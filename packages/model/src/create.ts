import {
  WorkspaceError,
  type DocumentId,
  type JsonValue,
  type NodeId,
} from "@voxel-maker/shared";
import {
  canonicalIntAabb,
  canonicalQuat,
  canonicalScale,
  canonicalTransform,
  canonicalVec3,
} from "@voxel-maker/math";
import { canonicalDocumentJson } from "./canonical.js";
import { canonicalColor } from "./color.js";
import { deepFreeze } from "./freeze.js";
import { parseDocument } from "./parse.js";
import { DEFAULT_DOCUMENT_LIMITS, type DocumentLimits } from "./limits.js";
import type {
  AnimationDescriptor,
  AnimationTrack,
  Component,
  ConstraintDescriptor,
  Keyframe,
  MaterialRecord,
  MaterialRecordInput,
  MetadataRecord,
  SceneNode,
  TrackProperty,
  VoxelDocument,
  VolumeDescriptor,
} from "./types.js";
import { validateDocument } from "./validate.js";

/** Inputs for `createDocument`; every identifier is caller-supplied. */
export interface CreateDocumentInput {
  readonly documentId: DocumentId;
  /** Logical session revision; defaults to 0. */
  readonly revision?: number;
  readonly metadata?: MetadataRecord;
  readonly rootNodeId: NodeId;
  readonly nodes: readonly SceneNode[];
  readonly materials?: readonly MaterialRecordInput[];
  readonly volumes?: readonly VolumeDescriptor[];
  readonly animations?: readonly AnimationDescriptor[];
}

const MAX_METADATA_COPY_DEPTH = 64;

function copyJson(value: unknown, seen: Set<object>, depth: number): JsonValue {
  if (value === null || typeof value !== "object") {
    if (
      typeof value === "boolean" ||
      typeof value === "number" ||
      typeof value === "string"
    ) {
      return value;
    }
    // Non-JSON leaves (undefined, functions, symbols, BigInt) are copied
    // through so validation can report them with a precise path.
    return value as JsonValue;
  }
  if (depth > MAX_METADATA_COPY_DEPTH) {
    throw new WorkspaceError({
      family: "limit",
      code: "METADATA_TOO_DEEP",
      message: "Metadata is nested too deeply to be represented canonically",
    });
  }
  if (seen.has(value)) {
    throw new WorkspaceError({
      family: "validation",
      code: "CYCLIC_VALUE",
      message: "Metadata cannot contain cycles",
    });
  }
  seen.add(value);
  if (Array.isArray(value)) {
    const items = value as readonly JsonValue[];
    const copied: JsonValue[] = [];
    for (let index = 0; index < items.length; index += 1) {
      if (!(index in items)) {
        throw new WorkspaceError({
          family: "validation",
          code: "SPARSE_ARRAY",
          message: "Metadata arrays cannot contain holes",
        });
      }
      copied.push(copyJson(items[index], seen, depth + 1));
    }
    seen.delete(value);
    return copied;
  }
  const copied = Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      copyJson(item, seen, depth + 1),
    ]),
  );
  seen.delete(value);
  return copied;
}

function canonicalizeMetadata(
  metadata: MetadataRecord | undefined,
): MetadataRecord | undefined {
  if (metadata === undefined) return undefined;
  return copyJson(metadata, new Set(), 0) as MetadataRecord;
}

function canonicalizeConstraint(
  constraint: ConstraintDescriptor,
  path: readonly (string | number)[],
): ConstraintDescriptor {
  return {
    componentId: constraint.componentId,
    type: constraint.type,
    limits: {
      min: canonicalVec3(constraint.limits.min, [...path, "limits", "min"]),
      max: canonicalVec3(constraint.limits.max, [...path, "limits", "max"]),
    },
  };
}

function canonicalizeComponent(
  component: Component,
  path: readonly (string | number)[],
): Component {
  switch (component.kind) {
    case "voxel":
      return { kind: "voxel", schemaVersion: 1, volumeId: component.volumeId };
    case "pivot":
      return {
        kind: "pivot",
        schemaVersion: 1,
        pivot: canonicalVec3(component.pivot, [...path, "pivot"]),
      };
    case "joint":
      return { kind: "joint", schemaVersion: 1 };
    case "constraint":
      return {
        kind: "constraint",
        schemaVersion: 1,
        constraints: component.constraints.map((constraint, index) =>
          canonicalizeConstraint(constraint, [...path, "constraints", index]),
        ),
      };
  }
}

function canonicalizeNode(node: SceneNode): SceneNode {
  const transformPath = ["nodes", node.nodeId, "transform"] as const;
  const componentPath = ["nodes", node.nodeId, "components"] as const;
  const result = {
    nodeId: node.nodeId,
    parentId: node.parentId,
    children: [...node.children],
    transform: canonicalTransform(node.transform, transformPath),
    components: node.components.map((component, index) =>
      canonicalizeComponent(component, [...componentPath, index]),
    ),
  } as SceneNode;
  if (node.name !== undefined) Object.assign(result, { name: node.name });
  if (node.metadata !== undefined) {
    Object.assign(result, { metadata: canonicalizeMetadata(node.metadata) });
  }
  return result;
}

function canonicalizeMaterial(material: MaterialRecordInput): MaterialRecord {
  return {
    materialId: material.materialId,
    name: material.name,
    color: canonicalColor(material.color, [
      "materials",
      String(material.materialId),
      "color",
    ]),
    opacity: material.opacity,
    roughness: material.roughness,
    metallic: material.metallic,
    emissive: material.emissive,
  };
}

