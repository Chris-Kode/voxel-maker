# Rigging and motion skills v1

**Status:** v1 (ticket #39, plan S14.1/S14.7/S14.8/S14.9/S14.10/S14.11)

The rigging and motion skill catalogs extend the creation-skill catalog
(ticket #38) with reusable articulation and animation knowledge that
uses **only** the generic engine surface — never specialized behavior in
the document or runtime (ticket #39 AC). They live in the
`@voxel-maker/skills` package next to the creation skills and share the
same manifest contract, validator, provenance helpers, and removal
boundary.

## The v1 rigging catalog (plan S14.7)

| Skill | Category | Fixed fixture | Knowledge |
|---|---|---|---|
| `skill.biped-rig` | `biped` | `rig-biped` | separate head/upper arms/forearms/thighs/shin nodes; pivots at neck, shoulders, elbows, hips, knees; joints at each articulation; elbow and knee rotation limits |
| `skill.quadruped-rig` | `quadruped` | `rig-quadruped` | separate head/tail/four two-segment legs; pivots at neck, tail root, hips, knees; joints; knee rotation limits |
| `skill.wings-rig` | `wings` | `rig-wings` | body root with two wing children; wing-root pivots, joints, and bounded flap limits |
| `skill.mechanical-linkage-rig` | `mechanical-linkage` | `rig-linkage` | base root with a chain of links; per-link root pivots and joints; bounded sweep limits on intermediate joints |

Every rigging skill's allowed tools are exactly the generic hierarchy,
pivot, joint, and constraint tools plus rig inspection reads
(`RIGGING_TOOLS` in `src/rigging/define.ts`): `createNode`/`deleteNode`/
`renameNode`/`reparentNode`/`setNodeTransform`/`setNodeComponents`/
`setNodeMetadata`, `setNodePivot`/`removeNodePivot`,
`addNodeJoint`/`removeNodeJoint`, `addConstraint`/`setConstraint`/
`removeConstraint`, and the inspection reads `inspectSummary`,
`getSelection`, `inspectHierarchy`, `inspectNode`, `inspectBounds`,
`inspectRigging`. Rigging skills never touch voxels or animation state
(ticket #39 AC: "using only generic hierarchy, pivot, joint, and
constraint tools").

## The v1 motion catalog (plan S14.8)

| Skill | Category | Fixed fixture | Knowledge |
|---|---|---|---|
| `skill.walk` | `walk` | `motion-walk` | two-second seamless looping gait: thigh and shin tracks on both legs, alternate swing, equal endpoint values |
| `skill.run` | `run` | `motion-run` | one-second seamless looping stride with a deeper swing |
| `skill.jump` | `jump` | `motion-jump` | one-and-a-half-second non-looping tuck of both thighs |
| `skill.idle` | `idle` | `motion-idle` | four-second seamless looping sway of torso and head |
| `skill.fly` | `fly` | `motion-fly` | one-second seamless looping wing flap about both wing roots |
| `skill.mechanical-motion` | `mechanical` | `motion-mechanical` | two-second seamless looping sweep of the intermediate linkage joints |

Every motion skill's allowed tools are exactly the generic
clips/tracks/keyframes tools plus the clip/track/keyframe inspection
reads (`MOTION_TOOLS` in `src/motion/define.ts`): `createAnimation`/
`updateAnimation`/`deleteAnimation`, `addTrack`/`removeTrack`/
`setTrackInterpolation`, `setKeyframe`/`moveKeyframe`/`deleteKeyframe`,
and `inspectClips`/`inspectTracks`/`inspectKeyframes` (plus the scene
reads `inspectSummary`, `getSelection`, `inspectHierarchy`,
`inspectNode`, `inspectRigging`). Motion skills never change voxels,
hierarchy, pivots, joints, or constraints (ticket #39 AC: "using only
generic clips, tracks, and keyframes").

## Manifest contract extensions (ticket #39)

The v1 manifest gains a `kind` field (`"creation" | "rigging" |
"motion"`) and a kind-scoped `category`:

- creation categories stay the seven ticket #38 categories
  (`SKILL_CATEGORIES`);
- rigging categories are `biped`, `quadruped`, `wings`,
  `mechanical-linkage` (`RIGGING_CATEGORIES`);
- motion categories are `walk`, `run`, `jump`, `idle`, `fly`,
  `mechanical` (`MOTION_CATEGORIES`).

Kind-specific validation:

- creation skills declare at least one compatible generator and one
  visual baseline; rigging and motion skills declare **no** generators
  and **no** visual baselines (they change no voxels, so rendered
  silhouette baselines would be vacuous);
- rigging and motion skills **require** `evaluation.fixtureId`, which
  must resolve in the fixed-fixture registry
  (`src/rig-motion-fixtures.ts`) — a rigging/motion manifest that
  names an unknown fixture fails validation at catalog load;
- the manifest error surface gains `SKILL_KIND_INVALID`.

## New generic checks (plan S14.10)

The generic check registry (`src/checks.ts`) adds rig-state and
animation-state predicates over a committed document. All counts are
bounded integers; durations are bounded non-negative numbers; the
presence check takes one bounded node id.

| Check | Options | Passes when |
|---|---|---|
| `pivot-count-in-range` | `min`, `max` | nodes carrying a pivot component stay in range |
| `joint-count-in-range` | `min`, `max` | nodes carrying a joint component stay in range |
| `constraint-count-in-range` | `min`, `max` | nodes carrying a constraint component stay in range |
| `parented-node-count-in-range` | `min`, `max` | nodes with a parent stay in range |
| `node-present` | `nodeId` | the declared fixture node exists |
| `animation-count-in-range` | `min`, `max` | animations (clips) stay in range |
| `track-count-in-range` | `min`, `max` | animation tracks stay in range |
| `keyframe-count-in-range` | `min`, `max` | animation keyframes stay in range |
| `animation-duration-in-range` | `min`, `max` | at least one animation exists and every duration stays in range |
| `animation-loop-policy` | `policy: "once" \| "loop"` | at least one animation exists and every animation uses the policy |

## Evaluation against fixed fixtures (plan S14.10, ticket #39 AC3)

Every rigging and motion skill is evaluated against a fixed fixture
registered in `src/rig-motion-fixtures.ts`:

- **rigging fixtures** pair an unrigged start document with the golden
  rigged end state (pivots, joints, constraints, hierarchy);
- **motion fixtures** pair a rigged, clip-free start document with the
  golden rigged-plus-clip end state;
- every end state shares the start document's id at revision 1, so a
  store that applied the recorded golden trace is **byte-identical in
  canonical semantic identity** to the golden end state.

The evaluation suite (`src/rig-motion-evaluation.test.ts`) proves, per
skill: the fixed checks pass on the golden end state and fail on the
start (discriminating checks), the efficiency limits are coherent, and
a recorded golden trace (e.g. `bipedRigGoldenCommands()` and
`walkGoldenCommands()`) stages through the preview seam, exposes the
staged clip as the overlay clip before Apply, applies with provenance
metadata, and lands in the exact golden end state.

The looping endpoint policy (plan S13.4) is enforced on the fixtures
themselves: every looping fixture clip starts and ends at the same
keyframe value, so looped playback is seamless.

## Provenance and the removal boundary (plan S14.9, ticket #39 AC4)

Rigging and motion skills apply through `applyWithProvenance` exactly
like creation skills: the history entry and recovery journal carry
`skill:<name>@<version>` as the label and a deterministic correlation
id. Provenance is advisory metadata; it is never written into the
document, never required to open, edit, animate, or export the result,
and never consulted by the command bus.

The boundary suite (`src/boundary.test.ts`) proves a rigged **and**
animated document created through two labeled skill applies (biped rig
+ walk clip) opens, replays its journal, edits, animates, and exports
in a child process that imports none of the skill catalog — the
recovered canonical semantic hash is identical, and the document JSON
contains no skill reference.

## Authoring a new rigging or motion skill

1. Add the category to `RIGGING_CATEGORIES` / `MOTION_CATEGORIES` in
   `src/manifest.ts` and a manifest in `src/rigging/` / `src/motion/`.
2. Reference only the shared tool surface (`RIGGING_TOOLS` /
   `MOTION_TOOLS`); the registry rejects unknown tools.
3. Add a fixed fixture pair in `src/rig-motion-fixtures.ts` (start +
   golden end state sharing the start's document id at revision 1) and
   reference it with `evaluation.fixtureId`.
4. Reference only registered checks with bounded options; keep the
   checks discriminating (they must fail on the start).
5. Keep `constraints` at or below the hard engine caps; keep efficiency
   maxima at or below the constraints and goldens at or below the
   maxima.
6. Register the manifest in `RIGGING_SKILLS` / `MOTION_SKILLS` (stable
   category order) and re-run
   `pnpm --filter @voxel-maker/skills test`.
