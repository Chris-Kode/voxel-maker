#!/usr/bin/env node
/**
 * Regenerates the checked-in static glTF/GLB fixture corpus in
 * `fixtures/gltf/` (plan S16.8, ticket #41): byte-stable golden `.glb`
 * and `.gltf` files plus the retained document/volume JSON needed to
 * rebuild the exact bytes, and a machine-readable `corpus.json`.
 *
 * Requires a full build first (`pnpm build`), then:
 *   node scripts/generate-gltf-fixtures.mjs
 *
 * The script self-checks every fixture against
 * preflight/plan/encode before writing anything, so the committed corpus
 * and `corpus.json` always agree with the exporter's current behavior.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  componentId,
  materialId,
  nodeId,
  volumeId,
} from "../packages/shared/dist/index.js";
import {
  canonicalDocumentJson,
  createDocument,
} from "../packages/model/dist/index.js";
import { createDocumentStore } from "../packages/document/dist/index.js";
import {
  GLTF_EXPORT_LOSSES,
  encodeGlb,
  encodeGltfJson,
  planGltfExport,
  preflightGltfExport,
} from "../packages/formats/dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpusDir = join(root, "fixtures", "gltf");
const goldenDir = join(corpusDir, "golden");

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
};

/** One entry list per volume id; entries are [x, y, z, material]. */
function storeWithEntries(document, entriesByVolume) {
  const volumes = new Map();
  for (const [id, entries] of entriesByVolume) {
    const chunks = new Map();
    for (const [x, y, z, material] of entries) {
      const cx = Math.floor(x / 16);
      const cy = Math.floor(y / 16);
      const cz = Math.floor(z / 16);
      const key = `${String(cx)},${String(cy)},${String(cz)}`;
      const chunk = chunks.get(key) ?? {
        coordinate: [cx, cy, cz],
        values: new Uint16Array(4096),
      };
      const lx = ((x % 16) + 16) % 16;
      const ly = ((y % 16) + 16) % 16;
      const lz = ((z % 16) + 16) % 16;
      chunk.values[lx + 16 * (ly + 16 * lz)] = material;
      chunks.set(key, chunk);
    }
    volumes.set(id, [...chunks.values()]);
  }
  return createDocumentStore({ document, volumes }).store;
}

/** Independent GLB read used for the generator's self-check. */
function readGlb(bytes) {
  if (bytes.byteLength < 12) throw new Error("GLB shorter than header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== "glTF") throw new Error(`bad magic ${magic}`);
  if (view.getUint32(4, true) !== 2) throw new Error("bad version");
  if (view.getUint32(8, true) !== bytes.byteLength) {
    throw new Error("bad length");
  }
  const jsonLength = view.getUint32(12, true);
  if (view.getUint32(16, true) !== 0x4e4f534a) throw new Error("bad JSON type");
  const json = JSON.parse(
    Buffer.from(bytes.subarray(20, 20 + jsonLength)).toString("utf8"),
  );
  return json;
}

const fixtures = [];

// --- Golden 1: two-material 2x2x2 cube --------------------------------
{
  const ROOT = nodeId("node:fixture:cube:root");
  const CUBE = nodeId("node:fixture:cube:body");
  const VOLUME = volumeId("volume:fixture:cube");
  const document = createDocument({
    documentId: "document:fixture:cube:0001",
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Cube Root",
        parentId: null,
        children: [CUBE],
        transform: identity,
        components: [],
      },
      {
        nodeId: CUBE,
        name: "Cube",
        parentId: ROOT,
        children: [],
        transform: {
          translation: [1, 2, 3],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "base",
        color: "#c8b89a",
        opacity: 1,
        roughness: 0.8,
        metallic: 0,
        emissive: 0,
      },
      {
        materialId: materialId(2),
        name: "accent",
        color: "#8a5a3a",
        opacity: 1,
        roughness: 0.6,
        metallic: 0.1,
        emissive: 0.05,
      },
    ],
    volumes: [{ volumeId: VOLUME, name: "Cube voxels" }],
  });
  const entries = [];
  for (let z = 0; z < 2; z += 1) {
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        entries.push([x, y, z, z === 0 ? 1 : 2]);
      }
    }
  }
  const store = storeWithEntries(document, [[VOLUME, entries]]);
  const preflight = preflightGltfExport(document, (id) => store.getVolume(id));
  if (!preflight.ok) throw new Error("cube preflight blocked");
  const plan = planGltfExport(document, (id) => store.getVolume(id), preflight);
  const glb = encodeGlb(plan);
  const gltf = encodeGltfJson(plan);
  const json = readGlb(glb);
  fixtures.push({
    name: "cube",
    vector: "2x2x2 two-material cube with a translated node",
    document,
    volumesJson: [[VOLUME, entries]],
    glb,
    gltf,
    counts: {
      nodes: plan.metadata.nodes,
      meshes: plan.metadata.meshes,
      materials: plan.metadata.materials,
      accessors: json.accessors.length,
      faces: plan.metadata.faces,
      voxels: plan.metadata.voxels,
      losses: plan.losses.length,
      animations: 0,
      channels: 0,
      samplers: 0,
    },
  });
}

