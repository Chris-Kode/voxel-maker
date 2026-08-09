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
| `node.setPivot` | `nodeId`, `pivot` | Creates the pivot component, or updates it when one already exists (canonical finite vector). Write-through: `transform.pivot` — the value the approved transform formula evaluates (ADR-0001) — is set to the same value, so the annotation and the geometry never disagree (plan S7.9). |
| `node.removePivot` | `nodeId` | Removes the pivot annotation; a no-op commit when absent. `transform.pivot` is left untouched: the node keeps its geometric pivot and only loses the articulation declaration. |
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

Undo restores the exact pre-command state: the recorded inverse may be a
different command type or a composite (the bus replays a composite in
reverse order). For example, undoing `node.setPivot` on a node that had
no pivot component first restores the previous transform — including the
old `transform.pivot` — and then removes the annotation, mirroring the
`node.create`/`node.delete` pattern. A new commit clears the redo
history; `NOTHING_TO_UNDO` / `NOTHING_TO_REDO` are returned at the ends
of history.

## No-op semantics

Removing an absent singleton or adding an existing one commits a no-op
transaction; `node.setPivot` is also a no-op when both the annotation and
`transform.pivot` already hold the requested value. The revision still
increments and an event is emitted, but `changedNodeIds` is empty,
keeping history uniform.
