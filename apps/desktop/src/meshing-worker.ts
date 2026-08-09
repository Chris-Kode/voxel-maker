import {
  createMeshingWorkerScope,
  type MeshingWorkerScope,
} from "@voxel-maker/renderer";

/**
 * Desktop meshing worker entry (plan S6.6, ticket #23).
 *
 * The scene adapter's worker pool posts copied immutable chunk-and-halo
 * requests here; this file installs the renderer package's message glue
 * onto the worker global scope. All compute, protocol validation, and
 * DTO logic lives in `@voxel-maker/renderer` (tree-shaken to the meshing
 * modules by the `sideEffects: false` package), so this file only bridges
 * to the Web Worker global.
 */

// In a worker module the global scope is `DedicatedWorkerGlobalScope`;
// TypeScript's DOM lib types it as `Window`, so the narrow surface the
// glue needs is applied explicitly.
const scope = globalThis as unknown as MeshingWorkerScope;

createMeshingWorkerScope(scope);
