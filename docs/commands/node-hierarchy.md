# `node.*` hierarchy commands

The `node.create`, `node.rename`, `node.setTransform`, `node.setComponents`,
`node.setMetadata`, `node.delete`, and `node.reparent` commands evolve the
generic scene graph through the command bus — the same atomic history path as
voxel edits. Direct mutation of node records is not available through public
consumer interfaces.

## Command shapes

All commands share `schemaVersion: 1` and a branded `payload.nodeId`.

| Command | Payload fields | Effect |
| --- | --- | --- |
| `node.create` | `nodeId`, `parentId`, `transform`, optional `name`, `components`, `metadata`, `index` | Adds an ordered child under `parentId`; `index` (non-negative integer, absent appends) selects the insertion position. |
| `node.rename` | `nodeId`, optional `name` | Sets the node name; absent removes it. |
| `node.setTransform` | `nodeId`, `transform` | Replaces the canonical local transform. |
| `node.setComponents` | `nodeId`, `components` | Replaces the component list (closed discriminated union). |
| `node.setMetadata` | `nodeId`, optional `metadata` | Replaces bounded JSON metadata; absent removes it. |
| `node.delete` | `nodeId` | Removes a leaf node and its parent reference. |
| `node.reparent` | `nodeId`, `newParentId`, `placement`, optional `transform` | Moves a node under a new parent, preserving local or world placement. |

Use the canonicalizing constructors (`createNodeCommand`, `renameNodeCommand`,
`setNodeTransformCommand`, `setNodeComponentsCommand`, `setNodeMetadataCommand`,
`deleteNodeCommand`, `reparentNodeCommand`); they validate and normalize the
payload at construction time.

## Validation

`parse` bounds every untrusted value before allocation:

- `INVALID_ID` / `MISSING_NODE` — malformed or unknown node identifiers.
- `INVALID_NAME` — name is not a string or exceeds `maxNameBytes`.
- `INVALID_TRANSFORM`, `INVALID_QUATERNION`, `NON_CANONICAL_QUATERNION`,
  `INVALID_SCALE`, `INVALID_VECTOR` — malformed transform components.
- `UNSUPPORTED_COMPONENT`, `UNSUPPORTED_COMPONENT_VERSION`,
  `DUPLICATE_COMPONENT`, `INVALID_CONSTRAINT`, `UNKNOWN_FIELD` — the
  component list must match the closed discriminated union exactly; voxel,
  pivot, and joint are singletons per node.
- `INVALID_METADATA`, `CYCLIC_VALUE`, `LIMIT_EXCEEDED` — metadata must be
  JSON-compatible and within `maxMetadataDepth`, `maxMetadataMembers`,
  `maxMetadataBytes`, and `maxMetadataStringBytes`.

`validate` checks the command against the committed (or staged) document:

- `DUPLICATE_NODE_ID` — `node.create` with an existing identifier and a
  different record.
- `MISSING_NODE` — unknown parent or target.
- `LIMIT_EXCEEDED` — `node.create` beyond `maxNodes`.
- `MISSING_VOLUME` — a voxel component references an unknown volume.
- `DUPLICATE_COMPONENT_ID` — constraint component ids must be unique across
  the whole document.
- `INVALID_ROOT` — the document root cannot be deleted or reparented.
- `NODE_HAS_CHILDREN` — only leaf nodes can be deleted (delete or reparent
  the children first).
- `REFERENCED_NODE` — a node targeted by an animation track cannot be
  deleted.
- `SELF_PARENT` / `CYCLIC_HIERARCHY` — reparenting to the node itself or to
  one of its descendants is rejected, preserving acyclicity.

## Reparenting placement

- `preserve-local` keeps the node's current local transform; its world
  placement changes with the new parent.
- `preserve-world` keeps the node's world placement: the command constructor
  resolves the canonical local transform `inverse(parentWorld) x world` from
  the current document (ADR-0001 derived-transform policy: 1e-9 quantization,
  magnitudes below 5e-10 canonicalized to zero, normalized and
  sign-canonicalized rotation, decomposition recomposition checked within
  1e-9) and carries it in the payload. The handler installs the resolved
  transform verbatim, so the payload is deterministic intent. The node's
  pivot is preserved.
- `set-transform` reparents and installs the given canonical local transform
  verbatim. The `node.reparent` inverse uses this placement to restore the
  exact previous local transform on undo.

## Transaction and revision behavior

Every `bus.execute` / `bus.executeTransaction` / `bus.undo` / `bus.redo` call
commits exactly one transaction: the document revision increments by exactly
one and exactly one deeply frozen `DocumentCommitted` event is emitted.
`expectedRevision` must match, transactions are atomic, and history is
bounded by `CommandLimits`. Later commands in one transaction see earlier
staged record effects (plan 4.4).

## Undo and redo

- Undo of `node.create` deletes the node; undo of `node.delete` recreates
  the exact record (name, transform, components, metadata, parent, and
  children index). Undo of `node.rename`, `node.setTransform`,
  `node.setComponents`, and `node.setMetadata` restores the previous values.
- Undo of `node.reparent` moves the node back to its previous parent with
  `preserve-world` and the previous local transform, restoring the exact
  pre-command state.
- A new commit clears the redo history; `NOTHING_TO_UNDO` /
  `NOTHING_TO_REDO` are returned at the ends of history.

## No-op semantics

Creating a node that already exists with an identical record (same parent,
name, transform, components, and metadata) commits a no-op transaction: the
revision still increments and an event is emitted, but `changedNodeIds` is
empty. Deleting a node that is already absent is likewise a no-op. This keeps
history uniform so undo/redo behavior is predictable.
