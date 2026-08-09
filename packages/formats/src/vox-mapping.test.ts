import { describe, expect, it } from "vitest";
import { materialId, nodeId, volumeId } from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import {
  createDocumentStore,
  type DocumentStoreHandle,
} from "@voxel-maker/document";
import {
  mapVoxImport,
  planVoxExport,
  preflightVoxExport,
  type VoxImportIdFactory,
} from "./vox-mapping.js";
import { encodeVox, parseVox } from "./vox.js";
import type { VoxColor, VoxModel, VoxParseResult } from "./vox-types.js";

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ids: VoxImportIdFactory = {
  nodeId: (index) =>
    nodeId(`node:import:${String(index + 1).padStart(4, "0")}`),
  volumeId: (index) =>
    volumeId(`volume:import:${String(index + 1).padStart(4, "0")}`),
  materialId: (colorIndex) => materialId(colorIndex),
};

const palette: VoxColor[] = [
  { r: 0, g: 0, b: 0, a: 0 },
  { r: 255, g: 0, b: 0, a: 255 },
  { r: 0, g: 255, b: 0, a: 128 },
  ...Array.from({ length: 253 }, () => ({ r: 0, g: 0, b: 0, a: 255 })),
];

function parsedModel(): VoxParseResult {
  const model: VoxModel = {
    sizeX: 2,
    sizeY: 3,
    sizeZ: 4,
    voxels: [
      { x: 1, y: 2, z: 3, colorIndex: 1 },
      { x: 0, y: 0, z: 0, colorIndex: 2 },
    ],
  };
  return parseVox(encodeVox({ models: [model], palette }));
}

describe("mapVoxImport", () => {
  it("maps axes (vox x, vox y, vox z) -> (X, Y, Z) = (x, z, -y)", () => {
    const plan = mapVoxImport(parsedModel(), ids);
    expect(plan.nodes).toHaveLength(1);
    expect(plan.nodes[0]).toEqual({
      nodeId: "node:import:0001",
      name: "Model 1",
      volumeId: "volume:import:0001",
    });
    const volume = plan.volumes[0];
    expect(volume?.name).toBe("Model 1");
    expect(volume?.bounds).toEqual({ min: [0, 0, -2], max: [2, 4, 1] });
    expect(volume?.entries).toEqual([
      { coordinate: [0, 0, 0], material: materialId(2) },
      { coordinate: [1, 3, -2], material: materialId(1) },
    ]);
  });

  it("maps palette entries to materials with colors and alpha opacity", () => {
    const plan = mapVoxImport(parsedModel(), ids);
    expect(plan.materials).toEqual([
      {
        materialId: materialId(1),
        name: "Palette 1",
        color: "#ff0000",
        opacity: 1,
      },
      {
        materialId: materialId(2),
        name: "Palette 2",
        color: "#00ff00",
        opacity: 128 / 255,
      },
    ]);
  });

  it("produces empty volumes for empty models", () => {
    const empty: VoxModel = { sizeX: 1, sizeY: 1, sizeZ: 1, voxels: [] };
    const parsed = parseVox(encodeVox({ models: [empty], palette }));
    const plan = mapVoxImport(parsed, ids);
    expect(plan.volumes[0]?.entries).toEqual([]);
    expect(plan.volumes[0]?.bounds).toEqual({
      min: [0, 0, 0],
      max: [0, 0, 0],
    });
  });

  it("maps multiple models to separate root nodes", () => {
    const model: VoxModel = {
      sizeX: 1,
      sizeY: 1,
      sizeZ: 1,
      voxels: [{ x: 0, y: 0, z: 0, colorIndex: 1 }],
    };
    const parsed = parseVox(encodeVox({ models: [model, model], palette }));
    const plan = mapVoxImport(parsed, ids);
    expect(plan.nodes).toHaveLength(2);
    expect(plan.nodes.map((node) => node.name)).toEqual(["Model 1", "Model 2"]);
  });

  it("warns when the declared model cube exceeds the occupied bounds", () => {
    // A 10x10x10 declared cube holding one voxel: the empty space is not
    // preserved on re-export, and the import must say so explicitly.
    const model: VoxModel = {
      sizeX: 10,
      sizeY: 10,
      sizeZ: 10,
      voxels: [{ x: 3, y: 4, z: 5, colorIndex: 1 }],
    };
    const parsed = parseVox(encodeVox({ models: [model], palette }));
    const plan = mapVoxImport(parsed, ids);
    expect(plan.warnings.some((w) => w.code === "VOX_MODEL_CUBE_TRIMMED")).toBe(
      true,
    );
    expect(plan.volumes[0]?.bounds).toEqual({
      min: [3, 5, -4],
      max: [4, 6, -3],
    });
  });

  it("carries parser warnings into the plan", () => {
    // A raw VOX file without an RGBA chunk triggers the default-palette
    // warning, which must pass through the mapping.
    const model: VoxModel = {
      sizeX: 1,
      sizeY: 1,
      sizeZ: 1,
      voxels: [{ x: 0, y: 0, z: 0, colorIndex: 1 }],
    };
    const parsed = parseVox(rawVoxWithoutRgba(model));
    const plan = mapVoxImport(parsed, ids);
    expect(
      plan.warnings.some((w) => w.code === "VOX_DEFAULT_PALETTE_USED"),
    ).toBe(true);
  });
});

