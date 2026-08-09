import {
  WorkspaceError,
  type AnimationId,
  type CommandId,
  type KeyframeId,
  type NodeId,
  type TrackId,
} from "@voxel-maker/shared";
import {
  canonicalQuat,
  canonicalScale,
  canonicalVec3,
  type Quat,
  type Vec3,
} from "@voxel-maker/math";
import type {
  AnimationDescriptor,
  AnimationTrack,
  DocumentLimits,
  Interpolation,
  Keyframe,
  LoopPolicy,
  TrackProperty,
  VoxelDocument,
} from "@voxel-maker/model";
import { isRecord, parseName, parseNodeId } from "./parse-helpers.js";
import type { Command } from "./types.js";
import type {
  CommandExecution,
  CommandExecutionContext,
  CommandHandler,
  CommandValidationContext,
  InverseCommand,
  MutableDocument,
} from "./registry.js";
import { CommandRegistry } from "./registry.js";

/**
 * Clip/track/keyframe lifecycle commands (plan S10.6, ticket #28): the
 * generic animation authoring surface. Clips are bounded named track
 * collections with a duration and loop policy; tracks target one node
 * property channel; keyframes carry typed values with sorted unique
 * times. Every handler parses and bounds untrusted payloads, validates
 * against the immutable read view (target existence, limits, channel
 * compatibility, sorted unique times, duration bounds), and records exact
 * inverses so undo/redo restore the precise pre-command state. All nine
 * commands run the shared command-conformance battery.
 */

export const ANIMATION_CREATE_COMMAND = "animation.create" as const;
export const ANIMATION_UPDATE_COMMAND = "animation.update" as const;
export const ANIMATION_DELETE_COMMAND = "animation.delete" as const;
export const TRACK_ADD_COMMAND = "track.add" as const;
export const TRACK_REMOVE_COMMAND = "track.remove" as const;
export const TRACK_SET_INTERPOLATION_COMMAND =
  "track.setInterpolation" as const;
export const KEYFRAME_SET_COMMAND = "keyframe.set" as const;
export const KEYFRAME_MOVE_COMMAND = "keyframe.move" as const;
export const KEYFRAME_DELETE_COMMAND = "keyframe.delete" as const;
export const ANIMATION_COMMAND_SCHEMA_VERSION = 1;

export interface CreateAnimationPayload {
  readonly animationId: AnimationId;
  readonly name?: string;
  readonly duration: number;
  readonly loop: LoopPolicy;
}

export interface UpdateAnimationPayload {
  readonly animationId: AnimationId;
  /** New name, or `null` to remove the name (matches node.rename semantics). */
  readonly name?: string | null;
  readonly duration?: number;
  readonly loop?: LoopPolicy;
}

export interface DeleteAnimationPayload {
  readonly animationId: AnimationId;
}

export interface AddTrackPayload {
  readonly animationId: AnimationId;
  readonly trackId: TrackId;
  readonly targetNodeId: NodeId;
  readonly interpolation: Interpolation;
}

export interface RemoveTrackPayload {
  readonly animationId: AnimationId;
  readonly trackId: TrackId;
}

export interface SetTrackInterpolationPayload {
  readonly animationId: AnimationId;
  readonly trackId: TrackId;
  readonly interpolation: Interpolation;
}

export interface SetKeyframePayload {
  readonly animationId: AnimationId;
  readonly trackId: TrackId;
  readonly keyframeId: KeyframeId;
  readonly time: number;
  readonly property: TrackProperty;
}

export interface MoveKeyframePayload {
  readonly animationId: AnimationId;
  readonly trackId: TrackId;
  readonly keyframeId: KeyframeId;
  readonly time: number;
}

export interface DeleteKeyframePayload {
  readonly animationId: AnimationId;
  readonly trackId: TrackId;
  readonly keyframeId: KeyframeId;
}

/** Canonicalizing constructor for an `animation.create` command. */
export function createAnimationCommand(
  id: CommandId,
  payload: CreateAnimationPayload,
): Command<typeof ANIMATION_CREATE_COMMAND, CreateAnimationPayload> {
  return {
    id,
    type: ANIMATION_CREATE_COMMAND,
    schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
    payload: {
      animationId: payload.animationId,
      duration: payload.duration,
      loop: payload.loop,
      ...(payload.name === undefined ? {} : { name: payload.name }),
    },
  };
}

/** Canonicalizing constructor for an `animation.update` command. */
export function updateAnimationCommand(
  id: CommandId,
  payload: UpdateAnimationPayload,
): Command<typeof ANIMATION_UPDATE_COMMAND, UpdateAnimationPayload> {
  return {
    id,
    type: ANIMATION_UPDATE_COMMAND,
    schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
    payload: {
      animationId: payload.animationId,
      ...(payload.name === undefined ? {} : { name: payload.name }),
      ...(payload.duration === undefined ? {} : { duration: payload.duration }),
      ...(payload.loop === undefined ? {} : { loop: payload.loop }),
    },
  };
}

/** Canonicalizing constructor for an `animation.delete` command. */
export function deleteAnimationCommand(
  id: CommandId,
  payload: DeleteAnimationPayload,
): Command<typeof ANIMATION_DELETE_COMMAND, DeleteAnimationPayload> {
  return {
    id,
    type: ANIMATION_DELETE_COMMAND,
    schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
    payload: { animationId: payload.animationId },
  };
}

/** Canonicalizing constructor for a `track.add` command. */
export function addTrackCommand(
  id: CommandId,
  payload: AddTrackPayload,
): Command<typeof TRACK_ADD_COMMAND, AddTrackPayload> {
  return {
    id,
    type: TRACK_ADD_COMMAND,
    schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
    payload: {
      animationId: payload.animationId,
      trackId: payload.trackId,
      targetNodeId: payload.targetNodeId,
      interpolation: payload.interpolation,
    },
  };
}

