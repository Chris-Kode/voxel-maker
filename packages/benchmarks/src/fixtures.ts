import {
  canonicalAssetSemanticHash,
  createDocumentStore,
  type DocumentCommitted,
  type DocumentStore,
  type DocumentStoreHandle,
} from "@voxel-maker/document";
import type { Vec3i } from "@voxel-maker/math";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";
import {
  animationId,
  commandId,
  documentId,
  keyframeId,
  materialId,
  nodeId,
  trackId,
  transactionId,
  volumeId,
  type MaterialId,
  type NodeId,
  type VolumeId,
} from "@voxel-maker/shared";
import {
  createDocument,
  type AnimationDescriptor,
  type AnimationTrack,
  type SceneNode,
  type VoxelDocument,
} from "@voxel-maker/model";

/**
 * Reproducible benchmark scenes (plan S6.16/S17.4, ADR-0008, ticket
 * #45): deterministic 100k/500k/1M occupied-voxel fixtures in the three
 * ADR-0008 surface classes (compact, sparse, checkerboard/high-surface)
 * plus a track-count scaling fixture for the animation frame budget.
 * Every fixture uses a fixed seed, stable branded ids, and a fixed voxel
 * layout, so the same scene reproduces byte-identical semantic hashes on
 * every machine and run. Scenes are seeded through the store's staging
 * surface (a fixture, not a measured operation); measured operations
 * always go through the command bus.
 */

/** The fixed benchmark seed; every fixture derives from it. */
export const BENCHMARK_SEED = 0x45_2025_07;

/** The three ADR-0008 surface classes (compact, sparse, high-surface). */
export type BenchmarkSceneKind = "compact" | "sparse" | "checkerboard";

export const BENCHMARK_SCENE_KINDS: readonly BenchmarkSceneKind[] =
  Object.freeze(["compact", "sparse", "checkerboard"]);

/** The nominal occupied-voxel sizes of the benchmark matrix. */
export const BENCHMARK_SIZES: readonly number[] = Object.freeze([
  100_000,
  500_000,
  1_000_000,
]);

/** Deterministic 32-bit PRNG (mulberry32); pure, seed-stable. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const identity = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

/** Bounding extent (half-open max) of one benchmark scene kind + size. */
function sceneExtent(kind: BenchmarkSceneKind, target: number): IntAabbLike {
  switch (kind) {
    case "compact":
      // Solid slabs: 100x100x10 / 50 / 100.
      return { min: [0, 0, 0], max: [100, 100, target / 10_000] };
    case "checkerboard":
      // (x+y+z)%2 occupancy at exactly half density.
      return { min: [0, 0, 0], max: [100, 100, target / 5_000] };
    case "sparse":
      // Scatter box with 20x the target volume so collisions are rare
      // (200 x 100 x Z with Z = target / 1000 -> volume = 20 x target).
      return { min: [0, 0, 0], max: [200, 100, target / 1_000] };
  }
}

interface IntAabbLike {
  readonly min: Vec3i;
  readonly max: Vec3i;
}

/** Deterministic voxel entries of one benchmark scene (fixed order). */
export function sceneEntries(
  kind: BenchmarkSceneKind,
  target: number,
): readonly (readonly [x: number, y: number, z: number])[] {
  const extent = sceneExtent(kind, target);
  const entries: [number, number, number][] = [];
  if (kind === "compact" || kind === "checkerboard") {
    const [mx, my, mz] = extent.max as readonly [number, number, number];
    for (let x = 0; x < mx; x += 1) {
      for (let y = 0; y < my; y += 1) {
        for (let z = 0; z < mz; z += 1) {
          const occupied = kind === "compact" || ((x + y + z) % 2) === 0;
          if (occupied) entries.push([x, y, z]);
        }
      }
    }
    return entries;
  }
  // Sparse: exact target occupancy from a seeded scatter.
  const [mx, my, mz] = extent.max as readonly [number, number, number];
  const random = mulberry32(BENCHMARK_SEED ^ target);
  const seen = new Set<string>();
  let guard = 0;
  const guardLimit = 64 * target;
  while (seen.size < target && guard < guardLimit) {
    guard += 1;
    const x = Math.floor(random() * mx);
    const y = Math.floor(random() * my);
    const z = Math.floor(random() * mz);
    const key = `${String(x)},${String(y)},${String(z)}`;
    if (!seen.has(key)) {
      seen.add(key);
      entries.push([x, y, z]);
    }
  }
  if (entries.length !== target) {
    throw new Error(
      `sparse fixture ${String(target)} did not reach target occupancy (${String(entries.length)})`,
    );
  }
  return entries;
}

