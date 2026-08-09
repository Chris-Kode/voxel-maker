import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import {
  commandId,
  documentId,
  materialId,
  nodeId,
  transactionId,
  volumeId,
} from "@voxel-maker/shared";
import { canonicalColor, createDocument } from "@voxel-maker/model";
import {
  CommandBus,
  CommandRegistry,
  createMaterialCommand,
  deleteMaterialCommand,
  deleteNodeCommand,
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
} from "./composition.js";

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:test:root");
const CHILD = nodeId("node:test:child");
const VOLUME = volumeId("volume:test:0001");

/** Builds a project with a 4x4x4 filled box through the real command path. */
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
        transform: IDENTITY,
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

function createFakePicker(
  pickOpenPath: () => Promise<string | undefined>,
): FilePicker {
  return {
    pickOpenPath,
    pickSavePath(suggestedName) {
      return Promise.resolve(suggestedName);
    },
  };
}

type ProjectedMesh = THREE.Mesh<
  THREE.BufferGeometry,
  THREE.Material | THREE.Material[]
>;

function meshesOf(composition: DesktopComposition): ProjectedMesh[] {
  const meshes: ProjectedMesh[] = [];
  composition.renderer.scene.traverse((object) => {
    // The transform gizmo (ticket #20) is a permanent overlay whose
    // handles are meshes; projected content excludes it.
    if (
      object instanceof THREE.Mesh &&
      object.name !== "transform-gizmo-handle"
    ) {
      meshes.push(object as ProjectedMesh);
    }
  });
  return meshes;
}

