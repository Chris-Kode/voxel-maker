import {
  addTrackCommand,
  createAnimationCommand,
  deleteAnimationCommand,
  deleteKeyframeCommand,
  moveKeyframeCommand,
  removeTrackCommand,
  setKeyframeCommand,
  setTrackInterpolationCommand,
  updateAnimationCommand,
} from "@voxel-maker/commands";
import {
  animationId,
  keyframeId,
  trackId,
  type AnimationId,
  type JsonValue,
  type TrackId,
} from "@voxel-maker/shared";
import {
  DEFAULT_DOCUMENT_LIMITS,
  type AnimationDescriptor,
  type TrackProperty,
  type VoxelDocument,
} from "@voxel-maker/model";
import {
  invalidArgument,
  missingReference,
  mutationOutputSchema,
  type ToolContract,
} from "../contract.js";
import {
  requireAnimation,
  requireNode,
  UNKNOWN_TRACK_CODE,
} from "../tools/helpers.js";
import type { MutationToolContext, MutationPayload } from "./context.js";
import { estimateVoxelDelta } from "./estimate.js";
import { requireNodeId, requireString, resolveCommandId } from "./parse.js";

/**
 * Animation mutation tools (plan S13.5, ticket #36): clip, track, and
 * keyframe operations that compile only to the registered animation
 * commands (`animation.create`, `track.add`, `keyframe.set`, ...). Each
 * handler validates references against the current read surface (the
 * staged view when bound to a preview session), constructs exactly one
 * command with an explicit id, and reports the animation deltas the
 * session budget ledger reserves (tracks, keyframes, clip duration).
 * Nothing is executed here.
 */

/** Hard upper bound for clip duration and keyframe times (model limit). */
const MAX_CLIP_DURATION_SECONDS =
  DEFAULT_DOCUMENT_LIMITS.maxClipDurationSeconds;

const ID_SCHEMA = { type: "string", minLength: 1, maxLength: 128 } as const;
const DURATION_SCHEMA = {
  type: "number",
  exclusiveMinimum: 0,
  maximum: MAX_CLIP_DURATION_SECONDS,
} as const;
const TIME_SCHEMA = {
  type: "number",
  minimum: 0,
  maximum: MAX_CLIP_DURATION_SECONDS,
} as const;
const LOOP_SCHEMA = { type: "string", enum: ["once", "loop"] } as const;
const INTERPOLATION_SCHEMA = {
  type: "string",
  enum: ["step", "linear", "smoothstep"],
} as const;
const CHANNEL_SCHEMA = {
  type: "string",
  enum: ["translation", "rotation", "scale"],
} as const;

/** Looks up a track inside one animation or throws the stable error. */
function requireTrackInAnimation(
  document: VoxelDocument,
  animationIdValue: AnimationId,
  trackIdValue: TrackId,
): AnimationDescriptor["tracks"][number] {
  const animation = requireAnimation(document, animationIdValue);
  const track = animation.tracks.find(
    (entry) => entry.trackId === trackIdValue,
  );
  if (track === undefined) {
    missingReference("track", trackIdValue, UNKNOWN_TRACK_CODE);
  }
  return track;
}

/** Validates a finite non-negative duration argument. */
function requireDuration(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): number {
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > MAX_CLIP_DURATION_SECONDS
  ) {
    invalidArgument(
      `${key} must be a finite number in (0, ${String(MAX_CLIP_DURATION_SECONDS)}]`,
      [key],
    );
  }
  return value;
}

/** Optional duration; absent returns undefined. */
function requireOptionalDuration(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): number | undefined {
  if (record[key] === undefined) return undefined;
  return requireDuration(record, key);
}

/** Validates a keyframe time (finite, bounded, non-negative). */
function requireKeyframeTime(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): number {
  const value = record[key];
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_CLIP_DURATION_SECONDS
  ) {
    invalidArgument(
      `${key} must be a finite number in [0, ${String(MAX_CLIP_DURATION_SECONDS)}]`,
      [key],
    );
  }
  return value;
}

/** Validates a channel argument against the three track channels. */
function requireChannel(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
): "translation" | "rotation" | "scale" {
  const value = record[key];
  if (value !== "translation" && value !== "rotation" && value !== "scale") {
    invalidArgument(
      `${key} must be one of "translation", "rotation", "scale"`,
      [key],
    );
  }
  return value;
}

