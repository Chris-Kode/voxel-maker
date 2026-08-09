# AI panel and staged proposals v1

**Status:** v1 (ticket #34, plan S12.10/S12.14/S12.15)

The AI panel is the desktop surface for observing, previewing, accepting,
rejecting, or conflict-resolving an AI proposal without surrendering
document control (issue #34, ADR-0007).

## Workflow

1. **Configure.** The panel shows the provider and model. AI stays
   unavailable until a provider key is stored: the desktop shell stores
   the key in the operating-system keychain through the agent package's
   credential seam (plan S12.4, ADR-0010); the plain browser dev shell
   keeps the key in memory only (never web storage), so a reload returns
   to the unconfigured state. The key never enters controller state,
   notices, activity logs, diagnostics, transcripts, or project files.
2. **Consent.** The first run per provider+model requires explicit
   consent: the panel lists the transmitted data categories and the
   per-run cost cap before enabling the provider (ADR-0010). Consent
   records live in a per-window store and expire after 30 days.
3. **Run.** The prompt runs through the bounded provider-neutral agent
   loop (`@voxel-maker/agent`, ticket #33) over a fresh isolated preview
   session. The panel shows the state-machine progress, normalized tool
   activity (called/rejected tools), cumulative token usage, and a Cancel
   button. Session budgets (rounds, tokens, tool calls, commands, voxels,
   output bytes, duration, cost) are hard limits.
4. **Review.** Every successful run lands in the `approve` phase — there
   is no auto-apply path in v1 (ADR-0007). The panel shows a bounded
   semantic diff (staged command count, command types, voxel estimate,
   changed node/material/volume counts, truncation flag) and flags large
   proposals (≥ 10,000 voxels) for extra review. Apply and Discard are
   the only ways forward.
5. **Apply** executes every staged command as ONE optimistic transaction
   on the live bus against the captured base revision, labeled with the
   user-editable history label (default `AI proposal`). The result is one
   undoable history entry with `source: ai`. The staged overlay is
   disposed; live revision advances by exactly one.
6. **Discard** releases the preview session and the staged overlay. No
   history entry is created; live revision, history, dirty state,
   autosave, and journal are untouched.

## Staged viewport projection (S12.15)

While a run is in flight and a proposal awaits review, the renderer
projects the preview session's staged overlay under its
`preview:<session>` namespace (issue #32):

- Preview chunks mesh through the same pool tagged with the preview
  namespace; results install into a dedicated root group, so live and
  staged geometry never collide and completion order never decides
  visible state (ADR-0005).
- Preview commits are handled by the overlay's own projection
  bookkeeping; the live projection, live revision, history, autosave,
  and journal are never touched.
- `dispose()` (apply, discard, cancel, failure, or document lifecycle
  replacement) removes exactly that overlay's geometry and cancels only
  its meshing jobs.

## Stale-base conflicts (S12.9)

A proposal is anchored to the live revision at run start. When the live
document changes while the proposal is pending (mid-run or between
approve and apply), Apply reports `REVISION_CONFLICT` and the panel
offers:

- **Discard** — drop the proposal.
- **Reinspect** — start a fresh run that re-inspects the changed document
  before continuing with the original request.
- **Replan** — re-run the original prompt at the fresh revision.

There is no silent rebase: the staged proposal is never transplanted onto
the newer document.

## Offline / unconfigured degradation (S12.14)

Without a provider key, without consent, or when the provider is
unreachable, the panel explains the unavailable state and keeps every
manual workflow (create, open, edit, undo, save, recover, import,
export, preview) fully functional. Provider failures surface as a stable
error phase with a bounded, user-safe message; the run fails closed and
releases the preview.

## Layout

- `apps/desktop/src/ai/ai-controller.ts` — headless controller: snapshot
  state, run/cancel/apply/discard/reinspect/replan, key and consent
  management, lifecycle handling.
- `apps/desktop/src/ai/AiPanel.tsx` — the panel UI; renders only state
  and forwards gestures.
- `apps/desktop/src/platform/tauri.ts` — `TauriCredentialStore` over the
  shell's allowlisted keychain commands (`src-tauri`, `keyring` crate).
- `packages/renderer/src/scene-adapter.ts` — `projectPreview` /
  `ScenePreviewProjection`.
