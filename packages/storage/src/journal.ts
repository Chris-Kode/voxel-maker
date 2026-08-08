import {
  WorkspaceError,
  canonicalJson,
  type JsonValue,
  type RecoverySessionId,
} from "@voxel-maker/shared";
import {
  VXL_CONTAINER_VERSION,
  VXL_DOCUMENT_VERSION,
  crc32Hex,
} from "@voxel-maker/formats";
import {
  IO_ERROR_CODES,
  IO_ERROR_MESSAGES,
  storageIoError,
  type ProjectStoragePort,
  type RecoveryJournalPort,
} from "./port.js";
import type { ProjectEncoder } from "./encoder.js";
import type { RevisionSnapshot } from "./snapshot.js";

/**
 * Version 1 recovery journal (plan S5.6/S5.9/S5.10, ADR-0004, ticket #14;
 * docs/storage/recovery-journal-v1.md).
 *
 * A per-project recovery area sits beside the project file: the project
 * file itself is the durable snapshot at revision R, and `project.vxl.journal`
 * holds an ordered append-only stream of length-prefixed, checksummed
 * frames. Each frame records the container/document/command schema
 * versions, the revision transition (before/after), and the canonical
 * committed transaction as an opaque JSON payload produced by the command
 * codec (`@voxel-maker/commands`). CRC-32 detects journal corruption; it is
 * never semantic identity. Recovery loads the snapshot, replays complete
 * valid frames through normal decoding and invariants, and reports rather
 * than guesses past a corrupt tail.
 */

/** Version of the journal frame format itself. */
export const JOURNAL_FORMAT_VERSION = 1;

/** Default journal resource bounds (ADR-0009 style hard defaults). */
export interface JournalLimits {
  /** Maximum encoded bytes of one frame (length prefix + payload). */
  readonly maxFrameBytes: number;
  /** Maximum encoded bytes of the whole journal file. */
  readonly maxJournalBytes: number;
}

/** ADR-0009-style hard defaults for journal reads and writes. */
export const DEFAULT_JOURNAL_LIMITS: JournalLimits = Object.freeze({
  maxFrameBytes: 33_554_432,
  maxJournalBytes: 536_870_912,
});

/**
 * Identity carried by every journal frame (plan S5.6: container/document/
 * command schema versions) and by the header's `RecoverySessionId`: a
 * journal is only replayed against a snapshot of the same session and
 * supported schema versions.
 */
export interface JournalIdentity {
  /** Stable identity of the recovery session that owns this journal. */
  readonly recoverySessionId: RecoverySessionId;
  readonly containerVersion: number;
  readonly documentSchemaVersion: number;
  readonly commandEnvelopeVersion: number;
}

/** Durable anchor recorded in the journal header (plan S5.9 "base hash/revision"). */
export interface JournalBase extends JournalIdentity {
  /** Revision of the snapshot the journal extends (R in plan 5.6). */
  readonly baseRevision: number;
  /** Semantic hash of that snapshot (H_R in plan 5.6). */
  readonly baseSemanticHash: string;
}

/** One journaled revision transition (plan S5.6/S5.9). */
export interface JournalFrame extends JournalIdentity {
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  /** Canonical committed transaction payload (command codec JSON). */
  readonly transaction: JsonValue;
}

/** A decoded frame plus its raw byte span (used for repair and retention). */
export interface DecodedJournalFrame {
  readonly frame: JournalFrame;
  /** Byte offset of the length prefix. */
  readonly offset: number;
  /** Total encoded bytes including the length prefix. */
  readonly byteLength: number;
}

/**
 * Result of scanning a journal file. Frames are complete and valid; the
 * first corrupt or incomplete frame is reported as `corruptTail` and the
 * scan never attempts to interpret bytes past it ("reports rather than
 * guesses past a corrupt tail").
 */
export interface DecodedJournal {
  readonly header: JournalHeader | undefined;
  readonly frames: readonly DecodedJournalFrame[];
  readonly corruptTail:
    | {
        readonly frameIndex: number;
        readonly reason: string;
        readonly offset: number;
      }
    | undefined;
  readonly byteLength: number;
}

/** The header frame of a journal file. */
export interface JournalHeader extends JournalBase {
  readonly formatVersion: 1;
}

/** The four identity fields of one journal frame, as a plain value. */
export function journalIdentity(options: JournalIdentity): JournalIdentity {
  return {
    recoverySessionId: options.recoverySessionId,
    containerVersion: options.containerVersion,
    documentSchemaVersion: options.documentSchemaVersion,
    commandEnvelopeVersion: options.commandEnvelopeVersion,
  };
}

