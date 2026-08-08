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
  setVoxelCommand,
} from "@voxel-maker/commands";
import { createDocumentStore } from "@voxel-maker/document";
import { MemoryProjectStorage } from "@voxel-maker/storage";
import { writeVxlProject } from "@voxel-maker/formats";
import {
  createDesktopComposition,
  type DesktopComposition,
  type FilePicker,
} from "../composition.js";

/**
 * Viewport controller tests (ticket #16): the composition seam between
 * DOM input, the deterministic picker, runtime selection, and overlays.
 * Everything runs headless through the real command path.
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:test:root");
const CHILD = nodeId("node:test:child");
const VOLUME = volumeId("volume:test:0001");

/** A project with a 4x4x4 box at world translation (2, 0, 0). */
function buildFixtureProject(): Uint8Array {
  const document = createDocument({
    documentId: documentId("document:test:0001"),
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
  pickSavePath(suggestedName) {
    return Promise.resolve(suggestedName);
  },
});

function openFixture(composition: DesktopComposition): void {
  const result = composition.fileService.openLoadedProject(
    "fixture.vxl",
    buildFixtureProject(),
  );
  if (!result.ok) {
    const error = result.error;
    throw new Error(
      `open failed: ${error === undefined ? "unknown" : error.code}`,
    );
  }
}

function boundsSegments(scene: THREE.Scene): THREE.LineSegments[] {
  const segments: THREE.LineSegments[] = [];
  const isBoundsSegment = (
    object: THREE.Object3D,
  ): object is THREE.LineSegments =>
    object instanceof THREE.LineSegments && object.renderOrder === 2;
  scene.traverse((object) => {
    if (isBoundsSegment(object)) segments.push(object);
  });
  return segments;
}

describe("viewport controller", () => {
  it("picks the fixture box through the center of the viewport", () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
    });
    openFixture(composition);
    composition.viewport.setViewportSize(800, 600);
    // Focus preserves the viewing direction, so pin a standard view first.
    composition.viewport.setStandardView("front");
    composition.viewport.focus();
    const hit = composition.viewport.pick(400, 300);
    expect(hit?.nodeId).toBe(CHILD);
    expect(hit?.volumeId).toBe(VOLUME);
    // The center ray passes exactly through the box center, so the
    // ADR-0005 tie-break resolves the boundary tie deterministically.
    // Voxel coordinates are volume-local (world voxel is [3, 1, 3]).
    expect(hit?.voxel).toEqual([1, 1, 3]);
    expect(hit?.face).toEqual([0, 0, 1]);
    expect(hit?.distance).toBeCloseTo(6.9146, 2);
    composition.dispose();
  });

  it("selects the picked node and clears selection on a miss", () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
    });
    openFixture(composition);
    composition.viewport.setViewportSize(800, 600);
    composition.viewport.focus();
    composition.viewport.selectAt(400, 300);
    expect(composition.editor.selection).toEqual([CHILD]);
    composition.viewport.selectAt(5, 5);
    expect(composition.editor.selection).toEqual([]);
    composition.dispose();
  });

  it("navigates: standard views, mode toggle, zoom, orbit, and focus", () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
    });
    openFixture(composition);
    const viewport = composition.viewport;
    viewport.setStandardView("front");
    expect(viewport.cameraState.direction).toEqual([0, 0, 1]);
    viewport.setStandardView("top");
    expect(viewport.cameraState.direction).toEqual([0, 1, 0]);
    // Orbiting at the pole rotates around the axis, so move off it first.
    viewport.setStandardView("front");
    const distanceBefore = viewport.cameraState.distance;
    viewport.zoomBy(1.1);
    expect(viewport.cameraState.distance).toBeLessThan(distanceBefore);
    viewport.orbit(10, 0);
    expect(viewport.cameraState.direction[0]).toBeLessThan(0);
    viewport.toggleMode();
    expect(viewport.camera).toBeInstanceOf(THREE.OrthographicCamera);
    viewport.toggleMode();
    expect(viewport.camera).toBeInstanceOf(THREE.PerspectiveCamera);
    viewport.focus();
    expect(viewport.cameraState.target).toEqual([4, 2, 2]);
    composition.dispose();
  });

  it("rebuilds the content bounds overlay after a commit", () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
    });
    openFixture(composition);
    const initial = boundsSegments(composition.renderer.scene);
    expect(initial).toHaveLength(1);
    expect(initial[0]?.position.x).toBe(4);

    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    const result = state.bus.execute(
      setVoxelCommand(commandId("command:test:set-far"), {
        volumeId: VOLUME,
        coordinate: [10, 10, 10],
        material: materialId(1),
      }),
      {
        transactionId: transactionId("transaction:test:set-far"),
        expectedRevision: state.revision,
        source: "ui",
      },
    );
    expect(result.ok).toBe(true);
    const updated = boundsSegments(composition.renderer.scene);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.position.x).toBe(7.5);
    expect(updated[0]?.position.y).toBe(5.5);
    expect(updated[0]?.position.z).toBe(5.5);
    composition.dispose();
  });

  it("removes document overlays when the document closes", () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
    });
    openFixture(composition);
    expect(boundsSegments(composition.renderer.scene)).toHaveLength(1);
    const result = composition.fileService.closeProject();
    expect(result.ok).toBe(true);
    expect(boundsSegments(composition.renderer.scene)).toHaveLength(0);
    composition.dispose();
  });

  it("toggles overlay visibility through the controller", () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(),
    });
    openFixture(composition);
    expect(composition.viewport.toggleOverlay("grid")).toBe(false);
    expect(composition.viewport.overlays.visible.grid).toBe(false);
    composition.viewport.setOverlay("grid", true);
    expect(composition.viewport.overlays.visible.grid).toBe(true);
    composition.dispose();
  });
});
