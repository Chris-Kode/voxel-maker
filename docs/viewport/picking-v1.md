# Viewport picking semantics (v1)

**Plan:** S6.12 — Node and voxel picking.
**Ticket:** #16 — Navigate and pick in the viewport.
**Status:** accepted (implementation baseline).

## Contract

`pickScene(store, ray, options?)` in `@voxel-maker/renderer` returns the
deterministic nearest voxel hit along a world-space ray, or `undefined` on
a miss. A hit carries:

- `nodeId` / `volumeId` — stable identifiers (ADR-0005 tie-break tail).
- `voxel` — volume-local integer voxel coordinate (may be negative).
- `face` — volume-local axis-aligned unit face normal of the entered face.
- `distance` — world-space ray distance, always non-negative.
- `point` — world-space hit point on the entered face.

The function is pure: it reads only the immutable `DocumentStoreRead`
surface, never mutates semantic or renderer state, and returns identical
results for identical inputs.

## Algorithm

1. **World matrices.** Node world matrices are computed depth-first from
   the document root in explicit child order using the canonical local
   matrices (`transformToMatrix`, ADR-0001 pivot semantics).
2. **Local ray.** The ray is transformed into each volume's local space
   through the inverse world matrix, so picking is exact under negative
   voxel coordinates, translated/pivoted nodes, rotation, and non-uniform
   scale. Near-zero local direction components (float roundoff through
   rotation matrices) are snapped to zero (`PICK_DIRECTION_EPSILON`).
3. **Chunk traversal.** Each allocated chunk (stable X, then Y, then Z
   order) is rejected with a slab test, then traversed with an
   Amanatides–Woo voxel DDA in local integer space. Origins within the
   boundary epsilon of a chunk face count as inside, so an exactly
   grazing ray cannot be lost to matrix roundoff.
4. **Incident voxel set.** At every cell entry event the full incident
   set — every voxel whose closed cube contains the entry point, across
   chunk borders — is checked for occupancy. This makes exact
   edge/corner/face ties resolvable regardless of which cell the DDA
   steps into first. The first event with any occupied incident voxel is
   the chunk's nearest hit.
5. **Tie-break (ADR-0005).** The best candidate is the smallest
   non-negative ray distance; an exact boundary tie (within
   `PICK_DISTANCE_EPSILON`) resolves by voxel X, then Y, then Z
   (volume-local coordinates), followed by stable Node ID and Volume ID.
   The key is lexicographic: the ID tail decides only ties that X/Y/Z
   leave open (for example two volumes with identical transforms and
   overlapping voxels). Cross-volume ties at the same world point compare
   each volume's local voxel coordinates first, which is deterministic
   and locked by tests.
6. **Face.** The face is the volume-local face the ray crosses into the
   voxel: the min face when moving along an axis, the max face when
   moving against it. Tangent (grazing) touches fall back to the
   containing face whose plane is most perpendicular to the ray (X, Y, Z
   priority on equal magnitudes). When the ray origin lies strictly
   inside a voxel (distance 0), the face is the first face the ray exits
   (dominant axis).

## Epsilons

| Constant | Value | Meaning |
| --- | --- | --- |
| `PICK_BOUNDARY_EPSILON` | `1e-6` | Absolute coordinate epsilon for "point on integer plane" and slab-boundary tests. Well below one voxel unit; above double-precision noise for supported coordinate magnitudes. |
| `PICK_DISTANCE_EPSILON` | `1e-6` | Distance epsilon for the ADR-0005 "exact boundary tie" predicate. |
| `PICK_DIRECTION_EPSILON` | `1e-12` | Relative epsilon for snapping local ray direction components to zero. |

## Consequences

- A ray through an exact corner returns the min-X/min-Y/min-Z occupied
  incident voxel, not an arbitrary one — deterministic across frames,
  platforms, and renderers.
- A ray entering a solid box exactly on its surface plane ties with the
  layer behind the surface (the ray enters it at the same point) and the
  X/Y/Z rule decides; the reported face and distance describe the shared
  face.
- `maxDistance` (optional) rejects hits beyond a world-space budget.

## Non-goals

- Picking empty (voxel-less) nodes is not supported in v1; only occupied
  voxels are pickable.
- GPU/triangle picking is not used; the DDA reads semantic chunk data, so
  picks never depend on mesh generation, culling, or draw state.
