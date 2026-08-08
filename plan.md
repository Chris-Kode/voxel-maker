# AI-Native Generic Voxel Editor — Technical Implementation Plan

**Plan version:** 1.0  
**PRD baseline:** 0.1  
**Repository state at planning time:** Empty  
**Primary target:** Desktop (macOS, Windows, Linux)  
**Recommended implementation:** Tauri 2 + React 19 + TypeScript + Three.js / React Three Fiber  
**Planning convention:** Task identifiers in `S<stage>.<task>` form; `Depends on` refers to those identifiers.  

---

## 1. Purpose and success criteria

This plan turns the PRD into a dependency-ordered implementation program. It deliberately builds a deterministic, headless editor engine before rendering, animation, or AI. The UI and the AI are adapters over the same command bus; neither may directly mutate persistent document state, Three.js is a projection rather than the source of truth, and all domain knowledge stays in skills above the generic engine.

The program is complete when:

1. The native editor can create, edit, organize, rig, animate, save, recover, and export generic voxel assets.
2. Every persistent human and AI operation is a validated, serializable command or transaction with undo/redo.
3. The same unmodified core represents and animates the nine asset categories in the PRD definition of done.
4. The AI can inspect, minimally modify, rig, animate, and export without receiving unrestricted state or filesystem/code execution.
5. The engine is testable in Node without React, Three.js, Tauri, a GPU, or an LLM.
6. The product meets explicit correctness, recovery, security, accessibility, and performance gates in this plan.

### 1.1 Scope rule

The initial release is a voxel editor, generic transform rig, property animation system, and constrained AI agent. It is not a mesh sculptor, physics simulator, game engine, multiplayer system, or plugin marketplace. Any proposal that expands those areas must be separately approved and must not delay the dependency chain below.

---

## 2. Non-negotiable architecture invariants

These are review gates, not preferences.

- **One edit path:** edits within an open document only use `CommandBus.execute` / `executeTransaction`. Validated new/open/recovery/migration may replace the entire aggregate only through the narrow `DocumentSession` lifecycle capability; this is not an edit command.
- **One semantic model:** UI actions and agent tools construct the same registered commands.
- **Renderer isolation:** no Three.js/R3F type appears in `shared`, `document`, `voxel`, `commands`, `rigging`, or `animation`.
- **Headless core:** all core operations run deterministically in Node tests.
- **Generic core:** no core type or command named for humanoids, furniture, vehicles, creatures, or named motions.
- **Serializable intent:** command payloads contain all IDs and values required for replay; handlers never generate random IDs or read wall-clock time.
- **Atomic transactions:** validation/execution happens against a staged sequential view; a failure publishes no document change, no dirty event, and no history entry.
- **Revision safety:** each committed transaction increments one document revision. AI commits use an expected base revision and fail on conflict.
- **Runtime/persistent separation:** selection, hover, cameras, open panels, playback time, evaluated animation transforms, GPU resources, and AI scratch state are not asset document state.
- **Bounded untrusted input:** imported files, tool arguments, and model output are schema-validated and resource-limited.
- **Stable coordinates:** right-handed `+X right, +Y up, +Z forward`; voxel locations are integers; regions are half-open `[min, max)`; angles are radians internally.
- **Backward-compatible persistence:** saved documents carry format versions and migrations. Unknown future versions fail safely and never overwrite the source.
- **Minimal AI diffs:** the agent inspects before mutation and preserves unrelated geometry and tracks.

A pull request violating an invariant requires an Architecture Decision Record (ADR) and explicit architecture-owner approval.

---

## 3. Baseline technology decisions

These decisions remove ambiguity before coding. Record each as an ADR in Stage 0.

| Area | Baseline | Reason / constraint |
|---|---|---|
| Monorepo | `pnpm` workspaces + Turborepo | Fast TypeScript workspace builds and explicit task graph |
| Desktop | Tauri 2, Rust stable | Small secure shell, native dialogs, atomic filesystem APIs |
| Web app | React 19, Vite, TypeScript strict | Desktop UI and fast iteration |
| 3D | Three.js + `@react-three/fiber` + `@react-three/drei` | Scene projection and editor controls |
| Runtime schemas | Zod | Shared validation for files, commands, IPC, and AI tools |
| Unit/property tests | Vitest + fast-check | Determinism, algebraic operations, malformed input |
| UI/E2E | Testing Library + Playwright (Tauri smoke separately) | Component and workflow testing |
| UI ephemeral state | Zustand | Selection/tool/layout/playback state; never owns the document |
| Styling | CSS variables + CSS Modules (or one agreed utility system) | Themeable desktop UI without engine coupling |
| Serialization | Canonical JSON manifest + little-endian binary chunks in ZIP `.vxl` | Inspectable metadata, compact voxels, deterministic hashing |
| ZIP | JS library behind `formats` interface initially | Replaceable; no format coupling to library |
| Worker protocol | Typed `postMessage` request/response DTOs | Meshing off-main-thread without shared mutable state |
| LLM integration | Provider-neutral adapter + JSON-schema tool calls | No core dependency on a model vendor |
| Secrets | OS keychain through allowlisted Tauri command | Never store API keys in project files/local logs |
| Logging | Structured redacted app log + in-memory diagnostics | Reproducibility without leaking prompts/secrets |
| CI | GitHub Actions on Linux; scheduled Windows/macOS packaging | Fast mandatory checks plus platform coverage |

### 3.1 Decisions to lock in Stage 0

- Chunk edge length: freeze v1 at **16** (`4096` voxels/chunk). A different edge requires a new voxel encoding version; benchmark alternatives only for a future version.
- Voxel material value and `MaterialId`: branded `uint16`; `0` is empty and absent from the material table, `1..65535` are document material IDs. Callers allocate exact IDs; referenced IDs cannot be deleted, and IDs are not reused while reachable history/journal records can mention them.
- All other IDs (`NodeId`, `VolumeId`, `AnimationId`, `TrackId`, `KeyframeId`, `CommandId`, `TransactionId`) are branded opaque serialized strings. UUIDv7/UUIDv4 may be generated by callers, but the generated ID must be present in the command payload before execution. Golden tests use fixed IDs.
- Quaternions: `[x,y,z,w]`, finite, normalized on command construction, and canonicalized so `w > 0` (tie-break first non-zero positive) for stable serialization.
- Numeric canonicalization: reject `NaN`, infinities, and serialized `-0`; ADR-001 defines float precision/quantization, epsilon, decomposition, and quaternion tie-breaks. Persistent derived TRS values (for example preserve-world reparenting) are resolved and canonicalized by the command constructor and carried in the payload; handlers validate/store them rather than recomputing platform-sensitive intent. Handlers may not perform hidden random/time/trigonometric intent generation.
- Scale: finite and strictly positive in v1. Geometry reflection uses `mirrorRegion`; negative node scale is rejected to avoid ambiguous winding, constraints, and export behavior.
- Matrices: column-major only inside math/runtime APIs; never serialize matrices as canonical transforms.
- Region convention: integer half-open AABBs; negative coordinates use mathematical floor division for chunk mapping.
- Color: canonical lowercase `#rrggbb` / `#rrggbbaa` policy selected once; linear/sRGB conversion belongs to renderer.
- Transform evaluation: `T(position) * T(pivot) * R(quaternion) * S(scale) * T(-pivot)`.
- Animation rotation values: quaternions and shortest-path SLERP. `step`, `linear`, and precisely defined `ease` (MVP: smoothstep time curve) have golden tests.
- Constraint MVP: local Euler XYZ rotation limits in radians, explicitly documented as an MVP limitation; keyframes remain quaternion-based.

---

## 4. Target repository and dependency boundaries

```text
/
├── apps/
│   └── desktop/                 # React UI + Tauri shell
│       ├── src/                 # panels, viewport composition, app services
│       └── src-tauri/           # allowlisted native I/O, keychain, updater
├── packages/
│   ├── shared/                  # IDs, branded primitives, Result/Error, events
│   ├── math/                    # vectors, quaternions, matrices, AABB, rays
│   ├── model/                   # all persisted DTOs, Zod schemas, schema migrations
│   ├── document/                # aggregate invariants, scene graph/query read model
│   ├── voxel/                   # sparse chunks, region ops, queries, meshing input
│   ├── commands/                # registry, bus, transactions, history, core commands
│   ├── rigging/                 # pivots, joints, constraints, evaluators
│   ├── animation/               # clips/tracks/keyframes and pure evaluation
│   ├── renderer/                # Three adapter, chunk resources, picking, previews
│   ├── editor/                  # editor services/tools independent of React widgets
│   ├── formats/                 # .vxl, .vox, glTF, image export adapters
│   ├── agent/                   # inspection/mutation tools and bounded agent loop
│   ├── skills/                  # domain knowledge, recipes, procedural generators
│   └── testkit/                 # deterministic fixtures, assertions, benchmarks
├── docs/
│   ├── adr/
│   ├── format/
│   ├── commands/
│   ├── threat-model.md
│   └── performance.md
├── fixtures/                    # checked-in golden assets and corrupt samples
├── scripts/                     # CI/build/release helpers
├── plan.md
└── package.json / pnpm-workspace.yaml / turbo.json
```

### 4.1 Allowed compile-time dependency graph

```text
shared <- math
shared, math <- model
shared, math, model <- voxel
shared, math, model, voxel <- document
shared, math, model, document <- rigging
shared, math, model, document, rigging <- animation
shared, math, model, document, voxel, rigging, animation <- commands
shared, math, model, document, voxel, rigging, animation <- renderer
shared, model, document, voxel, commands, rigging, animation <- editor
shared, math, model, document, voxel, rigging, animation <- formats
shared, model, document, voxel, commands, rigging, animation <- agent
agent tool contracts + generic generators <- skills
editor, renderer, formats, agent, skills <- apps/desktop
```

`model` owns the complete persisted discriminated unions from Stage 2, including pivot, joint, constraint, clip, track, and keyframe DTOs. It contains structural schemas only and never imports evaluators or commands. `document` owns aggregate invariants/read views; `rigging` and `animation` add semantic validators and pure evaluation without extending the schema upward. `commands` owns the kernel plus feature handler registrars and may depend on these lower feature packages; the desktop composition root registers them. Feature packages never import the global bus.

Enforce boundaries with ESLint `no-restricted-imports`, package `exports`, dependency-cruiser/Madge, an import-all-entrypoints CI fixture, and a cycle check. No package imports from `apps`, and no renderer/React/Three/Tauri import is allowed below adapters.

### 4.2 Runtime ownership

- `DocumentStore`: authoritative open asset state and committed revision; writable only with a private capability held by the command bus and the lifecycle coordinator.
- `DocumentSession`: narrow new/open/replace/recovery/close lifecycle coordinator. It installs only a fully parsed/migrated/validated document+voxel repository, resets history/selection/runtime/worker jobs, and emits lifecycle events; arbitrary UI/file code never receives its capability.
- `VoxelRepository`: document-associated sparse typed-array volumes; changes participate in the same atomic edit transaction. Public read views return copies/immutable accessors, never mutable `Uint16Array` backing buffers.
- `PreviewSession`: COW staged read view, query context, and preview-only revision/event namespace used by agent approval; it never affects live revision/history/autosave/journal.
- `EditorStore`: selection, active tool, camera, hover, panels, timeline cursor, notification state.
- `SceneRuntime`: world transforms, animation overlays, constraint outputs, visible chunk instances, picking maps.
- `AgentSession`: conversation summary, tool budget, working transaction, base revision, cancellation state.
- `FileService`: Tauri-mediated open/save/autosave/journal operations; core packages consume an interface, not filesystem APIs.

