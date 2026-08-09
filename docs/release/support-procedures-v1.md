# Crash handling, diagnostics export, and support procedures v1

**Status:** v1 (issue #46, plan §13, S17.9/S17.15, ADR-0010)
**App version:** 0.1.0

## Crash handling

- **Durable state survives crashes.** Committed transactions are
  journaled; a crash before a confirmed save is recovered by replaying
  the journal over the last snapshot (see
  [backup and recovery](./backup-and-recovery-v1.md)).
- **Partial transactions never commit.** A transaction is all-or-nothing
  (ADR-0003); recovery replays committed transactions only.
- **The app never guesses past a corrupt journal tail** — it restores
  the last complete snapshot and reports the truncated tail.
- **Stale UI/render work is revision-tagged** and discarded; a device or
  worker failure resets projections from the document snapshot without
  touching semantic state.
- **Crash reports:** v1 has no automatic crash reporter (no telemetry).
  If the app crashes, use the recovery prompt on next launch, then
  export diagnostics (below) and report the issue with the diagnostics
  file attached.

## Diagnostics export

- **What exists in v1:**
  - `buildSessionDiagnostics` (agent package, tested in
    `diagnostics.test.ts`) builds the sanitized session report:
    provider/model identifiers, rounds, tool names, token usage, staged
    counts, duration, cost, structured error codes, revision hashes.
    No prompts, tool arguments, project content, paths, or secrets by
    default; prompts/tool arguments are an explicit opt-in and always
    pass deterministic redaction (secrets, bearer tokens, API keys,
    URLs, home/tmp paths → fixed marker `[REDACTED]`).
  - The renderer diagnostics overlay (dev mode) shows document
    revision/hash, dirty chunks, worker queue, renderer stats
    (`composition.renderer.diagnostics()`).
  - Recovery reports from the recovery flow (snapshot revision/hash,
    replayed frames, corrupt-tail reason) — see the recovery trace.
  - The release smoke prints a canonical JSON report of the full
    journey (`voxel-maker-smoke`).
- **Credentials** are never included: keys live only in the OS
  keychain.
- **No upload in v1**: diagnostics are local and locally previewable;
  there is no telemetry pipeline.
- **Known gap (tracked):** a dedicated user-facing "export diagnostics
  file" button in the desktop shell is not shipped in v1; support
  requests collect the report through the headless builders above until
  the shell export lands (follow-up).

## Support procedures (playbook)

### Triage

1. Ask for: app version (About panel), platform/OS version, WebGL 2
   status, and a redacted diagnostics export.
2. Reproduce with a minimal document; never ask for project files
   containing personal data unless strictly needed, and prefer the
   redacted diagnostics report.
3. Check the [known limitations](./known-limitations-v1.md) list and the
   [support matrix](./support-matrix-v1.md) tier before investigating
   performance claims.

### Data loss / recovery incidents

1. Do not overwrite the project file or its journal (no new saves in
   the same directory before copying).
2. Copy the `.vxl` file, the adjacent journal (if any), and the
   last-known-good backup.
3. Open the copy; if recovery is offered, choose it and export the
   recovery report.
4. Escalate with the recovery report and the copied files (checksums
   recorded).

### Security incidents

1. Suspected secret exposure: revoke/rotate the provider key, delete it
   in the app, and request a redacted diagnostics export.
2. Malformed file or AI payload suspicion: quarantine the file, capture
   the diagnostics export, and follow the threat-model update process
   (docs/security/threat-model-v1.md) before any fix ships.
3. No telemetry exists to leak; treat any claim of exfiltration as a
   provider-side or local-machine issue and respond accordingly.

### Update/rollback incidents

Follow [signing, updater, rollback](./signing-notarization-v1.md):
reinstall the previous verified artifact, restore project checkpoints,
rotate keys if needed.

### Escalation

- P0 (silent data loss, security boundary breach, non-atomic AI
  transaction): stop the release channel, apply the risk-register
  contingency (plan §15), and re-run all gates before resuming.
- P1: fix on the normal branch with a regression test at the highest
  practical seam, per AGENTS.md.

## Smoke-tested evidence

- `voxel-maker-smoke` (release smoke) exercises create/edit/rig/animate/
  save/recover/import/export/AI-offline and the sanitized diagnostics
  report (including prompt opt-in redaction) end to end on every check
  run.
- `voxel-maker-recovery` exercises crash replay, corrupt-tail reporting,
  compaction, save-as, degraded durability.
- Desktop tests cover the recovery prompt and dirty-close flows
  (`project-lifecycle-v1.md`), and the AI panel's unconfigured/offline
  degradation (`ai-panel-v1.md`).
