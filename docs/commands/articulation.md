# `node.*` articulation component commands

The `node.setPivot`, `node.removePivot`, `node.addJoint`, and
`node.removeJoint` commands (plan S9.3, ticket #26) manage the singleton
pivot and joint components through the command bus. A joint annotates a
node in the single transform hierarchy; it never introduces a second
parent graph or skeleton structure. Pivot and joint are singletons per
node, so these commands are per-discriminant create/update/remove
operations instead of whole-list replacement (`node.setComponents`
remains the path for voxel and constraint components).

## Command shapes

All commands share `schemaVersion: 1` and a branded `payload.nodeId`.

| Command | Payload fields | Effect |
| --- | --- | --- |
| `node.setPivot` | `nodeId`, `pivot` | Creates the pivot component, or updates it when one already exists (canonical finite vector). |
| `node.removePivot` | `nodeId` | Removes the pivot component; a no-op commit when absent. |
| `node.addJoint` | `nodeId` | Adds the joint annotation; a no-op commit when present. |
| `node.removeJoint` | `nodeId` | Removes the joint annotation; a no-op commit when absent. |

Use the canonicalizing constructors (`setPivotCommand`,
`removePivotCommand`, `addJointCommand`, `removeJointCommand`); they
validate and normalize the payload at construction time. Register the
handlers with `registerArticulationCommands`.

## Validation

- `INVALID_VECTOR` / `INVALID_CANONICAL_NUMBER` — malformed pivot values
  (finite, never negative zero).
- `MISSING_NODE` — the target node does not exist.

## Undo and redo

Undo restores the exact pre-command component list: the recorded inverse
may be a different command type (for example, `node.setPivot` inverse is
`node.removePivot` when the pivot did not exist before, mirroring the
`node.create`/`node.delete` pattern). A new commit clears the redo
history; `NOTHING_TO_UNDO` / `NOTHING_TO_REDO` are returned at the ends
of history.

## No-op semantics

Removing an absent singleton or adding an existing one commits a no-op
transaction: the revision still increments and an event is emitted, but
`changedNodeIds` is empty, keeping history uniform.
