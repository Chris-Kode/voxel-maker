import { Fragment, useState } from "react";
import type { NodeId } from "@voxel-maker/shared";
import type { DocumentSession } from "@voxel-maker/session";
import {
  applySelectionIntent,
  buildCreateChildCommand,
  buildDeleteCommand,
  buildRenameCommand,
  buildReparentCommand,
  deleteFeedback,
  isAncestor,
  reparentFeedback,
  type DeleteFeedback,
  type EditorStore,
  type ReparentFeedback,
  type ToolModifiers,
} from "@voxel-maker/editor";
import {
  createPanelIds,
  executeTransaction,
  useDocument,
  useEditorStore,
  type PanelIds,
} from "./panel-utils.js";

/**
 * Hierarchy panel (plan S7.11, ticket #20): create, rename, delete, and
 * drag-reparent the scene graph with cycle and reference feedback. Every
 * action commits a registered command through the session bus; the panel
 * shows the deterministic reason for rejected drops/deletes (cycle, root,
 * children, references) instead of duplicating the validation.
 */

export interface HierarchyPanelProps {
  readonly session: DocumentSession;
  readonly editor: EditorStore;
  /** Shared panel id sequence (created once by the composition root). */
  readonly ids?: PanelIds;
}

const REJECTION_LABELS: Record<string, string> = {
  self: "A node cannot be its own parent",
  root: "The document root cannot be reparented",
  cycle: "This drop would create a cycle in the hierarchy",
  "missing-node": "The dragged node no longer exists",
  "missing-target": "The drop target no longer exists",
};

