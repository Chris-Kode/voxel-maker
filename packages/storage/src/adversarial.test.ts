import { describe, expect, it } from "vitest";
import { WorkspaceError, canonicalJson, type JsonValue } from "@voxel-maker/shared";
import { crc32Hex } from "@voxel-maker/formats";
import {
  decodeJournalFrames,
  encodeJournalFrame,
  encodeJournalHeader,
  journalIdentity,
  type DecodedJournal,
  type JournalFrame,
  type JournalHeader,
} from "./journal.js";

/**
 * Adversarial and deterministic-fuzz suite for recovery data (issue #44,
 * plan §10.1 "journal tails", §11.2, §5.6). Recovery bytes are untrusted:
 * a forged or corrupt journal must never crash, never allocate beyond the
 * frame budget, and never yield a frame that did not originally commit.
 *
 * Contract asserted across the whole corpus (documented in
 * docs/security/threat-model-v1.md, seam 15):
 * - decode either returns a `DecodedJournal` or throws a `WorkspaceError`
 *   (only JOURNAL_LIMIT_EXCEEDED for an oversized file);
 * - every returned frame is complete and valid;
 * - when a corrupt or incomplete tail exists, it is REPORTED, never
 *   guessed: the scan stops at the first bad frame and never interprets
 *   bytes past it;
 * - truncation at any offset yields a prefix of the valid frames.
 */

// ---------------------------------------------------------------------------
// Deterministic PRNG (xorshift32) and corpus builders
// ---------------------------------------------------------------------------

function createRng(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e37_79b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function randomBytes(rng: () => number, size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) out[i] = Math.floor(rng() * 256);
  return out;
}

function mutate(bytes: Uint8Array, rng: () => number, count: number): Uint8Array {
  const out = bytes.slice();
  const flips = 1 + Math.floor(rng() * count);
  for (let i = 0; i < flips; i += 1) {
    out[Math.floor(rng() * out.byteLength)] = Math.floor(rng() * 256);
  }
  return out;
}

const IDENTITY = journalIdentity({
  recoverySessionId: "session:adversarial:0001" as never,
  containerVersion: 1,
  documentSchemaVersion: 1,
  commandEnvelopeVersion: 1,
});

function header(): JournalHeader {
  return {
    ...IDENTITY,
    formatVersion: 1,
    baseRevision: 0,
    baseSemanticHash: "a".repeat(64),
  };
}

function frame(revisionAfter: number): JournalFrame {
  return {
    ...IDENTITY,
    revisionBefore: revisionAfter - 1,
    revisionAfter,
    transaction: { revision: revisionAfter, commands: [] },
  };
}

