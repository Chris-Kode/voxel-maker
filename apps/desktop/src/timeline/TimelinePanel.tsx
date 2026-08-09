import { useEffect, useMemo, useRef, useState } from "react";
import type {
  AnimationId,
  KeyframeId,
  NodeId,
  TrackId,
} from "@voxel-maker/shared";
import type { EditorStore } from "@voxel-maker/editor";
import {
  pixelToTime,
  timeToPixel,
  type TimelineStoreSnapshot,
} from "@voxel-maker/editor";
import type { AnimationDescriptor, Interpolation, TrackProperty } from "@voxel-maker/model";
import type {
  TimelineController,
  TrackChannel,
} from "./timeline-controller.js";

/**
 * Timeline panel (plan S10.9-S10.11, ticket #29): clip selection,
 * transport (play/pause/stop/loop/scrub), zoom/scroll/snap, track rows
 * linked to the hierarchy, and keyframe lanes with create (double-click
 * or Key), move (drag), multi-select (click/shift-click), delete (Delete
 * or button), and per-track interpolation choice. Every edit compiles to
 * a registered command through the timeline controller; the panel never
 * encodes domain invariants itself and never mutates the document
 * directly. All view state (zoom, scroll, playhead, selection, snapping,
 * key mode) is runtime-only.
 */

export interface TimelinePanelProps {
  readonly controller: TimelineController;
  readonly editor: EditorStore;
}

const INTERPOLATIONS: readonly { readonly id: Interpolation; readonly label: string }[] = [
  { id: "step", label: "Step" },
  { id: "linear", label: "Linear" },
  { id: "smoothstep", label: "Smooth" },
];

const CHANNELS: readonly { readonly id: TrackChannel; readonly label: string }[] = [
  { id: "translation", label: "Position" },
  { id: "rotation", label: "Rotation" },
  { id: "scale", label: "Scale" },
];