---

## 5. Canonical model and command contracts

This section is implementation guidance that later tasks must preserve.

### 5.1 Document aggregate

The `model` package defines the complete v1 persisted DTO family up front: `VoxelDocument`, nodes/components (including pivot/joint/constraint), materials, animation clips/tracks/keyframes, volume descriptors, metadata, independent schema-version fields, and a logical session revision. Later rigging/animation stages add semantic behavior and may bump `documentSchemaVersion` with migrations, but do not dynamically extend a closed schema union. Bulk chunk bytes live in `VoxelRepository` and serialize separately. All records use explicit stable ordering during serialization (sort string IDs by Unicode code unit; material IDs numerically; chunks and voxels lexicographically X, then Y, then Z unless a specific operation freezes another order). JavaScript object/Map/Set insertion order and worker completion order are never format or collision-resolution guarantees.

A scene node has exactly one parent reference and an ordered `children` list. Validators enforce reciprocity, uniqueness, no cycles, and no missing references. Reparenting defines whether world or local transform is preserved in its payload; it must never be implicit.

Components are a discriminated, independently versioned union with stable component IDs where multiple instances are allowed. Singleton kinds (`voxel`, `pivot`, `joint`) may occur at most once per node; constraints have stable IDs and a deterministic explicit order. Unknown component types in a supported file version produce a clear compatibility error rather than being silently discarded. Deleting referenced nodes, volumes, materials, clips, or components is rejected unless an explicit cascade/replacement policy is present in the command payload. Metadata is JSON-compatible, size/depth bounded, and never changes engine behavior.

### 5.2 Voxel storage

A volume maps signed chunk coordinates to lazily allocated chunks. Use a collision-free string key (`"x,y,z"`) in the first implementation, behind helpers so it can later become a packed key. Within a chunk use X-fastest indexing:

```text
index = localX + edge * (localY + edge * localZ)
```

`floorDiv` and positive modulo map negative voxel positions correctly. Empty chunks are removed canonically after a mutation. Each in-session chunk has a monotonic runtime revision and content hash; the revision may restart after reload and is excluded from semantic state/hash. Dirty flags are consumer-specific events, not canonical asset data. Boundary edits invalidate the edited chunk and only the six face neighbors needed for face visibility.

Bulk operations calculate bounds and modification estimates before allocation. Execution emits a compact `VoxelChangeSet` containing touched chunk coordinates, old-value runs needed for inversion, new revisions, and occupied-bounds invalidation.

### 5.3 Commands and handlers

```ts
interface Command<TType extends string, TPayload> {
  id: CommandId;
  type: TType;
  schemaVersion: number;
  payload: TPayload;
}

interface CommandEnvelope {
  command: Command<string, unknown>;
  source: "ui" | "ai" | "import" | "recovery" | "system";
  correlationId?: string;
}
```

Audit metadata (label, source, timestamps) is outside the deterministic payload unless explicitly part of the asset. Each registry entry provides:

- payload schema parsing;
- semantic validation against a read view and configured limits;
- staged execution returning a change set and inverse command(s);
- optional coalescing policy for UI drags;
- declared affected resources for diagnostics/conflict reporting.

Unknown command types/versions fail. Validation errors have stable codes, JSON paths, user-safe messages, and optional remediation hints for the agent.

### 5.4 Transaction algorithm

1. Parse transaction envelope and enforce command/count/byte budgets.
2. Verify mandatory `expectedRevision` for UI gestures, AI, import into an open document, preview Apply, undo, and redo. New/open/recovery use the separate lifecycle path. Reject stale revisions before staging.
3. Reject duplicate transaction/command IDs using the frozen idempotency policy: an identical already-committed transaction returns its recorded result; an ID reused with different bytes is an error. Undo/redo name the current revision explicitly and each increments it once; recovery replays recorded revision transitions without pretending to be a fresh user edit.
4. Create a copy-on-write overlay for node/material/animation records and touched chunks.
5. For each command in order: parse; validate against the overlay containing prior staged effects; execute only into the overlay; collect inverse/change/dirty information.
6. Run aggregate invariants (graph integrity, referential integrity, limits).
7. If any step fails, discard the overlay and return a structured error with command index; publish nothing.
8. Atomically swap/apply the in-memory overlay, increment revision exactly once, and create one history entry.
9. Publish one frozen commit event with granular change hints. Renderer, UI, the ordered recovery writer, autosave, and diagnostics consume it after commit; subscribers may never veto or mutate the commit, and subscriber exceptions are isolated.

The post-commit event is coarse, immutable, and revision-tagged rather than one renderer event per command:

```ts
interface DocumentCommitted {
  revisionBefore: number;
  revisionAfter: number;
  transactionId: TransactionId;
  source: "ui" | "ai" | "import" | "recovery" | "system";
  correlationId?: string;
  commandIds: CommandId[];
  commandTypes: string[];
  changedNodeIds: NodeId[];
  changedMaterialIds: MaterialId[];
  changedAnimationIds: AnimationId[];
  changedVolumes: Array<{
    volumeId: VoxelVolumeId;
    chunks: Array<{ coordinate: Vec3i; revision: number }>;
    bounds?: IntAabb;
  }>;
  label?: string;
}
```

Consumers re-read a revisioned immutable snapshot. Async consumers process events in revision order. Worker requests and results carry volume/chunk revision plus `live | preview:<sessionId>` namespace tokens, and stale results are discarded regardless of completion order. Full-session lifecycle events (`DocumentOpened`, `DocumentReplaced`, `DocumentClosed`) are a separate namespace and cause projections to dispose/rebind instead of masquerading as ordinary commits.

The semantic commit is intentionally separate from durable recovery I/O. An ordered journal writer appends committed events/transactions and tracks `lastJournaledRevision`. If append fails, the in-memory edit remains valid and dirty, the UI reports degraded crash recovery, and retry/snapshot is scheduled; the revision is never claimed durable until confirmed. The MVP does not block command execution on a filesystem write-ahead log.

Undo executes stored inverses in reverse command order as one special transaction. Redo replays original commands. A new normal commit clears redo. Coalesced drag commands remain individually deterministic but can replace a pending history entry until pointer-up. Saved-file checkpoints and bounded history memory are tracked separately.

### 5.5 Hashing and deterministic verification

Define `canonicalDocumentHash` as SHA-256 over a documented semantic projection of canonical document data plus sorted uncompressed chunk values. Exclude the hash/checksum field itself, runtime revisions, ZIP bytes/compression, timestamps, permissions, audit/history/recovery data, UI state, and previews. CRC32 is only a fast corruption/truncation detector for journal/container frames, never semantic identity. Every command golden test executes the same starting fixture and command stream at least twice, across fresh processes and supported OSes for release fixtures, then compares semantic hashes and canonical payload bytes. Import/export round trips compare semantic hashes, with documented losses for external formats.

If `.vxl` promises byte-identical output for the same writer version, normalize ZIP timestamps, permissions/platform flags, UTF-8 paths, entry order, compression codec/version/level, and extra fields. Across codec versions only the extracted semantic projection is promised stable.

### 5.6 Native container and recovery layout

Freeze the precise v1 layout in `docs/format/vxl-v1.md`; the intended shape is:

```text
project.vxl (ZIP)
├── manifest.json                 # container version, entry index, feature flags, checksums
├── document.json                 # canonical nodes/materials/animations/metadata/descriptors
├── voxels/<volume-id>.bin        # binary header, sorted chunk table, Uint16LE payloads
└── previews/{perspective,front,side,top}.png  # optional, outside semantic hash
```

Each volume binary header carries magic, encoding version, immutable chunk edge, material width, chunk count, codec, offsets/lengths, and checksums. Chunks are coordinate-sorted and empty chunks are omitted. Readers verify path, entry count, compressed and uncompressed sizes, ratios, integer overflow, offsets, dimensions, and checksum before bulk allocation.

Recovery data is not appended inside the ZIP. A stable `RecoverySessionId` exists even for unsaved projects and is reassociated intentionally on Save As/rename; confirmed save/close follows a documented journal-cleanup policy. A per-project recovery area contains a durable snapshot at revision R and length-prefixed journal frames with container/document/command schema versions, revision before/after, canonical committed transaction, and checksum. Snapshot compaction writes and durably renames the new snapshot before truncating old journal data. Recovery scans to the last complete valid frame and replays through normal schemas, command decoder/migrations, and invariants; it reports rather than guesses past a corrupt tail. Recovery restores the asset and then starts a fresh bounded user history in v1; cross-restart undo is not promised.

Atomic native save is same-directory temporary write -> flush/fsync where supported -> atomic replace -> best-effort parent directory sync, retaining a last-known-good backup. Project locking/concurrent-process behavior, symlink/canonical path handling, disk-full/permission failure, and migration backups are acceptance-tested rather than delegated to the ZIP library.

---

## 6. Stage map and high-level dependency DAG

```text
S0 Program/ADRs
 └─> S1 Workspace + math + schemas
      ├─> S2 Scene graph/materials
      └─> S3 Voxel storage/operations
            \        /
             -> S4 Command bus/transactions/history
                    -> S5 Native persistence/recovery
                    -> M1 Headless Engine
                           -> S6 Desktop shell + renderer
                              -> S7 Selection/manual editor
                              -> S8 .vox/native workflows
                                 -> M2 Functional Voxel Editor
                    S2,S4 -> S9 Pivots/rigging/constraints
                    S9 -> S10 Animation runtime/timeline
                              -> M3 Generic Animation
       M2 + M3 -> S11 AI-safe inspection/mutation API
                    -> S12 Agent runtime + AI editing
                    -> S13 AI rigging/animation
                    -> M4 AI-Native Editor
       S3 + S11 -> S14 Skills/procedural generation
       S6 + S12 -> S15 Preview/vision refinement
       M4 + S8 -> S16 glTF/export completeness
       all stages -> S17 hardening/performance/release
                    -> M5 Initial Release
```

Stages describe dependency order, not a requirement that all work be serial. Tasks marked as parallel may proceed once their own dependencies are met.

---

# 7. Detailed implementation stages

## Stage 0 — Program bootstrap and architectural lock

**Goal:** Convert ambiguous PRD points into reviewable contracts before implementation.  
**Indicative effort:** 1 week with tech lead + product/design + QA.  
**Exit artifact:** Approved ADR set, threat-model skeleton, UX flows, issue dependency graph.

Accepted core decision records:

