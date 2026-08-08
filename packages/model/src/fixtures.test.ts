import { describe, expect, it } from "vitest";
import * as modelApi from "./index.js";
import {
  canonicalDocumentHash,
  canonicalDocumentJson,
  parseDocument,
  validateDocument,
} from "./index.js";
import {
  createAbstractFixture,
  createHouseFixture,
  createVehicleFixture,
} from "./fixtures.js";

const FORBIDDEN_DOMAIN_NAMES =
  /(house|vehicle|humanoid|furniture|creature|character|animal|plant|door|wheel|robot|wing|chest|tree|fish|bird|car|building)/iu;

describe("model fixtures", () => {
  it("builds house, vehicle, and abstract hierarchies that validate cleanly", () => {
    for (const fixture of [
      createHouseFixture(),
      createVehicleFixture(),
      createAbstractFixture(),
    ]) {
      expect(validateDocument(fixture)).toEqual([]);
    }
  });

  it("round-trips every fixture without changing its semantic hash", () => {
    for (const fixture of [
      createHouseFixture(),
      createVehicleFixture(),
      createAbstractFixture(),
    ]) {
      const hash = canonicalDocumentHash(fixture);
      const reloaded = parseDocument(canonicalDocumentJson(fixture));
      expect(canonicalDocumentHash(reloaded)).toBe(hash);
      expect(validateDocument(reloaded)).toEqual([]);
    }
  });

  it("keeps release fixtures deterministic across repeated runs", () => {
    const house = createHouseFixture();
    const vehicle = createVehicleFixture();
    const abstract = createAbstractFixture();
    expect(canonicalDocumentHash(house)).toBe(
      canonicalDocumentHash(createHouseFixture()),
    );
    expect(canonicalDocumentHash(vehicle)).toBe(
      canonicalDocumentHash(createVehicleFixture()),
    );
    expect(canonicalDocumentHash(abstract)).toBe(
      canonicalDocumentHash(createAbstractFixture()),
    );
  });
});

describe("generic core surface", () => {
  it("exposes no category-specific symbols from the public API", () => {
    const exportNames = Object.keys(modelApi);
    expect(exportNames.length).toBeGreaterThan(0);
    for (const name of exportNames) {
      expect(name).not.toMatch(FORBIDDEN_DOMAIN_NAMES);
    }
  });
});
