import { nodeId, type CommandId, type NodeId } from "@voxel-maker/shared";
import type { VoxelDocument } from "@voxel-maker/model";
import {
  createNodeCommand,
  deleteNodeCommand,
  renameNodeCommand,
  reparentNodeCommand,
  type Command,
} from "@voxel-maker/commands";

/**
 * Headless hierarchy-panel semantics (plan S7.11, ticket #20): pure
 * feedback and command construction for create, rename, delete, and drag
 * reparenting. React widgets never encode these domain rules themselves
 * (ARCHITECTURE.md "Editor interaction"): the panel asks this module what
 * a drop or a delete means and commits the returned command through the
 * bus; every rejection reason is deterministic and user-safe.
 *
 * Reparent drags use `preserve-world` placement so the node keeps its
 * world placement under the new parent (the command constructor resolves
 * the canonical local transform, ADR-0001).
 */

/** Why a drag-reparent drop is (or is not) allowed. */
export type ReparentFeedback =
  | { readonly ok: true; readonly placement: "preserve-world" }
  | { readonly ok: false; readonly reason: ReparentRejectReason };

export type ReparentRejectReason =
  | "missing-node"
  | "missing-target"
  | "self"
  | "root"
  | "cycle";

/** Why a delete is (or is not) allowed (reference feedback, plan S7.11). */
export type DeleteFeedback =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: "missing-node" | "root" | "has-children" | "referenced";
    };

/**
 * Resolves one drag-reparent drop against the document. `targetId`
 * undefined means the drop landed on the panel background (no reparent).
 * The feedback is computed from live document state only, so it matches
 * the command validation exactly.
 */
export function reparentFeedback(
  document: VoxelDocument,
  nodeId: NodeId,
  targetId: NodeId | undefined,
): ReparentFeedback {
  if (targetId === undefined) return { ok: false, reason: "missing-target" };
  if (document.nodes[nodeId] === undefined) {
    return { ok: false, reason: "missing-node" };
  }
  if (document.nodes[targetId] === undefined) {
    return { ok: false, reason: "missing-target" };
  }
  if (nodeId === targetId) return { ok: false, reason: "self" };
  if (nodeId === document.rootNodeId) return { ok: false, reason: "root" };
  if (isAncestor(document, targetId, nodeId)) {
    return { ok: false, reason: "cycle" };
  }
  return { ok: true, placement: "preserve-world" };
}

/**
 * True when `maybeAncestorId` is an ancestor of `nodeId` (walking up from
 * the node's parent reaches it). Used for cycle feedback and drop-target
 * highlighting. The walk is iterative and cycle-guarded.
 */
export function isAncestor(
  document: VoxelDocument,
  nodeId: NodeId,
  maybeAncestorId: NodeId,
): boolean {
  const seen = new Set<NodeId>();
  let current: NodeId | undefined =
    document.nodes[nodeId]?.parentId ?? undefined;
  while (current !== undefined) {
    if (current === maybeAncestorId) return true;
    if (seen.has(current)) return false;
    seen.add(current);
    current = document.nodes[current]?.parentId ?? undefined;
  }
  return false;
}

/**
 * Pre-checks a delete for the panel's reference feedback (plan S7.11):
 * the command bus enforces the same rules authoritatively; the panel
 * shows the reason before committing so the user understands the
 * rejection. Animation tracks that target the node make it "referenced".
 */
export function deleteFeedback(
  document: VoxelDocument,
  nodeId: NodeId,
): DeleteFeedback {
  const node = document.nodes[nodeId];
  if (node === undefined) return { ok: false, reason: "missing-node" };
  if (nodeId === document.rootNodeId) return { ok: false, reason: "root" };
  if (node.children.length > 0) {
    return { ok: false, reason: "has-children" };
  }
  for (const animation of Object.values(document.animations)) {
    for (const track of animation.tracks) {
      if (track.targetNodeId === nodeId) {
        return { ok: false, reason: "referenced" };
      }
    }
  }
  return { ok: true };
}

/**
 * Next default child name under `parentId`: the first of "Node",
 * "Node 2", "Node 3", ... that no sibling (or the parent itself) uses.
 * Deterministic and collision-free for fresh documents.
 */
export function defaultChildName(
  document: VoxelDocument,
  parentId: NodeId,
): string {
  const parent = document.nodes[parentId];
  if (parent === undefined) return "Node";
  const used = new Set<string>();
  if (parent.name !== undefined) used.add(parent.name);
  for (const childId of parent.children) {
    const child = document.nodes[childId];
    if (child?.name !== undefined) used.add(child.name);
  }
  let index = 1;
  for (;;) {
    const candidate = index === 1 ? "Node" : `Node ${String(index)}`;
    if (!used.has(candidate)) return candidate;
    index += 1;
  }
}

/** A create-child command plus the node id it will install. */
export interface CreateChildCommand {
  readonly command: Command<"node.create">;
  readonly nodeId: NodeId;
}

/**
 * Builds a `node.create` command for a fresh child of `parentId` with the
 * default name, the identity transform, and no components; the child is
 * appended to the parent's ordered children. Returns the command together
 * with the node id it installs so callers can select the new node without
 * reverse-engineering the payload.
 */
export function buildCreateChildCommand(
  id: CommandId,
  document: VoxelDocument,
  parentId: NodeId,
): CreateChildCommand {
  const nodeId = nodeIdFromCommandId(id);
  return {
    nodeId,
    command: createNodeCommand(id, {
      nodeId,
      name: defaultChildName(document, parentId),
      parentId,
      transform: {
        translation: [0, 0, 0],
        pivot: [0, 0, 0],
        rotation: [0, 0, 0, 1],
        scale: [1, 1, 1],
      },
    }),
  };
}

/** Builds a `node.rename` command; an empty name removes the node name. */
export function buildRenameCommand(
  id: CommandId,
  nodeId: NodeId,
  name: string,
): Command<"node.rename"> {
  return renameNodeCommand(id, {
    nodeId,
    ...(name.trim().length === 0 ? {} : { name: name.trim() }),
  });
}

/** Builds a `node.delete` command (leaf nodes only, see deleteFeedback). */
export function buildDeleteCommand(
  id: CommandId,
  nodeId: NodeId,
): Command<"node.delete"> {
  return deleteNodeCommand(id, { nodeId });
}

/**
 * Builds a `node.reparent` command with `preserve-world` placement: the
 * node's world placement is preserved under the new parent (ADR-0001
 * derived-transform policy). Returns undefined when the drop is not
 * allowed (use `reparentFeedback` to show the reason first).
 */
export function buildReparentCommand(
  id: CommandId,
  document: VoxelDocument,
  nodeId: NodeId,
  targetId: NodeId,
): Command<"node.reparent"> | undefined {
  const feedback = reparentFeedback(document, nodeId, targetId);
  if (!feedback.ok) return undefined;
  return reparentNodeCommand(
    id,
    { nodeId, newParentId: targetId, placement: "preserve-world" },
    document,
  );
}

/** Derives a deterministic node id from the command id (branded). */
function nodeIdFromCommandId(id: CommandId): NodeId {
  return nodeId(`node:${id.replace(/^command:/u, "")}`);
}
