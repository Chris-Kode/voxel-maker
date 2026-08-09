# Materials panel semantics (v1)

**Plan:** S7.13 — Build materials panel.
**Ticket:** #21 — Manage document materials visually.
**Status:** accepted (implementation baseline).

## Contract

The `@voxel-maker/editor` package defines the headless panel model, and
`apps/desktop` defines the panel controller and view:

- `countMaterialUsage(store)` — zero-filled voxel usage counts for every
  document material, scanned only over allocated chunks.
- `defaultNewMaterialPayload(id)` — bounded `material.create` defaults
  (name `Material <id>`, canonical `#808080`, fully opaque, mid
  roughness, non-metallic, non-emissive).
- `materialUpdateChanges(record, changes)` — the `material.update`
  payload for exactly the fields that differ; `undefined` when nothing
  changed (an all-unchanged blur commits nothing).
- `MaterialPanelController` (`apps/desktop/src/materials/`,
  composed at the desktop composition root) — subscribes to the session
  lifecycle, the authoritative store, and the editor store; compiles
  every panel action into the registered `material.*` commands and
  commits through the session bus as one labeled, atomic, undoable
  transaction. The controller never mutates semantic state and holds no
  UI state; the React `MaterialPanel` renders the frozen snapshot and
  forwards gestures. Reassignment choices for a referenced delete are
  computed on demand (`replacementCandidates(materialId)`, ascending
  ids) when the delete flow arms, so the panel snapshot stays linear in
  the material count even at the 4,096-material document limit.

### Material id allocation

Ids are exact unsigned 16-bit values and "are not reused while reachable
history or recovery records can mention them" (ARCHITECTURE.md
"Materials"). The panel allocator is therefore a per-session monotonic
watermark: every fresh document install resets it to the live table's
highest id, and `material.create` always uses the next strictly higher
id. A deleted id is never handed out again while the delete (or any
transaction mentioning it) can still be reached through undo/redo or
recovery replay, so an id always denotes the same record for the life of
the session. The watermark advances only on a successful commit, and
creation fails with `LIMIT_EXCEEDED` at the 65,535 id bound (the
document's 4,096-material bound is checked first).

## Panel actions

| Action | Command | Notes |
| --- | --- | --- |
| Add material | `material.create` | Next free id, bounded defaults; the new material becomes the active paint material. Rejected at the document material limit (`LIMIT_EXCEEDED`). |
| Edit name / color / opacity / roughness / metallic / emissive | `material.update` | Only changed fields are sent; colors are canonicalized (lowercase `#rrggbb`). One user edit (blur, picker close, or slider release) is one history entry. |
| Paint with a material | — | Runtime only: sets `EditorStore.activeMaterial`, used by the pencil, paint, and shape tools. |
| Delete unused material | `material.delete` | No replacement needed when no voxel references it. |
| Delete referenced material | `material.delete` + `replacement` | The panel requires an explicit reassignment choice; the bus rejects an absent or invalid replacement (`REFERENCED_MATERIAL` / `INVALID_REPLACEMENT`) so a dangling voxel reference can never commit. With a replacement, every referencing voxel remaps and the record is removed in one atomic transaction. |
| Undo / Redo | `bus.undo` / `bus.redo` | One transaction per panel edit; `canUndo`/`canRedo` drive the shell toolbar buttons (the v1 history surface). |

Failed actions never mutate semantic state: the command is rejected
atomically and the error surfaces as a runtime notice
(`EditorStore.notices`). The committed values are restored on the next
store refresh.

## Usage counts

`countMaterialUsage` reads only allocated chunks (`chunkCoordinates` /
`getChunk`) so the scan is bounded by the volume resource limits and
never allocates from empty space. Every document material appears in the
result (zero-filled), and the counts update live on every committed
document event — including edits made by tools or the AI path — because
the controller subscribes to the authoritative store.

## Undo, redo, save, and reload

Material semantics and voxel assignments survive every supported
workflow, verified end-to-end at the composition seam:

- **Undo/redo:** a referenced deletion with reassignment undoes as one
  unit (record recreated, remapped voxels restored) and redoes as one
  unit; a create undoes to absence and redoes to the exact record.
- **Save/reload:** the project bytes carry the material table and the
  voxel values; reloading through the file service yields identical
  records and usage counts.

## Limits

- Materials are bounded by the document limit (4,096, ADR-0009); the
  panel disables Add at the limit and the bus rejects the command.
- Names are bounded by `maxNameBytes`; out-of-range or non-finite
  scalar values are rejected by `material.update` validation
  (`INVALID_NAME` / `INVALID_MATERIAL_RANGE`) with no commit.
- The panel is inert without an open document; every action fails with
  `SESSION_NOT_OPEN` rather than touching stale state.

## Non-goals (v1)

- No color space beyond canonical `#rrggbb`, no texture or image
  materials, and no per-face material painting.
- No bulk material operations (merge, renumber, palette import); the
  reassignment picker handles one referenced delete at a time.
- The full command-history UI of plan S7.14 (labels, shortcuts, dirty
  and save indicator, error-notification surface) is a separate task;
  this ticket ships only the Undo/Redo buttons the acceptance criteria
  require. Panel validation errors surface through the runtime notice
  store that the history-UI task renders.
