import {
  WorkspaceError,
  animationId,
  commandId,
  createListenerSet,
  keyframeId,
  trackId,
  transactionId,
  type AnimationId,
  type CommandId,
  type KeyframeId,
  type NodeId,
  type TrackId,
  type TransactionId,
} from "@voxel-maker/shared";
import type {
  AnimationDescriptor,
  AnimationTrack,
  Interpolation,
  Keyframe,
  LoopPolicy,
  TrackProperty,
  VoxelDocument,
} from "@voxel-maker/model";
import {
  addTrackCommand,
  createAnimationCommand,
  deleteAnimationCommand,
  deleteKeyframeCommand,
  moveKeyframeCommand,
  removeTrackCommand,
  setKeyframeCommand,
  setTrackInterpolationCommand,
  updateAnimationCommand,
  type Command,
} from "@voxel-maker/commands";
import { createPlaybackController, type PlaybackClock } from "@voxel-maker/animation";
import {
  buildAutoKeyCommands,
  createTimelineStore,
  snapTime,
  type EditorStore,
  type KeyMode,
} from "@voxel-maker/editor";
import type { DocumentSession } from "@voxel-maker/session";

/**
 * Timeline controller (plan S10.9-S10.13, ticket #29): the headless seam
 * between the timeline UI and the session command bus. The controller
 * owns the runtime-only timeline store (zoom/scroll/playhead/selection/
 * snap/key-mode), the playback transport (S10.10), and every authored
 * change (S10.11/S10.13): clip CRUD, tracks, keyframes, interpolation,
 * manual keys, and the auto-key augmentation (S10.12) all compile to the
 * registered animation commands and commit through the bus as one
 * labeled, atomic, undoable transaction — or return a structured error
 * the shell surfaces as a notice. The controller never mutates semantic
 * state itself.
 *
 * Channel note: a track's channel is established by its first keyframe
 * (the data model stores no channel on the track). Newly added tracks
 * keep their chosen channel in runtime-only `#pendingChannels` until a
 * keyframe pins it.
 */

/** The animatable transform channels (plan S10.1). */
export type TrackChannel = "translation" | "rotation" | "scale";

/** One track row: the committed track plus its node's display name. */
export interface TrackEntry {
  readonly track: AnimationTrack;
  readonly nodeName: string;
}

/** One selected keyframe with the track it lives on. */
export interface SelectedKeyframe {
  readonly trackId: TrackId;
  readonly keyframe: Keyframe;
}

/** One move request for a multi-keyframe drag (S10.11). */
export interface KeyframeMove {
  readonly trackId: TrackId;
  readonly keyframeId: KeyframeId;
  readonly time: number;
}

/** Frozen panel snapshot; recomputed on every relevant event. */
export interface TimelineControllerState {
  /** True when a document is open (the timeline is inert otherwise). */
  readonly open: boolean;
  /** All clips in ascending id order. */
  readonly clips: readonly AnimationDescriptor[];
  readonly selectedClipId: AnimationId | undefined;
  readonly selectedClip: AnimationDescriptor | undefined;
  /** Track rows of the selected clip, in document order. */
  readonly tracks: readonly TrackEntry[];
  readonly selectedTrackIds: readonly TrackId[];
  /** Selected keyframe ids (S10.11 multi-select). */
  readonly selectedKeyframeIds: readonly KeyframeId[];
  /** Resolved selected keyframes across the selected tracks. */
  readonly selectedKeyframes: readonly SelectedKeyframe[];
  /** The nodes currently selected in the editor (key targets). */
  readonly selectedNodeIds: readonly NodeId[];
  /** Transport (S10.10). */
  readonly playhead: number;
  readonly playing: boolean;
  readonly stopped: boolean;
  readonly loopOverride: boolean;
  /** View state (S10.9), runtime-only. */
  readonly zoom: number;
  readonly scrollSeconds: number;
  readonly snapEnabled: boolean;
  readonly snapIncrement: number;
  /** Manual-key vs auto-key routing (S10.12). */
  readonly keyMode: KeyMode;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}

export interface TimelineController {
  readonly state: TimelineControllerState;
  readonly playhead: number;
  subscribe(listener: () => void): () => void;

