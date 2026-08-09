import {
  multiplyMatrices,
  transformToMatrix,
  type Mat4,
  type Transform,
} from "@voxel-maker/math";
import {
  evaluateConstrainedLocalTransform,
  rotationConstraintsOf,
} from "@voxel-maker/rigging";
import type {
  AnimationDescriptor,
  SceneNode,
  VoxelDocument,
} from "@voxel-maker/model";
import type { AnimationId, NodeId } from "@voxel-maker/shared";
import { sampleClip, type NodeOverrides } from "./evaluate.js";

/**
 * Layered runtime transform evaluation (plan S10.5, tickets #28/#27).
 * ADR-0006 freezes the evaluation order: base Document state, then
 * animation override, then constraints, before the hierarchy world pass.
 * This module implements all four layers: the base and animation layers
 * produce the local table, the constraint layer clamps each local
 * rotation in persisted order, and the world pass composes the clamped
 * locals root-first.
 *
 * The evaluation is a pure runtime projection: it reads the immutable
 * document and clip, returns fresh immutable maps, and never issues
 * commands, never bumps revisions, and never mutates the document.
 * Stopping playback (evaluating with no clip) restores base state exactly
 * because the base layer is the identity for an absent clip.
 */

/**
 * The runtime state of one animated evaluation: the resolved sample time,
 * per-node local transforms after the animation override, and per-node
 * world matrices composed root-first (parents always before children).
 * Both maps are immutable snapshots; nodes not reachable from the root are
 * absent from the world map (valid documents have none).
 */
export interface AnimationRuntimeState {
  readonly time: number;
  readonly clipId: AnimationId | null;
  readonly local: ReadonlyMap<NodeId, Transform>;
  readonly world: ReadonlyMap<NodeId, Mat4>;
}

/**
 * A read-only view over a mutable map, matching the immutable-snapshot
 * contract of the runtime evaluator. `Object.freeze` alone cannot seal a
 * Map (entries live in internal slots), so the view exposes only the
 * `ReadonlyMap` surface and has no mutating methods at all.
 */
class ReadOnlyMapView<K, V> implements ReadonlyMap<K, V> {
  readonly #source: Map<K, V>;

  constructor(source: Map<K, V>) {
    this.#source = source;
  }

  get size(): number {
    return this.#source.size;
  }

  get(key: K): V | undefined {
    return this.#source.get(key);
  }

  has(key: K): boolean {
    return this.#source.has(key);
  }

  keys(): IterableIterator<K> {
    return this.#source.keys();
  }

  values(): IterableIterator<V> {
    return this.#source.values();
  }

  entries(): IterableIterator<[K, V]> {
    return this.#source.entries();
  }

  forEach(
    callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    this.#source.forEach((value, key) => {
      callback.call(thisArg, value, key, this);
    });
  }

  [Symbol.iterator](): IterableIterator<[K, V]> {
    return this.#source.entries();
  }

  get [Symbol.toStringTag](): string {
    return "ReadOnlyMapView";
  }
}

function applyOverride(
  base: Transform,
  overrides: Readonly<
    Partial<
      Record<
        "translation" | "rotation" | "scale",
        { readonly value: readonly number[] }
      >
    >
  >,
): Transform {
  const translation = overrides.translation?.value as
    | readonly [number, number, number]
    | undefined;
  const rotation = overrides.rotation?.value as
    | readonly [number, number, number, number]
    | undefined;
  const scale = overrides.scale?.value as
    | readonly [number, number, number]
    | undefined;
  return Object.freeze({
    translation: translation ?? base.translation,
    pivot: base.pivot,
    rotation: rotation ?? base.rotation,
    scale: scale ?? base.scale,
  });
}

/**
 * Builds the local-transform table from an optional override map: base
 * node transform, then the sampled clip property overrides
 * (translation/rotation/scale replace the base component; the pivot is
 * never animated in v1 and always stays base). Pass no overrides to
 * evaluate pure base state — the exact state `stop()` restores.
 */