function storeWithVolumes(
  document: VoxelDocument,
  volumes: ReadonlyMap<
    import("@voxel-maker/shared").VolumeId,
    readonly {
      readonly coordinate: [number, number, number];
      readonly material: number;
    }[]
  >,
): DocumentStoreHandle {
  const seeds = new Map<
    import("@voxel-maker/shared").VolumeId,
    import("@voxel-maker/voxel").VoxelChunkSeed[]
  >();
  for (const [volumeIdValue, entries] of volumes) {
    const chunks = new Map<
      string,
      import("@voxel-maker/voxel").VoxelChunkSeed
    >();
    for (const entry of entries) {
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
    seeds.set(volumeIdValue, [...chunks.values()]);
  }
  return createDocumentStore({ document, volumes: seeds });
}

const ROOT = nodeId("node:export:root");
const VOLUME_A = volumeId("volume:export:a");

function exportDocument(): VoxelDocument {
  return createDocument({
    documentId: "document:export:0001" as never,
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [nodeId("node:export:a")],
        transform: identity,
        components: [],
      },
      {
        nodeId: nodeId("node:export:a"),
        name: "Model A",
        parentId: ROOT,
        children: [],
        transform: identity,
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME_A }],
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
    volumes: [{ volumeId: VOLUME_A }],
  });
}

function exportHarness(
  document: VoxelDocument,
  volumeEntries: readonly {
    readonly volumeId: import("@voxel-maker/shared").VolumeId;
    readonly entries: readonly {
      readonly coordinate: [number, number, number];
      readonly material: number;
    }[];
  }[],
): { handle: DocumentStoreHandle; document: VoxelDocument } {
  const handle = storeWithVolumes(
    document,
    new Map(volumeEntries.map((v) => [v.volumeId, v.entries])),
  );
  return { handle, document };
}

