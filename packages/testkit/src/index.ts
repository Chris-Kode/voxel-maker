import { canonicalJson, type JsonValue } from "@voxel-maker/shared";

export const FIXED_SEED = 0x5eed_0001;

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