/** Validates a keyframe value against its channel's arity (3 or 4). */
function requireKeyframeValue(
  record: Readonly<Record<string, JsonValue>>,
  key: string,
  channel: "translation" | "rotation" | "scale",
):
  | readonly [number, number, number]
  | readonly [number, number, number, number] {
  const value = record[key];
  const expected = channel === "rotation" ? 4 : 3;
  if (
    !Array.isArray(value) ||
    value.length !== expected ||
    !value.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    invalidArgument(
      `${key} must be a finite ${String(expected)}-number array for channel ${channel}`,
      [key],
    );
  }
  return value as unknown as
    | readonly [number, number, number]
    | readonly [number, number, number, number];
}

/** `createAnimation` contract: construct an `animation.create` command. */
export const CREATE_ANIMATION_CONTRACT: ToolContract = {
  name: "createAnimation",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered animation.create command inserting one empty clip with a fixed duration and loop policy.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      animationId: ID_SCHEMA,
      name: { type: "string", minLength: 1, maxLength: 128 },
      duration: DURATION_SCHEMA,
      loop: LOOP_SCHEMA,
    },
    required: ["animationId", "duration", "loop"],
  },
  outputSchema: mutationOutputSchema("createAnimation"),
};

export function createAnimation(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const animationIdValue = animationId(requireString(record, "animationId"));
  const duration = requireDuration(record, "duration");
  const loop = requireLoop(record);
  const command = createAnimationCommand(resolveCommandId(ctx, record), {
    animationId: animationIdValue,
    ...(record.name === undefined
      ? {}
      : { name: requireString(record, "name") }),
    duration,
    loop,
  });
  return {
    command,
    voxelEstimate: estimateVoxelDelta(command, ctx.store),
    animation: { clipDurationSeconds: duration },
  };
}

/** `updateAnimation` contract: construct an `animation.update` command. */
export const UPDATE_ANIMATION_CONTRACT: ToolContract = {
  name: "updateAnimation",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered animation.update command changing one clip's name, duration, and/or loop policy. Only the supplied fields change.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      animationId: ID_SCHEMA,
      name: { type: "string", minLength: 1, maxLength: 128 },
      duration: DURATION_SCHEMA,
      loop: LOOP_SCHEMA,
    },
    required: ["animationId"],
  },
  outputSchema: mutationOutputSchema("updateAnimation"),
};

export function updateAnimation(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const animationIdValue = animationId(requireString(record, "animationId"));
  requireAnimation(ctx.store.getDocument(), animationIdValue);
  const duration = requireOptionalDuration(record, "duration");
  const loop = requireOptionalLoop(record);
  if (
    duration === undefined &&
    loop === undefined &&
    record.name === undefined
  ) {
    invalidArgument(
      "updateAnimation needs at least one of name, duration, or loop",
    );
  }
  const command = updateAnimationCommand(resolveCommandId(ctx, record), {
    animationId: animationIdValue,
    ...(record.name === undefined
      ? {}
      : { name: requireString(record, "name") }),
    ...(duration === undefined ? {} : { duration }),
    ...(loop === undefined ? {} : { loop }),
  });
  return {
    command,
    voxelEstimate: estimateVoxelDelta(command, ctx.store),
    ...(duration === undefined
      ? {}
      : { animation: { clipDurationSeconds: duration } }),
  };
}

/** `deleteAnimation` contract: construct an `animation.delete` command. */
export const DELETE_ANIMATION_CONTRACT: ToolContract = {
  name: "deleteAnimation",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered animation.delete command removing one clip and all of its tracks and keyframes.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      animationId: ID_SCHEMA,
    },
    required: ["animationId"],
  },
  outputSchema: mutationOutputSchema("deleteAnimation"),
};

export function deleteAnimation(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const animationIdValue = animationId(requireString(record, "animationId"));
  const animation = requireAnimation(ctx.store.getDocument(), animationIdValue);
  const command = deleteAnimationCommand(resolveCommandId(ctx, record), {
    animationId: animationIdValue,
  });
  // Deleting the clip modifies every nested track and keyframe; derive
  // the counts from the staged read view so the session budgets cannot
  // be bypassed by destruction (issue #119).
  const tracks = animation.tracks.length;
  const keyframes = animation.tracks.reduce(
    (total, track) => total + track.keyframes.length,
    0,
  );
  return {
    command,
    voxelEstimate: estimateVoxelDelta(command, ctx.store),
    animation: {
      ...(tracks > 0 ? { tracks } : {}),
      ...(keyframes > 0 ? { keyframes } : {}),
    },
  };
}