describe("preflightVoxExport", () => {
  it("accepts identity-transformed root volumes with non-negative bounds", () => {
    const { handle, document } = exportHarness(exportDocument(), [
      {
        volumeId: VOLUME_A,
        entries: [
          { coordinate: [1, 2, -3], material: 1 },
          { coordinate: [4, 5, -6], material: 1 },
        ],
      },
    ]);
    const result = preflightVoxExport(document, (id) =>
      handle.store.getVolume(id),
    );
    expect(result.ok).toBe(true);
  });

  it("blocks non-identity transforms", () => {
    const document = exportDocument();
    const moved: VoxelDocument = {
      ...document,
      nodes: {
        ...document.nodes,
        [nodeId("node:export:a")]: {
          ...document.nodes[nodeId("node:export:a")],
          transform: {
            translation: [1, 0, 0],
            pivot: [0, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1],
          },
        },
      },
    };
    const { handle } = exportHarness(moved, [
      { volumeId: VOLUME_A, entries: [{ coordinate: [1, 2, 3], material: 1 }] },
    ]);
    const result = preflightVoxExport(moved, (id) =>
      handle.store.getVolume(id),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.blocked.some((loss) => loss.code === "VOX_LOSS_TRANSFORM"),
      ).toBe(true);
    }
  });

  it("blocks nested voxel volumes unless flattenHierarchy is chosen", () => {
    const nested: VoxelDocument = createDocument({
      documentId: "document:export:0002" as never,
      rootNodeId: ROOT,
      nodes: [
        {
          nodeId: ROOT,
          name: "Root",
          parentId: null,
          children: [nodeId("node:export:child")],
          transform: identity,
          components: [],
        },
        {
          nodeId: nodeId("node:export:child"),
          name: "Child",
          parentId: ROOT,
          children: [nodeId("node:export:a")],
          transform: identity,
          components: [],
        },
        {
          nodeId: nodeId("node:export:a"),
          name: "Model A",
          parentId: nodeId("node:export:child"),
          children: [],
          transform: identity,
          components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME_A }],
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
      volumes: [{ volumeId: VOLUME_A }],
    });
    const { handle } = exportHarness(nested, [
      {
        volumeId: VOLUME_A,
        entries: [{ coordinate: [1, 2, -3], material: 1 }],
      },
    ]);
    const blocked = preflightVoxExport(nested, (id) =>
      handle.store.getVolume(id),
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(
        blocked.blocked.some((loss) => loss.code === "VOX_LOSS_HIERARCHY"),
      ).toBe(true);
    }
    const flattened = preflightVoxExport(
      nested,
      (id) => handle.store.getVolume(id),
      { flattenHierarchy: true },
    );
    expect(flattened.ok).toBe(true);
    if (flattened.ok) {
      expect(
        flattened.losses.some((loss) => loss.code === "VOX_LOSS_HIERARCHY"),
      ).toBe(true);
    }
  });

  it("blocks negative origins unless rebaseOrigins is chosen", () => {
    const { handle, document } = exportHarness(exportDocument(), [
      {
        volumeId: VOLUME_A,
        entries: [{ coordinate: [-2, 2, 3], material: 1 }],
      },
    ]);
    const blocked = preflightVoxExport(document, (id) =>
      handle.store.getVolume(id),
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(
        blocked.blocked.some((loss) => loss.code === "VOX_LOSS_ORIGIN"),
      ).toBe(true);
    }
    const rebased = preflightVoxExport(
      document,
      (id) => handle.store.getVolume(id),
      { rebaseOrigins: true },
    );
    expect(rebased.ok).toBe(true);
  });

  it("blocks dimensions beyond 256 per axis", () => {
    const { handle, document } = exportHarness(exportDocument(), [
      {
        volumeId: VOLUME_A,
        entries: [
          { coordinate: [0, 0, 0], material: 1 },
          { coordinate: [300, 0, 0], material: 1 },
        ],
      },
    ]);
    const result = preflightVoxExport(document, (id) =>
      handle.store.getVolume(id),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.blocked.some((loss) => loss.code === "VOX_LOSS_DIMENSIONS"),
      ).toBe(true);
    }
  });

  it("reports material semantics as losses", () => {
    const document = exportDocument();
    const shiny: VoxelDocument = {
      ...document,
      materials: {
        ...document.materials,
        [materialId(1)]: {
          materialId: materialId(1),
          name: "red",
          color: "#ff0000",
          opacity: 0.5,
          roughness: 0.8,
          metallic: 0.2,
          emissive: 0.1,
        },
      },
    };
    const { handle } = exportHarness(shiny, [
      {
        volumeId: VOLUME_A,
        entries: [{ coordinate: [1, 2, -3], material: 1 }],
      },
    ]);
    const result = preflightVoxExport(shiny, (id) =>
      handle.store.getVolume(id),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        result.losses.some(
          (loss) => loss.code === "VOX_LOSS_MATERIAL_SEMANTICS",
        ),
      ).toBe(true);
    }
  });

  it("blocks more than 255 distinct colors", () => {
    const document = exportDocument();
    const materials = Object.fromEntries(
      Array.from({ length: 256 }, (_, i) => {
        const id = materialId(i + 1);
        const channel = (value: number): string =>
          value.toString(16).padStart(2, "0");
        const color = `#${channel(i)}${channel(255 - i)}${channel((i * 7) % 256)}`;
        return [
          String(id),
          {
            materialId: id,
            name: `m${String(i)}`,
            color,
            opacity: 1,
            roughness: 0,
            metallic: 0,
            emissive: 0,
          },
        ];
      }),
    );
    const many: VoxelDocument = {
      ...document,
      materials: { ...document.materials, ...materials },
    };
    const entries = Array.from({ length: 256 }, (_, i) => ({
      coordinate: [i, 0, 0] as [number, number, number],
      material: i + 1,
    }));
    const { handle } = exportHarness(many, [{ volumeId: VOLUME_A, entries }]);
    const result = preflightVoxExport(many, (id) => handle.store.getVolume(id));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.blocked.some((loss) => loss.code === "VOX_LOSS_COLOR_LIMIT"),
      ).toBe(true);
    }
  });

  it("blocks documents without voxel volumes", () => {
    const bare: VoxelDocument = createDocument({
      documentId: "document:export:0003" as never,
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
    const { handle } = exportHarness(bare, []);
    const result = preflightVoxExport(bare, (id) => handle.store.getVolume(id));
    expect(result.ok).toBe(false);
  });
});

