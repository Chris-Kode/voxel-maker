import {
  WorkspaceError,
  canonicalJson,
  commandId,
  materialId,
  volumeId,
  type CommandId,
  type JsonValue,
  type MaterialId,
  type VolumeId,
} from "@voxel-maker/shared";
import type { JsonSchema } from "@voxel-maker/agent";
import { schemaErrors } from "@voxel-maker/agent";
import {
  VOXEL_COPY_REGION_COMMAND,
  VOXEL_DELETE_REGION_COMMAND,
  VOXEL_FILL_BOX_COMMAND,
  VOXEL_FILL_CYLINDER_COMMAND,
  VOXEL_MIRROR_REGION_COMMAND,
  VOXEL_SET_BATCH_COMMAND,
  copyRegionCommand,
  deleteRegionCommand,
  fillBoxCommand,
  fillCylinderCommand,
  mirrorRegionCommand,
  setBatchCommand,
  type Command,
} from "@voxel-maker/commands";
import { estimateCommandsVoxels } from "./estimate.js";
import type { IntAabb, ShapeAxis, Vec3i } from "./geometry.js";
import { digestHex } from "./hash.js";

/**
 * Versioned deterministic generator interface (plan S14.3, ticket #37).
 * A generator maps validated parameters plus an explicit seed to a
 * bounded list of proposed generic commands. Proposals are assembled by
 * one facade that (1) validates the parameters against the generator's
 * JSON-Schema contract, (2) derives deterministic command ids from
 * (generator, version, seed, params, index), (3) preflights the
 * cumulative voxel cost using the same payload formulas the agent
 * preview session enforces, and (4) rejects proposals that would exceed
 * the bounded command/voxel budgets before any command is constructed.
 * Generators know nothing about renderers, asset categories, or the
 * document; they only emit registered generic voxel/region commands.
 */

/** Schema version of the v1 generator contract. */
export const GENERATOR_CONTRACT_VERSION = 1;

/** Bounds one generator proposal may never exceed (plan S14.3). */
export interface GeneratorLimits {
  /** Maximum proposed commands in one proposal. */
  readonly maxProposedCommands: number;
  /** Maximum cumulative proposed voxel changes in one proposal. */
  readonly maxProposedVoxels: number;
}

/** Hard defaults matching the agent preview budgets (ADR-0009). */
export const DEFAULT_GENERATOR_LIMITS: GeneratorLimits = Object.freeze({
  maxProposedCommands: 1_024,
  maxProposedVoxels: 1_000_000,
});

/**
 * Resolves caller overrides against the hard defaults; only strict
 * lowerings are honored (clamped into `[0, default]`), so no caller can
 * raise a bound past the shared budget.
 */
export function resolveGeneratorLimits(
  overrides: Partial<GeneratorLimits> | undefined,
): GeneratorLimits {
  return Object.freeze({
    maxProposedCommands: clampLimit(
      overrides?.maxProposedCommands,
      DEFAULT_GENERATOR_LIMITS.maxProposedCommands,
    ),
    maxProposedVoxels: clampLimit(
      overrides?.maxProposedVoxels,
      DEFAULT_GENERATOR_LIMITS.maxProposedVoxels,
    ),
  });
}

function clampLimit(value: number | undefined, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(value, max))
    : max;
}

/** Stable error codes of the generator facade. */
export const UNKNOWN_GENERATOR_CODE = "UNKNOWN_GENERATOR";
export const INVALID_GENERATOR_PARAMS_CODE = "INVALID_GENERATOR_PARAMS";
export const INVALID_GENERATOR_CONTEXT_CODE = "INVALID_GENERATOR_CONTEXT";
export const GENERATOR_COMMAND_LIMIT_CODE = "GENERATOR_COMMAND_LIMIT";
export const GENERATOR_VOXEL_LIMIT_CODE = "GENERATOR_VOXEL_LIMIT";
export const GENERATOR_BOUNDS_CODE = "GENERATOR_OUT_OF_BOUNDS";

/** Engine coordinate interval (ARCHITECTURE.md default limits). */
const MIN_COORDINATE = -1_048_575;
const MAX_COORDINATE = 1_048_575;
/** Engine region extent bound per axis (ARCHITECTURE.md default limits). */
const MAX_REGION_EXTENT = 2_048;

/**
 * Ambient inputs shared by every generator: the target volume, the fill
 * material, and the explicit deterministic seed. Pattern-specific values
 * live in the params; these stay in the context so every proposal carries
 * one uniform envelope.
 */