/** Canonicalizing constructor for a `track.remove` command. */
export function removeTrackCommand(
  id: CommandId,
  payload: RemoveTrackPayload,
): Command<typeof TRACK_REMOVE_COMMAND, RemoveTrackPayload> {
  return {
    id,
    type: TRACK_REMOVE_COMMAND,
    schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
    payload: {
      animationId: payload.animationId,
      trackId: payload.trackId,
    },
  };
}

/** Canonicalizing constructor for a `track.setInterpolation` command. */
export function setTrackInterpolationCommand(
  id: CommandId,
  payload: SetTrackInterpolationPayload,
): Command<
  typeof TRACK_SET_INTERPOLATION_COMMAND,
  SetTrackInterpolationPayload
> {
  return {
    id,
    type: TRACK_SET_INTERPOLATION_COMMAND,
    schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
    payload: {
      animationId: payload.animationId,
      trackId: payload.trackId,
      interpolation: payload.interpolation,
    },
  };
}

/** Canonicalizing constructor for a `keyframe.set` command. */
export function setKeyframeCommand(
  id: CommandId,
  payload: SetKeyframePayload,
): Command<typeof KEYFRAME_SET_COMMAND, SetKeyframePayload> {
  return {
    id,
    type: KEYFRAME_SET_COMMAND,
    schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
    payload: {
      animationId: payload.animationId,
      trackId: payload.trackId,
      keyframeId: payload.keyframeId,
      time: payload.time,
      property: canonicalizeProperty(payload.property),
    },
  };
}

/** Canonicalizing constructor for a `keyframe.move` command. */
export function moveKeyframeCommand(
  id: CommandId,
  payload: MoveKeyframePayload,
): Command<typeof KEYFRAME_MOVE_COMMAND, MoveKeyframePayload> {
  return {
    id,
    type: KEYFRAME_MOVE_COMMAND,
    schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
    payload: {
      animationId: payload.animationId,
      trackId: payload.trackId,
      keyframeId: payload.keyframeId,
      time: payload.time,
    },
  };
}

/** Canonicalizing constructor for a `keyframe.delete` command. */
export function deleteKeyframeCommand(
  id: CommandId,
  payload: DeleteKeyframePayload,
): Command<typeof KEYFRAME_DELETE_COMMAND, DeleteKeyframePayload> {
  return {
    id,
    type: KEYFRAME_DELETE_COMMAND,
    schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
    payload: {
      animationId: payload.animationId,
      trackId: payload.trackId,
      keyframeId: payload.keyframeId,
    },
  };
}

function canonicalizeProperty(property: TrackProperty): TrackProperty {
  if (property.channel === "rotation") {
    return { channel: "rotation", value: canonicalQuat(property.value) };
  }
  if (property.channel === "scale") {
    return { channel: "scale", value: canonicalScale(property.value) };
  }
  return { channel: "translation", value: canonicalVec3(property.value) };
}

function parseAnimationIdValue(
  value: unknown,
  path: readonly (string | number)[],
): AnimationId {
  if (typeof value !== "string" || value.length === 0 || value.length > 128) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_ID",
      message:
        "Identifiers must be non-empty strings of at most 128 characters",
      path,
    });
  }
  return value as AnimationId;
}

const parseTrackIdValue = (
  value: unknown,
  path: readonly (string | number)[],
): TrackId => parseAnimationIdValue(value, path) as unknown as TrackId;

const parseKeyframeIdValue = (
  value: unknown,
  path: readonly (string | number)[],
): KeyframeId => parseAnimationIdValue(value, path) as unknown as KeyframeId;

function parseFiniteNumber(
  value: unknown,
  path: readonly (string | number)[],
): number {
  if (typeof value !== "number") {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a number",
      path,
    });
  }
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_CANONICAL_NUMBER",
      message: "Numbers must be finite and must not be negative zero",
      path,
    });
  }
  return value;
}

function parseDuration(
  value: unknown,
  limits: DocumentLimits,
  path: readonly (string | number)[],
): number {
  const duration = parseFiniteNumber(value, path);
  if (duration <= 0 || duration > limits.maxClipDurationSeconds) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_ANIMATION_DURATION",
      message: `Duration must be within (0, ${String(limits.maxClipDurationSeconds)}]`,
      path,
    });
  }
  return duration;
}

function parseLoopPolicy(
  value: unknown,
  path: readonly (string | number)[],
): LoopPolicy {
  if (value !== "once" && value !== "loop") {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_LOOP_POLICY",
      message: 'Loop policy must be "once" or "loop"',
      path,
    });
  }
  return value;
}

function parseInterpolation(
  value: unknown,
  path: readonly (string | number)[],
): Interpolation {
  if (value !== "step" && value !== "linear" && value !== "smoothstep") {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_INTERPOLATION",
      message: 'Interpolation must be "step", "linear", or "smoothstep"',
      path,
    });
  }
  return value;
}

function parseKeyframeTime(
  value: unknown,
  path: readonly (string | number)[],
): number {
  const time = parseFiniteNumber(value, path);
  if (time < 0) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_KEYFRAME_TIME",
      message: "Keyframe time must be a non-negative number",
      path,
    });
  }
  return time;
}

