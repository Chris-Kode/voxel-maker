import { describe, expect, it } from "vitest";
import { recoverySessionId, type JsonValue } from "@voxel-maker/shared";
import { WorkspaceError } from "@voxel-maker/shared";
import {
  createRecoveryJournal,
  decodeJournalFrames,
  encodeJournalFrame,
  encodeJournalHeader,
  type JournalFrame,
  type JournalLimits,
  type RecoveryJournal,
  type RecoveryJournalEvent,
} from "./journal.js";
import { createVxlProjectEncoder } from "./encoder.js";
import { MemoryProjectStorage } from "./memory-storage.js";
import type { ProjectStoragePort, RecoveryJournalPort } from "./port.js";
import type { DocumentStoreHandle } from "@voxel-maker/document/internal";
import { commitVoxel, createStore, VOLUME } from "./test-helpers.js";

const SESSION = recoverySessionId("session:journal:test:0001");
const HASH = "a".repeat(64);

const header = {
  recoverySessionId: SESSION,
  baseRevision: 0,
  baseSemanticHash: HASH,
  containerVersion: 1,
  documentSchemaVersion: 1,
  commandEnvelopeVersion: 1,
} as const;

const transaction: JsonValue = {
  transactionId: "transaction:journal:0001",
  expectedRevision: 0,
  source: "ui",
  revisionBefore: 0,
  revisionAfter: 1,
  commands: [],
};

function frame(revisionBefore: number, revisionAfter: number): JournalFrame {
  return {
    recoverySessionId: SESSION,
    containerVersion: 1,
    documentSchemaVersion: 1,
    commandEnvelopeVersion: 1,
    revisionBefore,
    revisionAfter,
    transaction,
  };
}

