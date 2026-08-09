# Genericity demonstrations v1

**Status:** v1 (issue #46, plan S17.13, ARCHITECTURE.md §5)
**App version:** 0.1.0

The engine (shared, math, model, voxel, document, rigging, animation,
commands, renderer, session, editor, formats, interchange, storage,
agent, testkit) is **category-free**: no asset-category document types,
commands, constraints, tracks, or evaluators. All category knowledge
lives above the engine in skills, generators, fixtures, and demos.

`pnpm check:genericity` (new in #46, part of `pnpm check`) enforces both
directions:

1. **Engine surface** — no exported identifier and no `kind`/`category`/
   `type` literal in engine source (non-test, non-fixture) matches the
   forbidden asset-category vocabulary.
2. **Demonstration coverage** — all nine PRD definition-of-done
   demonstrations exist above the engine.

## The nine demonstrations

| # | Demonstration | Evidence above the engine |
|---|---|---|
| 1 | Architecture | creation skill `architecture`; model fixture `createHouseFixture` |
| 2 | Furniture | creation skill `furniture` |
| 3 | Vehicles | creation skill `vehicle`; model fixture `createVehicleFixture`; animated demo `wheel` |
| 4 | Vegetation | creation skill `vegetation` |
| 5 | Humanoids | creation skill `humanoid`; rigging skill `biped`; animated demo `simple-character` |
| 6 | Quadruped (non-humanoid creature) | creation skill `quadruped`; rigging skill `quadruped` |
| 7 | Flying creature (non-humanoid creature) | creation skill `flying-creature`; rigging skill `wings`; animated demo `wings` |
| 8 | Mechanical assemblies | rigging skill `mechanical-linkage`; motion skill `mechanical`; animated demo `linked-arm`; animated demo `chest-lid` |
| 9 | Abstract assets | model fixture `createAbstractFixture`; animated demo `abstract` |

All demonstrations are built exclusively from generic primitives (node,
volume, material, pivot, joint, constraint, clip, track, keyframe) and
registered commands; none required a new core primitive (plan S17.13).

## Why the core stays generic

- A saved document never requires the originating skill to open, edit,
  animate, or export (skills are removable knowledge).
- The genericity suite (`packages/model/src/fixtures.test.ts`, skills
  boundary tests, `check:genericity`) fails the release if a category
  concept ever enters the engine, per ARCHITECTURE.md review checklist.
