import { WorkspaceError, type JsonValue } from "@voxel-maker/shared";
import type {
  AnimationDescriptor,
  AnimationTrack,
  Component,
  ConstraintDescriptor,
  Keyframe,
  MaterialRecord,
  MetadataRecord,
  SceneNode,
  TrackProperty,
  VoxelDocument,
  VolumeDescriptor,
} from "./types.js";
import type { IntAabb, Quat, Transform, Vec3, Vec3i } from "@voxel-maker/math";
import { compareCodeUnit, compareNumeric } from "./order.js";
import { sha256Hex } from "./sha256.js";

const encoder = new TextEncoder();

function serializeString(value: string): string {
  return JSON.stringify(value);
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_CANONICAL_NUMBER",
      message:
        "Canonical JSON requires finite numbers and forbids negative zero",
    });
  }
  return JSON.stringify(value);
}

function serializeVec3(value: Vec3): string {
  return `[${serializeNumber(value[0])},${serializeNumber(value[1])},${serializeNumber(value[2])}]`;
}

function serializeVec3i(value: Vec3i): string {
  return serializeVec3(value);
}

function serializeQuat(value: Quat): string {
  return `[${serializeNumber(value[0])},${serializeNumber(value[1])},${serializeNumber(value[2])},${serializeNumber(value[3])}]`;
}

/**
 * Serializes an object whose members are emitted in RFC 8785 Unicode code
 * unit order. Arrays preserve schema order.
 */
function serializeMembers(
  entries: readonly (readonly [string, string])[],
): string {
  const sorted = [...entries].sort(([a], [b]) => compareCodeUnit(a, b));
  return `{${sorted.map(([key, value]) => `${serializeString(key)}:${value}`).join(",")}}`;
}

function serializeTransform(transform: Transform): string {
  return serializeMembers([
    ["pivot", serializeVec3(transform.pivot)],
    ["rotation", serializeQuat(transform.rotation)],
    ["scale", serializeVec3(transform.scale)],
    ["translation", serializeVec3(transform.translation)],
  ]);
}

function serializeIntAabb(bounds: IntAabb): string {
  return serializeMembers([
    ["max", serializeVec3i(bounds.max)],
    ["min", serializeVec3i(bounds.min)],
  ]);
}

function serializeRotationLimits(constraint: ConstraintDescriptor): string {
  return serializeMembers([
    ["max", serializeVec3(constraint.limits.max)],
    ["min", serializeVec3(constraint.limits.min)],
  ]);
}

function serializeConstraint(constraint: ConstraintDescriptor): string {
  return serializeMembers([
    ["componentId", serializeString(constraint.componentId)],
    ["limits", serializeRotationLimits(constraint)],
    ["type", serializeString(constraint.type)],
  ]);
}

function serializeComponent(component: Component): string {
  switch (component.kind) {
    case "voxel":
      return serializeMembers([
        ["kind", '"voxel"'],
        ["schemaVersion", "1"],
        ["volumeId", serializeString(component.volumeId)],
      ]);
    case "pivot":
      return serializeMembers([
        ["kind", '"pivot"'],
        ["pivot", serializeVec3(component.pivot)],
        ["schemaVersion", "1"],
      ]);
    case "joint":
      return serializeMembers([
        ["kind", '"joint"'],
        ["schemaVersion", "1"],
      ]);
    case "constraint":
      return serializeMembers([
        [
          "constraints",
          `[${component.constraints.map(serializeConstraint).join(",")}]`,
        ],
        ["kind", '"constraint"'],
        ["schemaVersion", "1"],
      ]);
  }
}

function serializeMetadata(
  metadata: MetadataRecord,
  seen: Set<object> = new Set(),
): string {
  if (seen.has(metadata)) {
    throw new WorkspaceError({
      family: "validation",
      code: "CYCLIC_VALUE",
      message: "Canonical JSON cannot contain cycles",
    });
  }
  seen.add(metadata);
  const parts = Object.entries(metadata)
    .sort(([a], [b]) => compareCodeUnit(a, b))
    .map(
      ([key, value]) =>
        `${serializeString(key)}:${serializeJsonValue(value, seen)}`,
    );
  seen.delete(metadata);
  return `{${parts.join(",")}}`;
}

function serializeJsonValue(value: JsonValue, seen: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return serializeNumber(value);
  if (typeof value === "string") return serializeString(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new WorkspaceError({
        family: "validation",
        code: "CYCLIC_VALUE",
        message: "Canonical JSON cannot contain cycles",
      });
    }
    seen.add(value);
    const items = value as readonly JsonValue[];
    const parts = items.map((item) => serializeJsonValue(item, seen));
    seen.delete(value);
    return `[${parts.join(",")}]`;
  }
  return serializeMetadata(value as MetadataRecord, seen);
}

function serializeNode(node: SceneNode): string {
  const entries: readonly (readonly [string, string])[] = [
    ["children", `[${node.children.map(serializeString).join(",")}]`],
    ["components", `[${node.components.map(serializeComponent).join(",")}]`],
    ...(node.name === undefined
      ? []
      : ([["name", serializeString(node.name)]] as const)),
    ["nodeId", serializeString(node.nodeId)],
    [
      "parentId",
      node.parentId === null ? "null" : serializeString(node.parentId),
    ],
    ["transform", serializeTransform(node.transform)],
    ...(node.metadata === undefined
      ? []
      : ([["metadata", serializeMetadata(node.metadata)]] as const)),
  ];
  return serializeMembers(entries);
}

