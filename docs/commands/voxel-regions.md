# `voxel.copyRegion`, `voxel.deleteRegion`, `voxel.translateRegion`, `voxel.rotateRegion`, and `voxel.mirrorRegion`

These commands rearrange existing voxel geometry with explicit, reversible,
grid-preserving behavior (issue #9, plan S3.9–S3.12). Every operation uses
half-open integer regions `[min, max)`, snapshots the source before any
destination write, and returns a compact per-chunk change set that supports
exact inversion without whole-document snapshots.

## Command shapes

All commands use `schemaVersion: 1` and a branded `payload.volumeId`.

| Command | Payload | Meaning |
| --- | --- | --- |
| `voxel.copyRegion` | `source: { min, max }`, `destination: [x, y, z]` | Copies the occupied voxels of `source` to the destination AABB whose min corner is `destination`; the source is left in place. |
| `voxel.deleteRegion` | `region: { min, max }` | Removes every occupied voxel in the region. |
| `voxel.translateRegion` | `region: { min, max }`, `delta: [x, y, z]` | Moves the region content by an integer delta; the source is cleared. |
| `voxel.rotateRegion` | `region: { min, max }`, `axis: "x" \| "y" \| "z"`, `quarterTurns: 1 \| 2 \| 3` | Rotates the region content around the region center by exact 90-degree increments; the source is cleared. |
| `voxel.mirrorRegion` | `region: { min, max }`, `axis: "x" \| "y" \| "z"` | Mirrors the region content across the plane through the region center perpendicular to `axis`; the source is cleared. |

Use the canonicalizing constructors (`copyRegionCommand`,
`deleteRegionCommand`, `translateRegionCommand`, `rotateRegionCommand`,
`mirrorRegionCommand`); they validate and normalize payloads at construction
time.

## Frozen origin and axis semantics (v1)

Origin and axis semantics are product policy and are frozen by golden
coordinate fixtures, including negative positions (plan S3.9–S3.12).

- **Translate** — `p' = p + delta`. The destination AABB is the source AABB
  translated by `delta`.
- **Rotate** — the region center is `c = (min + max) / 2`. The mapping is
  the exact lattice rotation of voxel centers,
  `p' = c + R(p + 1/2 - c) - 1/2`, where `R` is the right-handed 90-degree
  rotation about `axis` (`+X` right, `+Y` up, `+Z` forward). The destination
  is the AABB of the rotated content: the same center with the two
  rotation-plane extents swapped (180 degrees keeps the source box). Four
  quarter turns are the identity.
- **Mirror** — the mirror plane passes through the region center
  perpendicular to `axis`; `p' = (min.a + max.a - p.a - 1)` on the mirror
  axis. The destination is the source region itself, so mirroring twice is
  the identity.

### Exact-rotation constraint

A 90-degree rotation around the region center maps integer voxel
coordinates to integer coordinates only when the region extents on the two
rotation-plane axes have the same parity (both even or both odd). When the
parities differ, the rotated voxel centers would land on half-integer
positions, so the operation is rejected with `INVALID_ROTATION_REGION` at
parse time. Resampling is explicitly deferred in v1 (plan S3.11); 180-degree
rotations are always exact.

## Snapshot and collision semantics

Every operation reads the source region into a snapshot before any
destination write, so overlapping sources behave as if the source were
copied first:

- `voxel.copyRegion` onto an overlapping destination copies the
  pre-operation source values (the copy does not see its own writes).
- `voxel.translateRegion` / `voxel.rotateRegion` / `voxel.mirrorRegion`
  clear the source and write the moved content; when source and destination
  overlap, the moved content wins over the cleared source.

Destination collisions overwrite explicitly: `overwrite` is the v1 collision
mode (plan S3.10). There is no merge, skip, or error on collision.

## Preflight and limits (ADR-0009)

Every operation validates and estimates before staging writes; a limit
failure leaves the volume byte-identical:

- `REGION_OUT_OF_BOUNDS` — the source region or the operation destination
  exceeds the volume coordinate domain.
- `TOO_MANY_VOXELS` — the region iteration domain is pathological (larger
  than twice the per-operation limit), more than 1,000,000 voxels are
  inspected, or the operation would change more than 1,000,000 voxels in
  net (a move's clear and write entries are not double-counted).
- `TOO_MANY_OCCUPIED_VOXELS` / `TOO_MANY_CHUNKS` / `EXTENT_LIMIT_EXCEEDED` —
  the operation would exceed the volume's occupied-voxel, chunk, or extent
  limits. Region moves use an exact estimate: the net occupied count
  (additions minus removals), the net chunk count (emptied source chunks are
  reclaimed), and the exact post-operation occupied bounds, so moving
  content across the world or near a limit is not falsely rejected.
- `INVALID_VOXEL_COORDINATE`, `INVALID_AABB`, `INVALID_AXIS`,
  `INVALID_QUARTER_TURNS`, `INVALID_ROTATION_REGION` — malformed payloads
  fail at parse time. A translation delta may reach
  `2 * maxVoxelCoordinate + 1` (a region at one extreme of the domain can
  validly move to the other); the destination AABB check then bounds the
  result.
- Command payloads are additionally bounded by the bus's 1 MiB canonical
  payload limit and the 16 MiB transaction envelope limit.

`validate` checks the committed document: `MISSING_VOLUME` for unknown
volumes. Region commands do not reference materials in their payloads; the
affected materials are derived from the change set for event reporting.

## Compact change sets and exact inversion

Every command returns a `VoxelChangeSet` (`{ volumeId, chunks: [{ coordinate,
revision, patches: [{ index, oldValue, newValue }] }] }`) — per-chunk local
indices, never whole-document snapshots. The stored inverse of every region
command is a single `voxel.applyPatches` command carrying the change set's
`oldValue`s, so undo restores exact pre-command semantic state and redo
replays the original intent. Undo/redo replay is exempt from the input
budgets exactly as documented for batch and fill commands.

## No-op semantics

A region command whose source contains no occupied voxels commits a no-op
transaction: the revision increments and an event is emitted, but all
`changed*` fields are empty.
