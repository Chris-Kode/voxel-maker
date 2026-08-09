# `animation.*`, `track.*`, and `keyframe.*` commands

The `animation.create`, `animation.update`, `animation.delete`, `track.add`,
`track.remove`, `track.setInterpolation`, `keyframe.set`, `keyframe.move`,
and `keyframe.delete` commands (plan S10.6, ticket #28) author generic
property-animation clips through the command bus. Clips are bounded named
track collections with a duration and loop policy; tracks target exactly one
property channel of one node; keyframes carry typed values at sorted unique
times. All nine commands share `schemaVersion: 1` and run the shared
command-conformance battery.

## Command shapes

| Command | Payload fields | Effect |
| --- | --- | --- |
| `animation.create` | `animationId`, `name?`, `duration`, `loop` | Creates an empty clip with the given duration (`(0, 86400]`) and loop policy (`once`/`loop`). Re-creating an identical clip is a no-op commit; a conflicting record with the same id is `DUPLICATE_ANIMATION_ID`. |
| `animation.update` | `animationId`, `name?`, `duration?`, `loop?` | Updates the named fields (at least one required; `name: null` removes the name, matching `node.rename` semantics). Shrinking the duration below an existing keyframe time is rejected. |
| `animation.delete` | `animationId` | Deletes the clip and its tracks and keyframes; a no-op commit when absent. Undo recreates the full clip through a composite inverse. |
| `track.add` | `animationId`, `trackId`, `targetNodeId`, `interpolation` | Adds an empty track targeting a document node with `step`, `linear`, or `smoothstep` interpolation. Track ids are unique across the document. Re-adding an identical track is a no-op; a conflicting record is `DUPLICATE_TRACK_ID`. |
| `track.remove` | `animationId`, `trackId` | Removes the track and its keyframes; a no-op commit when absent. Undo restores the track with its keyframes. |
| `track.setInterpolation` | `animationId`, `trackId`, `interpolation` | Changes the track's interpolation mode. |
| `keyframe.set` | `animationId`, `trackId`, `keyframeId`, `time`, `property` | Creates or updates a keyframe. `time` must lie in `[0, duration]` and stay unique; the property channel must match the track's existing channel; values are canonicalized (rotations normalized and sign-canonicalized, scale strictly positive). Honors the document keyframe budgets. |
| `keyframe.move` | `animationId`, `trackId`, `keyframeId`, `time` | Moves a keyframe to a new unique time, preserving its value. |
| `keyframe.delete` | `animationId`, `trackId`, `keyframeId` | Deletes a keyframe; a no-op commit when absent. Undo restores it exactly. |

Use the canonicalizing constructors (`createAnimationCommand`, ...,
`deleteKeyframeCommand`); they validate and normalize the payload at
construction time. Register the handlers with `registerAnimationCommands`.

## Validation

- `INVALID_ID` / `INVALID_ANIMATION_DURATION` / `INVALID_LOOP_POLICY` /
  `INVALID_INTERPOLATION` / `INVALID_KEYFRAME_TIME` / `INVALID_VECTOR` /
  `INVALID_QUATERNION` / `INVALID_SCALE` / `INVALID_PROPERTY_CHANNEL` /
  `INVALID_CANONICAL_NUMBER` — malformed or out-of-range payload values.
- `MISSING_ANIMATION` / `MISSING_TRACK` / `MISSING_KEYFRAME` /
  `MISSING_NODE` — references that do not exist in the document.
- `DUPLICATE_ANIMATION_ID` / `DUPLICATE_TRACK_ID` /
  `DUPLICATE_KEYFRAME_ID` / `DUPLICATE_KEYFRAME_TIME` — identifier and
  time uniqueness invariants (times must also stay sorted ascending).
- `ANIMATION_TRACK_CHANNEL_MISMATCH` — a track mixes property channels.
- `EMPTY_ANIMATION_UPDATE` — an update with no fields.
- `LIMIT_EXCEEDED` — clip/track/keyframe budgets (ADR-0009: 256 clips,
  10,000 tracks, 1,000,000 keyframes, 100,000 per track).
- `REFERENCED_NODE` — `node.delete` rejects nodes targeted by a track.

## Undo and redo

Undo restores the exact pre-command state. `animation.delete` and
`track.remove` record composite inverses (keyframe sets, then track adds,
then the clip create) that the bus replays in reverse order, so deleting a
clip and undoing restores every track and keyframe bit for bit.

## No-op semantics

Creating an identical clip or track, and deleting an absent clip, track, or
keyframe commit a no-op transaction (the desired end state already holds),
matching the `node.delete`/`material.create` no-op policy.

## Runtime semantics

The `@voxel-maker/animation` package evaluates the authored data purely:
`resolveClipTime` applies the ADR-0006 loop policy (negative time clamps to
zero; `once` clamps to `[0, duration]`; `loop` wraps with mathematical
modulo so an exact positive duration evaluates at zero); `sampleClip`
samples tracks (step, linear, frozen smoothstep ease `u² × (3 - 2u)`,
shortest-path quaternion SLERP, exact boundaries); and
`evaluateAnimationRuntime` layers base document state, then the animation
override, then the hierarchy world pass without commands or revisions per
frame. Stopping playback restores base state exactly. The injectable
playback controller (`createPlaybackController`) supports play, pause,
stop, loop (transport override), and scrub with a testable clock.