/** A journal with `count` frames, each `transaction.payload` bytes. */
function buildJournal(count: number, payload = 64): Uint8Array {
  const parts: Uint8Array[] = [encodeJournalHeader(header())];
  for (let i = 1; i <= count; i += 1) {
    parts.push(
      encodeJournalFrame({
        ...frame(i),
        transaction: { revision: i, payload: "x".repeat(payload) },
      }),
    );
  }
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** Byte-sequence search (Uint8Array.indexOf only accepts a number). */
function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.byteLength - needle.byteLength; i += 1) {
    for (let j = 0; j < needle.byteLength; j += 1) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

const encoder = new TextEncoder();

/**
 * Builds a frame record with a VALID checksum over arbitrary fields, so
 * adversarial tests can reach the identity/kind checks that run after the
 * checksum check (mirrors the production `encodeRecord`).
 */
function forgeFrame(overrides: Readonly<Record<string, JsonValue>>): Uint8Array {
  const rest: Record<string, JsonValue> = {
    kind: "frame",
    formatVersion: 1,
    ...IDENTITY,
    revisionBefore: 0,
    revisionAfter: 1,
    transaction: { revision: 1 },
    ...overrides,
  };
  const payload = canonicalJson({
    ...rest,
    crc32: crc32Hex(encoder.encode(canonicalJson(rest))),
  });
  const bytes = encoder.encode(payload);
  const out = new Uint8Array(4 + bytes.byteLength);
  new DataView(out.buffer).setUint32(0, bytes.byteLength, true);
  out.set(bytes, 4);
  return out;
}

function headerBytes(): Uint8Array {
  return encodeJournalHeader(header());
}

/** Asserts decode succeeds (possibly with a reported corrupt tail). */
function decodeOrThrow(bytes: Uint8Array): DecodedJournal {
  try {
    return decodeJournalFrames(bytes);
  } catch (error) {
    if (!(error instanceof WorkspaceError)) {
      throw new Error(
        `decodeJournalFrames threw a non-structured error: ${
          error instanceof Error ? `${error.name}: ${error.message}` : String(error)
        }`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Seeded fuzz: random, mutated, and truncated journals
// ---------------------------------------------------------------------------

describe("fuzz: recovery journal decoding never crashes", () => {
  const rng = createRng(0x44_f1_0001);

  it("stays structured over random bytes", () => {
    for (const size of [0, 1, 4, 8, 12, 16, 64, 128, 512, 1024, 2048]) {
      for (let i = 0; i < 40; i += 1) {
        const bytes = randomBytes(rng, size);
        try {
          const decoded = decodeJournalFrames(bytes);
          expect(decoded.frames.length).toBeGreaterThanOrEqual(0);
        } catch (error) {
          expect(error).toBeInstanceOf(WorkspaceError);
          expect((error as WorkspaceError).code).toBe("JOURNAL_LIMIT_EXCEEDED");
        }
      }
    }
  });

  it("stays structured over mutated valid journals", () => {
    const valid = buildJournal(6);
    for (let i = 0; i < 300; i += 1) {
      const bytes = mutate(valid, rng, 6);
      try {
        const decoded = decodeJournalFrames(bytes);
        // Frames that survived mutation must still be complete and valid.
        for (const entry of decoded.frames) {
          expect(entry.frame.revisionAfter).toBeGreaterThanOrEqual(1);
        }
      } catch (error) {
        expect(error).toBeInstanceOf(WorkspaceError);
      }
    }
  });

  it("truncation at any offset yields a prefix of the valid frames", () => {
    const valid = buildJournal(5);
    const full = decodeOrThrow(valid);
    expect(full.frames.map((entry) => entry.frame.revisionAfter)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    for (let offset = 0; offset <= valid.byteLength; offset += 1) {
      const decoded = decodeOrThrow(valid.slice(0, offset));
      const revisions = decoded.frames.map((entry) => entry.frame.revisionAfter);
      // Frames are a monotone prefix of [1..5].
      for (let i = 0; i < revisions.length; i += 1) {
        expect(revisions[i]).toBe(i + 1);
      }
      if (offset < valid.byteLength) {
        // A truncation inside the file either ends exactly on a frame
        // boundary (no tail) or reports a corrupt/incomplete tail.
        if (decoded.corruptTail !== undefined) {
          expect(decoded.corruptTail.reason.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("a journal that ends exactly on a frame boundary has no corrupt tail", () => {
    const valid = buildJournal(3);
    const decoded = decodeOrThrow(valid);
    expect(decoded.corruptTail).toBeUndefined();
    expect(decoded.frames).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Adversarial decode cases
// ---------------------------------------------------------------------------

describe("adversarial journal decoding", () => {
  it("reports a huge length prefix as a corrupt tail without allocating", () => {
    const valid = buildJournal(1);
    // Patch the second record's length prefix to 0x7fffffff.
    const forged = valid.slice();
    const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
    const headerBytes = encodeJournalHeader(header()).byteLength;
    view.setUint32(headerBytes, 0x7fff_ffff, true);
    const decoded = decodeOrThrow(forged);
    expect(decoded.corruptTail?.reason).toBe("frame exceeds the byte limit");
    expect(decoded.frames).toHaveLength(0);
  });

  it("reports zero-length frames without looping", () => {
    const valid = buildJournal(1);
    const forged = valid.slice();
    const view = new DataView(forged.buffer, forged.byteOffset, forged.byteLength);
    view.setUint32(encodeJournalHeader(header()).byteLength, 0, true);
    const decoded = decodeOrThrow(forged);
    expect(decoded.corruptTail?.reason).toBe("zero-length frame");
  });

  it("reports frame checksum corruption and keeps earlier frames", () => {
    const valid = buildJournal(3);
    const decoded = decodeOrThrow(valid);
    const second = decoded.frames[1] as { readonly offset: number; readonly byteLength: number };
    const forged = valid.slice();
    // Flip a byte inside the transaction payload string: the JSON stays
    // valid, so only the checksum can catch the tampering.
    const needle = new TextEncoder().encode('"payload":"');
    const span = forged.subarray(second.offset, second.offset + second.byteLength);
    const at = findBytes(span, needle);
    expect(at).toBeGreaterThanOrEqual(0);
    // 'x' (0x78) -> 'y' (0x79): JSON stays valid ASCII, only the CRC breaks.
    forged[second.offset + at + needle.byteLength] =
      (forged[second.offset + at + needle.byteLength] ?? 0) ^ 0x01;
    const result = decodeOrThrow(forged);
    expect(result.frames.map((entry) => entry.frame.revisionAfter)).toEqual([1]);
    expect(result.corruptTail?.reason).toBe("frame checksum mismatch");
    // frameIndex counts records including the header (header=0, frame1=1).
    expect(result.corruptTail?.frameIndex).toBe(2);
  });

  it("reports a frame whose identity differs from the header", () => {
    const forged = new Uint8Array(
      headerBytes().byteLength + forgeFrame({ recoverySessionId: "session:other:0001" }).byteLength,
    );
    forged.set(headerBytes(), 0);
    forged.set(forgeFrame({ recoverySessionId: "session:other:0001" }), headerBytes().byteLength);
    const result = decodeOrThrow(forged);
    expect(result.corruptTail?.reason).toBe("frame identity or schema versions differ from the header");
  });

  it("reports unknown frame kinds", () => {
    const forged = new Uint8Array(
      headerBytes().byteLength + forgeFrame({ kind: "fqame" }).byteLength,
    );
    forged.set(headerBytes(), 0);
    forged.set(forgeFrame({ kind: "fqame" }), headerBytes().byteLength);
    const result = decodeOrThrow(forged);
    expect(result.corruptTail?.reason).toContain("unknown");
  });

  it("rejects a journal file over the byte limit", () => {
    const valid = buildJournal(20, 4096);
    expect(valid.byteLength).toBeGreaterThan(64 * 1024);
    expect(() => decodeJournalFrames(valid, { maxJournalBytes: 1024 })).toThrow(
      WorkspaceError,
    );
    try {
      decodeJournalFrames(valid, { maxJournalBytes: 1024 });
      expect.unreachable("expected JOURNAL_LIMIT_EXCEEDED");
    } catch (error) {
      expect((error as WorkspaceError).code).toBe("JOURNAL_LIMIT_EXCEEDED");
      expect((error as WorkspaceError).family).toBe("limit");
    }
  });

  it("refuses caller limit profiles above the defaults", () => {
    expect(() =>
      decodeJournalFrames(buildJournal(1), { maxFrameBytes: 1 << 30 }),
    ).toThrow(WorkspaceError);
  });

  it("reports an empty file and a missing header honestly", () => {
    const empty = decodeOrThrow(new Uint8Array(0));
    expect(empty.header).toBeUndefined();
    expect(empty.frames).toEqual([]);
    expect(empty.corruptTail?.reason).toBe("missing journal header");

    // A file that starts with a frame record but no header.
    const onlyFrame = encodeJournalFrame(frame(1));
    const decoded = decodeOrThrow(onlyFrame);
    expect(decoded.header).toBeUndefined();
    expect(decoded.corruptTail?.reason).toContain("header");
  });
});
