# `voxel.set` and `voxel.remove` commands

Both commands mutate a single voxel in a document volume through the command
bus. They are the canonical way to edit voxel data: direct mutation of volume
state is not available through public consumer interfaces.

## Command shapes

| Field           | `voxel.set` | `voxel.remove` |
| --------------- | ----------- | -------------- |
| `type`          | `"voxel.set"` | `"voxel.remove"` |
| `schemaVersion` | `1`         | `1`            |
| `payload.volumeId` | branded `VolumeId` | branded `VolumeId` |
| `payload.coordinate` | `[x, y, z]` integers within `+-maxVoxelCoordinate` | same |
| `payload.material` | branded `MaterialId` (1–65535) | — |

Use the canonicalizing constructors `setVoxelCommand(id, payload)` and
`removeVoxelCommand(id, payload)`; they validate and normalize the payload at
construction time.

## Validation

`parse` bounds every untrusted value before allocation:

- `INVALID_VECTOR` — `coordinate` is not a 3-component array.
- `INVALID_VOXEL_COORDINATE` — a component is not an integer or exceeds
  `DocumentLimits.maxVoxelCoordinate` (path `["payload", "coordinate", axis]`).
- `INVALID_MATERIAL_ID` / `INVALID_ID` — malformed material or volume id.

`validate` checks the command against the committed document:

- `MISSING_VOLUME` — `payload.volumeId` is not in `document.volumes`.
- `MISSING_MATERIAL` — `voxel.set` references a material not in
  `document.materials`.

## Transaction and revision behavior

- Every `bus.execute` / `bus.executeTransaction` / `bus.undo` / `bus.redo`
  call commits exactly **one** transaction: the document revision increments
  by exactly one and exactly one deeply frozen `DocumentCommitted` event is
  emitted.
- `TransactionOptions.expectedRevision` must equal the current document
  revision; otherwise the transaction fails with `REVISION_CONFLICT` and
  nothing is committed.
- A transaction is atomic: if any command in a batch fails validation or
  execution, the whole batch is rejected and the document is unchanged.
- Reusing a `transactionId` with identical canonical command bytes replays
  the recorded result (`replayed: true`) without re-committing. Reusing it
  with different bytes fails with `DUPLICATE_TRANSACTION_ID`. The revision
  check runs first: a replay with a stale `expectedRevision` fails with
  `REVISION_CONFLICT` instead of replaying.
- A failing command in a batch reports the failing command's index in
  `error.context.commandIndex` (plan 5.4).
- History is bounded by `CommandLimits` (`maxHistoryEntries` 512,
  `maxHistoryInverseBytes` 256 MiB by default); the oldest entries are
  dropped first.

## Undo and redo

- `undo` replays the stored inverse commands of the most recent transaction
  in reverse order; `redo` replays the forward commands. Each undo/redo is
  itself a committed transaction and increments the revision by one.
- Undo of a `voxel.set` restores the previous material (or removes the voxel
  if it was empty before); undo of a `voxel.remove` restores the removed
  voxel. Empty chunks are reclaimed canonically, so undo/redo restore exact
  semantic state.
- A new commit clears the redo history (`canRedo()` becomes false).
- `NOTHING_TO_UNDO` / `NOTHING_TO_REDO` are returned at the ends of history.

## No-op semantics

Setting a voxel to its current material, or removing an empty voxel, commits
a no-op transaction: the revision still increments and an event is emitted,
but all `changed*` fields (`changedVolumes`, `changedNodeIds`,
`changedMaterialIds`, `changedAnimationIds`) are empty. This keeps history
uniform so undo/redo behavior is predictable.
