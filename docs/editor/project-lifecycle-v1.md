# Project lifecycle workflows (v1)

**Plan:** S7.16 / S5.15 / S5.8 / S6.18 — save/open/recent/recovery UI; lifecycle
coordinator; autosave; scoped native storage.
**Ticket:** #22 — Complete desktop project lifecycle workflows.
**Status:** accepted (implementation baseline).

## Contract

The desktop shell's project workflow lives behind the composition root
(`apps/desktop/src/file-service.ts`) and is the ONLY desktop code that
drives new, open, save, save-as, recent-project, replace, close, and
recovery. It never mutates semantic state directly: new/open/replace/close
install fully validated aggregates through `DocumentSession` (ADR-0002),
edits flow through the session's command bus, and the per-document save
coordinator, recovery journal, and autosave binding are disposed and
rebound on every lifecycle replacement.

The workflow is constructed with injected adapters so the same logic runs
in Node tests, the plain browser dev build, and the Tauri product shell:

- `ProjectStoragePort & RecoveryJournalPort` — scoped native project file
  + adjacent recovery journal (memory, browser, and Tauri adapters).
- `FilePicker` — native open/save dialogs.
- `PromptService` — user confirmations (dirty-close, overwrite, recovery
  choice); the shell supplies `window.confirm`, tests script answers.
- `RecentProjectsPort` — bounded most-recent-first list (memory,
  localStorage, or the app-config-dir JSON file through Tauri commands).
- `busHooks` — the session applies the composition's `onCommitted` hook to
  every fresh bus; the workflow points it at the current document's
  journal, which is how committed transactions are journaled without
  giving the journal any write authority over the store.

## Workflow semantics

1. **New.** Installs a fresh blank document through the session (a new
   project is voxel-less; shape tools explain the no-op). Prompts before
   discarding a dirty document. The project has no path until the first
   save.
2. **Open.** Picks a path, prompts before replacing a dirty document, then
   reads the project file and checks the adjacent journal. A journal with
   replayable frames prompts the recovery choice (apply / discard); an
   incompatible or damaged journal is reported and reset to the loaded
   anchor. Opens install the loaded snapshot at `(revision R, hash H_R)`:
   the save coordinator starts clean (the snapshot is already durable),
   so an unchanged project never triggers an immediate write.
3. **Save.** Saves through the serialized save coordinator (immutable
   `(R, H_R)` snapshot isolation, plan S5.14). A same-path save of an
   unchanged opened project is the documented `unchanged` short-circuit.
   A confirmed save compacts the journal to the new anchor (confirmed-save
   cleanup policy, plan 5.6).
4. **Save As.** Picks a destination with overwrite confirmation, moves the
   recovery area first (reassociate: at every crash point at least one
   path keeps a recoverable combination), then writes the current state
   over it. The recovery session id is preserved across save-as
   (plan S5.15 reassociation).
5. **Recent projects.** Successful opens and saves record the path; the
   list is bounded (10), most-recent-first, and opened through the normal
   open/recovery flow.
6. **Close.** Prompts before discarding a dirty document; closing emits
   `document-closed` and unbinds the save coordinator, journal, and
   autosave.
7. **Recovery.** Applying a journal replays complete valid frames through
   normal command decoding, limits, and invariants and installs the
   recovered aggregate with source `recovery`; the recovered document is
   dirty (the journaled edits are not on disk) and starts a fresh bounded
   user history. A corrupt tail is reported honestly, never guessed past.
   Declining recovery removes the journal; a crash can then only restore
   the durable snapshot.

## Data-safety feedback

Every state below is exposed on `FileServiceStatus` and rendered by the
shell chrome, so the user can act on it:

| State | Meaning | Action |
| --- | --- | --- |
| `dirty` | Live hash differs from the last confirmed save | Save or discard via prompt |
| `saving` / `autosaving` | A project write is in flight | Cancel button replaces Save |
| `progress` | Atomic-write phase of the in-flight save (`create-temp` … `sync-directory`) | Rendered next to the saving indicator; adapters that cannot observe phases (Tauri IPC) leave it unset |
| `lastSaveStale` | The last completed save captured stale state | Save again; the stale flag clears on the next clean completion |
| `degraded` | Journal appends fail or journaling is paused | Notice; retry happens on the next commit |

Failures are structured `WorkspaceError`s surfaced through the action
result and a dismissible notice. Cancellation (`cancelSave`) interrupts
the in-flight write at the next phase boundary and never undoes a
committed rename. In the Tauri shell, closing the OS window routes
through the same dirty-close prompt (`apps/desktop/src/close-request.ts`):
a clean project closes immediately, a dirty project prompts first and the
window is destroyed only on confirmation.

## Autosave

Each open document owns one debounced autosave binding (default 2000 ms;
tests lower it). The binding watches the save coordinator's dirty
transitions: a dirty project with a path schedules one snapshot save, a
save already in flight or a pending timer suppresses new timers, failures
surface as warnings with one bounded retry, and lifecycle replacement
disposes the binding — a debounced write can never straddle two documents.

## Journal wiring

The composition installs one `onCommitted` bus hook that stays connected
for the workflow's lifetime and forwards every committed record to the
current document's journal (buffering a bounded recent window). The
buffer makes an unsaved project's first save honest under stale
completion: edits that land while the first write is in flight are
backfilled onto the journal anchored at the SAVED outcome, so they are
recoverable instead of being claimed durable (plan S5.14). Lifecycle
replacement clears the buffer and the journal binding.

## Failure policy

| Failure | Result |
| --- | --- |
| Missing project file | `IO_NOT_FOUND`; nothing installed |
| Corrupt project file | structured `readVxlProject` error; nothing installed |
| Save write failure | error result + notice; dirty state stays |
| Edit during save | `save-completed` with `stale: true`; dirty state stays |
| Journal append failure | degraded durability notice; retry on next commit |
| Cancel during save | `IO_WRITE_INTERRUPTED`; destination untouched |
| Declined dirty-close/overwrite/recovery | action returns `undefined`; state unchanged |
| Journal incompatible/damaged | reported + reset to the loaded anchor |
| `markDurable` after open | clean start; no write until the first real change |
