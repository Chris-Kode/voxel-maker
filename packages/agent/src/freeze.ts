/**
 * Shared deep-freeze for plain JSON trees. Public agent responses and
 * installed preview state are frozen so no mutable backing data escapes
 * through a public interface (ARCHITECTURE.md "authoritative state and
 * capabilities").
 */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}