/** Input for one `journal()` append (the coordinator adds identity/versions). */
export interface JournalAppendInput {
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly transaction: JsonValue;
}

/** Immutable, frozen journal events (plan S5.9 failure notification). */
export type RecoveryJournalEvent =
  | { readonly kind: "appended"; readonly revisionAfter: number }
  | { readonly kind: "append-failed"; readonly error: WorkspaceError }
  | { readonly kind: "degraded-changed"; readonly degraded: boolean }
  | { readonly kind: "journal-repaired"; readonly droppedBytes: number }
  | { readonly kind: "compacted"; readonly revision: number }
  | {
      readonly kind: "base-reset";
      readonly revision: number;
      readonly semanticHash: string;
    }
  | { readonly kind: "reassociated"; readonly path: string };

/**
 * Ordered, append-only recovery writer for one open document (plan S5.9,
 * ticket #14). Semantic commit always precedes journaling: appends are
 * asynchronous and a failure leaves the in-memory edit valid and dirty,
 * exposes degraded durability, and schedules retry or snapshot work
 * (`retry()`/`compact()`). `lastJournaledRevision()` reports the last
 * revision whose frame was confirmed durable; a revision is never claimed
 * journaled until its append flushed.
 */
export interface RecoveryJournal {
  readonly sessionId: RecoverySessionId;
  /** Last revision whose frame was confirmed appended; undefined before the first. */
  lastJournaledRevision(): number | undefined;
  /** True while an append is failing and recovery coverage is degraded. */
  isDegraded(): boolean;
  /**
   * Enqueues one committed transaction frame. Appends never overlap and
   * run in call order. Resolves when the frame is durable; rejects on
   * failure, but the record is retained and retried by `retry()` or by the
   * next `journal()` call.
   */
  journal(input: JournalAppendInput): Promise<void>;
  /** Re-attempts a failed append (after repairing any partial tail). */
  retry(): void;
  /**
   * Compaction (acceptance criterion of ticket #14): durably installs the
   * replacement snapshot before old journal data is removed.
   */
  compact(): Promise<void>;
  /**
   * Rewrites the journal anchored at a newly confirmed snapshot: the header
   * base becomes `(revision, semanticHash)` and frames already covered by
   * that snapshot are removed (confirmed-save cleanup policy).
   */
  resetBase(revision: number, semanticHash: string): Promise<void>;
  /** Moves the recovery area to `newPath`, preserving the recovery identity. */
  reassociate(newPath: string): Promise<void>;
  subscribe(listener: (event: RecoveryJournalEvent) => void): () => void;
  /** Stops the writer; pending appends reject and the file is retained. */
  dispose(): void;
}