- [ADR-0001 — Coordinate, transform, and canonical number semantics](./docs/adr/0001-coordinate-transform-and-canonical-number-semantics.md)
- [ADR-0002 — Authoritative state and mutation capabilities](./docs/adr/0002-authoritative-state-and-mutation-capabilities.md)
- [ADR-0003 — Command, transaction, revision, and history semantics](./docs/adr/0003-command-transaction-revision-and-history-semantics.md)
- [ADR-0004 — Native storage, canonicalization, and versioning](./docs/adr/0004-native-storage-canonicalization-and-versioning.md)
- [ADR-0005 — Package dependency, threading, and adapter boundaries](./docs/adr/0005-package-dependency-threading-and-adapter-boundaries.md)
- [ADR-0006 — Generic articulation and animation runtime](./docs/adr/0006-generic-articulation-and-animation-runtime.md)
- [ADR-0007 — Bounded provider-neutral AI proposals](./docs/adr/0007-bounded-provider-neutral-ai-proposals.md)

ADR-0001, ADR-0005, and ADR-0006 also resolve the core-runtime portions of S0.18: picking ties, region-rotation anchoring and collision, loop endpoints, transparency, constraint order, and non-uniform scale. Product support and operational policies remain in #3.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S0.1 | Confirm MVP boundaries and target OS versions | — | Signed scope includes exact Phase 1–6 features and explicit deferred list |
| S0.2 | Write ADR-001 coordinates/math | S0.1 | Handedness, axes, unit, radians, quaternions, region bounds, negative chunk math fixed |
| S0.3 | Write ADR-002 document/runtime/session ownership | S0.1 | Edit capability, lifecycle replace exception, preview overlay and prohibited write paths approved |
| S0.4 | Write ADR-003 command/transaction/history semantics | S0.3 | Staging, mandatory revisions/idempotency, inversion, coalescing and semantic-commit vs durable-journal policy |
| S0.5 | Write ADR-004 storage/container/versioning | S0.2 | Independent versions, `.vxl` layout, SHA-256/CRC roles, normalized ZIP, snapshot isolation and atomic save selected |
| S0.6 | Write ADR-005 package graph/threading | S0.3 | `model` ownership, command registrars, copied worker buffers, preview/live namespaces and Tauri boundaries |
| S0.7 | Write ADR-006 animation/pivot/constraint semantics | S0.2,S0.3 | Transform formula, interpolation, loop boundaries, constraint order approved |
| S0.8 | Write ADR-007 AI trust boundary | S0.3 | Tool loop, transaction preview/direct-apply policy, budgets, provider abstraction approved |
| S0.9 | Define error taxonomy | S0.4 | Stable error families/codes for validation, conflict, limit, I/O, compatibility |
| S0.10 | Produce primary UX wireflows | S0.1 | Create/edit/save/undo, rig/animate, AI apply/discard, conflict and recovery flows |
| S0.11 | Establish performance benchmark matrix | S0.1 | Target devices/assets, frame and remesh metrics, memory budgets, measurement method |
| S0.12 | Seed threat model | S0.5,S0.8 | Assets: files, keys, prompts; trust boundaries and abuse cases listed |
| S0.13 | Convert this plan into tracked epics | S0.1 | Each task has owner, estimate, dependency, status, acceptance criteria |
| S0.14 | Freeze platform/support matrix | S0.1 | Minimum OS/CPU/RAM/WebGL2/GPU, reference and low-tier machines, HiDPI/input, offline/accessibility support |
| S0.15 | Freeze resource-limit defaults | S0.4,S0.11 | Coordinate/dimension/node/chunk/voxel/material/command/history/file/metadata/track/keyframe/AI step-token-time-cost limits and rejection/confirmation policy |
| S0.16 | Approve cloud/provider/privacy policy | S0.8,S0.12 | Supported provider, user consent, transmitted fields/images, retention, telemetry, offline degradation and disclosure UI |
| S0.17 | Freeze native/external format compatibility matrix | S0.5,S0.14 | Backward window, project locking, `.vox` axis/palette subset, glTF unit/pivot/material/animation rules |
| S0.18 | Freeze ambiguous editing/runtime semantics | S0.2,S0.7 | Picking tie-break, region rotation center/collision, loop endpoint, transparency, constraint order and non-uniform scale behavior |

**Stage gate:** No core coding until ADRs 001–005 and the applicable blocking decisions S0.14–S0.18 are accepted. ADR 006 must land before rigging; ADR 007 before agent work.

---

## Stage 1 — Monorepo, shared contracts, math, and quality baseline

**Goal:** A strict, reproducible workspace with tested deterministic primitives.  
**Indicative effort:** 1–2 weeks.  
**Exit artifact:** CI-green packages and published internal API docs.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S1.1 | Initialize pnpm/Turbo workspace | S0.5,S0.6 | Workspace scripts for build, typecheck, lint, test, format, clean |
| S1.2 | Scaffold package directories and exports | S1.1 | No deep cross-package imports; ESM build works in Node and Vite |
| S1.3 | Configure strict TypeScript | S1.1 | `strict`, no unchecked indexed access, exact optional properties, no implicit override |
| S1.4 | Configure lint/format/import boundaries | S1.2 | ESLint catches cycles, forbidden dependencies, floating promises, unsafe `any` |
| S1.5 | Configure Vitest and testkit | S1.2 | Fixed-ID/seed factories, canonical assertions and coverage reporting |
| S1.6 | Add CI foundation | S1.3–S1.5 | lockfile install, lint, types, unit tests, build and cycle check required on PRs |
| S1.7 | Implement branded IDs and primitive schemas | S0.9,S1.3 | Node/volume/material/animation/command IDs and parse helpers; no accidental mixing |
| S1.8 | Implement `Result` and structured errors | S0.9,S1.7 | Serializable errors with code/path/context/cause redaction |
| S1.9 | Implement vector/integer vector operations | S0.2,S1.5 | Vec2/3, Vec3i, finite checks, exact integer checks, golden tests |
| S1.10 | Implement quaternion operations | S1.9 | normalize/canonicalize/multiply/invert/slerp/Euler conversion with edge tests |
| S1.11 | Implement matrices/transforms/AABBs/rays | S1.9,S1.10 | compose/decompose, local/world, pivot formula, AABB and ray helpers tested |
| S1.12 | Implement chunk coordinate helpers | S1.9 | floor division/modulo across negative boundaries property-tested |
| S1.13 | Implement canonical JSON utility | S1.5,S1.7 | Stable object-key/record ordering, numeric validation, deterministic bytes |
| S1.14 | Add API documentation generation | S1.2 | Typedoc or equivalent for exported contracts; docs build in CI |
| S1.15 | Add licensing/dependency audit | S1.1 | Dependabot/Renovate, license allowlist, vulnerability scan baseline |

**Acceptance tests:** math inverse/property tests; quaternion `q`/`-q` canonicalization; coordinates around `-17..17`; non-finite numbers rejected; repeated canonical serialization byte-identical.

---

## Stage 2 — Versioned document, materials, and scene graph

**Goal:** A renderer-free validated asset model and generic hierarchy.  
**Indicative effort:** 2 weeks.  
**Exit artifact:** Headless scene graph capable of the PRD example hierarchies.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S2.1 | Scaffold `model` and define `VoxelDocument` v1 | S1.7,S1.13 | Complete persisted root schema and independent `documentSchemaVersion`; no evaluator dependency |
| S2.2 | Define `Transform` and node schemas | S1.10,S1.11,S2.1 | Defaults, finite checks, non-zero scale policy, ordered children |
| S2.3 | Define complete component discriminated union | S2.1 | voxel/pivot/joint/constraint/metadata structural schemas, singleton/multi-instance policy and stable IDs without domain types |
| S2.4 | Define metadata policy/schema | S2.1 | JSON-only, max bytes/depth/key count; inert to core behavior |
| S2.5 | Define extensible material v1 | S2.1 | Name/color/opacity/roughness/metallic/emissive ranges and ID allocation rules |
| S2.6 | Implement document factory/clone/read view | S2.1–S2.5,S2.14 | Fixed defaults, caller-supplied IDs, accessors/copies that expose no mutable typed-array backing storage |
| S2.7 | Implement hierarchy queries | S2.2 | ancestors, descendants, roots, path, preorder, subtree, find-by-tag |
| S2.8 | Implement graph validation | S2.2,S2.7 | Detect missing parent/child, duplicates, self-parent, cycles, disconnected inconsistencies |
| S2.9 | Implement local/world transform queries | S1.11,S2.7 | Correct parent composition; dirty cache is runtime-only and invalidates descendants |
| S2.10 | Implement document invariant validator | S2.3,S2.5,S2.8,S2.14 | Cross-reference and structural resource-limit validation with stable errors |
| S2.11 | Establish migration registry | S2.1 | `vN -> vN+1`, no skipping, fixtures retained, unknown future version safe |
| S2.12 | Create model fixtures | S2.6 | house, vehicle, abstract hierarchy fixtures prove genericity; no renderer dependency |
| S2.13 | Add public summary/query service | S2.7,S2.9 | Bounded hierarchy/material/node summaries reusable by UI and later agent API |
| S2.14 | Define complete persisted animation DTOs | S2.1,S2.2 | clip/track/keyframe/target/property/value/interpolation structures and stable IDs; semantic sampling comes later |

**Acceptance tests:** cycle creation rejected; world transforms after nested parent operations; metadata cannot alter behavior; malformed references report paths; model serializes canonically; no core symbol contains prohibited domain names.

---

## Stage 3 — Sparse voxel storage, operations, and queries

**Goal:** Efficient deterministic geometry independent of rendering.  
**Indicative effort:** 3–4 weeks.  
**Exit artifact:** Chunked volumes supporting every required core operation with compact change sets.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S3.1 | Define volume/chunk APIs and limits | S0.5,S1.12,S2.1 | 16³ chunk contract, signed coords, uint16 values, max extents/count configuration |
| S3.2 | Implement sparse `VoxelVolume` repository | S3.1 | Lazy chunk create/remove, X-fastest arrays, private mutation capability |
| S3.3 | Implement get/set/remove primitives | S3.2 | Negative coords, empty material rule, chunk revision and empty reclamation |
| S3.4 | Implement occupied bounds/count caches | S3.3 | Correct invalidation and lazy recompute; empty volume semantics defined |
| S3.5 | Implement box/sphere/cylinder iterators | S1.9,S3.3 | Inclusive geometric definitions documented; clipping and limit preflight |
| S3.6 | Implement set/remove batches | S3.3 | Stable duplicate-coordinate policy, sorted processing, bounded payloads |
| S3.7 | Implement fill operations | S3.5 | box/sphere/cylinder with deterministic voxelization golden fixtures |
| S3.8 | Implement paint/replace material | S3.4 | Region and source material filters; missing materials handled by command layer |
| S3.9 | Implement copy/delete operations | S3.6 | Snapshot source before overlapping destination writes; half-open region API |
| S3.10 | Implement translate region | S3.9 | Overlap-safe, explicit collision mode (`overwrite` MVP), compact inverse data |
| S3.11 | Implement rotate region | S3.9 | Exact 90° integer rotations initially; arbitrary rotation explicitly deferred/resampling policy documented |
| S3.12 | Implement mirror region | S3.9 | X/Y/Z plane with exact origin semantics and overwrite policy |
| S3.13 | Implement voxel/region queries | S3.4 | bounded `getVoxels`, occupied bounds, count/material histogram, ray traversal |
| S3.14 | Implement dirty-neighbor calculation | S3.3 | Face neighbors only on boundary occupancy/visibility changes |
| S3.15 | Implement compact `VoxelChangeSet` | S3.6–S3.12 | Old/new runs or chunk patches; invertible without full document snapshots |
| S3.16 | Add property/fuzz tests | S3.3–S3.15 | op+inverse identity, mirror twice, four rotations, translate round trip when non-colliding |
| S3.17 | Add storage microbenchmarks | S3.7,S3.15 | 100k/500k/1M population, random edits, bounds, memory baseline captured |

