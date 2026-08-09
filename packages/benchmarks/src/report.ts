/**
 * Benchmark report schema (ticket #45, ADR-0008): the full recorded
 * evidence of one benchmark run — named hardware, fixture versions and
 * hashes, measurement summaries per scene and metric, animation scaling,
 * and the gate verdicts. Reports are written as JSON by the CLI and
 * uploaded/retained by CI so regressions can be compared across runs on
 * the same named hardware.
 */

import type { BenchmarkSceneKind } from "./fixtures.js";
import type { SampleSummary } from "./stats.js";

/** The hardware tiers ADR-0008 names (plus the CI smoke tier). */
export type TierName = "reference" | "low" | "ci-smoke";

/** Named hardware of the machine that ran the benchmark. */
export interface HardwareInfo {
  /** Explicitly resolved tier (reference / low / ci-smoke). */
  readonly tier: TierName;
  /** CPU model string (os.cpus()[0].model), the named-hardware identity. */
  readonly cpuModel: string;
  readonly platform: string;
  readonly arch: string;
  readonly cores: number;
  /** Total system memory in GiB (rounded to 0.1). */
  readonly totalMemoryGiB: number;
  readonly nodeVersion: string;
}

/** Percentile summary of one measured distribution (ms). */
export type MeasurementSummary = SampleSummary;

/** Meshing pipeline counters captured after a burst settles. */
export interface MeshingPipelineCounters {
  readonly dispatchedTotal: number;
  readonly installedTotal: number;
  readonly pendingChunks: number;
  readonly inFlightMeshes: number;
  readonly completedQueue: number;
  readonly uploadsThisFrame: number;
  readonly staleDropped: number;
  readonly cancelled: number;
  readonly failed: number;
  readonly installedTriangles: number;
  readonly installedDrawCalls: number;
  readonly installedMeshBytes: number;
}

/** One timed save/load/export operation. */
export interface ByteTransferMeasurement {
  readonly summary: MeasurementSummary;
  readonly bytes: number;
  /** Peak process RSS observed while the operation ran (MiB). */
  readonly peakRssMiB: number;
  /**
   * Structured rejection evidence when the export service refused the
   * volume (e.g. the glTF face limit): graceful degradation is recorded,
   * not hidden.
   */
  readonly blocked?: { readonly code: string; readonly message: string };
}

/** Process memory snapshot (MiB). */
export interface MemorySnapshot {
  readonly rssMiB: number;
  readonly heapUsedMiB: number;
  readonly heapTotalMiB: number;
  readonly arrayBuffersMiB: number;
}

/** All measurements of one (kind, size) scene. */
export interface SceneMeasurements {
  /** Fixture seeding time (excluded from latency gates). */
  readonly buildMs: number;
  /** One-voxel Transaction commit latency (ADR-0008 <8 ms p95). */
  readonly command: MeasurementSummary;
  /** Localized face-cull remesh compute time per mesh (ADR-0008 <30 ms). */
  readonly remesh: MeasurementSummary;
  /** Schedule -> install wait of one localized mesh (queueing). */
  readonly queueWait: MeasurementSummary;
  /** Main-thread per-frame flush cost (scheduler frame proxy). */
  readonly flush: MeasurementSummary;
  /** Wall time for one localized edit burst to fully settle. */
  readonly meshSettleMs: number;
  readonly meshing: MeshingPipelineCounters;
  readonly save: ByteTransferMeasurement;
  readonly load: ByteTransferMeasurement;
  readonly export: ByteTransferMeasurement;
  /** Deterministic software preview render latency (100k scenes only). */
  readonly preview?: MeasurementSummary;
  /** Composite headless proxy of input-to-preview (commit+remesh+flush+preview). */
  readonly inputToPreview95Ms?: number;
  readonly memory: MemorySnapshot;
}

/** Animation scaling measurement of one track count. */
export interface AnimationMeasurement {
  readonly trackCount: number;
  readonly frames: number;
  /** One full layered runtime evaluation (ADR-0008 16.7 ms p95 at 10k). */
  readonly frameMs: MeasurementSummary;
  /** Playback must never mutate persistent state (ADR-0006). */
  readonly revisionBefore: number;
  readonly revisionAfter: number;
  readonly historyBefore: number;
  readonly historyAfter: number;
  readonly semanticHashBefore: string;
  readonly semanticHashAfter: string;
}

/** The complete recorded report of one benchmark run. */
export interface BenchmarkReport {
  readonly schemaVersion: 1;
  /** Version of the benchmark harness itself. */
  readonly benchmarkVersion: string;
  readonly date: string;
  readonly hardware: HardwareInfo;
  readonly options: {
    readonly sizes: readonly number[];
    readonly kinds: readonly BenchmarkSceneKind[];
    readonly samples: number;
    readonly saveLoadRuns: number;
    readonly full: boolean;
  };
  /** Measurements keyed by `scenes[kind][String(size)]`. */
  readonly scenes: Readonly<
    Record<BenchmarkSceneKind, Readonly<Record<string, SceneMeasurements>>>
  >;
  readonly animation: readonly AnimationMeasurement[];
  readonly durationMs: number;
}

/** Flattened numeric view of a report for trend rows. */
export type FlattenedValues = Readonly<Record<string, number>>;
