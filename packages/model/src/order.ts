/** Deterministic key comparators shared by canonical encoding and validation. */

export const compareCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

export const compareNumeric = (a: string, b: string): number =>
  Number(a) - Number(b);
