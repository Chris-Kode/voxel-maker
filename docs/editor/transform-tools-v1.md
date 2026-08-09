# Transform tool semantics (v1)

**Plan:** S7.19 — Add later geometry tools: selection transforms.
**Ticket:** #19 — Transform selected voxel regions.
**Status:** accepted (implementation baseline).

## Contract

The `@voxel-maker/editor` package implements the transform tool headlessly
(`createTransformTool`). It lets users **copy, delete, move, rotate, and
mirror the selected geometry** through the existing region commands
(`voxel.copyRegion`, `voxel.deleteRegion`, `voxel.translateRegion`,
`voxel.rotateRegion`, `voxel.mirrorRegion`, docs/commands/voxel-regions.md)
as **one labeled, atomic, undoable transaction** per operation.

The desktop viewport controller owns the transform tool like every other
tool (one instance per tool id) and routes:

- **Move / copy** drag gestures through the shared pointer lifecycle
  (down pins, moves preview, up commits, cancel/lost pointer restores the
  exact pre-gesture state).
- **Rotate / mirror / delete** button presses through
  `transformPreviewRotate(axis)` / `transformPreviewMirror(axis)` /
  `transformPreviewDelete()` and the apply/cancel actions
  `transformApply()` / `transformCancel()`.

All tool state is runtime-only `EditorStore` state (`transformMode`,
`transformPreview`): it never enters the document, history, journal, or
saved bytes (verified by a desktop serialization test).

## Selection regions

A transform operates on the per-volume regions of the runtime selection,
expanded by `selectionRegions`:

| Selection entry | Region contributed |
| --- | --- |
| Node | The occupied-voxel bounds of each of the node's voxel volumes (empty volumes skipped) |
| Voxel | The unit region `[voxel, voxel + 1)` |
| Region | The region itself |

Equal volume/region pairs deduplicate and selection order is preserved.
Regions are volume-local and half-open `[min, max)`, so negative
coordinates work exactly like positive ones. Transform operations never
touch node transforms — they rearrange voxel content (node/hierarchy
transforms land with ticket #20).

## Operations

### Move and copy (drag gestures)

The transform mode (toolbar: Move / Copy) pins the operation at pointer
down. Pointer down also pins the selection regions and the anchor voxel;
every move updates the delta (`current - anchor`, integer) and the
preview; pointer up commits one transaction with one
`voxel.translateRegion` / `voxel.copyRegion` command per region.

- A zero delta or an empty selection commits nothing.
- The source is snapshotted before destination writes, so an overlapping
  drag moves/copies from the pre-operation state (the moved content wins
  over the cleared source; the copy does not see its own writes).
- Destination collisions overwrite explicitly (`overwrite` is the v1
  collision mode).

### Rotate, mirror, and delete (preview-and-apply)

These modes are button-driven and two-phase: the button press computes the
exact preview and stores it as the pending `transformPreview`; the
toolbar then shows the preview summary plus **Apply** and **Cancel**.
Apply commits one transaction with one `voxel.rotateRegion` /
`voxel.mirrorRegion` / `voxel.deleteRegion` command per region; Cancel
(and Escape) discard the preview with zero document, revision, history,
autosave, or renderer side effect.

- **Rotate** cycles the exact 90-degree increments around the chosen axis
  (X / Y / Z): the first click previews 90°, the second 180°, the third
  270°, the fourth wraps back to 90°. A different axis restarts at 90°.
  Regions whose rotation-plane extents have different parities cannot
  rotate exactly by 90°/270° (resampling is deferred in v1); the tool
  then previews the always-exact 180° step instead, so a rotation stays
  available for every region.
- **Mirror** previews the mirror across the plane through the region
  center perpendicular to the chosen axis. The destination is the source
  region itself; mirroring twice is the identity.
- **Delete** previews the number of voxels that will be removed.

An operation whose selection contains no occupied voxels is a silent
no-op: no preview and no commit (a no-op history entry is never
created).

## Preview and collision semantics

`EditorStore.transformPreview` is the exact, authoritative-store-derived
preview published before every commit (live during move/copy drags,
pending-apply for rotate/mirror/delete):

- `entries` — one `{ volumeId, source, destination }` per region with the
  exact half-open affected bounds after the operation (the translated
  AABB for move/copy, the rotated AABB for rotate, the source region
  itself for mirror/delete).
- `movedVoxels` — the occupied source content the operation affects.
- `overwrittenVoxels` — the occupied destination voxels the operation
  replaces: mapped positions that are occupied before the operation and
  are not part of the operation's own source content (0 for mirror and
  delete; the v1 `overwrite` collision behavior).
- `removedVoxels` — the occupied source content that is cleared and not
  re-occupied.

Counts are per-volume unions of the occupied key sets, so they stay exact
even when several selection entries share a volume. The viewport overlay
projects each entry's destination bounds as a magenta wireframe box
(rebuild-on-change or on any store commit, disposed on cancel/apply/
lifecycle replacement).

## Same-volume command ordering

A commit issues one sequential region command per selection entry, and
the preview is the union of the per-entry results. Sequential region
commands snapshot their source at execution time, so an earlier
command's footprint (its source plus destination; destination only for
copies, which never clear) must never intersect a later command's
source. The tool orders same-volume entries topologically by that
interference rule (Kahn's algorithm) so the committed result always
equals the previewed union semantics. Entries whose interference graph
has a cycle (regions that mutually land on each other's sources, or
overlapping sources for in-place mirror) cannot be transformed exactly
by sequential commands and are rejected atomically with
`CONFLICTING_SELECTION_REGIONS`; delete never interferes (clears are
idempotent unions) and keeps the selection order.

## Preflight and failure policy

Every preview is bounded and preflighted against the authoritative store
before it is published; a failed preflight cancels the gesture or clears
the pending preview atomically:

| Failure | Result |
| --- | --- |
| No document open | `SESSION_NOT_OPEN`; no gesture/preview starts. |
| Selection empty or pointer misses | silent no-op; no gesture starts. |
| Destination outside the volume coordinate domain | `REGION_OUT_OF_BOUNDS`; the gesture cancels / the pending preview clears. |
| Total region volume exceeds the per-gesture voxel budget | `TOO_MANY_VOXELS`; atomic cancel. |
| Post-operation occupied count exceeds the volume limit | `TOO_MANY_OCCUPIED_VOXELS`; the exact net change (additions minus removals) is used, so moves and rotations that free voxels are not falsely rejected. |
| Same-volume entries mutually interfere | `CONFLICTING_SELECTION_REGIONS`; the gesture cancels / the pending preview clears. |
| Volume deleted mid-gesture | commit-time `MISSING_VOLUME` from command validation; nothing commits. |

The commit itself is atomic and the region commands revalidate every
limit; a rejected commit leaves the document, revision, history, and
autosave untouched.

## Limits

- Gestures are bounded by `ToolHost.maxGestureVoxels` (ADR-0009
  `MAX_VOXELS_PER_OPERATION` by default; the desktop composition may lower
  it), the same budget the region-command parsers enforce.
- Region iteration and key scans are chunk-wise through the immutable
  read view, so empty chunks and regions are cheap.
- All arithmetic is exact integer arithmetic on half-open regions;
  results are identical on every platform.

## Non-goals (v1)

- No gizmo drags, world-space transforms, node-transform editing, or
  pivot-relative operations (tickets #20, #43).
- No per-axis scaling, free-form deformation, or resampled 90°/270°
  rotations of parity-mismatched regions (deferred by plan S3.11;
  180° rotations are always exact).
- No symmetry painting, duplicate-on-axis, or multi-step transform
  stacks.