/** `addTrack` contract: construct a `track.add` command. */
export const ADD_TRACK_CONTRACT: ToolContract = {
  name: "addTrack",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered track.add command adding one empty track targeting a node with a fixed interpolation.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      animationId: ID_SCHEMA,
      trackId: ID_SCHEMA,
      targetNodeId: ID_SCHEMA,
      interpolation: INTERPOLATION_SCHEMA,
    },
    required: ["animationId", "trackId", "targetNodeId", "interpolation"],
  },
  outputSchema: mutationOutputSchema("addTrack"),
};

export function addTrack(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const animationIdValue = animationId(requireString(record, "animationId"));
  requireAnimation(ctx.store.getDocument(), animationIdValue);
  const trackIdValue = trackId(requireString(record, "trackId"));
  const targetNodeId = requireNodeId(record, "targetNodeId");
  requireNode(ctx.store.getDocument(), targetNodeId);
  const interpolation = requireInterpolation(record);
  const command = addTrackCommand(resolveCommandId(ctx, record), {
    animationId: animationIdValue,
    trackId: trackIdValue,
    targetNodeId,
    interpolation,
  });
  return {
    command,
    voxelEstimate: estimateVoxelDelta(command, ctx.store),
    animation: { tracks: 1 },
  };
}

/** `removeTrack` contract: construct a `track.remove` command. */
export const REMOVE_TRACK_CONTRACT: ToolContract = {
  name: "removeTrack",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered track.remove command removing one track (and its keyframes) from a clip.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      animationId: ID_SCHEMA,
      trackId: ID_SCHEMA,
    },
    required: ["animationId", "trackId"],
  },
  outputSchema: mutationOutputSchema("removeTrack"),
};

export function removeTrack(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const animationIdValue = animationId(requireString(record, "animationId"));
  const trackIdValue = trackId(requireString(record, "trackId"));
  const track = requireTrackInAnimation(
    ctx.store.getDocument(),
    animationIdValue,
    trackIdValue,
  );
  const command = removeTrackCommand(resolveCommandId(ctx, record), {
    animationId: animationIdValue,
    trackId: trackIdValue,
  });
  // Removing the track modifies it and every nested keyframe (issue
  // #119): both counts come from the staged read view.
  const keyframes = track.keyframes.length;
  return {
    command,
    voxelEstimate: estimateVoxelDelta(command, ctx.store),
    animation: {
      tracks: 1,
      ...(keyframes > 0 ? { keyframes } : {}),
    },
  };
}

/** `setTrackInterpolation` contract: `track.setInterpolation` command. */
export const SET_TRACK_INTERPOLATION_CONTRACT: ToolContract = {
  name: "setTrackInterpolation",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered track.setInterpolation command changing one track's interpolation (step, linear, smoothstep).",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      animationId: ID_SCHEMA,
      trackId: ID_SCHEMA,
      interpolation: INTERPOLATION_SCHEMA,
    },
    required: ["animationId", "trackId", "interpolation"],
  },
  outputSchema: mutationOutputSchema("setTrackInterpolation"),
};

export function setTrackInterpolation(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const animationIdValue = animationId(requireString(record, "animationId"));
  const trackIdValue = trackId(requireString(record, "trackId"));
  requireTrackInAnimation(
    ctx.store.getDocument(),
    animationIdValue,
    trackIdValue,
  );
  const command = setTrackInterpolationCommand(resolveCommandId(ctx, record), {
    animationId: animationIdValue,
    trackId: trackIdValue,
    interpolation: requireInterpolation(record),
  });
  // Changing a track's interpolation modifies that track against the
  // session track budget (issue #119: every animation mutation must
  // reserve its modified tracks/keyframes).
  return {
    command,
    voxelEstimate: estimateVoxelDelta(command, ctx.store),
    animation: { tracks: 1 },
  };
}

/** `setKeyframe` contract: construct a `keyframe.set` command. */
export const SET_KEYFRAME_CONTRACT: ToolContract = {
  name: "setKeyframe",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered keyframe.set command writing one keyframe (time, channel, value) on a track. Rotation values are quaternions [x, y, z, w]; translation/scale values are [x, y, z].",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      animationId: ID_SCHEMA,
      trackId: ID_SCHEMA,
      keyframeId: ID_SCHEMA,
      time: TIME_SCHEMA,
      channel: CHANNEL_SCHEMA,
      value: {
        type: "array",
        items: { type: "number" },
        minItems: 3,
        maxItems: 4,
      },
    },
    required: [
      "animationId",
      "trackId",
      "keyframeId",
      "time",
      "channel",
      "value",
    ],
  },
  outputSchema: mutationOutputSchema("setKeyframe"),
};