// --- Golden 2: pivoted hierarchy --------------------------------------
{
  const ROOT = nodeId("node:fixture:hp:root");
  const ARM = nodeId("node:fixture:hp:arm");
  const HAND = nodeId("node:fixture:hp:hand");
  const ARM_VOLUME = volumeId("volume:fixture:hp:arm");
  const HAND_VOLUME = volumeId("volume:fixture:hp:hand");
  const document = createDocument({
    documentId: "document:fixture:hp:0001",
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Rig Root",
        parentId: null,
        children: [ARM],
        transform: identity,
        components: [],
      },
      {
        nodeId: ARM,
        name: "Arm",
        parentId: ROOT,
        children: [HAND],
        transform: {
          translation: [1, 2, 0],
          pivot: [0, 1, 0],
          rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
          scale: [1, 1, 1],
        },
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: ARM_VOLUME }],
      },
      {
        nodeId: HAND,
        name: "Hand",
        parentId: ARM,
        children: [],
        transform: {
          translation: [2, 0, 0],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: HAND_VOLUME },
        ],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "body",
        color: "#5a3a2a",
        opacity: 1,
        roughness: 0.4,
        metallic: 0.2,
        emissive: 0,
      },
    ],
    volumes: [
      { volumeId: ARM_VOLUME, name: "Arm voxels" },
      { volumeId: HAND_VOLUME },
    ],
  });
  const store = storeWithEntries(document, [
    [
      ARM_VOLUME,
      [
        [0, 0, 0, 1],
        [1, 0, 0, 1],
        [0, 1, 0, 1],
      ],
    ],
    [HAND_VOLUME, [[0, 0, 0, 1]]],
  ]);
  const preflight = preflightGltfExport(document, (id) => store.getVolume(id));
  if (!preflight.ok) throw new Error("hierarchy-pivot preflight blocked");
  const plan = planGltfExport(document, (id) => store.getVolume(id), preflight);
  const glb = encodeGlb(plan);
  const json = readGlb(glb);
  fixtures.push({
    name: "hierarchy-pivot",
    vector: "nested pivoted arm with a helper-node chain and a child",
    document,
    volumesJson: [
      [
        ARM_VOLUME,
        [
          [0, 0, 0, 1],
          [1, 0, 0, 1],
          [0, 1, 0, 1],
        ],
      ],
      [HAND_VOLUME, [[0, 0, 0, 1]]],
    ],
    glb,
    gltf: undefined,
    counts: {
      nodes: plan.metadata.nodes,
      meshes: plan.metadata.meshes,
      materials: plan.metadata.materials,
      accessors: json.accessors.length,
      faces: plan.metadata.faces,
      voxels: plan.metadata.voxels,
      losses: plan.losses.length,
      animations: 0,
      channels: 0,
      samplers: 0,
    },
  });
}

