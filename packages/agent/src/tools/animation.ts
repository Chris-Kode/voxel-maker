import type { AnimationId, JsonValue, TrackId } from "@voxel-maker/shared";
import { boundedEmit } from "../budget.js";
import { outputSchema, type ToolContract } from "../contract.js";
import {
  clampName,
  pageSlice,
  requireAnimation,
  requireTrack,
  resolvePage,
  resolvePageSize,
} from "./helpers.js";
import type { ToolContext } from "./context.js";

/**
 * Animation inspection (plan S11.3/S13.2): clip summaries, track
 * summaries, and keyframe detail, all paginated and budget-truncated with
 * stable ids (clip, track, keyframe) and canonical values.
 */

/** `inspectClips` contract. */
export const INSPECT_CLIPS_CONTRACT: ToolContract = {
  name: "inspectClips",
  version: 1,
  capability: "inspect",
  description:
    "Paginated clip summaries: id, name, duration, loop policy, and track/keyframe counts.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      page: { type: "integer", minimum: 1 },
      pageSize: { type: "integer", minimum: 1 },
    },
  },
  outputSchema: outputSchema(
    "inspectClips",
    {
      total: { type: "integer", minimum: 0 },
      page: { type: "integer", minimum: 1 },
      pageSize: { type: "integer", minimum: 1 },
      hasMore: { type: "boolean" },
      clips: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            animationId: { type: "string" },
            name: { type: "string" },
            duration: { type: "number", minimum: 0 },
            loop: { type: "string", enum: ["once", "loop"] },
            trackCount: { type: "integer", minimum: 0 },
            keyframeCount: { type: "integer", minimum: 0 },
          },
          required: [
            "animationId",
            "duration",
            "loop",
            "trackCount",
            "keyframeCount",
          ],
        },
      },
    },
    ["total", "page", "pageSize", "hasMore", "clips"],
  ),
};

export function inspectClips(
  ctx: ToolContext,
  args: JsonValue,
): Readonly<Record<string, JsonValue>> {
  const { store, limits, budget } = ctx;
  const record = args as Readonly<Record<string, JsonValue>>;
  const animations = Object.values(store.getDocument().animations);
  const entries = animations.map((animation) => ({
    animationId: animation.animationId,
    ...(animation.name === undefined
      ? {}
      : { name: clampName(animation.name, limits) }),
    duration: animation.duration,
    loop: animation.loop,
    trackCount: animation.tracks.length,
    keyframeCount: animation.tracks.reduce(
      (sum, track) => sum + track.keyframes.length,
      0,
    ),
  }));
  const page = resolvePage(record);
  const pageSize = resolvePageSize(record, limits);
  const slice = pageSlice(entries.length, page, pageSize);
  const emitted = boundedEmit(
    budget,
    entries.slice(slice.start, slice.end),
    (entry) => entry,
  );
  return {
    total: slice.total,
    page: slice.page,
    pageSize: slice.pageSize,
    hasMore: slice.hasMore && !emitted.truncated,
    clips: emitted.list,
  };
}

/** `inspectTracks` contract. */
export const INSPECT_TRACKS_CONTRACT: ToolContract = {
  name: "inspectTracks",
  version: 1,
  capability: "inspect",
  description:
    "Paginated track summaries across one clip or every clip: track id, owning clip, target node, interpolation, keyframe count, and the union of animated channels.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      animationId: {
        type: "string",
        description: "Restrict to one clip (default: every clip)",
      },
      page: { type: "integer", minimum: 1 },
      pageSize: { type: "integer", minimum: 1 },
    },
  },
  outputSchema: outputSchema(
    "inspectTracks",
    {
      total: { type: "integer", minimum: 0 },
      page: { type: "integer", minimum: 1 },
      pageSize: { type: "integer", minimum: 1 },
      hasMore: { type: "boolean" },
      tracks: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            trackId: { type: "string" },
            animationId: { type: "string" },
            targetNodeId: { type: "string" },
            interpolation: {
              type: "string",
              enum: ["step", "linear", "smoothstep"],
            },
            keyframeCount: { type: "integer", minimum: 0 },
            channels: {
              type: "array",
              items: {
                type: "string",
                enum: ["translation", "rotation", "scale"],
              },
            },
          },
          required: [
            "trackId",
            "animationId",
            "targetNodeId",
            "interpolation",
            "keyframeCount",
            "channels",
          ],
        },
      },
    },
    ["total", "page", "pageSize", "hasMore", "tracks"],
  ),
};