export interface RecoveryJournalOptions {
  readonly projectPath: string;
  readonly port: ProjectStoragePort & RecoveryJournalPort;
  readonly sessionId: RecoverySessionId;
  /** Durable anchor at session start: the snapshot the journal extends. */
  readonly baseRevision: number;
  /** Durable anchor at session start: that snapshot's semantic hash. */
  readonly baseSemanticHash: string;
  readonly encoder: ProjectEncoder;
  /** Live snapshot capture; used by compaction (snapshot work). */
  readonly capture: () => RevisionSnapshot;
  readonly containerVersion?: number;
  readonly documentSchemaVersion?: number;
  readonly commandEnvelopeVersion?: number;
  readonly limits?: Partial<JournalLimits>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const SEMANTIC_HASH_PATTERN = /^[0-9a-f]{64}$/u;
const CRC32_PATTERN = /^[0-9a-f]{8}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Bounds a caller-supplied limit profile; callers may only lower. */
function resolveLimits(
  provided: Partial<JournalLimits> | undefined,
): JournalLimits {
  if (provided === undefined) return DEFAULT_JOURNAL_LIMITS;
  const merged = { ...DEFAULT_JOURNAL_LIMITS, ...provided };
  if (merged.maxFrameBytes > DEFAULT_JOURNAL_LIMITS.maxFrameBytes) {
    throw new WorkspaceError({
      family: "limit",
      code: "LIMIT_ABOVE_DEFAULT",
      message: "Callers may only lower the journal frame byte limit",
      context: { requested: merged.maxFrameBytes },
    });
  }
  if (merged.maxJournalBytes > DEFAULT_JOURNAL_LIMITS.maxJournalBytes) {
    throw new WorkspaceError({
      family: "limit",
      code: "LIMIT_ABOVE_DEFAULT",
      message: "Callers may only lower the journal byte limit",
      context: { requested: merged.maxJournalBytes },
    });
  }
  return merged;
}

/**
 * Encodes a record as a length-prefixed frame: canonical JSON payload with
 * a CRC-32 field covering every other payload byte. The length prefix lets
 * a reader skip intact frames and stop at the first incomplete one.
 */
function encodeRecord(fields: Readonly<Record<string, JsonValue>>): Uint8Array {
  const withoutCrc = canonicalJson(fields as JsonValue);
  const payload = canonicalJson({
    ...fields,
    crc32: crc32Hex(encoder.encode(withoutCrc)),
  } as JsonValue);
  const payloadBytes = encoder.encode(payload);
  const out = new Uint8Array(4 + payloadBytes.byteLength);
  new DataView(out.buffer).setUint32(0, payloadBytes.byteLength, true);
  out.set(payloadBytes, 4);
  return out;
}

/** Encodes the journal header frame (base anchor + schema versions). */
export function encodeJournalHeader(base: JournalBase): Uint8Array {
  return encodeRecord({
    kind: "header",
    formatVersion: JOURNAL_FORMAT_VERSION,
    ...journalIdentity(base),
    baseRevision: base.baseRevision,
    baseSemanticHash: base.baseSemanticHash,
  });
}

/** Encodes one revision-transition frame. */
export function encodeJournalFrame(frame: JournalFrame): Uint8Array {
  return encodeRecord({
    kind: "frame",
    formatVersion: JOURNAL_FORMAT_VERSION,
    ...journalIdentity(frame),
    revisionBefore: frame.revisionBefore,
    revisionAfter: frame.revisionAfter,
    transaction: frame.transaction,
  });
}

interface RawRecord {
  /** Validated separately: only "header" and "frame" are supported. */
  readonly kind: string;
  readonly formatVersion: unknown;
  readonly recoverySessionId: unknown;
  readonly crc32: string;
  readonly [key: string]: unknown;
}

function parseNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  return undefined;
}

/**
 * Scans a journal file and returns every complete valid frame plus a report
 * of the first corrupt or incomplete frame. The scan never reads past the
 * reported offset, never guesses, and never allocates more than
 * `maxFrameBytes` for one frame.
 */
