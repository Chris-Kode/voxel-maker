# Incremental chunk meshing pipeline (v1)

**Plan:** S6.4/S6.6–S6.8/S6.14/S6.15 — Mesh DTOs, worker pool, chunk
geometry lifecycle, dirty-chunk scheduler, diagnostics, render lifecycle
tests.
**Ticket:** #23 — Keep rendering incremental and responsive.
**Status:** accepted (implementation baseline).

## Purpose

The viewport projects voxel chunks as Three.js meshes. Meshing must stay
responsive while localized geometry and material changes arrive
asynchronously: edits produce *only* the edited chunk and its face
neighbors, meshing happens off the main thread over copied immutable
data, visible work is prioritized, main-thread uploads are budgeted per
frame, and stale, cancelled, failed, live, and preview results follow
explicit behavior. This document is the contract the ticket's acceptance
criteria require.

## Data flow

```text
commit event (changed chunks)
        │  edited chunk + face neighbors only
        ▼
scene adapter ── schedule({namespace, volume, coordinate, revision})
        │
        ▼
dirty-chunk scheduler (pending set, bounded)
        │  per frame: dispatch ≤ maxDispatches, visible first
        ▼
meshing pool (≤ maxConcurrent in flight, retries, latest-wins)
        │  copied immutable input: core 4096 values + 1736-value halo
        ▼
worker (compute face-culled mesh) ── result tagged with request identity
        │
        ▼
scheduler (completed queue) ── install ≤ maxUploads per frame
        │
        ▼
scene adapter (re-verifies latest revision, disposes superseded geometry)
```

## Copied immutable chunk-and-halo data (S6.4)

Every meshing job carries a `ChunkMeshInput` whose buffers are always
copies of authoritative storage:

- `values` — 4096 X-fastest unsigned-16 material values of the chunk
  (`VoxelVolumeReadView.getChunk` already copies);
- `halo` — 1,736 values copied from the 26 neighbor chunks' boundary
  data: 6 face slices × 256, 12 edge lines × 16, 8 corner voxels (layout
  in `packages/renderer/src/halo.ts`).

Both are transferred to the worker (never copied again), and mutating
either never affects the volume. `halo.test.ts` proves the halo sampler
agrees with direct volume reads for every one of the 18³ local positions,
including negative chunk coordinates.

## Request/result identity and staleness (S6.4/S6.6)

Requests and results carry `{namespace, volumeId, coordinate, revision}`.
A result may update the scene only when it still matches the **latest**
request for that identity — checked twice:

1. **Pool (latest-wins):** submitting a newer job for a chunk cancels the
   older job; a late result is dropped and counted `staleDropped`
   (superseded) or `cancelled` (explicit cancel). Worker responses must
   also reproduce the request's identity tags exactly (protocol
   validation), so a corrupt or mismatched response can never install.
2. **Scene adapter (install gate):** the adapter keeps its own
   latest-revision map and drops results whose revision no longer matches
   — covering the window between pool delivery and main-thread install.

Worker completion order never decides visible state. The main thread
alone owns semantic and renderer installation authority.

## Explicit result behaviors

| Outcome | Behavior |
| --- | --- |
| Fresh (matches latest) | Installed within the frame upload budget; superseded geometry disposed exactly once |
| Stale (superseded by newer job) | Dropped; counted `staleDropped` |
| Cancelled (newer edit, volume/node deletion, lifecycle clear) | Dropped; counted `cancelled` |
| Failed (retries exhausted) | Chunk stays unmeshed; previous geometry (if any) stays visible; counted `failed`; pool reports through `onFailure` |
| Live (`live` namespace) | Installs into the live scene |
| Preview (`preview:<session>`) | Never touches the live scene; the adapter installs only `live` results, and preview results are isolated per namespace in the pool |

## Scheduling (S6.8)

- **Localized edits:** the adapter schedules exactly the chunks the
  commit event reports — the edited chunk plus the six face neighbors
  needed for boundary visibility. Nothing else is remeshed.
- **Newest revision wins:** scheduling a chunk again supersedes the
  pending entry and cancels any in-flight job; a slow result can never
  overwrite a newer edit.
- **Visible work first:** each flush recomputes per-chunk priority from
  the camera frustum (chunk world box vs. frustum, 0 = visible,
  1 = hidden) and dispatches in priority order.
- **Bounded queues:** the pending set is capped (`maxPending`, default
  256; overflow drops the least important pending chunk — its mesh stays
  as it was until a later edit); the pool caps concurrent jobs
  (`maxConcurrent`, default 2) and rejects further submits, which the
  scheduler re-queues for the next frame.
- **Upload budget:** at most `maxUploadsPerFrame` completed meshes
  install per frame (default 4), and at most `maxDispatchesPerFrame` jobs
  dispatch (default 4). `resolve` copies chunk data on the main thread at
  dispatch time, so main-thread cost is bounded per frame.
- **No flicker:** the old geometry stays visible until its replacement
  lands; emptied chunks dispose immediately on the main thread (no worker
  round-trip).

## Geometry and material lifecycle (S6.7)

- One `THREE.Mesh` per chunk; material groups map to a shared material
  instance per material id (the material adapter owns the cache).
- Every replacement disposes the superseded `BufferGeometry` exactly
  once; volume removal, node deletion, lifecycle replacement
  (`document-opened`/`document-replaced`/`document-closed`), and
  `dispose()` dispose every owned mesh and material.
- Node groups stay synchronous (selection, overlays, and picking attach
  to them); only chunk meshes are asynchronous.

## Diagnostics (S6.14)

`SceneAdapter.diagnostics()` returns the live counters the desktop dev
overlay renders each frame:

| Counter | Meaning |
| --- | --- |
| `pendingChunks` / `inFlightMeshes` | Queued / executing mesh jobs |
| `installedChunks` | Installed chunk meshes |
| `triangles` / `drawCallEstimate` / `meshBytes` | Scene totals (estimate: one draw call per material group; bytes = positions + normals + indices) |
| `lastMeshMs` / `averageMeshMs` | Worker mesh times |
| `staleDropped` / `cancelled` / `failed` | Pipeline outcome counters |
| `uploadsThisFrame` | Main-thread installs in the latest flush |

The desktop shell overlays FPS, draw calls, triangles, queue length, mesh
time, and mesh memory in dev mode (`import.meta.env.DEV`); the same
numbers are asserted in renderer tests.

## Greedy meshing gate (S6.17)

Face culling is the correctness baseline and the only enabled mesher.
Greedy meshing may be enabled only behind the same seam
(`buildChunkMesh`/`handleMeshingRequest`) with (a) golden equivalence to
the face-culled output on the correctness fixtures and (b) benchmark
evidence of significant triangle reduction on the S6.16 scenes. Neither
exists yet, so greedy meshing remains off.

## Tests (S6.15)

- `halo.test.ts` — copies are immutable and sampler-equivalent to volume
  reads (including negative coordinates).
- `meshing-pool.test.ts` — latest-wins, cancel, bounded concurrency,
  retries-then-failure, diagnostics, worker protocol validation, worker
  executor against a fake worker.
- `chunk-scheduler.test.ts` — newest revision per chunk, commit-scoped
  scheduling, visible-first dispatch, per-frame budgets, bounded pending,
  volume/namespace cancellation, disposal.
- `scene-adapter.test.ts` — flush-driven installs, no-flicker
  replacement, immediate empty-chunk disposal, stale worker result never
  wins (fake worker), upload budget, diagnostics, subtree/lifecycle
  disposal, and chunk readability after dispatch.
- Desktop composition tests drive the same pipeline through the real
  session/command bus.