describe("journal frame codec", () => {
  it("round-trips a header and ordered frames with raw spans", () => {
    const bytes = concat([
      encodeJournalHeader(header),
      encodeJournalFrame(frame(0, 1)),
      encodeJournalFrame(frame(1, 2)),
    ]);
    const decoded = decodeJournalFrames(bytes);
    expect(decoded.header?.recoverySessionId).toBe(SESSION);
    expect(decoded.header?.baseRevision).toBe(0);
    expect(decoded.header?.baseSemanticHash).toBe(HASH);
    expect(decoded.frames).toHaveLength(2);
    expect(decoded.frames[0]?.frame.revisionBefore).toBe(0);
    expect(decoded.frames[0]?.frame.revisionAfter).toBe(1);
    expect(decoded.frames[1]?.frame.revisionBefore).toBe(1);
    expect(decoded.frames[1]?.frame.revisionAfter).toBe(2);
    expect(decoded.frames[1]?.offset).toBe(
      (decoded.frames[0]?.offset ?? 0) + (decoded.frames[0]?.byteLength ?? 0),
    );
    expect(decoded.corruptTail).toBeUndefined();
  });

  it("encodes identical inputs to identical bytes", () => {
    const a = concat([
      encodeJournalHeader(header),
      encodeJournalFrame(frame(0, 1)),
    ]);
    const b = concat([
      encodeJournalHeader(header),
      encodeJournalFrame(frame(0, 1)),
    ]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("reports an incomplete trailing frame as a corrupt tail", () => {
    const bytes = concat([
      encodeJournalHeader(header),
      encodeJournalFrame(frame(0, 1)),
    ]);
    const truncated = bytes.subarray(0, bytes.byteLength - 3);
    const decoded = decodeJournalFrames(truncated);
    // The header decoded; the only frame is incomplete and never guessed at.
    expect(decoded.frames).toHaveLength(0);
    expect(decoded.corruptTail?.frameIndex).toBe(1);
    expect(decoded.corruptTail?.reason).toContain("incomplete");
  });

  it("reports a checksum corruption as a corrupt tail", () => {
    const bytes = concat([
      encodeJournalHeader(header),
      encodeJournalFrame(frame(0, 1)),
    ]);
    // Flip one hex digit inside the crc32 field of the frame: JSON stays
    // valid, the recomputed checksum over the remaining payload no longer
    // matches.
    const headerLength = new DataView(bytes.buffer as ArrayBuffer).getUint32(
      0,
      true,
    );
    const frameLength = new DataView(bytes.buffer as ArrayBuffer).getUint32(
      4 + headerLength,
      true,
    );
    const payload = new TextDecoder().decode(
      bytes.subarray(4 + headerLength + 4, 4 + headerLength + 4 + frameLength),
    );
    const crcStart = payload.indexOf('"crc32":"');
    const digit = payload[crcStart + 10] as string;
    const flipped = digit === "0" ? "1" : "0";
    const corruptedPayload = new TextEncoder().encode(
      payload.slice(0, crcStart + 10) + flipped + payload.slice(crcStart + 11),
    );
    // Re-frame with the original length prefix and keep the header intact.
    const framed = new Uint8Array(
      4 + headerLength + 4 + corruptedPayload.byteLength,
    );
    framed.set(bytes.subarray(0, 4 + headerLength), 0);
    new DataView(framed.buffer).setUint32(
      4 + headerLength,
      corruptedPayload.byteLength,
      true,
    );
    framed.set(corruptedPayload, 4 + headerLength + 4);
    const decoded = decodeJournalFrames(framed);
    expect(decoded.frames).toHaveLength(0);
    expect(decoded.corruptTail?.frameIndex).toBe(1);
    expect(decoded.corruptTail?.reason).toContain("checksum");
  });

  it("reports a huge length prefix as a corrupt tail without allocating", () => {
    const bytes = concat([encodeJournalHeader(header)]);
    const withHuge = new Uint8Array(bytes.byteLength + 7);
    withHuge.set(bytes, 0);
    new DataView(withHuge.buffer).setUint32(
      bytes.byteLength,
      0xffff_ffff,
      true,
    );
    withHuge.set([1, 2, 3], bytes.byteLength + 4);
    const decoded = decodeJournalFrames(withHuge);
    expect(decoded.frames).toHaveLength(0);
    expect(decoded.corruptTail?.frameIndex).toBe(1);
    expect(decoded.corruptTail?.reason).toContain("limit");
  });

  it("reports an empty file and a frame-before-header honestly", () => {
    expect(
      decodeJournalFrames(new Uint8Array(0)).corruptTail?.reason,
    ).toContain("header");
    const onlyFrame = encodeJournalFrame(frame(0, 1));
    expect(decodeJournalFrames(onlyFrame).corruptTail?.reason).toContain(
      "header",
    );
  });

  it("rejects non-contiguous revision transitions", () => {
    const bytes = concat([
      encodeJournalHeader(header),
      encodeJournalFrame(frame(0, 1)),
      encodeJournalFrame(frame(2, 3)),
    ]);
    const decoded = decodeJournalFrames(bytes);
    expect(decoded.frames).toHaveLength(1);
    expect(decoded.corruptTail?.frameIndex).toBe(2);
    expect(decoded.corruptTail?.reason).toContain("contiguous");
  });

  it("rejects a frame whose identity differs from the header", () => {
    const foreign = encodeJournalFrame({
      ...frame(0, 1),
      recoverySessionId: recoverySessionId("session:journal:other"),
    });
    const bytes = concat([encodeJournalHeader(header), foreign]);
    const decoded = decodeJournalFrames(bytes);
    expect(decoded.frames).toHaveLength(0);
    expect(decoded.corruptTail?.frameIndex).toBe(1);
    expect(decoded.corruptTail?.reason).toContain("differ");
  });

  it("rejects a journal file over the byte limit", () => {
    const limits: JournalLimits = { maxFrameBytes: 1024, maxJournalBytes: 64 };
    const bytes = concat([encodeJournalHeader(header)]);
    expect(() => decodeJournalFrames(bytes, limits)).toThrowError(
      WorkspaceError,
    );
  });
});

type JournalPort = ProjectStoragePort & RecoveryJournalPort;

/** Memory port that can fail journal writes and record call order. */
class ScriptedJournalPort extends MemoryProjectStorage {
  failNextAppend = false;
  /** Writes the bytes then fails the flush (crash-like partial or full write). */
  failNextAppendAfterWrite: "partial" | "full" | undefined;
  failNextReplace = false;
  failNextSnapshotWrite = false;
  /** When set, the next appendJournal call waits on this promise before writing. */
  appendGate: Promise<void> | undefined;
  readonly order: string[] = [];

  override async appendJournal(path: string, bytes: Uint8Array): Promise<void> {
    this.order.push(`append:${String(bytes.byteLength)}`);
    const gate = this.appendGate;
    this.appendGate = undefined;
    if (gate !== undefined) await gate;
    if (this.failNextAppend) {
      this.failNextAppend = false;
      throw new WorkspaceError({
        family: "io",
        code: "IO_DISK_FULL",
        message: "simulated disk full",
        context: { path },
      });
    }
    const mode = this.failNextAppendAfterWrite;
    if (mode !== undefined) {
      this.failNextAppendAfterWrite = undefined;
      await super.appendJournal(
        path,
        mode === "partial"
          ? bytes.subarray(0, Math.max(1, Math.floor(bytes.byteLength / 2)))
          : bytes,
      );
      throw new WorkspaceError({
        family: "io",
        code: "IO_SYNC_FAILED",
        message: "simulated flush failure",
        context: { path },
      });
    }
    return super.appendJournal(path, bytes);
  }

  override async replaceJournal(
    path: string,
    bytes: Uint8Array,
  ): Promise<void> {
    this.order.push(`replace:${String(bytes.byteLength)}`);
    if (this.failNextReplace) {
      this.failNextReplace = false;
      throw new WorkspaceError({
        family: "io",
        code: "IO_WRITE_FAILED",
        message: "simulated replace failure",
        context: { path },
      });
    }
    return super.replaceJournal(path, bytes);
  }

  override async writeProjectAtomic(
    path: string,
    bytes: Uint8Array,
  ): Promise<import("./port.js").AtomicWriteResult> {
    this.order.push("snapshot");
    if (this.failNextSnapshotWrite) {
      this.failNextSnapshotWrite = false;
      throw new WorkspaceError({
        family: "io",
        code: "IO_DISK_FULL",
        message: "simulated snapshot failure",
        context: { path },
      });
    }
    return super.writeProjectAtomic(path, bytes);
  }
}

interface JournalHarness {
  readonly journal: RecoveryJournal;
  readonly store: DocumentStoreHandle["store"];
  readonly writeCapability: DocumentStoreHandle["writeCapability"];
  /** Commits one voxel and appends its frame to the journal. */
  commitAndAppend(): Promise<number>;
}

function createJournal(
  port: JournalPort,
  options: {
    readonly sessionId?: typeof SESSION;
    readonly baseRevision?: number;
    readonly baseSemanticHash?: string;
    readonly limits?: Partial<JournalLimits>;
    readonly projectPath?: string;
  } = {},
): JournalHarness {
  const handle = createStore();
  const { store } = handle;
  const journal = createRecoveryJournal({
    projectPath: options.projectPath ?? "project.vxl",
    port,
    sessionId: options.sessionId ?? SESSION,
    baseRevision: options.baseRevision ?? 0,
    baseSemanticHash: options.baseSemanticHash ?? HASH,
    encoder: createVxlProjectEncoder(),
    capture: () => ({
      revision: store.revision,
      semanticHash: HASH,
      document: store.getDocument(),
      volumes: new Map(),
    }),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return {
    journal,
    store,
    writeCapability: handle.writeCapability,
    async commitAndAppend() {
      const revision = commitVoxel(store, handle.writeCapability, [0, 0, 0], 1);
      await journal.journal({
        revisionBefore: revision - 1,
        revisionAfter: revision,
        transaction: { revision } as JsonValue,
      });
      return revision;
    },
  };
}

describe("RecoveryJournal", () => {
  it("appends ordered checksummed frames and tracks the last journaled revision", async () => {
    const port = new ScriptedJournalPort();
    const harness = createJournal(port);
    const events: RecoveryJournalEvent[] = [];
    harness.journal.subscribe((event) => events.push(event));

    await harness.commitAndAppend();
    await harness.commitAndAppend();
    expect(harness.journal.lastJournaledRevision()).toBe(2);
    expect(harness.journal.isDegraded()).toBe(false);
    expect(events.some((event) => event.kind === "appended")).toBe(true);

    const bytes = await port.readJournal("project.vxl");
    const decoded = decodeJournalFrames(bytes as Uint8Array);
    expect(decoded.header?.baseRevision).toBe(0);
    expect(decoded.frames.map((entry) => entry.frame.revisionAfter)).toEqual([
      1, 2,
    ]);
    expect(port.order.filter((step) => step.startsWith("append")).length).toBe(
      2,
    );
  });

  it("a failed append leaves the edit valid and dirty and retry restores coverage", async () => {
    const port = new ScriptedJournalPort();
    const harness = createJournal(port);
    port.failNextAppend = true;
    await expect(harness.commitAndAppend()).rejects.toMatchObject({
      code: "IO_DISK_FULL",
    });
    expect(harness.journal.isDegraded()).toBe(true);
    expect(harness.journal.lastJournaledRevision()).toBeUndefined();
    // The in-memory edit is untouched: the journal never mutates the store.
    expect(harness.store.revision).toBe(1);
    expect(harness.store.getVoxel(VOLUME, [0, 0, 0])).toBe(1);

    port.failNextAppend = false;
    harness.journal.retry();
    await waitFor(() => harness.journal.lastJournaledRevision() === 1);
    expect(harness.journal.isDegraded()).toBe(false);
    const bytes = await port.readJournal("project.vxl");
    const decoded = decodeJournalFrames(bytes as Uint8Array);
    expect(decoded.frames).toHaveLength(1);
    expect(decoded.corruptTail).toBeUndefined();
  });

  it("a duplicate journal() call joins the pending append and settles with it", async () => {
    const port = new ScriptedJournalPort();
    const harness = createJournal(port);
    let release: (() => void) | undefined;
    port.appendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input = {
      revisionBefore: 0,
      revisionAfter: 1,
      transaction: { revision: 1 } as JsonValue,
    };
    const first = harness.journal.journal(input);
    const duplicate = harness.journal.journal(input);
    let firstSettled = false;
    let duplicateSettled = false;
    void first.then(
      () => {
        firstSettled = true;
      },
      () => {
        firstSettled = true;
      },
    );
    void duplicate.then(
      () => {
        duplicateSettled = true;
      },
      () => {
        duplicateSettled = true;
      },
    );
    // While the append is gated, neither caller may be told the frame is
    // durable: no frame is on disk and no revision is journaled.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(firstSettled).toBe(false);
    expect(duplicateSettled).toBe(false);
    expect(harness.journal.lastJournaledRevision()).toBeUndefined();
    const bytesWhileGated = await port.readJournal("project.vxl");
    expect(
      decodeJournalFrames(bytesWhileGated as Uint8Array).frames,
    ).toHaveLength(0);

    release?.();
    await Promise.all([first, duplicate]);
    expect(harness.journal.lastJournaledRevision()).toBe(1);
    const bytes = await port.readJournal("project.vxl");
    const decoded = decodeJournalFrames(bytes as Uint8Array);
    expect(decoded.frames.map((entry) => entry.frame.revisionAfter)).toEqual([
      1,
    ]);
    // The duplicate coalesced onto the pending append: only one frame was
    // ever written.
    expect(port.order.filter((step) => step.startsWith("append"))).toHaveLength(
      1,
    );
  });

  it("a duplicate journal() call rejects when the pending append fails", async () => {
    const port = new ScriptedJournalPort();
    const harness = createJournal(port);
    port.failNextAppend = true;
    let release: (() => void) | undefined;
    port.appendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const input = {
      revisionBefore: 0,
      revisionAfter: 1,
      transaction: { revision: 1 } as JsonValue,
    };
    const first = harness.journal.journal(input);
    const duplicate = harness.journal.journal(input);
    release?.();
    await expect(first).rejects.toMatchObject({ code: "IO_DISK_FULL" });
    await expect(duplicate).rejects.toMatchObject({ code: "IO_DISK_FULL" });
    expect(harness.journal.isDegraded()).toBe(true);
    expect(harness.journal.lastJournaledRevision()).toBeUndefined();
    // The failure consumed one append attempt: the duplicate never issued
    // its own write.
    expect(port.order.filter((step) => step.startsWith("append"))).toHaveLength(
      1,
    );
  });

  it("a duplicate journal() call after a failed append joins the parked task and retries it", async () => {
    const port = new ScriptedJournalPort();
    const harness = createJournal(port);
    port.failNextAppend = true;
    const input = {
      revisionBefore: 0,
      revisionAfter: 1,
      transaction: { revision: 1 } as JsonValue,
    };
    const first = harness.journal.journal(input);
    await expect(first).rejects.toMatchObject({ code: "IO_DISK_FULL" });
    expect(harness.journal.isDegraded()).toBe(true);
    expect(port.order.filter((step) => step.startsWith("append"))).toHaveLength(
      1,
    );
    // The failed append is parked at the queue head; a later duplicate
    // joins that parked task and re-attempts it instead of resolving early
    // (the frame is still not durable).
    const duplicate = harness.journal.journal(input);
    await expect(duplicate).resolves.toBeUndefined();
    expect(harness.journal.isDegraded()).toBe(false);
    expect(harness.journal.lastJournaledRevision()).toBe(1);
    // One retry append only: the duplicate coalesced onto the parked task
    // and never issued its own write.
    expect(port.order.filter((step) => step.startsWith("append"))).toHaveLength(
      2,
    );
    const bytes = await port.readJournal("project.vxl");
    const decoded = decodeJournalFrames(bytes as Uint8Array);
    expect(decoded.frames.map((entry) => entry.frame.revisionAfter)).toEqual([
      1,
    ]);
  });

  it("a duplicate journal() call joins an append queued behind an in-flight one", async () => {
    const port = new ScriptedJournalPort();
    const harness = createJournal(port);
    let release: (() => void) | undefined;
    port.appendGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = harness.journal.journal({
      revisionBefore: 0,
      revisionAfter: 1,
      transaction: { revision: 1 } as JsonValue,
    });
    // The second append queues behind the gated first one; its duplicate
    // must join that queued task instead of resolving early.
    const second = harness.journal.journal({
      revisionBefore: 1,
      revisionAfter: 2,
      transaction: { revision: 2 } as JsonValue,
    });
    const secondDuplicate = harness.journal.journal({
      revisionBefore: 1,
      revisionAfter: 2,
      transaction: { revision: 2 } as JsonValue,
    });
    let secondSettled = false;
    let duplicateSettled = false;
    void second.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );
    void secondDuplicate.then(
      () => {
        duplicateSettled = true;
      },
      () => {
        duplicateSettled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondSettled).toBe(false);
    expect(duplicateSettled).toBe(false);
    release?.();
    await Promise.all([first, second, secondDuplicate]);
    expect(harness.journal.lastJournaledRevision()).toBe(2);
    const bytes = await port.readJournal("project.vxl");
    const decoded = decodeJournalFrames(bytes as Uint8Array);
    expect(decoded.frames.map((entry) => entry.frame.revisionAfter)).toEqual([
      1, 2,
    ]);
    // Two appends total: the queued duplicate coalesced and never wrote.
    expect(port.order.filter((step) => step.startsWith("append"))).toHaveLength(
      2,
    );
  });

  it("retry never appends a duplicate frame after a complete unconfirmed write", async () => {
    const port = new ScriptedJournalPort();
    const harness = createJournal(port);
    await harness.commitAndAppend();
    // The append writes its full bytes but fails its flush: the frame is
    // already in the file when the coordinator reports the failure.
    port.failNextAppendAfterWrite = "full";
    await expect(harness.commitAndAppend()).rejects.toMatchObject({
      code: "IO_SYNC_FAILED",
    });
    expect(harness.journal.lastJournaledRevision()).toBe(1);

    harness.journal.retry();
    await waitFor(() => harness.journal.lastJournaledRevision() === 2);
    const bytes = await port.readJournal("project.vxl");
    const decoded = decodeJournalFrames(bytes as Uint8Array);
    // Exactly one frame per revision: the retry deduped the tail instead of
    // appending a duplicate.
    expect(decoded.frames.map((entry) => entry.frame.revisionAfter)).toEqual([
      1, 2,
    ]);
    expect(decoded.corruptTail).toBeUndefined();
  });

  it("repairs a partial tail from a crashed append before retrying", async () => {
    const port = new ScriptedJournalPort();
    const harness = createJournal(port);
    await harness.commitAndAppend();
    // A crash-like append writes half a frame then fails: the tail is
    // incomplete and must be repaired before the retry lands.
    port.failNextAppendAfterWrite = "partial";
    await expect(harness.commitAndAppend()).rejects.toMatchObject({
      code: "IO_SYNC_FAILED",
    });
    expect(harness.journal.isDegraded()).toBe(true);

    const events: RecoveryJournalEvent[] = [];
    harness.journal.subscribe((event) => events.push(event));
    harness.journal.retry();
    await waitFor(() => harness.journal.lastJournaledRevision() === 2);
    const repaired = await port.readJournal("project.vxl");
    const decoded = decodeJournalFrames(repaired as Uint8Array);
    expect(decoded.frames.map((entry) => entry.frame.revisionAfter)).toEqual([
      1, 2,
    ]);
    expect(decoded.corruptTail).toBeUndefined();
    expect(events.some((event) => event.kind === "journal-repaired")).toBe(
      true,
    );
  });

  it("repairs a partial tail left by a previous process on first append", async () => {
    const port = new ScriptedJournalPort();
    const harness = createJournal(port);
    await harness.commitAndAppend();
    const bytes = await port.readJournal("project.vxl");
    const partial = concat([bytes as Uint8Array, new Uint8Array([1, 2, 3])]);
    await port.replaceJournal("project.vxl", partial);

    // A fresh coordinator (new process) sees the partial tail on its first
    // append and repairs it before appending. The process recovered the
    // journaled state first, so its next commit continues at revision 2.
    const fresh = createJournal(port);
    const events: RecoveryJournalEvent[] = [];
    fresh.journal.subscribe((event) => events.push(event));
    await fresh.journal.journal({
      revisionBefore: 1,
      revisionAfter: 2,
      transaction: { revision: 2 } as JsonValue,
    });
    const repaired = await port.readJournal("project.vxl");
    const decoded = decodeJournalFrames(repaired as Uint8Array);
    expect(decoded.frames.map((entry) => entry.frame.revisionAfter)).toEqual([
      1, 2,
    ]);
    expect(decoded.corruptTail).toBeUndefined();
    expect(events.some((event) => event.kind === "journal-repaired")).toBe(
      true,
    );
  });

  it("compaction installs the snapshot before truncating the journal", async () => {
    const port = new ScriptedJournalPort();
    const harness = createJournal(port);
    await harness.commitAndAppend();
    await harness.commitAndAppend();

    port.order.length = 0;
    await harness.journal.compact();
    // The durable snapshot write precedes the journal replacement.
    expect(port.order[0]).toBe("snapshot");
    expect(port.order[1]?.startsWith("replace")).toBe(true);
    const bytes = await port.readJournal("project.vxl");
    const decoded = decodeJournalFrames(bytes as Uint8Array);
    expect(decoded.header?.baseRevision).toBe(2);
    expect(decoded.frames).toHaveLength(0);
  });

  it("a failed snapshot write during compaction leaves the journal intact", async () => {
    const port = new ScriptedJournalPort();
    const harness = createJournal(port);
    await harness.commitAndAppend();
    port.failNextSnapshotWrite = true;
    await expect(harness.journal.compact()).rejects.toMatchObject({
      code: "IO_DISK_FULL",
    });
    const bytes = await port.readJournal("project.vxl");
    const decoded = decodeJournalFrames(bytes as Uint8Array);
    expect(decoded.frames).toHaveLength(1);
    expect(harness.journal.lastJournaledRevision()).toBe(1);
  });

  it("resetBase keeps frames beyond the saved revision and drops covered ones", async () => {
    const port = new ScriptedJournalPort();
    const harness = createJournal(port);
    await harness.commitAndAppend();
    await harness.commitAndAppend();
    await harness.commitAndAppend();

    await harness.journal.resetBase(2, HASH);
    const bytes = await port.readJournal("project.vxl");
    const decoded = decodeJournalFrames(bytes as Uint8Array);
    expect(decoded.header?.baseRevision).toBe(2);
    expect(decoded.frames.map((entry) => entry.frame.revisionAfter)).toEqual([
      3,
    ]);
  });

  it("reassociate moves the recovery area and preserves the session identity", async () => {
    const port = new ScriptedJournalPort();
    const harness = createJournal(port);
    await harness.commitAndAppend();
    await port.writeProjectAtomic("project.vxl", new Uint8Array([1, 2, 3]));

    await harness.journal.reassociate("other.vxl");
    expect(await port.readJournal("project.vxl")).toBeUndefined();
    expect(await port.readJournal("other.vxl")).toBeDefined();
    expect(await port.readProject("other.vxl")).toEqual(
      new Uint8Array([1, 2, 3]),
    );
    const decoded = decodeJournalFrames(
      (await port.readJournal("other.vxl")) as Uint8Array,
    );
    expect(decoded.header?.recoverySessionId).toBe(SESSION);

    // Appends after reassociation land at the new path with the same id.
    await harness.commitAndAppend();
    const after = decodeJournalFrames(
      (await port.readJournal("other.vxl")) as Uint8Array,
    );
    expect(after.frames.map((entry) => entry.frame.revisionAfter)).toEqual([
      1, 2,
    ]);
  });

  it("reassociate to the current path retains the journal and keeps appends recoverable (issue #52)", async () => {
    const port = new ScriptedJournalPort();
    const harness = createJournal(port);
    await harness.commitAndAppend();
    await port.writeProjectAtomic("project.vxl", new Uint8Array([1, 2, 3]));
    const journalBefore = (await port.readJournal("project.vxl")) as Uint8Array;
    const projectBefore = await port.readProject("project.vxl");
    const orderBefore = [...port.order];

    await harness.journal.reassociate("project.vxl");

    // The recovery area is untouched: byte-identical journal and snapshot,
    // same confirmed revision, still non-degraded.
    expect(await port.readJournal("project.vxl")).toEqual(journalBefore);
    expect(await port.readProject("project.vxl")).toEqual(projectBefore);
    expect(harness.journal.lastJournaledRevision()).toBe(1);
    expect(harness.journal.isDegraded()).toBe(false);
    // The same-path reassociation performed no snapshot, journal replace,
    // or journal removal I/O at all.
    expect(port.order).toEqual(orderBefore);

    // Later appends land in the same journal with the same identity.
    await harness.commitAndAppend();
    const after = decodeJournalFrames(
      (await port.readJournal("project.vxl")) as Uint8Array,
    );
    expect(after.header?.recoverySessionId).toBe(SESSION);
    expect(after.frames.map((entry) => entry.frame.revisionAfter)).toEqual([
      1, 2,
    ]);
  });

  it("refuses to append to a journal owned by a different session", async () => {
    const port = new ScriptedJournalPort();
    const foreign = createJournal(port, {
      sessionId: recoverySessionId("session:journal:foreign"),
    });
    await foreign.commitAndAppend();
    const harness = createJournal(port);
    await expect(harness.commitAndAppend()).rejects.toMatchObject({
      code: "JOURNAL_SESSION_MISMATCH",
    });
    expect(harness.journal.isDegraded()).toBe(true);
    // The foreign journal is untouched.
    const bytes = await port.readJournal("project.vxl");
    const decoded = decodeJournalFrames(bytes as Uint8Array);
    expect(decoded.frames).toHaveLength(1);
  });

  it("journal overflow schedules snapshot work so appends keep flowing", async () => {
    const port = new ScriptedJournalPort();
    const harness = createJournal(port, {
      limits: { maxFrameBytes: 4096, maxJournalBytes: 4096 },
    });
    for (let index = 0; index < 20; index += 1) {
      await harness.commitAndAppend();
    }
    expect(harness.journal.lastJournaledRevision()).toBe(20);
    expect(
      port.order.filter((step) => step === "snapshot").length,
    ).toBeGreaterThan(0);
    const bytes = await port.readJournal("project.vxl");
    const decoded = decodeJournalFrames(bytes as Uint8Array);
    // The journal ends at the live revision and stays under the limit;
    // compaction dropped covered frames along the way.
    expect(decoded.frames[decoded.frames.length - 1]?.frame.revisionAfter).toBe(
      20,
    );
    expect(bytes?.byteLength ?? 0).toBeLessThanOrEqual(4096);
    expect(decoded.corruptTail).toBeUndefined();
  });
});

function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("timed out");
}
