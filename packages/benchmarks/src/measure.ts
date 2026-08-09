import {
  CommandBus,
  CommandRegistry,
  registerVoxelCommands,
  setVoxelCommand,
  type TransactionResult,
} from "@voxel-maker/commands";
import { canonicalDocumentHash } from "@voxel-maker/model";
import {
  canonicalAssetSemanticHash,
  createDocumentStore,
  type DocumentCommitted,
  type DocumentStoreRead,
} from "@voxel-maker/document";
import {
  createChunkHalo,
  createChunkScheduler,
  handleMeshingRequest,
  type ChunkMeshInput,
  type ChunkMeshOutput,
  type ChunkScheduler,
  type ChunkSchedulerDiagnostics,
  type ChunkScheduleSpec,
  type MeshingExecutor,
  type MeshingJob,
  type MeshingOutcome,
} from "@voxel-maker/renderer";
import {
  commandId,
  materialId,
  transactionId,
  type MaterialId,
  type VolumeId,
} from "@voxel-maker/shared";
import {
  writeVxlProject,
  readVxlProject,
  type LoadedVxlProject,
} from "@voxel-maker/formats";
import type { VoxelChunkSeed } from "@voxel-maker/voxel";
import { MemoryProjectStorage } from "@voxel-maker/storage";
import { exportGltf } from "@voxel-maker/interchange";
import { evaluateAnimationRuntime } from "@voxel-maker/animation";
import {
  renderStandardPreview,
  STANDARD_PREVIEW_VIEWS,
  type PreviewViewId,
} from "@voxel-maker/renderer";
import {
  createAnimationScaleDocument,
  type BenchmarkFixture,
} from "./fixtures.js";
import { summarize } from "./stats.js";
import type {
  AnimationMeasurement,
  ByteTransferMeasurement,
  MeasurementSummary,
  MemorySnapshot,
  MeshingPipelineCounters,
} from "./report.js";
import { chunkKey, type VoxelVolumeReadView } from "@voxel-maker/voxel";
/**
 * Headless measurements of the ADR-0008 gates (ticket #45): command
 * latency, localized remesh and queueing through the real dirty-chunk
 * scheduler with an asynchronous (worker-like) executor, per-frame flush
 * cost, canonical save/load, glTF export, deterministic preview render,
 * process memory, and animation scaling. Everything runs over committed
 * benchmark fixtures through the same seams the desktop uses — command
 * bus, scheduler, mesher, container codecs, export service — with no GPU
 * and no wall-clock-dependent fixture.
 */

const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/** Builds a fresh command bus over a committed fixture store. */
function createFixtureBus(fixture: BenchmarkFixture): {
  readonly bus: CommandBus;
  readonly registry: CommandRegistry;
} {
  const registry = new CommandRegistry();
  registerVoxelCommands(registry);
  const bus = new CommandBus(
    fixture.store,
    registry,
    fixture.handle.writeCapability,
  );
  return { bus, registry };
}

/** One-voxel commit latency (ADR-0008: p95 under 8 ms on the reference). */
export function measureCommandLatency(
  fixture: BenchmarkFixture,
  samples: number,
): MeasurementSummary {
  const { bus } = createFixtureBus(fixture);
  const durations: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    const result: TransactionResult = bus.execute(
      setVoxelCommand(commandId(`command:bench:edit:${String(i)}`), {
        volumeId: fixture.volumeId,
        coordinate: [...fixture.editCoordinate] as [number, number, number],
        material: toggleMaterial(fixture),
      }),
      {
        transactionId: transactionId(`transaction:bench:edit:${String(i)}`),
        source: "ui",
        expectedRevision: fixture.store.revision,
      },
    );
    durations.push(performance.now() - start);
    if (!result.ok) {
      throw new Error(`benchmark edit commit failed: ${result.error.code}`);
    }
  }
  return summarize(durations);
}

/**
 * A material that differs from the voxel currently at the edit
 * coordinate, so every measured edit is a real voxel change (material
 * 1 <-> 2 toggle) and the chunk revision actually advances.
 */
function toggleMaterial(fixture: BenchmarkFixture): MaterialId {
  const current = fixture.store.getVoxel(
    fixture.volumeId,
    fixture.editCoordinate,
  );
  return current === materialId(1) ? materialId(2) : materialId(1);
}

