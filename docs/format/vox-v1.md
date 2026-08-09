# MagicaVoxel `.vox` interchange subset (version 150)

This document freezes the MagicaVoxel interchange contract (plan S8.1,
ADR-0011, ticket #24): the supported VOX version, chunks, palette,
dimensions, axes, transforms, hierarchy, and the unsupported-feature policy
for import and export. `.vox` is interchange, not the canonical backup
format; the native format is `.vxl` (`vxl-v1.md`).

## Scope and guarantees

Import and export target MagicaVoxel VOX version **150** only. The initial
subset reads `MAIN`, optional `PACK`, paired `SIZE`/`XYZI`, and optional
`RGBA`; missing `RGBA` uses the version-150 default palette (embedded in
`@voxel-maker/formats` from the official format reference). Palette index
zero is empty. Scene-graph, layer, material, camera, note, and other
extension chunks are reported but not interpreted.

The codec is deterministic on both sides: parsing never depends on object
insertion order or runtime state, and the writer emits stable bytes for
stable content (models in document order, voxels sorted, explicit `RGBA`).
Every conversion and every loss is explicit — nothing is dropped silently.

## File layout

```text
"VOX " + version(150, i32le)
MAIN (root; content must be empty; children span the whole file)
├── PACK (optional; i32le model count; required only for multi-model files)
├── SIZE  + XYZI     # model 1
├── SIZE  + XYZI     # model 2 (PACK >= 2)
├── ...              # further models
└── RGBA  (optional; 1024 bytes; 256 entries)
```

- Every chunk is `id(4 ASCII) + contentSize(i32le) + childrenSize(i32le) +
  content + children`. A chunk's declared sizes must fit exactly inside its
  parent region; the file must end exactly at the end of `MAIN`.
- `SIZE` carries `sizeX, sizeY, sizeZ` (i32le). Supported dimensions are
  **1..256 per axis**; `size z` is the gravity direction in MagicaVoxel.
- `XYZI` carries `numVoxels` (i32le) followed by `numVoxels` entries of
  `(x, y, z, colorIndex)` bytes. Coordinates must be `< size` on every
  axis; **duplicate coordinates are rejected**; `colorIndex` 0 (empty)
  voxels are skipped and reported.
- `RGBA` carries 256 `(R, G, B, A)` bytes. Official layout: bytes
  `[0..1020)` are palette indices 1..255; the last quadruple
  (`[1020..1024)`) is palette index 0. Absent `RGBA` uses the frozen
  version-150 default palette.

## Axes

The file basis is right-handed with VOX `+y` up. The editor basis is
right-handed with `+Y` up and `+Z` forward (ARCHITECTURE.md). Import maps

```text
(X, Y, Z) = (vox x, vox z, -vox y)
```

and export applies the inverse `(vox x, vox y, vox z) = (X, -Z, Y)`.
Integer coordinates remain exact. Golden files authored in MagicaVoxel
must verify the orientation before the codec is promoted to a wider
release (ADR-0011).

## Palette and materials

- Palette index 0 is empty; voxels referencing it are never imported.
- Used palette entries (indices 1..255) become Materials. Import maps
  `(R, G, B)` to the canonical `#rrggbb` color and alpha to opacity
  (`a / 255`); roughness, metallic, and emissive are 0.
- Import reuses an existing document material with the identical color
  **and** opacity (reuse on color alone would silently discard the palette
  alpha), prefers the palette index as the material id when free, and
  otherwise remaps to the lowest free id; conflicts never fail the import
  silently.
- Export requires at most 255 non-empty colors. Opacity maps to palette
  alpha with 8-bit rounding (reported); roughness/metallic/emissive values
  are reported as dropped; materials that quantize to the same palette
  entry are reported as a distinction loss.

## Hierarchy and transforms

- Import creates one root-level Node per model at identity transform with
  a single voxel component; node names are deterministic `Model N` labels
  (the subset carries no names). Scene-graph chunks (`nTRN`, `nGRP`,
  `nSHP`, `LAYR`, `MATL`, `MATT`, `rOBJ`, `rCAM`, `NOTE`, `IMAP`) are
  reported and not interpreted.
- Export supports identity-transformed Voxel Volumes only. Nested volumes
  require the explicit `flattenHierarchy` choice (reported as a hierarchy
  loss) or block; any non-identity transform blocks with a loss report.
  Children of voxel nodes and node names are reported as losses.

## Dimensions and origin

- Import keeps the declared model cube's occupied voxels only: when the
  declared `SIZE` exceeds the occupied bounds, the empty space is reported
  as a `VOX_MODEL_CUBE_TRIMMED` warning because it is not preserved on
  re-export (the exported `SIZE` is the occupied extent).
- Export requires each volume's occupied bounds to fit 256 voxels per
  axis (the VOX unsigned cube); larger volumes block with a loss report.
- Because the axis mapping flips `Z`, a volume's VOX-space origin is
  `(minX, -maxZ, minY)`. Any negative VOX-space minimum requires the
  explicit `rebaseOrigins` choice (each model shifts to its local origin;
  absolute coordinates are lost and reported) or blocks. Empty volumes are
  omitted and reported.

## Import and export pipeline

- **Import** (`@voxel-maker/interchange`): parse (bounded, defensive) ->
  map -> one atomic `source: "import"` transaction on the open document's
  command bus. Malformed input, stale revisions, and resource-limit
  violations reject the import atomically with stable errors; cancellation
  is honored before parse and before commit. The whole import is undoable
  as one history entry. Payloads are split across `volume.create` commands
  so a single transaction can carry up to the transaction-envelope bound
  (~890k voxels with the compact entry encoding).
- **Export** (`@voxel-maker/interchange`): preflight (loss report or
  block) -> deterministic encode -> scoped atomic write through the
  storage port with progress and cancellation. Export never mutates the
  document.

## Unsupported-feature policy

Anything outside the subset is either reported as a warning/loss, resolved
through an explicit documented choice, or blocks the operation with a
structured report — never silently dropped:

| Feature | Import | Export |
|---|---|---|
| `PACK` multi-model | supported | written when needed |
| `SIZE`/`XYZI` | supported | written |
| `RGBA` / default palette | supported | written explicitly |
| Scene-graph/layer/material/camera/note chunks | reported, skipped | n/a |
| Unknown chunks | skipped when structurally valid, reported | n/a |
| Hierarchy | flattened to root nodes (reported) | `flattenHierarchy` choice or block |
| Transforms | identity only | block (no bake) |
| Dimensions > 256 | rejected | block (no bake) |
| Negative origin | n/a (import maps into signed editor space) | `rebaseOrigins` choice or block |
| > 255 colors | n/a | block (no bake) |
| Opacity | alpha -> opacity | opacity -> alpha (reported) |
| Roughness/metallic/emissive | default 0 | dropped (reported) |
| Node/material names | synthesized `Model N` | dropped (reported) |

## Limits

`parseVox` enforces ADR-0009-style hard limits (callers may only lower):
512 MiB input, 1,024 models, 1,000,000 voxels per model and per file,
100,000 chunks, and 64 MiB of skipped unknown-chunk bytes. The import
transaction additionally inherits the command-bus budgets
(`maxCommandPayloadBytes`, `maxTransactionEnvelopeBytes`, ...).

## Fixtures

`fixtures/vox/` (see its `README.md`) holds the golden and adversarial
corpus: byte-stable known files (cube, multi-model `PACK`, default
palette, empty model, unknown chunk) and malformed files that must reject
with exactly the recorded `family`/`code`. Regenerate with:

```sh
pnpm build
node scripts/generate-vox-fixtures.mjs
```