export function evaluateLocalTransformsFromOverrides(
  document: VoxelDocument,
  overrides: ReadonlyMap<NodeId, NodeOverrides> | undefined,
): ReadonlyMap<NodeId, Transform> {
  const local = new Map<NodeId, Transform>();
  for (const node of Object.values(document.nodes)) {
    const nodeOverrides = overrides?.get(node.nodeId);
    local.set(
      node.nodeId,
      nodeOverrides === undefined
        ? node.transform
        : applyOverride(node.transform, nodeOverrides),
    );
  }
  return new ReadOnlyMapView(local);
}

/**
 * Evaluates the local transforms of every node reachable from the root
 * with the animation override applied: base node transform, then the
 * sampled clip property overrides (translation/rotation/scale replace the
 * base component; the pivot is never animated in v1 and always stays
 * base). Pass `clip: null` to evaluate pure base state — the exact state
 * `stop()` restores.
 */
export function evaluateLocalTransforms(
  document: VoxelDocument,
  clip: AnimationDescriptor | null,
  time: number,
): ReadonlyMap<NodeId, Transform> {
  const overrides =
    clip === null ? undefined : sampleClip(clip, time).overrides;
  return evaluateLocalTransformsFromOverrides(document, overrides);
}

/**
 * Composes the world matrices from a local-transform table in one
 * deterministic root-first pre-order pass (parents always before
 * children, using the authoritative children order). Cycle-guarded like
 * the document read-model equivalent; unreachable nodes are absent.
 */
export function evaluateWorldTransforms(
  document: VoxelDocument,
  local: ReadonlyMap<NodeId, Transform>,
): ReadonlyMap<NodeId, Mat4> {
  const world = new Map<NodeId, Mat4>();
  const root = document.nodes[document.rootNodeId];
  if (root === undefined) return world;
  const rootWorld = transformToMatrix(local.get(root.nodeId) ?? root.transform);
  world.set(root.nodeId, rootWorld);
  const stack: Array<{ readonly node: SceneNode; readonly parentWorld: Mat4 }> =
    [{ node: root, parentWorld: rootWorld }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry === undefined) break;
    const { node, parentWorld } = entry;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const childId = node.children[index];
      if (childId === undefined) continue;
      const child = document.nodes[childId];
      if (child === undefined || world.has(child.nodeId)) continue;
      const childLocal = local.get(child.nodeId) ?? child.transform;
      const childWorld = multiplyMatrices(
        parentWorld,
        transformToMatrix(childLocal),
      );
      world.set(child.nodeId, childWorld);
      stack.push({ node: child, parentWorld: childWorld });
    }
  }
  return new ReadOnlyMapView(world);
}

/**
 * Evaluates the complete layered runtime state: base document state, then
 * animation override, then rotation constraints, then the hierarchy world
 * pass (ADR-0006 order). Pure, deterministic, and immutable: no commands,
 * revisions, or document writes occur.
 */
export function evaluateAnimationRuntime(
  document: VoxelDocument,
  clip: AnimationDescriptor | null,
  time: number,
): AnimationRuntimeState {
  // Sample the clip once; the same overrides feed the local table and the
  // resolved time, so one evaluation allocates one sample.
  const sample = clip === null ? undefined : sampleClip(clip, time);
  const local = evaluateLocalTransformsFromOverrides(
    document,
    sample?.overrides,
  );
  return {
    time: sample?.time ?? 0,
    clipId: clip?.animationId ?? null,
    local,
    world: evaluateWorldTransforms(
      document,
      applyConstraintsToLocal(document, local),
    ),
  };
}

/**
 * Applies the constraint layer to a local-transform table: each node's
 * rotation is clamped in persisted constraint order (plan S9.5, ticket
 * #27) after the animation override and before the world pass. Nodes
 * without constraints pass through unchanged (same object, no copy).
 */
function applyConstraintsToLocal(
  document: VoxelDocument,
  local: ReadonlyMap<NodeId, Transform>,
): ReadonlyMap<NodeId, Transform> {
  const constrained = new Map<NodeId, Transform>();
  for (const [nodeId, transform] of local) {
    const node = document.nodes[nodeId];
    constrained.set(
      nodeId,
      node === undefined
        ? transform
        : evaluateConstrainedLocalTransform(
            transform,
            rotationConstraintsOf(node),
          ),
    );
  }
  return constrained;
}