// --- Golden 3: lossy document ------------------------------------------
{
  const ROOT = nodeId("node:fixture:lossy:root");
  const BODY = nodeId("node:fixture:lossy:body");
  const EMPTY = nodeId("node:fixture:lossy:empty");
  const BODY_VOLUME = volumeId("volume:fixture:lossy:body");
  const EMPTY_VOLUME = volumeId("volume:fixture:lossy:empty");
  const document = createDocument({
    documentId: "document:fixture:lossy:0001",
    metadata: { title: "lossy fixture" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Lossy Root",
        parentId: null,
        children: [BODY, EMPTY],
        transform: identity,
        components: [],
      },
      {
        nodeId: BODY,
        name: "Glass Body",
        parentId: ROOT,
        children: [],
        transform: identity,
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: BODY_VOLUME },
          { kind: "joint", schemaVersion: 1 },
        ],
        metadata: { note: "translucent" },
      },
      {
        nodeId: EMPTY,
        name: "Empty Holder",
        parentId: ROOT,
        children: [],
        transform: identity,
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: EMPTY_VOLUME },
        ],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "glass",
        color: "#66ccff",
        opacity: 0.5,
        roughness: 0.1,
        metallic: 0.9,
        emissive: 0,
      },
    ],
    volumes: [{ volumeId: BODY_VOLUME }, { volumeId: EMPTY_VOLUME }],
    animations: [
      {
        animationId: "animation:fixture:lossy:spin",
        name: "Spin",
        duration: 1,
        loop: "once",
        tracks: [
          {
            trackId: "track:fixture:lossy:spin",
            targetNodeId: BODY,
            interpolation: "linear",
            keyframes: [
              {
                keyframeId: "key:fixture:lossy:spin:0",
                time: 0,
                property: { channel: "rotation", value: [0, 0, 0, 1] },
              },
            ],
          },
        ],
      },
    ],
  });
  const store = storeWithEntries(document, [
    [BODY_VOLUME, [[0, 0, 0, 1]]],
    [EMPTY_VOLUME, []],
  ]);
  const preflight = preflightGltfExport(document, (id) => store.getVolume(id));
  if (!preflight.ok) throw new Error("lossy preflight blocked");
  const plan = planGltfExport(document, (id) => store.getVolume(id), preflight);
  const glb = encodeGlb(plan);
  const json = readGlb(glb);
  const codes = new Set(plan.losses.map((loss) => loss.code));
  for (const expected of [
    GLTF_EXPORT_LOSSES.joints,
    GLTF_EXPORT_LOSSES.metadata,
    GLTF_EXPORT_LOSSES.emptyVolume,
  ]) {
    if (!codes.has(expected)) throw new Error(`missing loss ${expected}`);
  }
  if (codes.has(GLTF_EXPORT_LOSSES.clips)) {
    throw new Error("lossy clip should map to an animation, not a clips loss");
  }
  fixtures.push({
    name: "lossy",
    vector:
      "transparent material, exported single-keyframe clip, joint, node/document metadata, empty volume",
    document,
    volumesJson: [
      [BODY_VOLUME, [[0, 0, 0, 1]]],
      [EMPTY_VOLUME, []],
    ],
    glb,
    gltf: undefined,
    counts: {
      nodes: plan.metadata.nodes,
      meshes: plan.metadata.meshes,
      materials: plan.metadata.materials,
      accessors: json.accessors.length,
      faces: plan.metadata.faces,
      voxels: plan.metadata.voxels,
      losses: plan.losses.length,
      animations: plan.animations.length,
      channels: plan.animations.reduce(
        (total, animation) => total + animation.channels.length,
        0,
      ),
      samplers: plan.animations.reduce(
        (total, animation) => total + animation.samplers.length,
        0,
      ),
    },
  });
}

