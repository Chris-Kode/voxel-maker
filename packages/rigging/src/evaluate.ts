import {
  multiplyMatrices,
  transformToMatrix,
  type Mat4,
  type Transform,
} from "@voxel-maker/math";
import { worldTransformMatrix } from "@voxel-maker/document";
import type { NodeId } from "@voxel-maker/shared";
import type { SceneNode, VoxelDocument } from "@voxel-maker/model";

/**
 * Pivot-aware rig evaluation (plan S9.2, ticket #26). The node hierarchy
 * is the only transform graph: a local transform evaluates to
 * `T(translation) x T(pivot) x R(rotation) x S(scale) x T(-pivot)`
 * (ADR-0001, approved transform formula), and a world transform is the
 * composition of ancestor local matrices from the root down. Evaluation
 * is pure: it reads the immutable document and never mutates state.
 */

/**
 * Local 4x4 matrix of a canonical node transform, evaluating the approved
 * pivot formula `T(translation) x T(pivot) x R(rotation) x S(scale) x
 * T(-pivot)` (ADR-0001).
 */
export function evaluateLocalTransform(transform: Transform): Mat4 {
  return transformToMatrix(transform);
}

/**
 * World 4x4 matrix of one node: the composition of the node's ancestors'
 * local matrices with its own, `M(root) x ... x M(node)` (plan S2.9).
 * Cycle-guarded like the document read-model equivalent.
 */
export function evaluateWorldTransform(
  document: VoxelDocument,
  nodeId: NodeId,
): Mat4 {
  return worldTransformMatrix(document, nodeId);
}

/**
 * World 4x4 matrices of every node reachable from the document root in
 * one deterministic pre-order pass (parents always before children, using
 * the authoritative children order). This is the rig-runtime table the
 * renderer and later animation layers evaluate against; it is a pure
 * projection and never touches the document. Nodes not reachable from the
 * root are absent from the map (valid documents have none).
 */
export function evaluateNodeWorldTransforms(
  document: VoxelDocument,
): ReadonlyMap<NodeId, Mat4> {
  const world = new Map<NodeId, Mat4>();
  const root = document.nodes[document.rootNodeId];
  if (root === undefined) return world;
  world.set(root.nodeId, transformToMatrix(root.transform));
  const stack: SceneNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) break;
    const parentWorld = world.get(node.nodeId);
    if (parentWorld === undefined) break;
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      const childId = node.children[index];
      const child = childId === undefined ? undefined : document.nodes[childId];
      if (child === undefined || world.has(child.nodeId)) continue;
      world.set(
        child.nodeId,
        multiplyMatrices(parentWorld, transformToMatrix(child.transform)),
      );
      stack.push(child);
    }
  }
  return world;
}