/** Stable fixture ids of one benchmark scene. */
export interface BenchmarkSceneIds {
  readonly documentId: string;
  readonly rootNodeId: string;
  readonly volumeId: VolumeId;
  readonly materialIds: readonly MaterialId[];
}

/** Builds the scene ids once; the same ids across kinds and sizes. */
function sceneIds(seedSuffix: string): BenchmarkSceneIds {
  return {
    documentId: `document:bench:${seedSuffix}`,
    rootNodeId: `node:bench:${seedSuffix}:root`,
    volumeId: volumeId(`volume:bench:${seedSuffix}`),
    materialIds: [materialId(1), materialId(2), materialId(3), materialId(4)],
  };
}

/** A fully committed benchmark scene ready for measurement. */
export interface BenchmarkFixture {
  readonly kind: BenchmarkSceneKind;
  readonly targetOccupied: number;
  readonly occupiedCount: number;
  readonly extent: IntAabbLike;
  readonly handle: DocumentStoreHandle;
  /** The full store (bus-ownable); the fixture is committed once. */
  readonly store: DocumentStore;
  readonly volumeId: VolumeId;
  /** Canonical semantic hash of the committed fixture. */
  readonly semanticHash: string;
}

/** Deterministic material for a scene voxel (1..4, by coordinate hash). */
function materialFor(
  x: number,
  y: number,
  z: number,
  ids: BenchmarkSceneIds,
): MaterialId {
  const index = Math.abs((x * 31 + y * 17 + z * 7) % ids.materialIds.length);
  return ids.materialIds[index] as MaterialId;
}

/**
 * Creates and commits one deterministic benchmark scene. Seeding is a
 * fixture operation (staged writes, one synthetic commit); every
 * *measured* latency starts from a committed store.
 */
export function createBenchmarkFixture(
  kind: BenchmarkSceneKind,
  targetOccupied: number,
): BenchmarkFixture {
  const ids = sceneIds(`${kind}-${String(targetOccupied)}`);
  const extent = sceneExtent(kind, targetOccupied);
  const document: VoxelDocument = createDocument({
    documentId: documentId(ids.documentId),
    metadata: { title: `benchmark ${kind} ${String(targetOccupied)}` },
    rootNodeId: nodeId(ids.rootNodeId),
    nodes: [
      {
        nodeId: nodeId(ids.rootNodeId),
        name: "Root",
        parentId: null,
        children: [],
        transform: identity,
        components: [
          {
            kind: "voxel",
            schemaVersion: 1,
            volumeId: ids.volumeId,
          },
        ],
      },
    ],
    materials: ids.materialIds.map((id, index) => ({
      materialId: id,
      name: `bench-${String(index + 1)}`,
      color: ["#b06a3b", "#3b7ab0", "#6ab03b", "#b0a63b"][index] as string,
      opacity: 1,
      roughness: 0.5,
      metallic: 0,
      emissive: 0,
    })),
    volumes: [
      {
        volumeId: ids.volumeId,
        name: "bench",
        bounds: { min: extent.min, max: extent.max },
      },
    ],
  });
  const handle = createDocumentStore({ document });
  const { store, writeCapability } = handle;
  const staged = store.stageVolume(ids.volumeId);
  if (staged === undefined) throw new Error("benchmark volume missing");
  for (const [x, y, z] of sceneEntries(kind, targetOccupied)) {
    staged.setVoxel(
      [x, y, z],
      materialFor(x, y, z, ids),
      writeCapability,
    );
  }
  const event: DocumentCommitted = {
    revisionBefore: store.revision,
    revisionAfter: store.revision + 1,
    transactionId: transactionId(`transaction:bench:seed:${kind}:${String(targetOccupied)}`),
    source: "system",
    commandIds: [commandId(`command:bench:seed:${kind}:${String(targetOccupied)}`)],
    commandTypes: ["seedBenchmarkFixture"],
    changedNodeIds: [],
    changedMaterialIds: [],
    changedAnimationIds: [],
    changedVolumes: [
      {
        volumeId: ids.volumeId,
        chunks: [],
        bounds: { min: extent.min, max: extent.max },
      },
    ],
  };
  store.commit(
    {
      document: { ...document, revision: store.revision + 1 },
      volumes: new Map([[ids.volumeId, staged]]),
      removedVolumes: [],
    },
    event,
    writeCapability,
  );
  const volumes = new Map<VolumeId, VoxelVolumeReadView>();
  const volume = store.getVolume(ids.volumeId);
  if (volume !== undefined) volumes.set(ids.volumeId, volume);
  return {
    kind,
    targetOccupied,
    occupiedCount: store.getVolume(ids.volumeId)?.occupiedCount() ?? 0,
    extent,
    handle,
    store,
    volumeId: ids.volumeId,
    // Hash the COMMITTED state (revision 1), which is what save/load
    // round trips must reproduce.
    semanticHash: canonicalAssetSemanticHash(store.getDocument(), volumes),
  };
}