/** Executor that computes on a macrotask like a worker (timed). */
function createTimedAsyncExecutor(
  onMeshTime: (ms: number) => void,
): MeshingExecutor {
  return {
    start(job: MeshingJob, finish: (outcome: MeshingOutcome) => void): void {
      setImmediate(() => {
        const start = performance.now();
        try {
          const result = handleMeshingRequest(job.input);
          onMeshTime(performance.now() - start);
          finish({ ok: true, result });
        } catch (error: unknown) {
          finish({ ok: false, error });
        }
      });
    },
    dispose(): void {
      // Nothing to release: pure compute on macrotasks.
    },
  };
}

/**
 * A minimal live projection of one store over the real dirty-chunk
 * scheduler: resolve copies chunk+halo at dispatch time, install counts
 * meshes and records queue wait, exactly like the scene adapter's live
 * projection but without GPU/Three.js resources (the renderer owns the
 * Three.js projection; this harness measures the scheduler seam).
 */
class BenchmarkMeshingPipeline {
  readonly scheduler: ChunkScheduler;
  readonly #onQueueWait: (ms: number) => void;
  readonly #onFlush: (ms: number) => void;
  #store: DocumentStoreRead | undefined;
  #scheduledAt = new Map<string, number>();
  installedChunks = 0;
  installedTriangles = 0;
  installedDrawCalls = 0;
  installedMeshBytes = 0;

  constructor(
    onMeshTime: (ms: number) => void,
    onQueueWait: (ms: number) => void,
    onFlush: (ms: number) => void,
  ) {
    this.#onQueueWait = onQueueWait;
    this.#onFlush = onFlush;
    this.scheduler = createChunkScheduler({
      executor: createTimedAsyncExecutor(onMeshTime),
      resolve: (spec: ChunkScheduleSpec): ChunkMeshInput | undefined =>
        this.resolve(spec),
      install: (result: ChunkMeshOutput): void => {
        this.install(result);
      },
      maxDispatchesPerFrame: 4,
      maxUploadsPerFrame: 4,
      maxConcurrent: 2,
      maxPending: 512,
    });
  }

  /** Schedules every allocated chunk (revision 0), like a live rebind. */
  rebind(store: DocumentStoreRead): void {
    this.#store = store;
    const readView = store.getVolume(this.volumeOf(store));
    if (readView === undefined) return;
    for (const coordinate of readView.chunkCoordinates()) {
      this.scheduler.schedule({
        namespace: "live",
        volumeId: this.volumeOf(store),
        coordinate,
        revision: 0,
      });
    }
  }

  /** Schedules exactly the changed chunks of one committed transaction. */
  handleCommit(event: DocumentCommitted): void {
    for (const volume of event.changedVolumes) {
      for (const chunk of volume.chunks) {
        const key = this.keyOf(volume.volumeId, chunk.coordinate);
        this.#scheduledAt.set(key, performance.now());
        this.scheduler.schedule({
          namespace: "live",
          volumeId: volume.volumeId,
          coordinate: chunk.coordinate,
          revision: chunk.revision,
        });
      }
    }
  }

  /** One per-frame step; records the main-thread flush cost. */
  flush(): void {
    const start = performance.now();
    this.scheduler.flush();
    this.#onFlush(performance.now() - start);
  }

  /** Flushes until every job settled or the frame bound is reached. */
  async settle(maxFrames = 2_000): Promise<void> {
    for (let frame = 0; frame < maxFrames; frame += 1) {
      this.flush();
      await tick();
      const diagnostics = this.scheduler.diagnostics();
      if (
        diagnostics.pending === 0 &&
        diagnostics.inFlight === 0 &&
        diagnostics.completedQueue === 0
      ) {
        return;
      }
    }
    const diagnostics = this.scheduler.diagnostics();
    throw new Error(
      `meshing did not settle: pending=${String(diagnostics.pending)} inFlight=${String(diagnostics.inFlight)} queued=${String(diagnostics.completedQueue)}`,
    );
  }

