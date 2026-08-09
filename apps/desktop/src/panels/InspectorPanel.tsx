import { useState } from "react";
import { volumeId, type NodeId } from "@voxel-maker/shared";
import type { DocumentSession } from "@voxel-maker/session";
import {
  buildSetComponentsCommand,
  buildSetMetadataCommand,
  buildSetTransformFieldCommands,
  formatMetadata,
  formatRotationDegrees,
  formatVec3,
  parseRotationDegreesInput,
  parseScaleInput,
  parseVec3Input,
  transformFieldValue,
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
        nodes.map((node) => ({ nodeId: node.nodeId, transform: node.transform })),
        field,
        value,
      );
      const result = executeTransaction(session, panelIds, commands, "Edit transform");
      if (!result.ok) editor.pushNotice("error", result.message);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid inspector input";
      editor.pushNotice("error", message);
    }
  };

  const setComponents = (components: readonly Component[]): void => {
    if (single === undefined) return;
    const command = buildSetComponentsCommand(
      panelIds.nextCommandId(),
      single.nodeId,
      components,
    );
    const result = executeTransaction(session, panelIds, [command], "Edit components");
    if (!result.ok) editor.pushNotice("error", result.message);
  };

  const addComponent = (component: Component): void => {
    if (single === undefined) return;
    if (single.components.some((existing) => existing.kind === component.kind)) {
      editor.pushNotice("warning", `The node already has a ${component.kind} component`);
      return;
    }
    setComponents([...single.components, component]);
  };

  const removeComponent = (index: number): void => {
    if (single === undefined) return;
    setComponents(single.components.filter((_, entry) => entry !== index));
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
          Component edits apply to one node; select a single node.
        </p>
      ) : single.components.length === 0 ? (
        <p className="panel-empty">No components.</p>
      ) : (
        <ul className="component-list">
          {single.components.map((component, index) => (
            <li key={`${component.kind}-${String(index)}`} className="component-row">
              <span className="component-kind">{component.kind}</span>
              <span className="component-summary">
                <ComponentSummary
                  document={document.document as VoxelDocument}
                  component={component}
                />
              </span>
              <button
                type="button"
                title="Remove component"
                onClick={() => {
                  removeComponent(index);
                }}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {single !== undefined ? (
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
      ) : null}

      <h3>Metadata</h3>
      {single === undefined ? (
        <p className="panel-empty">
          Metadata edits apply to one node; select a single node.
        </p>
      ) : (
        <MetadataEditor
          key={`${String(single.nodeId)}:${String(document.revision)}`}
          document={document.document}
          nodeId={single.nodeId}
          onCommit={(text) => {
            try {
              const command = buildSetMetadataCommand(
                panelIds.nextCommandId(),
                single.nodeId,
                text,
              );
              const result = executeTransaction(session, panelIds, [command], "Edit metadata");
              if (!result.ok) editor.pushNotice("error", result.message);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Invalid metadata";
              editor.pushNotice("error", message);
            }
          }}
        />
      )}
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
  const resolved = transformFieldValue(transforms, field);
  const initial =
    resolved.kind === "value"
      ? field === "rotation"
        ? formatRotationDegrees(resolved.value as unknown as Quat)
        : formatVec3(resolved.value)
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

function ComponentSummary({
  document,
  component,
}: {
  readonly document: VoxelDocument;
  readonly component: Component;
}): React.JSX.Element {
  switch (component.kind) {
    case "voxel": {
      const volume = document.volumes[component.volumeId];
      return <span>volume {volume?.volumeId ?? component.volumeId}</span>;
    }
    case "pivot":
      return <span>pivot {formatVec3(component.pivot)}</span>;
    case "joint":
      return <span>joint</span>;
    case "constraint":
      return <span>{String(component.constraints.length)} constraint(s)</span>;
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
  document,
  nodeId,
  onCommit,
}: {
  readonly document: VoxelDocument;
  readonly nodeId: NodeId;
  onCommit: (text: string) => void;
}): React.JSX.Element {
  const node = document.nodes[nodeId];
  const initial = node?.metadata === undefined ? "" : formatMetadata(node.metadata);
  const [text, setText] = useState(initial);
  return (
    <textarea
      className="inspector-metadata"
      rows={6}
      spellCheck={false}
      value={text}
      placeholder="{} — JSON object; empty removes metadata"
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
