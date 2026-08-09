# Static glTF 2.0 / GLB export contract (v1)

This document freezes the static glTF interchange contract (plan S16.1,
ADR-0011, ticket #41): the exported subset, units, axes, hierarchy,
pivots, materials, naming, the unsupported-feature policy, and the
resource limits. glTF import is deferred; the animated exporter is a
separate ticket (#42) and this contract covers static export only.

## Scope and guarantees

Static export writes glTF **2.0** as either a binary **GLB** container
(`.glb`) or self-contained **glTF JSON** (`.gltf`) whose buffer is
embedded as a base64 `data:` URI, so one scoped atomic write produces a
complete file (ADR-0011 scoped atomic write policy). Both variants embed
the same scene graph and the same binary buffer; only the container
differs.

The exporter is deterministic: the same frozen document and volume read
views always produce the same bytes. The encoder fixes the JSON key
order, the accessor/buffer layout, chunk padding, and the generator
string (`asset.generator` = `"voxel-maker"`). Export never mutates the
document, never reads renderer state, and never depends on transient
renderer object identity: it consumes the frozen `VoxelDocument` and the
session `VoxelVolumeReadView`s only.

## Units and axes

- **Units:** one voxel edge maps to **one meter**; positions are written
  in meters (integer voxel coordinates).
- **Axes:** the editor and glTF bases are both right-handed `+Y` up with
  `+X` right; editor `+Z` forward is retained as positive glTF Z. No axis
  remapping happens.
- **Winding and normals:** voxel surfaces are face-culled indexed
  triangles with outward unit normals and counter-clockwise front faces
  in the shared right-handed basis, using the same face table and winding
  as the renderer mesher (plan S6.5), so export geometry matches the
  viewport.

## Hierarchy, transforms, and pivots

Every document Node maps to a glTF Node chain in canonical node-id
(code-unit) order — the same order as `canonicalDocumentJson` — so the
export bytes are identical whether the document was created in memory or
parsed from disk. The document root maps to the single scene root node. Node hierarchy and
ordered local translation, canonical quaternion rotation, and positive
scale map to glTF node TRS; default-valued fields are omitted.

A non-zero pivot is represented by a deterministic helper-node chain that
keeps the canonical transform

```text
T(translation) x T(pivot) x R(rotation) x S(scale) x T(-pivot)
```

exactly:

```text
head (translation)
└── pivot helper (translation = pivot, rotation, scale)
    └── pivot offset helper (translation = -pivot, mesh and children)
```

The helper nodes are named `<node name> pivot` and
`<node name> pivot offset`; their identity is reported in the export
metadata (`metadata.pivotHelpers`) so consumers and goldens can verify
the strategy. Nodes without a pivot use a single node with the full TRS.

## Voxel surfaces and meshes

Each distinct Voxel Volume becomes one glTF mesh (deduplicated when
several nodes reference the same volume). The mesh is a face-culled
indexed triangle mesh in volume-local coordinates (absolute editor
coordinates), grouped by Material: each mesh emits one primitive per
material group, sharing one POSITION and one NORMAL accessor and slicing
one index accessor per primitive. Hidden faces (same material on both
sides) are culled; faces between different materials are kept on both
sides. Empty volumes are omitted and reported.

## Materials

Used document Materials (ascending material-id order) map to glTF PBR
materials:

| Document | glTF |
|---|---|
| `color` (`#rrggbb`) + `opacity` | `pbrMetallicRoughness.baseColorFactor` `[r, g, b, a]` |
| `roughness` | `pbrMetallicRoughness.roughnessFactor` |
| `metallic` | `pbrMetallicRoughness.metallicFactor` |
| `emissive` (scalar) | `emissiveFactor` `[e, e, e]` |
| `opacity < 1` | `alphaMode: "BLEND"`, otherwise `"OPAQUE"` |

Unused document materials are not emitted.

## Naming

Names are sanitized by removing control characters (U+0000..U+001F,
U+007F) and trimming; an empty result falls back to a deterministic
label (`Node N`, `Mesh N`, `Material <id>`). Collisions are resolved by
appending `-2`, `-3`, ... in canonical node-id / material-id order. Stable document IDs are
never used as glTF names.

## Unsupported-feature policy

Every unsupported feature is reported by the preflight loss report before
any bytes are written; nothing is dropped silently:

| Feature | Policy |
|---|---|
| Clips (`document.animations`) | reported loss (static exporter omits them; animated export is #42) |
| Rotation-limit constraints | reported loss (per node) |
| Joint annotations | reported loss (per node) |
| Document/node metadata | reported loss |
| Empty volumes | reported loss, omitted |
| No voxel volumes in the document | **block** (`GLTF_LOSS_NO_VOLUMES`) |
| Volume missing from the store | **block** (`GLTF_LOSS_MISSING_VOLUME`) |
| Non-`.gltf`/`.glb` destination | validation error `GLTF_UNSUPPORTED_EXTENSION` |

A block returns a structured loss report and writes nothing.

## Limits

`DEFAULT_GLTF_EXPORT_LIMITS` (callers may only lower): 1,000,000 faces
per volume, 4,000,000 total faces, 256 MiB total output bytes. The
per-volume face cap is enforced by the mesher while it emits, the total
face cap by the plan, and the byte cap by the encoder; violations throw
structured `limit`-family errors (`GLTF_FACE_LIMIT`, `GLTF_FILE_TOO_LARGE`)
before any bytes are written.

## Export pipeline

- **Preflight** (`preflightGltfExport`): feature loss report or block.
- **Plan** (`planGltfExport`): meshes volumes, builds the node chains,
  the material table, and export metadata.
- **Encode** (`encodeGlb` / `encodeGltfJson`): deterministic bytes.
- **Write** (`@voxel-maker/interchange` `exportGltf`): scoped atomic
  write through the storage port with progress and cancellation.

## Fixtures

`fixtures/gltf/` (see its `README.md`) holds the byte-stable golden
corpus: a cube, a pivoted hierarchy, and a lossy document, each with the
retained document/volume JSON needed to rebuild the exact bytes.
Regenerate with:

```sh
pnpm build
node scripts/generate-gltf-fixtures.mjs
```
