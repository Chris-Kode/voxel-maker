import { describe, expect, it } from "vitest";
import {
  animationId,
  componentId,
  keyframeId,
  materialId,
  nodeId,
  trackId,
  volumeId,
  type VolumeId,
} from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import { createDocumentStore } from "@voxel-maker/document";
import type { VoxelChunkSeed } from "@voxel-maker/voxel";
import { GLTF_EXPORT_LOSSES, type GltfExportLimits } from "./gltf-types.js";
import {
  planGltfExport,
  preflightGltfExport,
  sanitizeGltfName,
} from "./gltf-mapping.js";

/**
 * Document -> glTF mapping (plan S16.1-S16.3, ticket #41): preflight loss
 * reports and the deterministic scene-graph plan (hierarchy, pivot helper
 * chains, mesh dedup, material mapping, deterministic names).
 */

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:gltf:root");
const BODY = nodeId("node:gltf:body");
const ARM = nodeId("node:gltf:arm");
const VOLUME_BODY = volumeId("volume:gltf:body");
const VOLUME_ARM = volumeId("volume:gltf:arm");

function buildDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:gltf:0001" as never,
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [BODY, ARM],
        transform: identity,
        components: [],
      },
      {
        nodeId: BODY,
        name: "Body",
        parentId: ROOT,
        children: [],
        transform: {
          translation: [0, 2, 0],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: VOLUME_BODY },
        ],
      },
      {
        nodeId: ARM,
        name: "Arm",
        parentId: ROOT,
        children: [],
        transform: {
          translation: [1, 3, 0],
          pivot: [0, 1, 0],
          rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
          scale: [2, 1, 1],
        },
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME_ARM }],
      },
    ],
    materials: [
      {
        materialId: materialId(2),
        name: "green",
        color: "#00ff00",
        opacity: 0.5,
        roughness: 0.3,
        metallic: 0.7,
        emissive: 0.25,
      },
      {
        materialId: materialId(1),
        name: "red",
        color: "#ff0000",
        opacity: 1,
        roughness: 0,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      { volumeId: VOLUME_BODY, name: "Body voxels" },
      { volumeId: VOLUME_ARM },
    ],
  });
}

function storeWithEntries(
  document: VoxelDocument,
  entries: ReadonlyMap<
    VolumeId,
    readonly { coordinate: [number, number, number]; material: number }[]
  >,
) {
  const volumes = new Map<VolumeId, readonly VoxelChunkSeed[]>();
  for (const [id, list] of entries) {
    const chunks = new Map<string, VoxelChunkSeed>();
    for (const entry of list) {
      const [x, y, z] = entry.coordinate;
      const cx = Math.floor(x / 16);
      const cy = Math.floor(y / 16);
      const cz = Math.floor(z / 16);
      const key = `${String(cx)},${String(cy)},${String(cz)}`;
      const chunk = chunks.get(key) ?? {
        coordinate: [cx, cy, cz] as [number, number, number],
        values: new Uint16Array(4096),
      };
      const lx = ((x % 16) + 16) % 16;
      const ly = ((y % 16) + 16) % 16;
      const lz = ((z % 16) + 16) % 16;
      chunk.values[lx + 16 * (ly + 16 * lz)] = entry.material;
      chunks.set(key, chunk);
    }
    volumes.set(id, [...chunks.values()]);
  }
  return createDocumentStore({ document, volumes }).store;
}

const fullStore = (document: VoxelDocument) =>
  storeWithEntries(
    document,
    new Map([
      [VOLUME_BODY, [{ coordinate: [0, 0, 0], material: 1 }]],
      [VOLUME_ARM, [{ coordinate: [1, 1, 1], material: 2 }]],
    ]),
  );

describe("sanitizeGltfName", () => {
  it("removes control characters and trims", () => {
    expect(sanitizeGltfName("  Arm\u0000body  ")).toBe("Armbody");
    expect(sanitizeGltfName("\u0001\u0002")).toBeUndefined();
    expect(sanitizeGltfName(undefined)).toBeUndefined();
  });
});

