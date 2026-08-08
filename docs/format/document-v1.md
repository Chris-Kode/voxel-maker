# Version 1 canonical document format

This document freezes the v1 persisted generic asset model defined in the
`@voxel-maker/model` package (plan section 5.1, ADR-0001, ADR-0004). It is the
schema of `document.json` inside a native container and the input to the
semantic identity hash. Changes to this contract require a migration or an
explicit compatibility break approved by ADR.

## Scope

A v1 `VoxelDocument` contains ordered generic nodes with canonical transforms,
bounded inert metadata, material records, volume descriptors, generic
components, and animation descriptors. Bulk voxel chunk bytes are not part of
the document JSON; they serialize separately (stage 3) and join the semantic
bytes as length-framed chunk streams defined in ADR-0004.

All identifiers are caller-supplied opaque strings of at most 128 characters
(`NodeId`, `VolumeId`, `AnimationId`, `TrackId`, `KeyframeId`, `ComponentId`,
`DocumentId`) or exact unsigned 16-bit integers (`MaterialId`, 1..65535).
The core never generates identifiers.

## Canonical JSON

The document serializes as UTF-8 JSON without a BOM, following RFC 8785
member ordering and ECMAScript shortest round-trippable numbers. Field order
below is the canonical order:

```jsonc
{
  "documentId": "document:example:0001",
  "documentSchemaVersion": 1,
  "revision": 0,
  "metadata": {},
  "rootNodeId": "node:example:root",
  "nodes": {
    "node:example:root": {
      "nodeId": "node:example:root",
      "name": "Root",                 // optional
      "parentId": null,               // null only on the root
      "children": ["node:example:a"], // ordered, unique, no self
      "transform": {
        "translation": [0, 0, 0],
        "pivot": [0, 0, 0],
        "rotation": [0, 0, 0, 1],     // normalized, sign-canonical
        "scale": [1, 1, 1]            // strictly positive
      },
      "components": [
        { "kind": "voxel", "schemaVersion": 1, "volumeId": "volume:example:0001" }
      ],
      "metadata": {}                  // optional
    }
  },
  "materials": {
    "1": {
      "materialId": 1,
      "name": "wall",
      "color": "#c8b89a",             // lowercase #rrggbb
      "opacity": 1,                   // [0, 1]
      "roughness": 0.8,               // [0, 1]
      "metallic": 0,                  // [0, 1]
      "emissive": 0                   // [0, 1]
    }
  },
  "volumes": {
    "volume:example:0001": {
      "volumeId": "volume:example:0001",
      "name": "Walls",                // optional
      "bounds": { "min": [-4, 0, -4], "max": [4, 8, 4] } // optional half-open AABB
    }
  },
  "animations": {
    "animation:example:spin": {
      "animationId": "animation:example:spin",
      "name": "Spin",                 // optional
      "duration": 1,                  // (0, 86400]
      "loop": "loop",                 // "once" | "loop"
      "tracks": [
        {
          "trackId": "track:example:spin-0",
          "targetNodeId": "node:example:a",
          "interpolation": "linear",  // "step" | "linear" | "smoothstep"
          "keyframes": [
            {
              "keyframeId": "keyframe:example:spin-0-0",
              "time": 0,              // [0, duration], strictly increasing
              "property": {
                "channel": "rotation", // "translation" | "rotation" | "scale"
                "value": [0, 0, 0, 1]  // Vec3 or canonical Quat per channel
              }
            }
          ]
        }
      ]
    }
  }
}
```

### Ordering rules

- Every object's members sort by Unicode code unit (RFC 8785), including the
  document root, nodes, transforms, components, materials, volumes, clips,
  tracks, keyframes, and constraints.
- ID-keyed record keys follow plan section 5.1: `nodes`, `volumes`, and
  `animations` keys sort by Unicode code unit; `materials` keys sort
  numerically by material ID (the one deliberate deviation from strict RFC
  8785 member order, frozen by the plan).
- `children`, `components`, `constraints`, `tracks`, and `keyframes` arrays
  preserve their authored order (schema order is semantic).
- Absent optional fields are omitted; explicit `null` is preserved only where
  allowed (`parentId` on the root). Unknown fields, non-finite numbers, and
  serialized `-0` are rejected before canonicalization.
- Every record key must equal the embedded identifier of its value
  (`MISMATCHED_RECORD_ID` otherwise) for nodes, materials, volumes, and
  animations.

### Transform and value canonicalization (ADR-0001)

- Numbers are finite; `-0` is normalized to `0` at construction and rejected
  when parsed.
- Rotation quaternions are normalized (`|norm - 1| <= 1e-9`) and
  sign-canonicalized: `w > 0`, and when `w == 0` the first non-zero component
  among `x, y, z` is positive.
- Scale is strictly positive on node transforms and scale keyframes.
- Colors are lowercase `#rrggbb` (six digits; opacity is a separate field).
- Material `name` is required; node, volume, and clip names are optional.
  All names are bounded to 256 UTF-8 bytes.

### Components

The component union is closed and each member carries `schemaVersion: 1`:

| kind | cardinality | fields |
|---|---|---|
| `voxel` | at most one per node | `volumeId` (must exist in `volumes`) |
| `pivot` | at most one per node | `pivot: Vec3` |
| `joint` | at most one per node | none (annotation; stage 9 semantics) |
| `constraint` | at most one per node | `constraints[]` with unique document-wide `componentId`, `type: "rotation-limits"`, `limits.min/max` radians with `min <= max` per axis |

Unknown component kinds or component schema versions are rejected.

### Animation descriptors

- Clip `duration` is in seconds, `0 < duration <= 86400`; `loop` is `once` or
  `loop`.
- Tracks target existing nodes; `trackId`s and `keyframeId`s are unique
  document-wide; keyframe `time` is in `[0, duration]` and strictly increasing.
- Keyframe values must match their channel: `Vec3` for `translation` and
  `scale` (scale strictly positive), canonical `Quat` for `rotation`.

### Metadata

Document-level and node-level metadata are JSON objects bounded by
ADR-0009: depth 16, 10,000 members total, 1 MiB canonical JSON total, 64 KiB
per string/key. Metadata is inert: it never changes engine behavior.

### Limits

Counts are per document (ADR-0009): 10,000 nodes; 1,024 volumes; 4,096
materials; 256 clips; 10,000 tracks; 1,000,000 keyframes (100,000 per track);
volume bound coordinates within `+-1,048,575`; revision a non-negative
integer at most `Number.MAX_SAFE_INTEGER`. Tests may lower limits; hard
defaults may only be raised by a reviewed policy change.

## Semantic identity (ADR-0004)

`canonicalDocumentHash` is SHA-256 (pure JS, FIPS 180-4) over the document
part of `canonicalSemanticBytes`:

```text
ASCII  "vxl-semantic-v1\n"
u64le  length of canonical document JSON bytes
bytes  canonical document JSON
```

The full asset identity (`canonicalAssetSemanticHash` in `@voxel-maker/document`)
appends the length-framed sorted voxel chunk streams defined in
[`vxl-v1.md`](./vxl-v1.md) once volume read views are available. The hash
excludes timestamps, compression, previews, UI state, runtime revisions,
history, recovery data, and diagnostics. Reloading a valid document preserves
its hash; the returned document is deeply frozen and exposes no mutable
authoritative backing data.

## Versioning and migration

`documentSchemaVersion` is an independent version field (ADR-0004). A format
change that adds, removes, or reinterprets persisted fields bumps the version
and registers an ordered, pure, JSON-to-JSON migration for every supported
transition in the `@voxel-maker/model` migration registry
(`createMigrationChain`, plan S2.11). Migrations run one version at a time
(`vN -> vN+1`) and never skip; a file whose version is unknown, or newer than
the current release, fails with `UNSUPPORTED_DOCUMENT_VERSION`
(compatibility) and is never overwritten. The production registry is empty
while v1 is the only released version, and every future transition must
retain its own fixture before the chain may grow.

## Error codes

Validation failures carry a stable `code` and a JSON-ish `path`. Principal
codes: `INVALID_DOCUMENT_SCHEMA_VERSION`, `UNSUPPORTED_DOCUMENT_VERSION`
(compatibility, future versions), `INVALID_REVISION`, `INVALID_ID`,
`UNKNOWN_FIELD`, `INVALID_FIELD_TYPE`, `INVALID_CANONICAL_NUMBER`,
`INVALID_TRANSFORM`, `INVALID_SCALE`, `INVALID_QUATERNION`,
`NON_CANONICAL_QUATERNION`, `INVALID_COLOR`, `INVALID_MATERIAL_ID`,
`INVALID_MATERIAL_RANGE`, `INVALID_VECTOR`, `INVALID_INTEGER_VECTOR`,
`INVALID_AABB`, `INVALID_VOLUME_BOUNDS`, `UNSUPPORTED_COMPONENT`,
`UNSUPPORTED_COMPONENT_VERSION`, `DUPLICATE_COMPONENT`,
`DUPLICATE_COMPONENT_ID`, `INVALID_CONSTRAINT`, `INVALID_ROOT`,
`SELF_PARENT`, `DUPLICATE_CHILD`, `MISSING_REFERENCE`,
`RECIPROCAL_REFERENCE`, `CYCLIC_HIERARCHY`, `DISCONNECTED_NODE`,
`INVALID_NODE`, `INVALID_MATERIAL`, `INVALID_VOLUME`, `INVALID_ANIMATION`,
`INVALID_ANIMATION_DURATION`, `INVALID_LOOP_POLICY`, `INVALID_TRACK`,
`INVALID_INTERPOLATION`, `DUPLICATE_TRACK_ID`, `DUPLICATE_KEYFRAME_ID`,
`INVALID_KEYFRAME`, `INVALID_KEYFRAME_TIME`, `DUPLICATE_KEYFRAME_TIME`,
`UNSORTED_KEYFRAME_TIMES`, `INVALID_PROPERTY_CHANNEL`,
`INVALID_KEYFRAME_VALUE`, `INVALID_METADATA`, `MISMATCHED_RECORD_ID`,
`INVALID_JSON`, and `LIMIT_EXCEEDED` (family `limit`, naming the resource,
maximum, and requested amount).
