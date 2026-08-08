# `material.*` commands

The `material.create`, `material.update`, and `material.delete` commands
evolve the document material table through the command bus — the same atomic
history path as voxel edits. Direct mutation of material records is not
available through public consumer interfaces.

## Command shapes

All commands share `schemaVersion: 1` and a branded `payload.materialId`
(integer 1–65535).

| Command | Payload fields | Effect |
| --- | --- | --- |
| `material.create` | `materialId`, `name`, `color`, `opacity`, `roughness`, `metallic`, `emissive` | Adds a material record. |
| `material.update` | `materialId`, optional subset of the record fields | Merges the provided bounded properties; at least one field is required. |
| `material.delete` | `materialId`, optional `replacement` | Removes the record; a referenced material requires an explicit valid replacement. |

Use the canonicalizing constructors (`createMaterialCommand`,
`updateMaterialCommand`, `deleteMaterialCommand`); they validate and
normalize the payload at construction time.

## Validation

`parse` bounds every untrusted value before allocation:

- `INVALID_MATERIAL_ID` — identifier outside 1–65535.
- `INVALID_NAME` — name is not a string or exceeds `maxNameBytes`.
- `INVALID_COLOR` — color is not a canonical lowercase `#rrggbb` value.
- `INVALID_CANONICAL_NUMBER` / `INVALID_MATERIAL_RANGE` — opacity, roughness,
  metallic, and emissive must be finite numbers in `[0, 1]`.

`validate` checks the command against the committed (or staged) document:

- `DUPLICATE_MATERIAL_ID` — `material.create` with an existing identifier
  and a different record.
- `MISSING_MATERIAL` — `material.update` or `material.delete` target, or a
  `material.delete` replacement, is not in the document.
- `EMPTY_MATERIAL_UPDATE` — `material.update` with no properties.
- `INVALID_REPLACEMENT` — the replacement equals the deleted material.
- `REFERENCED_MATERIAL` — `material.delete` without a replacement while any
  voxel in any volume references the material. The reference scan is bounded
  by the per-operation voxel limit (ADR-0009).
- `LIMIT_EXCEEDED` — `material.create` beyond `maxMaterials`.

## Referenced deletion and replacement

Deleting a material that voxels reference is rejected unless the command
supplies an explicit valid replacement. With a replacement, the command
remaps every referencing voxel to the replacement (across all volumes) and
then removes the record, all in one atomic transaction. The event reports
the changed volumes, the nodes referencing them, and both material ids.

## Transaction and revision behavior

Every `bus.execute` / `bus.executeTransaction` / `bus.undo` / `bus.redo` call
commits exactly one transaction: the document revision increments by exactly
one and exactly one deeply frozen `DocumentCommitted` event is emitted.
`expectedRevision` must match, transactions are atomic, and history is
bounded by `CommandLimits`. Later commands in one transaction see earlier
staged record effects (plan 4.4).

## Undo and redo

- Undo of `material.create` deletes the material; undo of `material.delete`
  recreates the exact record. A referenced deletion with replacement undoes
  as one unit: the record is recreated and every remapped voxel is restored
  to the original material.
- Undo of `material.update` restores the previous values of exactly the
  fields that changed.
- A new commit clears the redo history; `NOTHING_TO_UNDO` /
  `NOTHING_TO_REDO` are returned at the ends of history.

## No-op semantics

Creating a material that already exists with an identical record, or deleting
a material that is already absent, commits a no-op transaction: the revision
still increments and an event is emitted, but `changedMaterialIds` is empty.
This keeps history uniform so undo/redo behavior is predictable.
