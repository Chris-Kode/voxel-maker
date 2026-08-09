# Format compatibility v1

**Status:** v1 (issue #46, plan §14, ADR-0004/0011, S17.11)
**App version:** 0.1.0

## Native format: `.vxl`

- ZIP container **v1** with fixed entry names, per-entry checksums, and
  a manifest carrying independent versions: `containerVersion`,
  `documentSchemaVersion`, `voxelEncodingVersion`, `commandSchemaVersion`
  (docs/format/vxl-v1.md, document-v1.md).
- The semantic hash covers the document JSON plus sorted chunk streams;
  same writer version ⇒ byte-identical output for the same content.
- Readers support a declared backward window; migrations are ordered,
  pure, tested on immutable fixtures, and produce a report. Unknown
  future versions fail safely and never overwrite the source.
- A saved document never requires a skill to open, edit, animate, or
  export (skills are removable knowledge).
- Unknown persistent fields in a supported version are never silently
  discarded.

## MagicaVoxel `.vox` (import and export)

| Aspect | v1 behavior |
|---|---|
| Import | Bounded parse (chunk budgets, axis ≤ 256, palette bounds, unknown-chunk byte cap); one import = one transaction; warnings reported |
| Export | Deterministic; preflight blocks with a structured loss report unless the user accepts explicit choices |
| Transforms | Non-identity transforms block export by default (VOX writes no transforms) |
| Hierarchy | Nested voxel volumes block unless `flattenHierarchy` is chosen (reported as loss) |
| Origin | Negative-space occupancy blocks unless `rebaseOrigins` is chosen (reported as loss) |
| Metadata/material semantics | Names and PBR semantics are not representable; reported as losses |
| Palette | ≤ 255 colors; extras are mapped/reported |

The editor and VOX space share the +X right / +Y up convention with an
axis mapping documented in `docs/format/vox-v1.md`; `(x, y, z)` editor
maps to `(X, -Z, Y)` vox space.

## glTF 2.0 (export only; import deferred)

- `.gltf` (JSON + embedded data-URI buffer) and `.glb` (binary) both
  deterministic (ADR-0011).
- One voxel edge = one meter; right-handed +Y up, +X right.
- Node hierarchy and ordered local translation / canonical quaternion /
  positive scale map to glTF nodes; pivots become deterministic helper
  nodes; clips map to glTF animations.
- Constraint semantics and pivot-helper identity are not representable
  in glTF; export metadata and goldens report them (loss report for
  constrained motion is part of the export outcome).
- No glTF import in v1.

## Backup guidance

See [backup and recovery](./backup-and-recovery-v1.md) for the
operational guidance; the format-level guarantees are:

1. Every confirmed save is atomic (temp + fsync + rename); the previous
   project file is preserved as a last-known-good backup before replace.
2. The recovery journal is per-project, bounded, and anchored to the
   last confirmed save; replaying it restores committed transactions
   only (never partial transactions).
3. Save-as preserves the recovery identity and moves the journal with
   the file; the old path keeps a recoverable combination at every crash
   point.
4. Keep regular external copies of `.vxl` files (the format is
   self-contained and versioned; a copy opened on any supported
   platform is byte-compatible).