function parseTrackProperty(
  value: unknown,
  path: readonly (string | number)[],
): TrackProperty {
  if (!isRecord(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a track property object",
      path,
    });
  }
  const channel = value.channel;
  if (channel === "rotation") {
    return {
      channel: "rotation",
      value: canonicalQuat(
        parseVec3OrQuat(value.value, [...path, "value"], 4) as Quat,
      ),
    };
  }
  if (channel === "scale") {
    return {
      channel: "scale",
      value: canonicalScale(
        parseVec3OrQuat(value.value, [...path, "value"], 3) as Vec3,
      ),
    };
  }
  if (channel === "translation") {
    return {
      channel: "translation",
      value: canonicalVec3(
        parseVec3OrQuat(value.value, [...path, "value"], 3) as Vec3,
      ),
    };
  }
  throw new WorkspaceError({
    family: "validation",
    code: "INVALID_PROPERTY_CHANNEL",
    message: 'Property channel must be "translation", "rotation", or "scale"',
    path: [...path, "channel"],
  });
}

function parseVec3OrQuat(
  value: unknown,
  path: readonly (string | number)[],
  length: 3 | 4,
): readonly number[] {
  if (!Array.isArray(value) || value.length !== length) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_VECTOR",
      message: `Expected a ${String(length)}-component vector`,
      path,
    });
  }
  return value.map((component, index) =>
    parseFiniteNumber(component, [...path, index]),
  );
}

function parseCreatePayload(
  payload: unknown,
  limits: DocumentLimits,
): CreateAnimationPayload {
  if (!isRecord(payload)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a payload object",
      path: ["payload"],
    });
  }
  return {
    animationId: parseAnimationIdValue(payload.animationId, [
      "payload",
      "animationId",
    ]),
    duration: parseDuration(payload.duration, limits, ["payload", "duration"]),
    loop: parseLoopPolicy(payload.loop, ["payload", "loop"]),
    ...(payload.name === undefined
      ? {}
      : { name: parseName(payload.name, limits, ["payload", "name"]) }),
  };
}

function parseUpdatePayload(
  payload: unknown,
  limits: DocumentLimits,
): UpdateAnimationPayload {
  if (!isRecord(payload)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a payload object",
      path: ["payload"],
    });
  }
  return {
    animationId: parseAnimationIdValue(payload.animationId, [
      "payload",
      "animationId",
    ]),
    ...(payload.name === undefined
      ? {}
      : payload.name === null
        ? { name: null }
        : { name: parseName(payload.name, limits, ["payload", "name"]) }),
    ...(payload.duration === undefined
      ? {}
      : {
          duration: parseDuration(payload.duration, limits, [
            "payload",
            "duration",
          ]),
        }),
    ...(payload.loop === undefined
      ? {}
      : { loop: parseLoopPolicy(payload.loop, ["payload", "loop"]) }),
  };
}

function parseAnimationId(payload: unknown): {
  readonly animationId: AnimationId;
} {
  if (!isRecord(payload)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a payload object",
      path: ["payload"],
    });
  }
  return {
    animationId: parseAnimationIdValue(payload.animationId, [
      "payload",
      "animationId",
    ]),
  };
}

function parseTrackPayload(payload: unknown): AddTrackPayload {
  if (!isRecord(payload)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a payload object",
      path: ["payload"],
    });
  }
  return {
    animationId: parseAnimationIdValue(payload.animationId, [
      "payload",
      "animationId",
    ]),
    trackId: parseTrackIdValue(payload.trackId, ["payload", "trackId"]),
    targetNodeId: parseNodeId(payload.targetNodeId, [
      "payload",
      "targetNodeId",
    ]),
    interpolation: parseInterpolation(payload.interpolation, [
      "payload",
      "interpolation",
    ]),
  };
}

function parseTrackRef(payload: unknown): {
  readonly animationId: AnimationId;
  readonly trackId: TrackId;
} {
  if (!isRecord(payload)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a payload object",
      path: ["payload"],
    });
  }
  return {
    animationId: parseAnimationIdValue(payload.animationId, [
      "payload",
      "animationId",
    ]),
    trackId: parseTrackIdValue(payload.trackId, ["payload", "trackId"]),
  };
}

function parseKeyframeRef(payload: unknown): {
  readonly animationId: AnimationId;
  readonly trackId: TrackId;
  readonly keyframeId: KeyframeId;
} {
  const ref = parseTrackRef(payload);
  // parseTrackRef already rejected non-record payloads.
  const record = payload as Record<string, unknown>;
  return {
    ...ref,
    keyframeId: parseKeyframeIdValue(record.keyframeId, [
      "payload",
      "keyframeId",
    ]),
  };
}

function parseSetKeyframePayload(
  payload: unknown,
  limits: DocumentLimits,
): SetKeyframePayload {
  void limits;
  const ref = parseKeyframeRef(payload);
  if (!isRecord(payload)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_FIELD_TYPE",
      message: "Expected a payload object",
      path: ["payload"],
    });
  }
  return {
    ...ref,
    time: parseKeyframeTime(payload.time, ["payload", "time"]),
    property: parseTrackProperty(payload.property, ["payload", "property"]),
  };
}

function missingAnimation(animationId: AnimationId): WorkspaceError {
  return new WorkspaceError({
    family: "validation",
    code: "MISSING_ANIMATION",
    message: "Animation clip is not part of the document",
    context: { animationId },
  });
}

function missingTrack(
  animationId: AnimationId,
  trackId: TrackId,
): WorkspaceError {
  return new WorkspaceError({
    family: "validation",
    code: "MISSING_TRACK",
    message: "Track is not part of the animation clip",
    context: { animationId, trackId },
  });
}

function missingKeyframe(
  animationId: AnimationId,
  trackId: TrackId,
  keyframeId: KeyframeId,
): WorkspaceError {
  return new WorkspaceError({
    family: "validation",
    code: "MISSING_KEYFRAME",
    message: "Keyframe is not part of the track",
    context: { animationId, trackId, keyframeId },
  });
}

