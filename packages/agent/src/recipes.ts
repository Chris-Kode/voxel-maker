import type { DocumentStoreRead } from "@voxel-maker/document";
import { worldTransformMatrix } from "@voxel-maker/document";
import { applyMatrix } from "@voxel-maker/math";
import type {
  AnimationDescriptor,
  SceneNode,
  VoxelDocument,
} from "@voxel-maker/model";
import type { JsonValue, NodeId } from "@voxel-maker/shared";
import { ResponseBudget, boundedEmit, clampString } from "./budget.js";
import type { InspectionLimits } from "./limits.js";
import { DEFAULT_INSPECTION_LIMITS } from "./limits.js";

/**
 * Agent context recipes (plan S13.1/S13.2, ticket #36 AC): compact,
 * bounded JSON summaries of the rig and animation state an agent needs
 * before staging — bounded hierarchy, pivots, voxel bounds, world
 * transforms, constraints, clips, tracks, and targeted keyframe detail.
 * Recipes are pure reads over `DocumentStoreRead` (never mutated), are
 * truncated predictably through the response budget, and never dump an
 * authoritative full document (plan S12.6).
 */

/** Bounded recipe options; every limit can only be lowered. */
export interface RecipeOptions {
  /** Maximum nodes in the rig recipe (default 200, hard cap 1024). */
  readonly maxNodes?: number;
  /** Maximum hierarchy depth (default 8, hard cap 32). */
  readonly maxHierarchyDepth?: number;
  /** Maximum serialized recipe size in JSON code units (default 16 KiB). */
  readonly maxResponseBytes?: number;
  /** Maximum characters of a display name (default 128). */
  readonly maxNameLength?: number;
  /** Maximum clips in the animation recipe page (default 50). */
  readonly pageSize?: number;
}

/** Resolves recipe options against the hard bounds (lower-only). */
export function resolveRecipeOptions(
  options: RecipeOptions | undefined,
): Required<RecipeOptions> {
  const maxNodes = clamp(options?.maxNodes, 200, 1024);
  const maxHierarchyDepth = clamp(options?.maxHierarchyDepth, 8, 32);
  const maxResponseBytes = clamp(options?.maxResponseBytes, 65_536, 1_048_576);
  const maxNameLength = clamp(options?.maxNameLength, 128, 512);
  const pageSize = clamp(options?.pageSize, 50, 500);
  return {
    maxNodes,
    maxHierarchyDepth,
    maxResponseBytes,
    maxNameLength,
    pageSize,
  };
}

function clamp(
  value: number | undefined,
  fallback: number,
  max: number,
): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.min(value, max)
    : fallback;
}

/** The bounded rig context recipe of one document. */
export interface RigContextRecipe {
  readonly hierarchy: readonly {
    readonly nodeId: string;
    readonly name?: string;
    readonly parentId: string | null;
    readonly children: readonly string[];
  }[];
  /** Per-node rig facts in document order, bounded by `maxNodes`. */
  readonly nodes: readonly {
    readonly nodeId: string;
    readonly name?: string;
    readonly bounds?: {
      readonly min: readonly number[];
      readonly max: readonly number[];
    };
    readonly worldPosition: readonly number[];
    readonly pivot?: readonly number[];
    readonly hasJoint: boolean;
    readonly constraints: readonly {
      readonly componentId: string;
      readonly type: string;
      readonly limits: {
        readonly min: readonly number[];
        readonly max: readonly number[];
      };
    }[];
  }[];
  readonly truncated: boolean;
}

