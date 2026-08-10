# glTF 2.0 / GLB export contract (v1)

This document freezes the glTF interchange contract (plan S16.1-S16.4,
ADR-0011, tickets #41/#42): the exported subset, units, axes, hierarchy,
pivots, materials, animation mapping, naming, the unsupported-feature
policy, and the resource limits. glTF import is deferred.

## Scope and guarantees

Export writes glTF **2.0** as either a binary **GLB** container (`.glb`)
or self-contained **glTF JSON** (`.gltf`) whose buffer is embedded as a
base64 `data:` URI, so one scoped atomic write produces a complete file
(ADR-0011 scoped atomic write policy). Both variants embed the same scene
graph and the same binary buffer; only the container differs. By default
Clips map to glTF animations (ticket #42); pass `includeAnimations:
false` to export the static subset only (ticket #41 behavior).

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
label (`Node N`, `Mesh N`, `Material <id>`, `Clip N`). Collisions are
resolved by appending `-2`, `-3`, ... in canonical node-id / material-id
/ animation-id order. Stable document IDs are never used as glTF names.

## Animation mapping

Each Clip (`document.animations`, ADR-0006) maps to one glTF
`animation` in canonical animation-id order; animation names follow the
naming policy above. Each Track maps to one channel plus one sampler:

| Track | glTF channel target | Sampler |
|---|---|---|
| `translation` | chain head node (`translation`) | input = keyframe times |
| `rotation` | pivot helper / single node (`rotation`) | output = canonical quaternions (VEC4) |
| `scale` | pivot helper / single node (`scale`) | output = scale vectors (VEC3) |

A track targeting a pivoted node animates the same helper chain that
carries its static transform: translation moves the chain head, rotation
and scale are applied on the pivot helper, so the world transform stays
`T(t) x T(pivot) x R(t) x S(t) x T(-pivot)` while animated (ADR-0011).

Interpolation maps as follows:

- `step` and `linear` map directly to glTF `STEP` and `LINEAR` with the
  authored keyframes (times strictly increasing, values bit-for-bit in
  float32).
- `smoothstep` is deterministically baked to `LINEAR` samples using the
  frozen ease curve `u² × (3 - 2u)` (ADR-0006), with at most
  `maxSmoothstepSamplesPerSegment` interior samples per segment
  (default 16, callers may only lower). Authored boundary values are
  reproduced exactly.
- Every multi-keyframe sampler covers the whole Clip: the runtime holds
  the first value before the first keyframe and the last value after the
  last keyframe, so held boundary samples are emitted at `0` and
  `clip.duration` whenever the first/last authored keys do not already
  lie there (identical adjacent values keep the segments constant; input
  times stay strictly increasing without duplicates). This preserves the
  Clip's leading and trailing hold intervals for every interpolation
  mode.
- A track with a single keyframe is constant and is emitted as two
  `LINEAR` samples over `[0, clip.duration]`, because glTF samplers
  require at least two strictly increasing input times.
- A track with no keyframes carries no motion and is omitted; a Clip
  whose tracks all carry no keyframes produces no animation.

Rotation samples are the model's canonical shortest-path quaternions
(ADR-0001/ADR-0006), so consecutive samples always travel the shortest
arc and every sample is a unit quaternion. glTF cannot encode playback
looping; a `loop` Clip is exported as an animation whose playback policy
is reported as a loss so downstream tooling must enable looping itself.

## Unsupported-feature policy

Every unsupported feature is reported by the preflight loss report before
any bytes are written; nothing is dropped silently:

| Feature | Policy |
|---|---|
| Clips (`document.animations`) with `includeAnimations: false` | reported loss `GLTF_LOSS_CLIPS` |
| Clip loop policy `loop` | reported loss `GLTF_LOSS_CLIP_LOOP` (glTF cannot encode looping) |
| `smoothstep` tracks | reported loss `GLTF_LOSS_SMOOTHSTEP` (baked to linear samples) |
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
  the material table, maps Clips to animations, and builds export
  metadata (`metadata.clips` counts the exported animations).
- **Encode** (`encodeGlb` / `encodeGltfJson`): deterministic bytes; the
  `animations` JSON key is omitted when the scene graph has no
  animations, so static exports keep their exact historical bytes.
- **Write** (`@voxel-maker/interchange` `exportGltf`): scoped atomic
  write through the storage port with progress and cancellation.

## Fixtures

`fixtures/gltf/` (see its `README.md`) holds the byte-stable golden
corpus: a cube, a pivoted hierarchy, a lossy document, and an animated
pivoted arm (rotation/translation/scale channels, baked smoothstep,
loop clip, constraint), each with the retained document/volume JSON
needed to rebuild the exact bytes. The corpus test validates animation
playback data through an independent GLB reader. Regenerate with:

```sh
pnpm build
node scripts/generate-gltf-fixtures.mjs
```
