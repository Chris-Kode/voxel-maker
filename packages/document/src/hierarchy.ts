import type { NodeId, VolumeId } from "@voxel-maker/shared";
import {
  multiplyMatrices,
  transformToMatrix,
  type Mat4,
} from "@voxel-maker/math";
import type { SceneNode, VoxelDocument } from "@voxel-maker/model";

const IDENTITY_MATRIX: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * World matrix of a node: the composition of its ancestors' local transforms
 * with its own, `M(root) x ... x M(node)` (plan S2.9). Matrices are
 * runtime-only (ADR-0001); the walk is iterative and cycle-guarded.
 */
export function worldTransformMatrix(
  document: VoxelDocument,
  nodeId: NodeId,
): Mat4 {
  const chain: SceneNode[] = [];
  const seen = new Set<NodeId>();
  let current: SceneNode | undefined = document.nodes[nodeId];
  while (current !== undefined) {
    if (seen.has(current.nodeId)) break;
    seen.add(current.nodeId);
    chain.push(current);
    current =
      current.parentId === null ? undefined : document.nodes[current.parentId];
  }
  let matrix = IDENTITY_MATRIX;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const node = chain[index];
    if (node === undefined) continue;
    matrix = multiplyMatrices(matrix, transformToMatrix(node.transform));
  }
  return matrix;
}

/**
 * Nodes whose voxel component references the volume (plan 5.3): the
 * volume->owner lookup shared by command handlers and projections. The
 * scan follows stable document record order; callers may not rely on the
 * returned node order.
 */
export function nodesReferencingVolume(
  document: VoxelDocument,
  volumeId: VolumeId,
): readonly NodeId[] {
  const nodeIds: NodeId[] = [];
  for (const node of Object.values(document.nodes)) {
    if (
      node.components.some(
        (component) =>
          component.kind === "voxel" && component.volumeId === volumeId,
      )
    ) {
      nodeIds.push(node.nodeId);
    }
  }
  return nodeIds;
}
