import { useEffect, useRef, useState } from "react";
import { materialId, type MaterialId } from "@voxel-maker/shared";
import type {
  MaterialPanelController,
  MaterialPanelEntry,
  MaterialPanelState,
} from "./material-panel-controller.js";

/**
 * Materials panel (plan S7.13, ticket #21): the desktop view over
 * `MaterialPanelController`. The controller compiles every edit — name,
 * canonical color, opacity, roughness, metallic, emissive, create, and
 * referenced delete with reassignment — into the registered `material.*`
 * commands and commits through the session bus; this component only
 * renders the committed snapshot and forwards gestures. Fields commit on
 * blur (or release for sliders) so one user edit is one undoable history
 * entry, and rejected commands surface as runtime notices with the
 * committed values restored on the next refresh.
 */

/** Subscribes to the panel controller for the shell chrome. */
export function usePanelState(
  controller: MaterialPanelController,
): MaterialPanelState {
  const [state, setState] = useState(() => controller.state);
  useEffect(
    () =>
      controller.subscribe(() => {
        setState(controller.state);
      }),
    [controller],
  );
  return state;
}

export function MaterialPanel({
  controller,
}: {
  readonly controller: MaterialPanelController;
}): React.JSX.Element {
  const state = usePanelState(controller);
  return (
    <section
      className="material-panel"
      aria-label="Materials panel"
      id="panel-materials"
      tabIndex={-1}
    >
      <header className="material-panel-header">
        <h2>Materials</h2>
        <button
          type="button"
          disabled={!state.canCreate}
          title={
            state.canCreate
              ? "Create a new material"
              : "The document has reached its material limit"
          }
          onClick={() => {
            controller.createMaterial();
          }}
        >
          Add
        </button>
      </header>
      {state.entries.length === 0 ? (
        <p className="material-panel-empty">
          No materials yet — click Add to create one, or sample a voxel with the
          Eyedropper.
        </p>
      ) : (
        <ul className="material-list">
          {state.entries.map((entry) => (
            <MaterialRow
              key={String(entry.record.materialId)}
              entry={entry}
              controller={controller}
              active={state.activeMaterial === entry.record.materialId}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function MaterialRow({
  entry,
  controller,
  active,
}: {
  readonly entry: MaterialPanelEntry;
  readonly controller: MaterialPanelController;
  readonly active: boolean;
}): React.JSX.Element {
  const record = entry.record;
  const [name, setName] = useState(record.name);
  const [color, setColor] = useState<string>(record.color);
  const [opacity, setOpacity] = useState(record.opacity);
  const [roughness, setRoughness] = useState(record.roughness);
  const [metallic, setMetallic] = useState(record.metallic);
  const [emissive, setEmissive] = useState(record.emissive);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [replacement, setReplacement] = useState("");
  /** Reassignment choices, fetched lazily when the delete is armed. */
  const [candidates, setCandidates] = useState<readonly MaterialId[]>([]);
  // Fields the user is currently editing: the resync below skips them so
  // an unrelated commit (for example a viewport stroke) cannot wipe an
  // in-progress draft.
  const focusedRef = useRef<Set<string>>(new Set());

  // Resync drafts with the committed record after external changes
  // (commits, undo, redo, lifecycle replacement), except for fields the
  // user is actively editing.
  useEffect(() => {
    const focused = focusedRef.current;
    if (!focused.has("name")) setName(record.name);
    if (!focused.has("color")) setColor(record.color);
    if (!focused.has("opacity")) setOpacity(record.opacity);
    if (!focused.has("roughness")) setRoughness(record.roughness);
    if (!focused.has("metallic")) setMetallic(record.metallic);
    if (!focused.has("emissive")) setEmissive(record.emissive);
    setDeleteArmed(false);
  }, [record]);

  const referenced = entry.usage > 0;
  const canReassign = referenced && candidates.length > 0;

  const commitName = (): void => {
    controller.updateMaterial(record.materialId, { name: name.trim() });
  };
  const commitScalar = (
    field: "opacity" | "roughness" | "metallic" | "emissive",
    value: number,
  ): void => {
    controller.updateMaterial(record.materialId, { [field]: value });
  };

  return (
    <li className={active ? "material-row active" : "material-row"}>
      <div className="material-row-main">
        <span
          className="material-swatch"
          style={{ background: record.color }}
          aria-hidden="true"
        />
        <input
          className="material-name"
          type="text"
          value={name}
          aria-label={`Name of material ${String(record.materialId)}`}
          onChange={(event) => {
            setName(event.target.value);
          }}
          onFocus={() => {
            focusedRef.current = new Set(focusedRef.current).add("name");
          }}
          onBlur={() => {
            focusedRef.current = new Set(focusedRef.current);
            focusedRef.current.delete("name");
            commitName();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              (event.target as HTMLInputElement).blur();
            }
          }}
        />
        <span className="material-usage" title="Voxels using this material">
          {String(entry.usage)} voxel{entry.usage === 1 ? "" : "s"}
        </span>
        <button
          type="button"
          className={active ? "material-paint active" : "material-paint"}
          aria-pressed={active}
          title="Paint with this material"
          onClick={() => {
            controller.paintWith(record.materialId);
          }}
        >
          Paint
        </button>
      </div>
      <div className="material-fields">
        <label className="material-field">
          <span>Color</span>
          <input
            type="color"
            value={color}
            aria-label={`Color of material ${String(record.materialId)}`}
            onChange={(event) => {
              setColor(event.target.value);
            }}
            onFocus={() => {
              focusedRef.current = new Set(focusedRef.current).add("color");
            }}
            onBlur={() => {
              focusedRef.current = new Set(focusedRef.current);
              focusedRef.current.delete("color");
              controller.updateMaterial(record.materialId, { color });
            }}
          />
        </label>
        <ScalarField
          label="Opacity"
          value={opacity}
          onChange={setOpacity}
          onFocus={() => {
            focusedRef.current = new Set(focusedRef.current).add("opacity");
          }}
          onBlur={() => {
            focusedRef.current = new Set(focusedRef.current);
            focusedRef.current.delete("opacity");
          }}
          onCommit={(value) => {
            commitScalar("opacity", value);
          }}
        />
        <ScalarField
          label="Roughness"
          value={roughness}
          onChange={setRoughness}
          onFocus={() => {
            focusedRef.current = new Set(focusedRef.current).add("roughness");
          }}
          onBlur={() => {
            focusedRef.current = new Set(focusedRef.current);
            focusedRef.current.delete("roughness");
          }}
          onCommit={(value) => {
            commitScalar("roughness", value);
          }}
        />
        <ScalarField
          label="Metallic"
          value={metallic}
          onChange={setMetallic}
          onFocus={() => {
            focusedRef.current = new Set(focusedRef.current).add("metallic");
          }}
          onBlur={() => {
            focusedRef.current = new Set(focusedRef.current);
            focusedRef.current.delete("metallic");
          }}
          onCommit={(value) => {
            commitScalar("metallic", value);
          }}
        />
        <ScalarField
          label="Emissive"
          value={emissive}
          onChange={setEmissive}
          onFocus={() => {
            focusedRef.current = new Set(focusedRef.current).add("emissive");
          }}
          onBlur={() => {
            focusedRef.current = new Set(focusedRef.current);
            focusedRef.current.delete("emissive");
          }}
          onCommit={(value) => {
            commitScalar("emissive", value);
          }}
        />
      </div>
      <div className="material-delete">
        {deleteArmed ? (
          <span className="material-reassign">
            <label>
              Reassign {String(entry.usage)} voxel
              {entry.usage === 1 ? "" : "s"} to
              <select
                value={replacement}
                aria-label={`Replacement material for ${String(record.materialId)}`}
                onChange={(event) => {
                  setReplacement(event.target.value);
                }}
              >
                {candidates.map((id) => {
                  const candidate = controller.state.entries.find(
                    (candidateEntry) => candidateEntry.record.materialId === id,
                  );
                  return (
                    <option key={String(id)} value={String(id)}>
                      {String(id)} — {candidate?.record.name ?? "material"}
                    </option>
                  );
                })}
              </select>
            </label>
            <button
              type="button"
              className="danger"
              onClick={() => {
                if (replacement !== "") {
                  controller.deleteMaterial(
                    record.materialId,
                    materialId(Number(replacement)),
                  );
                }
                setDeleteArmed(false);
              }}
            >
              Delete
            </button>
            <button
              type="button"
              onClick={() => {
                setDeleteArmed(false);
              }}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            className={referenced ? "danger" : undefined}
            disabled={referenced && !canReassign}
            title={
              referenced
                ? canReassign
                  ? "Delete and reassign its voxels to another material"
                  : "Every voxel uses this material and no other material exists"
                : "Delete this unused material"
            }
            onClick={() => {
              if (referenced) {
                const choices = controller.replacementCandidates(
                  record.materialId,
                );
                setCandidates(choices);
                const first = choices[0];
                if (first !== undefined) setReplacement(String(first));
                setDeleteArmed(true);
              } else {
                controller.deleteMaterial(record.materialId);
              }
            }}
          >
            {referenced ? "Delete…" : "Delete"}
          </button>
        )}
      </div>
    </li>
  );
}

/** A [0, 1] slider that commits on release, so a drag is one history entry. */
function ScalarField({
  label,
  value,
  onChange,
  onFocus,
  onBlur,
  onCommit,
}: {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly onFocus: () => void;
  readonly onBlur: () => void;
  readonly onCommit: (value: number) => void;
}): React.JSX.Element {
  return (
    <label className="material-field">
      <span>
        {label} {value.toFixed(2)}
      </span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        aria-label={label}
        onChange={(event) => {
          onChange(Number(event.target.value));
        }}
        onFocus={onFocus}
        onPointerUp={() => {
          onCommit(value);
        }}
        onBlur={() => {
          onBlur();
          onCommit(value);
        }}
        onKeyUp={(event) => {
          // Arrow keys adjust the value without a pointer release.
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            onCommit(value);
          }
        }}
      />
    </label>
  );
}