function animationOfDocument(
  document: MutableDocument,
  animationId: AnimationId,
): AnimationDescriptor {
  const clip = document.animations[animationId];
  if (clip === undefined) throw missingAnimation(animationId);
  return clip;
}

function trackOfClip(
  clip: AnimationDescriptor,
  trackId: TrackId,
): AnimationTrack {
  const track = clip.tracks.find((candidate) => candidate.trackId === trackId);
  if (track === undefined) throw missingTrack(clip.animationId, trackId);
  return track;
}

/**
 * Composite inverse that recreates a full clip on undo: the bus replays
 * the stored inverse array in reverse, so the array is stored in reverse
 * execution order (keyframes, then tracks, then the create) to execute
 * create -> track.add -> keyframe.set.
 */
function restoreClipInverse(
  clip: AnimationDescriptor,
): readonly InverseCommand[] {
  const animationId = clip.animationId;
  const keyframeSets: InverseCommand[] = clip.tracks.flatMap((track) =>
    track.keyframes.map((keyframe) => ({
      type: KEYFRAME_SET_COMMAND,
      schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
      payload: {
        animationId,
        trackId: track.trackId,
        keyframeId: keyframe.keyframeId,
        time: keyframe.time,
        property: keyframe.property,
      },
    })),
  );
  const trackAdds: InverseCommand[] = clip.tracks.map((track) => ({
    type: TRACK_ADD_COMMAND,
    schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
    payload: {
      animationId,
      trackId: track.trackId,
      targetNodeId: track.targetNodeId,
      interpolation: track.interpolation,
    },
  }));
  const create: InverseCommand = {
    type: ANIMATION_CREATE_COMMAND,
    schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
    payload: {
      animationId: clip.animationId,
      duration: clip.duration,
      loop: clip.loop,
      ...(clip.name === undefined ? {} : { name: clip.name }),
    },
  };
  return [...keyframeSets, ...trackAdds, create];
}

/** Finds a track by id anywhere in the document (ids are document-unique). */
function trackOfDocument(
  document: VoxelDocument,
  trackId: TrackId,
): AnimationTrack | undefined {
  for (const clip of Object.values(document.animations)) {
    const track = clip.tracks.find(
      (candidate) => candidate.trackId === trackId,
    );
    if (track !== undefined) return track;
  }
  return undefined;
}

/** True when the track record exactly matches a `track.add` payload. */
function trackMatchesAddPayload(
  track: AnimationTrack,
  payload: AddTrackPayload,
): boolean {
  return (
    track.targetNodeId === payload.targetNodeId &&
    track.interpolation === payload.interpolation &&
    track.keyframes.length === 0
  );
}

/** True when the clip record exactly matches an `animation.create` payload. */
function clipMatchesCreatePayload(
  clip: AnimationDescriptor,
  payload: CreateAnimationPayload,
): boolean {
  return (
    clip.duration === payload.duration &&
    clip.loop === payload.loop &&
    clip.tracks.length === 0 &&
    (payload.name === undefined
      ? clip.name === undefined
      : clip.name === payload.name)
  );
}

function animationResources(
  animationId: AnimationId,
): CommandExecution["declaredAffectedResources"] {
  return {
    nodeIds: [],
    materialIds: [],
    animationIds: [animationId],
    volumeIds: [],
  };
}

/** One walk over the animation model for budget and uniqueness checks. */
function animationModelSummary(document: VoxelDocument): {
  readonly trackCount: number;
  readonly keyframeCount: number;
  readonly trackIds: ReadonlySet<string>;
  readonly keyframeIds: ReadonlySet<string>;
} {
  let trackCount = 0;
  let keyframeCount = 0;
  const trackIds = new Set<string>();
  const keyframeIds = new Set<string>();
  for (const clip of Object.values(document.animations)) {
    for (const track of clip.tracks) {
      trackCount += 1;
      trackIds.add(track.trackId);
      for (const keyframe of track.keyframes) {
        keyframeCount += 1;
        keyframeIds.add(keyframe.keyframeId);
      }
    }
  }
  return { trackCount, keyframeCount, trackIds, keyframeIds };
}

const createAnimationHandler: CommandHandler<
  typeof ANIMATION_CREATE_COMMAND,
  CreateAnimationPayload
> = {
  type: ANIMATION_CREATE_COMMAND,
  schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): CreateAnimationPayload {
    return parseCreatePayload(payload, limits);
  },
  validate(
    payload: CreateAnimationPayload,
    context: CommandValidationContext,
  ): void {
    const existing = context.document.animations[payload.animationId];
    if (existing !== undefined) {
      // Creating a clip that already exists with an identical record is a
      // no-op commit (the desired end state already holds), matching the
      // material.create no-op policy; a conflicting record is a duplicate.
      if (clipMatchesCreatePayload(existing, payload)) return;
      throw new WorkspaceError({
        family: "validation",
        code: "DUPLICATE_ANIMATION_ID",
        message: "An animation clip with this identifier already exists",
        context: { animationId: payload.animationId },
      });
    }
    if (
      Object.keys(context.document.animations).length >= context.limits.maxClips
    ) {
      throw new WorkspaceError({
        family: "limit",
        code: "LIMIT_EXCEEDED",
        message: `Clip count exceeds the ${String(context.limits.maxClips)}-clip limit`,
        context: { animationId: payload.animationId },
      });
    }
  },
  execute(
    payload: CreateAnimationPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const existing = document.animations[payload.animationId];
    if (existing !== undefined && clipMatchesCreatePayload(existing, payload)) {
      return {
        inverse: {
          type: ANIMATION_CREATE_COMMAND,
          schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
          payload,
        },
        changedRecords: false,
        declaredAffectedResources: animationResources(payload.animationId),
      };
    }
    if (existing !== undefined) {
      throw new WorkspaceError({
        family: "validation",
        code: "DUPLICATE_ANIMATION_ID",
        message: "An animation clip with this identifier already exists",
        context: { animationId: payload.animationId },
      });
    }
    const clip: AnimationDescriptor = {
      animationId: payload.animationId,
      duration: payload.duration,
      loop: payload.loop,
      tracks: [],
      ...(payload.name === undefined ? {} : { name: payload.name }),
    };
    document.animations = {
      ...document.animations,
      [payload.animationId]: clip,
    };
    return {
      inverse: {
        type: ANIMATION_DELETE_COMMAND,
        schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
        payload: { animationId: payload.animationId },
      },
      changedRecords: true,
      declaredAffectedResources: animationResources(payload.animationId),
    };
  },
};