/** A fixed localized edit coordinate inside every benchmark extent. */
export const BENCHMARK_EDIT_COORDINATE: readonly [number, number, number] = [
  2, 2, 2,
] as const;

/**
 * Track-count scaling fixture (ADR-0008 "10,000 active Tracks"): one
 * clip whose two-keyframe tracks animate a flat hierarchy, up to two
 * tracks (rotation and scale) per node. Two tracks per node keeps the
 * 10,000-track matrix inside the document's 10,000-node limit. Pure
 * document construction — no store, no commands.
 */
export function createAnimationScaleDocument(
  trackCount: number,
): {
  readonly document: VoxelDocument;
  readonly clip: AnimationDescriptor;
  readonly trackCount: number;
} {
  const rootId = nodeId("node:bench:anim:root");
  const clipId = animationId("animation:bench:scale:0001");
  const nodes: SceneNode[] = [];
  const rootChildren: NodeId[] = [];
  const tracks: AnimationTrack[] = [];
  const root: SceneNode = {
    nodeId: rootId,
    name: "Root",
    parentId: null,
    children: rootChildren,
    transform: identity,
    components: [],
  };
  nodes.push(root);
  const nodeCount = Math.ceil(trackCount / 2);
  for (let i = 0; i < nodeCount; i += 1) {
    const id = nodeId(`node:bench:anim:${String(i)}`);
    nodes.push({
      nodeId: id,
      name: `Animated ${String(i)}`,
      parentId: rootId,
      children: [],
      transform: identity,
      components: [{ kind: "pivot", schemaVersion: 1, pivot: [0, 0, 0] }],
    });
    rootChildren.push(id);
    for (const offset of [0, 1]) {
      const trackIndex = i * 2 + offset;
      if (trackIndex >= trackCount) break;
      const rotation = offset === 0;
      tracks.push({
        trackId: trackId(`track:bench:scale:${String(trackIndex)}`),
        targetNodeId: id,
        interpolation: "smoothstep",
        keyframes: rotation
          ? [
              {
                keyframeId: keyframeId(
                  `keyframe:bench:scale:${String(trackIndex)}:0`,
                ),
                time: 0,
                property: { channel: "rotation", value: [1, 0, 0, 0] },
              },
              {
                keyframeId: keyframeId(
                  `keyframe:bench:scale:${String(trackIndex)}:1`,
                ),
                time: 1,
                property: {
                  channel: "rotation",
                  value: [0, 1, 0, Math.PI / 2],
                },
              },
            ]
          : [
              {
                keyframeId: keyframeId(
                  `keyframe:bench:scale:${String(trackIndex)}:0`,
                ),
                time: 0,
                property: { channel: "scale", value: [1, 1, 1] },
              },
              {
                keyframeId: keyframeId(
                  `keyframe:bench:scale:${String(trackIndex)}:1`,
                ),
                time: 1,
                property: { channel: "scale", value: [1.2, 1.2, 1.2] },
              },
            ],
      });
    }
  }
  const clip: AnimationDescriptor = {
    animationId: clipId,
    name: "Scale",
    duration: 2,
    loop: "loop",
    tracks,
  };
  const document = createDocument({
    documentId: documentId("document:bench:anim:scale"),
    metadata: { title: `benchmark animation scale ${String(trackCount)}` },
    rootNodeId: rootId,
    nodes,
    materials: [],
    volumes: [],
    animations: [clip],
  });
  return { document, clip, trackCount };
}

/** The track counts of the animation scaling matrix. */
export const ANIMATION_TRACK_COUNTS: readonly number[] = Object.freeze([
  100, 1_000, 10_000,
]);