/** Formats seconds as `m:ss.t` for the transport readout. */
export function formatTimelineTime(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds >= 0 ? seconds : 0;
  const minutes = Math.floor(safe / 60);
  const rest = safe - minutes * 60;
  return `${String(minutes)}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}

/** Chooses a ruler tick interval so ticks stay at least 48px apart. */
function tickInterval(zoom: number): number {
  const candidates = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
  for (const candidate of candidates) {
    if (candidate * zoom >= 48) return candidate;
  }
  return 120;
}

export function TimelinePanel({
  controller,
  editor,
}: TimelinePanelProps): React.JSX.Element {
  const [state, setState] = useState(() => controller.state);
  const [channel, setChannel] = useState<TrackChannel>("translation");
  const [dragPreview, setDragPreview] = useState<
    readonly { readonly trackId: TrackId; readonly keyframeId: KeyframeId; readonly time: number }[]
  >([]);
  const lanesRef = useRef<HTMLDivElement>(null);
  const [lanesWidth, setLanesWidth] = useState(800);

  useEffect(
    () =>
      controller.subscribe(() => {
        setState(controller.state);
      }),
    [controller],
  );

  useEffect(() => {
    const element = lanesRef.current;
    if (element === null) return;
    const measure = (): void => {
      setLanesWidth(element.clientWidth);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [state.selectedClipId]);

  const report = (error: Error | undefined): void => {
    if (error !== undefined) editor.pushNotice("error", error.message);
  };

  const zoom = state.zoom;
  const scroll = state.scrollSeconds;
  const clip = state.selectedClip;
  const duration = clip?.duration ?? 0;
  const laneX = (time: number): number => timeToPixel(time, zoom, scroll);
  const contentWidth = Math.max(
    lanesWidth,
    timeToPixel(duration, zoom, scroll) + 40,
  );

  const play = (): void => controller.play();
  const pause = (): void => controller.pause();
  const stop = (): void => controller.stop();
  const toggleLoop = (): void => controller.toggleLoop();
  const toggleSnap = (): void => controller.setSnapEnabled(!state.snapEnabled);
  const toggleAutoKey = (): void =>
    controller.setKeyMode(state.keyMode === "auto" ? "manual" : "auto");

  const onRulerPointerDown = (event: React.PointerEvent<HTMLDivElement>): void => {
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const scrubTo = (clientX: number): void => {
      const rect = element.getBoundingClientRect();
      controller.scrub(pixelToTime(clientX - rect.left, zoom, scroll));
    };
    scrubTo(event.clientX);
    const onMove = (moveEvent: PointerEvent): void => {
      scrubTo(moveEvent.clientX);
    };
    const onUp = (): void => {
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
    };
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
  };

  const onKeyframePointerDown = (
    event: React.PointerEvent<HTMLButtonElement>,
    trackIdValue: TrackId,
    keyframeIdValue: KeyframeId,
  ): void => {
    event.stopPropagation();
    const element = event.currentTarget;
    element.setPointerCapture(event.pointerId);
    const multi = event.shiftKey || event.metaKey || event.ctrlKey;
    // Read the live controller selection, not the render snapshot: within
    // one act() batch several pointer events may arrive before a re-render
    // lands, and the store is the single source of truth.
    const selected = controller.state.selectedKeyframeIds;
    const isSelected = selected.includes(keyframeIdValue);
    const nextSelection = multi
      ? isSelected
        ? selected.filter((id) => id !== keyframeIdValue)
        : [...selected, keyframeIdValue]
      : [keyframeIdValue];
    controller.selectKeyframes(nextSelection);
    // Resolve the drag origins from the committed clip state (the fresh
    // selection is authoritative even before the re-render lands).
    const originals = nextSelection.flatMap((id) => {
      for (const track of state.selectedClip?.tracks ?? []) {
        const keyframe = track.keyframes.find(
          (candidate) => candidate.keyframeId === id,
        );
        if (keyframe !== undefined) {
          return [
            {
              trackId: track.trackId,
              keyframeId: id,
              time: keyframe.time,
            },
          ];
        }
      }
      return [];
    });
    console.log("DBG pointerdown", keyframeIdValue, "multi", event.shiftKey, "next", JSON.stringify(nextSelection), "originals", JSON.stringify(originals));
    const session = {
      startX: event.clientX,
      lastX: event.clientX,
      originals,
    };
    const onMove = (moveEvent: PointerEvent): void => {
      session.lastX = moveEvent.clientX;
      const delta = (session.lastX - session.startX) / zoom;
      setDragPreview(
        session.originals.map((original) => ({
          trackId: original.trackId,
          keyframeId: original.keyframeId,
          time: Math.max(0, original.time + delta),
        })),
      );
    };
    const onUp = (): void => {
      const delta = (session.lastX - session.startX) / zoom;
      const preview = session.originals.map((original) => ({
        trackId: original.trackId,
        keyframeId: original.keyframeId,
        time: Math.max(0, original.time + delta),
      }));
      const moves = preview.filter(
        (candidate, index) =>
          candidate.time !== session.originals[index]?.time,
      );
      if (moves.length > 0) {
        report(controller.moveKeyframes(moves));
      }
      setDragPreview([]);
      element.removeEventListener("pointermove", onMove);
      element.removeEventListener("pointerup", onUp);
    };
    element.addEventListener("pointermove", onMove);
    element.addEventListener("pointerup", onUp);
  };

  const onCreateKeyframe = (trackIdValue: TrackId, time: number): void => {
    report(controller.setKeyframe(trackIdValue, time));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Delete" || event.key === "Backspace") {
      if (state.selectedKeyframeIds.length > 0) {
        event.preventDefault();
        report(controller.deleteSelectedKeyframes());
      }
    }
  };

  const onWheel = (event: React.WheelEvent<HTMLDivElement>): void => {
    if (event.ctrlKey || event.metaKey) {
      const factor = event.deltaY < 0 ? 1.25 : 0.8;
      controller.setZoom(zoom * factor);
      return;
    }
    controller.setScrollSeconds(
      scroll + (event.deltaY + event.deltaX) / zoom,
    );
  };

  const ticks = useMemo(() => {
    if (clip === undefined) return [];
    const interval = tickInterval(zoom);
    const first = Math.floor(scroll / interval) * interval;
    const last = scroll + lanesWidth / zoom;
    const result: { readonly time: number; readonly x: number }[] = [];
    for (let time = first; time <= last; time += interval) {
      result.push({ time, x: laneX(time) });
    }
    return result;
  }, [clip, zoom, scroll, lanesWidth]);

  const trackSelected = (trackIdValue: TrackId): boolean =>
    state.selectedTrackIds.includes(trackIdValue);

  const onTrackClick = (
    event: React.MouseEvent,
    trackIdValue: TrackId,
  ): void => {
    const multi = event.shiftKey || event.metaKey || event.ctrlKey;
    const selected = controller.state.selectedTrackIds;
    controller.selectTracks(
      multi
        ? trackSelected(trackIdValue)
          ? selected.filter((id) => id !== trackIdValue)
          : [...selected, trackIdValue]
        : [trackIdValue],
    );
  };

  const addTracksForSelection = (): void => {
    if (state.selectedNodeIds.length === 0) return;
    report(controller.addTracks(state.selectedNodeIds, channel));
  };

  const key = (): void => {
    report(controller.keySelection());
  };

  const visibleKeyframes = (trackIdValue: TrackId): readonly {
    readonly keyframeId: KeyframeId;
    readonly time: number;
  }[] => {
    const preview = dragPreview
      .filter((entry) => entry.trackId === trackIdValue)
      .map((entry) => ({ keyframeId: entry.keyframeId, time: entry.time }));
    const track = clip?.tracks.find((candidate) => candidate.trackId === trackIdValue);
    if (track === undefined) return preview;
    const previewIds = new Set(preview.map((entry) => entry.keyframeId));
    return [
      ...track.keyframes
        .filter((keyframe) => !previewIds.has(keyframe.keyframeId))
        .map((keyframe) => ({
          keyframeId: keyframe.keyframeId,
          time: keyframe.time,
        })),
      ...preview,
    ];
  };

  if (!state.open) {
    return (
      <section className="timeline-panel" aria-label="Timeline">
        <p className="timeline-empty">Open a document to edit animations.</p>
      </section>
    );
  }

  return (
    <section className="timeline-panel" aria-label="Timeline">
      <div className="timeline-toolbar">
        <label className="timeline-clip-picker">
          <span className="sr-only">Clip</span>
          <select
            value={state.selectedClipId ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              controller.selectClip(value === "" ? undefined : (value as AnimationId));
            }}
          >
            <option value="">No clip — base state</option>
            {state.clips.map((candidate) => (
              <option key={candidate.animationId} value={candidate.animationId}>
                {candidate.name ?? candidate.animationId}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className={state.keyMode === "auto" ? "active" : undefined}
          aria-pressed={state.keyMode === "auto"}
          title="Auto-key: transform edits write keys into the selected clip"
          onClick={toggleAutoKey}
          disabled={clip === undefined}
        >
          Auto-key
        </button>
        <button
          type="button"
          onClick={key}
          disabled={clip === undefined}
          title="Key the selected tracks (or nodes with tracks) at the playhead"
        >
          Key
        </button>
        <span className="timeline-separator" aria-hidden="true" />
        <button
          type="button"
          aria-label={state.playing ? "Pause" : "Play"}
          onClick={state.playing ? pause : play}
          disabled={clip === undefined}
        >
          {state.playing ? "Pause" : "Play"}
        </button>
        <button type="button" onClick={stop} disabled={clip === undefined}>
          Stop
        </button>
        <button
          type="button"
          className={state.loopOverride ? "active" : undefined}
          aria-pressed={state.loopOverride}
          onClick={toggleLoop}
          disabled={clip === undefined}
        >
          Loop
        </button>
        <span className="timeline-time" aria-label="Transport time">
          {formatTimelineTime(state.playhead)}
        </span>
        <span className="timeline-separator" aria-hidden="true" />
        <label className="timeline-channel-picker">
          <span className="sr-only">New track channel</span>
          <select
            value={channel}
            onChange={(event) => setChannel(event.target.value as TrackChannel)}
          >
            {CHANNELS.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={addTracksForSelection}
          disabled={clip === undefined || state.selectedNodeIds.length === 0}
          title="Add a track for each selected node"
        >
          + Track
        </button>
        <button
          type="button"
          onClick={() => report(controller.deleteSelectedKeyframes())}
          disabled={state.selectedKeyframeIds.length === 0}
        >
          Delete keys
        </button>
        <span className="timeline-separator" aria-hidden="true" />
        <button
          type="button"
          className={state.snapEnabled ? "active" : undefined}
          aria-pressed={state.snapEnabled}
          onClick={toggleSnap}
        >
          Snap
        </button>
        <button
          type="button"
          aria-label="Zoom out"
          onClick={() => controller.setZoom(zoom / 1.5)}
        >
          −
        </button>
        <button
          type="button"
          aria-label="Zoom in"
          onClick={() => controller.setZoom(zoom * 1.5)}
        >
          +
        </button>
      </div>
      {clip === undefined ? (
        <div className="timeline-empty">
          <p>Create a clip to start animating.</p>
          <button
            type="button"
            onClick={() => report(controller.createClip("Clip 1", 2, "loop"))}
          >
            New clip
          </button>
        </div>
      ) : (
        <div className="timeline-body">
          <div className="timeline-tracks" aria-label="Tracks">
            {state.tracks.length === 0 ? (
              <p className="timeline-empty">
                Select a node, then + Track. {state.keyMode === "auto" ? "Auto-key is on." : ""}
              </p>
            ) : (
              state.tracks.map((entry) => (
                <div
                  key={entry.track.trackId}
                  className={
                    "timeline-track" +
                    (trackSelected(entry.track.trackId) ? " selected" : "")
                  }
                  onClick={(event) => onTrackClick(event, entry.track.trackId)}
                >
                  <span className="timeline-track-name" title={entry.nodeName}>
                    {entry.nodeName}
                  </span>
                  <span className="timeline-track-channel">
                    {CHANNELS.find(
                      (candidate) =>
                        candidate.id ===
                        (entry.track.keyframes[0]?.property.channel ??
                          controller.channelForTrack(entry.track.trackId)),
                    )?.label ?? "?"}
                  </span>
                  <select
                    aria-label={`Interpolation of ${entry.nodeName}`}
                    value={entry.track.interpolation}
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => {
                      report(
                        controller.setInterpolation(
                          entry.track.trackId,
                          event.target.value as Interpolation,
                        ),
                      );
                    }}
                  >
                    {INTERPOLATIONS.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {candidate.label}
                      </option>
                    ))}
                  </select>
                </div>
              ))
            )}
          </div>
          <div
            className="timeline-lanes"
            ref={lanesRef}
            tabIndex={0}
            aria-label="Keyframe lanes"
            onWheel={onWheel}
            onKeyDown={onKeyDown}
          >
            <div className="timeline-ruler" onPointerDown={onRulerPointerDown}>
              {ticks.map((tick) => (
                <span
                  key={tick.time}
                  className="timeline-tick"
                  style={{ left: `${tick.x}px` }}
                >
                  {tick.time.toFixed(tickInterval(zoom) < 1 ? 2 : 0)}
                </span>
              ))}
            </div>
            <div
              className="timeline-lane-content"
              style={{ width: `${contentWidth}px` }}
            >
              {state.tracks.map((entry, row) => (
                <div
                  key={entry.track.trackId}
                  className="timeline-row"
                  style={{ top: `${row * 26}px` }}
                  onDoubleClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    onCreateKeyframe(
                      entry.track.trackId,
                      pixelToTime(event.clientX - rect.left, zoom, scroll),
                    );
                  }}
                >
                  {visibleKeyframes(entry.track.trackId).map((keyframe) => (
                    <button
                      key={keyframe.keyframeId}
                      type="button"
                      className={
                        "timeline-keyframe" +
                        (state.selectedKeyframeIds.includes(keyframe.keyframeId)
                          ? " selected"
                          : "")
                      }
                      style={{ left: `${laneX(keyframe.time) - 6}px` }}
                      aria-label={`Keyframe at ${keyframe.time.toFixed(2)}s`}
                      onPointerDown={(event) =>
                        onKeyframePointerDown(
                          event,
                          entry.track.trackId,
                          keyframe.keyframeId,
                        )
                      }
                    />
                  ))}
                </div>
              ))}
              <div
                className="timeline-playhead"
                style={{ left: `${laneX(state.playhead)}px` }}
                aria-hidden="true"
              />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