const updateAnimationHandler: CommandHandler<
  typeof ANIMATION_UPDATE_COMMAND,
  UpdateAnimationPayload
> = {
  type: ANIMATION_UPDATE_COMMAND,
  schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): UpdateAnimationPayload {
    return parseUpdatePayload(payload, limits);
  },
  validate(
    payload: UpdateAnimationPayload,
    context: CommandValidationContext,
  ): void {
    const clip = context.document.animations[payload.animationId];
    if (clip === undefined) throw missingAnimation(payload.animationId);
    if (
      payload.name === undefined &&
      payload.duration === undefined &&
      payload.loop === undefined
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "EMPTY_ANIMATION_UPDATE",
        message: "At least one clip property must be provided",
        path: ["payload"],
      });
    }
    if (payload.duration !== undefined) {
      for (const track of clip.tracks) {
        for (const keyframe of track.keyframes) {
          if (keyframe.time > payload.duration) {
            throw new WorkspaceError({
              family: "validation",
              code: "INVALID_KEYFRAME_TIME",
              message: "Keyframe times must stay within the clip duration",
              context: {
                animationId: payload.animationId,
                trackId: track.trackId,
                keyframeId: keyframe.keyframeId,
                time: String(keyframe.time),
                duration: String(payload.duration),
              },
            });
          }
        }
      }
    }
  },
  execute(
    payload: UpdateAnimationPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const clip = animationOfDocument(document, payload.animationId);
    const next: {
      animationId: AnimationId;
      name?: string;
      duration: number;
      loop: LoopPolicy;
      tracks: readonly AnimationTrack[];
    } = { ...clip };
    if (payload.name !== undefined) {
      if (payload.name === null) {
        delete next.name;
      } else {
        next.name = payload.name;
      }
    }
    if (payload.duration !== undefined) next.duration = payload.duration;
    if (payload.loop !== undefined) next.loop = payload.loop;
    document.animations = {
      ...document.animations,
      [payload.animationId]: next,
    };
    const inversePayload: UpdateAnimationPayload = {
      animationId: payload.animationId,
      ...(payload.name === undefined ||
      (payload.name ?? null) === (clip.name ?? null)
        ? {}
        : clip.name === undefined
          ? { name: null }
          : { name: clip.name }),
      ...(payload.duration === undefined ? {} : { duration: clip.duration }),
      ...(payload.loop === undefined ? {} : { loop: clip.loop }),
    };
    return {
      inverse: {
        type: ANIMATION_UPDATE_COMMAND,
        schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
        payload: inversePayload,
      },
      changedRecords:
        (clip.name ?? null) !== (next.name ?? null) ||
        clip.duration !== next.duration ||
        clip.loop !== next.loop,
      declaredAffectedResources: animationResources(payload.animationId),
    };
  },
};

const deleteAnimationHandler: CommandHandler<
  typeof ANIMATION_DELETE_COMMAND,
  DeleteAnimationPayload
> = {
  type: ANIMATION_DELETE_COMMAND,
  schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown): DeleteAnimationPayload {
    return parseAnimationId(payload);
  },
  validate(
    payload: DeleteAnimationPayload,
    context: CommandValidationContext,
  ): void {
    void context;
    void payload;
  },
  execute(
    payload: DeleteAnimationPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const clip = document.animations[payload.animationId];
    if (clip === undefined) {
      // Deleting an absent clip is a no-op commit (the desired end state
      // already holds), matching the node.delete no-op policy.
      return {
        inverse: {
          type: ANIMATION_DELETE_COMMAND,
          schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
          payload: { animationId: payload.animationId },
        },
        changedRecords: false,
        declaredAffectedResources: animationResources(payload.animationId),
      };
    }
    document.animations = Object.fromEntries(
      Object.entries(document.animations).filter(
        ([id]) => id !== payload.animationId,
      ),
    ) as MutableDocument["animations"];
    return {
      inverse: restoreClipInverse(clip),
      changedRecords: true,
      declaredAffectedResources: animationResources(payload.animationId),
    };
  },
};

const addTrackHandler: CommandHandler<
  typeof TRACK_ADD_COMMAND,
  AddTrackPayload
