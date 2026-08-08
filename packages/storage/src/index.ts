/**
 * Public entry point for the storage package: the project storage port,
 * atomic-save coordination with immutable revision snapshot isolation,
 * the memory adapter, and the shared adapter conformance matrix (plan
 * S5.6/S5.7/S5.14, ADR-0004, ticket #13). Platform filesystem adapters
 * live at the composition root (Node adapter in the headless app, Tauri
 * adapter in the desktop app).
 */
export {
  backupPathFor,
  defaultPhaseError,
  IO_ERROR_CODES,
  IO_ERROR_MESSAGES,
  PHASE_ERROR_CODES,
  storageIoError,
  tempPathFor,
  throwIfAborted,
  throwPhaseFault,
  type AtomicWriteFaultPlan,
  type AtomicWriteOptions,
  type AtomicWritePhase,
  type AtomicWriteResult,
  type ProjectStoragePort,
} from "./port.js";
export { captureRevisionSnapshot, type RevisionSnapshot } from "./snapshot.js";
export { createVxlProjectEncoder, type ProjectEncoder } from "./encoder.js";
export {
  createSaveCoordinator,
  type SaveCoordinator,
  type SaveCoordinatorEvent,
  type SaveCoordinatorOptions,
  type SaveOutcome,
} from "./coordinator.js";
export { MemoryProjectStorage } from "./memory-storage.js";
export {
  storagePortConformanceCases,
  type PortConformanceCase,
  type StoragePortFactory,
  type StoragePortHarness,
} from "./conformance.js";
