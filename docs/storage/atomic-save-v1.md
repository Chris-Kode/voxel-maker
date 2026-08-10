# Version 1 atomic save contract

This document freezes the atomic project-save protocol implemented by
`@voxel-maker/storage` (plan S5.6/S5.7/S5.14, ADR-0004, ticket #13). It is the
runtime counterpart of the `.vxl` container format: the container defines the
bytes, this contract defines how those bytes become durable without ever
corrupting the last-known-good project.

## Scope and guarantees

A save captures an immutable revision snapshot `(revision R, semantic hash
H_R)` from the open `DocumentStore` and writes it asynchronously. Later edits
proceed on the live store; the writer retains the captured document and
copy-on-write volume read views, so the bytes on disk always describe exactly
one committed revision. Completion records `R` as the durable snapshot and
marks the project clean only when the live semantic hash still equals the
captured `H_R` — a stale completion can never clear dirty state, and a hash is
never compared with a revision.

## Storage port

`ProjectStoragePort` (plan S5.6 `RecoveryStoragePort` / file service) is the
adapter seam. Packages never touch filesystem APIs; the composition root
supplies an adapter (memory in `@voxel-maker/storage`, Node filesystem in the
headless app, Tauri in the desktop app). The port owns external effects only:
`readProject`, `writeProjectAtomic`, `exists`, `remove`, and `readBackup`.
It never parses or validates container bytes.

### Atomic write phases

One `writeProjectAtomic(path, bytes)` call runs these phases in order:

```text
create-temp -> write-temp -> flush-temp -> backup -> replace -> sync-directory
```

- `create-temp` opens a hidden same-directory temporary file
  `.<basename>.<nonce>.tmp` with exclusive creation. Same-directory output
  guarantees the final rename never crosses a filesystem boundary.
- `write-temp` streams the bytes (in chunks so cancellation can interrupt
  large saves).
- `flush-temp` fsyncs the temporary file where the platform supports it.
- `backup` copies the previous destination to the adjacent last-known-good
  path `<path>.bak` (ADR-0011 naming convention). The backup refresh is
  itself atomic: the copy lands in a same-directory temporary file that is
  renamed over the previous backup, so a mid-copy failure never truncates
  the last-known-good backup. The first save creates no backup; after a
  successful save the backup holds the previous destination.
- `replace` atomically renames the temporary file over the destination.
- `sync-directory` fsyncs the parent directory on a best-effort basis. A
  failure here never fails the save; `directorySyncSucceeded` reports it.

Any failure at or before the `backup` phase leaves destination and backup
byte-identical to before the call and removes every temporary file. A
failure at `replace` leaves the previous destination in place; the backup
has already been refreshed to that same destination at that point. The
destination is never missing or truncated at any point.

### Fault injection and error codes

Adapters accept an `AtomicWriteFaultPlan` (`failAt` per phase) so memory and
Node implementations exercise identical failures. Disk-full, permissions,
rename, interruption, and stale-completion failures are part of the shared
conformance matrix (`storagePortConformanceCases`) run against both adapters.
Stable `io`-family error codes:

| Code | Meaning |
|---|---|
| `IO_NOT_FOUND` | Read or backup of a missing file |
| `IO_DISK_FULL` | Temporary write/flush failed (ENOSPC/EIO) |
| `IO_PERMISSION_DENIED` | Temp creation or backup failed (EACCES/EPERM) |
| `IO_RENAME_FAILED` | Atomic replace failed |
| `IO_WRITE_INTERRUPTED` | The write was aborted via `AbortSignal`/cancel |
| `IO_WRITE_FAILED` | Any other write failure |
| `IO_SYNC_FAILED` | Directory sync failure (reported, never thrown) |

## Save coordinator

`SaveCoordinator` serializes saves for one open document:

- `capture()` freezes the immutable `(R, H_R)` snapshot.
- `save(path)` captures the current state and writes it asynchronously.
  Writes never overlap: one write runs at a time and later requests queue in
  order. Re-saving an already-durable state at the same path resolves
  `unchanged` without touching the port.
- Completion records `R` as the durable snapshot and emits
  `save-completed { stale }`; the project stays dirty when live state moved
  past the captured snapshot.
- `cancel()` interrupts the in-flight write at the next phase boundary and
  rejects queued requests with `IO_WRITE_INTERRUPTED`. An abort observed
  before the atomic replace leaves destination and backup untouched; if the
  replace already committed, the save completes normally. `dispose()`
  cancels, rejects queued requests, and stops observing the store.

### Shared snapshot-write gate

Saves are not the only snapshot replacements for a project path: journal
compaction (`RecoveryJournal.compact()`, recovery-journal contract) also
installs a replacement snapshot, and save-as reassociation copies the
snapshot to the new path. Without a shared owner, a save captured at an
older revision can finish after compaction installed a newer snapshot and
overwrite it, leaving a stale snapshot beside a newer journal anchor that
recovery rejects (ticket #51).

The composition root therefore creates one `SnapshotWriteGate` per open
document and passes the same instance to both `SaveCoordinator` and
`RecoveryJournal`:

- **Serialization per path**: one atomic write runs per path at a time and
  later requests queue in submission order, so an older captured revision
  can never finish last and regress the durable snapshot.
- **Stale-write fencing**: a queued write whose revision is strictly older
  than the snapshot already installed at that path is skipped with
  `superseded` instead of touching the port; a superseded save still
  resolves `saved` because the captured state is durably covered by the
  newer snapshot.
- `dispose()` rejects queued writes; an in-flight write completes normally
  (a resolved port write means the replace committed).

The gate owns no semantic state: it never parses or validates bytes and
never decides which revision is correct; it only orders and fences
replacements for a path.
- Dirty state is runtime projection: the project is dirty exactly when the
  live semantic hash differs from the hash of the last completed save. It is
  never persisted and never part of semantic identity. Because the document
  revision is part of the ADR-0004 semantic identity, any committed
  transaction since the last completed save keeps the project dirty — even an
  undo that restores the saved voxel content — until the next completed save.

## Adapters

- `MemoryProjectStorage` (in `@voxel-maker/storage`): deterministic in-memory
  adapter used by tests, the conformance matrix, and headless demos.
- `NodeProjectStorage` (in the headless app): real same-directory temp +
  fsync + rename + backup implementation with fault injection and
  cancellation; the M1 test adapter that keeps the milestone Tauri-free.
- Desktop: a Tauri adapter supplies the same port at the composition root
  (plan S6.18) with Rust-validated scoped paths and error parity.
