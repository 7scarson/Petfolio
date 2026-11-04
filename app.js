import { shardFile } from './shard.js';

// ---------- config ----------
const IMAGE_BASE = 'https://ps99.biggamesapi.io/image/';
const PAGE_SIZE = 100;
const PET_CLASSES = ['Huge', 'Titanic', 'Gargantuan'];
const HOUR = 3600;
const DAY = 86400;

// ---------- state ----------
const state = {
  latest: null,
  market: null,
  byKey: new Map(),
  history: new Map(), // shard file -> Promise<object>
  favs: new Set(loadStore('petfolio:favs', [])),
  filters: { q: '', cat: 'All', cls: 'All', variant: 'All', shiny: false, sort: 'r', dir: -1, page: 0 },
  home: { moverClass: 'Huge', moverDir: 'up', sentClass: 'Huge', bmRange: loadStore('petfolio:bmRange', '7D') },
  chartRange: loadStore('petfolio:range', '7D'),
};

const view = document.getElementById('view');
const searchInput = document.getElementById('search');

// ---------- small helpers ----------
function loadStore(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}
function saveStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function compact(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const abs = Math.abs(n);
  const units = [[1e15, 'Q'], [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const v = n / size;
      const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
      return v.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/, '$1') + suffix;
    }
  }
  return Math.round(n).toLocaleString();
}
const full = (n) => (n == null ? '—' : Math.round(n).toLocaleString());

function pctHtml(p, { plain = false } = {}) {
  if (p == null) return '<span class="flat">—</span>';
  const cls = p > 0 ? 'up' : p < 0 ? 'down' : 'flat';
  const arrow = plain ? '' : p > 0 ? '▲ ' : p < 0 ? '▼ ' : '';
  const v = Math.abs(p) >= 1000 ? compact(Math.abs(p)) : Math.abs(p).toFixed(Math.abs(p) >= 100 ? 0 : 1);
  return `<span class="num ${cls}">${arrow}${p > 0 ? '+' : p < 0 ? '−' : ''}${v}%</span>`;
}
function deltaHtml(d) {
  if (d == null) return '<span class="flat">—</span>';
  const cls = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  return `<span class="num ${cls}">${d > 0 ? '+' : d < 0 ? '−' : ''}${compact(Math.abs(d))}</span>`;
}

function timeAgo(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hr ago`;
  return `${Math.round(s / 86400)} days ago`;
}
const fmtDate = (ts, withTime = true) =>
  new Date(ts * 1000).toLocaleString(undefined, withTime ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', year: 'numeric' });

function roman(n) {
  const map = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let out = '';
  for (const [v, s] of map) while (n >= v) { out += s; n -= v; }
  return out;
}

function displayName(it) {
  const parts = [];
  if (it.s) parts.push('Shiny');
  if (it.v === 1) parts.push('Golden');
  if (it.v === 2) parts.push('Rainbow');
  parts.push(it.n);
  if (it.t) parts.push(roman(it.t));
  return parts.join(' ');
}

const CATEGORY_LABELS = { Pet: 'Pets', Misc: 'Misc items', XPPotion: 'XP potions', Lootbox: 'Lootboxes', Box: 'Boxes' };
const catLabel = (c) => CATEGORY_LABELS[c] || (c.endsWith('s') ? c : `${c}s`);

// Item art comes from the official API's image service. Golden pets use their golden art;
// rainbow pets cycle colors and shiny ones sparkle, the way they look in game.
function iconHtml(it, cls = '') {
  const fx = [it.v === 2 && 'rainbow', it.v === 1 && 'golden', it.s && 'shiny'].filter(Boolean).join(' ');
  const initial = esc(String(it.n || '?')[0]);
  const inner = it.i
    ? `<img src="${IMAGE_BASE}${esc(it.i)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-initial="${initial}">`
    : `<span class="icon-letter">${initial}</span>`;
  return `<span class="icon ${fx} ${cls}" aria-hidden="true">${inner}</span>`;
}

function badgesHtml(it) {
  const b = [];
  if (it.cl && PET_CLASSES.includes(it.cl)) b.push(`<span class="badge b-${it.cl.toLowerCase()}">${it.cl}</span>`);
  if (it.v === 1) b.push('<span class="badge b-golden">Golden</span>');
  if (it.v === 2) b.push('<span class="badge b-rainbow">Rainbow</span>');
  if (it.s) b.push('<span class="badge b-shiny">Shiny</span>');
  if (state.latest && it.f >= state.latest.updated - DAY && state.latest.updated - firstSnapshot() > DAY) {
    b.push('<span class="badge b-new">New</span>');
  }
  return b.length ? `<span class="badges">${b.join('')}</span>` : '';
}
function firstSnapshot() {
  return state.market?.series?.[0]?.[0] ?? state.latest.updated;
}

const itemHref = (it) => `#/item/${encodeURIComponent(it.k)}`;
// When the data was last pulled from the API (checked every 5 minutes).
const lastRun = () => state.latest.generated ?? state.latest.updated;