// --- Golden 4: animated pivoted hierarchy ---------------------------------
{
  const ROOT = nodeId("node:fixture:anim:root");
  const ARM = nodeId("node:fixture:anim:arm");
  const HAND = nodeId("node:fixture:anim:hand");
  const ARM_VOLUME = volumeId("volume:fixture:anim:arm");
  const HAND_VOLUME = volumeId("volume:fixture:anim:hand");
  const document = createDocument({
    documentId: "document:fixture:anim:0001",
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Anim Root",
        parentId: null,
        children: [ARM],
        transform: identity,
        components: [],
      },
      {
        nodeId: ARM,
        name: "Anim Arm",
        parentId: ROOT,
        children: [HAND],
        transform: {
          translation: [1, 2, 0],
          pivot: [0, 1, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: ARM_VOLUME },
          {
            kind: "constraint",
            schemaVersion: 1,
            constraints: [
              {
                componentId: componentId("component:fixture:anim:limit"),
                type: "rotation-limits",
                limits: { min: [0, 0, 0], max: [0, 0, 1] },
              },
            ],
          },
        ],
      },
      {
        nodeId: HAND,
        name: "Anim Hand",
        parentId: ARM,
        children: [],
        transform: {
          translation: [2, 0, 0],
          pivot: [0, 0, 0],
          rotation: [0, 0, 0, 1],
          scale: [1, 1, 1],
        },
        components: [
          { kind: "voxel", schemaVersion: 1, volumeId: HAND_VOLUME },
        ],
      },
    ],
    materials: [
      {
        materialId: materialId(1),
        name: "joint",
        color: "#c8b89a",
        opacity: 1,
        roughness: 0.4,
        metallic: 0.2,
        emissive: 0,
      },
    ],
    volumes: [
      { volumeId: ARM_VOLUME, name: "Arm voxels" },
      { volumeId: HAND_VOLUME, name: "Hand voxels" },
    ],
    animations: [
      {
        animationId: "animation:fixture:anim:swing",
        name: "Swing",
        duration: 1,
        loop: "loop",
        tracks: [
          {
            trackId: "track:fixture:anim:swing:rotate",
            targetNodeId: ARM,
            interpolation: "linear",
            keyframes: [
              {
                keyframeId: "key:fixture:anim:swing:rotate:0",
                time: 0,
                property: { channel: "rotation", value: [0, 0, 0, 1] },
              },
              {
                keyframeId: "key:fixture:anim:swing:rotate:1",
                time: 1,
                property: { channel: "rotation", value: [0, 0, 1, 0] },
              },
            ],
          },
          {
            trackId: "track:fixture:anim:swing:slide",
            targetNodeId: ARM,
            interpolation: "step",
            keyframes: [
              {
                keyframeId: "key:fixture:anim:swing:slide:0",
                time: 0,
                property: { channel: "translation", value: [1, 2, 0] },
              },
              {
                keyframeId: "key:fixture:anim:swing:slide:1",
                time: 0.5,
                property: { channel: "translation", value: [2, 2, 0] },
              },
            ],
          },
          {
            trackId: "track:fixture:anim:swing:grow",
            targetNodeId: HAND,
            interpolation: "smoothstep",
            keyframes: [
              {
                keyframeId: "key:fixture:anim:swing:grow:0",
                time: 0,
                property: { channel: "scale", value: [1, 1, 1] },
              },
              {
                keyframeId: "key:fixture:anim:swing:grow:1",
                time: 1,
                property: { channel: "scale", value: [2, 2, 2] },
              },
            ],
          },
        ],
      },
    ],
  });
  const store = storeWithEntries(document, [
    [
      ARM_VOLUME,
      [
        [0, 0, 0, 1],
        [1, 0, 0, 1],
        [0, 1, 0, 1],
      ],
    ],
    [HAND_VOLUME, [[0, 0, 0, 1]]],
  ]);
  const preflight = preflightGltfExport(document, (id) => store.getVolume(id));
  if (!preflight.ok) throw new Error("animated preflight blocked");
  const plan = planGltfExport(document, (id) => store.getVolume(id), preflight);
  const glb = encodeGlb(plan);
  const json = readGlb(glb);
  const codes = new Set(plan.losses.map((loss) => loss.code));
  for (const expected of [
    GLTF_EXPORT_LOSSES.clipLoop,
    GLTF_EXPORT_LOSSES.smoothstep,
    GLTF_EXPORT_LOSSES.constraints,
  ]) {
    if (!codes.has(expected)) throw new Error(`missing loss ${expected}`);
  }
  if (plan.animations.length !== 1) {
    throw new Error(`expected one animation, got ${plan.animations.length}`);
  }
  const animationSamples = plan.animations.map((animation) => ({
    name: animation.name,
    channels: animation.channels.map((channel) => ({
      sampler: channel.sampler,
      node: channel.node,
      path: channel.path,
    })),
    samplers: animation.samplers.map((sampler) => ({
      input: [...sampler.input],
      output: [...sampler.output],
      interpolation: sampler.interpolation,
      outputType: sampler.outputType,
    })),
  }));
  fixtures.push({
    name: "animated",
    vector:
      "pivoted arm with linear rotation, step translation, baked smoothstep scale, loop clip, and a constraint",
    document,
    volumesJson: [
      [
        ARM_VOLUME,
        [
          [0, 0, 0, 1],
          [1, 0, 0, 1],
          [0, 1, 0, 1],
        ],
      ],
      [HAND_VOLUME, [[0, 0, 0, 1]]],
    ],
    glb,
    gltf: undefined,
    counts: {
      nodes: plan.metadata.nodes,
      meshes: plan.metadata.meshes,
      materials: plan.metadata.materials,
      accessors: json.accessors.length,
      faces: plan.metadata.faces,
      voxels: plan.metadata.voxels,
      losses: plan.losses.length,
      animations: plan.animations.length,
      channels: plan.animations.reduce(
        (total, animation) => total + animation.channels.length,
        0,
      ),
      samplers: plan.animations.reduce(
        (total, animation) => total + animation.samplers.length,
        0,
      ),
    },
    animationSamples,
  });
}