> = {
  type: TRACK_ADD_COMMAND,
  schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown): AddTrackPayload {
    return parseTrackPayload(payload);
  },
  validate(payload: AddTrackPayload, context: CommandValidationContext): void {
    if (context.document.animations[payload.animationId] === undefined) {
      throw missingAnimation(payload.animationId);
    }
    if (context.document.nodes[payload.targetNodeId] === undefined) {
      throw new WorkspaceError({
        family: "validation",
        code: "MISSING_NODE",
        message: "Track target node is not part of the document",
        context: { nodeId: payload.targetNodeId },
      });
    }
    const summary = animationModelSummary(context.document);
    if (summary.trackIds.has(payload.trackId)) {
      const existing = trackOfDocument(context.document, payload.trackId);
      if (existing !== undefined && trackMatchesAddPayload(existing, payload)) {
        return; // identical record: no-op commit
      }
      throw new WorkspaceError({
        family: "validation",
        code: "DUPLICATE_TRACK_ID",
        message: "A track with this identifier already exists in the document",
        context: { trackId: payload.trackId },
      });
    }
    if (summary.trackCount >= context.limits.maxTracks) {
      throw new WorkspaceError({
        family: "limit",
        code: "LIMIT_EXCEEDED",
        message: `Track count exceeds the ${String(context.limits.maxTracks)}-track limit`,
        context: { trackId: payload.trackId },
      });
    }
  },
  execute(
    payload: AddTrackPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const clip = animationOfDocument(document, payload.animationId);
    const existing = document.animations[payload.animationId]?.tracks.find(
      (track) => track.trackId === payload.trackId,
    );
    if (existing !== undefined && trackMatchesAddPayload(existing, payload)) {
      return {
        inverse: {
          type: TRACK_ADD_COMMAND,
          schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
          payload,
        },
        changedRecords: false,
        declaredAffectedResources: animationResources(payload.animationId),
      };
    }
    if (existing !== undefined) {
      throw new WorkspaceError({
        family: "validation",
        code: "DUPLICATE_TRACK_ID",
        message: "A track with this identifier already exists in the document",
        context: { trackId: payload.trackId },
      });
    }
    const track: AnimationTrack = {
      trackId: payload.trackId,
      targetNodeId: payload.targetNodeId,
      interpolation: payload.interpolation,
      keyframes: [],
    };
    document.animations = {
      ...document.animations,
      [payload.animationId]: { ...clip, tracks: [...clip.tracks, track] },
    };
    return {
      inverse: {
        type: TRACK_REMOVE_COMMAND,
        schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
        payload: {
          animationId: payload.animationId,
          trackId: payload.trackId,
        },
      },
      changedRecords: true,
      declaredAffectedResources: animationResources(payload.animationId),
    };
  },
};

const removeTrackHandler: CommandHandler<
  typeof TRACK_REMOVE_COMMAND,
  RemoveTrackPayload
> = {
  type: TRACK_REMOVE_COMMAND,
  schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): RemoveTrackPayload {
    void limits;
    return parseTrackRef(payload);
  },
  validate(
    payload: RemoveTrackPayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.animations[payload.animationId] === undefined) {
      throw missingAnimation(payload.animationId);
    }
  },
  execute(
    payload: RemoveTrackPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const clip = animationOfDocument(document, payload.animationId);
    const track = clip.tracks.find(
      (candidate) => candidate.trackId === payload.trackId,
    );
    if (track === undefined) {
      // Removing an absent track is a no-op commit, matching the
      // node.removePivot no-op policy.
      return {
        inverse: {
          type: TRACK_REMOVE_COMMAND,
          schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
          payload: {
            animationId: payload.animationId,
            trackId: payload.trackId,
          },
        },
        changedRecords: false,
        declaredAffectedResources: animationResources(payload.animationId),
      };
    }
    document.animations = {
      ...document.animations,
      [payload.animationId]: {
        ...clip,
        tracks: clip.tracks.filter(
          (candidate) => candidate.trackId !== payload.trackId,
        ),
      },
    };
    // Restore the track and its keyframes on undo: the bus replays the
    // stored array in reverse, so the keyframes are stored first.
    const keyframeSets: InverseCommand[] = track.keyframes.map((keyframe) => ({
      type: KEYFRAME_SET_COMMAND,
      schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
      payload: {
        animationId: payload.animationId,
        trackId: track.trackId,
        keyframeId: keyframe.keyframeId,
        time: keyframe.time,
        property: keyframe.property,
      },
    }));
    const trackAdd: InverseCommand = {
      type: TRACK_ADD_COMMAND,
      schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
      payload: {
        animationId: payload.animationId,
        trackId: track.trackId,
        targetNodeId: track.targetNodeId,
        interpolation: track.interpolation,
      },
    };
    return {
      inverse: [...keyframeSets, trackAdd],
      changedRecords: true,
      declaredAffectedResources: animationResources(payload.animationId),
    };
  },
};

const setTrackInterpolationHandler: CommandHandler<
  typeof TRACK_SET_INTERPOLATION_COMMAND,
  SetTrackInterpolationPayload
> = {
  type: TRACK_SET_INTERPOLATION_COMMAND,
  schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown): SetTrackInterpolationPayload {
    const ref = parseTrackRef(payload);
    if (!isRecord(payload)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "Expected a payload object",
        path: ["payload"],
      });
    }
    return {
      ...ref,
      interpolation: parseInterpolation(payload.interpolation, [
        "payload",
        "interpolation",
      ]),
    };
  },
  validate(
    payload: SetTrackInterpolationPayload,
    context: CommandValidationContext,
  ): void {
    const clip = context.document.animations[payload.animationId];
    if (clip === undefined) throw missingAnimation(payload.animationId);
    if (!clip.tracks.some((track) => track.trackId === payload.trackId)) {
      throw missingTrack(payload.animationId, payload.trackId);
    }
  },
  execute(
    payload: SetTrackInterpolationPayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const clip = animationOfDocument(document, payload.animationId);
    const track = trackOfClip(clip, payload.trackId);
    const next: AnimationTrack = {
      ...track,
      interpolation: payload.interpolation,
    };
    document.animations = {
      ...document.animations,
      [payload.animationId]: {
        ...clip,
        tracks: clip.tracks.map((candidate) =>
          candidate.trackId === payload.trackId ? next : candidate,
        ),
      },
    };
    return {
      inverse: {
        type: TRACK_SET_INTERPOLATION_COMMAND,
        schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
        payload: {
          animationId: payload.animationId,
          trackId: payload.trackId,
          interpolation: track.interpolation,
        },
      },
      changedRecords: track.interpolation !== payload.interpolation,
      declaredAffectedResources: animationResources(payload.animationId),
    };
  },
};

