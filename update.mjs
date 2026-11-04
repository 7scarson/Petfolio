#!/usr/bin/env node
// Petfolio data updater.
// Pulls RAP and exists counts from the official Pet Simulator 99 API (BIG Games),
// appends to a compact price history, and writes the JSON files the website reads.
//
// Usage:  node update.mjs <store-dir>
// Env:    PS99_FIXTURES=<dir>  read API responses from local files instead (for testing)
//         NOW_TS=<unix secs>   pretend the current time is this (for testing)

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { shardOf, SHARDS } from './shard.js';

const API = process.env.PS99_API || 'https://ps99.biggamesapi.io';
const FIXTURES = process.env.PS99_FIXTURES;
const STORE = path.resolve(process.argv[2] || 'store');
const HOUR = 3600;
const DAY = 86400;
const NOW = Number(process.env.NOW_TS) || Math.floor(Date.now() / 1000);
const HOUR_TS = NOW - (NOW % HOUR);

// ---------- fetching ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname) {
  if (FIXTURES) {
    const name = pathname
      .replace('/api/collection/', 'collection-')
      .replace('/api/', '');
    const file = path.join(FIXTURES, `${name}.json`);
    const json = JSON.parse(await readFile(file, 'utf8'));
    return json.data;
  }
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(API + pathname, {
        headers: { 'User-Agent': 'petfolio-rap-tracker (GitHub Actions)', Accept: 'application/json' },
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${pathname}`);
      const json = await res.json();
      if (json.status !== 'ok') throw new Error(`API error for ${pathname}: ${json.error?.message || 'unknown'}`);
      return json.data;
    } catch (err) {
      lastErr = err;
      console.warn(`  attempt ${attempt} failed: ${err.message}`);
      await sleep(attempt * 5000);
    }
  }
  throw lastErr;
}

// ---------- store helpers ----------

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(path.join(STORE, file), 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  const full = path.join(STORE, file);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, JSON.stringify(value));
}

// ---------- item identity ----------

const KNOWN = new Set(['id', 'pt', 'sh', 'tn']);

function keyOf(category, cd = {}) {
  const extras = Object.keys(cd)
    .filter((k) => !KNOWN.has(k))
    .sort()
    .map((k) => `${k}=${typeof cd[k] === 'object' ? JSON.stringify(cd[k]) : cd[k]}`)
    .join(',');
  return `${category}|${cd.id}|${cd.pt || 0}|${cd.sh ? 1 : 0}|${cd.tn || 0}` + (extras ? `|${extras}` : '');
}

// ---------- icons & names (refreshed at most once a day) ----------

const ASSET_RE = /rbxassetid:\/\/(\d+)/;
const ICON_KEYS = ['thumbnail', 'Thumbnail', 'Icon', 'icon', 'Image', 'image', 'DisplayIcon'];

function asset(v) {
  if (typeof v !== 'string') return null;
  const m = v.match(ASSET_RE);
  return m ? m[1] : null;
}

function findAsset(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return null;
  for (const k of ICON_KEYS) {
    const a = asset(obj[k]);
    if (a) return a;
  }
  for (const v of Object.values(obj)) {
    const a = typeof v === 'string' ? asset(v) : findAsset(v, depth + 1);
    if (a) return a;
  }
  return null;
}

const SPECIAL_COLLECTIONS = { Misc: 'MiscItems', Card: 'CardItems' };
// Categories whose pictures live in collections with different names.
const EXTRA_COLLECTIONS = {
  Tool: /pickaxe|fishingrod|shovel|wateringcan|tool/i,
  Pickaxe: /pickaxe/i,
  Consumable: /consumable|booster/i,
};

function resolveCollection(cat, list) {
  const lower = new Map(list.map((c) => [c.toLowerCase(), c]));
  const tries = [SPECIAL_COLLECTIONS[cat], cat, `${cat}s`, `${cat}es`, cat.replace(/y$/, 'ies')].filter(Boolean);
  for (const t of tries) if (lower.has(t.toLowerCase())) return lower.get(t.toLowerCase());
  return list.find((c) => c.toLowerCase().startsWith(cat.toLowerCase())) || null;
}

// Gives bare ids like "Huge" (an XP potion) a readable name when the catalog has none.
const NAME_SUFFIX = { Potion: 'Potion', Charm: 'Charm', Enchant: 'Enchant', XPPotion: 'XP Potion', Hoverboard: 'Hoverboard', Booth: 'Booth', Ultimate: 'Ultimate' };
function nameFor(catalog, category, id) {
  const known = catalog.names[`${category}|${id}`];
  if (known) return known;
  const suffix = NAME_SUFFIX[category];
  return suffix && !String(id).toLowerCase().endsWith(suffix.toLowerCase()) ? `${id} ${suffix}` : String(id);
}

function petClassFromName(name) {
  if (name.startsWith('Gargantuan ')) return 'Gargantuan';
  if (name.startsWith('Titanic ')) return 'Titanic';
  if (name.startsWith('Huge ')) return 'Huge';
  return null;
}

// Bump this to force the icon/name catalog to rebuild on the next run.
const CATALOG_VERSION = 2;

async function refreshCatalog(categories) {
  const catalog = { version: CATALOG_VERSION, updated: NOW, icons: {}, names: {}, classes: {}, collections: [], unmatched: [] };
  let collections = [];
  try {
    collections = await api('/api/collections');
  } catch (err) {
    console.warn(`Could not list collections: ${err.message}`);
    return null;
  }
  catalog.collections = collections;
  const jobs = [];
  for (const cat of categories) {
    const coll = resolveCollection(cat, collections);
    const extras = EXTRA_COLLECTIONS[cat] ? collections.filter((c) => EXTRA_COLLECTIONS[cat].test(c) && c !== coll) : [];
    if (!coll && !extras.length) catalog.unmatched.push(cat);
    for (const c of [coll, ...extras].filter(Boolean)) jobs.push([cat, c]);
  }
  for (const [cat, coll] of jobs) {
    let rows;
    try {
      rows = await api(`/api/collection/${encodeURIComponent(coll)}`);
    } catch (err) {
      console.warn(`  skipped collection ${coll}: ${err.message}`);
      continue;
    }
    for (const row of rows || []) {
      // Non-pet collections name rows "Potion | Damage"; RAP data calls that item just "Damage".
      const id = String(row.configName || '').replace(/^[^|]+\s\|\s/, '');
      const cd = row.configData || {};
      if (!id) continue;
      const display = cd.name || cd.DisplayName || cd.Title || cd.displayName;
      if (typeof display === 'string' && display !== id) catalog.names[`${cat}|${id}`] = display;

      if (cat === 'Pet') {
        const normal = asset(cd.thumbnail) || findAsset(cd);
        if (normal) catalog.icons[`Pet|${id}`] = normal;
        const golden = asset(cd.goldenThumbnail);
        if (golden) catalog.icons[`Pet|${id}|1`] = golden;
        const cls = cd.gargantuan ? 'Gargantuan' : cd.titanic ? 'Titanic' : cd.huge ? 'Huge' : petClassFromName(id) || row.category || null;
        if (cls) catalog.classes[id] = cls;
      } else {
        const base = findAsset(cd);
        if (base && !catalog.icons[`${cat}|${id}`]) catalog.icons[`${cat}|${id}`] = base;
        if (Array.isArray(cd.Tiers)) {
          cd.Tiers.forEach((tier, i) => {
            const a = findAsset(tier);
            if (a) catalog.icons[`${cat}|${id}|t${i + 1}`] = a;
          });
        }
      }
    }
    await sleep(FIXTURES ? 0 : 700); // stay well under the 100 requests/minute limit
  }
  return catalog;
}

function iconFor(catalog, category, cd) {
  const { icons } = catalog;
  if (category === 'Pet' && cd.pt === 1 && icons[`Pet|${cd.id}|1`]) return icons[`Pet|${cd.id}|1`];
  if (cd.tn && icons[`${category}|${cd.id}|t${cd.tn}`]) return icons[`${category}|${cd.id}|t${cd.tn}`];
  // Tower defense units share their pet's picture.
  return icons[`${category}|${cd.id}`] || (category === 'Tower' ? icons[`Pet|${cd.id}`] : null) || null;
}

// ---------- history ----------

// Keep every change for 48 hours, the last value per 6 hours for 30 days, then one per day.
function compact(points) {
  const out = [];
  const bucketOf = (ts) => {
    const age = HOUR_TS - ts;
    if (age <= 2 * DAY) return `h${ts}`;
    if (age <= 30 * DAY) return `q${Math.floor(ts / (6 * HOUR))}`;
    return `d${Math.floor(ts / DAY)}`;
  };
  for (let i = 0; i < points.length; i++) {
    const next = points[i + 1];
    // A later point in the same bucket wins, but the very first point is always kept so
    // "tracked since" stays put.
    if (i > 0 && next && bucketOf(next[0]) === bucketOf(points[i][0])) continue;
    out.push(points[i]);
  }
  return out;
}

function valueAt(points, ts) {
  let found = null;
  for (const p of points) {
    if (p[0] <= ts) found = p;
    else break;
  }
  return found;
}

const pct = (now, then) => (then && then > 0 && now != null ? Math.round(((now - then) / then) * 10000) / 100 : null);

function addPoint(series, point) {
  const last = series.at(-1);
  if (last && last[0] === point[0]) {
    series[series.length - 1] = point; // re-run within the same hour
  } else if (!last || last.slice(1).some((v, i) => v !== point[i + 1])) {
    series.push(point);
  }
}

// ---------- main ----------

async function main() {
  console.log(`Updating snapshot for ${new Date(HOUR_TS * 1000).toISOString()}`);

  const [rapRes, existsRes] = await Promise.allSettled([api('/api/rap'), api('/api/exists')]);
  if (rapRes.status !== 'fulfilled') throw new Error(`RAP request failed: ${rapRes.reason?.message}`);
  const rapRaw = rapRes.value;
  if (!Array.isArray(rapRaw) || rapRaw.length < 50) {
    throw new Error(`RAP response has only ${rapRaw?.length ?? 0} items; keeping the previous data.`);
  }
  const existsRaw = existsRes.status === 'fulfilled' && Array.isArray(existsRes.value) ? existsRes.value : null;
  if (!existsRaw) console.warn('Exists request failed; reusing the last known exists counts.');

  const existsMap = new Map();
  for (const row of existsRaw || []) existsMap.set(keyOf(row.category, row.configData), row.value);

  // Catalog (icons, display names, pet classes)
  let catalog = await readJson('catalog.json', null);
  const categories = [...new Set(rapRaw.map((r) => r.category))];
  if (!catalog || catalog.version !== CATALOG_VERSION || NOW - catalog.updated > DAY) {
    console.log('Refreshing icons and names...');
    catalog = (await refreshCatalog(categories)) || catalog || { updated: 0, icons: {}, names: {}, classes: {} };
  }

  // History shards
  const shards = await Promise.all(
    Array.from({ length: SHARDS }, (_, i) => readJson(`history/${String(i).padStart(2, '0')}.json`, {})),
  );

  const items = [];
  for (const row of rapRaw) {
    const cd = row.configData || {};
    if (cd.id == null || typeof row.value !== 'number') continue;
    const key = keyOf(row.category, cd);
    const shard = shards[shardOf(key)];
    const series = (shard[key] ||= []);
    const prevExists = series.at(-1)?.[2] ?? null;
    const exists = existsMap.has(key) ? existsMap.get(key) : existsRaw ? null : prevExists;

    addPoint(series, [HOUR_TS, row.value, exists]);
    shard[key] = compact(series);

    const day = valueAt(shard[key], HOUR_TS - DAY);
    const week = valueAt(shard[key], HOUR_TS - 7 * DAY);
    const cls = row.category === 'Pet' ? catalog.classes[cd.id] || petClassFromName(cd.id) : null;

    items.push({
      k: key,
      n: nameFor(catalog, row.category, cd.id),
      c: row.category,
      ...(cls ? { cl: cls } : {}),
      ...(cd.pt ? { v: cd.pt } : {}),
      ...(cd.sh ? { s: 1 } : {}),
      ...(cd.tn ? { t: cd.tn } : {}),
      r: row.value,
      e: exists,
      i: iconFor(catalog, row.category, cd),
      d1: pct(row.value, day?.[1]),
      d7: pct(row.value, week?.[1]),
      e1: day && day[2] != null && exists != null ? exists - day[2] : null,
      f: shard[key][0][0],
    });
  }

  // Market-wide numbers
  const petExists = { total: 0, Huge: 0, Titanic: 0, Gargantuan: 0 };
  if (existsRaw) {
    for (const row of existsRaw) {
      if (row.category !== 'Pet') continue;
      const id = row.configData?.id || '';
      petExists.total += row.value || 0;
      const cls = catalog.classes[id] || petClassFromName(id);
      if (cls in petExists) petExists[cls] += row.value || 0;
    }
  }

  const marketValue = items.reduce((sum, it) => sum + (it.e ? it.r * it.e : 0), 0);
  const plainHuges = items
    .filter((it) => it.cl === 'Huge' && !it.v && !it.s && it.e)
    .sort((a, b) => b.e - a.e)
    .slice(0, 50);
  const hugeIndex = plainHuges.length ? Math.round(plainHuges.reduce((s, it) => s + it.r, 0) / plainHuges.length) : null;

  const market = await readJson('market.json', { series: [] });
  const lastMarket = market.series.at(-1);
  const point = [
    HOUR_TS,
    marketValue,
    existsRaw ? petExists.total : lastMarket?.[2] ?? null,
    existsRaw ? petExists.Huge : lastMarket?.[3] ?? null,
    existsRaw ? petExists.Titanic : lastMarket?.[4] ?? null,
    existsRaw ? petExists.Gargantuan : lastMarket?.[5] ?? null,
    hugeIndex,
  ];
  if (lastMarket && lastMarket[0] === HOUR_TS) market.series[market.series.length - 1] = point;
  else market.series.push(point);
  market.series = compact(market.series);
  market.fields = ['time', 'marketValue', 'petExists', 'hugeExists', 'titanicExists', 'gargantuanExists', 'hugeIndex'];

  const dayAgo = valueAt(market.series, HOUR_TS - DAY);
  const sentiment = {};
  for (const cls of ['Huge', 'Titanic', 'Gargantuan']) {
    const s = { up: 0, down: 0, flat: 0 };
    for (const it of items) {
      if (it.cl !== cls || it.d1 == null) continue;
      if (it.d1 > 0) s.up++;
      else if (it.d1 < 0) s.down++;
      else s.flat++;
    }
    sentiment[cls] = s;
  }

  const latest = {
    updated: HOUR_TS,
    generated: NOW,
    count: items.length,
    market: {
      marketValue: point[1],
      petExists: point[2],
      hugeExists: point[3],
      titanicExists: point[4],
      gargantuanExists: point[5],
      hugeIndex: point[6],
      change24h: dayAgo
        ? {
            marketValue: pct(point[1], dayAgo[1]),
            petExists: point[2] != null && dayAgo[2] != null ? point[2] - dayAgo[2] : null,
            hugeExists: point[3] != null && dayAgo[3] != null ? point[3] - dayAgo[3] : null,
            titanicExists: point[4] != null && dayAgo[4] != null ? point[4] - dayAgo[4] : null,
            gargantuanExists: point[5] != null && dayAgo[5] != null ? point[5] - dayAgo[5] : null,
            hugeIndex: pct(point[6], dayAgo[6]),
          }
        : null,
    },
    sentiment,
    items,
  };

  // Write everything at the end so a failed run never leaves half-updated files.
  await mkdir(STORE, { recursive: true });
  await Promise.all(shards.map((s, i) => writeJson(`history/${String(i).padStart(2, '0')}.json`, s)));
  await writeJson('market.json', market);
  await writeJson('catalog.json', catalog);
  await writeJson('latest.json', latest);

  console.log(`Saved ${items.length} items. Market value ${marketValue.toLocaleString()}.`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
