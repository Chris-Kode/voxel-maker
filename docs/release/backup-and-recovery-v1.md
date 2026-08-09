# Backup and recovery v1

**Status:** v1 (issue #46, plan §5.6/S5.10/S5.15, ADR-0004/0011)
**App version:** 0.1.0

## What the app guarantees

- **Atomic saves.** A confirmed save writes to a same-directory temp
  file, flushes, and atomically renames over the project file. The
  previous project file is first preserved as a last-known-good backup
  next to the project (`.bak` convention of the storage adapter).
- **Recovery journal.** Every committed transaction after the last
  confirmed save is appended to an adjacent bounded journal. The journal
  stores complete valid frames only (schema versions, base/new
  revision, canonical committed transaction, checksum).
- **Crash recovery.** On open, the app offers to replay the journal over
  the last snapshot. Recovery scans to the last complete valid frame,
  replays through normal schemas/limits/invariants, and *reports rather
  than guesses* past a corrupt tail. Recovery starts a fresh bounded
  history; cross-restart undo is not promised.
- **Degraded durability.** If the journal cannot be appended (disk
  full, permissions), the app keeps editing in a degraded state with a
  clear warning and retries; a confirmed save still writes the full
  snapshot.

Evidence: `apps/headless` recovery trace and the release smoke
(`voxel-maker-recovery`, `voxel-maker-smoke`) exercise crash replay,
corrupt-tail reporting, compaction, save-as reassociation, and degraded
durability on every CI run.

## User guidance

1. **Save often.** A confirmed save compacts the journal and anchors
   recovery; unsaved edits since the last save live only in the journal.
2. **Keep external backups.** Copy `.vxl` files to another drive or
   backup service regularly; the format is self-contained, versioned,
   and byte-compatible across supported platforms.
3. **Before destructive operations** (delete, large region rewrites,
   experimental AI applies), use Save As to create a checkpoint copy.
   Every external export is non-lossy only for `.vxl`; exported `.vox`
   / glTF files are not backups of the document.
4. **After a crash**, choose recovery when offered. If the journal is
   corrupt at the tail, the app restores the last complete snapshot and
   reports the truncated tail rather than guessing.
5. **Recovery data is bounded** (frame caps, journal caps, ADR-0011) and
   cleaned up on confirmed save/close per the journal-cleanup policy.

## What is not a backup

- Exported `.vox` / `.gltf` / `.glb` files (lossy by design; see
  [format compatibility](./format-compatibility-v1.md)).
- The web build or installed application files.
- The recovery journal alone (it depends on the matching snapshot).