export function setKeyframe(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const animationIdValue = animationId(requireString(record, "animationId"));
  const trackIdValue = trackId(requireString(record, "trackId"));
  requireTrackInAnimation(
    ctx.store.getDocument(),
    animationIdValue,
    trackIdValue,
  );
  const channel = requireChannel(record, "channel");
  const command = setKeyframeCommand(resolveCommandId(ctx, record), {
    animationId: animationIdValue,
    trackId: trackIdValue,
    keyframeId: keyframeId(requireString(record, "keyframeId")),
    time: requireKeyframeTime(record, "time"),
    property: {
      channel,
      value: requireKeyframeValue(record, "value", channel),
    } as unknown as TrackProperty,
  });
  return {
    command,
    voxelEstimate: estimateVoxelDelta(command, ctx.store),
    animation: { keyframes: 1 },
  };
}

/** `moveKeyframe` contract: construct a `keyframe.move` command. */
export const MOVE_KEYFRAME_CONTRACT: ToolContract = {
  name: "moveKeyframe",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered keyframe.move command retiming one keyframe without changing its value.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      animationId: ID_SCHEMA,
      trackId: ID_SCHEMA,
      keyframeId: ID_SCHEMA,
      time: TIME_SCHEMA,
    },
    required: ["animationId", "trackId", "keyframeId", "time"],
  },
  outputSchema: mutationOutputSchema("moveKeyframe"),
};

export function moveKeyframe(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const animationIdValue = animationId(requireString(record, "animationId"));
  const trackIdValue = trackId(requireString(record, "trackId"));
  requireTrackInAnimation(
    ctx.store.getDocument(),
    animationIdValue,
    trackIdValue,
  );
  const command = moveKeyframeCommand(resolveCommandId(ctx, record), {
    animationId: animationIdValue,
    trackId: trackIdValue,
    keyframeId: keyframeId(requireString(record, "keyframeId")),
    time: requireKeyframeTime(record, "time"),
  });
  // Retiming counts one modified keyframe against the session budget
  // (issue #119): destruction must not bypass keyframe caps.
  return {
    command,
    voxelEstimate: estimateVoxelDelta(command, ctx.store),
    animation: { keyframes: 1 },
  };
}

/** `deleteKeyframe` contract: construct a `keyframe.delete` command. */
export const DELETE_KEYFRAME_CONTRACT: ToolContract = {
  name: "deleteKeyframe",
  version: 1,
  capability: "mutate",
  description:
    "Constructs a registered keyframe.delete command removing one keyframe from a track.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      commandId: ID_SCHEMA,
      animationId: ID_SCHEMA,
      trackId: ID_SCHEMA,
      keyframeId: ID_SCHEMA,
    },
    required: ["animationId", "trackId", "keyframeId"],
  },
  outputSchema: mutationOutputSchema("deleteKeyframe"),
};

export function deleteKeyframe(
  ctx: MutationToolContext,
  args: JsonValue,
): MutationPayload {
  const record = args as Readonly<Record<string, JsonValue>>;
  const animationIdValue = animationId(requireString(record, "animationId"));
  const trackIdValue = trackId(requireString(record, "trackId"));
  requireTrackInAnimation(
    ctx.store.getDocument(),
    animationIdValue,
    trackIdValue,
  );
  const command = deleteKeyframeCommand(resolveCommandId(ctx, record), {
    animationId: animationIdValue,
    trackId: trackIdValue,
    keyframeId: keyframeId(requireString(record, "keyframeId")),
  });
  // Deleting counts one modified keyframe against the session budget
  // (issue #119): destruction must not bypass keyframe caps.
  return {
    command,
    voxelEstimate: estimateVoxelDelta(command, ctx.store),
    animation: { keyframes: 1 },
  };
}

function requireLoop(
  record: Readonly<Record<string, JsonValue>>,
): "once" | "loop" {
  const value = record.loop;
  if (value !== "once" && value !== "loop") {
    invalidArgument('loop must be one of "once", "loop"', ["loop"]);
  }
  return value;
}

function requireOptionalLoop(
  record: Readonly<Record<string, JsonValue>>,
): "once" | "loop" | undefined {
  if (record.loop === undefined) return undefined;
  return requireLoop(record);
}

function requireInterpolation(
  record: Readonly<Record<string, JsonValue>>,
): "step" | "linear" | "smoothstep" {
  const value = record.interpolation;
  if (value !== "step" && value !== "linear" && value !== "smoothstep") {
    invalidArgument(
      'interpolation must be one of "step", "linear", "smoothstep"',
      ["interpolation"],
    );
  }
  return value;
}