**Key rules:** primitive volume methods are internal write-capability APIs; public product mutations arrive in Stage 4 commands. Shape voxelization is frozen by golden coordinate lists before AI depends on it.

---

## Stage 4 — Command registry, transactions, revisions, undo/redo

**Goal:** Establish the only persistent mutation path.  
**Indicative effort:** 3–4 weeks.  
**Exit artifact:** Fully tested headless command engine with atomic history.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S4.1 | Implement registry and versioned handler contract | S1.8,S2.10,S3.15 | Duplicate registration rejected; unknown types/versions safe |
| S4.2 | Implement private mutable store + public read view | S2.6,S3.2 | Direct writes unavailable from UI/agent package exports |
| S4.3 | Implement copy-on-write transaction overlay | S4.2 | Nodes/records/chunks staged lazily and discarded on error |
| S4.4 | Implement sequential parse/validate/execute pipeline | S4.1,S4.3 | Later commands see earlier staged effects; no subscriber event pre-commit |
| S4.5 | Implement aggregate validation and atomic commit | S2.10,S4.4 | Revision increments once; one immutable commit event contains change hints |
| S4.6 | Implement limits, mandatory expected revision and idempotency | S4.4 | Source budgets, stale `REVISION_CONFLICT`, duplicate ID policy, explicit undo/redo/recovery revision behavior |
| S4.7 | Implement history manager | S4.5 | past/present/future semantics, bounded byte budget, saved checkpoint marker |
| S4.8 | Implement undo/redo transaction paths | S4.7 | inverse order correct, redo cleared by new edit, revision behavior documented |
| S4.9 | Implement transaction labels/source/correlation | S4.5 | Non-authoritative audit metadata; AI multi-step operation is one history item |
| S4.10 | Implement drag coalescing API | S4.7 | begin/update/end gesture, pointer cancel rollback, one human-visible history entry |
| S4.11 | Register node/hierarchy commands | S4.4,S2.8 | create/delete/rename/reparent/set transform; preserve-world payload carries canonical final local TRS; only supported discriminants, no generic bypass |
| S4.12 | Register material commands | S4.4,S2.5 | create/update/delete with reference-safe replacement policy |
| S4.13 | Register voxel commands | S4.4,S3.7–S3.15 | set/batch/fills/paint/replace/copy/delete/move/rotate/mirror |
| S4.14 | Implement journal-safe command codec | S4.1 | JSON schema versions, max envelope bytes, canonical encoding, parse errors |
| S4.15 | Implement commit subscription API | S4.5 | Read-only after-commit events; subscriber exception cannot corrupt store |
| S4.16 | Add command conformance test harness | S4.8,S4.14 | Shared suite: valid, invalid, inverse, redo, serialization, determinism, edge, rollback |
| S4.17 | Run every command through conformance suite | S4.11–S4.13,S4.16 | 100% registered persistent commands declare tests and inverse policy |
| S4.18 | Add command-stream hash goldens | S4.14,S1.13 | repeated/replayed fresh-process and cross-OS streams yield identical semantic hashes/canonical payloads |
| S4.19 | Implement command decoder/migration registry | S4.14,S2.11 | Version-by-version journal command decoding; old recovery fixtures remain replayable or fail with explicit compatibility result |

**Stage gate / architecture test:** lint tests intentionally attempt direct mutation from UI/agent-style consumers and must fail at compile time. A transaction containing a valid command followed by an invalid command must leave bytes, revision, history, and emitted events unchanged.

---

## Stage 5 — Native `.vxl` persistence, autosave, journal, and recovery

**Goal:** Durable, versioned, crash-safe project files before the visual editor depends on them.  
**Indicative effort:** 2–3 weeks.  
**Exit artifact:** Golden `.vxl` format and tested recovery workflow.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S5.1 | Specify `.vxl` container/encoding versions | S0.5,S2.11,S3.1 | Independent container/document/voxel/command versions, SHA-256/CRC32 roles, normalized ZIP metadata, limits and paths |
| S5.2 | Implement manifest codec | S2.10,S1.13 | Canonical read/write and detailed compatibility errors |
| S5.3 | Implement binary chunk codec | S3.2,S5.1 | Little-endian uint16, sparse chunk index, checksum, size preflight |
| S5.4 | Implement streaming/limited container reader | S5.2,S5.3 | Reject path traversal, zip bombs, duplicates, oversized entries before allocation |
| S5.5 | Implement deterministic container writer | S5.2,S5.3 | Stable entry order/content; preview files excluded from semantic hash |
| S5.6 | Implement `RecoveryStoragePort` / file service | S0.6 | open/save/save-as/recovery interfaces with memory adapter; no Tauri dependency |
| S5.7 | Implement Node filesystem test adapter | S5.6 | same-directory temp, fsync/rename/backup and fault injection; M1 remains Tauri-free |
| S5.8 | Implement debounced autosave snapshots | S4.15,S5.7,S5.14 | Revision/hash snapshot isolation, cancellation, stale completion, failure notification and no overlapping writes |
| S5.9 | Implement ordered append-only recovery writer | S4.15,S4.19,S5.7 | Base hash/revision, checksummed frames, `lastJournaledRevision`, retry/degraded-durability state and flush policy |
| S5.10 | Implement recovery discovery/replay | S5.8,S5.9 | Load snapshot, replay valid complete records, stop/report corrupt tail, user approval |
| S5.11 | Implement migrations and backup-on-upgrade | S2.11,S5.4 | Old fixtures migrate; original is never overwritten before successful save |
| S5.12 | Add corrupt/adversarial file fixtures | S5.4 | truncation, checksum, huge lengths, cycles, missing chunks, future version, zip traversal |
| S5.13 | Add persistence/recovery E2E tests | S5.7–S5.11,S5.14,S5.15 | crash/failure boundaries, edit-during-save races, lifecycle replacement and semantic/byte-stability promises |
| S5.14 | Implement immutable revision snapshot isolation | S4.3,S5.5 | Retain COW records/chunks for async writer; capture `(R, H_R)` and mark clean only if the live hash equals captured `H_R`; stale completion cannot clear dirty state |
| S5.15 | Implement `DocumentSession` lifecycle coordinator | S2.10,S5.4,S5.10 | validated new/open/recovery/replace/close; events reset history/redo/selection/runtime/workers/autosave binding; recovery-session Save As reassociation |

### Milestone M1 — Headless Engine

**Requires:** S1–S5 complete.  
**Demo:** A Node script builds a generic multi-node voxel asset solely with commands, saves `.vxl`, reloads it, compares canonical hashes, undoes/redoes a transaction, and recovers a journal after simulated crash.  
**Gate:** no React, Three.js, or LLM dependency is loaded by the demo.

---

## Stage 6 — Desktop shell, scene projection, meshing, and viewport

**Goal:** Render the authoritative model efficiently without allowing renderer state to become authoritative.  
**Indicative effort:** 4–5 weeks.  
**Exit artifact:** Desktop viewport with incremental meshing, cameras, picking, and metrics.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S6.1 | Scaffold Tauri/Vite/React desktop app | S1.1,S5.6 | Development/build/package on supported OS; strict CSP and minimum allowlist |
| S6.2 | Build application service composition root | S4.15,S5.15,S6.1,S6.18 | Store/bus/session/file/renderer/editor services injected; lifecycle reset/rebind; no global mutable engine singleton |
| S6.3 | Implement renderer scene adapter | S2.9,S5.15,S6.2 | Node IDs map to `Object3D`; commit/runtime updates are incremental, lifecycle replace fully disposes/rebinds |
| S6.4 | Define chunk mesh input/output DTO | S3.14,S0.6 | Copied immutable chunk+halo transfer buffer (never authoritative backing memory), live/preview namespace, revision, cancellation/stale semantics |
| S6.5 | Implement face-culling mesher | S3.2,S6.4 | No hidden internal faces; neighbor sampling across chunk boundaries; material groups |
| S6.6 | Implement meshing worker pool | S6.4,S6.5 | bounded queue, copied transferables, `{namespace,volume,coord,revision}` stale rejection, cancellation release and error recovery |
| S6.7 | Implement chunk geometry lifecycle | S6.3,S6.6 | create/update/dispose GPU geometry/material resources without leaks |
| S6.8 | Implement dirty-chunk scheduler | S3.14,S4.15,S6.6 | prioritize visible chunks, deduplicate revisions, budget main-thread uploads |
| S6.9 | Implement material renderer adapter | S2.5,S6.3 | color/opacity/PBR mapping, shared resources, disposal, fallback error material |
| S6.10 | Implement perspective/orthographic camera controller | S6.1 | orbit/pan/zoom, mode switch preserving target, configurable speeds |
| S6.11 | Implement standard views and focus selection hook | S6.10 | front/back/left/right/top/bottom with correct +Z convention |
| S6.12 | Implement node and voxel picking | S6.3,S6.7 | ID mapping and voxel hit/face computed deterministically; handles negative/scaled nodes |
| S6.13 | Implement grid, axes, bounds and pivot overlays | S6.3 | non-persistent helpers with depth/render-order policy |
| S6.14 | Add viewport diagnostics | S6.7,S6.8 | FPS, draw calls, triangles, queue length, mesh times, memory estimates in dev mode |
| S6.15 | Add render lifecycle tests | S6.3–S6.9 | source chunk remains readable/byte-identical after dispatch; removal/replacement disposes; stale live/preview result never wins |
| S6.16 | Add benchmark scenes | S6.14 | 100k/500k/1M assets and localized/boundary edit scenarios reproducible |
| S6.17 | Implement greedy meshing | S6.5,S6.16 | gated by correctness goldens; significant triangle reduction documented |
| S6.18 | Implement Tauri storage/recovery adapter | S5.6,S5.7,S6.1 | Rust-validated scoped paths, atomic save/journal, backup/fsync policy, error parity with Node fault tests |

**Performance gate:** 100k reference asset is interactively editable at target refresh on reference hardware; a one-voxel edit rebuilds at most the edited chunk plus necessary face neighbors; meshing does not synchronously block the UI beyond the agreed frame budget.

---

## Stage 7 — Editor state, selection, manual tools, and panels

