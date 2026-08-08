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
export type DocumentId = OpaqueId<"DocumentId">;
export type NodeId = OpaqueId<"NodeId">;
export type TransactionId = OpaqueId<"TransactionId">;
export type VolumeId = OpaqueId<"VolumeId">;
export type MaterialId = number & { readonly __kind: "MaterialId" };

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

function cloneJson(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const items = value as readonly JsonValue[];
    return Object.freeze(items.map((item) => cloneJson(item)));
  }
  const record = value as Readonly<Record<string, JsonValue>>;
  return Object.freeze(
    Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, cloneJson(item)]),
    ),
  );
}

function redactCause(cause: unknown): RedactedCause | undefined {
  if (cause === undefined) return undefined;
  if (cause instanceof Error) return Object.freeze({ type: cause.name });
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
  value: string,
  kind: Kind,
): OpaqueId<Kind> {
  if (value.length === 0 || value.length > 128) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_ID",
      message: `Invalid ${kind} identifier`,
      context: { kind },
    });
  }
  return value as OpaqueId<Kind>;
}

export const animationId = (value: string): AnimationId =>
  opaqueId(value, "AnimationId");
export const commandId = (value: string): CommandId =>
  opaqueId(value, "CommandId");
export const documentId = (value: string): DocumentId =>
  opaqueId(value, "DocumentId");
export const nodeId = (value: string): NodeId => opaqueId(value, "NodeId");
export const transactionId = (value: string): TransactionId =>
  opaqueId(value, "TransactionId");
export const volumeId = (value: string): VolumeId =>
  opaqueId(value, "VolumeId");

export function materialId(value: number): MaterialId {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_MATERIAL_ID",
      message: "Material identifier must be an integer from 1 through 65535",
      context: { value },
    });
  }
  return value as MaterialId;
}

function normalize(value: JsonValue, ancestors: Set<object>): JsonValue {
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
    result = items.map((item) => normalize(item, ancestors));
  } else {
    const record = value as Readonly<Record<string, JsonValue>>;
    result = Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, normalize(record[key] as JsonValue, ancestors)]),
    );
  }
  ancestors.delete(value);
  return result;
}

/** Produces deterministic JSON by recursively sorting object keys. */
export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(normalize(value, new Set()));
}
