import { describe, expect, it } from "vitest";
import {
  GLTF_EXPORT_LOSSES,
  type GltfExportLimits,
  type GltfSceneGraph,
} from "./gltf-types.js";
import { encodeGlb, encodeGltfJson } from "./gltf.js";

/**
 * Deterministic glTF 2.0 / GLB encoder (plan S16.3, ticket #41). The
 * independent reader below parses the GLB container from raw bytes
 * (header, chunks, JSON, accessors, bufferViews) without reusing any
 * encoder internals, so the encoded files are validated by a reader the
 * encoder does not share code with ("validated by independent readers").
 */

/** Minimal scene: two nodes, one mesh with two material primitives. */
function sceneGraph(): GltfSceneGraph {
  const positions = Float32Array.from([
    // unit cube at the origin
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  ]);
  const normals = Float32Array.from([
    0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1,
  ]);
  return {
    sceneNodes: [0],
    nodes: [
      {
        name: "Root",
        children: [1],
      },
      {
        name: "Cube",
        translation: [1, 2, 3],
        mesh: 0,
      },
    ],
    meshes: [
      {
        name: "Cube mesh",
        positions,
        normals,
        primitives: [
          {
            materialIndex: 0,
            indices: Uint32Array.from([0, 1, 2, 2, 1, 3]),
          },
          {
            materialIndex: 1,
            indices: Uint32Array.from([4, 5, 6, 6, 5, 7]),
          },
        ],
      },
    ],
    materials: [
      {
        name: "red",
        baseColorFactor: [1, 0, 0, 1],
        metallicFactor: 0,
        roughnessFactor: 1,
        emissiveFactor: [0, 0, 0],
        alphaMode: "OPAQUE",
      },
      {
        name: "glass",
        baseColorFactor: [0, 1, 0, 0.5],
        metallicFactor: 0.5,
        roughnessFactor: 0.25,
        emissiveFactor: [0.1, 0.1, 0.1],
        alphaMode: "BLEND",
      },
    ],
    metadata: {
      generator: "voxel-maker",
      metersPerVoxel: 1,
      pivotHelpers: [],
      nodes: 2,
      meshes: 1,
      materials: 2,
      faces: 2,
      voxels: 2,
      clips: 0,
    },
    losses: [],
  };
}

interface GltfJson {
  readonly asset: { readonly version: string; readonly generator: string };
  readonly scene: number;
  readonly scenes: readonly { readonly nodes: readonly number[] }[];
  readonly nodes: readonly Record<string, unknown>[];
  readonly meshes: readonly Record<string, unknown>[];
  readonly materials: readonly Record<string, unknown>[];
  readonly animations?: readonly Record<string, unknown>[];
  readonly accessors: readonly Record<string, unknown>[];
  readonly bufferViews: readonly Record<string, unknown>[];
  readonly buffers: readonly Record<string, unknown>[];
}

/** Independent GLB container reader: header + chunks + JSON. */
function readGlb(bytes: Uint8Array): { json: GltfJson; bin: Uint8Array } {
  if (bytes.byteLength < 12) throw new Error("GLB shorter than header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(
    bytes[0] as number,
    bytes[1] as number,
    bytes[2] as number,
    bytes[3] as number,
  );
  if (magic !== "glTF") throw new Error(`bad magic ${magic}`);
  const version = view.getUint32(4, true);
  const length = view.getUint32(8, true);
  if (version !== 2) throw new Error(`bad version ${String(version)}`);
  if (length !== bytes.byteLength) {
    throw new Error(`length ${String(length)} != ${String(bytes.byteLength)}`);
  }
  let offset = 12;
  let json: GltfJson | undefined;
  let bin: Uint8Array = new Uint8Array(0);
  for (let chunk = 0; chunk < 2; chunk += 1) {
    if (offset + 8 > bytes.byteLength) throw new Error("missing chunk header");
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    if (offset + 8 + chunkLength > bytes.byteLength) {
      throw new Error("chunk overflows file");
    }
    const payload = bytes.subarray(offset + 8, offset + 8 + chunkLength);
    if (chunkType === 0x4e4f534a) {
      const text = new TextDecoder("utf-8").decode(payload);
      json = JSON.parse(text) as GltfJson;
    } else if (chunkType === 0x004e4942) {
      bin = payload;
    } else {
      throw new Error(`unknown chunk type ${String(chunkType)}`);
    }
    offset += 8 + chunkLength;
  }
  if (offset !== bytes.byteLength) throw new Error("trailing bytes");
  if (json === undefined) throw new Error("missing JSON chunk");
  return { json, bin };
}