export function decodeJournalFrames(
  bytes: Uint8Array,
  limits: Partial<JournalLimits> = {},
): DecodedJournal {
  const resolved = resolveLimits(limits);
  if (bytes.byteLength > resolved.maxJournalBytes) {
    throw new WorkspaceError({
      family: "limit",
      code: "JOURNAL_LIMIT_EXCEEDED",
      message: "Journal file exceeds the byte limit",
      context: { bytes: bytes.byteLength, limit: resolved.maxJournalBytes },
    });
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const frames: DecodedJournalFrame[] = [];
  let header: JournalHeader | undefined;
  let offset = 0;
  let frameIndex = 0;
  let corruptTail:
    | {
        readonly frameIndex: number;
        readonly reason: string;
        readonly offset: number;
      }
    | undefined;
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength) {
      corruptTail = {
        frameIndex,
        reason: "incomplete frame length prefix",
        offset,
      };
      break;
    }
    const length = view.getUint32(offset, true);
    if (length === 0) {
      corruptTail = { frameIndex, reason: "zero-length frame", offset };
      break;
    }
    if (length > resolved.maxFrameBytes) {
      corruptTail = {
        frameIndex,
        reason: "frame exceeds the byte limit",
        offset,
      };
      break;
    }
    if (offset + 4 + length > bytes.byteLength) {
      corruptTail = {
        frameIndex,
        reason: "incomplete frame payload",
        offset,
      };
      break;
    }
    const payload = bytes.subarray(offset + 4, offset + 4 + length);
    let parsed: unknown;
    try {
      parsed = JSON.parse(decoder.decode(payload));
    } catch {
      corruptTail = { frameIndex, reason: "frame is not valid JSON", offset };
      break;
    }
    if (!isRecord(parsed) || typeof parsed.crc32 !== "string") {
      corruptTail = { frameIndex, reason: "frame has no checksum", offset };
      break;
    }
    const record = parsed as RawRecord;
    if (!CRC32_PATTERN.test(record.crc32)) {
      corruptTail = {
        frameIndex,
        reason: "frame checksum is malformed",
        offset,
      };
      break;
    }
    const crc32 = record.crc32;
    const rest: Record<string, unknown> = {};
    for (const key of Object.keys(record)) {
      if (key !== "crc32") rest[key] = record[key];
    }
    if (crc32Hex(encoder.encode(canonicalJson(rest as JsonValue))) !== crc32) {
      corruptTail = { frameIndex, reason: "frame checksum mismatch", offset };
      break;
    }
    if (record.formatVersion !== JOURNAL_FORMAT_VERSION) {
      corruptTail = {
        frameIndex,
        reason: "unsupported journal format version",
        offset,
      };
      break;
    }
    if (record.kind !== "header" && record.kind !== "frame") {
      corruptTail = { frameIndex, reason: "unknown frame kind", offset };
      break;
    }
    if (record.kind === "header") {
      if (frameIndex !== 0) {
        corruptTail = {
          frameIndex,
          reason: "header frame outside the first position",
          offset,
        };
        break;
      }
      if (
        typeof record.recoverySessionId !== "string" ||
        record.recoverySessionId.length === 0 ||
        record.recoverySessionId.length > 128 ||
        typeof record.baseRevision !== "number" ||
        !Number.isSafeInteger(record.baseRevision) ||
        record.baseRevision < 0 ||
        typeof record.baseSemanticHash !== "string" ||
        !SEMANTIC_HASH_PATTERN.test(record.baseSemanticHash) ||
        typeof record.containerVersion !== "number" ||
        !Number.isInteger(record.containerVersion) ||
        record.containerVersion < 1 ||
        typeof record.documentSchemaVersion !== "number" ||
        !Number.isInteger(record.documentSchemaVersion) ||
        record.documentSchemaVersion < 1 ||
        typeof record.commandEnvelopeVersion !== "number" ||
        !Number.isInteger(record.commandEnvelopeVersion) ||
        record.commandEnvelopeVersion < 1
      ) {
        corruptTail = {
          frameIndex,
          reason: "header fields are invalid",
          offset,
        };
        break;
      }
      header = {
        formatVersion: JOURNAL_FORMAT_VERSION,
        ...journalIdentity({
          recoverySessionId: record.recoverySessionId as RecoverySessionId,
          containerVersion: record.containerVersion,
          documentSchemaVersion: record.documentSchemaVersion,
          commandEnvelopeVersion: record.commandEnvelopeVersion,
        }),
        baseRevision: record.baseRevision,
        baseSemanticHash: record.baseSemanticHash,
      };
    } else {
      if (header === undefined) {
        corruptTail = { frameIndex, reason: "frame before the header", offset };
        break;
      }
      const revisionBefore = parseNonNegativeInt(record.revisionBefore);
      const revisionAfter = parseNonNegativeInt(record.revisionAfter);
      if (
        revisionBefore === undefined ||
        revisionAfter === undefined ||
        revisionAfter !== revisionBefore + 1
      ) {
        corruptTail = {
          frameIndex,
          reason: "frame revision transition is invalid",
          offset,
        };
        break;
      }
      if (
        record.recoverySessionId !== header.recoverySessionId ||
        record.containerVersion !== header.containerVersion ||
        record.documentSchemaVersion !== header.documentSchemaVersion ||
        record.commandEnvelopeVersion !== header.commandEnvelopeVersion
      ) {
        corruptTail = {
          frameIndex,
          reason: "frame identity or schema versions differ from the header",
          offset,
        };
        break;
      }
      if (
        typeof record.transaction !== "object" ||
        record.transaction === null ||
        Array.isArray(record.transaction)
      ) {
        corruptTail = {
          frameIndex,
          reason: "frame transaction is not an object",
          offset,
        };
        break;
      }
      const previous = frames[frames.length - 1];
      if (
        previous !== undefined &&
        previous.frame.revisionAfter !== revisionBefore
      ) {
        corruptTail = {
          frameIndex,
          reason: "frame revisions are not contiguous",
          offset,
        };
        break;
      }
      frames.push({
        frame: {
          ...journalIdentity(header),
          revisionBefore,
          revisionAfter,
          transaction: record.transaction as JsonValue,
        },
        offset,
        byteLength: 4 + length,
      });
    }
    offset += 4 + length;
    frameIndex += 1;
  }
  if (corruptTail === undefined && header === undefined) {
    corruptTail = {
      frameIndex: 0,
      reason: "missing journal header",
      offset: 0,
    };
  }
  return { header, frames, corruptTail, byteLength: bytes.byteLength };
}

