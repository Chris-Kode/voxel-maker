import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { documentId, materialId, nodeId, volumeId } from "@voxel-maker/shared";
import { createDocument } from "@voxel-maker/model";
import {
  createDocumentStore,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import type { Component } from "@voxel-maker/model";
import {
  chunkCoordinate,
  chunkIndex,
  chunkKey,
  localCoordinate,
  type VoxelChunkSeed,
} from "@voxel-maker/voxel";
import { createOverlayManager } from "./overlays.js";

/**
 * Overlay tests (plan S6.13, ticket #16): overlays are runtime-only
 * projections — nothing here mutates the store, and every assertion
 * checks scene object structure, visibility policy, and lifecycle
 * disposal.
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:overlay:root");
const BOX = nodeId("node:overlay:box");
const VOLUME = volumeId("volume:overlay:0001");

function boxSeeds(): VoxelChunkSeed[] {
  const chunks = new Map<
    string,
    { coordinate: [number, number, number]; values: Uint16Array }
  >();
  for (let z = 0; z < 4; z += 1) {
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        const coordinate: [number, number, number] = [x, y, z];
        const chunk: [number, number, number] = [
          ...chunkCoordinate(coordinate),
        ];
        const key = chunkKey(chunk);
        const existing = chunks.get(key);
        const values = existing?.values ?? new Uint16Array(4096);
        if (existing === undefined) {
          chunks.set(key, { coordinate: chunk, values });
        }
        values[chunkIndex(localCoordinate(coordinate))] = 1;
      }
    }
  }
  return [...chunks.values()].map(({ coordinate, values }) => ({
    coordinate,
    values,
  }));
}

function buildStore(boxComponents?: readonly Component[]): DocumentStoreRead {
  const document = createDocument({
    documentId: documentId("document:overlay:0001"),
    metadata: { title: "overlay fixture" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [BOX],
        transform: IDENTITY,
        components: [],
      },
      {
        nodeId: BOX,
        name: "Box",
        parentId: ROOT,
        children: [],
        transform: { ...IDENTITY, translation: [2, 0, 0] },
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: VOLUME },
          ...(boxComponents ?? []),
        ],
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
  const { store } = createDocumentStore({
    document,
    volumes: new Map([[VOLUME, boxSeeds()]]),
  });
  return store;
}

function objectsOfType(
  scene: THREE.Scene,
  type: new () => THREE.Object3D,
): THREE.Object3D[] {
  const found: THREE.Object3D[] = [];
  scene.traverse((object) => {
    if (object instanceof type) found.push(object);
  });
  return found;
}

describe("overlay manager", () => {
  it("creates non-persistent grid and axes helpers with the depth policy", () => {
    const scene = new THREE.Scene();
    const overlays = createOverlayManager(scene);
    expect(objectsOfType(scene, THREE.GridHelper)).toHaveLength(1);
    // Grid is depth-tested but never depth-writing (render-order 1).
    const grid = objectsOfType(scene, THREE.GridHelper)[0] as THREE.GridHelper;
    expect(grid.material.depthWrite).toBe(false);
    expect(grid.material.transparent).toBe(true);
    expect(grid.renderOrder).toBe(1);
    // Three axis lines, always on top (GridHelper is a LineSegments).
    const lines = objectsOfType(scene, THREE.Line).filter(
      (object): object is THREE.Line => !(object instanceof THREE.LineSegments),
    );
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect((line.material as THREE.LineBasicMaterial).depthTest).toBe(false);
      expect(line.renderOrder).toBe(3);
    }
    // No overlay is a Mesh, so mesh-based scene assertions stay valid.
    expect(objectsOfType(scene, THREE.Mesh)).toHaveLength(0);
    overlays.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it("projects content bounds from the store and removes them without a store", () => {
    const scene = new THREE.Scene();
    const overlays = createOverlayManager(scene);
    const store = buildStore();
    overlays.update(store, []);
    const boundsBoxes = objectsOfType(scene, THREE.LineSegments).filter(
      (object) => object.renderOrder === 2,
    );
    expect(boundsBoxes).toHaveLength(1);
    const box = boundsBoxes[0] as THREE.LineSegments;
    // World box [2,6] x [0,4] x [0,4].
    expect(box.position.x).toBe(4);
    expect(box.position.y).toBe(2);
    expect(box.position.z).toBe(2);

    overlays.update(undefined, []);
    expect(
      objectsOfType(scene, THREE.LineSegments).filter(
        (object) => object.renderOrder === 2,
      ),
    ).toHaveLength(0);
    overlays.dispose();
  });

  it("projects transform preview destination bounds and clears on cancel", () => {
    const scene = new THREE.Scene();
    const overlays = createOverlayManager(scene);
    const store = buildStore();
    // A pending rotate preview over the box volume (world x shifted +2
    // by the node translation).
    overlays.update(store, [], undefined, {
      operation: "rotate",
      axis: "z",
      quarterTurns: 1,
      entries: [
        {
          volumeId: VOLUME,
          source: { min: [0, 0, 0], max: [4, 4, 4] },
          destination: { min: [0, 0, 0], max: [4, 4, 4] },
        },
      ],
      movedVoxels: 64,
      overwrittenVoxels: 0,
      removedVoxels: 0,
    });
    const previewBoxes = objectsOfType(scene, THREE.LineSegments).filter(
      (object) =>
        object.renderOrder === 2 &&
        (
          (object as THREE.LineSegments).material as THREE.LineBasicMaterial
        ).color.getHex() === 0xff2d55,
    );
    expect(previewBoxes).toHaveLength(1);
    const box = previewBoxes[0] as THREE.LineSegments;
    // World destination box [2,6] x [0,4] x [0,4].
    expect(box.position.x).toBe(4);
    expect(box.position.y).toBe(2);
    expect(box.position.z).toBe(2);
    // Cancelling the preview removes the box without touching the scene
    // helpers.
    overlays.update(store, []);
    expect(
      objectsOfType(scene, THREE.LineSegments).filter(
        (object) =>
          object.renderOrder === 2 &&
          (
            (object as THREE.LineSegments).material as THREE.LineBasicMaterial
          ).color.getHex() === 0xff2d55,
      ),
    ).toHaveLength(0);
    overlays.dispose();
  });

  it("shows selection bounds and pivot markers for the selection", () => {
    const scene = new THREE.Scene();
    const overlays = createOverlayManager(scene);
    const store = buildStore();
    overlays.update(store, [{ kind: "node", nodeId: BOX }]);
    const lines = objectsOfType(scene, THREE.Line).filter(
      (object) => !(object instanceof THREE.LineSegments),
    );
    // 3 axis lines + 3 pivot marker lines.
    expect(lines).toHaveLength(6);
    // One pivot marker group at the box node's world pivot (2, 0, 0);
    // the axes group also has three line children, but sits at the origin.
    const pivotGroups: THREE.Group[] = [];
    const isPivotGroup = (object: THREE.Object3D): object is THREE.Group =>
      object instanceof THREE.Group &&
      object.children.length === 3 &&
      object.position.x === 2 &&
      object.position.y === 0 &&
      object.position.z === 0;
    scene.traverse((object) => {
      if (isPivotGroup(object)) pivotGroups.push(object);
    });
    expect(pivotGroups).toHaveLength(1);
    overlays.update(store, []);
    expect(
      objectsOfType(scene, THREE.Line).filter(
        (object) => !(object instanceof THREE.LineSegments),
      ),
    ).toHaveLength(3);
    overlays.dispose();
  });

  it("toggles visibility per overlay key", () => {
    const scene = new THREE.Scene();
    const overlays = createOverlayManager(scene);
    expect(overlays.visible).toEqual({
      grid: true,
      axes: true,
      bounds: true,
      pivots: true,
      joints: true,
    });
    expect(overlays.toggle("grid")).toBe(false);
    expect(
      (objectsOfType(scene, THREE.GridHelper)[0] as THREE.GridHelper).visible,
    ).toBe(false);
    overlays.setVisible("grid", true);
    expect(
      (objectsOfType(scene, THREE.GridHelper)[0] as THREE.GridHelper).visible,
    ).toBe(true);
    overlays.dispose();
  });

  it("shows joint ring markers for selected joint-annotated nodes", () => {
    const scene = new THREE.Scene();
    const overlays = createOverlayManager(scene);
    const store = buildStore([{ kind: "joint", schemaVersion: 1 }]);
    overlays.update(store, [{ kind: "node", nodeId: BOX }]);
    const rings = objectsOfType(scene, THREE.LineLoop);
    // One ring at the box node's world pivot (2, 0, 0).
    expect(rings).toHaveLength(1);
    const ring = rings[0] as THREE.LineLoop;
    expect(ring.position.x).toBe(2);
    expect(ring.position.y).toBe(0);
    expect(ring.position.z).toBe(0);
    expect((ring.material as THREE.LineBasicMaterial).depthTest).toBe(false);
    expect(ring.renderOrder).toBe(3);
    // Deselecting removes the ring.
    overlays.update(store, []);
    expect(objectsOfType(scene, THREE.LineLoop)).toHaveLength(0);
    overlays.dispose();
  });

  it("does not show joint rings for nodes without a joint annotation", () => {
    const scene = new THREE.Scene();
    const overlays = createOverlayManager(scene);
    const store = buildStore();
    overlays.update(store, [{ kind: "node", nodeId: BOX }]);
    expect(objectsOfType(scene, THREE.LineLoop)).toHaveLength(0);
    overlays.dispose();
  });

  it("does not mutate the store when updating overlays", () => {
    const scene = new THREE.Scene();
    const overlays = createOverlayManager(scene);
    const store = buildStore();
    const revisionBefore = store.revision;
    const documentBefore = store.getDocument();
    overlays.update(store, [{ kind: "node", nodeId: BOX }]);
    expect(store.revision).toBe(revisionBefore);
    expect(store.getDocument()).toBe(documentBefore);
    overlays.dispose();
  });
});
