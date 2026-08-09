/**
 * Shared helpers for the glTF exporter (ADR-0011 naming policy and the
 * canonical code-unit ordering that keeps exports byte-identical whether
 * the document was created in memory or parsed from disk).
 */

/**
 * Code-unit string comparison matching the canonical JSON member order
 * (RFC 8785, `canonicalDocumentJson`), so the export is identical whether
 * the document was created in memory or parsed from disk.
 */
export const compareCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/**
 * Sanitizes a document name for glTF: removes control characters
 * (U+0000..U+001F, U+007F) and trims. Returns undefined when nothing
 * remains, so callers fall back to a deterministic `Node N` / `Material N`
 * / `Mesh N` / `Clip N` label.
 */
export function sanitizeGltfName(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  let sanitized = "";
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    sanitized += char;
  }
  sanitized = sanitized.trim();
  return sanitized.length === 0 ? undefined : sanitized;
}

/** Deterministic unique-name allocator (ADR-0011 naming policy). */
export class NameAllocator {
  readonly #used = new Set<string>();

  /** Allocates `base`, or the fallback when base is undefined or empty. */
  allocate(base: string | undefined, fallback: string): string {
    const root = base === undefined || base.length === 0 ? fallback : base;
    let candidate = root;
    let suffix = 2;
    while (this.#used.has(candidate)) {
      candidate = `${root}-${String(suffix)}`;
      suffix += 1;
    }
    this.#used.add(candidate);
    return candidate;
  }
}
