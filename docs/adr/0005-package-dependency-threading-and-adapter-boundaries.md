---
status: accepted
---

# Package dependency, threading, and adapter boundaries

A headless deterministic core requires platform, renderer, worker, and provider behavior to remain outside semantic ownership. We adopt downward-only packages, composition-root adapters, copied revision-tagged worker messages, and main-thread installation authority.

## Decision

The workspace uses downward-only semantic dependencies rooted in `shared` and `math`, with `model` owning all persisted discriminated unions; feature packages add behavior without runtime schema extension. `commands` owns the mutation kernel, renderer and editor remain projections, and desktop composition injects filesystem, Tauri, archive, worker, Three.js, and provider adapters. Worker communication uses typed copied immutable DTOs tagged with live or preview namespace, semantic identity, Revision, and cancellation identity; completion order is never authoritative. Viewport picking selects the smallest non-negative ray distance; an exact boundary tie resolves by X, then Y, then Z axis, followed by stable Node ID and Volume ID. The main thread alone owns semantic and renderer installation authority; workers are pure compute adapters that cannot commit, publish revisions, or mutate transferred source state.
## Considered options

- A single application package was rejected because platform and UI imports would contaminate the headless semantic test surface.
- Feature-owned schema extension and globally discovered command registrars were rejected because persisted unions and mutation availability would depend on import order.
- Shared mutable worker memory was rejected initially because ownership and stale-result safety are harder to prove; copied buffers are the correctness baseline.
- Semantic packages constructing concrete adapters were rejected because integrations would become hidden, unreplaceable dependencies.
- Renderer access to the command bus was rejected because a projection must not gain write authority.

## Consequences

Package exports are the only supported cross-package entry points. Dependency, cycle, and forbidden-import checks must fail the build. Worker results update a projection only when all namespace, identity, and Revision tags still match; superseded resources are disposed.

## Gates

This decision gates workspace bootstrap and CI (#4), every semantic package (#5–#10), desktop composition and rendering (#15–#23), formats (#11–#14 and #24–#25), agent adapters (#31–#40), and scale/responsiveness work (#45).
