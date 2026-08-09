import { useState } from "react";
import { volumeId } from "@voxel-maker/shared";
import type { DocumentSession } from "@voxel-maker/session";
import {
  buildAddJointCommand,
  buildRemoveJointCommand,
  buildRemovePivotCommand,
  buildSetComponentsCommand,
  buildSetMetadataCommand,
  buildSetPivotCommand,
  buildSetTransformFieldCommands,
  formatMetadata,
  formatRotationDegrees,
  formatVec3,
  parseRotationDegreesInput,
  parseScaleInput,
  parseVec3Input,
  transformFieldValue,
  transformRotationValue,
  type EditorStore,
  type TransformField,
} from "@voxel-maker/editor";
import type { Quat, Transform } from "@voxel-maker/math";
import type { Component, SceneNode, VoxelDocument } from "@voxel-maker/model";
import {
  createPanelIds,
  executeTransaction,
  useDocument,
  useEditorStore,
  type PanelIds,
} from "./panel-utils.js";

/**
 * Inspector panel (plan S7.12, ticket #20): edits validated transforms,
 * components, and bounded metadata with mixed multi-selection states.
 * Every edit is parsed here, committed as one labeled transaction through
 * the session bus, and surfaced as a notice on rejection — the panel
 * never encodes domain invariants itself.
 */

export interface InspectorPanelProps {
  readonly session: DocumentSession;
  readonly editor: EditorStore;
  /** Shared panel id sequence (created once by the composition root). */
  readonly ids?: PanelIds;
}

const FIELDS: readonly {
  readonly field: TransformField;
  readonly label: string;
}[] = [
  { field: "translation", label: "Position" },
  { field: "rotation", label: "Rotation" },
  { field: "scale", label: "Scale" },
  { field: "pivot", label: "Pivot" },
];

