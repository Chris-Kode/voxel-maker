# Viewport overlay visibility policy (v1)

**Plan:** S6.13 — Grid, axes, bounds, and pivot overlays.
**Ticket:** #16 — Navigate and pick in the viewport.
**Status:** accepted (implementation baseline).

## Purpose

The viewport renders four non-persistent helper overlays on top of the
projected document. This document is the visibility policy the ticket
requires: what each overlay is, when it is visible, how it is rendered
(depth and render-order policy), and the guarantees that keep overlays out
of persistent state.

## Overlay inventory

| Overlay | Description | Default | Depth / render order |
| --- | --- | --- | --- |
| Grid | XZ ground plane at world `y = 0`, one line per voxel unit (100 × 100 units) | visible | depth-tested, `depthWrite = false`, `renderOrder = 1` (draws after opaque voxel geometry, never pollutes the depth buffer) |
| Axes | `+X` red, `+Y` green, `+Z` blue lines from the world origin, fixed length 10 | visible | `depthTest = false`, `depthWrite = false`, `renderOrder = 3` (always on top) |
| Bounds | Content bounds wire box (cyan), selection bounds wire box (yellow), region-select draft box (orange), and transform-preview destination boxes (magenta, one per exact affected region, ticket #19) around the world AABBs of occupied voxels / affected bounds | visible when a document is open and content/selection/preview exists | depth-tested, `depthWrite = false`, `renderOrder = 2` |
| Pivots | Orange cross marker at every selected node's world-space transform pivot (`transform.pivot` transformed by the node world matrix) | visible when a selection exists | `depthTest = false`, `depthWrite = false`, `renderOrder = 3` (always on top) |

## Visibility policy

1. **Overlays are runtime state (ADR-0002).** They are projections of the
   authoritative document and the runtime selection. They are never part
   of a document revision, commit event, history entry, autosave, journal,
   `.vxl` file, or any export. Closing or replacing a document disposes
   the document-dependent overlays (bounds, pivots) immediately; the grid
   and axes are world helpers and remain.
2. **Default visibility is all-on.** The overlay manager starts with
   `{ grid: true, axes: true, bounds: true, pivots: true }` and applies
   each key independently; document-dependent overlays additionally hide
   themselves when there is nothing to show (no document, no content, no
   selection).
3. **Toggles are runtime-only.** `G`, `X`, `B`, `K` toggle grid, axes,
   bounds, and pivots in the desktop shell. Toggle state lives in the
   overlay manager and is never persisted or synchronized.
4. **Rebuild, never mutate.** Every store commit, selection change, or
   lifecycle event rebuilds the bounds/pivot projections from the current
   immutable read surface. Superseded geometries and materials are
   disposed exactly once; overlays never hold references to authoritative
   backing memory.
5. **Determinism.** Content and selection bounds use the same world
   matrices as picking (`nodeWorldMatrices`, ADR-0001), so the wire boxes
   always match what picking returns.

## Pointer and keyboard reference

| Input | Behavior |
| --- | --- |
| Left-drag | Orbit (drag right orbits the camera left; drag down orbits it up) |
| Right-drag / middle-drag | Pan (content follows the cursor) |
| Wheel | Zoom (perspective: distance; orthographic: zoom factor) |
| Click (no drag) | Pick the nearest voxel and select its node (ADR-0005 tie-break) |
| `1`–`6` | Front / back / left / right / top / bottom views (`+X` right, `+Y` up, `+Z` forward) |
| `F` | Focus the selection, or the whole content when nothing is selected (keeps the viewing direction) |
| `P` | Toggle perspective / orthographic projection (keeps target and framing) |
| `G` / `X` / `B` / `K` | Toggle grid / axes / bounds / pivots |

## Non-goals

- No overlay is pickable in v1 (pivot/joint picking arrives with the
  rigging overlays, plan S9.8).
- No overlay setting is persisted across sessions.
- Grid sizing is fixed; adaptive/scale-aware grids are deferred.
