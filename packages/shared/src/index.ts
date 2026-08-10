/** JSON-compatible values accepted at deterministic public boundaries. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export type OpaqueId<Kind extends string> = string & { readonly __kind: Kind };
export type AnimationId = OpaqueId<"AnimationId">;
export type CommandId = OpaqueId<"CommandId">;
export type ComponentId = OpaqueId<"ComponentId">;
export type DocumentId = OpaqueId<"DocumentId">;
export type KeyframeId = OpaqueId<"KeyframeId">;
export type NodeId = OpaqueId<"NodeId">;
export type RecoverySessionId = OpaqueId<"RecoverySessionId">;
export type TrackId = OpaqueId<"TrackId">;
export type TransactionId = OpaqueId<"TransactionId">;
export type VolumeId = OpaqueId<"VolumeId">;
export type MaterialId = number & { readonly __kind: "MaterialId" };

/**
 * Hard default limits for standard preview images (ARCHITECTURE.md
 * "preview image | 2048x2048 and 16 MiB decoded RGBA"). Single source of
 * truth for every package that encodes or bounds preview images.
 */
export const PREVIEW_IMAGE_MAX_DIMENSION = 2048;
/** 2048x2048 pixels = 16 MiB decoded RGBA. */
export const PREVIEW_IMAGE_MAX_PIXELS =
  PREVIEW_IMAGE_MAX_DIMENSION * PREVIEW_IMAGE_MAX_DIMENSION;

/**
 * A small, exception-isolated listener set (ARCHITECTURE.md assigns event
 * utilities to `shared`). `emit` runs every listener and swallows listener
 * failures so one bad subscriber can never break the notifier; `add`
 * returns an unsubscribe function.
 */
export interface ListenerSet<T> {
  add(listener: (value: T) => void): () => void;
  emit(value: T): void;
  clear(): void;
  readonly size: number;
}

export function createListenerSet<T>(): ListenerSet<T> {
  const listeners = new Set<(value: T) => void>();
  return {
    add(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(value) {
      for (const listener of [...listeners]) {
        try {
          listener(value);
        } catch {
          // Best-effort notifications never break the emitter.
        }
      }
    },
    clear() {
      listeners.clear();
    },
    get size() {
      return listeners.size;
    },
  };
}

export type ErrorFamily =
  | "validation"
  | "conflict"
  | "limit"
  | "io"
  | "compatibility"
  | "internal";
export interface RedactedCause {
  readonly type: string;
}
export interface WorkspaceErrorData {
  readonly family: ErrorFamily;
  readonly code: string;
  readonly message: string;
  readonly path?: readonly (string | number)[];
  readonly context?: Readonly<Record<string, JsonValue>>;
  readonly cause?: RedactedCause;
}
export interface WorkspaceErrorInput extends Omit<WorkspaceErrorData, "cause"> {
  readonly cause?: unknown;
}

/**
 * Hard nesting caps for canonical JSON work (issue #44, plan §11.2): a
 * deeply nested untrusted value must fail with a structured `WorkspaceError`
 * instead of a stack-overflow `RangeError`. 512 levels is far above every
 * legitimate v1 payload (document metadata is capped at 16) and far below
 * the engine stack limit.
 */
export const CANONICAL_JSON_MAX_DEPTH = 512;

/** Structured nesting-cap failure shared by every deep JSON walker. */
export function depthLimitError(maxDepth: number): WorkspaceError {
  return new WorkspaceError({
    family: "limit",
    code: "LIMIT_EXCEEDED",
    message: `Value exceeds the maximum nesting depth of ${String(maxDepth)}`,
  });
}

function cloneJson(value: JsonValue, depth = 0): JsonValue {
  if (depth > CANONICAL_JSON_MAX_DEPTH)
    throw depthLimitError(CANONICAL_JSON_MAX_DEPTH);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const items = value as readonly JsonValue[];
    return Object.freeze(items.map((item) => cloneJson(item, depth + 1)));
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(record).map(([key, item]) => [
        key,
        cloneJson(item, depth + 1),
      ]),
    ),
  );
}

/**
 * Error names that are safe to surface in a redacted cause type (issue #67).
 * `Error.name` is mutable and attacker-controlled, so anything outside this
 * fixed allowlist collapses to the generic "Error" and hostile `name` getters
 * fall back to the same generic type: serialized errors never leak native
 * details and never throw while redacting.
 */
const SAFE_CAUSE_TYPES = new Set([
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
  "AggregateError",
  "WorkspaceError",
]);

