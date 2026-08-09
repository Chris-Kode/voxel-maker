import { canonicalJson, type JsonValue } from "@voxel-maker/shared";

export const FIXED_SEED = 0x5eed_0001;

/**
 * Deterministic xorshift32 PRNG for seeded fuzz corpora (issue #44): the
 * same seed always produces the same byte stream, so adversarial suites
 * are regression gates rather than flaky probes.
 */
export function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e37_79b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

/** Random bytes of `size` from a seeded RNG. */
export function randomBytes(rng: () => number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = Math.floor(rng() * 256);
  return out;
}

/** Flips up to `count` random bytes of `bytes` (returns a copy). */
export function mutateBytes(
  bytes: Uint8Array,
  rng: () => number,
  count: number,
): Uint8Array {
  const out = bytes.slice();
  const flips = 1 + Math.floor(rng() * count);
  for (let i = 0; i < flips; i += 1) {
    out[Math.floor(rng() * out.byteLength)] = Math.floor(rng() * 256);
  }
  return out;
}

export function createFixedIds(namespace = "fixture"): Readonly<{
  command: string;
  document: string;
  transaction: string;
  volume: string;
}> {
  return Object.freeze({
    command: `command:${namespace}:0001`,
    document: `document:${namespace}:0001`,
    transaction: `transaction:${namespace}:0001`,
    volume: `volume:${namespace}:0001`,
  });
}

export const fixedIds = createFixedIds();

export function assertCanonicalEqual(
  actual: JsonValue,
  expected: JsonValue,
): void {
  const actualCanonical = canonicalJson(actual);
  const expectedCanonical = canonicalJson(expected);
  if (actualCanonical !== expectedCanonical) {
    throw new Error(
      `Canonical values differ: ${actualCanonical} !== ${expectedCanonical}`,
    );
  }
}