// Green ▲ / red ▼ for the latest RAP move. Faded when the move is more than a day old.
function moveText(it) {
  if (!it.m || !it.m[1]) return null;
  const [t, p] = it.m;
  const prev = it.r / (1 + p / 100);
  return `${p > 0 ? 'Up' : 'Down'} ${Math.abs(p) >= 100 ? Math.round(Math.abs(p)) : Math.abs(p).toFixed(1)}% from ${compact(prev)} · ${fmtDate(t)}`;
}
function moveHtml(it) {
  const text = moveText(it);
  if (!text) return '';
  const up = it.m[1] > 0;
  const old = state.latest && state.latest.updated - it.m[0] > DAY;
  return `<span class="move ${up ? 'up' : 'down'}${old ? ' old' : ''}" title="${esc(text)}" role="img" aria-label="${esc(text)}">${up ? '▲' : '▼'}</span>`;
}
function rapHtml(it, { long = false, unit = false, move = true } = {}) {
  return `<span class="rap"><span class="num" title="${full(it.r)} RAP">${long ? full(it.r) : compact(it.r)}</span>${unit ? '<span class="rap-unit">RAP</span>' : ''}${move ? moveHtml(it) : ''}</span>`;
}

// Swap broken icons for an initial letter.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.parentElement?.classList.contains('icon')) return;
  const span = document.createElement('span');
  span.className = 'icon-letter';
  span.textContent = img.dataset.initial || '?';
  img.replaceWith(span);
}, true);

// ---------- data ----------
async function getJson(path) {
  const preview = window.PETFOLIO_PREVIEW;
  if (preview) {
    if (path in preview) return preview[path];
    throw new Error(`Missing ${path} in preview data`);
  }
  const res = await fetch(`data/${path}?v=${state.latest?.updated ?? Date.now()}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${res.status} loading ${path}`);
  return res.json();
}

function history(key) {
  const file = shardFile(key);
  if (!state.history.has(file)) {
    state.history.set(file, getJson(file).catch(() => ({})));
  }
  return state.history.get(file).then((shard) => shard[key] || []);
}

