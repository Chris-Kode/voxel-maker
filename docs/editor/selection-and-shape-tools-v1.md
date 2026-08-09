# Selection and shape tool semantics (v1)

**Plan:** S7.1–S7.4, S7.6, S7.7, S7.19 — Editor state, selection, and
manual geometry tools.
**Ticket:** #18 — Select and create bounded voxel shapes.
**Status:** accepted (implementation baseline).

## Contract

The `@voxel-maker/editor` package defines the runtime selection model and
every headless tool. A tool receives pointer input, reads immutable
semantic state, maintains a transient runtime preview, and constructs
registered commands on commit (ARCHITECTURE.md "Editor interaction"). It
never mutates semantic state itself.

The desktop viewport controller owns one tool instance per tool id
(select, pencil, erase, paint, eyedropper, box, sphere, cylinder) and
routes primary-button gestures to the tool matching
`EditorStore.activeTool`. All tools share one `ToolHost` (the
authoritative `DocumentStoreRead`, the deterministic picker, a fresh
command-id source, an atomic labeled commit through the session's
`CommandBus`, and the ADR-0009 per-gesture voxel budget,
`maxGestureVoxels`).

## Selection (S7.1/S7.2/S7.4)

`EditorStore.selection` is a mixed, runtime-only list of immutable
`SelectionEntry` values:

- `{ kind: "node", nodeId }` — the whole node (its voxel volumes).
- `{ kind: "voxel", volumeId, voxel }` — one volume-local voxel.
- `{ kind: "region", volumeId, region }` — one half-open volume-local
  region.

Entries are canonical (equal entries share a key), deduplicated, and may
be mixed freely (multi-selection). Selection, the select-tool granularity
(`selectionMode`: node/voxel/region), the in-progress `regionDraft`, and
all tool state live only in `EditorStore`; they never enter the document,
history, journal, or saved bytes (verified by a desktop serialization
test that saves, reloads, and asserts the default runtime state).

### Intent

| Input | Result |
| --- | --- |
| Click | Replaces the selection with the picked entry. |
| Shift-click | Adds the picked entry (no duplicates). |
| Ctrl/Cmd-click | Toggles the picked entry's membership. |
| Click empty space | Plain click clears; Shift/Ctrl clicks leave it (all modes, including region mode). |
| Escape | Cancels any in-progress gesture, then clears the selection. |
| Region-mode drag | Rubber-bands the spanned region; release selects it with the same modifier intent. |

Node/voxel mode clicks resolve through the select tool's `click`; region
mode uses the full gesture lifecycle (down anchors the region, moves
preview it as a wireframe box, up commits the region entry, cancel
restores the exact pre-gesture state). A region drag never leaves the
volume it started on.

### Pruning

The controller subscribes to the authoritative store and, on every
committed document event, prunes entries whose node or volume no longer
exists (`pruneSelection`), then redraws the overlays. Deleted references
never survive a commit.

## Tools (S7.3/S7.6/S7.7/S7.19)

All gesture tools follow the same lifecycle: pointer down validates and
pins (volume and material), moves update the transient preview, pointer
up constructs exactly one registered command and commits it as one
labeled, atomic, undoable transaction, and cancel/lost pointer restores
the exact pre-gesture state. Lifecycle replacement resets every tool.

### Eyedropper (S7.6)

Read-only sample: a click copies the picked voxel's material into
`EditorStore.activeMaterial`. Empty voxels are a no-op; nothing is ever
committed and no gesture is captured. Because the sampled material is
referenced by a live voxel, it can never be a deleted material id.

### Paint (S7.6)

Like the pencil, but recolors only occupied path voxels whose material
differs from the pinned active material. The draft previews exactly the
change that will commit (it re-checks the live store at pointer-up), and
a paint stroke that changes nothing commits nothing.

### Box, sphere, cylinder (S7.7/S7.19)

The anchor voxel pins the volume; the current voxel derives the shape
deterministically:

- **Box** — the half-open region spanning both voxels inclusively.
- **Sphere** — integer center at the anchor, integer radius equal to the
  Chebyshev distance (largest axis delta) to the current voxel.
- **Cylinder** — axis-aligned along the dominant drag axis (largest
  absolute delta; ties resolve x, y, z; a point drag defaults to y). The
  base sits at the minimum drag coordinate along the axis with the
  anchor's other coordinates; height spans the drag; radius is the
  largest delta on the remaining axes.

Every parameter is clamped to the volume's coordinate domain and extent
limit (`VoxelVolumeLimits.maxCoordinate` / `maxExtent`, ADR-0009), so
the preview always equals the committed fill. Previews are voxelized
with the frozen `boxCoordinates` / `sphereCoordinates` /
`cylinderCoordinates` rules, bounded by the per-gesture budget
(`ToolHost.maxGestureVoxels`), and the occupied-voxel limit is
preflighted exactly (current occupancy plus the additions the shape
would make, read through the authoritative store): a shape that cannot
fit is rejected with `TOO_MANY_VOXELS` / `TOO_MANY_OCCUPIED_VOXELS`
before any commit and the gesture is cancelled atomically. Commit is one
`voxel.fillBox` / `voxel.fillSphere` / `voxel.fillCylinder` transaction
("Fill box" / "Fill sphere" / "Fill cylinder"). A zero-height cylinder
commits nothing.

## Failure policy

Every failure is atomic: no partial commit and no surviving preview.

| Failure | Result |
| --- | --- |
| No document open | `SESSION_NOT_OPEN`; no gesture starts. |
| No active material (paint/shape) | `NO_ACTIVE_MATERIAL`; no gesture starts. |
| Active material deleted mid-gesture | the commit is rejected (`MISSING_MATERIAL`); nothing commits. |
| Gesture exceeds the voxel budget | `TOO_MANY_VOXELS`; the gesture is cancelled atomically. |
| Fill would exceed the occupied-voxel limit | `TOO_MANY_OCCUPIED_VOXELS`; reported during the gesture, before any commit. |
| Volume deleted mid-gesture | `MISSING_VOLUME` from command validation; nothing commits. |

## Limits

- Gestures are bounded by `MAX_VOXELS_PER_OPERATION` (1,000,000), the
  same ADR-0009 budget the command parsers enforce; the desktop
  composition accepts a lowered per-gesture budget for tests.
- Shape derivation uses exact integer arithmetic and canonical half-open
  regions; results are identical on every platform.

## Non-goals (v1)

- No cursor hover preview, brush size, symmetry, or cross-volume
  gestures.
- Region selection is axis-aligned in volume space; world-space free
  lassos and selection transforms land with ticket #19.
- Keyboard shortcuts for tools land with ticket #43.