function redactCause(cause: unknown): RedactedCause | undefined {
  if (cause === undefined) return undefined;
  try {
    if (cause instanceof Error) {
      const name = cause.name;
      return Object.freeze({
        type: SAFE_CAUSE_TYPES.has(name) ? name : "Error",
      });
    }
  } catch {
    return Object.freeze({ type: "Error" });
  }
  return Object.freeze({ type: typeof cause });
}

/** Stable, user-safe error that serializes without a stack or native cause details. */
export class WorkspaceError extends Error {
  readonly family: ErrorFamily;
  readonly code: string;
  readonly path?: readonly (string | number)[];
  readonly context?: Readonly<Record<string, JsonValue>>;
  private readonly safeCause?: RedactedCause;

  constructor(data: WorkspaceErrorInput) {
    super(data.message);
    this.name = "WorkspaceError";
    this.family = data.family;
    this.code = data.code;
    if (data.path !== undefined) this.path = Object.freeze([...data.path]);
    if (data.context !== undefined)
      this.context = cloneJson(data.context) as Readonly<
        Record<string, JsonValue>
      >;
    const safeCause = redactCause(data.cause);
    if (safeCause !== undefined) this.safeCause = safeCause;
  }

  toJSON(): WorkspaceErrorData {
    return {
      family: this.family,
      code: this.code,
      message: this.message,
      ...(this.path === undefined ? {} : { path: [...this.path] }),
      ...(this.context === undefined
        ? {}
        : {
            context: cloneJson(this.context) as Readonly<
              Record<string, JsonValue>
            >,
          }),
      ...(this.safeCause === undefined ? {} : { cause: { ...this.safeCause } }),
    };
  }
}

export function opaqueId<Kind extends string>(
  value: unknown,
  kind: Kind,
): OpaqueId<Kind> {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_ID",
      message: `Invalid ${kind} identifier`,
      context: { kind },
    });
  }
  return value as OpaqueId<Kind>;
}

export const animationId = (value: unknown): AnimationId =>
  opaqueId(value, "AnimationId");
export const commandId = (value: unknown): CommandId =>
  opaqueId(value, "CommandId");
export const componentId = (value: unknown): ComponentId =>
  opaqueId(value, "ComponentId");
export const documentId = (value: unknown): DocumentId =>
  opaqueId(value, "DocumentId");
export const keyframeId = (value: unknown): KeyframeId =>
  opaqueId(value, "KeyframeId");
export const nodeId = (value: unknown): NodeId => opaqueId(value, "NodeId");
export const recoverySessionId = (value: unknown): RecoverySessionId =>
  opaqueId(value, "RecoverySessionId");
export const trackId = (value: unknown): TrackId => opaqueId(value, "TrackId");
export const transactionId = (value: unknown): TransactionId =>
  opaqueId(value, "TransactionId");
export const volumeId = (value: unknown): VolumeId =>
  opaqueId(value, "VolumeId");

export function materialId(value: unknown): MaterialId {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65_535
  ) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_MATERIAL_ID",
      message: "Material identifier must be an integer from 1 through 65535",
      // Wrong runtime types may not be JSON-serializable (e.g. BigInt) and
      // non-finite numbers are not canonical JSON, so carry only the type
      // name in context; finite numbers are always safe to embed.
      context:
        typeof value === "number" && Number.isFinite(value)
          ? { value }
          : { valueType: value === null ? "null" : typeof value },
    });
  }
  return value as MaterialId;
}

function normalize(
  value: JsonValue,
  ancestors: Set<object>,
  depth = 0,
): JsonValue {
  if (depth > CANONICAL_JSON_MAX_DEPTH)
    throw depthLimitError(CANONICAL_JSON_MAX_DEPTH);
  if (
    typeof value === "number" &&
    (!Number.isFinite(value) || Object.is(value, -0))
  ) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_CANONICAL_NUMBER",
      message:
        "Canonical JSON requires finite numbers and forbids negative zero",
    });
  }
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "CYCLIC_VALUE",
      message: "Canonical JSON cannot contain cycles",
    });
  }
  ancestors.add(value);
  let result: JsonValue;
  if (Array.isArray(value)) {
    const items = value as readonly JsonValue[];
    result = items.map((item) => normalize(item, ancestors, depth + 1));
  } else {
    const record = value as Readonly<Record<string, JsonValue>>;
    result = Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [
          key,
          normalize(record[key] as JsonValue, ancestors, depth + 1),
        ]),
    );
  }
  ancestors.delete(value);
  return result;
}

/** Produces deterministic JSON by recursively sorting object keys. */
export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(normalize(value, new Set()));
}
