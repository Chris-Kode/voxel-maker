/**
 * Default resource limits for one open Document (ADR-0009). Counts are totals
 * per Document; callers may lower, never raise, these hard defaults.
 */
export interface DocumentLimits {
  readonly maxNodes: number;
  readonly maxVolumes: number;
  readonly maxMaterials: number;
  readonly maxClips: number;
  readonly maxTracks: number;
  readonly maxKeyframes: number;
  readonly maxKeyframesPerTrack: number;
  readonly maxClipDurationSeconds: number;
  readonly maxNameBytes: number;
  readonly maxMetadataDepth: number;
  readonly maxMetadataMembers: number;
  readonly maxMetadataBytes: number;
  readonly maxMetadataStringBytes: number;
  readonly maxVoxelCoordinate: number;
  readonly maxRevision: number;
}

/** ADR-0009 hard defaults for the v1 document model. */
export const DEFAULT_DOCUMENT_LIMITS: DocumentLimits = Object.freeze({
  maxNodes: 10_000,
  maxVolumes: 1_024,
  maxMaterials: 4_096,
  maxClips: 256,
  maxTracks: 10_000,
  maxKeyframes: 1_000_000,
  maxKeyframesPerTrack: 100_000,
  maxClipDurationSeconds: 86_400,
  maxNameBytes: 256,
  maxMetadataDepth: 16,
  maxMetadataMembers: 10_000,
  maxMetadataBytes: 1_048_576,
  maxMetadataStringBytes: 65_536,
  maxVoxelCoordinate: 1_048_575,
  maxRevision: Number.MAX_SAFE_INTEGER,
});