**Goal:** A complete human-operable editor whose actions compile to commands.  
**Indicative effort:** 5–7 weeks, with UI and tool work parallelized.  
**Exit artifact:** Functional voxel editor before AI or animation.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S7.1 | Define non-persistent `EditorState` | S6.2 | selection, hover, tool, camera, layout, draft gesture; asset save excludes it |
| S7.2 | Implement node/voxel/region/multi-selection | S6.12,S7.1 | click/add/toggle/clear, selection pruning after delete, region bounds display |
| S7.3 | Implement editor tool interface | S4.10,S7.1 | pointer/key lifecycle, preview state, command construction, cancel/commit contract |
| S7.4 | Implement select tool | S7.2,S7.3 | node/voxel modes and modifier behavior |
| S7.5 | Implement pencil/erase tools | S7.3,S6.12 | drag rasterization without gaps; one transaction/history entry per stroke |
| S7.6 | Implement paint/eyedropper | S7.3,S2.5 | paint command and read-only sample; invalid deleted material handled |
| S7.7 | Implement box tool | S7.3,S3.7 | live non-authoritative preview and single fill command on commit |
| S7.8 | Implement node move/rotate/scale gizmos | S7.3,S4.10 | local/world modes, snapping, finite values, pointer-cancel restoration |
| S7.9 | Implement pivot tool | S6.13,S7.3 | visual edit through pivot command; geometry/world behavior matches ADR |
| S7.10 | Build application shell layout | S6.1 | toolbar, hierarchy/material left panel, viewport, inspector, timeline placeholder, AI placeholder |
| S7.11 | Build hierarchy panel | S7.2,S4.11 | create/delete/rename/reparent drag with cycle feedback; all actions commands |
| S7.12 | Build inspector | S4.11,S7.2 | transform/component/metadata editing, mixed multi-select state, validated commit on blur/Enter |
| S7.13 | Build materials panel | S4.12,S7.6 | create/edit/delete/reassign, color controls, usage counts |
| S7.14 | Implement command history UI | S4.7,S7.10 | undo/redo labels, shortcuts, dirty/save indicator, error notifications |
| S7.15 | Implement keyboard/shortcut service | S7.3 | platform conventions, remappable command IDs, text-input conflict handling |
| S7.16 | Implement save/open/recent/recovery UI | S5.10,S5.14,S5.15,S6.18,S7.10 | unsaved/pending-save prompts, stale save completion, recovery choice, errors and progress/cancel |
| S7.17 | Accessibility pass | S7.10–S7.16 | keyboard panel navigation, labels, focus visibility, contrast, reduced motion |
| S7.18 | UI integration/E2E suite | S7.4–S7.16 | create/edit/select/reparent/material/undo/save/reopen workflows |
| S7.19 | Add later geometry tools | S7.7 | line/sphere/cylinder/mirror/selection transform; extrude/inset only after semantics ADR |

**UX correctness rule:** tool previews may be local/transient; pointer-up creates commands. Gizmo drag updates may execute coalesced commands, but direct model assignment is forbidden.

---

## Stage 8 — Native workflow and MagicaVoxel import/export

**Goal:** Finish the non-animated editor’s initial interchange workflows.  
**Indicative effort:** 2–3 weeks.  
**Exit artifact:** `.vxl`, `.vox`, and preview PNG user workflows.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S8.1 | Research/freeze supported `.vox` subset | S0.1 | Version/chunks, palette, transforms, scene graph, size and unsupported-feature policy |
| S8.2 | Implement defensive `.vox` parser | S5.4,S8.1 | Length/depth/count limits and structured unsupported/corrupt errors |
| S8.3 | Map `.vox` to generic document via import transaction | S4.11–S4.13,S8.2 | coordinate/material conversion explicit; no direct bypass of invariants |
| S8.4 | Implement `.vox` exporter | S3.4,S8.1 | axis/palette/size limitations reported before write; deterministic fixtures |
| S8.5 | Implement PNG preview renderer/export | S6.3,S6.10,S6.18 | fixed dimensions/background/camera presets, atomic scoped file write |
| S8.6 | Add format fixture corpus | S8.2–S8.5 | known files, malformed files, round trips, coordinate/color goldens |
| S8.7 | Build import/export UI | S7.16,S8.3–S8.5 | progress, warnings, cancellation, overwrite confirmation |

### Milestone M2 — Functional Voxel Editor

**Requires:** S6–S8 complete.  
**Demo:** A user creates a multi-node asset with negative-coordinate voxels, uses all MVP tools, changes hierarchy/materials, undoes/redoes, saves/reopens `.vxl`, imports/exports `.vox`, and exports a PNG.  
**Gate:** usable without network, account, LLM, or animation.

---

## Stage 9 — Generic pivots, joints, hierarchy runtime, and constraints

**Goal:** Add domain-neutral articulation primitives without a humanoid skeleton.  
**Indicative effort:** 2–3 weeks.  
**Exit artifact:** Door, wheel, robot arm, and wing rigs use the same APIs.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S9.1 | Implement pivot/joint/constraint semantic validators | S0.7,S2.3 | Stage-2 DTO semantics frozen; single transform hierarchy authoritative; any schema change bumps document version+migration |
| S9.2 | Implement pivot-aware transform evaluation | S2.9,S9.1 | formula matches math/render goldens under rotation/scale/parents |
| S9.3 | Register joint component lifecycle commands | S4.16,S9.1 | Per-discriminant create/remove/update validation, conformance suite, no separate skeleton graph |
| S9.4 | Register rotation constraint semantics/commands | S9.1,S4.16 | local XYZ limits, stable IDs/order, finite min<=max; automatic conformance suite |
| S9.5 | Implement constraint evaluator | S9.2,S9.4 | pure runtime clamp after animation/local transform input; does not mutate document |
| S9.6 | Integrate rig runtime with renderer | S6.3,S9.5 | evaluated transforms update objects while base document remains unchanged |
| S9.7 | Build joint/constraint inspector | S7.12,S9.3–S9.5 | add/remove/edit, limit feedback and visual axes/arcs |
| S9.8 | Build pivot/joint overlays | S6.13,S9.6 | selection-aware, scalable, pickable where required |
| S9.9 | Create generic rig fixtures | S9.6 | chest lid, wheel, 3-link arm, bilateral wings, abstract sculpture |
| S9.10 | Add transform/constraint tests | S9.2–S9.6 | parent+pivot+scale, wrap boundaries, constraint enforcement/order, no document mutation |

**Design constraint:** hierarchy controls transform inheritance. A joint component annotates/articulates a node; it must not introduce a second parent graph that can disagree with `parentId`.

---

## Stage 10 — Property animation runtime and timeline

**Goal:** Deterministic non-destructive animation editing and playback.  
**Indicative effort:** 4–5 weeks.  
**Exit artifact:** Generic clips animate any transformable node.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S10.1 | Freeze clip/track/keyframe semantic policy | S0.7,S2.14,S9.1 | Validate stable IDs, targets/properties, sorted unique times, duration/loop; schema changes require migration/goldens |
| S10.2 | Implement animation invariant validation | S10.1,S2.10 | target/property/value type, finite/range/time/duration/keyframe limit checks |
| S10.3 | Implement track sampling | S1.10,S10.1 | step, vector lerp, shortest quaternion SLERP, ease curve, exact endpoints |
| S10.4 | Implement clip time/loop evaluation | S10.3 | negative/out-of-range policy, duration boundary, zero-duration rejection |
| S10.5 | Implement layered runtime transform evaluator | S9.5,S10.4 | base document + animation override + constraints -> runtime; hierarchy world pass |
| S10.6 | Register clip/track/keyframe commands | S4.16,S10.2 | CRUD/set/move/delete handlers automatically run full command conformance and migration checks |
| S10.7 | Implement playback controller | S10.5 | play/pause/stop/loop/scrub; stop restores base; clock injectable for tests |
| S10.8 | Integrate playback with renderer | S9.6,S10.7 | no command/history/revision per frame; only runtime scene updates |
| S10.9 | Build timeline state/model | S10.6,S10.7 | zoom/scroll/playhead/selection/snap, separate from asset data |
| S10.10 | Build transport and track list UI | S10.9 | play/pause/stop/loop/scrub and hierarchy-linked tracks |
| S10.11 | Build keyframe editing UI | S10.6,S10.9 | create/delete/move, multi-select, snap, interpolation choice; commands on edits |
| S10.12 | Implement auto-key/manual key workflow | S7.8,S10.6 | clear mode indication; transform changes target base or selected clip intentionally |
| S10.13 | Build animation inspector | S10.6 | clip name/duration/loop and keyframe value editing with validation |
| S10.14 | Add animation conformance suite | S10.3–S10.8 | interpolation, loops, parent transforms, pivots, constraints, multiple tracks, immutability |
| S10.15 | Build definition-of-done animation demos | S10.8–S10.13 | door, wheel, robot arm, simple character; also wings and abstract animation |

### Milestone M3 — Generic Animation Editor

**Requires:** S9–S10 complete.  
**Demo:** The same runtime opens a constrained chest lid, continuously spins a wheel, moves a linked robot arm, and flaps wings. Stop restores base transforms; editing and undo of keyframes work.  
**Gate:** no asset-specific core component or animation primitive was added.

---

## Stage 11 — AI-safe inspection and mutation API

**Goal:** Build a model-independent, schema-driven tool surface over read services and commands.  
**Indicative effort:** 3 weeks.  
**Exit artifact:** Tools can be exercised deterministically with no LLM.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S11.1 | Define provider-neutral tool contract | S0.8,S1.8 | JSON Schema name/description/input/output/error, version and capability flags |
| S11.2 | Implement bounded document summary | S2.13,S3.13,S7.2,S10.1,S11.14 | persisted summary plus injected selection/editor context and revision within token/byte budget |
| S11.3 | Implement inspection tools | S11.1,S11.2 | persisted queries plus `getSelection` via `EditorContextPort`, all paginated/bounded |
| S11.4 | Implement spatial query tools | S3.13,S2.9 | bounded voxels, raycast, tag search, distance, local/world transform |
| S11.5 | Implement command-constructor tools: scene/material | S4.11,S4.12,S11.1 | IDs explicit/generated before command, same schemas/errors as UI |
| S11.6 | Implement geometry tools | S4.13,S11.1 | coarse fill/mirror/move/paint/batch APIs; discourage excessive `setVoxel` |
| S11.7 | Implement rigging tools | S9.3,S9.4,S11.1 | pivot/joint/constraint operations compile only to registered commands |
| S11.8 | Implement animation tools | S10.6,S11.1 | clip/track/keyframe operations compile only to registered commands |
| S11.9 | Implement tool authorization/capability registry | S11.1 | session exposes only phase/user-enabled tools; inspection distinct from mutation |
| S11.10 | Implement tool budgets and response truncation | S4.6,S11.3–S11.8 | calls, commands, voxel estimates, output bytes, duration, keyframes; stable limit errors |
| S11.11 | Implement temporary transaction facade | S4.3,S4.6 | mandatory base revision, stage/validate/diff, optimistic one-commit Apply or rollback; no live side effects |
| S11.12 | Add deterministic mock-tool tests | S11.3–S11.11,S11.14,S11.15 | malformed arguments, missing refs, selection port, preview isolation, conflicts, limits, rollback/minimal diff |
| S11.13 | Generate tool documentation | S11.1 | machine JSON schemas and human examples generated from one source |
| S11.14 | Define injected `EditorContextPort` | S7.2,S11.1 | Desktop supplies selection/active clip/tool snapshots; agent package does not import editor implementation |
| S11.15 | Implement `PreviewSession` read model | S11.11 | COW overlay queries see staged state; isolated revision/event namespace; release on Apply/Discard/cancel |

