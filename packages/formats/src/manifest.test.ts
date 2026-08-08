import { describe, expect, it } from "vitest";
import { volumeId } from "@voxel-maker/shared";
import {
  decodeManifest,
  encodeManifest,
  VXL_CHUNK_ENCODING_VERSION,
  VXL_CONTAINER_VERSION,
  VXL_DOCUMENT_VERSION,
  type VxlManifest,
} from "./manifest.js";

const manifest = (): VxlManifest => ({
  containerVersion: VXL_CONTAINER_VERSION,
  documentSchemaVersion: VXL_DOCUMENT_VERSION,
  chunkEncodingVersion: VXL_CHUNK_ENCODING_VERSION,
  features: Object.freeze({}),
  semanticHash: "ab".repeat(32),
  entries: Object.freeze([
    {
      name: "document.json",
      kind: "document",
      size: 42,
      crc32: "01234567",
    },
    {
      name: "voxels/volume%3Ademo%3A0001.bin",
      kind: "voxels",
      volumeId: volumeId("volume:demo:0001"),
      size: 28,
      crc32: "89abcdef",
    },
  ]),
});

/** Adds an unknown top-level field to the encoded manifest JSON. */
function canonicalJsonWithUnknownField(manifest: VxlManifest): string {
  const bytes = encodeManifest(manifest);
  const json = new TextDecoder().decode(bytes);
  return json.replace(/^\{/u, '{"surprise":1,');
}

/** Asserts that `fn` throws a WorkspaceError with the exact stable code. */
function expectErrorCode(fn: () => unknown, code: string): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`Expected WorkspaceError ${code}, but nothing was thrown`);
  }
  if (
    typeof thrown === "object" &&
    thrown !== null &&
    "code" in thrown &&
    (thrown as { code: unknown }).code === code
  ) {
    return;
  }
  throw new Error(
    `Expected WorkspaceError ${code}, got ${
      thrown instanceof Error ? thrown.name : typeof thrown
    }`,
  );
}

describe("manifest codec", () => {
  it("round-trips and is canonical and deterministic", () => {
    const bytes = encodeManifest(manifest());
    const decoded = decodeManifest(bytes);
    expect(decoded).toEqual(manifest());
    expect(
      Buffer.from(encodeManifest(manifest())).equals(Buffer.from(bytes)),
    ).toBe(true);
    // Canonical JSON: sorted member order, no whitespace.
    const json = new TextDecoder().decode(bytes);
    expect(
      json.startsWith('{"chunkEncodingVersion":1,"containerVersion":1,'),
    ).toBe(true);
  });

  it("rejects unsupported versions with compatibility errors", () => {
    expectErrorCode(
      () =>
        decodeManifest(
          encodeManifest({ ...manifest(), containerVersion: 2 as never }),
        ),
      "UNSUPPORTED_CONTAINER_VERSION",
    );
    expectErrorCode(
      () =>
        decodeManifest(
          encodeManifest({ ...manifest(), documentSchemaVersion: 2 as never }),
        ),
      "UNSUPPORTED_DOCUMENT_VERSION",
    );
    expectErrorCode(
      () =>
        decodeManifest(
          encodeManifest({ ...manifest(), chunkEncodingVersion: 2 as never }),
        ),
      "UNSUPPORTED_CHUNK_ENCODING_VERSION",
    );
  });

  it("rejects malformed indexes", () => {
    expectErrorCode(
      () => decodeManifest(new TextEncoder().encode("{not json")),
      "INVALID_MANIFEST",
    );
    const noDocument = {
      ...manifest(),
      entries: Object.freeze(
        (manifest().entries as readonly unknown[]).filter(
          (entry) => (entry as { kind: string }).kind !== "document",
        ),
      ),
    };
    expectErrorCode(
      () => decodeManifest(encodeManifest(noDocument as never)),
      "INVALID_MANIFEST",
    );
    const duplicate = {
      ...manifest(),
      entries: Object.freeze([
        ...(manifest().entries as readonly unknown[]),
        (manifest().entries as readonly unknown[])[0],
      ]),
    };
    expectErrorCode(
      () => decodeManifest(encodeManifest(duplicate as never)),
      "DUPLICATE_ENTRY",
    );
    const badHash = { ...manifest(), semanticHash: "zz" };
    expectErrorCode(
      () => decodeManifest(encodeManifest(badHash as never)),
      "INVALID_MANIFEST",
    );
  });

  it("rejects unknown fields in the manifest and its entries", () => {
    expectErrorCode(
      () =>
        decodeManifest(
          new TextEncoder().encode(canonicalJsonWithUnknownField(manifest())),
        ),
      "UNKNOWN_MANIFEST_FIELD",
    );
    const parsed = JSON.parse(
      new TextDecoder().decode(encodeManifest(manifest())),
    ) as { entries: Record<string, unknown>[] };
    (parsed.entries[0] as Record<string, unknown>).extra = 1;
    expectErrorCode(
      () => decodeManifest(new TextEncoder().encode(JSON.stringify(parsed))),
      "UNKNOWN_MANIFEST_FIELD",
    );
  });

  it("requires volumeId exactly on voxel entries", () => {
    const missing = {
      ...manifest(),
      entries: Object.freeze([
        (manifest().entries as readonly unknown[])[0],
        {
          name: "voxels/a.bin",
          kind: "voxels",
          size: 28,
          crc32: "89abcdef",
        },
      ]),
    };
    expectErrorCode(
      () => decodeManifest(encodeManifest(missing as never)),
      "INVALID_MANIFEST",
    );
    const extra = {
      ...manifest(),
      entries: Object.freeze([
        {
          name: "document.json",
          kind: "document",
          volumeId: volumeId("volume:demo:0001"),
          size: 42,
          crc32: "01234567",
        },
      ]),
    };
    expectErrorCode(
      () => decodeManifest(encodeManifest(extra as never)),
      "INVALID_MANIFEST",
    );
  });
});
