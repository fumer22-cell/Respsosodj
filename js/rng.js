// Deterministic random numbers from a text seed, so a seed always rebuilds
// exactly the same stage.

const SEED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 32-bit string hash (cyrb-style). */
export function hashString(str) {
  let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  return h1 >>> 0;
}

/** mulberry32 PRNG with a few helpers. */
export function makeRng(seedStr) {
  let a = hashString(String(seedStr));
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (lo, hi) => lo + (hi - lo) * next(),
    int: (lo, hi) => Math.floor(lo + (hi - lo + 1) * next()),
    chance: (p) => next() < p,
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    sign: () => (next() < 0.5 ? -1 : 1),
    weighted(items, key = 'weight') {
      let total = 0;
      for (const it of items) total += it[key];
      let r = next() * total;
      for (const it of items) { r -= it[key]; if (r <= 0) return it; }
      return items[items.length - 1];
    },
  };
}

/** A fresh random, human-friendly seed like "K7Q2XD". */
export function randomSeed() {
  let s = '';
  for (let i = 0; i < 6; i++) s += SEED_ALPHABET[Math.floor(Math.random() * SEED_ALPHABET.length)];
  return s;
}

/** Clean user input into a seed: uppercase letters/digits only, max 16 chars. */
export function sanitizeSeed(str) {
  return String(str || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
}
