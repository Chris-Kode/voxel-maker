# Bounded visual refinement v1

**Status:** v1 (ticket #40, plan S15.1–S15.9)

Visual refinement lets a consenting user improve an AI proposal using
fixed standard-view rendered evidence, without creating an unbounded
autonomous loop (issue #40). Images are evidence for proposed commands —
never authoritative state — and every correction remains an ordinary
staged command with the same Apply / Discard / conflict / undo /
diagnostics semantics as the base proposal (ADR-0007).

## Fixed render protocol (S15.1)

Evidence always follows the standard preview protocol
(`packages/renderer/src/preview/preview-protocol.ts`, ticket #25):

- **Views:** perspective, front, side, top, in canonical order, with
  fixed framing, light direction, background, and orientation.
- **Bounds:** each image is at most 2048×2048 and 16 MiB decoded RGBA;
  the default evidence resolution is 512×512.
- **Determinism:** the same store and spec produce byte-identical PNGs
  on every platform (golden-tested in the renderer).
- **Revision association:** every evidence image carries the store
  revision, the canonical semantic hash, and the source (`live` or
  `preview:<session>`), so evidence is always tied to the exact live or
  preview revision it was rendered from (AC1). The loop renders the
  STAGED preview session, never the live document, during refinement.

The agent package owns the provider-neutral `EvidenceCapture` seam
(`packages/agent/src/vision/evidence.ts`); the desktop composition root
implements it with the software preview renderer and the dependency-free
PNG encoder (`apps/desktop/src/ai/visual-evidence.ts`). Core semantic
packages never import the renderer.

## Image consent and provider privacy policy (AC2)

Images are off by default, independently of text AI (ADR-0010). A
visual-refinement session transmits images only under an explicit
`ImageTransmissionConsent` record that names the provider, model, views,
image count, maximum resolution, estimated cost, consent time, and
expiry (`packages/agent/src/vision/image-consent.ts`). The loop checks
coverage before the first transmission: same provider/model, not
expired, every requested view approved, count within `maxImages`, and
resolution within `maxResolution`. Missing or insufficient consent fails
the run closed before any image leaves the device.

The consent UI summarizes the recorded provider privacy policy
(`PROVIDER_PRIVACY_POLICY`): OpenAI API data is not used for training by
default and may be retained for up to 30 days for abuse and misuse
monitoring, per the provider's published API data usage policy
(recorded as of the constant's `recordedAt` date). The application
retains no image bytes anywhere: transcripts keep only bounded image
metadata (view, dimensions, revision, source), never pixels.

## Critique and correction loop (S15.3–S15.5)

After the text/tool walk reaches approval, the optional refinement phase
(`VisualRefinementConfig` in `packages/agent/src/agent/loop.ts`):

1. Captures the fixed standard views of the STAGED preview.
2. Sends them with the fixed critique instruction
   (`DEFAULT_CRITIQUE_PROMPT`) to the provider.
3. Parses the bounded critique schema (`vision/critique.ts`): view,
   issue category, affected node ids, optional region, evidence text,
   suggested generic correction, confidence. Provider output is
   untrusted and validated before use.
4. Executes correction tool calls through the SAME mutator and preview
   session — corrections are ordinary staged commands (AC4).
5. Re-captures locally and evaluates the round (see below).
6. Stops when the model makes no change, on regression or oscillation,
   at the iteration/image caps, on cancellation, or on provider failure.

### Hard limits (AC3)

The refinement phase shares the session ledger with the base run, so
token, cost, duration, tool, command, and voxel budgets are enforced
across the whole session. New session limits (ADR-0009 table): **3
visual iterations** and **12 transmitted images**, reserved before
allocation. The image budget counts only transmitted images; local
evidence captures never leave the device and never consume it. The
iteration and image caps end the phase gracefully; any other budget
violation fails the run closed.

## Evaluation and regression gate (AC5)

Each round is evaluated deterministically
(`packages/agent/src/vision/evaluation.ts`):

- **Structural outcomes:** occupied voxels, chunks, volumes, nodes,
  materials, and occupied bounds before/after (`vision/structural.ts`).
- **Visual outcomes:** per-view pixel similarity of the rendered
  evidence (changed-pixel fraction and mean channel delta).
- **Regression policy** (`RefinementPolicy`): occupied-voxel loss below
  the retention floor, runaway growth, bounds explosion, and material
  loss are reported as stable regression codes; `promotable` is false
  while any regression or oscillation is flagged.
- **Oscillation detection:** a correction round that returns the staged
  state to a previously seen semantic hash stops the loop (no oscillating
  edits).

The loop stops refining on the first regressing or oscillating round,
and the final evaluation compares the pre-refinement baseline against
the final staged state. Automated promotion refuses regressing work, and
the desktop Apply button is gated: a proposal whose evaluation is not
promotable requires the explicit "Apply anyway" override (still one
labeled undoable history entry). The human remains the final authority
(ADR-0007); regressions are never silent.

## Desktop surface (S15.7)

- **Consent:** the AI panel shows a separate "Refine proposals with
  standard-view images" section with the provider privacy policy
  summary, a resolution choice (256/512/1024), the estimated cost, and
  Approve/Revoke actions.
- **Status:** the panel reports iterations, transmitted images, the
  final evaluation (occupancy delta, visual similarity), and regression
  warnings; the activity log shows per-iteration critique diagnostics.
- **Apply:** normal Apply is blocked for regression-gated proposals;
  "Apply anyway" promotes them explicitly.

## Layout

- `packages/agent/src/vision/evidence.ts` — bounded evidence schema,
  validation, capture seam.
- `packages/agent/src/vision/image-consent.ts` — image consent records,
  plans, provider privacy policy record.
- `packages/agent/src/vision/critique.ts` — bounded critique schema and
  parser.
- `packages/agent/src/vision/structural.ts` — deterministic structural
  metrics.
- `packages/agent/src/vision/evaluation.ts` — before/after evaluation,
  similarity, regression policy, promotion gate.
- `packages/agent/src/agent/loop.ts` — the refinement phase inside the
  bounded run.
- `apps/desktop/src/ai/visual-evidence.ts` — renderer-backed capture.
- `apps/desktop/src/ai/ai-controller.ts` — image consent, refinement
  status, gated Apply.
- `apps/desktop/src/ai/AiPanel.tsx` — consent and status UI.

## Follow-up work

- S15.6: deterministic intersection/silhouette pre-checks before paid
  vision (geometry-only checks are currently deferred).
- S15.8: a broader visual regression dataset (fox/bird/house/vehicle/
  abstract fixtures with versioned views) for the evaluation harness.