/** Builds the bounded rig context recipe (plan S13.1). */
export function rigContextRecipe(
  store: DocumentStoreRead,
  options?: RecipeOptions,
): RigContextRecipe {
  const resolved = resolveRecipeOptions(options);
  const limits: InspectionLimits = {
    ...DEFAULT_INSPECTION_LIMITS,
    maxNameLength: resolved.maxNameLength,
    defaultPageSize: resolved.pageSize,
    maxPageSize: resolved.pageSize,
  };
  const budget = new ResponseBudget(resolved.maxResponseBytes);
  const document = store.getDocument();
  const nodeIds = Object.keys(document.nodes) as NodeId[];
  const selected = nodeIds.slice(0, resolved.maxNodes);
  const truncated = nodeIds.length > resolved.maxNodes;
  const byId = new Map<NodeId, SceneNode>();
  for (const node of Object.values(document.nodes)) byId.set(node.nodeId, node);

  const hierarchy = boundedEmit(budget, selected, (nodeId) => {
    const node = byId.get(nodeId);
    if (node === undefined) return undefined;
    return {
      nodeId: node.nodeId,
      ...(node.name === undefined
        ? {}
        : { name: clampString(node.name, limits.maxNameLength).value }),
      parentId: node.parentId,
      children: node.children.slice(0, resolved.maxNodes),
    } as JsonValue;
  });
  const nodes = boundedEmit(budget, selected, (nodeId) => {
    const node = byId.get(nodeId);
    if (node === undefined) return undefined;
    return {
      nodeId: node.nodeId,
      ...(node.name === undefined
        ? {}
        : { name: clampString(node.name, limits.maxNameLength).value }),
      ...(boundsOf(store, document, node) === undefined
        ? {}
        : { bounds: boundsOf(store, document, node) }),
      worldPosition: [...nodeWorldPosition(store, nodeId)],
      ...rigFacts(node),
    } as JsonValue;
  });
  return {
    hierarchy: hierarchy.list as unknown as RigContextRecipe["hierarchy"],
    nodes: nodes.list as unknown as RigContextRecipe["nodes"],
    truncated: truncated || hierarchy.truncated || nodes.truncated,
  };
}

/** Pivot/joint/constraint facts of one node (compact, stable order). */
function rigFacts(node: SceneNode): {
  readonly pivot?: readonly number[];
  readonly hasJoint: boolean;
  readonly constraints: readonly {
    readonly componentId: string;
    readonly type: string;
    readonly limits: {
      readonly min: readonly number[];
      readonly max: readonly number[];
    };
  }[];
} {
  let pivot: readonly number[] | undefined;
  let hasJoint = false;
  const constraints: {
    componentId: string;
    type: string;
    limits: { min: readonly number[]; max: readonly number[] };
  }[] = [];
  for (const component of node.components) {
    if (component.kind === "pivot") pivot = [...component.pivot];
    else if (component.kind === "joint") hasJoint = true;
    else if (component.kind === "constraint") {
      for (const constraint of component.constraints) {
        constraints.push({
          componentId: constraint.componentId,
          type: constraint.type,
          limits: {
            min: [...constraint.limits.min],
            max: [...constraint.limits.max],
          },
        });
      }
    }
  }
  return {
    ...(pivot === undefined ? {} : { pivot }),
    hasJoint,
    constraints,
  };
}

/** Voxel-volume bounds of a node (first voxel component, document order). */
function boundsOf(
  store: DocumentStoreRead,
  document: VoxelDocument,
  node: SceneNode,
):
  | { readonly min: readonly number[]; readonly max: readonly number[] }
  | undefined {
  for (const component of node.components) {
    if (component.kind !== "voxel") continue;
    const volume = document.volumes[component.volumeId];
    if (volume === undefined || volume.bounds === undefined) continue;
    return {
      min: [...volume.bounds.min],
      max: [...volume.bounds.max],
    };
  }
  return undefined;
}

/** World-space position of a node origin (pivot-aware world transform). */
function nodeWorldPosition(
  store: DocumentStoreRead,
  nodeId: NodeId,
): readonly number[] {
  const matrix = worldTransformMatrix(store.getDocument(), nodeId);
  return [...applyMatrix(matrix, [0, 0, 0])];
}