export function HierarchyPanel({
  session,
  editor,
  ids,
}: HierarchyPanelProps): React.JSX.Element {
  const document = useDocument(session);
  const editorState = useEditorStore(editor);
  const [expanded, setExpanded] = useState<ReadonlySet<NodeId>>(
    () => new Set(),
  );
  const [renaming, setRenaming] = useState<NodeId | undefined>();
  const [renameText, setRenameText] = useState("");
  const [dragging, setDragging] = useState<NodeId | undefined>();
  const [dropFeedback, setDropFeedback] = useState<
    { readonly target: NodeId; readonly feedback: ReparentFeedback } | undefined
  >();
  const panelIds = ids ?? createPanelIds("hierarchy");

  if (document.document === undefined) {
    return (
      <section className="panel" aria-label="Hierarchy">
        <h2>Hierarchy</h2>
        <p className="panel-empty">Open a document to edit the hierarchy.</p>
      </section>
    );
  }

  const root = document.document.nodes[document.document.rootNodeId];
  if (root === undefined) {
    return (
      <section className="panel" aria-label="Hierarchy">
        <h2>Hierarchy</h2>
        <p className="panel-empty">The document has no root node.</p>
      </section>
    );
  }

  const isSelected = (nodeId: NodeId): boolean =>
    editorState.selection.some(
      (entry) => entry.kind === "node" && entry.nodeId === nodeId,
    );

  const select = (nodeId: NodeId, modifiers: ToolModifiers): void => {
    editor.setSelection(
      applySelectionIntent(
        editorState.selection,
        { kind: "node", nodeId },
        modifiers,
      ),
    );
  };

  const commit = (
    commands: readonly import("@voxel-maker/commands").Command[],
    label: string,
  ): boolean => {
    const result = executeTransaction(session, panelIds, commands, label);
    if (!result.ok) {
      editor.pushNotice("error", result.message);
      return false;
    }
    return true;
  };

  const createChild = (parentId: NodeId): void => {
    if (document.document === undefined) return;
    const created = buildCreateChildCommand(
      panelIds.nextCommandId(),
      document.document,
      parentId,
    );
    if (commit([created.command], "Create node")) {
      setExpanded((previous) => new Set(previous).add(parentId));
      editor.setSelection([{ kind: "node", nodeId: created.nodeId }]);
    }
  };

  const startRename = (nodeId: NodeId): void => {
    const node = document.document?.nodes[nodeId];
    setRenaming(nodeId);
    setRenameText(node?.name ?? "");
  };

  const finishRename = (nodeId: NodeId): void => {
    setRenaming(undefined);
    if (document.document === undefined) return;
    const current = document.document.nodes[nodeId];
    const nextName = renameText.trim();
    if (
      current?.name === nextName ||
      (nextName === "" && current?.name === undefined)
    ) {
      return;
    }
    commit(
      [buildRenameCommand(panelIds.nextCommandId(), nodeId, nextName)],
      "Rename node",
    );
  };

  const remove = (nodeId: NodeId): void => {
    if (document.document === undefined) return;
    const feedback = deleteFeedback(document.document, nodeId);
    if (!feedback.ok) {
      editor.pushNotice("error", deleteReason(feedback.reason));
      return;
    }
    if (
      commit(
        [buildDeleteCommand(panelIds.nextCommandId(), nodeId)],
        "Delete node",
      )
    ) {
      editor.setSelection(
        editorState.selection.filter((entry) => {
          if (entry.kind !== "node") return true;
          if (document.document === undefined) return true;
          // Prune the deleted node and every descendant from the runtime
          // selection (plan S7.2).
          return !isAncestor(document.document, entry.nodeId, nodeId);
        }),
      );
    }
  };

  const onDragOver = (target: NodeId, event: React.DragEvent): void => {
    if (dragging === undefined || target === dragging) return;
    event.preventDefault();
    event.stopPropagation();
    const feedback =
      document.document === undefined
        ? ({ ok: false, reason: "missing-target" } as const)
        : reparentFeedback(document.document, dragging, target);
    setDropFeedback({ target, feedback });
  };

  const onDrop = (target: NodeId, event: React.DragEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    const dragged = dragging;
    setDragging(undefined);
    setDropFeedback(undefined);
    if (document.document === undefined || dragged === undefined) return;
    const command = buildReparentCommand(
      panelIds.nextCommandId(),
      document.document,
      dragged,
      target,
    );
    if (command === undefined) {
      const feedback = reparentFeedback(document.document, dragged, target);
      if (!feedback.ok) {
        editor.pushNotice(
          "error",
          REJECTION_LABELS[feedback.reason] ?? "Cannot drop the node here",
        );
      }
      return;
    }
    if (commit([command], "Reparent node")) {
      editor.setSelection([
        ...editorState.selection.filter(
          (entry) => entry.kind !== "node" || entry.nodeId !== dragged,
        ),
        { kind: "node", nodeId: dragged },
      ]);
    }
  };

  const renderNode = (nodeId: NodeId, depth: number): React.JSX.Element => {
    const node = document.document?.nodes[nodeId];
    if (node === undefined) return <Fragment key={nodeId} />;
    const selected = isSelected(nodeId);
    const hasChildren = node.children.length > 0;
    const isOpen = expanded.has(nodeId);
    const dropState =
      dropFeedback !== undefined && dropFeedback.target === nodeId
        ? dropFeedback.feedback
        : undefined;
    return (
      <div key={nodeId}>
        <div
          className={[
            "hierarchy-row",
            selected ? "selected" : undefined,
            dropState !== undefined && dropState.ok ? "drop-target" : undefined,
            dropState !== undefined && !dropState.ok
              ? "drop-invalid"
              : undefined,
          ]
            .filter(Boolean)
            .join(" ")}
          style={{ paddingLeft: `${String(depth * 14 + 6)}px` }}
          draggable={nodeId !== document.document?.rootNodeId}
          onClick={(event) => {
            select(nodeId, modifiersFrom(event));
          }}
          onDragStart={(event) => {
            if (nodeId === document.document?.rootNodeId) {
              event.preventDefault();
              return;
            }
            setDragging(nodeId);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", nodeId);
          }}
          onDragEnd={() => {
            setDragging(undefined);
            setDropFeedback(undefined);
          }}
          onDragOver={(event) => {
            onDragOver(nodeId, event);
          }}
          onDragLeave={() => {
            if (dropFeedback?.target === nodeId) setDropFeedback(undefined);
          }}
          onDrop={(event) => {
            onDrop(nodeId, event);
          }}
        >
          {hasChildren ? (
            <button
              type="button"
              className="hierarchy-toggle"
              aria-label={isOpen ? "Collapse" : "Expand"}
              onClick={(event) => {
                event.stopPropagation();
                setExpanded((previous) => {
                  const next = new Set(previous);
                  if (isOpen) {
                    next.delete(nodeId);
                  } else {
                    next.add(nodeId);
                  }
                  return next;
                });
              }}
            >
              {isOpen ? "▾" : "▸"}
            </button>
          ) : (
            <span className="hierarchy-toggle" aria-hidden="true" />
          )}
          {renaming === nodeId ? (
            <input
              className="hierarchy-rename"
              value={renameText}
              autoFocus
              onChange={(event) => {
                setRenameText(event.target.value);
              }}
              onBlur={() => {
                finishRename(nodeId);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") finishRename(nodeId);
                if (event.key === "Escape") setRenaming(undefined);
              }}
              onClick={(event) => {
                event.stopPropagation();
              }}
            />
          ) : (
            <span className="hierarchy-name" title={node.name ?? nodeId}>
              {node.name ?? "(unnamed)"}
            </span>
          )}
          <span className="hierarchy-actions">
            <button
              type="button"
              title="Add child node"
              onClick={(event) => {
                event.stopPropagation();
                createChild(nodeId);
              }}
            >
              ＋
            </button>
            <button
              type="button"
              title="Rename"
              onClick={(event) => {
                event.stopPropagation();
                startRename(nodeId);
              }}
            >
              ✎
            </button>
            {nodeId !== document.document?.rootNodeId ? (
              <button
                type="button"
                title="Delete node"
                onClick={(event) => {
                  event.stopPropagation();
                  remove(nodeId);
                }}
              >
                ✕
              </button>
            ) : null}
          </span>
          {dropState !== undefined && !dropState.ok ? (
            <span className="hierarchy-drop-reason">
              {REJECTION_LABELS[dropState.reason] ?? "Cannot drop here"}
            </span>
          ) : null}
        </div>
        {isOpen ? (
          <div className="hierarchy-children">
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <section className="panel" aria-label="Hierarchy">
      <h2>
        Hierarchy
        <button
          type="button"
          className="panel-action"
          title="Add child to root"
          onClick={() => {
            const rootNodeId = document.document?.rootNodeId;
            if (rootNodeId !== undefined) createChild(rootNodeId);
          }}
        >
          ＋ Root child
        </button>
      </h2>
      <div
        className="hierarchy-tree"
        onDragOver={(event) => {
          // Allow the panel background to receive the drop so it can
          // report a missing target instead of silently swallowing it.
          event.preventDefault();
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (dragging === undefined) return;
          const dragged = dragging;
          setDragging(undefined);
          setDropFeedback(undefined);
          if (document.document === undefined) return;
          const feedback = reparentFeedback(
            document.document,
            dragged,
            undefined,
          );
          if (!feedback.ok) {
            editor.pushNotice(
              "error",
              feedback.reason === "missing-target"
                ? "Drop the node onto a hierarchy row to reparent it"
                : (REJECTION_LABELS[feedback.reason] ??
                    "Cannot drop the node here"),
            );
          }
        }}
      >
        {renderNode(document.document.rootNodeId, 0)}
      </div>
    </section>
  );
}

function modifiersFrom(event: React.MouseEvent): ToolModifiers {
  return { additive: event.shiftKey, toggle: event.ctrlKey || event.metaKey };
}

function deleteReason(
  reason: Extract<DeleteFeedback, { ok: false }>["reason"],
): string {
  switch (reason) {
    case "root":
      return "The document root cannot be deleted";
    case "has-children":
      return "Delete or reparent the node's children first";
    case "referenced":
      return "The node is referenced by an animation track and cannot be deleted";
    case "missing-node":
      return "The node no longer exists";
    default:
      return "The node cannot be deleted";
  }
}