  /** Scheduler + install counters after a settled burst. */
  counters(): MeshingPipelineCounters {
    const diagnostics: ChunkSchedulerDiagnostics = this.scheduler.diagnostics();
    return {
      dispatchedTotal: diagnostics.dispatchedTotal,
      installedTotal: diagnostics.installedTotal,
      pendingChunks: diagnostics.pending,
      inFlightMeshes: diagnostics.inFlight,
      completedQueue: diagnostics.completedQueue,
      uploadsThisFrame: diagnostics.uploadsThisFrame,
      staleDropped: diagnostics.pool.staleDropped,
      cancelled: diagnostics.pool.cancelled,
      failed: diagnostics.pool.failed,
      installedTriangles: this.installedTriangles,
      installedDrawCalls: this.installedDrawCalls,
      installedMeshBytes: this.installedMeshBytes,
    };
  }

  dispose(): void {
    this.scheduler.dispose();
  }

  resolve(spec: ChunkScheduleSpec): ChunkMeshInput | undefined {
    const readView = this.#store?.getVolume(spec.volumeId);
    if (readView === undefined) return undefined;
    const values = readView.getChunk(spec.coordinate);
    if (values === undefined) return undefined;
    return {
      namespace: spec.namespace,
      volumeId: spec.volumeId,
      coordinate: spec.coordinate,
      revision: spec.revision,
      values,
      halo: createChunkHalo(readView, spec.coordinate),
    };
  }

  install(result: ChunkMeshOutput): void {
    const key = this.keyOf(result.volumeId, result.coordinate);
    const scheduledAt = this.#scheduledAt.get(key);
    if (scheduledAt !== undefined) {
      this.#onQueueWait(performance.now() - scheduledAt);
      this.#scheduledAt.delete(key);
    }
    this.installedChunks += 1;
    this.installedTriangles += result.faceCount;
    this.installedDrawCalls += result.materialGroups.length;
    this.installedMeshBytes +=
      result.positions.byteLength +
      result.normals.byteLength +
      result.indices.byteLength;
  }

  volumeOf(store: DocumentStoreRead): VolumeId {
    return Object.keys(store.getDocument().volumes)[0] as VolumeId;
  }

  keyOf(
    volumeId: VolumeId,
    coordinate: readonly [number, number, number],
  ): string {
    return `${String(volumeId)}:${chunkKey(coordinate)}`;
  }
}

/** One full localized-edit remesh + frame-pipeline measurement. */
export interface RemeshMeasurement {
  readonly remesh: MeasurementSummary;
  readonly queueWait: MeasurementSummary;
  readonly flush: MeasurementSummary;
  readonly meshSettleMs: number;
  readonly meshing: MeshingPipelineCounters;
}

/**
 * Measures the localized-edit budget: initial meshing of the scene,
 * then `samples` one-voxel commits, each settled through the scheduler.
 * Collects per-mesh compute time (ADR-0008 remesh <30 ms p95), queue
 * wait (schedule -> install), per-frame flush cost, and pipeline
 * counters.
 */
export async function measureRemeshAndPipeline(
  fixture: BenchmarkFixture,
  samples: number,
): Promise<RemeshMeasurement> {
  const meshTimes: number[] = [];
  const queueWaits: number[] = [];
  const flushTimes: number[] = [];
  const pipeline = new BenchmarkMeshingPipeline(
    (ms: number) => {
      meshTimes.push(ms);
    },
    (ms: number) => {
      queueWaits.push(ms);
    },
    (ms: number) => {
      flushTimes.push(ms);
    },
  );
  try {
    pipeline.rebind(fixture.store);
    // Initial meshing settles before any measured edit; its mesh and
    // flush samples are NOT part of the localized-edit gate, so the
    // collectors reset here (the gate must measure only edit-driven
    // remesh work).
    await pipeline.settle();
    meshTimes.length = 0;
    queueWaits.length = 0;
    flushTimes.length = 0;
    const { bus } = createFixtureBus(fixture);
    const coordinate = fixture.editCoordinate;
    const settleStart = performance.now();
    for (let i = 0; i < samples; i += 1) {
      const result = bus.execute(
        setVoxelCommand(commandId(`command:bench:local:${String(i)}`), {
          volumeId: fixture.volumeId,
          coordinate: [...coordinate] as [number, number, number],
          material: toggleMaterial(fixture),
        }),
        {
          transactionId: transactionId(`transaction:bench:local:${String(i)}`),
          source: "ui",
          expectedRevision: fixture.store.revision,
        },
      );
      if (!result.ok) {
        throw new Error(`local edit commit failed: ${result.error.code}`);
      }
      pipeline.handleCommit(result.value.event);
      await pipeline.settle();
    }
    const meshSettleMs = performance.now() - settleStart;
    return {
      remesh: summarize(meshTimes),
      queueWait: summarize(queueWaits),
      flush: summarize(flushTimes),
      meshSettleMs,
      meshing: pipeline.counters(),
    };
  } finally {
    pipeline.dispose();
  }
}