function canonicalizeVolume(volume: VolumeDescriptor): VolumeDescriptor {
  const result = {
    volumeId: volume.volumeId,
  } as VolumeDescriptor;
  if (volume.name !== undefined) Object.assign(result, { name: volume.name });
  if (volume.bounds !== undefined) {
    Object.assign(result, {
      bounds: canonicalIntAabb(volume.bounds, [
        "volumes",
        volume.volumeId,
        "bounds",
      ]),
    });
  }
  return result;
}

function canonicalizeKeyframe(
  keyframe: Keyframe,
  path: readonly (string | number)[],
): Keyframe {
  const valuePath = [...path, "property", "value"] as const;
  const property: TrackProperty =
    keyframe.property.channel === "rotation"
      ? {
          channel: "rotation",
          value: canonicalQuat(keyframe.property.value, valuePath),
        }
      : keyframe.property.channel === "scale"
        ? {
            channel: "scale",
            value: canonicalScale(keyframe.property.value, valuePath),
          }
        : {
            channel: "translation",
            value: canonicalVec3(keyframe.property.value, valuePath),
          };
  return {
    keyframeId: keyframe.keyframeId,
    time: keyframe.time,
    property,
  };
}

function canonicalizeTrack(
  track: AnimationTrack,
  path: readonly (string | number)[],
): AnimationTrack {
  return {
    trackId: track.trackId,
    targetNodeId: track.targetNodeId,
    interpolation: track.interpolation,
    keyframes: track.keyframes.map((keyframe, index) =>
      canonicalizeKeyframe(keyframe, [...path, "keyframes", index]),
    ),
  };
}

function canonicalizeAnimation(
  animation: AnimationDescriptor,
): AnimationDescriptor {
  const trackPath = ["animations", animation.animationId, "tracks"] as const;
  const result = {
    animationId: animation.animationId,
    duration: animation.duration,
    loop: animation.loop,
    tracks: animation.tracks.map((track, index) =>
      canonicalizeTrack(track, [...trackPath, index]),
    ),
  } as AnimationDescriptor;
  if (animation.name !== undefined)
    Object.assign(result, { name: animation.name });
  return result;
}

function toRecord<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  code: string,
  message: (key: string) => string,
  path: readonly (string | number)[],
): Record<string, T> {
  // Null prototype so caller-supplied IDs such as "toString" or
  // "__proto__" never collide with inherited object members.
  const record: Record<string, T> = Object.create(null) as Record<string, T>;
  for (const item of items) {
    const key = keyOf(item);
    if (record[key] !== undefined) {
      throw new WorkspaceError({
        family: "validation",
        code,
        message: message(key),
        path: [...path, key],
      });
    }
    record[key] = item;
  }
  return record;
}

/**
 * Deep, canonical clone of a document. The clone is produced by a full
 * serialize/parse round trip, so it shares no mutable backing data with the
 * source and preserves its semantic hash exactly.
 */
export function cloneDocument(document: VoxelDocument): VoxelDocument {
  return parseDocument(canonicalDocumentJson(document));
}

/**
 * Builds a validated, deeply frozen `VoxelDocument`. Transforms, colors, and
 * keyframe values are canonicalized (negative zero normalized, rotations
 * normalized and sign-canonicalized, scale checked strictly positive) before
 * validation; IDs and all other intent are supplied by the caller.
 */
export function createDocument(
  input: CreateDocumentInput,
  limits: DocumentLimits = DEFAULT_DOCUMENT_LIMITS,
): VoxelDocument {
  const document: VoxelDocument = {
    documentId: input.documentId,
    documentSchemaVersion: 1,
    revision: input.revision ?? 0,
    metadata: canonicalizeMetadata(input.metadata) ?? {},
    rootNodeId: input.rootNodeId,
    nodes: toRecord(
      input.nodes.map(canonicalizeNode),
      (node) => node.nodeId,
      "DUPLICATE_NODE_ID",
      (key) => `Duplicate node identifier ${key}`,
      ["nodes"],
    ) as VoxelDocument["nodes"],
    materials: toRecord(
      (input.materials ?? []).map(canonicalizeMaterial),
      (material) => String(material.materialId),
      "DUPLICATE_MATERIAL_ID",
      (key) => `Duplicate material identifier ${key}`,
      ["materials"],
    ) as VoxelDocument["materials"],
    volumes: toRecord(
      (input.volumes ?? []).map(canonicalizeVolume),
      (volume) => volume.volumeId,
      "DUPLICATE_VOLUME_ID",
      (key) => `Duplicate volume identifier ${key}`,
      ["volumes"],
    ) as VoxelDocument["volumes"],
    animations: toRecord(
      (input.animations ?? []).map(canonicalizeAnimation),
      (animation) => animation.animationId,
      "DUPLICATE_ANIMATION_ID",
      (key) => `Duplicate animation identifier ${key}`,
      ["animations"],
    ) as VoxelDocument["animations"],
  };
  const issues = validateDocument(document, limits);
  const first = issues[0];
  if (first !== undefined) {
    throw new WorkspaceError({
      family: first.family,
      code: first.code,
      message: first.message,
      path: [...first.path],
    });
  }
  return deepFreeze(document);
}