export function inspectTracks(
  ctx: ToolContext,
  args: JsonValue,
): Readonly<Record<string, JsonValue>> {
  const { store, limits, budget } = ctx;
  const document = store.getDocument();
  const record = args as Readonly<Record<string, JsonValue>>;
  const animations =
    record.animationId === undefined
      ? Object.values(document.animations)
      : [
          requireAnimation(
            document,
            record.animationId as string as AnimationId,
          ),
        ];
  const entries: JsonValue[] = [];
  for (const animation of animations) {
    for (const track of animation.tracks) {
      const channels = new Set<string>();
      for (const keyframe of track.keyframes)
        channels.add(keyframe.property.channel);
      entries.push({
        trackId: track.trackId,
        animationId: animation.animationId,
        targetNodeId: track.targetNodeId,
        interpolation: track.interpolation,
        keyframeCount: track.keyframes.length,
        channels: [...channels],
      });
    }
  }
  const page = resolvePage(record);
  const pageSize = resolvePageSize(record, limits);
  const slice = pageSlice(entries.length, page, pageSize);
  const emitted = boundedEmit(
    budget,
    entries.slice(slice.start, slice.end),
    (entry) => entry,
  );
  return {
    total: slice.total,
    page: slice.page,
    pageSize: slice.pageSize,
    hasMore: slice.hasMore && !emitted.truncated,
    tracks: emitted.list,
  };
}

/** `inspectKeyframes` contract. */
export const INSPECT_KEYFRAMES_CONTRACT: ToolContract = {
  name: "inspectKeyframes",
  version: 1,
  capability: "inspect",
  description:
    "Paginated keyframes of one track with canonical values: time, channel, and value (translation/scale triples or rotation quaternion). Missing tracks fail with UNKNOWN_TRACK.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      trackId: { type: "string" },
      page: { type: "integer", minimum: 1 },
      pageSize: { type: "integer", minimum: 1 },
    },
    required: ["trackId"],
  },
  outputSchema: outputSchema(
    "inspectKeyframes",
    {
      trackId: { type: "string" },
      animationId: { type: "string" },
      targetNodeId: { type: "string" },
      interpolation: { type: "string", enum: ["step", "linear", "smoothstep"] },
      total: { type: "integer", minimum: 0 },
      page: { type: "integer", minimum: 1 },
      pageSize: { type: "integer", minimum: 1 },
      hasMore: { type: "boolean" },
      keyframes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            keyframeId: { type: "string" },
            time: { type: "number", minimum: 0 },
            channel: {
              type: "string",
              enum: ["translation", "rotation", "scale"],
            },
            value: {
              type: "array",
              items: { type: "number" },
              minItems: 3,
              maxItems: 4,
            },
          },
          required: ["keyframeId", "time", "channel", "value"],
        },
      },
    },
    [
      "trackId",
      "animationId",
      "targetNodeId",
      "interpolation",
      "total",
      "page",
      "pageSize",
      "hasMore",
      "keyframes",
    ],
  ),
};

export function inspectKeyframes(
  ctx: ToolContext,
  args: JsonValue,
): Readonly<Record<string, JsonValue>> {
  const { store, limits, budget } = ctx;
  const document = store.getDocument();
  const record = args as Readonly<Record<string, JsonValue>>;
  const { animationId, track } = requireTrack(
    document,
    record.trackId as string as TrackId,
  );
  const entries = track.keyframes.map((keyframe) => ({
    keyframeId: keyframe.keyframeId,
    time: keyframe.time,
    channel: keyframe.property.channel,
    value: [...keyframe.property.value],
  }));
  const page = resolvePage(record);
  const pageSize = resolvePageSize(record, limits);
  const slice = pageSlice(entries.length, page, pageSize);
  const emitted = boundedEmit(
    budget,
    entries.slice(slice.start, slice.end),
    (entry) => entry,
  );
  return {
    trackId: track.trackId,
    animationId,
    targetNodeId: track.targetNodeId,
    interpolation: track.interpolation,
    total: slice.total,
    page: slice.page,
    pageSize: slice.pageSize,
    hasMore: slice.hasMore && !emitted.truncated,
    keyframes: emitted.list,
  };
}