**Security gate:** tools cannot accept source code, shell strings, unrestricted paths, arbitrary URLs, or renderer objects. Inspection outputs are bounded and contain stable IDs plus coordinate conventions.

---

## Stage 12 — Agent runtime and AI geometry editing

**Goal:** Natural-language inspection and minimal geometry edits through a bounded transaction loop.  
**Indicative effort:** 4–6 weeks, variable by provider/UI.  
**Exit artifact:** AI editing for chair/shorter legs/red seat/mirror prompts with reliable undo.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S12.1 | Define agent state machine | S0.8,S11.15 | understand -> inspect -> plan -> stage -> inspect staged -> validate -> approve/commit; cancel/error states |
| S12.2 | Implement LLM provider interface | S11.1 | streaming text, structured tool calls, cancellation, usage, normalized errors |
| S12.3 | Implement one initial provider adapter | S12.2 | retries only when safe, timeouts, tool-call validation, no vendor types outside adapter |
| S12.4 | Implement credential service | S6.1,S0.12 | OS keychain, explicit consent, redaction; project never contains secret |
| S12.5 | Implement bounded agent loop | S11.9–S11.11,S12.2 | max rounds/tokens/tool calls/time, cancellation, repeated-error cutoff |
| S12.6 | Implement context builder | S11.2,S7.2 | selection-first summary, revision, coordinate help, recent relevant actions; no full voxel dump |
| S12.7 | Implement planning/minimal-diff policy prompt | S12.5,S12.6 | inspect existing state, preserve unrelated content, coarse semantic ops, no authoritative JSON state |
| S12.8 | Implement direct vs preview policy | S11.15,S12.5,S12.15 | configurable risk threshold; large changes switch projection and require Apply/Discard; small changes still one undo |
| S12.9 | Implement revision conflict flow | S4.6,S12.8 | never silent rebase; discard/reinspect/replan options and human message |
| S12.10 | Build integrated AI panel | S7.10,S12.5,S12.8,S12.15 | prompt, progress/tool activity, cancel, errors, preview/diff, Apply/Discard, history label |
| S12.11 | Implement safe transcript/diagnostics | S12.5 | opt-in retention, prompt/tool redaction/export; no secret/full hidden project leakage |
| S12.12 | Create fixed geometry evaluation harness | S11.12,S12.5 | deterministic starting docs/prompts, tool logs, structural metrics, preview artifacts |
| S12.13 | Tune and pass initial edit scenarios | S12.7,S12.12 | chair creation, shorter legs, red seat, left-side mirror; acceptable tool error/limit rates |
| S12.14 | Add offline/no-key UX | S12.10 | editor remains fully usable; clear provider configuration and network state |
| S12.15 | Implement preview renderer projection | S6.3,S6.6,S11.15 | Switch/secondary scene reads overlay events/queries, uses preview job namespace, disposes without live revision/history/autosave effects |

**Commit semantics:** an AI run owns a working transaction with `baseRevision`. Tool successes mutate only the overlay. `Apply` atomically commits one labeled history entry; `Discard` drops it. Direct-apply mode uses the same mechanism but auto-approves after validation.

---

## Stage 13 — AI rigging and animation

**Goal:** Extend the same agent loop to generic articulation and property animation.  
**Indicative effort:** 3–4 weeks.  
**Exit artifact:** Natural-language chest, wheel, bird, and robot animation workflows.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S13.1 | Add rig inspection context recipes | S11.3,S9.9,S12.6 | hierarchy, pivots, bounds, world transforms, current constraints compactly represented |
| S13.2 | Add animation inspection context recipes | S11.3,S10.14,S12.6 | clip/track/keyframe summary and targeted detail paging |
| S13.3 | Add rig planning guidance | S11.7,S12.7 | separate movable geometry minimally, parent correctly, place pivot from bounds, constrain generically |
| S13.4 | Add animation planning guidance | S11.8,S12.7 | reuse nodes, valid duration/times, quaternion conversion, looping endpoint policy |
| S13.5 | Implement rig/animation preview diff | S12.8,S12.15,S10.8 | visualize staged hierarchy/pivots/tracks and play overlay clip before Apply with no live mutation |
| S13.6 | Add corrective tool loop | S13.1,S13.2,S12.5 | inspect staged result and adjust, within strict iteration/command budget |
| S13.7 | Create rig/animation evaluation fixtures | S9.9,S10.15,S12.12 | unrigged chest, paired wings, robot arm, wheel, abstract node rig |
| S13.8 | Pass target prompts | S13.3–S13.7 | chest open, wheel continuous spin, wings flap, robot idle/arm movement |
| S13.9 | Test follow-up modifications | S13.8 | “open farther/slower”, “only this wing”, “limit elbow”, “make wheel twice as fast” minimally diff existing state |

### Milestone M4 — AI-Native Generic Editor

**Requires:** S11–S13 complete.  
**Demo:** From a selected or empty context, AI creates, inspects, modifies, rigs, animates, modifies the animation, and the user previews, applies, undoes, manually edits, saves, and exports.  
**Gate:** every AI mutation in logs maps to registered commands; conflict and limit tests pass; no direct renderer/document write path exists.

---

## Stage 14 — Skills and procedural generators

**Goal:** Add reusable domain knowledge above generic tools without polluting the engine.  
**Indicative effort:** ongoing; initial set 4–6 weeks.  
**Exit artifact:** Versioned skills that compile to inspectable generic operations.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S14.1 | Define versioned skill manifest | S11.1,S12.1 | name/version/instructions/tools/constraints/template/generator/evaluation metadata |
| S14.2 | Implement skill registry/selection | S14.1 | explicit or classifier-assisted selection, capability check, user-visible active skill |
| S14.3 | Define generator API | S3.7–S3.12,S11.6 | pure parameters -> proposed commands, deterministic seed in payload, preflight estimates |
| S14.4 | Implement generic repetition/symmetry generators | S14.3 | array/repeat/radial/mirror primitives with tests |
| S14.5 | Implement structural generators | S14.3 | stairs/walls/roofs/branches/limb-chain/wheel patterns, all generic outputs |
| S14.6 | Add creation skills | S14.1,S14.4,S14.5 | furniture, architecture, vegetation, vehicle, humanoid, quadruped, flying creature |
| S14.7 | Add rig skills | S14.1,S13.3 | generic recipes for biped/quadruped/wings/mechanical linkages, no new core APIs |
| S14.8 | Add motion skills | S14.1,S13.4 | walk/run/jump/idle/fly/mechanical knowledge expressed as generic tracks/keyframes |
| S14.9 | Add skill provenance and compatibility | S14.2 | skill/version recorded in transaction metadata, not required for document behavior |
| S14.10 | Evaluate each skill | S12.12,S14.6–S14.8 | fixed prompts, structural/animation metrics, visual baselines, token/tool efficiency |
| S14.11 | Add skill authoring docs/tests | S14.10 | schema validation, forbidden engine coupling, command-budget guidelines |

**Boundary test:** removing `packages/skills` must not prevent opening, editing, playing, or exporting any document previously created with a skill.

---

## Stage 15 — Standard previews and bounded vision refinement

**Goal:** Give the agent visual evidence while retaining deterministic command authority.  
**Indicative effort:** 3–5 weeks.  
**Exit artifact:** Opt-in multi-view critique/correction loop.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S15.1 | Specify preview render protocol | S6.5,S12.1 | perspective/front/side/top cameras, framing, light, background, resolution fixed |
| S15.2 | Implement offscreen preview service | S8.5,S15.1 | current or staged document, cancellable, deterministic camera metadata, bounded size |
| S15.3 | Implement vision provider capability | S12.2,S15.2 | images + compact structural context; provider-neutral result schema |
| S15.4 | Define critique schema | S15.3 | view, issue category, affected IDs/region, evidence, suggested generic correction, confidence |
| S15.5 | Implement critique-to-agent loop | S13.6,S15.4 | corrections still use tools/commands; max iterations/cost/delta; user can cancel |
| S15.6 | Add intersection/silhouette deterministic checks | S3.13,S15.2 | use geometry checks before paid vision where feasible |
| S15.7 | Build preview/refinement UI | S12.10,S15.5 | thumbnails, critique, iteration/cost status, Apply/Discard |
| S15.8 | Build visual regression dataset | S12.12,S15.2 | fox/bird/house/vehicle/abstract fixtures; views retained with version metadata |
| S15.9 | Gate regressions and runaway correction | S15.5,S15.8 | hard iteration cap, no oscillating edits, structural metrics may not regress silently |

---

## Stage 16 — glTF and export completeness

**Goal:** Produce useful static and animated assets for common engines.  
**Indicative effort:** 3–4 weeks.  
**Exit artifact:** Validated `.glb/.gltf` static and animated export.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S16.1 | Specify export coordinate/material policy | S0.2,S6.17 | axis/handedness/unit, pivots, node names, material approximation and loss report |
| S16.2 | Build renderer-independent mesh export DTO | S6.5 | positions/normals/indices/material groups and node mapping; no `BufferGeometry` dependency required |
| S16.3 | Implement static glTF/GLB exporter | S16.1,S16.2,S6.18 | hierarchy/meshes/materials, deterministic naming, valid buffers and scoped atomic write |
| S16.4 | Implement animated glTF export | S10.1,S16.3 | nodes and TRS tracks, quaternion rotations, loop metadata limitation documented |
| S16.5 | Handle pivot conversion | S9.2,S16.3 | helper-node or baked strategy preserves motion; golden chest/arm tests |
| S16.6 | Validate in external tooling | S16.3–S16.5 | Khronos validator plus Blender/Three.js and documented Unity/Godot smoke test |
| S16.7 | Add export options/loss report UI | S8.7,S16.6 | static/animated, greedy mesh, selected/all, warnings before write |
| S16.8 | Extend format corpus | S16.6 | static, hierarchy, multiple materials/clips, pivots, negative coordinates fixtures |

---

## Stage 17 — Hardening, optimization, release, and operations

**Goal:** Turn feature-complete software into a supportable release.  
**Indicative effort:** 4–6 weeks plus stabilization.  
**Exit artifact:** Signed multi-platform release satisfying all gates.

