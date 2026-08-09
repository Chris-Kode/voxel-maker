/**
 * Deterministic seeded random source for pattern variation (plan S14.3).
 * The seed arrives explicitly in the generator context and is mixed with
 * the generator name, so the same (generator, seed) always yields the same
 * sequence on every platform while different generators never share a
 * sequence. Only 32-bit integer arithmetic is used (FNV-1a seeding +
 * mulberry32), so results are portable and reproducible.
 */

/** FNV-1a 32-bit digest of a string (deterministic integer arithmetic). */
export function hashSeed(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Returns a deterministic `[0, 1)` generator for `seed`. The same seed
 * string produces the identical sequence on every platform and run.
 */
export function createSeededRandom(seed: string): () => number {
  let state = hashSeed(seed) || 0x9e3779b9;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic integer in `[0, bound)` from a seeded random source. */
export function seededInt(random: () => number, bound: number): number {
  return Math.floor(random() * bound);
}
