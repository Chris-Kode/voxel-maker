# Version 1 recovery journal contract

This document freezes the crash-recovery protocol implemented by
`@voxel-maker/storage` (plan S5.6/S5.9/S5.10/S5.15, ADR-0003/ADR-0004,
ticket #14). It is the runtime counterpart of the `.vxl` container and the
atomic-save contract: the container defines the bytes, atomic save defines
how those bytes become durable, and this contract defines how committed
work that is not yet in a durable snapshot survives a process or machine
failure.

## Scope and guarantees

A per-project recovery area sits beside the project file:

```text
project.vxl            durable snapshot at revision R (the saved project)
project.vxl.journal    ordered append-only journal of revision transitions
project.vxl.bak        last-known-good backup (atomic-save contract)
```

Recovery data is never appended inside the ZIP container. A stable
`RecoverySessionId` exists even for unsaved projects and is reassociated
intentionally on Save As/rename.

Semantic commit always precedes durable recovery I/O. An ordered writer
appends checksummed frames and tracks `lastJournaledRevision`. If an append
fails, the in-memory edit remains valid and dirty, durability is exposed as
degraded, and retry or snapshot work is scheduled; a revision is never
claimed journaled until its frame is confirmed.

## Journal file layout

The journal is a sequence of length-prefixed frames:

```text
journal := header-frame | frame*
frame   := u32le payloadLength | payload
payload := canonical JSON (RFC 8785) with a CRC-32 field
```

The header frame carries the format version, the `RecoverySessionId`, the
container/document/command schema versions, and the base anchor: the
revision `R` and semantic hash `H_R` of the durable snapshot the journal
extends. Every revision-transition frame carries the same identity and
schema versions, the revision before/after, the canonical committed
transaction as an opaque JSON payload (produced by the command codec in
`@voxel-maker/commands`, plan S4.14), and a CRC-32 over every other payload
byte. CRC-32 detects journal corruption; it is never semantic identity.

Appends are ordered and flushed (fsync where supported) before they
resolve. A failed append may leave a partial frame at the tail; the writer
repairs that tail before retrying, and recovery never guesses past an
incomplete frame.

## Writer semantics (`RecoveryJournal`)

- `journal(input)` enqueues one committed transaction frame. Appends never
  overlap and run in call order; `lastJournaledRevision()` reports the last
  revision whose frame is confirmed.
- A failed append rejects the caller, keeps the request queued, emits
  `append-failed`, and enters degraded durability. `retry()` re-attempts
  the queued frame (after repairing any partial tail); the next `journal()`
  call also re-attempts it first. A limit failure (frame or journal byte
  bound) is never retried: the edit stays valid and dirty and the caller
  decides.
- Journal overflow schedules snapshot work: `compact()` durably installs a
  replacement snapshot, then resets the journal anchor to the captured
  revision/hash and removes covered frames. Compaction order is fixed:
  the replacement snapshot is durable before old journal data is removed,
  so a crash between the two steps still recovers. Snapshot replacements
  route through the document's shared `SnapshotWriteGate` (atomic-save
  contract, ticket #51): compaction is serialized and revision-fenced
  against manual/autosaves, so a save captured at an older revision can
  never overwrite a newer compacted snapshot and leave snapshot 0 beside
  header 1. When a compaction snapshot write is superseded (a strictly
  newer snapshot is already durable at the path), the anchor reset still
  runs: recovery treats a snapshot newer than the anchor as a confirmed
  save and skips covered frames.
- `resetBase(revision, hash)` rewrites the journal anchored at a newly
  confirmed snapshot, keeping only frames beyond that revision
  (confirmed-save cleanup policy below).
- `reassociate(newPath)` moves the recovery area to a new path, preserving
  the `RecoverySessionId` (Save As reassociation).

### Confirmed-save/close cleanup policy

After a confirmed save at the session path, the snapshot covers every
journaled frame up to the saved revision: the session resets the journal
anchor to `(R_saved, H_R_saved)` and drops covered frames. On close, the
journal file is retained so the next open can recover edits that were
journaled but never saved; a final confirmed save leaves a header-only
journal. A crash between the atomic snapshot write and the anchor reset
leaves the older journal in place; recovery skips frames the newer
snapshot already covers and replays only what is still missing.

## Recovery semantics (`recoverProject`)

Recovery loads the durable snapshot (full container validation, including
the semantic hash), scans the journal to the last complete valid frame, and
replays each frame through normal command decoding, migrations, limits, and
invariants:

1. The journal header must carry the expected `RecoverySessionId` and the
   supported container/document/command schema versions; anything else is
   reported as incompatible and nothing is replayed.
2. When the journal anchor revision equals the snapshot revision, the
   anchor hash must equal the snapshot's semantic hash (matching snapshot
   identity). A snapshot newer than the anchor means a confirmed save
   happened; its hash is not compared, and covered frames are skipped
   individually.
3. Frames whose `revisionAfter` is already covered by the snapshot are
   skipped. Every other frame must chain exactly (`revisionBefore` equals
   the current replay revision); a gap is reported, never bridged.
4. Each frame's transaction is parsed by the journal-safe command codec
   and executed through a fresh `CommandBus` with the frame's own
   transaction metadata. A frame that fails parsing, validation, or
   invariants is reported as a corrupt tail; replay stops there.
5. A byte-level corrupt or incomplete frame (bad checksum, huge length,
   truncated payload, invalid JSON, non-contiguous revisions) is reported
   as a corrupt tail; the complete valid frames before it are replayed and
   nothing past it is guessed.

The recovered document is installed into a fresh store through validated
lifecycle replacement and begins a fresh bounded user history (v1 promises
no cross-restart undo before the journal; the replayed frames form the
first entries of that fresh history and remain undoable within the
session). Recovery never resets the journal: the replayed frames stay on
disk, and a second crash before the next save recovers the same state by
replaying them again.

## Adapters

- `MemoryProjectStorage` (in `@voxel-maker/storage`): deterministic
  in-memory journal with the same append/replace/remove semantics.
- `NodeProjectStorage` (in the headless app): real append + fsync,
  same-directory temporary + rename for atomic journal replacement; the M1
  test adapter.
- Desktop: a Tauri adapter supplies the same port at the composition root
  (plan S6.18).
