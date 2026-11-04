// Shared by the updater (Node) and the website (browser) so both agree
// which history file an item lives in.
export const SHARDS = 64;

export function shardOf(key) {
  // FNV-1a 32-bit hash
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % SHARDS;
}

export function shardFile(key) {
  return `history/${String(shardOf(key)).padStart(2, '0')}.json`;
}