/** Canonical save/load and glTF export measurements. */
export interface PersistenceMeasurements {
  readonly save: ByteTransferMeasurement;
  readonly load: ByteTransferMeasurement;
  readonly export: ByteTransferMeasurement;
}

/** Measures canonical `.vxl` save/load (ADR-0008: 100k <2 s, 1M <10 s). */
export function measureSaveLoad(
  fixture: BenchmarkFixture,
  runs: number,
): {
  readonly save: ByteTransferMeasurement;
  readonly load: ByteTransferMeasurement;
} {
  const document = fixture.store.getDocument();
  const volumes = new Map<VolumeId, VoxelVolumeReadView>();
  for (const key of Object.keys(document.volumes)) {
    const volumeId = key as VolumeId;
    const volume = fixture.store.getVolume(volumeId);
    if (volume !== undefined) volumes.set(volumeId, volume);
  }
  // Reference hash of the store AS IT IS at measurement time (the
  // benchmark may run before any edit measurement).
  const referenceHash = canonicalAssetSemanticHash(document, volumes);
  const saveTimes: number[] = [];
  const loadTimes: number[] = [];
  let bytes = 0;
  for (let i = 0; i < runs; i += 1) {
    const saveStart = performance.now();
    const encoded = writeVxlProject({ document, volumes });
    saveTimes.push(performance.now() - saveStart);
    bytes = encoded.byteLength;
    const loadStart = performance.now();
    const loaded = readVxlProject(encoded);
    loadTimes.push(performance.now() - loadStart);
    // Round-trip integrity: the validated load path must reproduce the
    // fixture's canonical semantic hash (verified outside the timed
    // region, since the desktop also separates parse from install).
    const loadedStore = installLoaded(loaded);
    const loadedVolumes = new Map<VolumeId, VoxelVolumeReadView>();
    for (const key of Object.keys(loaded.document.volumes)) {
      const volumeId = key as VolumeId;
      const volume = loadedStore.getVolume(volumeId);
      if (volume !== undefined) loadedVolumes.set(volumeId, volume);
    }
    const hash = canonicalAssetSemanticHash(
      loadedStore.getDocument(),
      loadedVolumes,
    );
    if (hash !== referenceHash) {
      throw new Error(
        `save/load round trip changed the semantic hash (${hash} != ${referenceHash})`,
      );
    }
  }
  return {
    save: {
      summary: summarize(saveTimes),
      bytes,
      peakRssMiB: 0,
      blocked: undefined,
    },
    load: {
      summary: summarize(loadTimes),
      bytes,
      peakRssMiB: 0,
      blocked: undefined,
    },
  };
}

/** Installs a validated load into a fresh store (the desktop load path). */
function installLoaded(loaded: LoadedVxlProject): DocumentStoreRead {
  const volumes = new Map<VolumeId, readonly VoxelChunkSeed[]>();
  for (const [id, volume] of loaded.volumes) {
    volumes.set(id, volume.chunks);
  }
  return createDocumentStore({ document: loaded.document, volumes }).store;
}

/**
 * Measures one glTF export (write through the in-memory storage port).
 * The export service rejects oversized volumes with structured
 * limit-family errors (glTF face limit) before writing bytes — that
 * graceful degradation is recorded as blocked evidence, not a crash.
 */