export function InspectorPanel({
  session,
  editor,
  ids,
}: InspectorPanelProps): React.JSX.Element {
  const document = useDocument(session);
  const editorState = useEditorStore(editor);
  const panelIds = ids ?? createPanelIds("inspector");

  const nodeIds = editorState.selection
    .filter(
      (entry): entry is Extract<typeof entry, { readonly kind: "node" }> =>
        entry.kind === "node",
    )
    .map((entry) => entry.nodeId);

  if (document.document === undefined) {
    return (
      <section className="panel" aria-label="Inspector">
        <h2>Inspector</h2>
        <p className="panel-empty">Open a document to inspect nodes.</p>
      </section>
    );
  }

  const nodes = nodeIds
    .map((id) => document.document?.nodes[id])
    .filter((node): node is SceneNode => node !== undefined);

  if (nodes.length === 0) {
    return (
      <section className="panel" aria-label="Inspector">
        <h2>Inspector</h2>
        <p className="panel-empty">
          Select a node to edit its transform, components, and metadata.
        </p>
      </section>
    );
  }

  const transforms = nodes.map((node) => node.transform);
  const single = nodes.length === 1 ? (nodes[0] as SceneNode) : undefined;

  const commitTransform = (field: TransformField, text: string): void => {
    try {
      const value =
        field === "rotation"
          ? parseRotationDegreesInput(text)
          : field === "scale"
            ? parseScaleInput(text)
            : parseVec3Input(text, field);
      const commands = buildSetTransformFieldCommands(
        () => panelIds.nextCommandId(),
        nodes.map((node) => ({
          nodeId: node.nodeId,
          transform: node.transform,
        })),
        field,
        value,
      );
      const result = executeTransaction(
        session,
        panelIds,
        commands,
        "Edit transform",
      );
      if (!result.ok) editor.pushNotice("error", result.message);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid inspector input";
      editor.pushNotice("error", message);
    }
  };

  /**
   * Commits one `node.setComponents` transaction applying `change` to
   * every selected node (mixed multi-selection, plan S7.12): each node's
   * component list transforms independently.
   */
  const applyComponentChange = (
    change: (components: readonly Component[]) => readonly Component[],
    label: string,
  ): void => {
    const commands = nodes.flatMap((node) => {
      const components = change(node.components);
      if (
        components.length === node.components.length &&
        components.every(
          (component, index) => component === node.components[index],
        )
      ) {
        return [];
      }
      return [
        buildSetComponentsCommand(
          panelIds.nextCommandId(),
          node.nodeId,
          components,
        ),
      ];
    });
    const result = executeTransaction(session, panelIds, commands, label);
    if (!result.ok) editor.pushNotice("error", result.message);
  };

  const addComponent = (component: Component): void => {
    if (component.kind === "pivot" || component.kind === "joint") {
      // Singleton articulation components use the per-discriminant
      // lifecycle commands (plan S9.3, ticket #26): one command per
      // selected node that does not already carry the component.
      const missing = nodes.filter(
        (node) =>
          !node.components.some((entry) => entry.kind === component.kind),
      );
      if (missing.length < nodes.length) {
        editor.pushNotice(
          "warning",
          `Some selected nodes already have a ${component.kind} component; they were left unchanged`,
        );
      }
      const commands = missing.map((node) =>
        component.kind === "pivot"
          ? buildSetPivotCommand(
              panelIds.nextCommandId(),
              node.nodeId,
              component.pivot,
            )
          : buildAddJointCommand(panelIds.nextCommandId(), node.nodeId),
      );
      const result = executeTransaction(
        session,
        panelIds,
        commands,
        "Add component",
      );
      if (!result.ok) editor.pushNotice("error", result.message);
      return;
    }
    let warned = false;
    applyComponentChange((components) => {
      if (components.some((existing) => existing.kind === component.kind)) {
        if (!warned) {
          warned = true;
          editor.pushNotice(
            "warning",
            `Some selected nodes already have a ${component.kind} component; they were left unchanged`,
          );
        }
        return components;
      }
      return [...components, component];
    }, "Add component");
  };

  const removeComponent = (kind: Component["kind"]): void => {
    if (kind === "pivot" || kind === "joint") {
      const commands = nodes.map((node) =>
        kind === "pivot"
          ? buildRemovePivotCommand(panelIds.nextCommandId(), node.nodeId)
          : buildRemoveJointCommand(panelIds.nextCommandId(), node.nodeId),
      );
      const result = executeTransaction(
        session,
        panelIds,
        commands,
        "Remove component",
      );
      if (!result.ok) editor.pushNotice("error", result.message);
      return;
    }
    applyComponentChange(
      (components) => components.filter((entry) => entry.kind !== kind),
      "Remove component",
    );
  };

  /** Replaces one component on every selected node that has it. */
  const updateComponent = (kind: Component["kind"], patch: Component): void => {
    if (kind === "pivot" && patch.kind === "pivot") {
      const commands = nodes
        .filter((node) =>
          node.components.some((entry) => entry.kind === "pivot"),
        )
        .map((node) =>
          buildSetPivotCommand(
            panelIds.nextCommandId(),
            node.nodeId,
            patch.pivot,
          ),
        );
      const result = executeTransaction(
        session,
        panelIds,
        commands,
        "Edit component",
      );
      if (!result.ok) editor.pushNotice("error", result.message);
      return;
    }
    applyComponentChange(
      (components) =>
        components.map((entry) => (entry.kind === kind ? patch : entry)),
      "Edit component",
    );
  };

  return (
    <section className="panel" aria-label="Inspector">
      <h2>Inspector</h2>
      <p className="inspector-selection">
        {nodes.length === 1
          ? (single?.name ?? "(unnamed)")
          : `${String(nodes.length)} nodes selected`}
      </p>

      <h3>Transform</h3>
      <div className="inspector-fields">
        {FIELDS.map(({ field, label }) => (
          <TransformFieldInput
            key={field}
            label={label}
            transforms={transforms}
            field={field}
            revision={document.revision}
            onCommit={(text) => {
              commitTransform(field, text);
            }}
          />
        ))}
      </div>

      <h3>Components</h3>
      {single === undefined ? (
        <p className="panel-empty">
          Showing the first selected node; add/remove/update applies to all{" "}
          {String(nodes.length)} selected nodes.
        </p>
      ) : null}
      {single !== undefined && single.components.length === 0 ? (
        <p className="panel-empty">No components.</p>
      ) : single !== undefined ? (
        <ul className="component-list">
          {single.components.map((component, index) => (
            <li
              key={`${component.kind}-${String(index)}`}
              className="component-row"
            >
              <span className="component-kind">{component.kind}</span>
              <ComponentValueEditor
                document={document.document as VoxelDocument}
                component={component}
                onUpdate={(patch) => {
                  updateComponent(component.kind, patch);
                }}
                onError={(message) => {
                  editor.pushNotice("error", message);
                }}
              />
              <button
                type="button"
                title="Remove component"
                onClick={() => {
                  removeComponent(component.kind);
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="panel-empty">No components.</p>
      )}
      <div className="component-add">
        <VoxelComponentAdd
          document={document.document}
          onAdd={(component) => {
            addComponent(component);
          }}
        />
        <button
          type="button"
          onClick={() => {
            addComponent({ kind: "joint", schemaVersion: 1 });
          }}
        >
          ＋ Joint
        </button>
        <button
          type="button"
          onClick={() => {
            addComponent({
              kind: "pivot",
              schemaVersion: 1,
              pivot: [0, 0, 0],
            });
          }}
        >
          ＋ Pivot
        </button>
      </div>

      <h3>Metadata</h3>
      <MetadataEditor
        key={`${nodes.map((node) => node.nodeId).join(",")}:${String(
          document.revision,
        )}`}
        nodes={nodes}
        onCommit={(text) => {
          try {
            const commands = nodes.map((node) =>
              buildSetMetadataCommand(
                panelIds.nextCommandId(),
                node.nodeId,
                text,
              ),
            );
            const result = executeTransaction(
              session,
              panelIds,
              commands,
              "Edit metadata",
            );
            if (!result.ok) editor.pushNotice("error", result.message);
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Invalid metadata";
            editor.pushNotice("error", message);
          }
        }}
      />
    </section>
  );
}

function TransformFieldInput({
  label,
  transforms,
  field,
  revision,
  onCommit,
}: {
  readonly label: string;
  readonly transforms: readonly Transform[];
  readonly field: TransformField;
  /** Bumped per commit so stale drafts reset with the document. */
  readonly revision: number;
  onCommit: (text: string) => void;
}): React.JSX.Element {
  const rotation = field === "rotation";
  const resolved = rotation
    ? transformRotationValue(transforms)
    : transformFieldValue(transforms, field);
  const initial =
    resolved.kind === "value"
      ? rotation
        ? formatRotationDegrees(resolved.value as Quat)
        : formatVec3(resolved.value as [number, number, number])
      : "";
  return (
    <label className="inspector-field">
      <span className="inspector-field-label">{label}</span>
      <input
        defaultValue={initial}
        key={`${field}:${String(revision)}:${initial}`}
        placeholder={
          resolved.kind === "mixed" ? "Mixed — edits apply to all" : undefined
        }
        onBlur={(event) => {
          if (event.target.value !== initial) onCommit(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            const target = event.target as HTMLInputElement;
            if (target.value !== initial) onCommit(target.value);
            target.blur();
          }
          if (event.key === "Escape") {
            (event.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}

/**
 * In-place component value editor (plan S7.12): pivot vectors and voxel
 * volume ids are editable text; joint and constraint components are
 * read-only summaries. Commits through `onUpdate` apply to every selected
 * node that carries the component kind.
 */
function ComponentValueEditor({
  document,
  component,
  onUpdate,
  onError,
}: {
  readonly document: VoxelDocument;
  readonly component: Component;
  onUpdate: (patch: Component) => void;
  onError: (message: string) => void;
}): React.JSX.Element {
  const [text, setText] = useState(initialValue(component));
  const commit = (): void => {
    try {
      if (component.kind === "pivot") {
        const pivot = parseVec3Input(text, "pivot");
        onUpdate({ kind: "pivot", schemaVersion: 1, pivot });
      } else if (component.kind === "voxel") {
        const id = text.trim();
        if (document.volumes[id as never] === undefined) {
          onError("The volume does not exist");
          return;
        }
        onUpdate({ kind: "voxel", schemaVersion: 1, volumeId: volumeId(id) });
      }
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid component value";
      onError(message);
    }
  };
  switch (component.kind) {
    case "voxel":
      return (
        <input
          className="component-value"
          value={text}
          list="inspector-volume-ids"
          title="Volume id"
          onChange={(event) => {
            setText(event.target.value);
          }}
          onBlur={() => {
            if (text !== component.volumeId) commit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              (event.target as HTMLInputElement).blur();
            }
            if (event.key === "Escape") {
              setText(component.volumeId);
              (event.target as HTMLInputElement).blur();
            }
          }}
          aria-label="Volume id"
        />
      );
    case "pivot":
      return (
        <input
          className="component-value"
          value={text}
          title="Pivot x, y, z"
          onChange={(event) => {
            setText(event.target.value);
          }}
          onBlur={() => {
            if (text !== formatVec3(component.pivot)) commit();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              (event.target as HTMLInputElement).blur();
            }
            if (event.key === "Escape") {
              setText(formatVec3(component.pivot));
              (event.target as HTMLInputElement).blur();
            }
          }}
          aria-label="Pivot"
        />
      );
    case "joint":
      return <span className="component-summary">joint</span>;
    case "constraint":
      return (
        <span className="component-summary">
          {String(component.constraints.length)} constraint(s)
        </span>
      );
  }
}

function initialValue(component: Component): string {
  switch (component.kind) {
    case "voxel":
      return component.volumeId;
    case "pivot":
      return formatVec3(component.pivot);
    case "joint":
    case "constraint":
      return "";
  }
}

function VoxelComponentAdd({
  document,
  onAdd,
}: {
  readonly document: VoxelDocument;
  onAdd: (component: Component) => void;
}): React.JSX.Element {
  const [volumeText, setVolumeText] = useState("");
  const volumeIds = Object.keys(document.volumes);
  if (volumeIds.length === 0) {
    return (
      <span className="component-add-voxel">
        <button type="button" disabled title="The document has no volumes">
          ＋ Voxel
        </button>
      </span>
    );
  }
  return (
    <span className="component-add-voxel">
      <input
        list="inspector-volume-ids"
        placeholder="volume id"
        value={volumeText}
        onChange={(event) => {
          setVolumeText(event.target.value);
        }}
      />
      <datalist id="inspector-volume-ids">
        {volumeIds.map((id) => (
          <option key={id} value={id} />
        ))}
      </datalist>
      <button
        type="button"
        onClick={() => {
          const id = volumeText.trim();
          if (document.volumes[id as never] === undefined) return;
          onAdd({ kind: "voxel", schemaVersion: 1, volumeId: volumeId(id) });
          setVolumeText("");
        }}
      >
        ＋ Voxel
      </button>
    </span>
  );
}

function MetadataEditor({
  nodes,
  onCommit,
}: {
  readonly nodes: readonly SceneNode[];
  onCommit: (text: string) => void;
}): React.JSX.Element {
  // Shared metadata when every selected node carries the identical
  // record; otherwise the editor starts empty with a mixed placeholder.
  const first = nodes[0]?.metadata;
  const shared =
    first !== undefined &&
    nodes.every(
      (node) =>
        node.metadata !== undefined &&
        formatMetadata(node.metadata) === formatMetadata(first),
    );
  const initial = shared ? formatMetadata(first as never) : "";
  const [text, setText] = useState(initial);
  const placeholder =
    nodes.length > 1 && !shared
      ? "Mixed — edits apply to all selected nodes"
      : "{} — JSON object; empty removes metadata";
  return (
    <textarea
      className="inspector-metadata"
      rows={6}
      spellCheck={false}
      value={text}
      placeholder={placeholder}
      onChange={(event) => {
        setText(event.target.value);
      }}
      onBlur={() => {
        if (text !== initial) onCommit(text);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setText(initial);
          (event.target as HTMLTextAreaElement).blur();
        }
      }}
    />
  );
}