/** Resolves one accessor to its typed array from raw buffer bytes. */
function resolveAccessor(
  json: GltfJson,
  bin: Uint8Array,
  accessorIndex: number,
): { values: number[]; min?: number[]; max?: number[] } {
  const accessor = json.accessors[accessorIndex];
  if (accessor === undefined) throw new Error("missing accessor");
  const bufferView = json.bufferViews[accessor.bufferView as number];
  if (bufferView === undefined) throw new Error("missing bufferView");
  const byteOffset = (bufferView.byteOffset as number | undefined) ?? 0;
  const start = byteOffset + ((accessor.byteOffset as number | undefined) ?? 0);
  const componentType = accessor.componentType as number;
  const count = accessor.count as number;
  const type = accessor.type as string;
  const components = type === "VEC3" ? 3 : type === "VEC4" ? 4 : 1;
  const bytesPer = componentType === 5126 ? 4 : 4;
  const view = new DataView(
    bin.buffer,
    bin.byteOffset + start,
    count * components * bytesPer,
  );
  const values: number[] = [];
  for (let i = 0; i < count * components; i += 1) {
    if (componentType === 5126) values.push(view.getFloat32(i * 4, true));
    else values.push(view.getUint32(i * 4, true));
  }
  return {
    values,
    ...(accessor.min !== undefined ? { min: accessor.min as number[] } : {}),
    ...(accessor.max !== undefined ? { max: accessor.max as number[] } : {}),
  };
}

