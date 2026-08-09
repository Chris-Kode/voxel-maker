# AI Rigging and Animation Evaluation v1

Status: recorded baseline (ticket #36, plan S13.7-S13.9)

## Purpose

This suite extends the fixed AI geometry evaluation (S12.12/S12.13, ticket
#35) to generic rigging and animation workflows: the agent must rig an
unrigged asset (pivots, joints, constraints), stage a clip (tracks,
keyframes), have the staged overlay clip playable before Apply, and make
minimal natural-language follow-up modifications (plan S13.7-S13.9,
ticket #36 AC).

## Fixed scenarios

### Initial rig + animate (S13.8)

| id | fixture (unrigged) | user prompt | golden commands |
|---|---|---|---|
| `chest-lid-open` | chest lid | "Rig the chest lid on its hinge and make it open." | 7 |
| `wheel-spin` | wheel | "Make the wheel spin continuously." | 6 |
| `wings-flap` | paired wings | "Flap both wings." | 13 |
| `arm-reach` | linked arm | "Make the robot arm reach forward." | 19 |
| `abstract-rig` | abstract sculpture | "Animate the abstract sculpture." | 8 |

Each golden trace: inspect -> rig (setNodePivot/addNodeJoint/addConstraint)
-> animate (createAnimation/addTrack/setKeyframe) -> inspect staged ->
approve. All stages use only the registered articulation/animation command
families on the isolated preview overlay; nothing is executed on the live
store until Apply.

### Follow-up minimal modifications (S13.9)

| id | fixture (rigged) | user prompt | golden commands |
|---|---|---|---|
| `chest-farther` | rigged chest | "Open the chest lid farther." | 1 (keyframe value) |
| `wheel-slower` | rigged wheel | "Make the wheel spin slower." | 1 (duration 2 -> 4) |
| `wings-one` | rigged wings | "Only flap the left wing." | 1 (remove right track) |
| `arm-elbow-limit` | rigged arm | "Limit the elbow to 90 degrees." | 1 (constraint limits) |
| `wheel-faster` | rigged wheel | "Make the wheel spin twice as fast." | 2 (retime loop point + duration 2 -> 1) |

Every follow-up starts from the EXACT end state of the matching initial
scenario (the rigged fixtures are the golden initial end states), and the
golden trace touches only the requested state: the unrelated-changes
dimension allows only the scenario's declared node and clip allowances,
and voxels never change.

## Fixed fixtures

- Unrigged variants of the five generic rig fixtures from ticket #26
  (geometry + hierarchy only; pivots/joints/constraints/clips stripped).
- Rigged variants embedding the exact rig components and clips the golden
  traces produce (deterministic end states, shared by initial and follow-up
  scenarios).
- Every volume is filled solidly with the primary material so rendered
  preview evidence and voxel accounting are deterministic.

## Overlay-clip playback evidence (S13.5)

Before Apply, the harness reads the staged clip from the preview session
(`PreviewSession.overlayClip`) and evaluates it through the animation
runtime at two sample times; the `overlayPlayback` scoring dimension passes
only when the staged clip moves the expected nodes. Playback never touches
the live store, revision, history, autosave, or journal.

## Scoring

Same seven dimensions as the geometry suite, plus `overlayPlayback`
(vacuously 1.0 for geometry scenarios). Golden runs score 1.0 on every
dimension; the promotion gates of plan 12.3 apply to the combined suite.

## Recorded baselines

Pinned at `rig-animation-eval-v1` with golden input/output document hashes
recorded in `rig-harness.test.ts`; any drift in fixtures, tool schemas, or
golden behavior fails the pinned-hash tests and requires an approved
changed-baseline review.
