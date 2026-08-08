# `voxel.setBatch`, `voxel.removeBatch`, `voxel.fillBox`, `voxel.fillSphere`, `voxel.fillCylinder`, `voxel.replaceMaterial`, and `voxel.applyPatches`

These commands let callers make efficient deterministic bulk edits without
issuing unbounded per-voxel mutations (issue #8, plan S3.5–S3.8, S3.15,
S4.13). Every operation is planned and preflighted before any chunk is
allocated or mutated, and every operation returns a compact per-chunk change
set that supports exact inversion without retaining whole-document
snapshots.

## Command shapes

All commands use `schemaVersion: 1` and a branded `payload.volumeId`.

| Command | Payload | Meaning |
| --- | --- | --- |
| `voxel.setBatch` | `entries: [{ coordinate, material }]` | Sets many voxels atomically; materials are branded `MaterialId` (1–65535). |
| `voxel.removeBatch` | `coordinates: [x, y, z][]` | Removes many voxels atomically. |
| `voxel.fillBox` | `region: { min, max }`, `material` | Fills the half-open box `[min, max)`. |
| `voxel.fillSphere` | `center`, `radius`, `material` | Fills the solid sphere (integer center and radius). |
| `voxel.fillCylinder` | `center`, `radius`, `height`, `axis: "x" \| "y" \| "z"`, `material` | Fills the axis-aligned solid cylinder. |
| `voxel.replaceMaterial` | `region?`, `fromMaterial`, `toMaterial` | Replaces matching voxels; both values are 0–65535 (0 = empty). |
| `voxel.applyPatches` | `chunks: [{ coordinate, patches: [{ index, oldValue }] }]` | Restores voxels from a compact change-set patch list (0 removes). |

Use the canonicalizing constructors (`setBatchCommand`, `removeBatchCommand`,
`fillBoxCommand`, `fillSphereCommand`, `fillCylinderCommand`,
`replaceMaterialCommand`, `applyPatchesCommand`); they validate and normalize
payloads at construction time.

## Frozen voxelization rules (v1)

Shape voxelization is product policy and is frozen by golden tests before AI
depends on it (plan S3.5/S3.7). All rules use exact integer arithmetic and
are identical on every platform.

- **Box** — every integer point in the half-open region `[min, max)`.
- **Sphere** — every integer point whose squared distance from the integer
  center is at most `radius^2` (a solid sphere). Radius `0` yields exactly
  the center point.
- **Cylinder** — every integer point whose coordinate along `axis` lies in
  `[center[axis], center[axis] + height)` and whose squared distance from
  the axis is at most `radius^2`. Height `0` yields no points.

Radii and heights are non-negative integers in v1. Fills clip to the volume
coordinate domain (`+-maxVoxelCoordinate`); because regions are half-open,
`voxel.fillBox` and `voxel.replaceMaterial` region bounds may reach
`maxVoxelCoordinate + 1` so the boundary voxel itself is fillable.

## Duplicate-coordinate policy

Batch coordinates are resolved **last-write-wins in payload order** (the
same semantics as sequential `voxel.set` calls), then processed in canonical
sorted order (chunk X, then Y, then Z; local index within a chunk). The
change set reports only the net effect per voxel.

## Preflight and limits (ADR-0009)

Every operation validates and estimates before staging writes; a limit
failure leaves the volume byte-identical:

- `TOO_MANY_VOXELS` — more than 1,000,000 voxels inspected, generated, or
  changed by one operation (or an iteration domain larger than twice that,
  which would make a sparse shape scan pathological).
- `TOO_MANY_OCCUPIED_VOXELS` / `TOO_MANY_CHUNKS` / `EXTENT_LIMIT_EXCEEDED` —
  the operation would exceed the volume's occupied-voxel, chunk, or extent
  limits. Errors name the requested and configured amounts.
- `INVALID_VOXEL_COORDINATE`, `INVALID_AABB`, `INVALID_AXIS`,
  `INVALID_SHAPE_DIMENSION`, `INVALID_CHUNK_INDEX`, `INVALID_MATERIAL_ID` —
  malformed payloads fail at parse time.
- `REGION_REQUIRED` — `voxel.replaceMaterial` with `fromMaterial: 0` (paint
  empty voxels) requires an explicit region, because the empty domain is
  unbounded.
- Command payloads are additionally bounded by the bus's 1 MiB canonical
  payload limit and the 16 MiB transaction envelope limit.

`validate` checks the committed document: `MISSING_VOLUME` for unknown
volumes, and `MISSING_MATERIAL` for `voxel.setBatch`/fill materials and for
`voxel.replaceMaterial`'s `toMaterial` when it is non-empty. `fromMaterial`
is a filter and may reference a material that is not present (a no-op), and
`voxel.applyPatches` restores values without re-checking material existence
because it is the exact-inverse primitive for already-validated commands.

## Compact change sets and exact inversion

Every command returns a `VoxelChangeSet` (`{ volumeId, chunks: [{ coordinate,
revision, patches: [{ index, oldValue, newValue }] }] }`) — per-chunk local
indices, never whole-document snapshots. The stored inverse of every batch,
fill, replace, and patch command is a single `voxel.applyPatches` command
carrying the change set's `oldValue`s, so undo restores exact pre-command
semantic state and redo replays the original intent.

Undo/redo replay is exempt from the *input* budgets (payload bytes, command
count): stored inverses were already bounded at commit time (forward payload
budget plus the 256 MiB history inverse-bytes budget), and re-checking them
would make large fills un-undoable even though ADR-0003 requires every v1
edit command to be undoable and ADR-0009 allows 1,000,000 voxels per
transaction. New commits always run the full budget checks.

## No-op semantics

A batch whose entries are all no-ops, a fill of an empty shape, or a
`voxel.replaceMaterial` whose source and target match commits a no-op
transaction: the revision increments and an event is emitted, but all
`changed*` fields are empty.