describe("encodeGlb", () => {
  it("emits a valid GLB container with JSON and BIN chunks", () => {
    const bytes = encodeGlb(sceneGraph());
    const { json, bin } = readGlb(bytes);
    expect(json.asset).toEqual({ version: "2.0", generator: "voxel-maker" });
    expect(json.scene).toBe(0);
    expect(json.scenes).toEqual([{ nodes: [0] }]);
    expect(bin.byteLength).toBeGreaterThan(0);
  });

  it("round-trips positions, normals, and indices through the buffer", () => {
    const graph = sceneGraph();
    const bytes = encodeGlb(graph);
    const { json, bin } = readGlb(bytes);
    const mesh = json.meshes[0] as Record<string, unknown>;
    const primitives = mesh.primitives as readonly Record<string, unknown>[];
    expect(primitives).toHaveLength(2);
    const attributes = primitives[0]?.attributes as Record<string, number>;
    const position = resolveAccessor(json, bin, attributes.POSITION as number);
    const normal = resolveAccessor(json, bin, attributes.NORMAL as number);
    const indices = resolveAccessor(
      json,
      bin,
      primitives[0]?.indices as number,
    );
    expect(position.values).toEqual([...(graph.meshes[0]?.positions ?? [])]);
    expect(normal.values).toEqual([...(graph.meshes[0]?.normals ?? [])]);
    expect(indices.values).toEqual([0, 1, 2, 2, 1, 3]);
    expect(position.min).toEqual([0, 0, 0]);
    expect(position.max).toEqual([1, 1, 1]);
    expect(json.accessors).toHaveLength(4); // pos, normal, 2 x indices
  });

  it("maps nodes, hierarchy, and materials into the JSON", () => {
    const bytes = encodeGlb(sceneGraph());
    const { json } = readGlb(bytes);
    expect(json.nodes).toEqual([
      { name: "Root", children: [1] },
      { name: "Cube", translation: [1, 2, 3], mesh: 0 },
    ]);
    const material = json.materials[1] as Record<string, unknown>;
    expect(material.name).toBe("glass");
    expect(material.alphaMode).toBe("BLEND");
    const pbr = material.pbrMetallicRoughness as Record<string, unknown>;
    expect(pbr.baseColorFactor).toEqual([0, 1, 0, 0.5]);
    expect(pbr.metallicFactor).toBe(0.5);
    expect(pbr.roughnessFactor).toBe(0.25);
    expect(material.emissiveFactor).toEqual([0.1, 0.1, 0.1]);
  });

  it("pads chunks to 4 bytes and records the unpadded buffer length", () => {
    const bytes = encodeGlb(sceneGraph());
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const jsonLength = view.getUint32(12, true);
    expect(jsonLength % 4).toBe(0);
    const binStart = 20 + jsonLength;
    const binLength = view.getUint32(binStart, true);
    expect(binLength % 4).toBe(0);
    const { json, bin } = readGlb(bytes);
    expect(json.buffers).toEqual([{ byteLength: bin.byteLength }]);
    // Padding bytes after the buffer payload are zero for BIN.
    const buffer = json.buffers[0] as { byteLength: number };
    for (let i = buffer.byteLength; i < bin.byteLength; i += 1) {
      expect(bin[i]).toBe(0);
    }
  });

  it("is byte-deterministic across calls", () => {
    const first = encodeGlb(sceneGraph());
    const second = encodeGlb(sceneGraph());
    expect(first).toEqual(second);
    expect(Buffer.from(first).toString("base64")).toBe(
      Buffer.from(second).toString("base64"),
    );
  });

  it("enforces the output byte limit with a structured error", () => {
    const limits: GltfExportLimits = {
      maxFacesPerVolume: 1_000_000,
      maxTotalFaces: 1_000_000,
      maxTotalBytes: 16,
      maxSmoothstepSamplesPerSegment: 16,
    };
    expectGltfError(
      () => encodeGlb(sceneGraph(), limits),
      "limit",
      "GLTF_FILE_TOO_LARGE",
    );
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

/** Scene graph from `sceneGraph()` plus one animated clip. */
function animatedSceneGraph(): GltfSceneGraph {
  return {
    ...sceneGraph(),
    animations: [
      {
        name: "Spin",
        channels: [
          { sampler: 0, node: 1, path: "rotation" },
          { sampler: 1, node: 0, path: "translation" },
        ],
        samplers: [
          {
            input: Float32Array.from([0, 1, 2]),
            output: Float32Array.from([
              0, 0, 0, 1, //
              0, 0, Math.fround(Math.SQRT1_2), Math.fround(Math.SQRT1_2), //
              0, 0, 1, 0,
            ]),
            interpolation: "LINEAR",
            outputType: "VEC4",
          },
          {
            input: Float32Array.from([0, 2]),
            output: Float32Array.from([1, 2, 3, 4, 5, 6]),
            interpolation: "STEP",
            outputType: "VEC3",
          },
        ],
      },
    ],
  };
}

describe("encodeGlb with animations", () => {
  it("emits animation channels, samplers, and accessors", () => {
    const bytes = encodeGlb(animatedSceneGraph());
    const { json } = readGlb(bytes);
    const animations = json.animations as
      | readonly {
          readonly name: string;
          readonly channels: readonly {
            readonly sampler: number;
            readonly target: { readonly node: number; readonly path: string };
          }[];
          readonly samplers: readonly {
            readonly input: number;
            readonly output: number;
            readonly interpolation: string;
          }[];
        }[]
      | undefined;
    expect(animations).toHaveLength(1);
    const animation = animations?.[0];
    expect(animation?.name).toBe("Spin");
    expect(animation?.channels).toEqual([
      { sampler: 0, target: { node: 1, path: "rotation" } },
      { sampler: 1, target: { node: 0, path: "translation" } },
    ]);
    expect(animation?.samplers).toHaveLength(2);
    expect(animation?.samplers[0]?.interpolation).toBe("LINEAR");
    expect(animation?.samplers[1]?.interpolation).toBe("STEP");
  });

  it("round-trips animation times and values through the buffer", () => {
    const bytes = encodeGlb(animatedSceneGraph());
    const { json, bin } = readGlb(bytes);
    const animations = json.animations as
      | readonly {
          readonly samplers: readonly {
            readonly input: number;
            readonly output: number;
            readonly interpolation: string;
          }[];
        }[]
      | undefined;
    const samplers = animations?.[0]?.samplers;
    expect(samplers).toHaveLength(2);
    const times = resolveAccessor(json, bin, samplers?.[0]?.input ?? -1);
    expect(times.values).toEqual([0, 1, 2]);
    expect(times.min).toEqual([0]);
    expect(times.max).toEqual([2]);
    const rotations = resolveAccessor(json, bin, samplers?.[0]?.output ?? -1);
    expect(rotations.values).toEqual([
      0, 0, 0, 1, //
      0, 0, Math.fround(Math.SQRT1_2), Math.fround(Math.SQRT1_2), //
      0, 0, 1, 0,
    ]);
    const translations = resolveAccessor(json, bin, samplers?.[1]?.output ?? -1);
    expect(translations.values).toEqual([1, 2, 3, 4, 5, 6]);
    const accessor = json.accessors[samplers?.[0]?.input ?? -1];
    expect(accessor?.type).toBe("SCALAR");
    const rotationAccessor = json.accessors[samplers?.[0]?.output ?? -1];
    expect(rotationAccessor?.type).toBe("VEC4");
    const translationAccessor = json.accessors[samplers?.[1]?.output ?? -1];
    expect(translationAccessor?.type).toBe("VEC3");
  });

  it("omits the animations key when the scene graph has none", () => {
    const { json } = readGlb(encodeGlb(sceneGraph()));
    expect(json.animations).toBeUndefined();
  });

  it("is byte-deterministic across calls", () => {
    const first = encodeGlb(animatedSceneGraph());
    const second = encodeGlb(animatedSceneGraph());
    expect(first).toEqual(second);
  });

  it("matches the GLB JSON document exactly (same animated scene graph)", () => {
    const graph = animatedSceneGraph();
    const gltf = JSON.parse(encodeGltfJson(graph).json) as GltfJson;
    const { json: glb } = readGlb(encodeGlb(graph));
    expect(gltf.animations).toEqual(glb.animations);
    expect(gltf.nodes).toEqual(glb.nodes);
    expect(gltf.accessors).toEqual(glb.accessors);
  });
});

describe("encodeGltfJson", () => {
  it("embeds the buffer as a data URI and keeps the JSON valid", () => {
    const graph = sceneGraph();
    const encoded = encodeGltfJson(graph);
    const json = JSON.parse(encoded.json) as GltfJson;
    const buffers = json.buffers as readonly {
      uri: string;
      byteLength: number;
    }[];
    expect(buffers).toHaveLength(1);
    const buffer = buffers[0];
    expect(buffer?.byteLength).toBe(encoded.buffer.byteLength);
    expect(
      buffer?.uri.startsWith("data:application/octet-stream;base64,"),
    ).toBe(true);
    const payload = (buffer?.uri ?? "").split(",")[1] ?? "";
    const decoded = new Uint8Array(Buffer.from(payload, "base64"));
    expect(decoded).toEqual(encoded.buffer);
  });

  it("matches the GLB JSON document exactly (same scene graph)", () => {
    const graph = sceneGraph();
    const gltf = JSON.parse(encodeGltfJson(graph).json) as GltfJson;
    const { json: glb } = readGlb(encodeGlb(graph));
    expect(gltf.nodes).toEqual(glb.nodes);
    expect(gltf.meshes).toEqual(glb.meshes);
    expect(gltf.materials).toEqual(glb.materials);
    expect(gltf.accessors).toEqual(glb.accessors);
    expect(gltf.bufferViews).toEqual(glb.bufferViews);
  });

  it("reports nothing about losses through the encoder", () => {
    const graph: GltfSceneGraph = {
      ...sceneGraph(),
      losses: [
        {
          code: GLTF_EXPORT_LOSSES.metadata,
          message: "Metadata is not represented in glTF and is omitted",
          severity: "bake",
        },
      ],
    };
    const json = JSON.parse(encodeGltfJson(graph).json) as GltfJson;
    expect(json.materials).toBeDefined();
  });
});
