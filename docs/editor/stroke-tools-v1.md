# Stroke tool semantics (v1)

**Plan:** S7.3 / S7.5 — Editor tool interface; pencil and erase tools.
**Ticket:** #17 — Draw and erase with undoable desktop gestures.
**Status:** accepted (implementation baseline).

## Contract

The `@voxel-maker/editor` package defines the tool contract and the two
stroke tools. A tool receives pointer input, reads immutable semantic
state, maintains a transient runtime preview, and constructs registered
commands on commit (ARCHITECTURE.md "Editor interaction"). It never
mutates semantic state itself.

- `ToolHost` — services injected by the desktop composition root:
  the authoritative `DocumentStoreRead` of the open document, the
  deterministic voxel picker (S6.12), a fresh command-id source, an
  atomic labeled commit through the session's `CommandBus`, and the
  per-gesture voxel budget (ADR-0009 `MAX_VOXELS_PER_OPERATION`).
- `StrokeTool` — `pointerDown` / `pointerMove` / `pointerUp` /
  `pointerCancel` / `reset` over viewport-relative pointer coordinates,
  plus a `draft` preview and an `active` flag.
- `createStrokeTool({ kind: "pencil" | "erase", host, editor })` — the
  headless implementation shared by the desktop viewport controller.

The desktop viewport controller owns one tool instance per tool id and
routes primary-button gestures to the tool matching
`EditorStore.activeTool` ("select" keeps the #16 orbit/pan/click-select
behavior; ticket #18 adds paint, eyedropper, and the shape tools — see
docs/editor/selection-and-shape-tools-v1.md).

## Gesture lifecycle

1. **Pointer down.** The tool validates the gesture start, picks the
   nearest voxel, pins its volume for the whole stroke, and stores the
   first voxel in the runtime `EditorStore` draft. The pencil also pins
   the active material at this moment; the erase tool pins none. A pick
   miss starts nothing.
2. **Pointer moves.** Each move picks again. Picks over other volumes are
   ignored (a stroke only paints the volume it started on). A hit
   different from the last voxel rasterizes the straight segment between
   them (`segmentCoordinates` in `@voxel-maker/voxel`), deduplicates, and
   extends the draft. Fast movement can never leave gaps: every
   consecutive pair of rasterized voxels is 26-connected and both
   endpoints are exact, including under negative coordinates.
3. **Pointer up.** The tool builds exactly one registered command —
   `voxel.setBatch` for pencil, `voxel.removeBatch` for erase — and
   commits it as one transaction labeled "Draw stroke" / "Erase stroke".
   One stroke is therefore one undoable history entry. The draft is
   cleared before the commit so a rejected commit leaves no preview.
4. **Pointer cancel / lost pointer.** The draft is discarded and nothing
   is committed; semantic state is exactly the pre-gesture state. A late
   `pointerUp` after a cancel is a no-op.
5. **Lifecycle replacement.** Opening, replacing, or closing a document
   resets both tools, so a stroke can never straddle two documents.

## Preview policy

The draft lives only in the runtime `EditorStore` (never persisted, never
authoritative). The desktop composition projects it as a
semi-transparent instanced box mesh under the owning node's group in
volume-local coordinates (`apps/desktop/src/viewport/draft.ts`); the
pencil preview uses the pinned material's color and the erase preview a
fixed red. The mesh is removed on commit, cancel, and lifecycle
replacement.

## Failure policy

Every failure is atomic: no partial commit and no surviving preview.

| Failure | Result |
| --- | --- |
| No document open | `SESSION_NOT_OPEN`; no draft starts. |
| Pencil without an active material | `NO_ACTIVE_MATERIAL`; no draft starts. |
| Active material not in the document | `MISSING_MATERIAL`; no draft starts. |
| Material deleted mid-stroke | the commit is rejected by command validation (`MISSING_MATERIAL`); the stroke commits nothing. |
| Stroke exceeds the voxel budget | `TOO_MANY_VOXELS`; the gesture is cancelled atomically. |
| Volume deleted mid-stroke | `MISSING_VOLUME` from command validation; nothing commits. |

The composition root prunes a deleted active material on commit
(`EditorStore.activeMaterial` becomes undefined plus a warning notice) and
defaults the active material to the document's lowest material id when a
document opens, so the pencil works without a materials panel (ticket
#21).

## Limits

- Strokes are bounded by `MAX_VOXELS_PER_OPERATION` (1,000,000), the same
  ADR-0009 budget the batch command parsers enforce, so a legal stroke is
  always a legal transaction. The desktop composition accepts a lowered
  per-gesture budget (`CompositionOptions.gestureVoxelLimit`, ADR-0009
  "callers may lower") — used by tests to exercise the limit seam through
  the real pick/commit path.
- Rasterization uses exact integer arithmetic; intermediate products are
  far below 2^53, so results are identical on every platform.

## Non-goals (v1)

- Strokes follow volume-local straight segments between picks; under a
  rotated or scaled node the world-space path is therefore approximated.
- No cursor hover preview, no stroke thickness/brush size, no symmetry,
  and no painting across multiple volumes in one stroke.
- Keyboard shortcuts for tools land with ticket #43.
