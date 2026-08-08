# AGENTS.md

Instructions for every coding agent working in this repository.

## Start here

Before designing, implementing, or reviewing a change:

1. Read [`ARCHITECTURE.md`](./ARCHITECTURE.md). Apply every invariant and dependency rule relevant to the change.
2. Read the assigned GitHub issue, its comments, parent specification, and native blockers. Start implementation only when all blockers are closed.
3. Read the relevant sections of [`plan.md`](./plan.md) for detailed semantics, stage gates, formats, limits, and acceptance evidence. Treat the issue as the scope and the plan as supporting detail.
4. Read `CONTEXT.md` or `CONTEXT-MAP.md` and relevant ADRs when they exist. Use the glossary's terms exactly. An approved ADR may change an architectural decision only when the same change updates `ARCHITECTURE.md`.
5. Inspect the current implementation and tests. Preserve unrelated user changes and established local conventions.

Completion criterion: you can name the user-visible behavior, the highest test seam, the affected architectural owners, and every applicable invariant before editing code.

## Work in vertical slices

- Deliver the assigned ticket's end-to-end behavior. Keep schema, core behavior, adapters, UI, and tests in one coherent slice when they are relevant.
- Keep the issue's acceptance criteria observable. Do not substitute a horizontal layer, scaffold, or speculative abstraction for the requested behavior.
- Prefer the highest existing seam. Add a seam only when behavior genuinely varies; two adapters make a seam real.
- Design deep modules: small interfaces that hide substantial behavior. Accept dependencies at the composition root and return explicit results.
- Prefactor only when it makes the requested change safer or smaller. Keep the workspace green after each independently reviewable step.
- Keep scope within the assigned issue. Record follow-up work instead of quietly implementing adjacent roadmap items.

## Implementation rules

- Route every persistent edit to an open document through the command bus. Route whole-document replacement through the lifecycle coordinator after full validation.
- Keep the semantic core deterministic and executable in Node. Supply IDs, time, random seeds, and platform-sensitive intent before command execution.
- Keep the core generic. Asset-category knowledge belongs in skills and generators, not document types, commands, rigging, or animation primitives.
- Treat rendering, UI state, playback, worker jobs, previews, and agent scratch data as projections or runtime state rather than persisted asset state.
- Put platform, filesystem, renderer, worker, archive-library, and model-provider behavior behind adapters at the seams defined in `ARCHITECTURE.md`.
- Parse and bound every untrusted value before allocation or mutation. Return structured, stable, user-safe errors.
- Use strict types, branded identifiers, exhaustive discriminated unions, immutable read views, and package exports. Avoid unsafe casts, mutable backing-store leaks, deep cross-package imports, and hidden global state.
- Comment decisions and non-obvious invariants, not line-by-line mechanics. Update public documentation when an interface or compatibility promise changes.

## Testing rules

- Test external behavior through the module interface. Assert results, errors, snapshots, revisions, events, hashes, durable artifacts, or user-visible workflows—not private call order or data structures.
- Every bug fix starts with a failing regression test at the highest practical seam.
- Every persistent command participates in the shared command-conformance suite.
- Use fixed IDs, seeds, clocks, canonical bytes, and deterministic fixtures. A test must not depend on wall-clock timing, object insertion order, worker completion order, network availability, or a live model unless it is an explicitly credentialed evaluation.
- Cover failure paths and atomicity. A rejected transaction or discarded preview must leave semantic state, revision, history, dirty state, journaling, and emitted events unchanged.
- Use property, golden, adversarial, migration, desktop E2E, accessibility, performance, and AI evaluation tests where `ARCHITECTURE.md` assigns them.
- Prefer real in-memory adapters over mocks at architectural seams. Mock only external behavior that the test does not own.

## Verification

Before declaring work complete:

1. Run the repository-declared formatting, lint, strict type, dependency-boundary, cycle, unit, integration, and build checks that apply to the changed area.
2. Run the narrow behavioral tests first, then the broadest available affected suite. Run Rust checks for native changes and desktop E2E for user workflows.
3. Verify no forbidden dependency, second mutation path, persisted runtime state, unbounded input, nondeterministic intent, or category-specific core concept was introduced.
4. Verify migrations and golden artifacts intentionally when schemas, commands, containers, encodings, or exported semantics change.
5. Report the behavior delivered, tests run, remaining risks, and any follow-up tickets. Never claim a check that was not executed.

Completion criterion: all assigned acceptance criteria are evidenced, applicable checks pass, architecture remains conformant, and the working tree contains only intentional changes.