const setKeyframeHandler: CommandHandler<
  typeof KEYFRAME_SET_COMMAND,
  SetKeyframePayload
> = {
  type: KEYFRAME_SET_COMMAND,
  schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): SetKeyframePayload {
    return parseSetKeyframePayload(payload, limits);
  },
  validate(
    payload: SetKeyframePayload,
    context: CommandValidationContext,
  ): void {
    const clip = context.document.animations[payload.animationId];
    if (clip === undefined) throw missingAnimation(payload.animationId);
    const track = clip.tracks.find(
      (candidate) => candidate.trackId === payload.trackId,
    );
    if (track === undefined)
      throw missingTrack(payload.animationId, payload.trackId);
    if (payload.time > clip.duration) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_KEYFRAME_TIME",
        message: "Keyframe time must be within the clip duration",
        context: {
          animationId: payload.animationId,
          trackId: payload.trackId,
          time: String(payload.time),
          duration: String(clip.duration),
        },
      });
    }
    const existing = track.keyframes.find(
      (keyframe) => keyframe.keyframeId === payload.keyframeId,
    );
    if (existing === undefined) {
      // Creating a new keyframe: honor the document-wide keyframe budgets.
      if (
        animationModelSummary(context.document).keyframeCount >=
        context.limits.maxKeyframes
      ) {
        throw new WorkspaceError({
          family: "limit",
          code: "LIMIT_EXCEEDED",
          message: `Keyframe count exceeds the ${String(context.limits.maxKeyframes)}-keyframe limit`,
          context: { keyframeId: payload.keyframeId },
        });
      }
      if (track.keyframes.length >= context.limits.maxKeyframesPerTrack) {
        throw new WorkspaceError({
          family: "limit",
          code: "LIMIT_EXCEEDED",
          message: `Track exceeds the ${String(context.limits.maxKeyframesPerTrack)}-keyframe limit`,
          context: { trackId: payload.trackId },
        });
      }
      if (
        animationModelSummary(context.document).keyframeIds.has(
          payload.keyframeId,
        )
      ) {
        throw new WorkspaceError({
          family: "validation",
          code: "DUPLICATE_KEYFRAME_ID",
          message:
            "A keyframe with this identifier already exists in the document",
          context: { keyframeId: payload.keyframeId },
        });
      }
      if (track.keyframes.some((keyframe) => keyframe.time === payload.time)) {
        throw new WorkspaceError({
          family: "validation",
          code: "DUPLICATE_KEYFRAME_TIME",
          message: "Keyframe times must be unique within the track",
          context: { trackId: payload.trackId, time: String(payload.time) },
        });
      }
    }
    // Property channel compatibility: a track targets exactly one
    // property; every keyframe must speak the same channel.
    const first = track.keyframes[0];
    if (
      first !== undefined &&
      first.property.channel !== payload.property.channel
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "ANIMATION_TRACK_CHANNEL_MISMATCH",
        message: "A track targets exactly one property channel",
        context: { trackId: payload.trackId },
      });
    }
  },
  execute(
    payload: SetKeyframePayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const clip = animationOfDocument(document, payload.animationId);
    const track = trackOfClip(clip, payload.trackId);
    const existing = track.keyframes.find(
      (keyframe) => keyframe.keyframeId === payload.keyframeId,
    );
    const keyframe: Keyframe = {
      keyframeId: payload.keyframeId,
      time: payload.time,
      property: payload.property,
    };
    const keyframes =
      existing === undefined
        ? [...track.keyframes, keyframe]
        : track.keyframes.map((candidate) =>
            candidate.keyframeId === payload.keyframeId ? keyframe : candidate,
          );
    // Times must stay sorted ascending; validation guarantees the new
    // time is unique, so sorting the array restores the invariant.
    keyframes.sort((a, b) => a.time - b.time);
    const next: AnimationTrack = { ...track, keyframes };
    document.animations = {
      ...document.animations,
      [payload.animationId]: {
        ...clip,
        tracks: clip.tracks.map((candidate) =>
          candidate.trackId === payload.trackId ? next : candidate,
        ),
      },
    };
    const inverse: InverseCommand =
      existing === undefined
        ? {
            type: KEYFRAME_DELETE_COMMAND,
            schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
            payload: {
              animationId: payload.animationId,
              trackId: payload.trackId,
              keyframeId: payload.keyframeId,
            },
          }
        : {
            type: KEYFRAME_SET_COMMAND,
            schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
            payload: {
              animationId: payload.animationId,
              trackId: payload.trackId,
              keyframeId: payload.keyframeId,
              time: existing.time,
              property: existing.property,
            },
          };
    return {
      inverse,
      changedRecords:
        existing === undefined ||
        existing.time !== payload.time ||
        existing.property.channel !== payload.property.channel ||
        existing.property.value.some(
          (component, index) =>
            component !== (payload.property.value[index] as number),
        ),
      declaredAffectedResources: animationResources(payload.animationId),
    };
  },
};

const moveKeyframeHandler: CommandHandler<
  typeof KEYFRAME_MOVE_COMMAND,
  MoveKeyframePayload
