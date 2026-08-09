import { useEffect, useState } from "react";
import type { TrackId } from "@voxel-maker/shared";
import type { Quat, Vec3 } from "@voxel-maker/math";
import type { TrackProperty } from "@voxel-maker/model";
import type { EditorStore } from "@voxel-maker/editor";
import {
  formatRotationDegrees,
  formatVec3,
  parseRotationDegreesInput,
  parseScaleInput,
  parseVec3Input,
} from "@voxel-maker/editor";
import type {
  TrackChannel,
  TimelineController,
} from "./timeline-controller.js";

/**
 * Animation inspector (plan S10.13, ticket #29): clip name/duration/loop
 * editing and selected-keyframe value editing with validation. Every
 * edit compiles to a registered command through the timeline controller
 * (one labeled, atomic, undoable transaction); parse and range errors are
 * surfaced as structured notices instead of duplicating domain
 * invariants here.
 */

export interface AnimationInspectorProps {
  readonly controller: TimelineController;
  readonly editor: EditorStore;
}

const LOOPS: readonly {
  readonly id: "once" | "loop";
  readonly label: string;
}[] = [
  { id: "once", label: "Once" },
  { id: "loop", label: "Loop" },
];

const CHANNEL_LABELS: Readonly<Record<TrackChannel, string>> = {
  translation: "Position",
  rotation: "Rotation",
  scale: "Scale",
};

function channelOf(property: TrackProperty): TrackChannel {
  return property.channel;
}

export function AnimationInspector({
  controller,
  editor,
}: AnimationInspectorProps): React.JSX.Element {
  const [state, setState] = useState(() => controller.state);
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("");
  const [loop, setLoop] = useState<"once" | "loop">("loop");
  const [values, setValues] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | undefined>();

  useEffect(
    () =>
      controller.subscribe(() => {
        setState(controller.state);
      }),
    [controller],
  );

  const clip = state.selectedClip;
  const single =
    state.selectedKeyframes.length === 1
      ? (state.selectedKeyframes[0] as
          | {
              readonly trackId: TrackId;
              readonly keyframe: {
                readonly keyframeId: string;
                readonly time: number;
                readonly property: TrackProperty;
              };
            }
          | undefined)
      : undefined;

  // Seed the local editors whenever the selection changes.
  useEffect(() => {
    setName(clip?.name ?? "");
    setDuration(clip === undefined ? "" : String(clip.duration));
    setLoop(clip?.loop ?? "loop");
    setError(undefined);
    if (single === undefined) {
      setValues([]);
      return;
    }
    const property = single.keyframe.property;
    if (property.channel === "rotation") {
      setValues(formatRotationDegrees(property.value).split(", "));
    } else {
      setValues(
        property.value.map(
          (component) =>
            formatVec3([component, 0, 0]).split(", ")[0] ?? String(component),
        ),
      );
    }
  }, [clip?.animationId, state.selectedKeyframeIds.join(",")]);

  const report = (result: Error | undefined): void => {
    if (result !== undefined) {
      setError(result.message);
      editor.pushNotice("error", result.message);
    } else {
      setError(undefined);
    }
  };

  const commitClip = (): void => {
    if (clip === undefined) return;
    const parsedDuration = Number(duration);
    report(
      controller.updateClip({
        name: name.trim() === "" ? null : name,
        ...(duration.trim() === "" ? {} : { duration: parsedDuration }),
        loop,
      }),
    );
  };

  const commitValue = (): void => {
    if (single === undefined) return;
    try {
      const property = single.keyframe.property;
      const text = values.join(", ");
      const value =
        property.channel === "rotation"
          ? parseRotationDegreesInput(text)
          : property.channel === "scale"
            ? parseScaleInput(text)
            : parseVec3Input(text, "translation");
      const nextProperty: TrackProperty =
        property.channel === "rotation"
          ? { channel: "rotation", value: value as Quat }
          : property.channel === "scale"
            ? { channel: "scale", value: value as Vec3 }
            : { channel: "translation", value: value as Vec3 };
      report(
        controller.setKeyframe(
          single.trackId,
          single.keyframe.time,
          nextProperty,
        ),
      );
    } catch (caught) {
      const message =
        caught instanceof Error ? caught.message : "Invalid keyframe value";
      setError(message);
      editor.pushNotice("error", message);
    }
  };

  const label = (index: number): string => {
    if (single === undefined) return String(index);
    return single.keyframe.property.channel === "rotation"
      ? (["X", "Y", "Z"][index] ?? String(index))
      : (["X", "Y", "Z"][index] ?? String(index));
  };

  return (
    <section className="panel" aria-label="Animation">
      <h2>Animation</h2>
      {clip === undefined ? (
        <p className="panel-empty">
          Select a clip in the timeline to edit its name, duration, loop, and
          keyframe values.
        </p>
      ) : (
        <div className="animation-inspector">
          <label className="field">
            <span>Name</span>
            <input
              value={name}
              placeholder="Unnamed clip"
              onChange={(event) => {
                setName(event.target.value);
              }}
              onBlur={() => {
                commitClip();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitClip();
              }}
            />
          </label>
          <label className="field">
            <span>Duration (s)</span>
            <input
              type="number"
              min="0"
              step="0.1"
              value={duration}
              onChange={(event) => {
                setDuration(event.target.value);
              }}
              onBlur={() => {
                commitClip();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitClip();
              }}
            />
          </label>
          <label className="field">
            <span>Loop</span>
            <select
              value={loop}
              onChange={(event) => {
                setLoop(event.target.value as "once" | "loop");
              }}
              onBlur={() => {
                commitClip();
              }}
            >
              {LOOPS.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="danger"
            onClick={() => {
              report(controller.deleteClip());
            }}
          >
            Delete clip
          </button>

          {single === undefined ? (
            <p className="panel-empty">
              {state.selectedKeyframes.length === 0
                ? "Select one keyframe in the timeline to edit its value."
                : `${String(state.selectedKeyframes.length)} keyframes selected — select one to edit its value.`}
            </p>
          ) : (
            <fieldset className="keyframe-editor">
              <legend>
                Keyframe at {single.keyframe.time.toFixed(2)}s ·{" "}
                {CHANNEL_LABELS[channelOf(single.keyframe.property)]}
              </legend>
              <div className="keyframe-values">
                {values.map((value, index) => (
                  <label key={label(index)} className="field">
                    <span>{label(index)}</span>
                    <input
                      value={value}
                      onChange={(event) => {
                        const next = [...values];
                        next[index] = event.target.value;
                        setValues(next);
                      }}
                      onBlur={() => {
                        commitValue();
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitValue();
                      }}
                    />
                  </label>
                ))}
              </div>
              {error !== undefined ? (
                <p className="field-error" role="alert">
                  {error}
                </p>
              ) : null}
            </fieldset>
          )}
        </div>
      )}
    </section>
  );
}
