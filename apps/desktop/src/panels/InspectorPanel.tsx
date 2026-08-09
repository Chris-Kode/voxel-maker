import { useState } from "react";
import { volumeId, type ComponentId } from "@voxel-maker/shared";
import { rotationLimitsEqual, type Command } from "@voxel-maker/commands";
import type { DocumentSession } from "@voxel-maker/session";
import {
  buildAddConstraintCommand,
  buildAddJointCommand,
  buildRemoveConstraintCommand,
  buildRemoveJointCommand,
  buildRemovePivotCommand,
  buildReorderConstraintCommand,
  buildSetComponentsCommand,
  buildSetConstraintCommand,
  buildSetMetadataCommand,
  buildSetPivotCommand,
  buildSetTransformFieldCommands,
  constraintRuntimeRotationDegrees,
  formatMetadata,
  formatNumber,
  formatRotationDegrees,
  formatVec3,
  parseLimitsDegreesInput,
  parseRotationDegreesInput,
  parseScaleInput,
  parseVec3Input,
  transformFieldValue,
  transformRotationValue,
  type EditorStore,
  type TransformField,
} from "@voxel-maker/editor";
import type { Quat, Transform, Vec3 } from "@voxel-maker/math";
import type {
  Component,
  ConstraintComponent,
  ConstraintDescriptor,
  RotationLimits,
  SceneNode,
  VoxelDocument,
} from "@voxel-maker/model";
import {
  createPanelIds,
  executeTransaction,
  PANEL_FOCUS_IDS,
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
  /**
   * Auto-key augmentation (plan S10.12, ticket #29): when the timeline is
   * in auto-key mode, transform field edits also write keys into the
   * selected clip, so "transform changes target base or selected clip"
   * stays true for every transform edit surface.
   */
  readonly transformAugment?: (
    commands: readonly Command[],
  ) => readonly Command[];
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
  transformAugment,
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
      <section
        className="panel"
        aria-label="Inspector"
        id={PANEL_FOCUS_IDS.inspector}
        tabIndex={-1}
      >
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
      <section
        className="panel"
        aria-label="Inspector"
        id={PANEL_FOCUS_IDS.inspector}
        tabIndex={-1}
      >
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
      const commands = [
        ...buildSetTransformFieldCommands(
          () => panelIds.nextCommandId(),
          nodes.map((node) => ({
            nodeId: node.nodeId,
            transform: node.transform,
          })),
          field,
          value,
        ),
        // The pivot annotation mirrors transform.pivot (plan S9.3, ticket
        // #26): editing the transform pivot also moves the declared
        // articulation point on nodes that carry the annotation.
        ...(field === "pivot"
          ? nodes
              .filter((node) =>
                node.components.some((entry) => entry.kind === "pivot"),
              )
              .map((node) =>
                buildSetPivotCommand(
                  panelIds.nextCommandId(),
                  node.nodeId,
                  value as [number, number, number],
                ),
              )
          : []),
      ];
      // Auto-key (plan S10.12): pivot edits are never animated in v1, so
      // only the transform field edits can write keys into the clip.
      const augmented =
        transformAugment !== undefined && field !== "pivot"
          ? transformAugment(commands)
          : commands;
      const result = executeTransaction(
        session,
        panelIds,
        augmented,
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
          ? // Initialize the annotation from the node's current transform
            // pivot so declaring articulation never rewinds geometry.
            buildSetPivotCommand(
              panelIds.nextCommandId(),
              node.nodeId,
              node.transform.pivot,
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
    <section
      className="panel"
      aria-label="Inspector"
      id={PANEL_FOCUS_IDS.inspector}
      tabIndex={-1}
    >
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

      {single !== undefined ? (
        <ConstraintEditor
          key={`constraints:${single.nodeId}:${String(document.revision)}`}
          node={single}
          document={document.document}
          ids={panelIds}
          session={session}
          editor={editor}
        />
      ) : null}

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

/** Default limits for a newly added constraint: +-90 degrees per axis. */
const DEFAULT_CONSTRAINT_LIMITS: RotationLimits = {
  min: [-Math.PI / 2, -Math.PI / 2, -Math.PI / 2],
  max: [Math.PI / 2, Math.PI / 2, Math.PI / 2],
};

/**
 * Constraint editor (plan S9.7, ticket #27): ordered local Euler
 * rotation limits of the single selected node with per-axis degree
 * editing, removal, and up/down reordering, plus the constrained runtime
 * rotation the viewport renders. Shown for every single-node selection
 * so the first constraint can be added from the UI; every edit is one
 * labeled transaction through the session bus and validation feedback
 * surfaces as notices.
 */
function ConstraintEditor({
  node,
  document,
  ids,
  session,
  editor,
}: {
  readonly node: SceneNode;
  readonly document: VoxelDocument;
  readonly ids: PanelIds;
  readonly session: DocumentSession;
  readonly editor: EditorStore;
}): React.JSX.Element {
  const holder = node.components.find(
    (component): component is ConstraintComponent =>
      component.kind === "constraint",
  );
  const runtime = constraintRuntimeRotationDegrees(document, node.nodeId);
  const add = (): void => {
    const command = buildAddConstraintCommand(
      ids.nextCommandId(),
      node.nodeId,
      ids.nextComponentId(),
      DEFAULT_CONSTRAINT_LIMITS,
      null,
    );
    const result = executeTransaction(
      session,
      ids,
      [command],
      "Add constraint",
    );
    if (!result.ok) editor.pushNotice("error", result.message);
  };
  return (
    <section className="constraint-editor" aria-label="Rotation constraints">
      <h3>Constraints</h3>
      <p className="panel-empty">
        Local Euler XYZ rotation limits in degrees, applied in order (top first)
        after the authored rotation; the document never changes.
      </p>
      {holder === undefined || holder.constraints.length === 0 ? (
        <p className="panel-empty">No constraints yet.</p>
      ) : (
        <ul className="component-list">
          {holder.constraints.map((constraint, index) => (
            <ConstraintRow
              key={String(constraint.componentId)}
              node={node}
              holder={holder}
              constraint={constraint}
              index={index}
              ids={ids}
              session={session}
              editor={editor}
            />
          ))}
        </ul>
      )}
      <div className="component-add">
        <button type="button" onClick={add}>
          ＋ Constraint
        </button>
      </div>
      {runtime !== undefined ? (
        <p className="constraint-runtime">
          Runtime rotation: {formatVec3(roundDegrees(runtime))}° (authored:{" "}
          {formatRotationDegrees(node.transform.rotation)}°)
        </p>
      ) : null}
    </section>
  );
}

/** The six editable degree values of one constraint, ordered minX..maxZ. */
const CONSTRAINT_FIELDS = [
  { label: "min X", index: 0 },
  { label: "max X", index: 3 },
  { label: "min Y", index: 1 },
  { label: "max Y", index: 4 },
  { label: "min Z", index: 2 },
  { label: "max Z", index: 5 },
] as const;

function limitsToText(limits: RotationLimits): readonly string[] {
  const toDegrees = (value: number): string =>
    formatNumber((value * 180) / Math.PI);
  return [
    toDegrees(limits.min[0]),
    toDegrees(limits.min[1]),
    toDegrees(limits.min[2]),
    toDegrees(limits.max[0]),
    toDegrees(limits.max[1]),
    toDegrees(limits.max[2]),
  ];
}

function ConstraintRow({
  node,
  holder,
  constraint,
  index,
  ids,
  session,
  editor,
}: {
  readonly node: SceneNode;
  readonly holder: ConstraintComponent;
  readonly constraint: ConstraintDescriptor;
  readonly index: number;
  readonly ids: PanelIds;
  readonly session: DocumentSession;
  readonly editor: EditorStore;
}): React.JSX.Element {
  const [values, setValues] = useState<readonly string[]>(() =>
    limitsToText(constraint.limits),
  );
  const commit = (): void => {
    try {
      const limits = parseLimitsDegreesInput(values.join(", "), "constraint");
      if (rotationLimitsEqual(limits, constraint.limits)) return;
      const command = buildSetConstraintCommand(
        ids.nextCommandId(),
        node.nodeId,
        constraint.componentId,
        limits,
      );
      const result = executeTransaction(
        session,
        ids,
        [command],
        "Edit constraint",
      );
      if (!result.ok) editor.pushNotice("error", result.message);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Invalid constraint limits";
      editor.pushNotice("error", message);
    }
  };
  const reset = (): void => {
    setValues(limitsToText(constraint.limits));
  };
  const reorder = (before: ComponentId | null): void => {
    const command = buildReorderConstraintCommand(
      ids.nextCommandId(),
      node.nodeId,
      constraint.componentId,
      before,
    );
    const result = executeTransaction(
      session,
      ids,
      [command],
      "Reorder constraint",
    );
    if (!result.ok) editor.pushNotice("error", result.message);
  };
  const remove = (): void => {
    const command = buildRemoveConstraintCommand(
      ids.nextCommandId(),
      node.nodeId,
      constraint.componentId,
    );
    const result = executeTransaction(
      session,
      ids,
      [command],
      "Remove constraint",
    );
    if (!result.ok) editor.pushNotice("error", result.message);
  };
  const previous = holder.constraints[index - 1];
  const next = holder.constraints[index + 1];
  return (
    <li className="component-row constraint-row">
      <span className="component-kind">limits</span>
      <div className="constraint-limits">
        {CONSTRAINT_FIELDS.map(({ label, index: fieldIndex }) => (
          <label key={label}>
            <span>{label}</span>
            <input
              value={values[fieldIndex] ?? ""}
              aria-label={`${label} (degrees)`}
              onChange={(event) => {
                const nextValues = [...values];
                nextValues[fieldIndex] = event.target.value;
                setValues(nextValues);
              }}
              onBlur={() => {
                if (
                  values.join(",") !== limitsToText(constraint.limits).join(",")
                )
                  commit();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  commit();
                  (event.target as HTMLInputElement).blur();
                }
                if (event.key === "Escape") {
                  reset();
                  (event.target as HTMLInputElement).blur();
                }
              }}
            />
          </label>
        ))}
      </div>
      <button
        type="button"
        title="Move constraint up (earlier in order)"
        disabled={index === 0}
        onClick={() => {
          reorder(previous?.componentId ?? null);
        }}
      >
        ↑
      </button>
      <button
        type="button"
        title="Move constraint down (later in order)"
        disabled={index === holder.constraints.length - 1}
        onClick={() => {
          // Moving down one slot means inserting before the constraint
          // two slots ahead (or appending at the end for the last slot).
          reorder(
            next === undefined
              ? null
              : (holder.constraints[index + 2]?.componentId ?? null),
          );
        }}
      >
        ↓
      </button>
      <button type="button" title="Remove constraint" onClick={remove}>
        ✕
      </button>
    </li>
  );
}

/** Rounds degree display values like the inspector's other fields. */
function roundDegrees(value: Vec3): Vec3 {
  const round = (number: number): number => Math.round(number * 1e4) / 1e4;
  return [round(value[0]), round(value[1]), round(value[2])];
}