  // Selection (S10.9/S10.11).
  selectClip(animationId: AnimationId | undefined): void;
  selectTracks(trackIds: readonly TrackId[]): void;
  selectKeyframes(keyframeIds: readonly KeyframeId[]): void;

  // Transport (S10.10).
  play(): void;
  pause(): void;
  stop(): void;
  toggleLoop(): void;
  /** Scrubs to a time (snapped when enabled, clamped to the clip). */
  scrub(time: number): void;
  /** Advances the transport clock; call while playing. */
  tick(now: number): void;

  // View state (S10.9).
  setZoom(zoom: number): void;
  setScrollSeconds(seconds: number): void;
  setSnapEnabled(enabled: boolean): void;
  setSnapIncrement(seconds: number): void;
  setKeyMode(mode: KeyMode): void;

  // Clip editing (S10.13).
  createClip(name: string | undefined, duration: number, loop: LoopPolicy): WorkspaceError | undefined;
  updateClip(changes: {
    readonly name?: string | null;
    readonly duration?: number;
    readonly loop?: LoopPolicy;
  }): WorkspaceError | undefined;
  deleteClip(): WorkspaceError | undefined;

  // Track editing (S10.10/S10.11).
  addTracks(nodeIds: readonly NodeId[], channel: TrackChannel): WorkspaceError | undefined;
  removeTrack(trackId: TrackId): WorkspaceError | undefined;
  setInterpolation(trackId: TrackId, interpolation: Interpolation): WorkspaceError | undefined;

  // Keyframe editing (S10.11).
  /**
   * Creates or updates the keyframe parked at `time` on a track. When
   * `property` is omitted the value is derived from the track's channel
   * (first keyframe or the channel chosen at track creation) and the
   * target node's current base transform — the value the user sees.
   */
  setKeyframe(
    trackId: TrackId,
    time: number,
    property?: TrackProperty,
  ): WorkspaceError | undefined;
  /** The channel a track speaks, or undefined when not yet established. */
  channelForTrack(trackId: TrackId): TrackChannel | undefined;
  /** Manual key (S10.12): keys selected tracks/nodes at the playhead. */
  keySelection(): WorkspaceError | undefined;
  moveKeyframes(moves: readonly KeyframeMove[]): WorkspaceError | undefined;
  deleteSelectedKeyframes(): WorkspaceError | undefined;

  // Auto-key (S10.12).
  /** Augments a transform transaction with keyframes when auto-key is on. */
  autoKeyCommands(commands: readonly Command[]): readonly Command[];

  undo(): WorkspaceError | undefined;
  redo(): WorkspaceError | undefined;
  dispose(): void;
}

export interface TimelineControllerOptions {
  readonly session: DocumentSession;
  readonly editor: EditorStore;
  /** Injectable transport clock; defaults to the wall clock. */
  readonly clock?: PlaybackClock;
}

function emptyState(): TimelineControllerState {
  return {
    open: false,
    clips: [],
    selectedClipId: undefined,
    selectedClip: undefined,
    tracks: [],
    selectedTrackIds: [],
    selectedKeyframeIds: [],
    selectedKeyframes: [],
    selectedNodeIds: [],
    playhead: 0,
    playing: false,
    stopped: true,
    loopOverride: false,
    zoom: 100,
    scrollSeconds: 0,
    snapEnabled: true,
    snapIncrement: 0.1,
    keyMode: "manual",
    canUndo: false,
    canRedo: false,
  };
}