describe("preflightGltfExport", () => {
  it("blocks when the document has no voxel volumes", () => {
    const document = createDocument({
      documentId: "document:gltf:0002" as never,
      rootNodeId: ROOT,
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [],
          transform: identity,
          components: [],
        },
      ],
      materials: [],
      volumes: [],
    });
    const result = preflightGltfExport(document, () => undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.blocked[0]?.code).toBe(GLTF_EXPORT_LOSSES.noVolumes);
  });

  it("blocks when a referenced volume is missing from the store", () => {
    const document = buildDocument();
    const result = preflightGltfExport(document, () => undefined);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(
      result.blocked.some(
        (loss) => loss.code === GLTF_EXPORT_LOSSES.missingVolume,
      ),
    ).toBe(true);
  });

  it("reports clips, constraints, joints, and metadata as bake losses", () => {
    const document: VoxelDocument = {
      ...buildDocument(),
      metadata: { title: "fixture" },
      animations: {
        [animationId("animation:gltf:spin")]: {
          animationId: animationId("animation:gltf:spin"),
          name: "Spin",
          duration: 1,
          loop: "once",
          tracks: [
            {
              trackId: trackId("track:gltf:spin"),
              targetNodeId: BODY,
              interpolation: "linear",
              keyframes: [
                {
                  keyframeId: keyframeId("key:gltf:spin:0"),
                  time: 0,
                  property: {
                    channel: "rotation",
                    value: [0, 0, 0, 1],
                  },
                },
              ],
            },
          ],
        },
      },
      nodes: {
        ...buildDocument().nodes,
        [BODY]: {
          ...buildDocument().nodes[BODY],
          metadata: { note: "hello" },
          components: [
            { kind: "voxel", schemaVersion: 1, volumeId: VOLUME_BODY },
            { kind: "joint", schemaVersion: 1 },
            {
              kind: "constraint",
              schemaVersion: 1,
              constraints: [
                {
                  componentId: componentId("component:gltf:limit"),
                  type: "rotation-limits",
                  limits: { min: [0, 0, 0], max: [0, 0, 1] },
                },
              ],
            },
          ],
        },
      },
    };
    const store = fullStore(buildDocument());
    const result = preflightGltfExport(document, (id) => store.getVolume(id));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const codes = new Set(result.losses.map((loss) => loss.code));
    expect(codes.has(GLTF_EXPORT_LOSSES.clips)).toBe(true);
    expect(codes.has(GLTF_EXPORT_LOSSES.constraints)).toBe(true);
    expect(codes.has(GLTF_EXPORT_LOSSES.joints)).toBe(true);
    expect(codes.has(GLTF_EXPORT_LOSSES.metadata)).toBe(true);
  });

  it("reports empty volumes as a bake loss", () => {
    const document = buildDocument();
    const store = storeWithEntries(
      document,
      new Map([[VOLUME_BODY, [{ coordinate: [0, 0, 0], material: 1 }]]]),
    );
    const result = preflightGltfExport(document, (id) => store.getVolume(id));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.losses.some(
        (loss) => loss.code === GLTF_EXPORT_LOSSES.emptyVolume,
      ),
    ).toBe(true);
  });

  it("passes a clean document without losses", () => {
    const document = buildDocument();
    const store = fullStore(document);
    const result = preflightGltfExport(document, (id) => store.getVolume(id));
    expect(result).toEqual({ ok: true, losses: [] });
  });
});