describe("desktop composition root", () => {
  it("injects services without a global engine singleton", () => {
    const storage = new MemoryProjectStorage();
    const composition = createDesktopComposition({
      storage,
      picker: createFakePicker(() => Promise.resolve(undefined)),
    });
    expect(composition.session).toBeDefined();
    expect(composition.editor).toBeDefined();
    expect(composition.renderer.adapter).toBeDefined();
    expect(composition.fileService).toBeDefined();
    expect(composition.renderer.scene).toBeInstanceOf(THREE.Scene);
    composition.dispose();
  });

  it("creates a blank project and projects the root node", () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(() => Promise.resolve(undefined)),
    });
    const result = composition.fileService.newProject();
    expect(result.ok).toBe(true);
    expect(composition.session.current?.revision).toBe(0);
    expect(composition.renderer.adapter.nodeCount).toBe(1);
    expect(meshesOf(composition)).toHaveLength(0);
    composition.dispose();
  });

  it("opens a project, replaces the blank document, and projects chunks", () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(() => Promise.resolve(undefined)),
    });
    composition.fileService.newProject();
    const bytes = buildFixtureProject();
    const result = composition.fileService.openLoadedProject(
      "fixture.vxl",
      bytes,
    );
    expect(result.ok).toBe(true);
    expect(result.documentId).toBe("document:test:0001");
    expect(composition.session.current?.documentId).toBe("document:test:0001");
    expect(composition.renderer.adapter.nodeCount).toBe(2);
    expect(composition.renderer.adapter.chunkMeshCount).toBe(1);
    const boxGroup = composition.renderer.adapter.objectForNode(CHILD);
    expect(boxGroup).toBeDefined();
    const mesh = boxGroup?.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh,
    );
    expect(mesh).toBeDefined();
    if (mesh === undefined) throw new Error("missing chunk mesh");
    const positions = mesh.geometry.getAttribute("position");
    // 4x4x4 box = 6 faces per face-voxel => 6*16 faces * 4 verts = 384.
    expect(positions.count).toBe(384);
    composition.dispose();
  });

  it("disposes the previous projection when a document is replaced", () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(() => Promise.resolve(undefined)),
    });
    composition.fileService.newProject();
    composition.fileService.openLoadedProject(
      "fixture.vxl",
      buildFixtureProject(),
    );
    const boxGroup = composition.renderer.adapter.objectForNode(CHILD);
    const mesh = boxGroup?.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh,
    );
    if (mesh === undefined) throw new Error("missing chunk mesh");
    const dispose = vi.spyOn(mesh.geometry, "dispose");

    composition.fileService.newProject();
    expect(dispose).toHaveBeenCalled();
    expect(composition.renderer.adapter.chunkMeshCount).toBe(0);
    expect(meshesOf(composition)).toHaveLength(0);
    composition.dispose();
  });

  it("applies ordinary commits incrementally through the session bus", () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(() => Promise.resolve(undefined)),
    });
    composition.fileService.openLoadedProject(
      "fixture.vxl",
      buildFixtureProject(),
    );
    const boxGroup = composition.renderer.adapter.objectForNode(CHILD);
    const mesh = boxGroup?.children.find(
      (child): child is THREE.Mesh => child instanceof THREE.Mesh,
    );
    if (mesh === undefined) throw new Error("missing chunk mesh");
    const positions = mesh.geometry.getAttribute("position");
    expect(positions.count).toBe(384);

    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    const result = state.bus.execute(
      setVoxelCommand(commandId("command:test:set-isolated"), {
        volumeId: VOLUME,
        coordinate: [10, 10, 10],
        material: materialId(1),
      }),
      {
        transactionId: transactionId("transaction:test:set-isolated"),
        expectedRevision: state.revision,
        source: "ui",
      },
    );
    expect(result.ok).toBe(true);
    // The superseded geometry is disposed and a fresh mesh installed; an
    // isolated voxel adds 6 faces (24 verts) to the same chunk mesh.
    const freshMesh = composition.renderer.adapter
      .objectForNode(CHILD)
      ?.children.find(
        (child): child is THREE.Mesh => child instanceof THREE.Mesh,
      );
    expect(freshMesh?.geometry.getAttribute("position").count).toBe(408);
    void positions;
    expect(composition.session.current?.revision).toBe(1);
    composition.dispose();
  });

  it("disposes a deleted node subtree", () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(() => Promise.resolve(undefined)),
    });
    composition.fileService.openLoadedProject(
      "fixture.vxl",
      buildFixtureProject(),
    );
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    const result = state.bus.execute(
      deleteNodeCommand(commandId("command:test:delete"), {
        nodeId: CHILD,
      }),
      {
        transactionId: transactionId("transaction:test:delete"),
        expectedRevision: state.revision,
        source: "ui",
      },
    );
    expect(result.ok).toBe(true);
    expect(composition.renderer.adapter.objectForNode(CHILD)).toBeUndefined();
    expect(composition.renderer.adapter.chunkMeshCount).toBe(0);
    expect(meshesOf(composition)).toHaveLength(0);
    composition.dispose();
  });

  it("closing a document clears the scene through lifecycle events", () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(() => Promise.resolve(undefined)),
    });
    composition.fileService.openLoadedProject(
      "fixture.vxl",
      buildFixtureProject(),
    );
    expect(composition.renderer.adapter.chunkMeshCount).toBe(1);
    const result = composition.fileService.closeProject();
    expect(result.ok).toBe(true);
    expect(composition.session.current).toBeUndefined();
    expect(composition.renderer.adapter.chunkMeshCount).toBe(0);
    expect(meshesOf(composition)).toHaveLength(0);
    composition.dispose();
  });

  it("opens through the injected picker and storage port", async () => {
    const storage = new MemoryProjectStorage();
    const bytes = buildFixtureProject();
    await storage.writeProjectAtomic("picked.vxl", bytes);
    const composition = createDesktopComposition({
      storage,
      picker: createFakePicker(() => Promise.resolve("picked.vxl")),
    });
    const result = await composition.fileService.openProject();
    expect(result?.ok).toBe(true);
    expect(result?.path).toBe("picked.vxl");
    expect(composition.session.current?.documentId).toBe("document:test:0001");
    expect(composition.renderer.adapter.chunkMeshCount).toBe(1);
    composition.dispose();
  });

  it("defaults, prunes, and clears the active paint material", () => {
    const composition = createDesktopComposition({
      storage: new MemoryProjectStorage(),
      picker: createFakePicker(() => Promise.resolve(undefined)),
    });
    composition.fileService.openLoadedProject(
      "fixture.vxl",
      buildFixtureProject(),
    );
    // The lowest material id becomes the active material on open.
    expect(composition.editor.activeMaterial).toBe(materialId(1));

    // Deleting the active material (with a valid replacement) prunes it
    // from the runtime store and notifies.
    const state = composition.session.current;
    if (state === undefined) throw new Error("no open session");
    const created = state.bus.execute(
      createMaterialCommand(commandId("command:test:create-material"), {
        materialId: materialId(2),
        name: "blue",
        color: canonicalColor("#0000ff"),
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      }),
      {
        transactionId: transactionId("transaction:test:create-material"),
        expectedRevision: state.revision,
        source: "ui",
      },
    );
    expect(created.ok).toBe(true);
    const fresh = composition.session.current;
    if (fresh === undefined) throw new Error("no open session");
    const deleted = state.bus.execute(
      deleteMaterialCommand(commandId("command:test:delete-material"), {
        materialId: materialId(1),
        replacement: materialId(2),
      }),
      {
        transactionId: transactionId("transaction:test:delete-material"),
        // The session state revision is frozen at install; the store's
        // revision is live after the create commit above.
        expectedRevision: fresh.store.revision,
        source: "ui",
      },
    );
    expect(deleted.ok).toBe(true);
    expect(composition.editor.activeMaterial).toBeUndefined();
    expect(
      composition.editor.notices.some((notice) =>
        notice.message.includes("deleted"),
      ),
    ).toBe(true);

    // Closing the document keeps the runtime store empty.
    const closed = composition.fileService.closeProject();
    expect(closed.ok).toBe(true);
    expect(composition.editor.activeMaterial).toBeUndefined();
    composition.dispose();
  });
});