export function createTimelineController(
  options: TimelineControllerOptions,
): TimelineController {
  const session = options.session;
  const editor = options.editor;
  const timeline = createTimelineStore();
  const playback = createPlaybackController(options.clock);
  const listeners = createListenerSet<undefined>();
  let stateValue: TimelineControllerState = emptyState();
  let commandSequence = 0;
  let transactionSequence = 0;
  /** Fresh ids for authored clips/tracks/keyframes. */
  let animationSequence = 0;
  let trackSequence = 0;
  let keyframeSequence = 0;
  /** Runtime-only channel intent for tracks whose channel is not pinned. */
  const pendingChannels = new Map<TrackId, TrackChannel>();
  let unsubscribeStore: (() => void) | undefined;
  let currentDocument: VoxelDocument | null = null;

  const nextCommandId = (): CommandId => {
    commandSequence += 1;
    return commandId(`command:timeline:${String(commandSequence)}`);
  };
  const nextTransactionId = (): TransactionId => {
    transactionSequence += 1;
    return transactionId(`transaction:timeline:${String(transactionSequence)}`);
  };
  const nextAnimationId = (): AnimationId => {
    animationSequence += 1;
    return animationId(`animation:timeline:${String(animationSequence)}`);
  };
  const nextTrackId = (): TrackId => {
    trackSequence += 1;
    return trackId(`track:timeline:${String(trackSequence)}`);
  };
  const nextKeyframeId = (): KeyframeId => {
    keyframeSequence += 1;
    return keyframeId(`keyframe:timeline:${String(keyframeSequence)}`);
  };

  const notOpen = (): WorkspaceError =>
    new WorkspaceError({
      family: "conflict",
      code: "SESSION_NOT_OPEN",
      message: "No document is open",
    });

  const fail = (error: WorkspaceError): WorkspaceError => {
    // The shell surfaces the error as a runtime notice; the controller
    // keeps returning it so callers can branch on it.
    return error;
  };

  /** Recomputes the frozen snapshot from live sources. */
  const refresh = (): void => {
    const current = session.current;
    if (current === undefined) {
      stateValue = emptyState();
      listeners.emit(undefined);
      return;
    }
    const document = current.store.getDocument();
    const clips = Object.values(document.animations).sort((a, b) =>
      a.animationId < b.animationId ? -1 : a.animationId > b.animationId ? 1 : 0,
    );
    const selectedClipId = timeline.snapshot().selectedClipId;
    const selectedClip =
      selectedClipId === undefined
        ? undefined
        : document.animations[selectedClipId];
    const tracks = selectedClip?.tracks ?? [];
    const selectedTrackIds = timeline
      .snapshot()
      .selectedTrackIds.filter((id) => tracks.some((track) => track.trackId === id));
    const selectedKeyframeIds = timeline
      .snapshot()
      .selectedKeyframeIds.filter((id) =>
        tracks.some((track) =>
          track.keyframes.some((keyframe) => keyframe.keyframeId === id),
        ),
      );
    const selectedKeyframes: SelectedKeyframe[] = [];
    for (const track of tracks) {
      for (const keyframe of track.keyframes) {
        if (selectedKeyframeIds.includes(keyframe.keyframeId)) {
          selectedKeyframes.push({ trackId: track.trackId, keyframe });
        }
      }
    }
    const selectedNodeIds = editor.selection
      .filter(
        (entry): entry is Extract<typeof entry, { readonly kind: "node" }> =>
          entry.kind === "node",
      )
      .map((entry) => entry.nodeId);
    const transport = playback.state;
    const view = timeline.snapshot();
    stateValue = {
      open: true,
      clips,
      selectedClipId,
      selectedClip,
      tracks: tracks.map((track) => ({
        track,
        nodeName: document.nodes[track.targetNodeId]?.name ?? String(track.targetNodeId),
      })),
      selectedTrackIds,
      selectedKeyframeIds,
      selectedKeyframes,
      selectedNodeIds,
      playhead: transport.time,
      playing: transport.playing,
      stopped: transport.stopped,
      loopOverride: transport.loopOverride,
      zoom: view.zoom,
      scrollSeconds: view.scrollSeconds,
      snapEnabled: view.snapEnabled,
      snapIncrement: view.snapIncrement,
      keyMode: view.keyMode,
      canUndo: current.bus.canUndo(),
      canRedo: current.bus.canRedo(),
    };
    listeners.emit(undefined);
  };

  /** Executes one labeled transaction; refreshes and returns the error. */
  const execute = (
    commands: readonly Command[],
    label: string,
  ): WorkspaceError | undefined => {
    const current = session.current;
    if (current === undefined) return fail(notOpen());
    if (commands.length === 0) return undefined;
    const result = current.bus.executeTransaction(commands, {
      transactionId: nextTransactionId(),
      expectedRevision: current.store.revision,
      source: "ui",
      label,
    });
    if (result.ok) {
      refresh();
      return undefined;
    }
    return fail(result.error);
  };

  const history = (kind: "undo" | "redo"): WorkspaceError | undefined => {
    const current = session.current;
    if (current === undefined) return fail(notOpen());
    const result = current.bus[kind]({
      transactionId: nextTransactionId(),
      expectedRevision: current.store.revision,
      source: "ui",
    });
    if (result.ok) {
      refresh();
      return undefined;
    }
    return fail(result.error);
  };

  /** Clamps a time into the clip duration and snaps it when enabled. */
  const boundTime = (time: number): number => {
    const clip = stateValue.selectedClip;
    const max = clip === undefined ? Number.MAX_SAFE_INTEGER : clip.duration;
    const raw = Math.min(Math.max(Number.isFinite(time) ? time : 0, 0), max);
    return stateValue.snapEnabled ? snapTime(raw, stateValue.snapIncrement) : raw;
  };

  const trackOf = (trackIdValue: TrackId): AnimationTrack | undefined =>
    stateValue.selectedClip?.tracks.find(
      (track) => track.trackId === trackIdValue,
    );

  /** Builds the typed track property for a channel/value pair. */
function channelProperty(
  channel: TrackChannel,
  value: readonly number[],
): TrackProperty {
  if (channel === "rotation") {
    return {
      channel,
      value: [...value] as unknown as [number, number, number, number],
    };
  }
  return {
    channel,
    value: [...value] as unknown as [number, number, number],
  };
}

/** The transform value of a node for a channel (manual/auto keys). */
  const channelValueOf = (
    document: VoxelDocument,
    nodeId: NodeId,
    channel: TrackChannel,
  ): readonly number[] => {
    const transform = document.nodes[nodeId]?.transform;
    if (transform === undefined) {
      return channel === "rotation" ? [0, 0, 0, 1] : [0, 0, 0];
    }
    return [...transform[channel]];
  };

  const selectClip = (animationIdValue: AnimationId | undefined): void => {
    const current = session.current;
    if (current === undefined) return;
    const document = current.store.getDocument();
    const clip =
      animationIdValue === undefined
        ? null
        : (document.animations[animationIdValue] ?? null);
    timeline.selectClip(clip?.animationId);
    playback.load(document, clip);
    // Re-seeding pending channels is unnecessary: they are keyed by track
    // id, which is stable across reloads of the same document.
    refresh();
  };

  const scrub = (time: number): void => {
    const bounded = boundTime(time);
    playback.scrub(bounded);
    timeline.setPlayhead(playback.state.time);
    refresh();
  };

  const createClip = (
    name: string | undefined,
    duration: number,
    loop: LoopPolicy,
  ): WorkspaceError | undefined => {
    const current = session.current;
    if (current === undefined) return fail(notOpen());
    const id = nextAnimationId();
    const error = execute(
      [
        createAnimationCommand(nextCommandId(), {
          animationId: id,
          ...(name === undefined ? {} : { name }),
          duration,
          loop,
        }),
      ],
      "Create clip",
    );
    if (error === undefined) selectClip(id);
    return error;
  };

  const updateClip = (changes: {
    readonly name?: string | null;
    readonly duration?: number;
    readonly loop?: LoopPolicy;
  }): WorkspaceError | undefined => {
    const clip = stateValue.selectedClip;
    if (clip === undefined) {
      return fail(
        new WorkspaceError({
          family: "validation",
          code: "MISSING_ANIMATION",
          message: "Select a clip to edit",
        }),
      );
    }
    return execute(
      [
        updateAnimationCommand(nextCommandId(), {
          animationId: clip.animationId,
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.duration === undefined ? {} : { duration: changes.duration }),
          ...(changes.loop === undefined ? {} : { loop: changes.loop }),
        }),
      ],
      "Update clip",
    );
  };

  const deleteClip = (): WorkspaceError | undefined => {
    const clip = stateValue.selectedClip;
    if (clip === undefined) return undefined;
    const error = execute(
      [
        deleteAnimationCommand(nextCommandId(), {
          animationId: clip.animationId,
        }),
      ],
      "Delete clip",
    );
    if (error === undefined) selectClip(undefined);
    return error;
  };

  const addTracks = (
    nodeIds: readonly NodeId[],
    channel: TrackChannel,
  ): WorkspaceError | undefined => {
    const clip = stateValue.selectedClip;
    if (clip === undefined) {
      return fail(
        new WorkspaceError({
          family: "validation",
          code: "MISSING_ANIMATION",
          message: "Select a clip before adding tracks",
        }),
      );
    }
    const current = session.current;
    if (current === undefined) return fail(notOpen());
    const document = current.store.getDocument();
    const fresh: TrackId[] = [];
    const commands: Command[] = [];
    for (const nodeId of nodeIds) {
      if (document.nodes[nodeId] === undefined) continue;
      // Skip a track that already exists for the node (one per node).
      if (clip.tracks.some((track) => track.targetNodeId === nodeId)) continue;
      const id = nextTrackId();
      fresh.push(id);
      commands.push(
        trackAddCommandFor(nextCommandId(), clip.animationId, id, nodeId),
      );
    }
    if (commands.length === 0) return undefined;
    const error = execute(commands, "Add tracks");
    if (error === undefined) {
      for (const id of fresh) pendingChannels.set(id, channel);
      timeline.selectTracks(fresh);
      refresh();
    }
    return error;
  };

  const removeTrack = (trackIdValue: TrackId): WorkspaceError | undefined => {
    const clip = stateValue.selectedClip;
    if (clip === undefined) return undefined;
    const error = execute(
      [
        removeTrackCommand(nextCommandId(), {
          animationId: clip.animationId,
          trackId: trackIdValue,
        }),
      ],
      "Remove track",
    );
    if (error === undefined) {
      pendingChannels.delete(trackIdValue);
      refresh();
    }
    return error;
  };

  const setInterpolation = (
    trackIdValue: TrackId,
    interpolation: Interpolation,
  ): WorkspaceError | undefined => {
    const clip = stateValue.selectedClip;
    if (clip === undefined) return undefined;
    return execute(
      [
        setTrackInterpolationCommand(nextCommandId(), {
          animationId: clip.animationId,
          trackId: trackIdValue,
          interpolation,
        }),
      ],
      "Set interpolation",
    );
  };

  /**
   * Creates or updates the keyframe parked at `time` on a track: an
   * existing keyframe at exactly that time is updated in place (same id),
   * otherwise a fresh id is allocated. The snapped time is clamped into
   * the clip duration so the produced command always passes validation.
   */
  const setKeyframe = (
    trackIdValue: TrackId,
    time: number,
    property?: TrackProperty,
  ): WorkspaceError | undefined => {
    const clip = stateValue.selectedClip;
    if (clip === undefined) {
      return fail(
        new WorkspaceError({
          family: "validation",
          code: "MISSING_ANIMATION",
          message: "Select a clip before keying",
        }),
      );
    }
    const track = trackOf(trackIdValue);
    if (track === undefined) {
      return fail(
        new WorkspaceError({
          family: "validation",
          code: "MISSING_TRACK",
          message: "The keyframe's track no longer exists",
        }),
      );
    }
    let resolved: TrackProperty = property as TrackProperty;
    if (resolved === undefined) {
      const channel = channelForTrack(trackIdValue);
      if (channel === undefined) {
        return fail(
          new WorkspaceError({
            family: "validation",
            code: "ANIMATION_TRACK_CHANNEL_MISMATCH",
            message:
              "This track has no channel yet; add its first keyframe with a property",
          }),
        );
      }
      const current = session.current;
      if (current === undefined) return fail(notOpen());
      resolved = channelProperty(
        channel,
        channelValueOf(current.store.getDocument(), track.targetNodeId, channel),
      );
    }
    const bounded = boundTime(time);
    const parked = track.keyframes.find((keyframe) => keyframe.time === bounded);
    const keyframeIdValue = parked?.keyframeId ?? nextKeyframeId();
    const error = execute(
      [
        setKeyframeCommand(nextCommandId(), {
          animationId: clip.animationId,
          trackId: trackIdValue,
          keyframeId: keyframeIdValue,
          time: parked?.time ?? bounded,
          property: resolved,
        }),
      ],
      parked === undefined ? "Create keyframe" : "Edit keyframe",
    );
    if (error === undefined) {
      timeline.selectKeyframes([keyframeIdValue]);
      refresh();
    }
    return error;
  };

  const channelForTrack = (trackIdValue: TrackId): TrackChannel | undefined => {
    const track = trackOf(trackIdValue);
    if (track === undefined) return undefined;
    return (
      track.keyframes[0]?.property.channel ?? pendingChannels.get(trackIdValue)
    );
  };

  /**
   * Manual key (S10.12): writes keyframes at the snapped playhead for the
   * selected tracks — or, when no track is selected, for every track of
   * the selected clip whose target node is in the editor selection. The
   * value comes from the node's current base transform, so the key
   * captures the pose the user sees.
   */
  const keySelection = (): WorkspaceError | undefined => {
    const clip = stateValue.selectedClip;
    if (clip === undefined) {
      return fail(
        new WorkspaceError({
          family: "validation",
          code: "MISSING_ANIMATION",
          message: "Select a clip before keying",
        }),
      );
    }
    const current = session.current;
    if (current === undefined) return fail(notOpen());
    const document = current.store.getDocument();
    const selected = new Set(stateValue.selectedTrackIds);
    const targets = clip.tracks.filter(
      (track) =>
        selected.size === 0
          ? stateValue.selectedNodeIds.includes(track.targetNodeId)
          : selected.has(track.trackId),
    );
    const time = boundTime(playback.state.time);
    const commands: Command[] = [];
    const keyed: KeyframeId[] = [];
    for (const track of targets) {
      const channel = channelForTrack(track.trackId);
      if (channel === undefined) continue;
      const parked = track.keyframes.find((keyframe) => keyframe.time === time);
      const keyframeIdValue = parked?.keyframeId ?? nextKeyframeId();
      commands.push(
        setKeyframeCommand(nextCommandId(), {
          animationId: clip.animationId,
          trackId: track.trackId,
          keyframeId: keyframeIdValue,
          time: parked?.time ?? time,
          property: channelProperty(
            channel,
            channelValueOf(document, track.targetNodeId, channel),
          ),
        }),
      );
      keyed.push(keyframeIdValue);
    }
    if (commands.length === 0) {
      return fail(
        new WorkspaceError({
          family: "validation",
          code: "MISSING_TRACK",
          message:
            "No keyable track: select a track or a node with a track in the selected clip",
        }),
      );
    }
    const error = execute(commands, "Key selection");
    if (error === undefined) {
      timeline.selectKeyframes(keyed);
      refresh();
    }
    return error;
  };

  const moveKeyframes = (
    moves: readonly KeyframeMove[],
  ): WorkspaceError | undefined => {
    const clip = stateValue.selectedClip;
    if (clip === undefined) return undefined;
    if (moves.length === 0) return undefined;
    const commands = moves.map((move) =>
      moveKeyframeCommand(nextCommandId(), {
        animationId: clip.animationId,
        trackId: move.trackId,
        keyframeId: move.keyframeId,
        time: boundTime(move.time),
      }),
    );
    const error = execute(commands, "Move keyframes");
    if (error === undefined) {
      timeline.selectKeyframes(moves.map((move) => move.keyframeId));
      refresh();
    }
    return error;
  };

  const deleteSelectedKeyframes = (): WorkspaceError | undefined => {
    const clip = stateValue.selectedClip;
    if (clip === undefined) return undefined;
    const selected = stateValue.selectedKeyframes;
    if (selected.length === 0) return undefined;
    const commands = selected.map(({ trackId: trackIdValue, keyframe }) =>
      deleteKeyframeCommand(nextCommandId(), {
        animationId: clip.animationId,
        trackId: trackIdValue,
        keyframeId: keyframe.keyframeId,
      }),
    );
    const error = execute(commands, "Delete keyframes");
    if (error === undefined) {
      timeline.selectKeyframes([]);
      refresh();
    }
    return error;
  };

  /**
   * Auto-key augmentation (S10.12): see buildAutoKeyCommands. Returns the
   * input commands unchanged when auto-key is off or no clip is selected,
   * so the viewport can always commit the function's result.
   */
  const autoKeyCommands = (commands: readonly Command[]): readonly Command[] => {
    if (
      !stateValue.open ||
      stateValue.keyMode !== "auto" ||
      stateValue.selectedClip === undefined
    ) {
      return commands;
    }
    return [
      ...commands,
      ...buildAutoKeyCommands(commands, {
        clip: stateValue.selectedClip,
        time: boundTime(playback.state.time),
        nextKeyframeId,
      }),
    ];
  };

  // ---- wiring ----------------------------------------------------------

  const unsubscribeSession = session.subscribe((event) => {
    if (event.kind === "document-opened" || event.kind === "document-replaced") {
      unsubscribeStore?.();
      unsubscribeStore = event.store.subscribe(() => {
        // Refresh the playback projection and prune selection after
        // every commit; the playhead never rewinds (playback.refresh).
        const clip = timeline.snapshot().selectedClipId;
        playback.refresh(event.store.getDocument());
        void clip;
        refresh();
      });
      currentDocument = event.store.getDocument();
      const clip = timeline.snapshot().selectedClipId;
      playback.load(
        currentDocument,
        clip === undefined ? null : (currentDocument.animations[clip] ?? null),
      );
      // A fresh document has no authored history; runtime state resets.
      timeline.selectClip(undefined);
    } else {
      unsubscribeStore?.();
      unsubscribeStore = undefined;
      currentDocument = null;
      playback.load(undefined as never, null);
      timeline.selectClip(undefined);
    }
    refresh();
  });

  const unsubscribeTimeline = timeline.subscribe(() => {
    refresh();
  });

  const unsubscribePlayback = playback.subscribe(() => {
    refresh();
  });

  const unsubscribeEditor = editor.subscribe(() => {
    refresh();
  });

  refresh();

  return {
    get state() {
      return stateValue;
    },
    get playhead() {
      return playback.state.time;
    },
    subscribe(listener: () => void) {
      return listeners.add(listener);
    },
    selectClip,
    selectTracks: (trackIdsValue: readonly TrackId[]) => {
      timeline.selectTracks(trackIdsValue);
    },
    selectKeyframes: (keyframeIdsValue: readonly KeyframeId[]) => {
      timeline.selectKeyframes(keyframeIdsValue);
    },
    play: () => {
      playback.play();
      refresh();
    },
    pause: () => {
      playback.pause();
      refresh();
    },
    stop: () => {
      playback.stop();
      timeline.setPlayhead(0);
      refresh();
    },
    toggleLoop: () => {
      playback.setLoop(!playback.state.loopOverride);
      refresh();
    },
    scrub,
    tick: (now: number) => {
      playback.tick(now);
      timeline.setPlayhead(playback.state.time);
      refresh();
    },
    setZoom: (zoom: number) => {
      timeline.setZoom(zoom);
    },
    setScrollSeconds: (seconds: number) => {
      timeline.setScrollSeconds(seconds);
    },
    setSnapEnabled: (enabled: boolean) => {
      timeline.setSnapEnabled(enabled);
    },
    setSnapIncrement: (seconds: number) => {
      timeline.setSnapIncrement(seconds);
    },
    setKeyMode: (mode: KeyMode) => {
      timeline.setKeyMode(mode);
    },
    createClip,
    updateClip,
    deleteClip,
    addTracks,
    removeTrack,
    setInterpolation,
    setKeyframe,
    channelForTrack,
    keySelection,
    moveKeyframes,
    deleteSelectedKeyframes,
    autoKeyCommands,
    undo: () => history("undo"),
    redo: () => history("redo"),
    dispose() {
      unsubscribeSession();
      unsubscribeTimeline();
      unsubscribePlayback();
      unsubscribeEditor();
      unsubscribeStore?.();
    },
  };
}

function trackAddCommandFor(
  id: CommandId,
  animationIdValue: AnimationId,
  trackIdValue: TrackId,
  targetNodeId: NodeId,
): Command {
  return addTrackCommand(id, {
    animationId: animationIdValue,
    trackId: trackIdValue,
    targetNodeId,
    interpolation: "linear",
  });
}
