# Hierarchy and inspector panels

Plan S7.11/S7.12, ticket #20. The desktop shell ships a left hierarchy
panel and a right inspector panel. All behavior lives in headless modules
(`@voxel-maker/editor` `hierarchy.ts` and `inspector.ts`); React widgets
render state, forward edits to the command bus, and display the structured
errors the bus returns. Panels never encode domain invariants themselves
(ARCHITECTURE.md "Editor interaction").

## Hierarchy panel (S7.11)

- **Create**: "＋ Root child" creates a child of the root; every row has a
  "＋" button that appends a child. The command is `node.create` with the
  deterministic default name (`Node`, `Node 2`, ... collision-free among
  siblings), the identity transform, and no components
  (`buildCreateChildCommand`). The new node is selected after commit.
- **Rename**: the "✎" button turns the row into an inline input; Enter or
  blur commits `node.rename`, Escape cancels. Empty input removes the
  name.
- **Delete**: the "✕" button commits `node.delete` for leaf nodes. The
  panel pre-checks with `deleteFeedback` and shows the deterministic
  reason as a notice: the root, nodes with children, and nodes referenced
  by animation tracks cannot be deleted.
- **Selection**: clicking a row selects the node (Shift adds, Ctrl/Cmd
  toggles — same modifier table as the viewport); selection entries are
  runtime `EditorStore` state.
- **Drag reparenting**: rows are draggable (except the root). While
  dragging over a target row, `reparentFeedback` classifies the drop
  (`ok`, `self`, `root`, `cycle`, `missing-node`, `missing-target`) and
  the row highlights valid/invalid with the reason inline. Dropping
  commits `node.reparent` with `preserve-world` placement (the command
  constructor resolves the canonical local transform, ADR-0001), so the
  node keeps its world placement under the new parent.

## Inspector panel (S7.12)

- **Transform fields**: Position, Rotation (Euler XYZ degrees), Scale,
  and Pivot are edited as "x, y, z" text. Parsing is validated
  (`parseVec3Input`, `parseRotationDegreesInput`, `parseScaleInput`) and
  the commit is one labeled transaction of `node.setTransform` commands
  built by `buildSetTransformFieldCommands`. Scale must stay strictly
  positive; rotation text uses the same Euler convention as the gizmo.
- **Mixed multi-selection**: with several nodes selected, each field
  shows the shared value or a "Mixed" placeholder
  (`transformFieldValue`); committing a field applies it to every
  selected node, preserving each node's other fields. No-op edits are
  skipped.
- **Components**: single-node selection lists components (voxel, pivot,
  joint, constraint) with summaries and remove buttons; voxel (by volume
  id), pivot, and joint components can be added. Commits are
  `node.setComponents` with the full replacement list.
- **Constraints (plan S9.7, ticket #27)**: with a single constrained node
  selected, a Constraints section lists every rotation-limits descriptor
  in persisted order. Each row edits the six degree values
  `minX, minY, minZ, maxX, maxY, maxZ` (parsed by
  `parseLimitsDegreesInput`, committed as one `node.setConstraint`
  transaction; invalid values and min > max per axis surface as
  notices), moves the descriptor earlier/later (`node.reorderConstraint`),
  and removes it (`node.removeConstraint`). "＋ Constraint" appends a new
  descriptor with ±90° defaults through `node.addConstraint` using a
  fresh stable component id. The section also shows the constrained
  runtime rotation in degrees next to the authored rotation
  (`constraintRuntimeRotationDegrees`, plan S9.5) — the same clamped
  result the viewport renders.
- **Metadata**: a JSON text area commits `node.setMetadata`; invalid or
  non-finite input is rejected with a notice, and the bus enforces the
  document's depth/byte limits. Empty text removes the record.
