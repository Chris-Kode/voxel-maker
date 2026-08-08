/**
 * Pure JS SHA-256 (FIPS 180-4) over byte arrays. Deterministic, dependency
 * free, and usable in Node and browser runtimes so semantic hashing never
 * depends on a platform crypto binding.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
]);

const rotr = (value: number, shift: number): number =>
  (value >>> shift) | (value << (32 - shift));

/** Reads an in-bounds word; indices are guaranteed by the algorithm. */
const word = (array: Uint32Array, index: number): number =>
  array[index] as number;

/** Lowercase hex SHA-256 digest of the input bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  const bitLength = BigInt(bytes.length) * 8n;
  const paddedBlocks = Math.floor((bytes.length + 8) / 64) + 1;
  const message = new Uint8Array(paddedBlocks * 64);
  message.set(bytes);
  message[bytes.length] = 0x80;
  new DataView(message.buffer).setBigUint64(
    message.length - 8,
    bitLength,
    false,
  );

  const h = new Uint32Array(INITIAL);
  const w = new Uint32Array(64);
  const words = new DataView(message.buffer);
  for (let offset = 0; offset < message.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      w[i] = words.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 =
        rotr(word(w, i - 15), 7) ^
        rotr(word(w, i - 15), 18) ^
        (word(w, i - 15) >>> 3);
      const s1 =
        rotr(word(w, i - 2), 17) ^
        rotr(word(w, i - 2), 19) ^
        (word(w, i - 2) >>> 10);
      w[i] = (word(w, i - 16) + s0 + word(w, i - 7) + s1) >>> 0;
    }
    let a = word(h, 0);
    let b = word(h, 1);
    let c = word(h, 2);
    let d = word(h, 3);
    let e = word(h, 4);
    let f = word(h, 5);
    let g = word(h, 6);
    let hh = word(h, 7);
    for (let i = 0; i < 64; i += 1) {
      const sum1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (hh + sum1 + ch + word(K, i) + word(w, i)) >>> 0;
      const sum0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h[0] = (word(h, 0) + a) >>> 0;
    h[1] = (word(h, 1) + b) >>> 0;
    h[2] = (word(h, 2) + c) >>> 0;
    h[3] = (word(h, 3) + d) >>> 0;
    h[4] = (word(h, 4) + e) >>> 0;
    h[5] = (word(h, 5) + f) >>> 0;
    h[6] = (word(h, 6) + g) >>> 0;
    h[7] = (word(h, 7) + hh) >>> 0;
  }
  let digest = "";
  for (let i = 0; i < 8; i += 1) {
    digest += word(h, i).toString(16).padStart(8, "0");
  }
  return digest;
}