export interface GeneratorContext {
  /** Volume the proposed commands write to. */
  readonly volumeId: VolumeId;
  /** Material used by fill commands (must exist at execution time). */
  readonly material: MaterialId;
  /**
   * Explicit deterministic seed. The same (params, seed) pair always
   * yields the identical proposal; different seeds yield different
   * command ids and fingerprints.
   */
  readonly seed: string;
  /** Optional lowerings of the proposal budgets. */
  readonly limits?: Partial<GeneratorLimits>;
}

/** One bounded proposal produced by a generator. */
export interface GeneratorProposal {
  readonly generator: string;
  readonly version: number;
  readonly contractVersion: number;
  readonly seed: string;
  /** Validated parameters exactly as parsed (frozen plain JSON). */
  readonly params: JsonValue;
  readonly volumeId: VolumeId;
  readonly material: MaterialId;
  /** Proposed generic commands in execution order (frozen). */
  readonly commands: readonly Command[];
  readonly commandCount: number;
  /** Preflight cumulative proposed-voxel estimate. */
  readonly voxelEstimate: number;
  /** Bounding box of every voxel the proposal may touch. */
  readonly bounds: IntAabb;
  /** Deterministic identity: hash(generator, version, seed, params). */
  readonly fingerprint: string;
}

/**
 * One versioned generator definition. `parse` validates the raw JSON
 * params (schema plus semantic checks) and returns a frozen plain value;
 * `propose` maps validated params to generic commands with deterministic
 * ids and the proposal's bounding box. Params types are plain interfaces
 * over JSON-safe values; the facade treats them as `JsonValue` after
 * schema validation.
 */
export interface GeneratorDefinition<P = JsonValue> {
  readonly name: string;
  readonly version: number;
  readonly description: string;
  /** JSON-Schema (draft-07 subset) contract of the params. */
  readonly inputSchema: JsonSchema;
  /** Validates raw params; throws INVALID_GENERATOR_PARAMS on failure. */
  parse(value: unknown): P;
  /** Maps validated params to bounded generic commands (never throws). */
  propose(
    params: P,
    context: GeneratorContext,
  ): { readonly commands: readonly Command[]; readonly bounds: IntAabb };
}

/** Throws the stable unknown-generator error. */
export function unknownGenerator(name: string): never {
  throw new WorkspaceError({
    family: "validation",
    code: UNKNOWN_GENERATOR_CODE,
    message: `Unknown generator: ${name}`,
    context: { generator: name },
  });
}

/**
 * Validates raw params against a definition's contract and the generator's
 * semantic rules. Schema violations throw one stable error carrying every
 * schema message; semantic violations throw with their own path. The
 * parsed params are deep-frozen, so a proposal can never observe later
 * caller mutation of its own inputs.
 */
export function parseGeneratorParams<P>(
  definition: GeneratorDefinition<P>,
  value: unknown,
): P {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: INVALID_GENERATOR_PARAMS_CODE,
      message: `${definition.name} parameters must be a JSON object`,
      context: { generator: definition.name },
    });
  }
  const errors = schemaErrors(definition.inputSchema, value);
  if (errors.length > 0) {
    throw new WorkspaceError({
      family: "validation",
      code: INVALID_GENERATOR_PARAMS_CODE,
      message: `Invalid parameters for ${definition.name}: ${errors.join("; ")}`,
      context: {
        generator: definition.name,
        errors: [...errors],
      },
    });
  }
  const params = definition.parse(value);
  return deepFreeze(params) as P;
}

/** Recursively freezes validated JSON params (no cycles after validation). */
function deepFreeze(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) deepFreeze(record[key]);
  return Object.freeze(record);
}

/** Validates the ambient generator context before any proposal work. */
export function validateGeneratorContext(context: GeneratorContext): void {
  if (
    typeof context.seed !== "string" ||
    context.seed.length === 0 ||
    context.seed.length > 128
  ) {
    throw new WorkspaceError({
      family: "validation",
      code: INVALID_GENERATOR_CONTEXT_CODE,
      message:
        "Generator seed must be a non-empty string of at most 128 characters",
      context: { seed: context.seed },
    });
  }
  try {
    volumeId(context.volumeId);
    materialId(context.material);
  } catch {
    throw new WorkspaceError({
      family: "validation",
      code: INVALID_GENERATOR_CONTEXT_CODE,
      message: "Generator context must carry a valid volume id and material",
    });
  }
}

/**
 * Deterministic command id for one proposed command: a 64-bit digest of
 * (generator, version, seed, params, index). Identical proposals produce
 * identical ids; different seeds or params produce different ids, so
 * multiple proposals can be staged together without id collisions.
 */
export function proposalCommandId(
  generator: string,
  version: number,
  seed: string,
  params: JsonValue,
  index: number,
): CommandId {
  return commandId(
    `command:${generator}:${digestHex(
      canonicalJson({ generator, version, seed, params, index }),
    )}`,
  );
}