function journalError(
  family: "io" | "compatibility" | "limit",
  code: string,
  message: string,
  context: Readonly<Record<string, string | number | boolean>>,
  cause?: unknown,
): WorkspaceError {
  return new WorkspaceError({
    family,
    code,
    message,
    context,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** Wraps an append failure into a stable, user-safe journal error. */
function toJournalError(error: unknown, path: string): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  return storageIoError(
    IO_ERROR_CODES.writeFailed,
    IO_ERROR_MESSAGES.writeFailed,
    { path },
    error,
  );
}

/** One queued append; the request stays queued after a durable-io failure. */
interface PendingAppend {
  readonly bytes: Uint8Array;
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/** One queued journal operation; appends, resets, compacts, and moves are serialized. */
type JournalTask =
  | { readonly kind: "append"; readonly pending: PendingAppend }
  | {
      readonly kind: "reset";
      readonly revision: number;
      readonly semanticHash: string;
      readonly resolve: () => void;
      readonly reject: (error: unknown) => void;
    }
  | {
      readonly kind: "compact";
      readonly resolve: () => void;
      readonly reject: (error: unknown) => void;
    }
  | {
      readonly kind: "reassociate";
      readonly newPath: string;
      readonly resolve: () => void;
      readonly reject: (error: unknown) => void;
    };

class RecoveryJournalImpl implements RecoveryJournal {
  readonly sessionId: RecoverySessionId;
  #projectPath: string;
  readonly #port: ProjectStoragePort & RecoveryJournalPort;
  readonly #encoder: ProjectEncoder;
  readonly #capture: () => RevisionSnapshot;
  readonly #limits: JournalLimits;
  readonly #identity: JournalIdentity;
  readonly #listeners = new Set<(event: RecoveryJournalEvent) => void>();
  readonly #queue: JournalTask[] = [];
  #baseRevision: number;
  #baseSemanticHash: string;
  #lastJournaledRevision: number | undefined;
  #lastConfirmedBytes: Uint8Array | undefined;
  #degraded = false;
  #needsRepair = false;
  #headerEnsured = false;
  #inflight = false;
  #disposed = false;

  constructor(options: RecoveryJournalOptions) {
    this.sessionId = options.sessionId;
    this.#projectPath = options.projectPath;
    this.#port = options.port;
    this.#encoder = options.encoder;
    this.#capture = options.capture;
    this.#limits = resolveLimits(options.limits);
    this.#identity = {
      recoverySessionId: options.sessionId,
      containerVersion: options.containerVersion ?? VXL_CONTAINER_VERSION,
      documentSchemaVersion:
        options.documentSchemaVersion ?? VXL_DOCUMENT_VERSION,
      commandEnvelopeVersion: options.commandEnvelopeVersion ?? 1,
    };
    this.#baseRevision = options.baseRevision;
    this.#baseSemanticHash = options.baseSemanticHash;
  }

  lastJournaledRevision(): number | undefined {
    return this.#lastJournaledRevision;
  }

  isDegraded(): boolean {
    return this.#degraded;
  }

  journal(input: JournalAppendInput): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(
        journalError(
          "io",
          IO_ERROR_CODES.writeFailed,
          "The recovery journal is disposed",
          { path: this.#projectPath },
        ),
      );
    }
    let frameBytes: Uint8Array;
    try {
      frameBytes = encodeJournalFrame({
        ...this.#identity,
        revisionBefore: input.revisionBefore,
        revisionAfter: input.revisionAfter,
        transaction: input.transaction,
      });
    } catch (error) {
      return Promise.reject(toJournalError(error, this.#projectPath));
    }
    if (frameBytes.byteLength > this.#limits.maxFrameBytes) {
      return Promise.reject(
        journalError(
          "limit",
          "JOURNAL_LIMIT_EXCEEDED",
          "Journal frame exceeds the byte limit",
          { bytes: frameBytes.byteLength, limit: this.#limits.maxFrameBytes },
        ),
      );
    }
    if (
      this.#lastConfirmedBytes !== undefined &&
      bytesEqual(this.#lastConfirmedBytes, frameBytes)
    ) {
      return Promise.resolve();
    }
    if (
      this.#queue.some(
        (task) =>
          task.kind === "append" && bytesEqual(task.pending.bytes, frameBytes),
      )
    ) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({
        kind: "append",
        pending: {
          bytes: frameBytes,
          revisionBefore: input.revisionBefore,
          revisionAfter: input.revisionAfter,
          resolve,
          reject,
        },
      });
      this.#pump();
    });
  }

  retry(): void {
    if (this.#disposed) return;
    this.#pump();
  }

  compact(): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(
        journalError(
          "io",
          IO_ERROR_CODES.writeFailed,
          "The recovery journal is disposed",
          { path: this.#projectPath },
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ kind: "compact", resolve, reject });
      this.#pump();
    });
  }

  resetBase(revision: number, semanticHash: string): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(
        journalError(
          "io",
          IO_ERROR_CODES.writeFailed,
          "The recovery journal is disposed",
          { path: this.#projectPath },
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({
        kind: "reset",
        revision,
        semanticHash,
        resolve,
        reject,
      });
      this.#pump();
    });
  }

  reassociate(newPath: string): Promise<void> {
    if (this.#disposed) {
      return Promise.reject(
        journalError(
          "io",
          IO_ERROR_CODES.writeFailed,
          "The recovery journal is disposed",
          { path: this.#projectPath },
        ),
      );
    }
    return new Promise<void>((resolve, reject) => {
      this.#queue.push({ kind: "reassociate", newPath, resolve, reject });
      this.#pump();
    });
  }

  subscribe(listener: (event: RecoveryJournalEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const disposed = journalError(
      "io",
      IO_ERROR_CODES.writeInterrupted,
      "The recovery journal was disposed",
      { path: this.#projectPath },
    );
    for (const task of this.#queue.splice(0)) {
      if (task.kind === "append") task.pending.reject(disposed);
      else task.reject(disposed);
    }
    this.#listeners.clear();
  }

  #pump(): void {
    if (this.#disposed || this.#inflight) return;
    const task = this.#queue[0];
    if (task === undefined) return;
    this.#inflight = true;
    void this.#run(task).then((outcome) => {
      this.#inflight = false;
      const head = this.#queue[0];
      const atHead = head !== undefined && head === task;
      if (outcome.ok) {
        // Every completed task leaves the queue exactly once; without this
        // the pump would re-run the same reset/compact/reassociate task
        // forever. Append tasks were already dequeued by
        // `#confirmAppended`.
        if (atHead) this.#queue.shift();
        if (!this.#disposed) this.#pump();
        return;
      }
      // Failure bookkeeping happens after the pump is idle again, so an
      // event listener (or the rejected caller) can safely retry() without
      // racing the in-flight task. After a durable-io append failure the
      // request stays queued and the pump stops: retry is explicit
      // (`retry()` or the next `journal()`). A limit failure can never
      // succeed on retry: it is dropped and the caller decides (the edit
      // stays valid; durability stays degraded).
      if (task.kind === "append") {
        this.#setDegraded(true);
        this.#needsRepair = true;
        this.#emit({ kind: "append-failed", error: outcome.error });
        if (atHead) {
          if (outcome.dropped) this.#queue.shift();
          task.pending.reject(outcome.error);
        }
        if (!this.#disposed && outcome.dropped) this.#pump();
        return;
      }
      if (atHead) this.#queue.shift();
      task.reject(outcome.error);
      if (!this.#disposed) this.#pump();
    });
  }

  /** Returns the pump outcome for the completed task. */
  async #run(task: JournalTask): Promise<
    | { readonly ok: true; readonly continued: boolean }
    | {
        readonly ok: false;
        readonly error: WorkspaceError;
        readonly dropped: boolean;
      }
  > {
    const projectPath = this.#projectPath;
    try {
      if (task.kind === "append") {
        await this.#runAppend(task.pending, projectPath);
        return { ok: true, continued: true };
      }
      if (task.kind === "reset") {
        await this.#performReset(task.revision, task.semanticHash);
        task.resolve();
        return { ok: true, continued: true };
      }
      if (task.kind === "compact") {
        await this.#performCompact();
        task.resolve();
        return { ok: true, continued: true };
      }
      await this.#performReassociate(task.newPath);
      task.resolve();
      return { ok: true, continued: true };
    } catch (error) {
      const wrapped = toJournalError(error, this.#projectPath);
      if (task.kind === "append") {
        return {
          ok: false,
          error: wrapped,
          dropped: wrapped.family === "limit",
        };
      }
      return { ok: false, error: wrapped, dropped: true };
    }
  }

  async #runAppend(pending: PendingAppend, projectPath: string): Promise<void> {
    await this.#ensureRepair(projectPath);
    await this.#ensureHeader(projectPath);
    // A failed append may have written the complete frame and then failed
    // its flush; dedup against the current tail so retry never appends a
    // duplicate frame.
    const current = await this.#port.readJournal(projectPath);
    if (
      current !== undefined &&
      current.byteLength > 0 &&
      bytesEqual(
        current.subarray(current.byteLength - pending.bytes.byteLength),
        pending.bytes,
      )
    ) {
      this.#confirmAppended(pending);
      return;
    }
    const currentBytes = current?.byteLength ?? 0;
    if (
      currentBytes + pending.bytes.byteLength >
      this.#limits.maxJournalBytes
    ) {
      // Journal overflow schedules snapshot work: install a fresh durable
      // snapshot and drop covered frames, then append on the empty tail.
      await this.#performCompact();
      const after = await this.#port.readJournal(projectPath);
      if (
        (after?.byteLength ?? 0) + pending.bytes.byteLength >
        this.#limits.maxJournalBytes
      ) {
        throw journalError(
          "limit",
          "JOURNAL_LIMIT_EXCEEDED",
          "Journal frame does not fit even after compaction",
          {
            bytes: pending.bytes.byteLength,
            limit: this.#limits.maxJournalBytes,
          },
        );
      }
    }
    await this.#port.appendJournal(projectPath, pending.bytes);
    this.#confirmAppended(pending);
  }

  #confirmAppended(pending: PendingAppend): void {
    this.#lastConfirmedBytes = pending.bytes;
    this.#lastJournaledRevision = pending.revisionAfter;
    this.#setDegraded(false);
    const head = this.#queue[0];
    if (
      head !== undefined &&
      head.kind === "append" &&
      head.pending === pending
    ) {
      this.#queue.shift();
    }
    this.#emit({ kind: "appended", revisionAfter: pending.revisionAfter });
    pending.resolve();
  }

  async #ensureRepair(projectPath: string): Promise<void> {
    if (!this.#needsRepair) return;
    this.#needsRepair = false;
    const bytes = await this.#port.readJournal(projectPath);
    if (bytes === undefined || bytes.byteLength === 0) return;
    const decoded = decodeJournalFrames(bytes, this.#limits);
    const tail = decoded.corruptTail;
    if (tail === undefined) return;
    const kept = tail.offset === 0 ? undefined : bytes.subarray(0, tail.offset);
    await this.#port.replaceJournal(
      projectPath,
      kept ?? encodeJournalHeader(this.#header()),
    );
    this.#emit({
      kind: "journal-repaired",
      droppedBytes: bytes.byteLength - (kept?.byteLength ?? 0),
    });
  }

  async #ensureHeader(projectPath: string): Promise<void> {
    if (this.#headerEnsured) return;
    const bytes = await this.#port.readJournal(projectPath);
    if (bytes === undefined || bytes.byteLength === 0) {
      await this.#port.replaceJournal(
        projectPath,
        encodeJournalHeader(this.#header()),
      );
      this.#headerEnsured = true;
      return;
    }
    const decoded = decodeJournalFrames(bytes, this.#limits);
    const header = decoded.header;
    if (header === undefined) {
      // A corrupt header means nothing is recoverable: install a fresh
      // header-only journal and let the caller's frame follow.
      await this.#port.replaceJournal(
        projectPath,
        encodeJournalHeader(this.#header()),
      );
      this.#emit({
        kind: "journal-repaired",
        droppedBytes: bytes.byteLength,
      });
      this.#headerEnsured = true;
      return;
    }
    this.#assertHeaderCompatible(header);
    if (decoded.corruptTail !== undefined) {
      // A partial tail from a crashed append is dropped (it contains no
      // complete frame); the valid prefix stays in place.
      const kept = bytes.subarray(0, decoded.corruptTail.offset);
      await this.#port.replaceJournal(projectPath, kept);
      this.#emit({
        kind: "journal-repaired",
        droppedBytes: bytes.byteLength - kept.byteLength,
      });
    }
    this.#headerEnsured = true;
  }

  /** Throws when a journal header does not belong to this session's area. */
  #assertHeaderCompatible(header: JournalHeader): void {
    if (header.recoverySessionId !== this.sessionId) {
      throw journalError(
        "compatibility",
        "JOURNAL_SESSION_MISMATCH",
        "The recovery journal belongs to a different recovery session",
        { path: this.#projectPath, sessionId: header.recoverySessionId },
      );
    }
    if (
      header.containerVersion !== this.#identity.containerVersion ||
      header.documentSchemaVersion !== this.#identity.documentSchemaVersion ||
      header.commandEnvelopeVersion !== this.#identity.commandEnvelopeVersion
    ) {
      throw journalError(
        "compatibility",
        "JOURNAL_VERSION_MISMATCH",
        "The recovery journal uses unsupported schema versions",
        { path: this.#projectPath },
      );
    }
    if (
      header.baseRevision !== this.#baseRevision ||
      header.baseSemanticHash !== this.#baseSemanticHash
    ) {
      throw journalError(
        "compatibility",
        "JOURNAL_BASE_MISMATCH",
        "The recovery journal anchor does not match the durable snapshot",
        { path: this.#projectPath },
      );
    }
  }

  /**
   * Rewrites the journal anchored at a newly confirmed snapshot: the header
   * base becomes `(revision, semanticHash)` and frames already covered by
   * that snapshot are removed (confirmed-save cleanup policy). Runs inside
   * the pump so it can never interleave with an in-flight append.
   */
  async #performReset(revision: number, semanticHash: string): Promise<void> {
    const projectPath = this.#projectPath;
    const current = await this.#port.readJournal(projectPath);
    let retained: Uint8Array = new Uint8Array(0);
    if (current !== undefined && current.byteLength > 0) {
      const decoded = decodeJournalFrames(current, this.#limits);
      const header = decoded.header;
      if (header !== undefined) {
        // Never rewrite a foreign journal: the identity check that guards
        // appends guards the confirmed-save cleanup too.
        if (header.recoverySessionId !== this.sessionId) {
          throw journalError(
            "compatibility",
            "JOURNAL_SESSION_MISMATCH",
            "The recovery journal belongs to a different recovery session",
            { path: this.#projectPath, sessionId: header.recoverySessionId },
          );
        }
        if (
          header.containerVersion !== this.#identity.containerVersion ||
          header.documentSchemaVersion !==
            this.#identity.documentSchemaVersion ||
          header.commandEnvelopeVersion !==
            this.#identity.commandEnvelopeVersion
        ) {
          throw journalError(
            "compatibility",
            "JOURNAL_VERSION_MISMATCH",
            "The recovery journal uses unsupported schema versions",
            { path: this.#projectPath },
          );
        }
        const parts: Uint8Array[] = [];
        for (const entry of decoded.frames) {
          if (entry.frame.revisionAfter > revision) {
            parts.push(
              current.subarray(entry.offset, entry.offset + entry.byteLength),
            );
          }
        }
        retained = concatBytes(parts);
      }
      // A corrupt header means nothing is recoverable; the confirmed
      // snapshot covers everything the journal could, so a fresh
      // header-only journal is installed.
    }
    const next = concatBytes([
      encodeJournalHeader({
        ...this.#identity,
        baseRevision: revision,
        baseSemanticHash: semanticHash,
      }),
      retained,
    ]);
    await this.#port.replaceJournal(projectPath, next);
    this.#baseRevision = revision;
    this.#baseSemanticHash = semanticHash;
    this.#headerEnsured = true;
    this.#emit({ kind: "base-reset", revision, semanticHash });
  }

  /**
   * Compaction (acceptance criterion of ticket #14): durably installs the
   * replacement snapshot before old journal data is removed. Runs inside
   * the pump; the overflow path calls it inline, the public `compact()`
   * enqueues it.
   */
  async #performCompact(): Promise<void> {
    const snapshot = this.#capture();
    const bytes = await this.#encoder.encodeProject(snapshot);
    await this.#port.writeProjectAtomic(this.#projectPath, bytes);
    this.#emit({ kind: "compacted", revision: snapshot.revision });
    await this.#performReset(snapshot.revision, snapshot.semanticHash);
  }

  /**
   * Moves the recovery area to `newPath` preserving the recovery identity
   * (plan S5.15 save-as reassociation). Snapshot first, then journal, then
   * removal: at every crash point at least one path keeps a recoverable
   * combination.
   */
  async #performReassociate(newPath: string): Promise<void> {
    const oldPath = this.#projectPath;
    if (await this.#port.exists(oldPath)) {
      const snapshotBytes = await this.#port.readProject(oldPath);
      await this.#port.writeProjectAtomic(newPath, snapshotBytes);
    }
    const journalBytes = await this.#port.readJournal(oldPath);
    if (journalBytes !== undefined) {
      await this.#port.replaceJournal(newPath, journalBytes);
      await this.#port.removeJournal(oldPath);
    }
    this.#projectPath = newPath;
    this.#headerEnsured = false;
    this.#emit({ kind: "reassociated", path: newPath });
  }

  #header(): JournalBase {
    return {
      ...this.#identity,
      baseRevision: this.#baseRevision,
      baseSemanticHash: this.#baseSemanticHash,
    };
  }

  #setDegraded(degraded: boolean): void {
    if (degraded === this.#degraded) return;
    this.#degraded = degraded;
    this.#emit({ kind: "degraded-changed", degraded });
  }

  #emit(event: RecoveryJournalEvent): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(event);
      } catch {
        // Listener exceptions are isolated and never break the writer.
      }
    }
  }
}

/** Creates the recovery journal writer for one open document. */
export function createRecoveryJournal(
  options: RecoveryJournalOptions,
): RecoveryJournal {
  return new RecoveryJournalImpl(options);
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
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