/** The bounded animation context recipe of one document (plan S13.2). */
export interface AnimationContextRecipe {
  readonly clips: readonly {
    readonly animationId: string;
    readonly name?: string;
    readonly duration: number;
    readonly loop: "once" | "loop";
    readonly tracks: readonly {
      readonly trackId: string;
      readonly targetNodeId: string;
      readonly interpolation: "step" | "linear" | "smoothstep";
      readonly keyframeCount: number;
      /** Targeted detail: first and last keyframe of the track. */
      readonly edgeKeyframes: readonly {
        readonly keyframeId: string;
        readonly time: number;
        readonly channel: string;
        readonly value: readonly number[];
      }[];
    }[];
  }[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
  readonly hasMore: boolean;
  readonly truncated: boolean;
}

/** Builds the bounded animation context recipe (plan S13.2). */
export function animationContextRecipe(
  store: DocumentStoreRead,
  options?: RecipeOptions & { readonly page?: number },
): AnimationContextRecipe {
  const resolved = resolveRecipeOptions(options);
  const limits: InspectionLimits = {
    ...DEFAULT_INSPECTION_LIMITS,
    maxNameLength: resolved.maxNameLength,
    defaultPageSize: resolved.pageSize,
    maxPageSize: resolved.pageSize,
  };
  const budget = new ResponseBudget(resolved.maxResponseBytes);
  const document = store.getDocument();
  const animations = Object.values(document.animations);
  const page = options?.page ?? 1;
  const start = (page - 1) * resolved.pageSize;
  const pageAnimations = animations.slice(start, start + resolved.pageSize);
  const clips = boundedEmit(
    budget,
    pageAnimations,
    (animation) =>
      ({
        animationId: animation.animationId,
        ...(animation.name === undefined
          ? {}
          : { name: clampString(animation.name, limits.maxNameLength).value }),
        duration: animation.duration,
        loop: animation.loop,
        tracks: animation.tracks.map((track) => ({
          trackId: track.trackId,
          targetNodeId: track.targetNodeId,
          interpolation: track.interpolation,
          keyframeCount: track.keyframes.length,
          edgeKeyframes: edgeKeyframesOf(track),
        })),
      }) as JsonValue,
  );
  return {
    clips: clips.list as unknown as AnimationContextRecipe["clips"],
    page,
    pageSize: resolved.pageSize,
    total: animations.length,
    hasMore: start + resolved.pageSize < animations.length && !clips.truncated,
    truncated: clips.truncated,
  };
}

/** First and last keyframe of a track (the compact targeted detail). */
function edgeKeyframesOf(track: AnimationDescriptor["tracks"][number]): {
  readonly keyframeId: string;
  readonly time: number;
  readonly channel: string;
  readonly value: readonly number[];
}[] {
  if (track.keyframes.length === 0) return [];
  const first = track.keyframes[0];
  const last = track.keyframes[track.keyframes.length - 1];
  if (first === undefined || last === undefined) return [];
  const entry = (keyframe: (typeof track.keyframes)[number]) => ({
    keyframeId: keyframe.keyframeId,
    time: keyframe.time,
    channel: keyframe.property.channel,
    value: [...keyframe.property.value],
  });
  return first === last ? [entry(first)] : [entry(first), entry(last)];
}

/** One bounded context block appended to the agent system prompt. */
export interface AgentContextBlock {
  readonly text: string;
  readonly truncated: boolean;
}

/**
 * Composes the bounded rig/animation context block for the system prompt
 * (plan S13.1/S13.2): JSON text of the requested recipes with a short
 * preamble; absent recipes contribute nothing. The block never contains
 * voxel data or authoritative full document state.
 */
export function composeAgentContextBlock(
  store: DocumentStoreRead,
  options: {
    readonly rigging?: boolean;
    readonly animation?: boolean;
    readonly recipe?: RecipeOptions;
  } = {},
): AgentContextBlock {
  const parts: string[] = [];
  if (options.rigging === true) {
    const recipe = rigContextRecipe(store, options.recipe);
    parts.push(
      `Rig context (${String(recipe.nodes.length)} nodes, ${recipe.truncated ? "truncated" : "complete"}):\n${JSON.stringify(recipe)}`,
    );
  }
  if (options.animation === true) {
    const recipe = animationContextRecipe(store, options.recipe);
    parts.push(
      `Animation context (${String(recipe.total)} clips, page ${String(recipe.page)}/${recipe.hasMore ? "more" : "all"}):\n${JSON.stringify(recipe)}`,
    );
  }
  if (parts.length === 0) return { text: "", truncated: false };
  const text = [
    "Bounded context recipes of the CURRENT document state (read-only, authoritative):",
    ...parts,
  ].join("\n");
  return { text, truncated: text.length > 0 };
}