| ID | Task | Depends on | Deliverable / acceptance |
|---|---|---|---|
| S17.1 | Profile reference workflows | M4,S16.6 | CPU/GPU/memory traces for load, edit, remesh, playback, save, agent run |
| S17.2 | Optimize proven bottlenecks only | S17.1 | before/after metrics; consider pooling/WASM/Rust only with profile-backed ADR |
| S17.3 | Enforce memory/history budgets | S4.7,S17.1 | chunk/history/preview/worker limits; graceful warnings and eviction/checkpoint policy |
| S17.4 | Stress test large projects | S6.16,S17.3 | 100k interactive, 500k usable, 1M viewable; no catastrophic freeze/crash |
| S17.5 | Run import/file fuzzing | S5.12,S8.6,S16.8 | parsers survive corpus without panic/OOM/path escape |
| S17.6 | Complete threat model/security review | S0.12,S12.11,S17.5 | CSP/IPC/key storage/model data/file parser/update checks and mitigations signed off |
| S17.7 | Complete accessibility/UX review | S7.17,M4 | keyboard, focus, screen-reader labels where practical, contrast, error/recovery usability |
| S17.8 | Complete cross-platform matrix | S6.1,S16.7 | open/edit/save/render/export/AI configuration on supported Windows/macOS/Linux |
| S17.9 | Add crash reporting policy | S12.11 | opt-in, redacted, no project/prompt/secret by default; local diagnostics export |
| S17.10 | Configure signed packaging/updater | S17.6,S17.8 | code signing/notarization, secure update manifests, rollback instructions |
| S17.11 | Define release/migration policy | S5.11,S17.10 | semver, file compatibility, backups, beta channel, release notes |
| S17.12 | Run full AI evaluation suite | S14.10,S15.8 | fixed model/version/settings where possible; quality/cost/error baseline and thresholds |
| S17.13 | Run nine genericity demonstrations | M3,S14.10 | all PRD definition-of-done assets represented with no new core primitives |
| S17.14 | Release candidate soak | S17.4–S17.13 | no blocker defects, recovery drills pass, telemetry/diagnostics verified, sign-off |
| S17.15 | Publish release/support docs | S17.14 | installation, editor/AI/privacy, format backup, known limitations, troubleshooting |

### Milestone M5 — Initial Release

Release only when the quality gates in Section 10 pass, no P0/P1 defects remain, recovery has been tested from induced failures, supported platform packages are signed, and the genericity plus AI end-to-end demonstrations have recorded evidence.

---

## 8. Cross-stage workstreams and parallelization

A practical team can parallelize without breaking the critical path:

| Workstream | Primary stages | Can start when | Coordination boundary |
|---|---|---|---|
| Core/model | S1–S5 | S0 ADRs | Publishes schemas, read views, command APIs |
| Voxel/performance | S3,S6,S17 | S1 math | Publishes storage/query and mesh DTO contracts |
| Desktop/render | S6–S8 | M1 API stable | Consumes commit events; never writes core |
| Rig/animation | S9–S10 | S2/S4 stable + ADR-006 | Pure evaluators before UI integration |
| Agent | S11–S15 | command/query contracts stable | Starts with mock LLM; does not block editor |
| Formats | S5,S8,S16 | schemas/storage stable | File adapters isolated behind interfaces |
| QA/security | every stage | S0 | Builds fixtures, gates, fuzz/eval/perf harnesses continuously |
| Design/accessibility | S0,S7,S10,S12 | S0 | Wireflows and component specs ahead of implementation |

### 8.1 Suggested staffing assumption

For planning only: 1 tech lead/core engineer, 1 voxel/render engineer, 2 desktop/UI engineers, 1 rig/animation engineer, 1 AI engineer, and 1 QA/automation engineer, with product/design part-time. With fewer people, keep the same dependency order and reduce parallelism; do not merge layers to appear faster. Re-estimate after M1 and M2 using measured throughput. Calendar dates should be assigned only after task sizing and staffing are confirmed.

### 8.2 Critical path

`S0 -> S1 -> S2/S3 -> S4 -> S5 -> S6 -> S7 -> S9 -> S10 -> S11 -> S12 -> S13 -> S17`.

`.vox` work, later editor tools, skills, vision, and glTF can partly parallelize, but M2 requires initial `.vox`, M4 requires rig/animation AI, and the release requires glTF and hardening.

---

## 9. Definition of task-ready and task-done

### 9.1 Ready

A task may start when:

- all listed dependencies are complete or a versioned interface mock is approved;
- acceptance criteria and explicit non-goals are understood;
- relevant ADRs and UX design exist;
- test fixtures and performance/security implications are identified;
- ownership and reviewer are assigned.

### 9.2 Done

A task is done only when:

- implementation and public types are reviewed;
- unit/integration tests cover valid, invalid, boundary, and recovery behavior;
- no prohibited dependency or direct mutation path is introduced;
- public behavior/docs/schema are updated;
- errors are structured and user-safe;
- relevant benchmark/security/accessibility checks pass;
- migrations or compatibility notes exist for persistent changes;
- diagnostics do not expose secrets or unbounded document data.

---

## 10. Verification and release quality gates

### 10.1 Test pyramid

1. **Pure unit tests:** math, chunk indexing, shape rasterization, graph and track evaluation.
2. **Property tests:** transformations and inverses, region operations, command+inverse, serializer determinism.
3. **Command conformance:** every registered command runs the same execution/invalid/undo/redo/codec/determinism/rollback suite.
4. **Integration tests:** command store + volume + journal; commit events + mesh scheduler; timeline + runtime; tools + temporary transactions.
5. **Golden fixtures:** canonical JSON/binary bytes, known voxel shapes, mesher output, imports/exports, animation samples.
6. **UI component tests:** panels, input validation, focus/keyboard behavior, error states.
7. **Desktop E2E:** create/edit/rig/animate/save/recover/import/export and AI apply/discard/conflict.
8. **Fuzz/adversarial:** `.vxl`, `.vox`, command/tool JSON, metadata nesting, journal tails.
9. **Performance:** reproducible assets and device matrix; trend history rather than anecdotal FPS.
10. **AI evaluations:** structural metrics and rendered previews, with provider/model/prompt/tool versions pinned in results.

### 10.2 Mandatory CI gates per pull request

- clean locked install and generated schema/lockfile drift check;
- formatting/lint and dependency-boundary/cycle checks;
- strict typecheck for all packages plus Rust `fmt`, `clippy`, and tests once Tauri exists;
- unit/property/integration tests;
- registered-command conformance coverage;
- package and desktop web build;
- schema/format golden diff approval when changed;
- dependency license/security scan;
- affected benchmark smoke test with broad regression threshold;
- no checked-in secret scan;
- CODEOWNERS approval for command/file schemas, migrations, Tauri capabilities, AI safety policy, and signing/updater changes.

Nightly/scheduled CI adds Playwright, native Tauri builds, parser fuzz seeds, larger performance scenes, memory/leak checks, and AI evals when credentials/budget allow.

### 10.3 Coverage policy

Do not use one global percentage as a substitute for correctness. Require 100% registered command conformance participation, 100% migration fixture coverage, explicit branch coverage for transaction rollback and file recovery, and high branch coverage (target 90%+) for pure core packages. UI coverage is risk-based and supplemented with E2E.

### 10.4 Budgets selected in Stage 0 and validated at stage gates

Initial budgets, measured on named reference hardware:

- normal viewport target: 60 FPS at 100k occupied voxels;
- interaction input-to-preview: p95 under 50 ms;
- one-voxel edit command commit: p95 under 8 ms excluding async mesh completion;
- main-thread frame long tasks: no repeated tasks over 50 ms during editing;
- localized chunk face-cull mesh: p95 under 30 ms in worker; greedy target set after baseline;
- 500k asset: usable editing, target >=30 FPS in reference view;
- 1M asset: loads and remains navigable without OOM or multi-second main-thread stalls;
- save/load and memory targets recorded after representative compression benchmark;
- animation evaluation cost scales with active tracks/nodes and stays inside frame budget;
- agent has explicit maximum rounds, commands, voxel modifications, output bytes, time, and estimated cost.

Failures must degrade gracefully: show progress, permit cancellation where safe, retain the last good rendered revision, and never corrupt state.

---

## 11. Security and privacy plan

### 11.1 Threat boundaries

Untrusted inputs include LLM text/tool arguments, `.vxl/.vox/.gltf` files, metadata, filenames, journal files, preview images, clipboard content, and network/provider responses. Trusted code is still constrained by package capabilities.

### 11.2 Required controls

- Validate twice where boundaries differ: tool JSON at the agent boundary, command semantic validity at the bus.
- Treat imported names, tags, metadata, prior transcript text, and tool results as quoted untrusted data, never higher-priority instructions; regression-test indirect prompt injection.
- No `eval`, dynamic JS module execution, shell command tool, arbitrary URL fetch tool, or unrestricted filesystem tool.
- Tauri IPC exposes a minimal allowlist; validate paths/capabilities in Rust, not only UI code.
- Use OS dialogs and scoped handles for project/import/export locations.
- Enforce ZIP entry count, compressed/uncompressed size, ratio, nesting, path, and total allocation limits.
- Enforce node, dimensions, chunks, modified voxels, materials, keyframes, clip duration, command count, metadata depth/size, and tool response limits.
- Store provider keys in OS keychain; redact authorization headers, secrets, prompts, paths, and project contents from default logs/crash reports.
- Make cloud model use explicit and show what context/images will be sent. Local editing remains available without network.
- Apply strict CSP; disable remote content/navigation by default; pin update signatures.
- Cancellation does not mean rollback after commit: UI communicates transaction state precisely.
- Conflicting AI base revisions fail closed. No automatic overwrite or silent merge in MVP.
- Dependency scanning for npm and Cargo, secret scanning, SBOM/license generation, parser fuzzing, signed provenance/update manifests, key-rotation/rollback procedures, and a release threat-model review are mandatory.

### 11.3 AI-specific abuse handling

Model instructions never override command schemas, session tool allowlists, limits, revision checks, approval policy, or filesystem/network boundaries. Tool errors expose enough structured remediation for correction but no stack traces/secrets. Repeated invalid or resource-expanding calls terminate the run. Generated names/metadata are treated as display text and escaped in UI.

---

## 12. AI evaluation specification

Each evaluation records editor build, document/command schema, tool schema, system/skill prompt, provider/model/settings, seed where supported, input fixture hash, token/tool/latency/cost, command log, output document hash, structural metrics, and standardized previews.

### 12.1 Fixed scenario suite

- Create a chair, sword, tree, humanoid robot, quadruped, opening chest, animated windmill, and flapping bird.
- Follow-ups: shorter chair legs, longer sword only, red seat, taller roof, separate and animate an existing door, open chest farther/slower, constrain robot arm, edit one selected wing.
- Adversarial: nonexistent selected ID, stale revision, huge requested city, 1M keyframes, prompt asking for filesystem/shell access, malformed provider tool JSON.

### 12.2 Automatic metrics

- tool call errors and recovery rate;
- invalid commands and validation categories;
- command/tool/round/token counts;
- voxels changed vs estimated and resource-limit compliance;
- hierarchy validity, cycles, orphan/missing references;
- occupied bounds/material counts and requested color presence;
- symmetry score where requested;
- animation target/time/quaternion/loop validity;
- unrelated-node/volume/track change count for minimal-diff prompts;
- transaction atomicity, base revision, history label/source;
- render completion and image similarity/silhouette/intersection signals;
- user approval/discard and follow-up correction success in product trials.

### 12.3 Promotion gates

Split evaluation into two lanes. Deterministic recorded tool traces (valid, invalid, stale, over-budget, cancellation, prompt-injection metadata) run on every PR and require exact expected hashes, permissions, and zero state change for rejected traces. Live-provider cases run nightly or on model/prompt/tool/skill change, use at least three repetitions where budget permits, record variance, and never make credentials/network a PR prerequisite.