function serializeMaterial(material: MaterialRecord): string {
  return serializeMembers([
    ["color", serializeString(material.color)],
    ["emissive", serializeNumber(material.emissive)],
    ["materialId", serializeNumber(material.materialId)],
    ["metallic", serializeNumber(material.metallic)],
    ["name", serializeString(material.name)],
    ["opacity", serializeNumber(material.opacity)],
    ["roughness", serializeNumber(material.roughness)],
  ]);
}

function serializeVolume(volume: VolumeDescriptor): string {
  const entries: readonly (readonly [string, string])[] = [
    ...(volume.bounds === undefined
      ? []
      : ([["bounds", serializeIntAabb(volume.bounds)]] as const)),
    ...(volume.name === undefined
      ? []
      : ([["name", serializeString(volume.name)]] as const)),
    ["volumeId", serializeString(volume.volumeId)],
  ];
  return serializeMembers(entries);
}

function serializeTrackProperty(property: TrackProperty): string {
  switch (property.channel) {
    case "translation":
      return serializeMembers([
        ["channel", '"translation"'],
        ["value", serializeVec3(property.value)],
      ]);
    case "rotation":
      return serializeMembers([
        ["channel", '"rotation"'],
        ["value", serializeQuat(property.value)],
      ]);
    case "scale":
      return serializeMembers([
        ["channel", '"scale"'],
        ["value", serializeVec3(property.value)],
      ]);
  }
}

function serializeKeyframe(keyframe: Keyframe): string {
  return serializeMembers([
    ["keyframeId", serializeString(keyframe.keyframeId)],
    ["property", serializeTrackProperty(keyframe.property)],
    ["time", serializeNumber(keyframe.time)],
  ]);
}

function serializeTrack(track: AnimationTrack): string {
  return serializeMembers([
    ["interpolation", serializeString(track.interpolation)],
    ["keyframes", `[${track.keyframes.map(serializeKeyframe).join(",")}]`],
    ["targetNodeId", serializeString(track.targetNodeId)],
    ["trackId", serializeString(track.trackId)],
  ]);
}

function serializeAnimation(animation: AnimationDescriptor): string {
  const entries: readonly (readonly [string, string])[] = [
    ["animationId", serializeString(animation.animationId)],
    ["duration", serializeNumber(animation.duration)],
    ["loop", serializeString(animation.loop)],
    ...(animation.name === undefined
      ? []
      : ([["name", serializeString(animation.name)]] as const)),
    ["tracks", `[${animation.tracks.map(serializeTrack).join(",")}]`],
  ];
  return serializeMembers(entries);
}

/**
 * Serializes an ID-keyed record. Record keys are stable ordered per plan
 * section 5.1: string IDs by Unicode code unit, material IDs numerically.
 */
function serializeRecord<T>(
  record: Readonly<Record<string, T>>,
  serialize: (value: T) => string,
  compare: (a: string, b: string) => number,
): string {
  const entries = Object.entries(record).sort(([a], [b]) => compare(a, b));
  return `{${entries.map(([key, value]) => `${serializeString(key)}:${serialize(value)}`).join(",")}}`;
}

/**
 * Canonical UTF-8 document JSON (ADR-0001 / ADR-0004). Object members sort
 * by Unicode code unit (RFC 8785); arrays preserve schema order; record keys
 * follow plan section 5.1 (ID records by code unit, materials numerically);
 * absent optional fields are omitted. Unknown fields and non-finite or
 * negative-zero numbers are rejected.
 */
export function canonicalDocumentJson(document: VoxelDocument): string {
  return serializeMembers([
    [
      "animations",
      serializeRecord(document.animations, serializeAnimation, compareCodeUnit),
    ],
    ["documentId", serializeString(document.documentId)],
    ["documentSchemaVersion", serializeNumber(document.documentSchemaVersion)],
    [
      "materials",
      serializeRecord(document.materials, serializeMaterial, compareNumeric),
    ],
    ["metadata", serializeMetadata(document.metadata)],
    ["nodes", serializeRecord(document.nodes, serializeNode, compareCodeUnit)],
    ["revision", serializeNumber(document.revision)],
    ["rootNodeId", serializeString(document.rootNodeId)],
    [
      "volumes",
      serializeRecord(document.volumes, serializeVolume, compareCodeUnit),
    ],
  ]);
}

/**
 * ADR-0004 canonical semantic bytes: an ASCII version tag, the unsigned
 * 64-bit little-endian length of the canonical document JSON, and the
 * document bytes. Voxel chunk streams join this framing when voxel storage
 * lands (stage 3) and are excluded from semantic identity until then.
 */
export function canonicalSemanticBytes(document: VoxelDocument): Uint8Array {
  const documentBytes = encoder.encode(canonicalDocumentJson(document));
  const prefix = encoder.encode("vxl-semantic-v1\n");
  const out = new Uint8Array(prefix.length + 8 + documentBytes.byteLength);
  out.set(prefix, 0);
  new DataView(out.buffer, prefix.length, 8).setBigUint64(
    0,
    BigInt(documentBytes.byteLength),
    true,
  );
  out.set(documentBytes, prefix.length + 8);
  return out;
}

/** SHA-256 over `canonicalSemanticBytes`; the semantic identity of a document. */
export function canonicalDocumentHash(document: VoxelDocument): string {
  return sha256Hex(canonicalSemanticBytes(document));
}