describe("planVoxExport", () => {
  it("maps axes back to VOX space and assigns palette indices", () => {
    const { handle, document } = exportHarness(exportDocument(), [
      {
        volumeId: VOLUME_A,
        entries: [
          // editor (X, Y, Z) -> vox (X - minX, -(Z - minZ), Y - minY)
          { coordinate: [2, 3, -4], material: 1 },
          { coordinate: [5, 6, -7], material: 1 },
        ],
      },
    ]);
    const preflight = preflightVoxExport(document, (id) =>
      handle.store.getVolume(id),
    );
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const plan = planVoxExport(
      document,
      (id) => handle.store.getVolume(id),
      preflight,
    );
    expect(plan.models).toHaveLength(1);
    const model = plan.models[0];
    // Vox space: (2, 4, 3) and (5, 7, 6). Without rebasing, the model cube
    // spans from 0: sizes 6 x 8 x 7 with empty space below the voxels.
    expect(model?.sizeX).toBe(6);
    expect(model?.sizeY).toBe(8);
    expect(model?.sizeZ).toBe(7);
    expect(model?.voxels).toEqual([
      { x: 2, y: 4, z: 3, colorIndex: 1 },
      { x: 5, y: 7, z: 6, colorIndex: 1 },
    ]);
    expect(plan.palette[1]).toEqual({ r: 255, g: 0, b: 0, a: 255 });
  });

  it("rebases origins when chosen", () => {
    const { handle, document } = exportHarness(exportDocument(), [
      {
        volumeId: VOLUME_A,
        entries: [
          { coordinate: [-2, 3, -4], material: 1 },
          { coordinate: [-1, 5, -3], material: 1 },
        ],
      },
    ]);
    const preflight = preflightVoxExport(
      document,
      (id) => handle.store.getVolume(id),
      { rebaseOrigins: true },
    );
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const plan = planVoxExport(
      document,
      (id) => handle.store.getVolume(id),
      preflight,
      { rebaseOrigins: true },
    );
    const model = plan.models[0];
    // Vox space: (-2, 4, 3) and (-1, 3, 5); min (-2, 3, 3); rebase maps
    // them to (0, 1, 0) and (1, 0, 2); sizes 2 x 2 x 3.
    expect(model?.sizeX).toBe(2);
    expect(model?.sizeY).toBe(2);
    expect(model?.sizeZ).toBe(3);
    expect(model?.voxels).toEqual([
      { x: 0, y: 1, z: 0, colorIndex: 1 },
      { x: 1, y: 0, z: 2, colorIndex: 1 },
    ]);
  });

  it("maps opacity to palette alpha", () => {
    const document = exportDocument();
    const translucent: VoxelDocument = {
      ...document,
      materials: {
        ...document.materials,
        [materialId(1)]: {
          materialId: materialId(1),
          name: "red",
          color: "#ff0000",
          opacity: 0.5,
          roughness: 0,
          metallic: 0,
          emissive: 0,
        },
      },
    };
    const { handle } = exportHarness(translucent, [
      {
        volumeId: VOLUME_A,
        entries: [{ coordinate: [1, 2, -3], material: 1 }],
      },
    ]);
    const preflight = preflightVoxExport(translucent, (id) =>
      handle.store.getVolume(id),
    );
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    const plan = planVoxExport(
      translucent,
      (id) => handle.store.getVolume(id),
      preflight,
    );
    expect(plan.palette[1]?.a).toBe(128);
  });
});