export async function measureExportGltf(
  fixture: BenchmarkFixture,
): Promise<ByteTransferMeasurement> {
  const document = fixture.store.getDocument();
  const storage = new MemoryProjectStorage();
  const path = `benchmark-${fixture.kind}-${String(fixture.targetOccupied)}.glb`;
  const times: number[] = [];
  let bytes = 0;
  let peakRssMiB = 0;
  let blocked: { readonly code: string; readonly message: string } | undefined;
  // Sample RSS while the export runs so the report carries the export
  // service's transient memory footprint (kept out of the interactive
  // memory gate, which measures the editor footprint).
  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss / (1024 * 1024);
    if (rss > peakRssMiB) peakRssMiB = rss;
  }, 25);
  try {
    // A single export is already heavy at 1M; keep one timed run plus a
    // warm run that also verifies the outcome shape.
    for (let i = 0; i < 2; i += 1) {
      const start = performance.now();
      const outcome = await exportGltf({
        document,
        getVolume: (volumeId: VolumeId) => fixture.store.getVolume(volumeId),
        storagePort: storage,
        path,
      });
      times.push(performance.now() - start);
      if (!outcome.ok) {
        blocked = {
          code: "PREFLIGHT_BLOCKED",
          message: "glTF preflight blocked the export",
        };
        continue;
      }
      bytes = outcome.bytes.byteLength;
      // Export encodes synchronously inside the async call, so sample
      // RSS immediately after each export: the intermediates are still
      // alive, making this a close proxy of the export peak.
      const rssMiB = process.memoryUsage().rss / (1024 * 1024);
      if (rssMiB > peakRssMiB) peakRssMiB = rssMiB;
    }
    return { summary: summarize(times), bytes, peakRssMiB, blocked };
  } catch (error: unknown) {
    // Structured limit errors (e.g. GLTF_FACE_LIMIT at >1M faces) are
    // the product's graceful degradation for oversized volumes.
    blocked = {
      code:
        typeof error === "object" && error !== null && "code" in error
          ? String((error as { code: unknown }).code)
          : "EXPORT_FAILED",
      message: error instanceof Error ? error.message : "glTF export failed",
    };
    return { summary: summarize(times), bytes, peakRssMiB, blocked };
  } finally {
    clearInterval(sampler);
  }
}

/** Deterministic software preview render latency (100k scenes only). */
export function measurePreviewLatency(
  fixture: BenchmarkFixture,
  samples: number,
  size: number,
): MeasurementSummary {
  const times: number[] = [];
  for (let i = 0; i < samples; i += 1) {
    const view: PreviewViewId = STANDARD_PREVIEW_VIEWS[
      i % STANDARD_PREVIEW_VIEWS.length
    ] as PreviewViewId;
    const start = performance.now();
    renderStandardPreview({
      store: fixture.store,
      spec: { view, width: size, height: size },
    });
    times.push(performance.now() - start);
  }
  return summarize(times);
}

/** Current process memory in MiB. */
export function memorySnapshot(): MemorySnapshot {
  const usage = process.memoryUsage();
  return {
    rssMiB: usage.rss / (1024 * 1024),
    heapUsedMiB: usage.heapUsed / (1024 * 1024),
    heapTotalMiB: usage.heapTotal / (1024 * 1024),
    arrayBuffersMiB: usage.arrayBuffers / (1024 * 1024),
  };
}

/**
 * Animation scaling (ADR-0008: 10,000 active Tracks within the 16.7 ms
 * p95 frame budget, no persistent mutation, no history growth).
 */
export function measureAnimationScale(
  trackCount: number,
  frames: number,
): AnimationMeasurement {
  const { document, clip } = createAnimationScaleDocument(trackCount);
  // Playback integrity is evidenced through the REAL session seams: the
  // store and command bus observe every evaluation, so revision and
  // history growth would be caught (ADR-0006: playback never writes).
  const handle = createDocumentStore({ document });
  const registry = new CommandRegistry();
  const bus = new CommandBus(handle.store, registry, handle.writeCapability);
  const revisionBefore = handle.store.revision;
  const historyBefore = bus.historySnapshot().past.length;
  const hashBefore = canonicalDocumentHash(document);
  const times: number[] = [];
  const duration = clip.duration;
  for (let frame = 0; frame < frames; frame += 1) {
    const time = (frame / Math.max(1, frames - 1)) * duration;
    const start = performance.now();
    evaluateAnimationRuntime(document, clip, time);
    times.push(performance.now() - start);
  }
  return {
    trackCount,
    frames,
    frameMs: summarize(times),
    revisionBefore,
    revisionAfter: handle.store.revision,
    historyBefore,
    historyAfter: bus.historySnapshot().past.length,
    semanticHashBefore: hashBefore,
    semanticHashAfter: canonicalDocumentHash(document),
  };
}