> = {
  type: KEYFRAME_MOVE_COMMAND,
  schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): MoveKeyframePayload {
    const ref = parseKeyframeRef(payload);
    if (!isRecord(payload)) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_FIELD_TYPE",
        message: "Expected a payload object",
        path: ["payload"],
      });
    }
    void limits;
    return {
      ...ref,
      time: parseKeyframeTime(payload.time, ["payload", "time"]),
    };
  },
  validate(
    payload: MoveKeyframePayload,
    context: CommandValidationContext,
  ): void {
    const clip = context.document.animations[payload.animationId];
    if (clip === undefined) throw missingAnimation(payload.animationId);
    const track = clip.tracks.find(
      (candidate) => candidate.trackId === payload.trackId,
    );
    if (track === undefined)
      throw missingTrack(payload.animationId, payload.trackId);
    if (payload.time > clip.duration) {
      throw new WorkspaceError({
        family: "validation",
        code: "INVALID_KEYFRAME_TIME",
        message: "Keyframe time must be within the clip duration",
        context: {
          animationId: payload.animationId,
          trackId: payload.trackId,
          time: String(payload.time),
          duration: String(clip.duration),
        },
      });
    }
    const existing = track.keyframes.find(
      (keyframe) => keyframe.keyframeId === payload.keyframeId,
    );
    if (existing === undefined) {
      throw missingKeyframe(
        payload.animationId,
        payload.trackId,
        payload.keyframeId,
      );
    }
    if (
      existing.time !== payload.time &&
      track.keyframes.some(
        (keyframe) =>
          keyframe.keyframeId !== payload.keyframeId &&
          keyframe.time === payload.time,
      )
    ) {
      throw new WorkspaceError({
        family: "validation",
        code: "DUPLICATE_KEYFRAME_TIME",
        message: "Keyframe times must be unique within the track",
        context: { trackId: payload.trackId, time: String(payload.time) },
      });
    }
  },
  execute(
    payload: MoveKeyframePayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const clip = animationOfDocument(document, payload.animationId);
    const track = trackOfClip(clip, payload.trackId);
    const existing = track.keyframes.find(
      (keyframe) => keyframe.keyframeId === payload.keyframeId,
    );
    if (existing === undefined) {
      throw missingKeyframe(
        payload.animationId,
        payload.trackId,
        payload.keyframeId,
      );
    }
    const keyframes = track.keyframes
      .map((keyframe) =>
        keyframe.keyframeId === payload.keyframeId
          ? { ...keyframe, time: payload.time }
          : keyframe,
      )
      .sort((a, b) => a.time - b.time);
    const next: AnimationTrack = { ...track, keyframes };
    document.animations = {
      ...document.animations,
      [payload.animationId]: {
        ...clip,
        tracks: clip.tracks.map((candidate) =>
          candidate.trackId === payload.trackId ? next : candidate,
        ),
      },
    };
    return {
      inverse: {
        type: KEYFRAME_MOVE_COMMAND,
        schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
        payload: {
          animationId: payload.animationId,
          trackId: payload.trackId,
          keyframeId: payload.keyframeId,
          time: existing.time,
        },
      },
      changedRecords: existing.time !== payload.time,
      declaredAffectedResources: animationResources(payload.animationId),
    };
  },
};

const deleteKeyframeHandler: CommandHandler<
  typeof KEYFRAME_DELETE_COMMAND,
  DeleteKeyframePayload
> = {
  type: KEYFRAME_DELETE_COMMAND,
  schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
  parse(payload: unknown, limits: DocumentLimits): DeleteKeyframePayload {
    void limits;
    return parseKeyframeRef(payload);
  },
  validate(
    payload: DeleteKeyframePayload,
    context: CommandValidationContext,
  ): void {
    if (context.document.animations[payload.animationId] === undefined) {
      throw missingAnimation(payload.animationId);
    }
  },
  execute(
    payload: DeleteKeyframePayload,
    context: CommandExecutionContext,
  ): CommandExecution {
    const document = context.stageDocument();
    const clip = animationOfDocument(document, payload.animationId);
    const track = trackOfClip(clip, payload.trackId);
    const existing = track.keyframes.find(
      (keyframe) => keyframe.keyframeId === payload.keyframeId,
    );
    if (existing === undefined) {
      // Deleting an absent keyframe is a no-op commit, matching the
      // node.removePivot no-op policy.
      return {
        inverse: {
          type: KEYFRAME_DELETE_COMMAND,
          schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
          payload: {
            animationId: payload.animationId,
            trackId: payload.trackId,
            keyframeId: payload.keyframeId,
          },
        },
        changedRecords: false,
        declaredAffectedResources: animationResources(payload.animationId),
      };
    }
    document.animations = {
      ...document.animations,
      [payload.animationId]: {
        ...clip,
        tracks: clip.tracks.map((candidate) =>
          candidate.trackId === payload.trackId
            ? {
                ...candidate,
                keyframes: candidate.keyframes.filter(
                  (keyframe) => keyframe.keyframeId !== payload.keyframeId,
                ),
              }
            : candidate,
        ),
      },
    };
    return {
      inverse: {
        type: KEYFRAME_SET_COMMAND,
        schemaVersion: ANIMATION_COMMAND_SCHEMA_VERSION,
        payload: {
          animationId: payload.animationId,
          trackId: payload.trackId,
          keyframeId: existing.keyframeId,
          time: existing.time,
          property: existing.property,
        },
      },
      changedRecords: true,
      declaredAffectedResources: animationResources(payload.animationId),
    };
  },
};

/** Registers the clip/track/keyframe lifecycle handlers. */
export function registerAnimationCommands(registry: CommandRegistry): void {
  registry.register(createAnimationHandler);
  registry.register(updateAnimationHandler);
  registry.register(deleteAnimationHandler);
  registry.register(addTrackHandler);
  registry.register(removeTrackHandler);
  registry.register(setTrackInterpolationHandler);
  registry.register(setKeyframeHandler);
  registry.register(moveKeyframeHandler);
  registry.register(deleteKeyframeHandler);
}