/** Builds a minimal raw VOX file (no RGBA chunk) for one model. */
function rawVoxWithoutRgba(model: VoxModel): Uint8Array {
  const header = new Uint8Array(8);
  const headerView = new DataView(header.buffer);
  for (let i = 0; i < 4; i += 1) headerView.setUint8(i, "VOX ".charCodeAt(i));
  headerView.setUint32(4, 150, true);
  const sizeContent = new Uint8Array(12);
  const sizeView = new DataView(sizeContent.buffer);
  sizeView.setUint32(0, model.sizeX, true);
  sizeView.setUint32(4, model.sizeY, true);
  sizeView.setUint32(8, model.sizeZ, true);
  const xyzContent = new Uint8Array(4 + model.voxels.length * 4);
  const xyzView = new DataView(xyzContent.buffer);
  xyzView.setUint32(0, model.voxels.length, true);
  model.voxels.forEach((voxel, index) => {
    const offset = 4 + index * 4;
    xyzView.setUint8(offset, voxel.x);
    xyzView.setUint8(offset + 1, voxel.y);
    xyzView.setUint8(offset + 2, voxel.z);
    xyzView.setUint8(offset + 3, voxel.colorIndex);
  });
  const chunk = (id: string, content: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + content.length);
    const view = new DataView(out.buffer);
    for (let i = 0; i < 4; i += 1) view.setUint8(i, id.charCodeAt(i));
    view.setUint32(4, content.length, true);
    view.setUint32(8, 0, true);
    out.set(content, 12);
    return out;
  };
  const sizeChunk = chunk("SIZE", sizeContent);
  const xyzChunk = chunk("XYZI", xyzContent);
  const children = new Uint8Array(sizeChunk.length + xyzChunk.length);
  children.set(sizeChunk, 0);
  children.set(xyzChunk, sizeChunk.length);
  const mainOut = new Uint8Array(12 + children.length);
  const mainView = new DataView(mainOut.buffer);
  for (let i = 0; i < 4; i += 1) mainView.setUint8(i, "MAIN".charCodeAt(i));
  mainView.setUint32(4, 0, true);
  mainView.setUint32(8, children.length, true);
  mainOut.set(children, 12);
  const out = new Uint8Array(header.length + mainOut.length);
  out.set(header, 0);
  out.set(mainOut, header.length);
  return out;
}
