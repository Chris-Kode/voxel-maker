import type { JsonValue } from "@voxel-maker/shared";

/**
 * Deterministic response-budget accounting for inspection tools (plan
 * S11.10). Every payload item is measured in serialized JSON code units
 * (`JSON.stringify(...).length`) before it is emitted; items that do not
 * fit mark the response `truncated` and are dropped. Measurements are
 * pure and deterministic, so identical documents and arguments produce
 * identical truncation points.
 */

/** Serialized size of a JSON value in code units (4 for `null`). */
export function jsonUnits(value: unknown): number {
  return JSON.stringify(value).length;
}

/**
 * Tracks the remaining response budget. Handlers reserve units for every
 * item they emit; the first item that does not fit sets `truncated` and is
 * rejected, after which handlers stop emitting optional content.
 */
export class ResponseBudget {
  #remaining: number;
  #truncated = false;

  constructor(readonly maxUnits: number) {
    this.#remaining = maxUnits;
  }

  get remaining(): number {
    return this.#remaining;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  /**
   * Reserves `units` unconditionally (for required scalar fields). Marks
   * the response truncated when the reservation exceeds the budget.
   */
  reserve(units: number): void {
    this.#remaining -= units;
    if (this.#remaining < 0) this.#truncated = true;
  }

  /**
   * Attempts to reserve the serialized size of `value`; returns false (and
   * marks the response truncated) when it does not fit.
   */
  tryReserve(value: unknown): boolean {
    const units = jsonUnits(value);
    if (units > this.#remaining) {
      this.#truncated = true;
      return false;
    }
    this.#remaining -= units;
    return true;
  }
}

/**
 * Clamps a string to `maxLength` UTF-16 code units on a character
 * boundary. Returns the clamped prefix and whether truncation happened.
 * Clamped names stay readable and deterministic; callers may append a
 * truncation marker when the enclosing list is not already flagged.
 */
export function clampString(
  value: string,
  maxLength: number,
): { readonly value: string; readonly truncated: boolean } {
  if (value.length <= maxLength) return { value, truncated: false };
  let end = maxLength;
  while (end > 0 && (value.charCodeAt(end - 1) & 0xfc00) === 0xdc00) {
    end -= 1;
  }
  if (end > 0 && (value.charCodeAt(end - 1) & 0xfc00) === 0xd800) {
    end -= 1;
  }
  return { value: value.slice(0, end), truncated: true };
}

/**
 * Emits `items` into a JSON array while the response budget allows.
 * Returns the emitted list plus whether the tail was dropped; `emit` must
 * be pure so truncation points are deterministic.
 */
export function boundedEmit<T>(
  budget: ResponseBudget,
  items: readonly T[],
  emit: (item: T, index: number) => JsonValue | undefined,
): { readonly list: readonly JsonValue[]; readonly truncated: boolean } {
  const list: JsonValue[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const source = items[index];
    if (source === undefined) break;
    const item = emit(source, index);
    if (item === undefined) continue;
    if (!budget.tryReserve(item)) return { list, truncated: true };
    list.push(item);
  }
  return { list, truncated: budget.truncated };
}