// ---------- routing ----------
function route() {
  const hash = location.hash.replace(/^#/, '') || '/';
  const [, page, rest] = hash.split('/');
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const active = (a.dataset.nav === 'home' && !page) || a.dataset.nav === page || (a.dataset.nav === 'bookmarks' && page === 'favorites');
    if (active) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  if (!state.latest) return;
  document.title = 'Petfolio · PS99 RAP Tracker';
  if (page === 'items') renderItems();
  else if (page === 'bookmarks' || page === 'favorites') renderBookmarks();
  else if (page === 'item' && rest) renderItem(decodeURIComponent(hash.slice('/item/'.length)));
  else renderHome();
}

window.addEventListener('hashchange', () => {
  route();
  window.scrollTo(0, 0);
});

// ---------- home ----------
function sparkline(values, h = 40) {
  const pts = values.filter((v) => v != null);
  if (pts.length < 2) return '';
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const w = 200;
  const coords = pts.map((v, i) => [(i / (pts.length - 1)) * w, h - 3 - ((v - min) / span) * (h - 6)]);
  const line = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const rising = pts.at(-1) >= pts[0];
  const color = rising ? 'var(--gain)' : 'var(--loss)';
  const [lx, ly] = coords.at(-1);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
    <path d="${line}L${w},${h}L0,${h}Z" fill="${color}" fill-opacity=".12" stroke="none"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="1.6" vector-effect="non-scaling-stroke"/>
    <circle cx="${lx}" cy="${ly}" r="2.5" fill="${color}"/>
  </svg>`;
}

function marketColumn(idx, days = 7) {
  const series = state.market?.series || [];
  const cutoff = state.latest.updated - days * DAY;
  return series.filter((p) => p[0] >= cutoff).map((p) => p[idx]);
}

function renderHome() {
  const { market, sentiment, count } = state.latest;
  const ch = market.change24h || {};
  const tip = (t) => `<span class="tip" title="${esc(t)}">?</span>`;

  const stat = (label, help, value, title, change, sparkIdx) => `
    <div class="panel stat">
      <span class="eyebrow stat-label">${label} ${tip(help)}</span>
      <span class="stat-value" title="${esc(title)}">${value}</span>
      <span class="stat-sub">${change} <span>24h</span></span>
      ${sparkIdx != null ? sparkline(marketColumn(sparkIdx)) : ''}
    </div>`;

  view.innerHTML = `
    <section>
      <div class="section-head">
        <div>
          <p class="eyebrow">Pet Simulator 99 market</p>
          <h1>Every pet and item, priced hourly</h1>
        </div>
        <span class="muted">${count.toLocaleString()} items · updated ${timeAgo(lastRun())}</span>
      </div>
    </section>

    ${homeBookmarksHtml()}

    <section>
      <div class="stats">
        ${stat('Market value', 'RAP × exists, summed across every item that has both. Measured in diamonds.', compact(market.marketValue), full(market.marketValue), pctHtml(ch.marketValue), 1)}
        ${stat('Pets in existence', 'Total copies of every pet across all players.', compact(market.petExists), full(market.petExists), deltaHtml(ch.petExists), 2)}
        ${stat('Huge 50 index', 'Average RAP of the 50 regular Huges with the most copies in existence. A quick read on the Huge market as a whole.', compact(market.hugeIndex), full(market.hugeIndex), pctHtml(ch.hugeIndex), 6)}
        <div class="panel stat">
          <span class="eyebrow stat-label">Big pets in existence ${tip('Total copies of Huge, Titanic and Gargantuan pets, including ones that never trade.')}</span>
          <span class="stat-value" title="${esc(full(market.hugeExists))}">${compact(market.hugeExists)}</span>
          <span class="stat-sub">Huges ${deltaHtml(ch.hugeExists)} <span>24h</span></span>
          <div class="split">
            <span>Titanics <b>${compact(market.titanicExists)}</b> ${deltaHtml(ch.titanicExists)}</span>
            <span>Gargantuans <b>${compact(market.gargantuanExists)}</b> ${deltaHtml(ch.gargantuanExists)}</span>
          </div>
        </div>
      </div>
    </section>

    <section class="duo">
      <div class="panel panel-pad">
        <div class="section-head">
          <h2>Daily movers</h2>
          <div class="controls">
            <div class="seg" role="group" aria-label="Pet type" id="mover-class">
              ${PET_CLASSES.map((c) => `<button type="button" data-v="${c}" aria-pressed="${state.home.moverClass === c}">${c}</button>`).join('')}
            </div>
            <div class="seg" role="group" aria-label="Direction" id="mover-dir">
              <button type="button" data-v="up" aria-pressed="${state.home.moverDir === 'up'}">Gainers</button>
              <button type="button" data-v="down" aria-pressed="${state.home.moverDir === 'down'}">Losers</button>
            </div>
          </div>
        </div>
        <ol class="movers" id="movers"></ol>
      </div>
      <div class="panel panel-pad">
        <div class="section-head">
          <h2>Sentiment</h2>
          <div class="seg" role="group" aria-label="Pet type" id="sent-class">
            ${PET_CLASSES.map((c) => `<button type="button" data-v="${c}" aria-pressed="${state.home.sentClass === c}">${c}</button>`).join('')}
          </div>
        </div>
        <div id="sentiment"></div>
      </div>
    </section>

    <section class="panel">
      <div class="section-head panel-pad" style="margin:0;padding-bottom:4px">
        <h2>Most valuable</h2>
        <a href="#/items">Browse all ${count.toLocaleString()} items →</a>
      </div>
      <div class="table-wrap" id="home-table">${tableHtml([...state.latest.items].sort((a, b) => b.r - a.r).slice(0, 15), { rank: true })}</div>
    </section>
  `;

  const drawMovers = () => {
    const { moverClass, moverDir } = state.home;
    const list = state.latest.items
      .filter((it) => it.cl === moverClass && it.d1 != null && (moverDir === 'up' ? it.d1 > 0 : it.d1 < 0))
      .sort((a, b) => (moverDir === 'up' ? b.d1 - a.d1 : a.d1 - b.d1))
      .slice(0, 12);
    document.getElementById('movers').innerHTML = list.length
      ? list.map((it) => `<li><a href="${itemHref(it)}">${iconHtml(it)}<span style="min-width:0"><span class="mover-name" style="display:block">${esc(displayName(it))}</span><span class="mover-rap">${rapHtml(it, { unit: true })}</span></span><span class="mover-change">${pctHtml(it.d1, { plain: true })}</span></a></li>`).join('')
      : `<li class="muted" style="padding:8px">${state.latest.updated - firstSnapshot() < DAY ? 'Movers appear once the tracker has 24 hours of history.' : `No ${moverClass} ${moverDir === 'up' ? 'gainers' : 'losers'} in the last 24 hours.`}</li>`;
  };

  const drawSentiment = () => {
    const s = sentiment[state.home.sentClass] || { up: 0, down: 0, flat: 0 };
    const total = s.up + s.down + s.flat;
    const box = document.getElementById('sentiment');
    if (!total) {
      box.innerHTML = `<p class="muted">Sentiment needs 24 hours of history. Check back tomorrow.</p>`;
      return;
    }
    const upPct = (s.up / total) * 100;
    const downPct = (s.down / total) * 100;
    const verdict = upPct > 60 ? ['Bullish', 'bull'] : downPct > 60 ? ['Bearish', 'bear'] : ['Mixed', ''];
    box.innerHTML = `
      <p class="sentiment-verdict ${verdict[1]}">${verdict[0]}</p>
      <p class="muted" style="margin:0">${total.toLocaleString()} ${state.home.sentClass}s with a RAP reading over the last 24 hours</p>
      <div class="meter" role="img" aria-label="${s.up} up, ${s.flat} unchanged, ${s.down} down">
        <span class="up" style="width:${upPct}%"></span><span class="flat" style="width:${(s.flat / total) * 100}%"></span><span class="down" style="width:${downPct}%"></span>
      </div>
      <div class="legend">
        <span><i class="dot" style="background:var(--gain)"></i>Up <b>${s.up}</b></span>
        <span><i class="dot" style="background:var(--line)"></i>Flat <b>${s.flat}</b></span>
        <span><i class="dot" style="background:var(--loss)"></i>Down <b>${s.down}</b></span>
      </div>
      <p class="muted" style="font-size:12px;margin:10px 0 0">Bullish when over 60% are up, bearish when over 60% are down.</p>`;
  };

  bindSeg('mover-class', (v) => { state.home.moverClass = v; drawMovers(); });
  bindSeg('mover-dir', (v) => { state.home.moverDir = v; drawMovers(); });
  bindSeg('sent-class', (v) => { state.home.sentClass = v; drawSentiment(); });
  drawMovers();
  drawSentiment();
  bindHomeBookmarks();
  bindTable(document.getElementById('home-table'));
}

function bindSeg(id, onChange) {
  const group = document.getElementById(id);
  group?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-v]');
    if (!btn) return;
    group.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
    onChange(btn.dataset.v);
  });
}

// ---------- search matching ----------
const searchWords = (q) => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
function matches(it, words) {
  if (!words.length) return true;
  const hay = `${displayName(it)} ${it.c} ${it.cl || ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

// ---------- home: bookmarks ----------
const BM_RANGES = ['1D', '7D', '30D'];

function bookmarkedItems() {
  // Newest bookmark first
  return [...state.favs].reverse().map((k) => state.byKey.get(k)).filter(Boolean);
}

function homeBookmarksHtml() {
  const range = state.home.bmRange;
  return `
    <section class="panel panel-pad bm-section" aria-labelledby="bm-title">
      <div class="section-head">
        <div>
          <h2 id="bm-title">Your bookmarks</h2>
          <p class="muted bm-sub">Quick access to the pets and items you follow. Saved on this device.</p>
        </div>
        <div class="controls">
          <div class="seg" role="group" aria-label="History range" id="bm-range">
            ${BM_RANGES.map((r) => `<button type="button" data-v="${r}" aria-pressed="${range === r}">${r}</button>`).join('')}
          </div>
          <div class="bm-add">
            <label class="visually-hidden" for="bm-add-input">Add a bookmark</label>
            <input id="bm-add-input" type="search" placeholder="+ Add a pet or item" autocomplete="off" spellcheck="false"
              role="combobox" aria-expanded="false" aria-controls="bm-suggest" aria-autocomplete="list">
            <ul id="bm-suggest" class="bm-suggest" role="listbox" hidden></ul>
          </div>
        </div>
      </div>
      <div id="bm-grid"></div>
    </section>`;
}

function drawBookmarkGrid() {
  const grid = document.getElementById('bm-grid');
  if (!grid) return;
  const list = bookmarkedItems();
  if (!list.length) {
    grid.innerHTML = `
      <div class="bm-empty">
        <span class="bm-empty-star" aria-hidden="true">★</span>
        <p><b>Nothing bookmarked yet.</b> Search above to add a pet or item, or tap ★ next to anything on the site. Its price history will show up here.</p>
      </div>`;
    return;
  }
  const range = state.home.bmRange;
  grid.innerHTML = `<div class="bm-grid">${list.map((it) => `
    <article class="bm-card">
      <a class="bm-link" href="${itemHref(it)}">
        <div class="bm-top">${iconHtml(it, 'icon-md')}<div class="bm-name"><b>${esc(displayName(it))}</b>${badgesHtml(it)}</div></div>
        <div class="bm-value">${rapHtml(it, { unit: true })}<span class="bm-change" title="${esc(moveText(it) || 'RAP has not changed since tracking started')}">${it.m && it.m[1] ? pctHtml(it.m[1], { plain: true }) : '<span class="flat">—</span>'}</span></div>
        <div class="bm-spark" data-spark="${esc(it.k)}"><span class="bm-loading">Loading ${range} history…</span></div>
        <div class="bm-foot"><span>${compact(it.e)} exist</span><span>${it.m && it.m[1] ? `vs last RAP · ${shortTime(it.m[0])}` : 'No RAP change yet'}</span></div>
      </a>
      ${starHtml(it)}
    </article>`).join('')}</div>`;

  for (const it of list) {
    history(it.k).then((points) => {
      const spark = grid.querySelector(`[data-spark="${CSS.escape(it.k)}"]`);
      if (!spark) return;
      const ranged = sliceRange(points, range);
      const svg = sparkline(ranged.map((p) => p[1]), 48);
      spark.innerHTML = svg || '<span class="bm-loading">History builds up as updates come in.</span>';
    });
  }
}

// "5:12 PM" for today, "Nov 3, 5:12 PM" for older times.
function shortTime(ts) {
  const d = new Date(ts * 1000);
  const today = new Date().toDateString() === d.toDateString();
  return d.toLocaleString(undefined, today ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const pctChange = (from, to) => (from > 0 && to != null ? ((to - from) / from) * 100 : null);

function bindHomeBookmarks() {
  bindSeg('bm-range', (v) => {
    state.home.bmRange = v;
    saveStore('petfolio:bmRange', v);
    drawBookmarkGrid();
  });
  const grid = document.getElementById('bm-grid');
  grid.addEventListener('click', (e) => {
    const fav = e.target.closest('[data-fav]');
    if (fav) { e.preventDefault(); toggleFav(fav.dataset.fav); }
  });

  const input = document.getElementById('bm-add-input');
  const list = document.getElementById('bm-suggest');
  let results = [];
  let active = -1;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };
  const paint = () => {
    list.innerHTML = results.length
      ? results.map((it, i) => {
          const on = state.favs.has(it.k);
          return `<li id="bm-opt-${i}" role="option" aria-selected="${i === active}" data-i="${i}" class="${i === active ? 'active' : ''}">
            ${iconHtml(it)}<span class="bm-opt-name">${esc(displayName(it))}<small>${rapHtml(it, { unit: true })}</small></span>
            <span class="bm-opt-action">${on ? '★ Added' : '+ Add'}</span></li>`;
        }).join('')
      : '<li class="bm-none" role="option" aria-disabled="true">No matching pets or items</li>';
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (active >= 0) input.setAttribute('aria-activedescendant', `bm-opt-${active}`);
  };
  const pick = (i) => {
    const it = results[i];
    if (!it) return;
    toggleFav(it.k, true);
    input.value = '';
    close();
    input.focus();
  };

  input.addEventListener('input', () => {
    const words = searchWords(input.value);
    if (!words.length) { close(); return; }
    results = state.latest.items.filter((it) => matches(it, words)).sort((a, b) => b.r - a.r).slice(0, 8);
    active = results.length ? 0 : -1;
    paint();
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      paint();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(active);
    } else if (e.key === 'Escape') {
      close();
    }
  });
  list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
  list.addEventListener('click', (e) => {
    const li = e.target.closest('li[data-i]');
    if (li) pick(Number(li.dataset.i));
  });
  input.addEventListener('blur', () => setTimeout(close, 120));

  drawBookmarkGrid();
}

// ---------- tables ----------
const COLUMNS = [
  { id: 'n', label: 'Item' },
  { id: 'c', label: 'Category', cls: 'hide-sm' },
  { id: 'r', label: 'RAP', r: true },
  { id: 'd1', label: '24h', r: true },
  { id: 'd7', label: '7d', r: true, cls: 'hide-sm' },
  { id: 'e', label: 'Exists', r: true, cls: 'hide-sm' },
];

function tableHtml(items, { rank = false, sortable = false, offset = 0 } = {}) {
  if (!items.length) return '<p class="empty">No items match these filters.</p>';
  const { sort, dir } = state.filters;
  const head = COLUMNS.map((c) => {
    const inner = sortable
      ? `<button class="sort" type="button" data-sort="${c.id}" data-active="${sort === c.id}">${c.label}${sort === c.id ? (dir > 0 ? ' ↑' : ' ↓') : ''}</button>`
      : c.label;
    const aria = sortable && sort === c.id ? ` aria-sort="${dir > 0 ? 'ascending' : 'descending'}"` : '';
    return `<th scope="col" class="${c.r ? 'r' : ''} ${c.cls || ''}"${aria}>${inner}</th>`;
  }).join('');
  const rows = items.map((it, i) => `
    <tr data-href="${itemHref(it)}">
      <td>${starHtml(it)}</td>
      ${rank ? `<td class="rank hide-sm">${offset + i + 1}</td>` : ''}
      <td class="name"><div class="item-cell">${iconHtml(it)}<div><a href="${itemHref(it)}">${esc(displayName(it))}</a>${badgesHtml(it)}</div></div></td>
      <td class="hide-sm muted">${esc(catLabel(it.c))}</td>
      <td class="r">${rapHtml(it)}</td>
      <td class="r">${pctHtml(it.d1, { plain: true })}</td>
      <td class="r hide-sm">${pctHtml(it.d7, { plain: true })}</td>
      <td class="r num hide-sm" title="${full(it.e)}">${compact(it.e)}</td>
    </tr>`).join('');
  return `<table class="items"><thead><tr><th scope="col"><span class="visually-hidden">Favorite</span></th>${rank ? '<th scope="col" class="rank hide-sm">#</th>' : ''}${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function starHtml(it) {
  const on = state.favs.has(it.k);
  return `<button class="star" type="button" data-fav="${esc(it.k)}" aria-pressed="${on}" aria-label="${on ? 'Remove bookmark' : 'Bookmark'}" title="${on ? 'Remove bookmark' : 'Bookmark'}">★</button>`;
}

function bookmarkButtonHtml(it) {
  const on = state.favs.has(it.k);
  return `<button class="bm-btn" type="button" data-fav="${esc(it.k)}" aria-pressed="${on}"><span aria-hidden="true">★</span> <span class="bm-btn-label">${on ? 'Bookmarked' : 'Bookmark'}</span></button>`;
}

function toggleFav(key, force) {
  const on = force ?? !state.favs.has(key);
  if (on) state.favs.add(key);
  else state.favs.delete(key);
  saveStore('petfolio:favs', [...state.favs]);
  document.querySelectorAll(`[data-fav="${CSS.escape(key)}"]`).forEach((b) => {
    b.setAttribute('aria-pressed', String(on));
    const label = b.querySelector('.bm-btn-label');
    if (label) label.textContent = on ? 'Bookmarked' : 'Bookmark';
    else {
      b.setAttribute('aria-label', on ? 'Remove bookmark' : 'Bookmark');
      b.title = on ? 'Remove bookmark' : 'Bookmark';
    }
  });
  drawBookmarkGrid();
}

function bindTable(root, onSort) {
  root.addEventListener('click', (e) => {
    const fav = e.target.closest('[data-fav]');
    if (fav) { e.preventDefault(); toggleFav(fav.dataset.fav); return; }
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn && onSort) { onSort(sortBtn.dataset.sort); return; }
    if (e.target.closest('a, button, input, label')) return;
    const row = e.target.closest('tr[data-href]');
    if (row) location.hash = row.dataset.href;
  });
}

// ---------- items page ----------
function filteredItems() {
  const f = state.filters;
  const words = searchWords(f.q);
  let list = state.latest.items.filter((it) => {
    if (f.cat !== 'All' && it.c !== f.cat) return false;
    if (f.cat === 'Pet' && f.cls !== 'All' && it.cl !== f.cls) return false;
    // Picking Normal, Golden or Rainbow hides shiny versions unless "Shiny only" is ticked.
    if (f.variant !== 'All' && it.s && !f.shiny) return false;
    if (f.variant === 'Normal' && it.v) return false;
    if (f.variant === 'Golden' && it.v !== 1) return false;
    if (f.variant === 'Rainbow' && it.v !== 2) return false;
    if (f.shiny && !it.s) return false;
    return matches(it, words);
  });
  const key = f.sort;
  list.sort((a, b) => {
    if (key === 'n') return f.dir * displayName(a).localeCompare(displayName(b));
    if (key === 'c') return f.dir * a.c.localeCompare(b.c) || b.r - a.r;
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) return b.r - a.r;
    if (av == null) return 1;
    if (bv == null) return -1;
    return f.dir * (av - bv);
  });
  return list;
}

function renderItems() {
  const counts = new Map();
  for (const it of state.latest.items) counts.set(it.c, (counts.get(it.c) || 0) + 1);
  const cats = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const f = state.filters;
  const chip = (group, value, label, n) =>
    `<button type="button" class="chip" data-group="${group}" data-v="${esc(value)}" aria-pressed="${f[group] === value}">${esc(label)}${n != null ? `<small>${n.toLocaleString()}</small>` : ''}</button>`;

  view.innerHTML = `
    <div class="section-head">
      <div><p class="eyebrow">All tradeable items</p><h1>Items</h1></div>
      <span class="muted">Updated ${timeAgo(lastRun())}</span>
    </div>
    <section class="panel">
      <div class="filters">
        <div class="filter-row"><span class="filter-label">Category</span>
          <div class="chips">${chip('cat', 'All', 'All', state.latest.items.length)}${cats.map(([c, n]) => chip('cat', c, catLabel(c), n)).join('')}</div>
        </div>
        <div class="filter-row" id="pet-filters" ${f.cat === 'Pet' ? '' : 'hidden'}><span class="filter-label">Pet type</span>
          <div class="chips">${['All', ...PET_CLASSES].map((c) => chip('cls', c, c)).join('')}</div>
        </div>
        <div class="filter-row"><span class="filter-label">Variant</span>
          <div class="chips">${['All', 'Normal', 'Golden', 'Rainbow'].map((v) => chip('variant', v, v)).join('')}</div>
          <label class="toggle"><input type="checkbox" id="shiny-only" ${f.shiny ? 'checked' : ''}> Shiny only</label>
        </div>
      </div>
      <div class="table-wrap" id="table"></div>
      <div class="pager" id="pager"></div>
    </section>`;

  view.querySelector('.filters').addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c) return;
    f[c.dataset.group] = c.dataset.v;
    if (c.dataset.group === 'cat' && c.dataset.v !== 'Pet') f.cls = 'All';
    f.page = 0;
    view.querySelectorAll(`.chip[data-group="${c.dataset.group}"]`).forEach((b) => b.setAttribute('aria-pressed', String(b === c)));
    if (c.dataset.group === 'cat') {
      document.getElementById('pet-filters').hidden = f.cat !== 'Pet';
      view.querySelectorAll('.chip[data-group="cls"]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.v === f.cls)));
    }
    drawTable();
  });
  document.getElementById('shiny-only').addEventListener('change', (e) => { f.shiny = e.target.checked; f.page = 0; drawTable(); });
  bindTable(document.getElementById('table'), (col) => {
    if (f.sort === col) f.dir *= -1;
    else { f.sort = col; f.dir = col === 'n' || col === 'c' ? 1 : -1; }
    f.page = 0;
    drawTable();
  });
  document.getElementById('pager').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-page]');
    if (!b) return;
    f.page += Number(b.dataset.page);
    drawTable();
    document.getElementById('table').scrollIntoView({ block: 'start', behavior: 'smooth' });
  });
  drawTable();
}

function drawTable() {
  const table = document.getElementById('table');
  if (!table) return;
  const list = filteredItems();
  const f = state.filters;
  const pages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  f.page = Math.min(f.page, pages - 1);
  const start = f.page * PAGE_SIZE;
  table.innerHTML = tableHtml(list.slice(start, start + PAGE_SIZE), { sortable: true, rank: true, offset: start });
  document.getElementById('pager').innerHTML = `
    <span>${list.length ? `${(start + 1).toLocaleString()}–${Math.min(start + PAGE_SIZE, list.length).toLocaleString()} of ${list.length.toLocaleString()}` : '0 items'}${f.q ? ` matching “${esc(f.q)}”` : ''}</span>
    <span class="btn-row"><button class="btn" type="button" data-page="-1" ${f.page === 0 ? 'disabled' : ''}>Previous</button><button class="btn" type="button" data-page="1" ${f.page >= pages - 1 ? 'disabled' : ''}>Next</button></span>`;
}

// ---------- bookmarks page ----------
function renderBookmarks() {
  const favs = state.latest.items.filter((it) => state.favs.has(it.k)).sort((a, b) => b.r - a.r);
  const total = favs.reduce((s, it) => s + it.r, 0);
  view.innerHTML = `
    <div class="section-head">
      <div><p class="eyebrow">Saved on this device</p><h1>Bookmarks</h1></div>
      ${favs.length ? `<span class="muted">${favs.length} items · combined RAP <b class="num">${compact(total)}</b></span>` : ''}
    </div>
    <section class="panel">
      ${favs.length
        ? `<div class="table-wrap" id="fav-table">${tableHtml(favs)}</div>`
        : '<div class="empty"><h2>No bookmarks yet</h2><p>Tap the ★ next to any pet or item to keep it here and on the Market page.</p><p><a href="#/items">Browse items</a></p></div>'}
    </section>`;
  const t = document.getElementById('fav-table');
  if (t) bindTable(t);
}

// ---------- item page ----------
async function renderItem(key) {
  const it = state.byKey.get(key);
  if (!it) {
    view.innerHTML = `<div class="empty"><h2>Item not found</h2><p>It may no longer have a RAP value.</p><p><a href="#/items">Browse items</a></p></div>`;
    return;
  }
  document.title = `${displayName(it)} · Petfolio`;
  const value = it.e != null ? it.r * it.e : null;
  const [cat, id] = it.k.split('|');
  const siblings = state.latest.items
    .filter((o) => o.c === cat && o.k.split('|')[1] === id)
    .sort((a, b) => (a.s || 0) - (b.s || 0) || (a.v || 0) - (b.v || 0) || (a.t || 0) - (b.t || 0));

  view.innerHTML = `
    <p class="crumbs"><a href="#/items">Items</a> / ${esc(catLabel(it.c))}</p>
    <section class="item-hero">
      ${iconHtml(it, 'icon-lg')}
      <div>
        <h1>${esc(displayName(it))}</h1>
        <div>${badgesHtml(it) || `<span class="muted">${esc(catLabel(it.c))}</span>`}</div>
      </div>
      ${bookmarkButtonHtml(it)}
    </section>
    <dl class="kv">
      <div><dt>RAP</dt><dd>${rapHtml(it, { long: true, move: false })}</dd></div>
      <div><dt>Last RAP move</dt><dd class="last-move">${it.m && it.m[1] ? `${pctHtml(it.m[1])}<small>${fmtDate(it.m[0])}</small>` : '<span class="flat">No change yet</span>'}</dd></div>
      <div><dt>24h</dt><dd>${pctHtml(it.d1)}</dd></div>
      <div><dt>7d</dt><dd>${pctHtml(it.d7)}</dd></div>
      <div><dt>Exists</dt><dd title="${full(it.e)}">${full(it.e)} ${it.e1 ? `<small>${deltaHtml(it.e1)}</small>` : ''}</dd></div>
      <div><dt>Total value</dt><dd title="${full(value)}">${compact(value)}</dd></div>
      <div><dt>Tracked since</dt><dd style="font-size:15px">${fmtDate(it.f, false)}</dd></div>
    </dl>
    <section class="charts">
      <div class="panel chart-panel">
        <div class="section-head" style="margin:0">
          <h2>RAP history</h2>
          <div class="seg" role="group" aria-label="Chart range" id="range">
            ${['1D', '7D', '30D', 'All'].map((r) => `<button type="button" data-v="${r}" aria-pressed="${state.chartRange === r}">${r}</button>`).join('')}
          </div>
        </div>
        <div class="chart" id="chart-rap"></div>
      </div>
      <div class="panel chart-panel">
        <h2>Exists history</h2>
        <div class="chart" id="chart-exists"></div>
      </div>
    </section>
    ${siblings.length > 1 ? `
      <section>
        <h2>Other versions</h2>
        <div class="variants">${siblings.map((o) => `
          <a class="variant" href="${itemHref(o)}" ${o.k === it.k ? 'aria-current="page"' : ''}>${iconHtml(o)}<div><b>${esc(displayName(o))}</b><span class="variant-meta">${rapHtml(o, { unit: true })}<span class="num">· ${compact(o.e)} exist</span></span></div></a>`).join('')}
        </div>
      </section>` : ''}
  `;
  view.querySelector('.item-hero .bm-btn').addEventListener('click', () => toggleFav(it.k));

  const points = await history(key);
  if (decodeURIComponent(location.hash) !== decodeURIComponent(itemHref(it))) return; // navigated away while loading
  const draw = () => {
    const ranged = sliceRange(points, state.chartRange);
    drawChart(document.getElementById('chart-rap'), ranged.map((p) => [p[0], p[1]]), { color: 'var(--accent)', label: 'RAP' });
    drawChart(document.getElementById('chart-exists'), ranged.map((p) => [p[0], p[2]]).filter((p) => p[1] != null), { color: 'var(--titanic)', label: 'Exists' });
  };
  bindSeg('range', (v) => { state.chartRange = v; saveStore('petfolio:range', v); draw(); });
  draw();
  const ro = new ResizeObserver(() => draw());
  ro.observe(document.getElementById('chart-rap'));
  window.addEventListener('hashchange', () => ro.disconnect(), { once: true });
}

function sliceRange(points, range) {
  if (!points.length) return [];
  const end = state.latest.updated;
  const span = { '1D': DAY, '7D': 7 * DAY, '30D': 30 * DAY }[range];
  let out = points;
  if (span) {
    const start = end - span;
    const before = [...points].reverse().find((p) => p[0] <= start);
    out = points.filter((p) => p[0] > start);
    if (before) out = [[start, ...before.slice(1)], ...out];
  }
  // Values only change when RAP moves; carry the last value up to the latest update.
  const last = out.at(-1);
  if (last && last[0] < end) out = [...out, [end, ...last.slice(1)]];
  return out;
}

function niceTicks(min, max, count = 4) {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(v);
  return { lo, hi, ticks };
}

function drawChart(el, pts, { color, label }) {
  if (!el) return;
  const W = el.clientWidth || 600;
  const H = el.clientHeight || 240;
  if (pts.length < 2) {
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}"><text class="empty-chart" x="${W / 2}" y="${H / 2}" text-anchor="middle">History builds up as hourly updates come in.</text></svg>`;
    return;
  }
  const pad = { l: 54, r: 10, t: 10, b: 26 };
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const x0 = xs[0];
  const x1 = xs.at(-1);
  let yMin = Math.min(...ys);
  let yMax = Math.max(...ys);
  if (yMin === yMax) { yMin *= 0.95; yMax *= 1.05; if (yMin === yMax) yMax = yMin + 1; }
  const { lo, hi, ticks } = niceTicks(yMin, yMax);
  const sx = (t) => pad.l + ((t - x0) / (x1 - x0 || 1)) * (W - pad.l - pad.r);
  const sy = (v) => pad.t + (1 - (v - lo) / (hi - lo || 1)) * (H - pad.t - pad.b);

  let d = `M${sx(xs[0]).toFixed(1)},${sy(ys[0]).toFixed(1)}`;
  for (let i = 1; i < pts.length; i++) d += `H${sx(xs[i]).toFixed(1)}V${sy(ys[i]).toFixed(1)}`;
  const area = `${d}V${sy(lo).toFixed(1)}H${sx(xs[0]).toFixed(1)}Z`;

  const spanSecs = x1 - x0;
  const xTickCount = Math.max(2, Math.min(6, Math.floor((W - pad.l) / 110)));
  const xTicks = Array.from({ length: xTickCount }, (_, i) => x0 + (spanSecs * i) / (xTickCount - 1));
  const xLabel = (t) => new Date(t * 1000).toLocaleString(undefined, spanSecs <= 2 * DAY ? { hour: 'numeric' } : { month: 'short', day: 'numeric' });

  el.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${label} over time, from ${compact(ys[0])} to ${compact(ys.at(-1))}">
      <g class="grid">${ticks.map((v) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${sy(v)}" y2="${sy(v)}"/>`).join('')}</g>
      <g class="axis">
        ${ticks.map((v) => `<text x="${pad.l - 8}" y="${sy(v) + 4}" text-anchor="end">${compact(v)}</text>`).join('')}
        ${xTicks.map((t, i) => `<text x="${sx(t)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'}">${xLabel(t)}</text>`).join('')}
      </g>
      <path d="${area}" fill="${color}" fill-opacity=".1" stroke="none"/>
      <path d="${d}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
      <circle cx="${sx(x1)}" cy="${sy(ys.at(-1))}" r="3.5" fill="${color}"/>
      <g class="hover" visibility="hidden">
        <line y1="${pad.t}" y2="${H - pad.b}" stroke="var(--muted)" stroke-dasharray="3 3"/>
        <circle r="4.5" fill="var(--surface)" stroke="${color}" stroke-width="2"/>
      </g>
      <rect x="${pad.l}" y="0" width="${W - pad.l - pad.r}" height="${H}" fill="transparent" class="hit"/>
    </svg>
    <div class="chart-tip" hidden></div>`;

  const svg = el.querySelector('svg');
  const hover = svg.querySelector('.hover');
  const tipEl = el.querySelector('.chart-tip');
  const hit = svg.querySelector('.hit');
  const move = (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const t = x0 + ((px - pad.l) / (W - pad.l - pad.r)) * (x1 - x0);
    let idx = 0;
    for (let i = 0; i < xs.length; i++) if (xs[i] <= t) idx = i;
    const cx = Math.max(pad.l, Math.min(W - pad.r, px));
    const cy = sy(ys[idx]);
    hover.setAttribute('visibility', 'visible');
    hover.querySelector('line').setAttribute('x1', cx);
    hover.querySelector('line').setAttribute('x2', cx);
    hover.querySelector('circle').setAttribute('cx', cx);
    hover.querySelector('circle').setAttribute('cy', cy);
    tipEl.hidden = false;
    tipEl.style.left = `${(cx / W) * 100}%`;
    tipEl.style.top = `${(cy / H) * 100}%`;
    tipEl.innerHTML = `${label} ${full(ys[idx])}<span>${fmtDate(Math.min(t, x1))}</span>`;
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', () => { hover.setAttribute('visibility', 'hidden'); tipEl.hidden = true; });
}

// ---------- search ----------
let searchTimer;
searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.filters.q = searchInput.value.trim();
    state.filters.page = 0;
    if (!location.hash.startsWith('#/items')) location.hash = '#/items';
    else drawTable();
  }, 150);
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== searchInput && !/input|textarea|select/i.test(document.activeElement?.tagName)) {
    e.preventDefault();
    searchInput.focus();
  }
});

// ---------- boot ----------
async function boot() {
  try {
    state.latest = await getJson('latest.json');
  } catch {
    view.innerHTML = `<div class="empty"><h2>No market data yet</h2><p>The first hourly update hasn't finished. Open the repository's Actions tab and run “Update RAP data”, then reload this page in a few minutes.</p></div>`;
    return;
  }
  for (const it of state.latest.items) state.byKey.set(it.k, it);
  state.market = await getJson('market.json').catch(() => ({ series: [] }));
  document.getElementById('updated-line').textContent =
    `Last update ${new Date(lastRun() * 1000).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} (${timeAgo(lastRun())}). Checks for new data every 5 minutes.`;
  route();
}

boot();