/** Deterministic proposal fingerprint (identity, not content hash). */
export function proposalFingerprint(
  generator: string,
  version: number,
  seed: string,
  params: JsonValue,
): string {
  return digestHex(canonicalJson({ generator, version, seed, params }));
}

/**
 * Bounded command factory handed to a definition's `propose`: every
 * helper derives the next command id deterministically from the proposal
 * identity and wraps the canonical generic command constructors, so
 * definitions stay declarative and can never forge ids or emit a command
 * the engine does not register.
 */
export interface GeneratorCommandFactory {
  fillBox(region: IntAabb, material?: MaterialId): Command;
  fillCylinder(
    center: Vec3i,
    radius: number,
    height: number,
    axis: ShapeAxis,
    material?: MaterialId,
  ): Command;
  copyRegion(source: IntAabb, destination: Vec3i): Command;
  deleteRegion(region: IntAabb): Command;
  mirrorRegion(region: IntAabb, axis: ShapeAxis): Command;
  setBatch(
    entries: readonly {
      readonly coordinate: Vec3i;
      readonly material: MaterialId;
    }[],
  ): Command;
}

/** Creates the deterministic command factory for one proposal. */
export function createCommandFactory<P>(
  definition: GeneratorDefinition<P>,
  params: P,
  context: GeneratorContext,
): GeneratorCommandFactory {
  let index = 0;
  const nextId = (): CommandId =>
    proposalCommandId(
      definition.name,
      definition.version,
      context.seed,
      params as JsonValue,
      index++,
    );
  return {
    fillBox: (region, material = context.material) =>
      fillBoxCommand(nextId(), {
        volumeId: context.volumeId,
        region,
        material,
      }),
    fillCylinder: (center, radius, height, axis, material = context.material) =>
      fillCylinderCommand(nextId(), {
        volumeId: context.volumeId,
        center,
        radius,
        height,
        axis,
        material,
      }),
    copyRegion: (source, destination) =>
      copyRegionCommand(nextId(), {
        volumeId: context.volumeId,
        source,
        destination,
      }),
    deleteRegion: (region) =>
      deleteRegionCommand(nextId(), {
        volumeId: context.volumeId,
        region,
      }),
    mirrorRegion: (region, axis) =>
      mirrorRegionCommand(nextId(), {
        volumeId: context.volumeId,
        region,
        axis,
      }),
    setBatch: (entries) =>
      setBatchCommand(nextId(), {
        volumeId: context.volumeId,
        entries,
      }),
  };
}

/**
 * Assembles the final bounded proposal: runs the definition, freezes the
 * commands, preflights the cumulative voxel estimate, and rejects any
 * proposal that exceeds the configured command or voxel budgets or whose
 * derived geometry leaves the engine coordinate/region limits.
 */
export function assembleProposal<P>(
  definition: GeneratorDefinition<P>,
  params: P,
  context: GeneratorContext,
): GeneratorProposal {
  validateGeneratorContext(context);
  const limits = resolveGeneratorLimits(context.limits);
  const result = definition.propose(params, context);
  const commands = Object.freeze(
    result.commands.map((command) => Object.freeze(command)),
  );
  validateDerivedBounds(commands, definition.name);
  if (commands.length > limits.maxProposedCommands) {
    throw new WorkspaceError({
      family: "limit",
      code: GENERATOR_COMMAND_LIMIT_CODE,
      message: `${definition.name} proposes ${String(commands.length)} commands which exceeds the limit of ${String(limits.maxProposedCommands)}`,
      context: {
        generator: definition.name,
        proposed: commands.length,
        max: limits.maxProposedCommands,
      },
    });
  }
  const voxelEstimate = estimateCommandsVoxels(commands);
  if (voxelEstimate > limits.maxProposedVoxels) {
    throw new WorkspaceError({
      family: "limit",
      code: GENERATOR_VOXEL_LIMIT_CODE,
      message: `${definition.name} proposes ${String(voxelEstimate)} voxel changes which exceeds the limit of ${String(limits.maxProposedVoxels)}`,
      context: {
        generator: definition.name,
        proposed: voxelEstimate,
        max: limits.maxProposedVoxels,
      },
    });
  }
  return {
    generator: definition.name,
    version: definition.version,
    contractVersion: GENERATOR_CONTRACT_VERSION,
    seed: context.seed,
    params: params as JsonValue,
    volumeId: context.volumeId,
    material: context.material,
    commands,
    commandCount: commands.length,
    voxelEstimate,
    bounds: deepFreeze({ ...result.bounds }) as IntAabb,
    fingerprint: proposalFingerprint(
      definition.name,
      definition.version,
      context.seed,
      params as JsonValue,
    ),
  };
}

