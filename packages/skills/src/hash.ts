/**
 * Deterministic string digest for generator identity (plan S14.3).
 * FNV-1a 64-bit over UTF-16 code units, rendered as 16 lowercase hex
 * characters. Pure integer arithmetic, so results are byte-identical on
 * every platform; used to derive command ids and proposal fingerprints
 * from (generator, version, seed, params) without any external hashing
 * dependency.
 */

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

export function digestHex(value: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    hash ^= BigInt(code & 0xff);
    hash = (hash * FNV_PRIME) & MASK;
    hash ^= BigInt((code >>> 8) & 0xff);
    hash = (hash * FNV_PRIME) & MASK;
  }
  return hash.toString(16).padStart(16, "0");
}
