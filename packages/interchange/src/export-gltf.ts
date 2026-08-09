import { WorkspaceError, type VolumeId } from "@voxel-maker/shared";
import type { VoxelDocument } from "@voxel-maker/model";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";
import {
  encodeGlb,
  encodeGltfJson,
  planGltfExport,
  preflightGltfExport,
  type GltfExportLimits,
  type GltfExportLoss,
  type GltfExportMetadata,
} from "@voxel-maker/formats";
import {
  type AtomicWritePhase,
  type AtomicWriteResult,
  type ProjectStoragePort,
} from "@voxel-maker/storage";

/**
 * glTF/GLB export service (plan S16.3-S16.4, tickets #41/#42): preflights
 * the open document (unsupported features and structural problems), maps it
 * to the deterministic export scene graph (static meshes plus, by default,
 * Clips as glTF animations), encodes glTF 2.0 JSON with an embedded buffer
 * or a binary GLB container, and writes through the scoped atomic storage
 * port with progress and cancellation. Export never mutates the document.
 * A preflight block returns a structured loss report and writes nothing;
 * resource-limit violations throw structured `limit`-family errors before
 * any bytes are written.
 */

/** Options for one static glTF export. */
export interface ExportGltfOptions {
  readonly document: VoxelDocument;
  /** Volume read access; the caller supplies the session store. */
  readonly getVolume: (volumeId: VolumeId) => VoxelVolumeReadView | undefined;
  /** Scoped atomic-write port (memory in tests, Node/Tauri in apps). */
  readonly storagePort: ProjectStoragePort;
  /**
   * Destination path; the extension selects the format (`.glb` binary
   * container, `.gltf` JSON with embedded data-URI buffer). The caller has
   * already resolved overwrite consent.
   */
  readonly path: string;
  /** Cooperative cancellation for the atomic write. */
  readonly signal?: AbortSignal;
  /** Per-phase progress (mirrors the atomic-write phases). */
  readonly onPhase?: (phase: AtomicWritePhase) => void;
  /** Export resource limits; callers may only lower the defaults. */
  readonly limits?: GltfExportLimits;
  /**
   * When false, Clips are omitted and reported (static-only export);
   * when true or omitted, Clips map to glTF animations (ADR-0011,
   * ticket #42).
   */
  readonly includeAnimations?: boolean;
}

/** Outcome of one export: either written or blocked by the loss report. */
export type ExportGltfOutcome =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly format: "gltf" | "glb";
      readonly losses: readonly GltfExportLoss[];
      readonly metadata: GltfExportMetadata;
      readonly write: AtomicWriteResult;
    }
  | {
      readonly ok: false;
      readonly blocked: readonly GltfExportLoss[];
    };

/** Resolves the output format from the destination extension. */
export function exportFormatForPath(path: string): "gltf" | "glb" {
  if (path.endsWith(".glb")) return "glb";
  if (path.endsWith(".gltf")) return "gltf";
  throw new WorkspaceError({
    family: "validation",
    code: "GLTF_UNSUPPORTED_EXTENSION",
    message: "glTF export requires a .gltf or .glb destination path",
    context: { path },
  });
}

/** Exports the document to a static glTF or GLB file. */
export async function exportGltf(
  options: ExportGltfOptions,
): Promise<ExportGltfOutcome> {
  const format = exportFormatForPath(options.path);
  const preflight = preflightGltfExport(options.document, options.getVolume, {
    ...(options.includeAnimations !== undefined
      ? { includeAnimations: options.includeAnimations }
      : {}),
  });
  if (!preflight.ok) return { ok: false, blocked: preflight.blocked };
  const sceneGraph = planGltfExport(
    options.document,
    options.getVolume,
    preflight,
    options.limits,
    {
      ...(options.includeAnimations !== undefined
        ? { includeAnimations: options.includeAnimations }
        : {}),
    },
  );
  const bytes =
    format === "glb"
      ? encodeGlb(sceneGraph, options.limits)
      : new TextEncoder().encode(
          encodeGltfJson(sceneGraph, options.limits).json,
        );
  const write = await options.storagePort.writeProjectAtomic(
    options.path,
    bytes,
    {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.onPhase !== undefined ? { onPhase: options.onPhase } : {}),
    },
  );
  return {
    ok: true,
    bytes,
    format,
    losses: sceneGraph.losses,
    metadata: sceneGraph.metadata,
    write,
  };
}
