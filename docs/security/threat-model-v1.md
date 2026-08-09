# Threat model v1

**Status:** v1 (issue #44, plan §11, S17.5/S17.6)
**Owners:** every package boundary listed below; the security gates in
`package.json` (`check:security`) and CI enforce the invariants.

This document is the single security reference for the editor. It names
every trust seam, the threats at each seam, the control that addresses
each threat (with the code or document that implements it), and the
residual risk. A change that touches a seam must update this document and
the matching adversarial suite; the release gate `check:security` fails
when an enforced invariant is not represented.

## Trust model

- **Trusted:** the user's local machine, the app itself, and code the
  repo builds from source. The desktop shell's Rust commands and the
  webview are trusted *code* but their inputs are not.
- **Untrusted:** everything that crosses a boundary — `.vxl`/`.vox`
  files, project metadata, filenames and paths from dialogs, journal and
  snapshot bytes, provider responses (text, tool calls, images), user
  prompts, clipboard content, generated glTF bytes, and any future
  network payload. Untrusted values are quoted data, never instructions
  (plan §11.2, §11.3).
- **Least privilege:** the webview cannot touch the filesystem, keychain,
  shell, or network directly; the Rust side exposes a minimal allowlist
  and re-validates every value; the agent loop has no shell, path, URL,
  or source-execution capability.

## Trust seams and controls

| # | Seam | Untrusted input | Threat | Control | Enforced by |
|---|---|---|---|---|---|
| 1 | Files — `.vxl` container | ZIP bytes from disk/network | Zip-bomb, entry explosion, path escape, offset overlap, integer overflow | `packages/formats/src/zip.ts`: entry-count, per-entry size, total-size, ratio, path, offset/overlap preflight before allocation (DEFAULT_ZIP_ARCHIVE_LIMITS, ADR-0009) | `zip.test.ts`, `adversarial.test.ts` (formats) |
| 2 | Files — MagicaVoxel `.vox` | Binary chunks | Chunk-count/nesting, model count, voxel count, axis bounds, color-index overflow, unknown-chunk flood, truncation | `packages/formats/src/vox.ts`: magic/version check, chunk budget, per-model and total voxel caps, axis ≤ 256, palette bounds, unknown-chunk byte cap | `vox.test.ts`, `adversarial.test.ts` (formats) |
| 3 | Files — container layout | `manifest.json`, volume binaries, previews | Entry-name spoofing, checksum mismatch, oversized document, preview abuse | `packages/formats/src/container.ts`: fixed entry names, per-entry checksums, document/volume/container limits applied before allocation; previews outside semantic hash | `container.test.ts`, `adversarial.test.ts` (formats) |
| 4 | Files — document JSON | `document.json` | Deep nesting, oversized arrays/strings, invalid ids, unbounded nodes/materials | `packages/model` `validateDocument` + `DEFAULT_DOCUMENT_LIMITS` (node/material/clip/metadata depth and size caps) | `store.test.ts`, `adversarial.test.ts` (commands) |
| 5 | Files — PNG previews | Encoded PNG bytes | Dimension/pixel bombs, malformed chunks | `packages/formats/src/png.ts`: bounded encode, 2048×2048 and 16 MiB decoded RGBA caps; the host image codec is the decoder, bounded by the same caps | `png.test.ts` |
| 6 | Paths | Native command `path` arguments | Arbitrary read/write, symlink tricks, relative-path escape, NUL injection | Rust `validate_path` in `apps/desktop/src-tauri/src/lib.rs`: absolute, non-empty, no NUL; paths come only from OS dialogs; scoped app-config dir for recent projects; no directory listing | `check-native-capabilities.mjs` |
| 7 | Links | Model output containing URLs | Accidental navigation/phishing, telemetry leak | No URL-fetch tool; agent tools accept structured domain args only; rendered AI text is display-only; CSP `connect-src ipc: http://ipc.localhost` and `frame-ancestors 'none'` in `tauri.conf.json` | `check-native-capabilities.mjs` |
| 8 | Credentials | Keychain service/account/value | Wildcard/oversized entries, secret leakage into logs | Rust `validate_keychain_scope` (service/account shape and length) and value ≤ 16 KiB; keys live only in the OS keychain; values never logged | `credentials.test.ts`, `check-native-capabilities.mjs` |
| 9 | Prompts | User prompt text | Prompt injection ("ignore prior instructions"), secret exfiltration via prompt | Prompts are quoted data; model instructions never override schemas/allowlists/budgets/revision checks (plan §11.3); system prompt is fixed and carries no project data; consent record precedes any transmission | `loop.test.ts`, `adversarial.test.ts` (agent) |
| 10 | Model output — text | Provider text deltas | Injection of display text (HTML/links), huge streams | Text is rendered as plain display content; stream byte cap and per-line cap in the OpenAI adapter; CSP blocks script/style injection; `maxOutputTokens` per request | `openai.test.ts`, `adversarial.test.ts` (agent) |
| 11 | Model output — tool calls | Provider tool-call JSON | Malformed schema, deep nesting, oversized arguments, unknown tool names, argument bombs | `validateToolCall` JSON-schema subset validation before execution; per-call argument accumulation cap; bounded JSON parse depth; tool allowlist is fixed | `schema.test.ts`, `adversarial.test.ts` (agent) |
| 12 | Images | Evidence/preview images | Consent bypass, unbounded transmission, retained content | Per-session `ImageTransmissionConsent` (provider, model, views, count, resolution, cost); ADR-0009 `maxImages`/`maxVisualIterations`; images never retained in transcripts (metadata only) | `image-consent.ts`, `transcript.ts`, `adversarial.test.ts` (agent) |
| 13 | Logs | Everything above | Secret/path/prompt leakage into logs or crash reports | `redact.ts` deterministic redaction (secrets, paths, URLs, provider payloads); no raw chunk payloads or full command args logged by default (plan §13); no telemetry in v1 | `types.test.ts`, `diagnostics.ts` |
| 14 | Updater | Update manifests/artifacts | Tampered update, rollback attack | No updater in v1 (manual installs only). When S17.10 adds one: signed manifests, pinned signatures, rollback instructions, and a threat-model review are mandatory before release | threat-model sign-off (S17.6) |
| 15 | Recovery data | Journal frames, snapshot bytes | Corrupt/forged tail replay, oversized frame, checksum mismatch, state corruption | `packages/storage`: frame byte caps, journal byte cap, checksums, length prefixes; recovery scans to the last complete valid frame and reports rather than guesses past a corrupt tail; replay through normal codecs/limits/invariants; snapshot compaction is write-then-rename | `journal.test.ts`, `snapshot.test.ts`, `adversarial.test.ts` (storage) |
| 16 | glTF export bytes | Generated bytes + validator responses | Malformed export, unbounded geometry | Deterministic bounded export; validation before emit; glTF *import* is not a v1 surface (plan §16) | `gltf.test.ts`, `gltf-mesh.test.ts` |
| 17 | Commands | Command JSON in journal/tool calls | Oversized payloads, command-count explosion, deep nesting, unknown types | `CommandLimits` (payload/envelope/history caps, ADR-0009); codec parses bounded envelopes and re-validates through the registry; metadata depth cap | `codec.test.ts`, `adversarial.test.ts` (commands) |
| 18 | Tool calls (agent) | Tool JSON | Budget abuse, repeated invalid calls, resource-expanding loops | Session `AgentBudgets` (rounds, tokens, tool calls, commands, voxels, tracks, keyframes, duration, cost, output bytes) with reserve-before-allocate ledger; consecutive-error cutoff terminates the run | `budgets.test.ts`, `adversarial.test.ts` (agent) |

## Resource-limit inventory (all hard defaults, ADR-0009)

| Domain | Limits | Location |
|---|---|---|
| ZIP archive | 4096 entries; per-entry ≤ 4 GiB format cap; total ≤ 4 GiB; ratio and path preflight | `packages/formats/src/zip.ts` |
| VOX parse | file bytes, chunk count, per-model voxels, total voxels, unknown-chunk bytes | `packages/formats/src/vox.ts` |
| Document | node/material/clip counts, metadata depth/size, coordinates, volume caps | `packages/model` limits; `packages/voxel` volume limits |
| Command | 1024 commands/transaction; 1 MiB payload; 16 MiB envelope; 512 history entries | `packages/commands/src/types.ts` |
| Journal | frame bytes, journal bytes | `packages/storage/src/journal.ts` |
| Agent session | 16 rounds, 64 tool calls, 1024 commands, 128k tokens, 600 s, $5, 4 MiB output, 12 images, 3 visual iterations | `packages/agent/src/agent/budgets.ts` |
| Inspection | 64 KiB response, 500 page, 32 hierarchy depth, 4096 ray steps | `packages/agent/src/limits.ts` |
| Provider stream | request timeout; stream byte cap; per-line cap; per-tool-call argument cap; tool-call count cap; malformed/deep JSON maps to structured errors; schema walker depth cap | `packages/agent/src/provider/openai.ts`, `packages/agent/src/schema.ts` |

## Hostile-input invariants

1. **Parse before allocate.** Every reader preflights counts, sizes, and
   offsets against its limit profile before bulk allocation (zip, vox,
   journal, document validation).
2. **Structured failure only.** Every parse surface throws stable
   `WorkspaceError` codes (families `validation`/`compatibility`/`limit`/
   `io`) or returns structured results; no raw `Error`, no partial
   mutation, no crash, no OOM on hostile input (proved by the adversarial
   suites).
3. **Validate twice where boundaries differ.** Tool JSON at the agent
   boundary, command semantic validity at the bus (plan §11.2); paths in
   the webview AND in Rust.
4. **Fail closed.** Conflicting AI base revisions fail closed; recovery
   stops at a corrupt tail and reports; a rejected transaction changes
   nothing (revision, history, journal, events unchanged).
5. **No dynamic execution.** No `eval`, no `new Function`, no dynamic
   module import, no shell command tool, no arbitrary URL fetch, no
   unrestricted filesystem tool — enforced by `check:security` source
   scan and by the capability allowlist check.
6. **No secret in logs.** Redaction happens at write time in every
   exporter (transcript, diagnostics); the keychain never logs values.

## Verification matrix

| Gate | Covers | Runs where |
|---|---|---|
| Fuzz/adversarial suites | seams 1–5, 11, 15, 17, 18 | `pnpm test` (per package) |
| `check-native-capabilities` | seams 6–8, 10; invariants 5 | `pnpm check:security`, CI |
| `check-licenses` / `check-audit` | supply chain | `pnpm check:security` / CI |
| `check-secrets` | checked-in secrets | `pnpm check:security`, CI |
| Diagnostics tests | seam 13 | `pnpm test` (agent) |

## Residual risk (accepted in v1)

- Provider-side retention of transmitted prompts/images is disclosed in
  the consent record (ADR-0010) and is not application-controlled.
- The webview is a large trusted-code surface; CSP and the native
  allowlist bound what it can reach, but a webview compromise could read
  the open document in memory (documented follow-up: out-of-process
  isolation review at release, S17.6).
- ZIP-slip-style path entries are rejected by the fixed container layout
  and path preflight; a future generic archive feature must reuse the
  same preflight.
- Symlink/hard-link attacks on project files depend on the OS dialog
  returning a canonical path; Rust rejects relative and NUL paths but
  does not yet resolve symlinks before write (documented follow-up with
  ADR-0011 native locking).
- No updater exists in v1; the updater seam becomes active only with the
  S17.10 signed-update work, which requires its own review.
