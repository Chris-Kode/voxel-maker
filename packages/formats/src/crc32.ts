/**
 * CRC-32 (IEEE 802.3, reflected polynomial 0xEDB88320) over byte arrays —
 * the standard ZIP entry checksum. CRC detects container or journal
 * corruption (ADR-0004); it is never semantic identity, which is SHA-256
 * over the canonical semantic bytes.
 */

const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let value = i;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  }
  TABLE[i] = value >>> 0;
}

/** CRC-32 of a byte array as an unsigned 32-bit integer. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffff_ffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ (TABLE[(crc ^ byte) & 0xff] as number);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}

/** CRC-32 as the normalized 8-lowercase-hex-digit string used in indexes. */
export function crc32Hex(data: Uint8Array): string {
  return crc32(data).toString(16).padStart(8, "0");
}
