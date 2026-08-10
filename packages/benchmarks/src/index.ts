/**
 * Public entry point of the benchmarks package (ticket #45): the
 * headless ADR-0008 benchmark harness — deterministic 100k/500k/1M
 * fixtures (compact/sparse/checkerboard), measurements of command
 * latency, localized remesh, queueing, per-frame flush cost, canonical
 * save/load, glTF export, deterministic preview render, process memory,
 * and animation scaling; named-hardware tier gates (reference / low /
 * ci-smoke); and retained trend comparison. The CLI (`voxel-maker-bench`)
 * runs the matrix, writes the JSON report, and exits non-zero when a
 * gate fails or a retained trend regresses.
 */
export {
  ANIMATION_TRACK_COUNTS,
  BENCHMARK_SCENE_KINDS,
  BENCHMARK_SEED,
  BENCHMARK_SIZES,
  createAnimationScaleDocument,
  createBenchmarkFixture,
  mulberry32,
  sceneEntries,
  type BenchmarkSceneKind,
} from "./fixtures.js";
export {
  detectHardware,
  evaluateGates,
  resolveTier,
  summarizeGates,
  type GateDefinition,
  type GateResult,
  type GateSummary,
  type GateUnit,
  type HardwareInput,
} from "./gates.js";
export {
  measureAnimationScale,
  measureCommandLatency,
  measureExportGltf,
  measurePreviewLatency,
  measureRemeshAndPipeline,
  measureSaveLoad,
  memorySnapshot,
  type PersistenceMeasurements,
  type RemeshMeasurement,
} from "./measure.js";
export {
  appendTrendRow,
  compareWithTrends,
  DEFAULT_TREND_TOLERANCE,
  emptyTrendHistory,
  flattenReport,
  isTrendRegression,
  latestSameHardwareRow,
  sameNamedHardware,
  type BenchmarkTrendHistory,
  type TrendComparison,
  type TrendRow,
  type TrendTolerance,
} from "./trends.js";
export { percentile, summarize, type SampleSummary } from "./stats.js";
export {
  runBenchmarks,
  type BenchmarkRunOutcome,
  type RunBenchmarksOptions,
} from "./run.js";
export type {
  AnimationMeasurement,
  BenchmarkReport,
  ByteTransferMeasurement,
  FlattenedValues,
  HardwareInfo,
  MeasurementSummary,
  MemorySnapshot,
  MeshingPipelineCounters,
  SceneMeasurements,
  TierName,
} from "./report.js";
