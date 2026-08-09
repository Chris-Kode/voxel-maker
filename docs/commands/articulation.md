# `node.*` articulation component commands

The `node.setPivot`, `node.removePivot`, `node.addJoint`, and
`node.removeJoint` commands (plan S9.3, ticket #26) manage the singleton
pivot and joint components through the command bus. A joint annotates a
node in the single transform hierarchy; it never introduces a second
parent graph or skeleton structure. Pivot and joint are singletons per
node, so these commands are per-discriminant create/update/remove
operations instead of whole-list replacement.

The `node.addConstraint`, `node.setConstraint`, `node.reorderConstraint`,
and `node.removeConstraint` commands (plan S9.4, ticket #27) manage
stable, explicitly ordered local Euler XYZ rotation limits (ADR-0006).
Constraints are multi-instance descriptors with caller-supplied stable
component ids, so their lifecycle is one descriptor at a time;
`node.setComponents` remains the whole-list replacement path.

## Command shapes

All commands share `schemaVersion: 1` and a branded `payload.nodeId`.

| Command | Payload fields | Effect |
| --- | --- | --- |
| `node.setPivot` | `nodeId`, `pivot` | Creates the pivot component, or updates it when one already exists (canonical finite vector). Write-through: `transform.pivot` — the value the approved transform formula evaluates (ADR-0001) — is set to the same value, so the annotation and the geometry never disagree (plan S7.9). |
| `node.removePivot` | `nodeId` | Removes the pivot annotation; a no-op commit when absent. `transform.pivot` is left untouched: the node keeps its geometric pivot and only loses the articulation declaration. |
| `node.addJoint` | `nodeId` | Adds the joint annotation; a no-op commit when present. |
| `node.removeJoint` | `nodeId` | Removes the joint annotation; a no-op commit when absent. |
| `node.addConstraint` | `nodeId`, `componentId`, `limits`, `before` | Creates a rotation-limits descriptor (`limits.min` / `limits.max` radian vectors, finite `min <= max` per axis) and inserts it before the `before` constraint id (`null` appends). Re-adding an identical descriptor at the same position is a no-op commit; re-adding the same id with different limits is rejected with `DUPLICATE_COMPONENT_ID`. |
| `node.setConstraint` | `nodeId`, `componentId`, `limits` | Replaces the limits of an existing descriptor; a no-op commit when the limits are unchanged. |
| `node.reorderConstraint` | `nodeId`, `componentId`, `before` | Moves the descriptor before the `before` constraint id (`null` moves it to the end); a no-op commit when the position is unchanged. |
| `node.removeConstraint` | `nodeId`, `componentId` | Removes the descriptor; removing the last descriptor also removes the constraint component. Removing an absent descriptor is a no-op commit. |

Use the canonicalizing constructors (`setPivotCommand`,
`removePivotCommand`, `addJointCommand`, `removeJointCommand`,
`addConstraintCommand`, `setConstraintCommand`,
`reorderConstraintCommand`, `removeConstraintCommand`); they validate
and normalize the payload at construction time. Register the handlers
with `registerArticulationCommands`.

## Validation

- `INVALID_VECTOR` / `INVALID_CANONICAL_NUMBER` — malformed pivot values
  (finite, never negative zero).
- `INVALID_CONSTRAINT` — malformed limits (non-record, unknown field,
  min greater than max on an axis).
- `UNKNOWN_FIELD` — unknown constraint command or limits fields.
- `MISSING_NODE` — the target node does not exist.
- `DUPLICATE_COMPONENT_ID` — the constraint component id already exists
  in the document (or re-adds an existing id with different limits).
- `MISSING_CONSTRAINT` — `set`/`reorder` target a component id the node
  does not carry.
- `INVALID_ORDER_TARGET` — `before` references the constraint itself or a
  constraint on another node.

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
`transform.pivot` already hold the requested value. Constraint commands
are no-ops when the request matches the current state: identical
re-adds, unchanged limits, same-position reorders, and removals of
absent descriptors. The revision still increments and an event is
emitted, but `changedNodeIds` is empty, keeping history uniform.

## Constraint ordering and undo

Constraints apply in their persisted list order (ADR-0006), so reordering
is a user-visible semantic change. Undo restores the exact pre-command
list: reorders record a `before` target that moves the descriptor back to
its original index, and removing a middle descriptor records an add with
the following descriptor as its `before`. When a node carries an empty
constraint component (only possible through whole-list replacement), add
and remove fall back to a whole-list `node.setComponents` inverse so undo
is always exact.
