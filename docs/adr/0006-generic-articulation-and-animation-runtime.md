---
status: accepted
---

# Generic articulation and animation runtime

Articulation and animation must stay generic, deterministic, and separate from persisted runtime evaluation. We adopt one Node transform hierarchy, generic Joint and Constraint annotations, typed property Tracks, and a frozen sampling and evaluation order.

## Decision

The Node hierarchy is the only transform graph. Pivots and Joints annotate Nodes rather than introducing bones or category-specific structures. Version 1 Constraints are deterministically ordered by their stable persisted order and apply local Euler XYZ rotation limits in radians; they affect runtime evaluation only. Positive non-uniform ancestor scale is supported because constraints clamp the Node local rotation before hierarchy composition; shear decomposition is never used during evaluation, and exporters that cannot preserve the result must bake it or report a loss. Clips contain typed property Tracks with stable keyframes; rotation values are canonical quaternions sampled by shortest-path SLERP. Initial interpolation is step, linear, or the frozen smoothstep curve `u² × (3 - 2u)`. Version 1 loop policies are `once` and `loop`: `once` clamps time to `[0,duration]`; `loop` maps time with mathematical modulo into `[0,duration)`, so exact positive duration evaluates at zero; negative playback time clamps to zero before applying either policy. Evaluation layers base Document state, animation override, then Constraints before hierarchy world transforms, and playback never writes Commands per frame.
## Considered options

- A separate skeleton hierarchy was rejected because two parent graphs can disagree and complicate editing, export, and AI inspection.
- Persisting constrained or per-frame evaluated transforms was rejected because derived runtime output would pollute history and semantic identity.
- Euler rotation keyframes were rejected because interpolation and singularities are less stable than canonical quaternions.
- Asset-specific rigs and named motions in core were rejected because they prevent one engine from representing unrelated asset categories.
- More complex solver constraints and ping-pong looping were deferred because deterministic order, boundary behavior, limits, and export semantics need a narrow version 1 baseline.

## Consequences

Stopping playback restores base state exactly. Validation must enforce target/property compatibility, finite values, unique sorted times, duration, loops, and budgets. Rich category knowledge belongs in Skills and generators, and future constraint kinds require explicit versioned semantics.

## Gates

This decision gates persisted animation descriptors (#5), articulation and constraints (#26–#27), clips and timeline editing (#28–#30), AI rigging/motion proposals (#36 and #39), and animated glTF/GLB export (#42).
