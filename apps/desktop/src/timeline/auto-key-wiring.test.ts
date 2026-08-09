import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
} from "@voxel-maker/shared";
import { createDocument } from "@voxel-maker/model";
import {
  CommandBus,
  CommandRegistry,
  fillBoxCommand,
  registerBatchCommands,
  registerVoxelCommands,
} from "@voxel-maker/commands";
import { createDocumentStore } from "@voxel-maker/document";
import { MemoryProjectStorage } from "@voxel-maker/storage";
import { writeVxlProject } from "@voxel-maker/formats";
import {
  createDesktopComposition,
  type DesktopComposition,
  type FilePicker,
} from "../composition.js";
import { transformTargets } from "@voxel-maker/editor";
import { autoConfirmPrompts, requireResult } from "../test-prompts.js";

/**
 * Auto-key wiring at the composition seam (plan S10.12, ticket #29): with
 * the timeline key mode set to "auto" and a clip selected, a real gizmo
 * translate drag commits the node transform AND a keyframe into the
 * selected clip as one atomic, undoable transaction. With "manual" (the
 * default) the same drag touches only base state. This is the acceptance
 * evidence that transform edits intentionally target base state or the
 * selected clip depending on the mode.
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:autokey-wire:root");
const CHILD = nodeId("node:autokey-wire:child");
const VOLUME = volumeId("volume:autokey-wire:0001");

/** A project with a 4x4x4 box at world translation (2, 0, 0). */
function buildFixtureProject(): Uint8Array {
  const document = createDocument({
    documentId: documentId("document:autokey-wire:0001"),
    metadata: { title: "fixture-box" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [CHILD],
        transform: IDENTITY,
        components: [],
      },
      {
        nodeId: CHILD,
        name: "Box",
        parentId: ROOT,
        children: [],
        transform: { ...IDENTITY, translation: [2, 0, 0] },
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "box",
        color: "#ff8800",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [{ volumeId: VOLUME, bounds: { min: [0, 0, 0], max: [5, 5, 5] } }],
  });
  const { store, writeCapability } = createDocumentStore({ document });
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  registerBatchCommands(registry);
  const bus = new CommandBus(store, registry, writeCapability);
  const result = bus.execute(
    fillBoxCommand(commandId("command:test:fill"), {
      volumeId: VOLUME,
      region: { min: [0, 0, 0], max: [4, 4, 4] },
      material: materialId(1),
    }),
    {
      transactionId: transactionId("transaction:test:fill"),
      expectedRevision: 0,
      source: "system",
    },
  );
  if (!result.ok) throw new Error(`fixture fill failed: ${result.error.code}`);
  const readView = store.getVolume(VOLUME);
  if (readView === undefined) throw new Error("missing read view");
  return writeVxlProject({
    document: store.getDocument(),
    volumes: new Map([[VOLUME, readView]]),
  });
}

const createFakePicker = (): FilePicker => ({
  pickOpenPath: () => Promise.resolve(undefined),
  pickSavePath: (suggestedName: string) => Promise.resolve(suggestedName),
});

async function openFixture(composition: DesktopComposition): Promise<void> {
  const result = requireResult(
    await composition.fileService.openLoadedProject(
      "fixture.vxl",
      buildFixtureProject(),
    ),
  );
  if (!result.ok) {
    const error = result.error;
    throw new Error(
      `open failed: ${error === undefined ? "unknown" : error.code}`,
    );
  }
}

function projectToViewport(
  composition: DesktopComposition,
  point: readonly [number, number, number],
): readonly [number, number] {
  const vector = new THREE.Vector3(point[0], point[1], point[2]);
  vector.project(composition.viewport.camera);
  return [
    ((vector.x + 1) / 2) * composition.viewport.viewportWidth,
    ((1 - vector.y) / 2) * composition.viewport.viewportHeight,
  ];
}

/** Frames the camera like the render loop and projects the +X gizmo tip
 * for the CURRENT selection (the gizmo follows the selected node). */
function gizmoTip(composition: DesktopComposition): readonly [number, number] {
  const viewport = composition.viewport;
  viewport.setViewportSize(800, 600);
  viewport.setStandardView("front");
  viewport.focus();
  viewport.applyCamera();
  viewport.refreshGizmo();
  const state = composition.session.current;
  if (state === undefined) throw new Error("no open session");
  const targets = transformTargets(state.store, composition.editor.selection);
  if (targets === undefined) throw new Error("no transform targets");
  return projectToViewport(composition, [
    targets.center[0] + targets.radius * 1.1 * 1.25,
    targets.center[1],
    targets.center[2],
  ]);
}

/** Runs one +X gizmo drag that snaps the box by one increment. */
function dragTranslateX(
  composition: DesktopComposition,
  tip: readonly [number, number],
): void {
  const viewport = composition.viewport;
  expect(viewport.gizmoPointerDown(tip[0], tip[1])).toBe(true);
  viewport.gizmoPointerMove(tip[0] - 60, tip[1]);
  viewport.gizmoPointerMove(tip[0] - 120, tip[1]);
  viewport.gizmoPointerUp();
  expect(viewport.transformTool.active).toBe(false);
}

describe("auto-key transform wiring", () => {
  it("keys the selected clip on a transform drag in auto-key mode", async () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
      prompts: autoConfirmPrompts,
    });
    await openFixture(composition);
    const viewport = composition.viewport;
    viewport.setViewportSize(800, 600);
    viewport.setStandardView("front");
    viewport.focus();
    viewport.applyCamera();
    composition.editor.setSelection([{ kind: "node", nodeId: CHILD }]);
    viewport.refreshGizmo();
    let tip = gizmoTip(composition);

    // Author a clip with a translation track whose channel is pinned by
    // one keyframe, then park the playhead at 0.5s.
    const timeline = composition.timeline;
    expect(timeline.createClip("slide", 2, "loop")).toBeUndefined();
    expect(timeline.addTracks([CHILD], "translation")).toBeUndefined();
    const trackId = timeline.state.tracks[0]?.track.trackId;
    if (trackId === undefined) throw new Error("missing track");
    expect(
      timeline.setKeyframe(trackId, 0, {
        channel: "translation",
        value: [2, 0, 0],
      }),
    ).toBeUndefined();
    timeline.scrub(0.5);

    // Manual mode: the drag touches only base state.
    const before =
      composition.session.current?.store.getDocument().nodes[CHILD]?.transform
        .translation;
    if (before === undefined) throw new Error("missing baseline");
    dragTranslateX(composition, tip);
    const afterManual =
      composition.session.current?.store.getDocument().nodes[CHILD]?.transform
        .translation;
    const clipAfterManual = timeline.state.selectedClip;
    expect(clipAfterManual?.tracks[0]?.keyframes).toHaveLength(1);

    // Auto-key mode: the same drag also writes a keyframe at the playhead
    // into the clip — one atomic transaction. The gizmo follows the box,
    // so the tip is re-projected for the current pose.
    timeline.setKeyMode("auto");
    tip = gizmoTip(composition);
    const history = composition.session.current;
    if (history === undefined) throw new Error("no open session");
    const pastBefore = history.bus.historySnapshot().past.length;
    dragTranslateX(composition, tip);
    const clip = timeline.state.selectedClip;
    if (clip === undefined) throw new Error("clip missing");
    expect(clip.tracks[0]?.keyframes).toHaveLength(2);
    const keyed = clip.tracks[0]?.keyframes.find(
      (keyframe) => keyframe.time === 0.5,
    );
    if (keyed === undefined) throw new Error("playhead keyframe missing");
    // The key captures the post-drag transform value.
    const afterAuto =
      composition.session.current?.store.getDocument().nodes[CHILD]?.transform
        .translation;
    if (afterAuto === undefined) throw new Error("missing moved transform");
    if (afterManual === undefined) throw new Error("missing manual transform");
    expect(keyed.property.channel).toBe("translation");
    expect(keyed.property.value[0]).toBe(afterAuto[0]);
    expect(afterAuto[0]).not.toBe(afterManual[0]);
    // One history entry for the whole drag (transform + key).
    expect(history.bus.historySnapshot().past.length).toBe(pastBefore + 1);

    // Undo restores the base transform and the key in one step.
    const undone = history.bus.undo({
      transactionId: transactionId("transaction:autokey-wire:undo"),
      expectedRevision: history.store.revision,
      source: "ui",
    });
    expect(undone.ok).toBe(true);
    const afterUndo =
      composition.session.current?.store.getDocument().nodes[CHILD]?.transform
        .translation;
    expect(afterUndo?.[0]).toBe(afterManual[0]);
    expect(timeline.state.selectedClip?.tracks[0]?.keyframes).toHaveLength(1);
    composition.dispose();
  });
});
