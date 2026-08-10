# Privacy, consent, retention, and diagnostics policy v1

**Status:** v1 (issue #44, plan §11.3/§13, ADR-0010, S17.9)
**Owners:** agent package (consent/redaction/transcript/diagnostics),
desktop shell (keychain, consent UI), storage (journal retention).

This policy is the approved consent, retention, redaction, and
diagnostic-export contract for secrets, prompts, transcripts, project
contents, and images. Every claim below has a test or a gate.

## Consent (ADR-0010)

- **Local-first.** Every manual workflow — create, open, edit, undo, rig,
  animate, save, recover, import, preview, export — works with no
  account, no credential, no network, and no consent (ARCHITECTURE.md).
- **Cloud use is explicit.** A session transmits nothing to a provider
  until the user confirms a `ProviderConsent` record naming the provider,
  model, and what will be sent (plan §11.2, `provider/consent.ts`).
- **Images are separately opt-in.** Visual refinement transmits evidence
  images only under an `ImageTransmissionConsent` record naming provider,
  model, views, image count, maximum resolution, and estimated cost
  (`vision/image-consent.ts`; ADR-0009 caps: 12 images, 3 iterations,
  2048×2048 / 16 MiB each). Images are off by default.
- **Provider-side retention** is disclosed in the consent record, never
  represented as application-controlled.
- **No telemetry** in v1; diagnostics are local and locally previewable.

## Retention

- **No transcript by default.** The agent retains nothing unless the
  user opts in per session (`agent/transcript.ts`, ticket #33).
- **Bounded lifetime.** An opted-in transcript expires after a
  user-selected 1, 7, or 30 days (`RetentionDays`); `expiresAt` is part
  of the snapshot.
- **Images are never retained.** Transcripts keep only bounded metadata
  (view, dimensions, revision, source), never image bytes.
- **Recovery data** is retained only as the bounded per-project journal
  (frame caps, journal caps, ADR-0011) and is removed by the documented
  journal-cleanup policy on confirmed save/close.
- **Credentials** are stored only in the OS keychain, scoped to the fixed
  `voxel-maker:provider` service and allowlisted provider accounts (the
  keychain IPC never accepts a service and rejects accounts outside the
  allowlist), never in project files or logs.

## Redaction

- **Deterministic, at write time.** `provider/redact.ts` replaces
  secrets, bearer tokens, API keys, URLs, home/`/tmp` paths, and
  credential-named keys with the fixed marker `[REDACTED]` before
  anything is written or exported. Redaction is pure, so every consumer
  (transcript, diagnostics, provider errors) redacts identically.
- **Provider errors** expose structured remediation without stack traces
  or secrets (`ProviderError` normalization in `provider/types.ts`).
- **Logs never carry** raw chunk payloads, full command arguments,
  prompts, provider payloads, or private paths by default (plan §13);
  there is no telemetry pipeline in v1 to leak them.

## Diagnostic export

- **Default: sanitized.** `agent/diagnostics.ts` builds a session report
  from the bounded run record: provider/model identifiers, rounds, tool
  calls, token usage, staged counts, duration, estimated cost, structured
  error codes, and revision hashes. It never contains prompts, tool
  arguments, project content, paths, or secrets by default.
- **Opt-in prompts.** A caller may request prompt/tool-argument inclusion
  (`includePrompts`); every string is passed through `redactJson` with
  the session's explicit secret list, so retained content still never
  contains a credential or private path. The flag is a product policy
  decision per export, never a default.
- **Local preview.** Diagnostics are intended to be previewable on the
  device before any export; there is no automatic upload in v1.
- **Images** are represented by metadata only (count, views, bytes),
  never by bytes.

## Enforcement summary

| Claim | Evidence |
|---|---|
| Consent before any transmission | `consent.test.ts`, `image-consent` tests, loop tests |
| No transcript by default; bounded retention | `transcript.test.ts` |
| Images never retained | `transcript.test.ts` |
| Redaction is deterministic and secret-safe | `types.test.ts`, `adversarial.test.ts` (agent) |
| Diagnostics sanitized by default, redacted when opted in | `diagnostics.test.ts` |
| Credentials only in keychain, scoped | `lib.rs` keychain-scope tests, `credentials.test.ts`, `check-native-capabilities.mjs` |
| No telemetry | `check-native-capabilities.mjs` (no network permission), threat model |