await mkdir(goldenDir, { recursive: true });

const golden = [];
for (const fixture of fixtures) {
  const base = fixture.name;
  const documentJson = canonicalDocumentJson(fixture.document);
  const volumesJson = Object.fromEntries(
    fixture.volumesJson.map(([id, entries]) => [
      id,
      entries.map((entry) => [...entry]),
    ]),
  );
  await writeFile(
    join(goldenDir, `${base}.document.json`),
    `${documentJson}\n`,
  );
  await writeFile(
    join(goldenDir, `${base}.volumes.json`),
    `${JSON.stringify(volumesJson, null, 2)}\n`,
  );
  await writeFile(join(goldenDir, `${base}.glb`), fixture.glb);
  const entry = {
    file: `golden/${base}.glb`,
    vector: fixture.vector,
    byteLength: fixture.glb.byteLength,
    documentJson: `golden/${base}.document.json`,
    volumesJson: `golden/${base}.volumes.json`,
    nodes: fixture.counts.nodes,
    meshes: fixture.counts.meshes,
    materials: fixture.counts.materials,
    accessors: fixture.counts.accessors,
    faces: fixture.counts.faces,
    voxels: fixture.counts.voxels,
    losses: fixture.counts.losses,
    animations: fixture.counts.animations ?? 0,
    channels: fixture.counts.channels ?? 0,
    samplers: fixture.counts.samplers ?? 0,
  };
  if (fixture.animationSamples !== undefined) {
    entry.animationSamples = fixture.animationSamples;
  }
  if (fixture.gltf !== undefined) {
    await writeFile(join(goldenDir, `${base}.gltf`), fixture.gltf.json);
    entry.gltf = `golden/${base}.gltf`;
    entry.gltfByteLength = Buffer.byteLength(fixture.gltf.json, "utf8");
  }
  golden.push(entry);
}

const corpus = { schemaVersion: 2, golden };
await writeFile(
  join(corpusDir, "corpus.json"),
  `${JSON.stringify(corpus, null, 2)}\n`,
);

console.log(
  `Wrote ${String(golden.length)} golden glTF fixtures to ${corpusDir}`,
);
console.log(
  corpus.golden
    .map((entry) => `${entry.file} (${String(entry.byteLength)} bytes)`)
    .join("\n"),
);
