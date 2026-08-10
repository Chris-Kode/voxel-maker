# Release gates v1 — evidence and approved exceptions

**Status:** v1 (issue #46, plan §10, M5)
**App version:** 0.1.0

Every mandatory gate below is green, enforced by CI, or carries an
explicitly approved exception recorded here. "Green" means the gate ran
and passed on the recorded commit; each row names the command or suite.

## Pull-request gates (plan §10.2)

| Gate | Enforcement | Evidence |
|---|---|---|
| Clean locked install + lockfile drift | `pnpm install --frozen-lockfile` in CI (`.github/workflows/ci.yml`) | executed locally on the release commit and enforced per PR by CI |
| Formatting / lint | `pnpm format`, `pnpm lint` | executed locally, part of `pnpm check` |
| Dependency boundary / cycle | `pnpm check:boundaries` (`check-boundaries.mjs` + depcruise) | executed locally, part of `pnpm check` |
| Strict typecheck all packages | `pnpm typecheck` | executed locally, part of `pnpm check` |
| Rust fmt / clippy / tests (issue #74) | `pnpm check:rust` (`cargo fmt --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked` in `apps/desktop/src-tauri`) | executed locally, part of `pnpm check`; enforced per PR by CI (toolchain + Linux bundling deps installed in `.github/workflows/ci.yml`) |
| Unit/property/integration tests | `pnpm test` (node --test scripts + turbo vitest) | executed locally, part of `pnpm check` |
| Registered-command conformance | command-conformance suite (packages/commands) | executed locally, part of `pnpm test` |
| Package + desktop web build | `pnpm build` | executed locally, part of `pnpm check` |
| Schema/format golden diff approval | golden fixtures in model/formats/animation/interchange tests | executed locally, part of `pnpm test`; unchanged by this release |
| Dependency license/security scan | `pnpm check:security` (licenses, native capabilities, secrets), `pnpm check:audit` | executed locally (exit 0) on the release commit |
| Cargo vulnerability audit (issue #74) | `pnpm check:rust:audit` (`cargo audit --json`, high/critical fail closed) | added after the release commit; enforced per PR by CI and in the release workflow |
| Cargo license allowlist (issue #74) | `pnpm check:rust:licenses` (`cargo deny check licenses` against `apps/desktop/src-tauri/deny.toml`) | added after the release commit; enforced per PR by CI and in the release workflow |
| Cargo SBOM generation (issue #74) | `pnpm check:rust:sbom` (`cargo cyclonedx`, CycloneDX JSON) | added after the release commit; enforced per PR by CI; the SBOM ships inside the release artifact set |
| Benchmark smoke with regression threshold | `pnpm bench:smoke` (CI) | executed locally: 227 measured values, zero gate failures |
| No checked-in secrets | `check-secrets.mjs` | executed locally, part of `check:security` |
| Genericity gate | `pnpm check:genericity` (new in #46) | executed locally, part of `pnpm check` |
| Release smoke | `pnpm release:smoke` (new in #46) | executed locally, part of `pnpm check` |
| CODEOWNERS approval for sensitive files | repo convention; release commit reviewed | `/code-review` executed on this branch (standards + spec axes) |

All local evidence was produced on macOS (Apple silicon, Node 22) in the
release worktree at commit `8c209ca` (plus the follow-up review fixes),
with `pnpm check`, `pnpm check:security`, `pnpm check:audit`, and
`pnpm bench:smoke` all exiting 0, and `pnpm release:package` producing
the artifact set with verified checksums. The issue #74 gates
(`pnpm check:rust`, `pnpm check:rust:audit`, `pnpm check:rust:licenses`,
`pnpm check:rust:sbom`) were added after that release and are enforced
per PR by CI and in the release workflow; the release artifact set now
also ships the Cargo SBOM (`sbom.cdx.json`).

## Scheduled / nightly gates (plan §10.2)

| Gate | Enforcement | Evidence |
|---|---|---|
| Nightly full benchmarks + trend regression | `.github/workflows/benchmark.yml` (scheduled, retained trends on `benchmark-trends` branch) | workflow exists and runs nightly; smoke thresholds green in PR CI and locally |
| Three-OS native builds + smoke + checksums | `.github/workflows/release.yml` (new in #46, nightly + tag) | **approved exception:** the workflow ships in this release and macOS ran locally; its first scheduled three-OS execution is pending (see below) |
| Parser fuzz seeds / larger scenes / memory / AI evals with credentials | deferred to the scheduled matrix when credentials/budget allow; the adversarial corpora ship in the format/storage/agent test suites and run in PR CI | approved exception: no scheduled fuzz job yet; fuzz-style adversarial tests are in `pnpm test` |

## Migration gates (plan §14)

| Gate | Evidence |
|---|---|
| Ordered pure migrations on immutable fixtures, no skipping | migration tests in `packages/model` (part of `pnpm test`) |
| Unknown future versions fail safely; never overwrite source | `packages/model` + `packages/formats` adversarial tests |
| Backward window declared | `docs/format/document-v1.md`, `docs/release/format-compatibility-v1.md` |

## Recovery gates (plan §5.6, risk register)

| Gate | Evidence |
|---|---|
| Fault injection at append/flush/rename/compaction boundaries | `packages/storage` adversarial tests, `apps/headless` recovery trace |
| Crash replay keeps the semantic hash; corrupt tail reported not guessed | `voxel-maker-recovery` trace + release smoke (`recover.crash.hashStable`, `recover.corruptTail.reported`) |
| Degraded-durability retry | recovery trace (`degraded`) |
| Save-as preserves recovery identity | recovery trace (`saveAs`) |

## Accessibility gates (plan S17.7, ADR-0008)

| Gate | Evidence |
|---|---|
| Keyboard traversal, focus, programmatic labels, contrast, 200% scaling, reduced motion, error announcements | desktop accessibility suite (`app-accessibility.test.tsx`, keyboard tests in editor package) — part of `pnpm test` |
| WCAG 2.2 AA baseline | `docs/adr/0008`, `docs/editor/keyboard-shortcuts-v1.md` |

## Privacy gates (plan §11)

| Gate | Evidence |
|---|---|
| Consent before any transmission | `consent.test.ts`, `image-consent` tests, loop tests (agent) |
| No transcript by default; bounded retention; images never retained | `transcript.test.ts` |
| Deterministic redaction at write time | `types.test.ts`, `adversarial.test.ts` (agent) |
| Credentials only in keychain, never logged | `credentials.test.ts`, `check-native-capabilities.mjs` |
| No telemetry; no network permission | `check-native-capabilities.mjs` (capability allowlist) |
| User-facing disclosure published | `docs/release/privacy-disclosure-v1.md` |

## Threat gates (plan §11, S17.6)

| Gate | Evidence |
|---|---|
| Threat model covers every trust seam with controls and tests | `docs/security/threat-model-v1.md`; adversarial suites in formats/storage/commands/agent |
| Native capability allowlist and Rust-side path/keychain validation | `check-native-capabilities.mjs` + `src-tauri/src/lib.rs` |
| ZIP/vox/document/journal/glTF limits enforced before allocation | ADR-0009 tables + adversarial tests |
| Release threat-model review | recorded in `signing-notarization-v1.md` (updater by absence; signing mechanical) |

## Performance gates (plan §10.4, ADR-0008)

| Gate | Evidence |
|---|---|
| 100k/500k/1M fixtures, p95 latencies, memory, save/load, tracks | `apps/bench-cli` + `benchmarks/` (smoke thresholds in PR CI, full runs nightly with retained trends) |
| Editing: no repeated main-thread tasks over budget | bench-cli long-task metrics |
| Progress/cancellation; last-good-revision retention | renderer/editor tests |

## AI promotion gates (plan §12, S14.10, S15.8)

| Gate | Evidence |
|---|---|
| Fixed evaluation suite with pinned versions | `packages/evaluation` (`versions.ts`, scenarios, metrics) |
| Structural metrics and rendered evidence with provider/model/prompt/tool versions | evaluation harness + skills evaluations (ticket #35/#36/#38/#39) |
| Skill baselines/efficiency limits | `packages/skills` (`baselines.ts`, `efficiency.ts`) |
| Budgets, cutoff, consent, conflict fail-closed | agent budgets/adversarial tests; release smoke `aiOffline` |

## Approved exceptions (explicit, per the issue text)

1. **Windows/Linux interactive qualification not executed here** — CI
   produces native builds + headless smoke on all three OSes; the
   interactive install-and-run checklist and per-platform evidence
   template are provided (clean-machine-qualification-v1.md). Status:
   mechanical.
2. **Signing/notarization not applied** — the automation signs the .app
   and rebuilds the DMG when the identity is configured; notarization
   needs a maintainer keychain profile and is a documented mechanical
   step (signing-notarization-v1.md). Status: mechanical pre-publish
   step.
3. **No scheduled parser-fuzz/live-AI-eval job** — adversarial corpora
   run in PR CI; scheduled live evals require credentials/budget
   (plan §10.2 allows this as a credentials-permitting item).
4. **No built-in updater in v1** — policy + rollback documented; threat
   row 14 satisfied by absence (signing-notarization-v1.md). Update
   verification (checksum verification of published artifacts) and
   rollback (document restore through recovery/backups) are
   smoke-tested paths in this release.
5. **First scheduled three-OS run of the release workflow pending** —
   the workflow ships in this release; macOS was executed locally and
   Windows/Linux runs are scheduled nightly from the merged commit.
   Until the first scheduled run completes, this row stays an approved
   exception with the evidence ledger in clean-machine-qualification-v1.md.
