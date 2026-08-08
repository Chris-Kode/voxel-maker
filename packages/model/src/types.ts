import type {
  AnimationId,
  ComponentId,
  DocumentId,
  JsonValue,
  KeyframeId,
  MaterialId,
  NodeId,
  TrackId,
  VolumeId,
} from "@voxel-maker/shared";
import type { IntAabb, Quat, Transform, Vec3 } from "@voxel-maker/math";
import type { Color } from "./color.js";

/**
 * Bounded JSON-compatible metadata. Metadata is inert to engine behavior:
 * it is stored, validated, and round-tripped but never interpreted.
 */
export type MetadataRecord = Readonly<Record<string, JsonValue>>;

/** The frozen v1 persisted generic asset document (plan section 5.1). */
export interface VoxelDocument {
  readonly documentId: DocumentId;
  readonly documentSchemaVersion: 1;
  /** Logical session revision; increments once per committed transaction. */
  readonly revision: number;
  readonly metadata: MetadataRecord;
  readonly rootNodeId: NodeId;
  readonly nodes: Readonly<Record<NodeId, SceneNode>>;
  readonly materials: Readonly<Record<MaterialId, MaterialRecord>>;
  readonly volumes: Readonly<Record<VolumeId, VolumeDescriptor>>;
  readonly animations: Readonly<Record<AnimationId, AnimationDescriptor>>;
}

/** An ordered hierarchy element that locates and organizes asset content. */
export interface SceneNode {
  readonly nodeId: NodeId;
  readonly name?: string;
  /** Null only for the document root; every other node has exactly one parent. */
  readonly parentId: NodeId | null;
  /** Ordered child references; unique and never self-referential. */
  readonly children: readonly NodeId[];
  readonly transform: Transform;
  readonly components: readonly Component[];
  readonly metadata?: MetadataRecord;
}

/**
 * Closed, independently versioned component union. `voxel`, `pivot`, and
 * `joint` are singletons per node; constraints carry stable IDs and order.
 */
export type Component =
  | VoxelComponent
  | PivotComponent
  | JointComponent
  | ConstraintComponent;

export interface VoxelComponent {
  readonly kind: "voxel";
  readonly schemaVersion: 1;
  readonly volumeId: VolumeId;
}

export interface PivotComponent {
  readonly kind: "pivot";
  readonly schemaVersion: 1;
  readonly pivot: Vec3;
}

/** An articulation annotation on a Node; never a second parent graph. */
export interface JointComponent {
  readonly kind: "joint";
  readonly schemaVersion: 1;
}

export interface ConstraintComponent {
  readonly kind: "constraint";
  readonly schemaVersion: 1;
  readonly constraints: readonly ConstraintDescriptor[];
}

export interface ConstraintDescriptor {
  readonly componentId: ComponentId;
  readonly type: "rotation-limits";
  /** Local Euler XYZ rotation limits in radians; min <= max per axis. */
  readonly limits: RotationLimits;
}

export interface RotationLimits {
  readonly min: Vec3;
  readonly max: Vec3;
}

/** v1 material record; IDs are exact caller-supplied unsigned 16-bit values. */
export interface MaterialRecord {
  readonly materialId: MaterialId;
  readonly name: string;
  readonly color: Color;
  readonly opacity: number;
  readonly roughness: number;
  readonly metallic: number;
  readonly emissive: number;
}

/** Factory input for a material; colors are canonicalized on creation. */
export type MaterialRecordInput = Omit<MaterialRecord, "color"> & {
  readonly color: string;
};

/** Descriptor of a Voxel Volume; bulk chunk bytes serialize separately. */
export interface VolumeDescriptor {
  readonly volumeId: VolumeId;
  readonly name?: string;
  /** Half-open integer bounds `[min, max)` when known by the caller. */
  readonly bounds?: IntAabb;
}

/** A generic animation Clip: bounded tracks evaluated over a duration. */
export interface AnimationDescriptor {
  readonly animationId: AnimationId;
  readonly name?: string;
  readonly duration: number;
  readonly loop: LoopPolicy;
  readonly tracks: readonly AnimationTrack[];
}

export type LoopPolicy = "once" | "loop";

/** An ordered set of typed keyframes targeting one property of a Node. */
export interface AnimationTrack {
  readonly trackId: TrackId;
  readonly targetNodeId: NodeId;
  readonly interpolation: Interpolation;
  readonly keyframes: readonly Keyframe[];
}

export type Interpolation = "step" | "linear" | "smoothstep";

export interface Keyframe {
  readonly keyframeId: KeyframeId;
  readonly time: number;
  readonly property: TrackProperty;
}

/** Typed track property; rotation values are canonical quaternions. */
export type TrackProperty =
  | { readonly channel: "translation"; readonly value: Vec3 }
  | { readonly channel: "rotation"; readonly value: Quat }
  | { readonly channel: "scale"; readonly value: Vec3 };