/**
 * Preflight check over the DERIVED geometry of a proposal: parameter
 * schemas bound the inputs, but composed placements (copy destinations,
 * step positions, batch coordinates) are computed inside the patterns and
 * must stay inside the engine coordinate interval and region-extent
 * limits. Rejects with the stable GENERATOR_OUT_OF_BOUNDS error before
 * any command is handed to the engine, so a proposal can never fail
 * staging with a raw command-validation error.
 */
function validateDerivedBounds(
  commands: readonly Command[],
  generator: string,
): void {
  for (const command of commands) {
    const payload = command.payload as
      | Readonly<Record<string, JsonValue>>
      | undefined;
    if (payload === undefined) continue;
    switch (command.type) {
      case VOXEL_FILL_BOX_COMMAND:
      case VOXEL_DELETE_REGION_COMMAND:
      case VOXEL_MIRROR_REGION_COMMAND:
        checkRegion(payload.region, generator, command.type);
        break;
      case VOXEL_FILL_CYLINDER_COMMAND: {
        const center = payload.center;
        const radius = finiteBoundNumber(payload.radius);
        const height = finiteBoundNumber(payload.height);
        if (Array.isArray(center)) {
          checkPoint(center, generator, command.type);
          for (let axis = 0; axis < 3; axis += 1) {
            checkRange(
              (center[axis] as number) - radius,
              (center[axis] as number) + radius,
              generator,
              command.type,
            );
          }
          const axis = payload.axis;
          if (typeof axis === "string") {
            const index = axis === "x" ? 0 : axis === "y" ? 1 : 2;
            checkRange(
              center[index] as number,
              (center[index] as number) + height,
              generator,
              command.type,
            );
          }
        }
        break;
      }
      case VOXEL_COPY_REGION_COMMAND: {
        checkRegion(payload.source, generator, command.type);
        const source = payload.source;
        const destination = payload.destination;
        if (
          Array.isArray(destination) &&
          typeof source === "object" &&
          source !== null &&
          !Array.isArray(source)
        ) {
          // Array.isArray's guard cannot exclude readonly tuples, so the
          // record cast happens after the explicit runtime checks.
          const record = source as Readonly<Record<string, JsonValue>>;
          const min = record.min;
          const max = record.max;
          if (Array.isArray(min) && Array.isArray(max)) {
            const size = [
              (max[0] as number) - (min[0] as number),
              (max[1] as number) - (min[1] as number),
              (max[2] as number) - (min[2] as number),
            ];
            for (let axis = 0; axis < 3; axis += 1) {
              checkRange(
                destination[axis] as number,
                (destination[axis] as number) + (size[axis] as number),
                generator,
                command.type,
              );
            }
          }
        }
        break;
      }
      case VOXEL_SET_BATCH_COMMAND: {
        const entries = payload.entries;
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            if (
              typeof entry === "object" &&
              entry !== null &&
              Array.isArray(
                (entry as Readonly<Record<string, JsonValue>>).coordinate,
              )
            ) {
              checkPoint(
                (entry as Readonly<Record<string, JsonValue>>).coordinate,
                generator,
                command.type,
              );
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }
}

function checkPoint(point: unknown, generator: string, type: string): void {
  if (!Array.isArray(point)) return;
  for (const component of point) {
    if (
      typeof component !== "number" ||
      component < MIN_COORDINATE ||
      component > MAX_COORDINATE
    ) {
      outOfBounds(generator, type);
    }
  }
}

function checkRange(
  min: number,
  max: number,
  generator: string,
  type: string,
): void {
  if (min < MIN_COORDINATE || max > MAX_COORDINATE + 1) {
    outOfBounds(generator, type);
  }
}

function checkRegion(region: unknown, generator: string, type: string): void {
  if (typeof region !== "object" || region === null || Array.isArray(region)) {
    return;
  }
  const record = region as Readonly<Record<string, JsonValue>>;
  const min = record.min;
  const max = record.max;
  if (!Array.isArray(min) || !Array.isArray(max)) return;
  for (let axis = 0; axis < 3; axis += 1) {
    const lo = min[axis] as number;
    const hi = max[axis] as number;
    if (lo < MIN_COORDINATE || hi > MAX_COORDINATE + 1) {
      outOfBounds(generator, type);
    }
    if (hi - lo > MAX_REGION_EXTENT) {
      outOfBounds(generator, type);
    }
  }
}

function finiteBoundNumber(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function outOfBounds(generator: string, type: string): never {
  throw new WorkspaceError({
    family: "validation",
    code: GENERATOR_BOUNDS_CODE,
    message: `${generator} proposes geometry outside the engine coordinate interval or region-extent limits`,
    context: { generator, commandType: type },
  });
}

/** True when `value` is a plain JSON object (not array/null). */
export function isRecord(
  value: unknown,
): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
