# Transform gizmo

Plan S7.8, ticket #20. Move, rotate, and scale selected nodes from the
viewport. The drag math, snapping, local/world modes, and commit/cancel
behavior are headless (`@voxel-maker/editor` `transform-tool.ts`); the
desktop layer renders the handles and performs screen-space picking
(`apps/desktop/src/viewport/gizmo.ts`).

## Modes and spaces

- **Move / Rotate / Scale** mode buttons in the toolbar switch the
  rendered handles. The gizmo appears at the union world-bounds center of
  the node selection whenever the select tool is active and at least one
  node entry is selected; the handle size scales with the content.
- **World / Local** toggle: world space uses world axes and rotates the
  whole world placement around the gizmo center; local space uses each
  node's own rotated axes (the gizmo orients with the first selected
  node's rotation) and applies deltas in each node's local frame.
- **Snap** checkbox (on by default): translate distances snap to 0.25
  world units, rotation angles to 15 degrees, scale factors to 0.25
  increments. The increments are explicit tool state
  (`setTranslateSnap`, `setRotateSnap`, `setScaleSnap`).

## Drag semantics

- **Translate**: the pointer ray intersects the drag plane (the plane
  containing the axis that faces the camera, with a camera-facing fallback
  when the ray is parallel); the signed distance along the axis applies to
  every selected node.
- **Rotate (world)**: the node's world matrix rotates around the gizmo
  center by the signed angle about the world axis; the resulting local
  transform is resolved with `resolveLocalTransform` (ADR-0001
  derived-transform policy, 1e-9 quantization).
- **Rotate (local)**: the node's local rotation is pre-multiplied by the
  delta around its own local axis.
- **Scale (local)**: the chosen local scale component multiplies by the
  drag factor (relative to the gizmo radius).
- **Scale (world)**: the world axis is expressed in the node's local
  frame and each scale component multiplies by its projection, so an
  axis-aligned node scales on the matching axis and a rotated node scales
  along the world axis. Factors are clamped strictly positive.

Every produced transform is canonicalized (finite, positive scale,
normalized rotation) before it enters a command, so a drag can never
install an invalid transform.

## History and cancellation (S4.10)

A gizmo drag opens one coalescing gesture on the command bus
(`bus.beginGesture`). Every pointer move commits a normal atomic
`node.setTransform` transaction, and compatible updates replace the
unsealed history entry, so the whole drag presents as exactly one history
entry labeled Move/Rotate/Scale. Undo restores the pre-drag state; redo
replays the first and latest updates. Pointer cancellation (`Escape` or a
lost pointer) executes the pending inverse as one transaction that leaves
no history entry, restoring the exact pre-drag transforms.

See `docs/commands/coalescing.md` for the bus-level contract.
