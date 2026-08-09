# Fixed AI geometry evaluation v1

**Status:** v1 (ticket #35, plan S12.12/S12.13)

The fixed geometry evaluation harness validates the initial AI editing
workflows — chair creation, shorter legs, a red seat, and left-side
mirroring — reliably enough for promotion. It lives in the
`@voxel-maker/evaluation` package (plan S12.12), above the agent loop and
the deterministic preview renderer, and runs **headless in CI on every
PR** through recorded tool traces: no network, no wall clock, no live
model, no credentials.

## What the harness does

For each fixed scenario the harness:

1. builds the deterministic starting document and selection
   (`src/fixtures.ts`; the input document hash is recorded);
2. runs the bounded provider-neutral agent loop (`@voxel-maker/agent`,
   ticket #33) over an isolated preview session with the
   `DeterministicProvider` executing the scenario's **golden recorded
   tool trace** (`src/scenarios.ts`) on a virtual clock; the suite pins
   the exact expected input and output document hashes of every golden
   scenario (plan 12.3) so a fixture or trace drift fails CI;
3. applies the approved proposal as ONE labeled live transaction
   (the suite never auto-applies);
4. renders the starting and resulting documents through the standard
   preview protocol's deterministic software renderer (all four views,
   fixed 128x128 evaluation size) and records pixel hashes plus signals;
5. computes the seven scoring dimensions (`src/score.ts`), records every
   versioned input (`src/versions.ts`), and gates the result through the
   explicit promotion thresholds and baseline review (`src/promotion.ts`).

The suite test (`src/harness.test.ts`) asserts the golden scenarios score
1.0 on every dimension and pass every threshold, and that adversarial
recorded traces (invalid calls, over-budget, sloppy minimal diff,
revision conflict) are detected by the scoring and never corrupt live
state.

## Fixed scenarios

| Scenario | Starting document | Selection | Prompt |
|---|---|---|---|
| `chair-create` | empty scaffold (one volume, one wood material) | none | "Create a chair with a seat, four legs, and a backrest." |
| `shorter-legs` | 208-voxel chair | bottom two rows of every leg | "Make the chair legs shorter by removing the bottom half of each leg." |
| `red-seat` | 208-voxel chair | seat region | "Make the seat red." |
| `mirror-left` | 214-voxel chair with a left armrest | whole chair | "Mirror the left side to the right side to make the chair symmetric." |

Task completion is checked semantically on the resulting document
(occupied bounds, region fills, material usage, symmetry score, exact
voxel counts). The mirror scenario uses `voxel.copyRegion` anchored at
the mirrored position: `voxel.mirrorRegion` has move semantics (the
destination is the source region), so a copy-mirror is the minimal-diff
realization of "mirror the left side to the right side".

## Scoring dimensions (plan S12.2)

Every dimension is a 0..1 score plus the evidence that produced it:

1. **Task completion** — fraction of the scenario's semantic checks that
   pass on the applied document.
2. **Unrelated changes** — voxel changes outside the allowed region,
   material-record changes outside the allowed set (added materials
   only), and any node change; combined as voxel x material x node
   scores.
3. **Command/tool efficiency** — tool-call, round, and command counts
   against the golden trace (40/30/30 weighting).
4. **Invalid calls** — fraction of rejected tool calls, categorized by
   error code (`UNKNOWN_TOOL`, `INVALID_ARGUMENT`, ...).
5. **Limit failures** — any budget/limit error surfaced by the run.
6. **Semantic structure** — full document validation (hierarchy cycles,
   orphan/missing references), occupied bounds inside volume bounds, and
   used-material existence.
7. **Rendered previews** — render completion plus scenario signals:
   previews changed, normalized silhouette similarity (framing-robust
   occupancy-grid signature; raw pixel overlap is meaningless when the
   standard views reframe to changed content bounds), and requested-color
   presence (red pixels for the red-seat scenario).

## Tracked run metrics (ticket #45 AC)

Every `RunReport` records the complete cost/scale evidence of one
evaluation run, so AI evaluations track rounds, tool calls, commands,
modified voxels, output size, time, and estimated cost:

| Metric | Source | Notes |
|---|---|---|
| `rounds`, `toolCalls` | agent loop counters | exact counts of the recorded run |
| `stagedCommands` | staged proposal | commands the proposal reserves |
| `appliedCommands` | applied transaction event | commands actually committed by Apply |
| `voxelEstimate` | preview reservation | proposed voxel changes reserved |
| `modifiedVoxels` | before/after diff | effective voxels changed by the applied proposal |
| `outputBytes` | canonical output document JSON | byte size of the applied document |
| `durationMs` | virtual clock | simulated provider latency, deterministic |
| `usage` | provider usage | input/output/cached tokens |
| `costUsd` | `estimateCostUsd` | deterministic eval-model price ($1/M input, $2/M output; `DETERMINISTIC_MODEL_PRICE`) |

The eval-model price is policy, not a vendor price: it gives the
deterministic suite a real, stable estimated-cost path through the same
pricing function the live adapters use, so cost tracking is exercised on
every PR run.

## Version recording (plan S12.2)

Every result records: evaluation suite version, provider id/version/model
(the deterministic adapter), system and scenario prompt versions (stable
prompt hashes), inspection and mutation tool-schema contract versions,
fixture version plus the input document's canonical semantic hash, and
budget version plus the budget profile hash. A change in any recorded
version invalidates silent baseline comparisons and triggers relevant
reevaluation (plan 12.3).

## Promotion thresholds (plan S12.3)

The suite is promotable only when ALL of the following hold:

| Threshold | Value | Evidence |
|---|---|---|
| Safety and integrity | 100% | every scenario run reaches approve+apply; zero partial commits; failed runs leave zero live state change |
| Schema-valid tool calls | >= 95% | valid calls / total calls across the suite |
| Task completion | >= 90% | per scenario and suite average |
| Over-budget runs | 0 | no limit-failure run |
| Minimal diff | unrelated-changes >= 0.95, efficiency >= 0.9 | per scenario, vs the recorded baselines |

These floors mirror the plan's proposed promotion gates. They are
constants in `src/promotion.ts` and are adjustable **only through an
approved eval report** that records the evidence and the new thresholds.

## Changed-baseline review process (plan S12.3)

`RECORDED_BASELINES` captures the first golden run's scores (1.0 on every
scenario dimension under `geometry-eval-v1`). `evaluatePromotion` compares
each run against the recorded baselines:

- a score more than 0.05 below its recorded baseline blocks promotion
  with a `changed baseline requires an approved eval report` entry;
- the review process is: reproduce the change on the pinned versions,
  compare the delta against the recorded baselines, and either fix the
  regression or ship an approved eval report that documents the new
  baseline and the reason (for example, an intentional prompt/tool/skill
  change) — the thresholds themselves are updated only through that
  report;
- changing model, provider behavior, tool descriptions, system prompt,
  skill, geometry semantics, or the renderer protocol triggers relevant
  reevaluation before promotion (plan 12.3).

Image/LLM-judge scores remain advisory until calibrated against blinded
human ratings; visual review remains required for a curated set. Live
provider cases are a planned follow-up (nightly, at least three
repetitions where budget permits, recording variance; never a PR
prerequisite) — v1 ships the deterministic recorded-trace lane only, and
the harness records every versioned input so a live-provider run can be
compared against these baselines when it lands.

## Running

```sh
pnpm --filter @voxel-maker/evaluation test
pnpm --filter @voxel-maker/evaluation test:coverage
```

The full repo gate (`pnpm check`) includes the suite.