Do not rely only on subjective “looks good.” Set baselines after the first harness run; proposed promotion floors are **100% safety/integrity cases, zero partial commits, >=95% schema-valid tool calls, >=90% task-invariant success, and zero over-budget runs**, adjusted only through an approved eval report. Prevent statistically meaningful regression in minimal-diff behavior and tool efficiency. Image/LLM-judge scores remain advisory until calibrated against blinded human ratings. Visual review remains required for a curated set. Changing model, provider behavior, tool descriptions, system prompt, skill, geometry semantics, or renderer protocol triggers relevant reevaluation.

---

## 13. Observability and diagnostics

- Every transaction has correlation ID, source, label, base/new revision, duration, command count, estimated/actual touched resources, and success/error code.
- Do not log raw chunk payloads or full command arguments by default; offer an explicit sanitized diagnostic export.
- Meshing metrics include source chunk revision, queue/wait/build/upload times, triangles, discarded stale results, and worker failures.
- Persistence metrics include snapshot/journal revisions, bytes, durations, backup path token (not raw private path in telemetry), and recovery outcome.
- Agent metrics include provider/model identifier, rounds, token usage, tool names, structured error codes, staged diff counts, conflict, apply/discard/cancel; prompt and tool arguments are opt-in.
- A developer diagnostics panel shows document revision/hash, dirty chunks, worker queue, renderer stats, history memory, and active agent transaction.
- Assertions catch direct post-commit mutation in development (freeze/proxy small records; hash/check strategies for large buffers where affordable).

---

## 14. Data compatibility and migration policy

- Distinguish `containerVersion`, `documentSchemaVersion`, `voxelEncodingVersion`, `commandSchemaVersion`, tool schema version, and skill version in the v1 manifest and codecs.
- Container v1 may carry later supported document schema versions; adding/changing pivot, constraint, or animation fields bumps `documentSchemaVersion` and adds migrations/goldens without needlessly changing the ZIP container. Chunk layout changes bump `voxelEncodingVersion`.
- File readers support a declared backward window. Migration is ordered, pure, tested on immutable fixtures, and produces a report.
- Saving a migrated document uses atomic Save As or creates a backup before replacing the original.
- Command journals are only replayed when snapshot/document/schema compatibility and base hash match; otherwise offer snapshot recovery without unsafe replay.
- External export is not lossless. Show a structured loss report (metadata, constraints, unsupported materials, loop semantics, pivot helpers) before write.
- Never silently discard unknown persistent fields/components in a version claimed to be supported.

---

## 15. Product and technical risk register

Risk owners maintain prevention, a detecting test/metric, and a rollback/contingency in the tracker. Review P0 risks at every milestone and P1 risks at the stage that owns them.

| Sev. | Risk | Owner | Detection / gate | Prevention and contingency |
|---|---|---|---|---|
| P0 | Silent save/journal data loss | Persistence lead | Fault injection at every append/flush/rename/compaction boundary; recovery E2E | Atomic temp/replace, checksums, backup, never truncate before durable snapshot; fall back to last valid snapshot and corrupt-tail report |
| P0 | Partial or non-atomic AI transaction | Commands lead | Inject invalid command at each transaction index; hash/revision/history/event assertions | Copy-on-write overlay, one commit point; discard overlay and terminate run on invariant failure |
| P0 | UI/renderer/agent bypasses command bus | Architecture owner | Forbidden-import/compile tests, capability audit, command trace E2E | Private write capability and package exports; block release until bypass is removed |
| P0 | Unbounded file/AI resource exhaustion | Security lead | Malicious corpus, fuzzing, limit and OOM-adjacent tests | Preflight/allocation limits, bounded queues and agent budgets; cancel/discard without changing current document |
| P0 | Tauri path/IPC privilege escape | Desktop/security lead | Threat review, path traversal/symlink/IPC tests | Minimal capabilities, Rust-side validation, scoped user-selected handles; disable vulnerable capability/update |
| P0 | Secret/project exfiltration or prompt injection | AI/security lead | Injection/privacy eval corpus and redacted-log audit | Treat content as data, bounded consented context, keychain, no file/network/shell tools; revoke keys/disable provider adapter if suspected |
| P0 | Nondeterministic persistent state/migration | Core lead | Cross-process/OS trace hashes, reordered-map/worker-schedule tests | Canonical codecs/iteration/IDs/numbers; stop rollout and restore prior writer/migration |
| P1 | Bulk command inverses exhaust history memory | Commands/voxel lead | History-byte benchmarks at 100k/500k/1M and undo soak | Compact per-chunk old-value runs, byte budgets/checkpoints; reject/confirm over-limit operation |
| P1 | Dependent commands validate against wrong state | Commands lead | Transaction where command N consumes resource created by N-1 | Sequential staged validation plus final aggregate validation |
| P1 | Negative coordinates/chunk boundaries crack | Voxel/render lead | Boundary golden fixtures, neighbor-dirty assertions and visual seam tests | Frozen floorDiv/index/halo conventions; rebuild affected neighbor from authoritative snapshot |
| P1 | Pivot/joint graphs or runtime/export disagree | Rig/animation lead | Chest/arm nested pivot goldens in runtime and glTF | One scene hierarchy, joint component only, ADR-006; helper-node/bake fallback with loss report |
| P1 | Renderer resource or listener leaks | Renderer lead | 30-minute edit/remesh/play soak, GPU-object and heap trend | Explicit ownership/dispose, stale-token rejection; reset projection from document snapshot on device/resource failure |
| P1 | Meshing/serialization blocks main thread | Performance lead | Long-task and p95 input latency budgets | Workers, transferables, bounded upload queue/progress; retain last good mesh and cancel stale work |
| P1 | AI emits excessive primitive calls/cost | AI lead | Tool/command/token/cost eval budgets | Coarse tools/generators, preflight and repeated-error cutoff; terminate and offer staged partial discard only (never partial commit) |
| P1 | AI overwrites a newer human edit | Commands/AI lead | Concurrent-edit E2E and expected-revision trace | Isolated base-revision overlay, fail closed, re-inspect/replan only with approval |
| P1 | Quaternion/Euler/axis mismatch | Math/formats lead | Golden scenes across editor, Three, `.vox`, glTF and animation samples | One math package/conversion policy; block affected exporter and preserve native file |
| P1 | Dense/checkerboard geometry defeats voxel-count target | Performance lead | Dense, sparse and high-surface benchmark fixtures | Measure faces/chunks as well as voxels, greedy meshing and queue budgets; degrade view features without data loss |
| P2 | `.vox` complexity expands MVP | Formats lead | Supported-feature matrix and scope review | Freeze subset, report unsupported chunks/losses; native `.vxl` stays canonical |
| P2 | Visual AI quality/provider drift regresses | AI QA lead | Pinned repeated live evals, artifact/human rubric and drift flag | Version prompts/tools/skills/provider; roll back configuration or mark capability experimental |
| P2 | Package cycles emerge | Architecture owner | Dependency-cruiser/Madge on every PR | Export maps and composition-root registration; reject or refactor violating change |
| P1 | History/journal semantics disagree | Commands/persistence leads | Undo/save/crash/replay sequence model tests | Journal forward committed transactions only; recover snapshot then validated replay |
| P1 | Cross-platform GPU/Tauri difference delays release | Release lead | Early and scheduled OS/GPU/HiDPI matrix | Named support tiers, feature fallback and platform-specific release block/known issue decision |

---

## 16. Deferred backlog after initial release

These require new plans/ADRs and are not hidden MVP dependencies:

- live symmetry modifier;
- arbitrary-angle voxel resampling and advanced selection transforms;
- position/look-at/IK constraints;
- animation blending/layers/events and nonlinear graph editor;
- glTF import;
- WASM/Rust meshing only if profiling justifies it;
- content-addressed/delta chunk storage and partial loading for very large projects;
- local-model provider and pluggable providers;
- working-copy visual side-by-side diff improvements;
- advanced procedural graph authoring;
- collaborative editing/merge semantics;
- plugin marketplace, arbitrary scripts, physics, weights/deformation, cloth/fluids.

---

## 17. First implementation sprint backlog

After Stage 0 approval, the first sprint should execute in this order:

1. `S1.1–S1.6`: reproducible workspace and mandatory CI.
2. `S1.7–S1.8`: branded IDs, schemas, structured errors.
3. `S1.9–S1.12`: math and negative chunk-coordinate primitives.
4. `S1.13`: canonical serialization utility.
5. Start `S2.1–S2.6` and `S3.1–S3.3` in parallel once shared primitives stabilize.
6. QA creates fixed IDs/seeds and first golden fixtures alongside implementation, not afterward.
7. Tech lead verifies package boundaries with an intentional forbidden-import test.

**Sprint demo:** CI builds all empty/scaffolded packages; a headless script creates a versioned document with a root and child, computes pivot-aware transforms, maps negative voxel coordinates to chunks, and emits byte-identical canonical JSON in repeated runs.

---

## 18. Final traceability to PRD phases

| PRD phase | Plan stages | Completion evidence |
|---|---|---|
| Phase 1 — Engine | S0–S5 | M1 headless deterministic save/recovery demo |
| Phase 2 — Editor | S6–S8 | M2 fully manual editor demo |
| Phase 3 — Generic Animation | S9–S10 | M3 multi-domain animation demo |
| Phase 4 — AI Editing | S11–S12 | geometry prompt/evaluation suite |
| Phase 5 — AI Rigging | S13 | chest/wings/robot rig prompts |
| Phase 6 — AI Animation | S13 | chest/wheel/bird/robot animation prompts |
| Phase 7 — AI Skills | S14 | removable versioned skills and generator evals |
| Phase 8 — Visual Refinement | S15 | bounded multi-view correction loop |
| Import/export improvements | S8,S16 | `.vxl/.vox/.png/.glb/.gltf` fixtures and validators |
| Optimization/release | S17 | performance/security/platform/recovery release gates |

---

## 19. Architecture review checklist

Before merging any persistent feature, answer **yes** to all applicable items:

- Is the operation generic rather than asset-domain-specific?
- Is persistent intent represented by a versioned, serializable command?
- Do UI and agent use the same handler and validation path?
- Is all nondeterminism supplied in the payload or excluded from canonical state?
- Is the operation invertible without routine full-document snapshots?
- Does it validate malformed IDs, references, numbers, coordinates, cycles, and limits?
- Does a failed containing transaction leave state/history/revision/events unchanged?
- Are negative coordinates and chunk-boundary effects tested?
- Does the renderer consume changes rather than own them?
- Is runtime state kept out of the saved asset?
- Is concurrency checked using an expected revision where appropriate?
- Are file/tool/model inputs treated as untrusted and bounded?
- Are migrations, format docs, and golden fixtures updated if persistence changes?
- Are performance impact and resource disposal measured?
- Does the feature remain manually editable, undoable, understandable, and exportable?

---

## 20. Plan maintenance

This file is the execution baseline, not a static promise. Update task status/owner links in the tracker and revise this plan when an ADR changes dependencies, a milestone benchmark invalidates an assumption, or scope changes. Every revision should include: reason, affected task IDs, migration/rework impact, and approval. Never reorder the conceptual foundation to start AI before the command/document/editor contracts are stable.