describe("planGltfExport", () => {
  const okPreflight = { ok: true as const, losses: [] };

  it("maps nodes, hierarchy, transforms, meshes, and materials deterministically", () => {
    const document = buildDocument();
    const store = fullStore(document);
    const plan = planGltfExport(
      document,
      (id) => store.getVolume(id),
      okPreflight,
    );
    // Root + Body + Arm chains; Arm has a pivot so its chain has 3 nodes.
    // Canonical node-id order: node:gltf:arm, node:gltf:body, node:gltf:root.
    expect(plan.nodes.map((node) => node.name)).toEqual([
      "Arm",
      "Arm pivot",
      "Arm pivot offset",
      "Body",
      "Root",
    ]);
    expect(plan.sceneNodes).toEqual([4]);
    const arm = plan.nodes[0];
    expect(arm?.translation).toEqual([1, 3, 0]);
    const pivot = plan.nodes[1];
    expect(pivot?.translation).toEqual([0, 1, 0]);
    expect(pivot?.rotation).toEqual([0, 0, Math.SQRT1_2, Math.SQRT1_2]);
    expect(pivot?.scale).toEqual([2, 1, 1]);
    expect(pivot?.children).toEqual([2]);
    const offset = plan.nodes[2];
    expect(offset?.translation).toEqual([0, -1, 0]);
    expect(offset?.mesh).toBe(0);
    const body = plan.nodes[3];
    expect(body?.translation).toEqual([0, 2, 0]);
    expect(body?.mesh).toBe(1);
    const root = plan.nodes[4];
    expect(root?.children).toEqual([3, 0]);
    // Meshes: arm first, then body (canonical node-id order of first use).
    expect(plan.meshes.map((mesh) => mesh.name)).toEqual([
      "Arm",
      "Body voxels",
    ]);
    // Materials: ascending material-id order (1 then 2).
    expect(plan.materials.map((material) => material.name)).toEqual([
      "red",
      "green",
    ]);
    expect(plan.materials[0]).toEqual({
      name: "red",
      baseColorFactor: [1, 0, 0, 1],
      metallicFactor: 0,
      roughnessFactor: 0,
      emissiveFactor: [0, 0, 0],
      alphaMode: "OPAQUE",
    });
    expect(plan.materials[1]).toEqual({
      name: "green",
      baseColorFactor: [0, 1, 0, 0.5],
      metallicFactor: 0.7,
      roughnessFactor: 0.3,
      emissiveFactor: [0.25, 0.25, 0.25],
      alphaMode: "BLEND",
    });
    // Primitives reference material indices.
    const armMesh = plan.meshes[0];
    expect(armMesh?.primitives[0]?.materialIndex).toBe(1);
    expect(plan.metadata.pivotHelpers).toEqual([
      {
        nodeId: ARM,
        name: "Arm",
        helperNodes: ["Arm pivot", "Arm pivot offset"],
      },
    ]);
  });

  it("deduplicates one mesh shared by two nodes", () => {
    const shared = createDocument({
      documentId: "document:gltf:0003" as never,
      rootNodeId: ROOT,
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [BODY, ARM],
          transform: identity,
          components: [],
        },
        {
          nodeId: BODY,
          name: "Left",
          parentId: ROOT,
          children: [],
          transform: identity,
          components: [
            { kind: "voxel", schemaVersion: 1, volumeId: VOLUME_BODY },
          ],
        },
        {
          nodeId: ARM,
          name: "Right",
          parentId: ROOT,
          children: [],
          transform: identity,
          components: [
            { kind: "voxel", schemaVersion: 1, volumeId: VOLUME_BODY },
          ],
        },
      ],
      materials: [
        {
          materialId: materialId(1),
          name: "red",
          color: "#ff0000",
          opacity: 1,
          roughness: 0,
          metallic: 0,
          emissive: 0,
        },
      ],
      volumes: [{ volumeId: VOLUME_BODY, name: "Shared voxels" }],
    });
    const store = storeWithEntries(
      shared,
      new Map([[VOLUME_BODY, [{ coordinate: [0, 0, 0], material: 1 }]]]),
    );
    const plan = planGltfExport(
      shared,
      (id) => store.getVolume(id),
      okPreflight,
    );
    expect(plan.meshes).toHaveLength(1);
    expect(plan.meshes[0]?.name).toBe("Shared voxels");
    // Canonical order: "Right" (node:gltf:arm) then "Left" (node:gltf:body).
    expect(plan.nodes.map((node) => node.name)).toEqual([
      "Right",
      "Left",
      "Root",
    ]);
    expect(plan.nodes[0]?.mesh).toBe(0);
    expect(plan.nodes[1]?.mesh).toBe(0);
  });

  it("makes sanitized and colliding names unique deterministically", () => {
    const document = createDocument({
      documentId: "document:gltf:0004" as never,
      rootNodeId: ROOT,
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [BODY, ARM],
          transform: identity,
          components: [],
        },
        {
          nodeId: BODY,
          name: "Part",
          parentId: ROOT,
          children: [],
          transform: identity,
          components: [
            { kind: "voxel", schemaVersion: 1, volumeId: VOLUME_BODY },
          ],
        },
        {
          nodeId: ARM,
          name: "Part\u0000",
          parentId: ROOT,
          children: [],
          transform: identity,
          components: [
            { kind: "voxel", schemaVersion: 1, volumeId: VOLUME_ARM },
          ],
        },
      ],
      materials: [
        {
          materialId: materialId(1),
          name: "mat",
          color: "#ff0000",
          opacity: 1,
          roughness: 0,
          metallic: 0,
          emissive: 0,
        },
        {
          materialId: materialId(2),
          name: "mat",
          color: "#00ff00",
          opacity: 1,
          roughness: 0,
          metallic: 0,
          emissive: 0,
        },
      ],
      volumes: [{ volumeId: VOLUME_BODY }, { volumeId: VOLUME_ARM }],
    });
    const store = fullStore(document);
    const plan = planGltfExport(
      document,
      (id) => store.getVolume(id),
      okPreflight,
    );
    // Canonical order: node:gltf:arm ("Part" -> collision suffix) first.
    expect(plan.nodes.map((node) => node.name)).toEqual([
      "Part",
      "Part-2",
      "Root",
    ]);
    expect(plan.materials.map((material) => material.name)).toEqual([
      "mat",
      "mat-2",
    ]);
  });

  it("enforces the total face limit with a structured error", () => {
    const document = buildDocument();
    const store = fullStore(document);
    const limits: GltfExportLimits = {
      maxFacesPerVolume: 1_000_000,
      maxTotalFaces: 10,
      maxTotalBytes: 1024,
    };
    expectGltfError(
      () =>
        planGltfExport(
          document,
          (id) => store.getVolume(id),
          okPreflight,
          limits,
        ),
      "limit",
      "GLTF_FACE_LIMIT",
    );
  });

  it("omits empty volumes and keeps the loss report", () => {
    const document = buildDocument();
    const store = storeWithEntries(
      document,
      new Map([[VOLUME_BODY, [{ coordinate: [0, 0, 0], material: 1 }]]]),
    );
    const preflight = preflightGltfExport(document, (id) =>
      store.getVolume(id),
    );
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const plan = planGltfExport(
      document,
      (id) => store.getVolume(id),
      preflight,
    );
    expect(plan.meshes).toHaveLength(1);
    expect(plan.metadata.voxels).toBe(1);
    expect(
      plan.losses.some((loss) => loss.code === GLTF_EXPORT_LOSSES.emptyVolume),
    ).toBe(true);
  });
});

/** Asserts that `fn` throws a WorkspaceError with the exact family/code. */
function expectGltfError(
  fn: () => unknown,
  family: string,
  code: string,
): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === undefined) {
    throw new Error(`Expected ${family}/${code}, but nothing was thrown`);
  }
  const actual =
    typeof thrown === "object" && thrown !== null
      ? (thrown as { family?: unknown; code?: unknown })
      : {};
  if (actual.family === family && actual.code === code) return;
  throw new Error(
    `Expected ${family}/${code}, got ${String(actual.family)}/${String(
      actual.code,
    )}`,
  );
}
