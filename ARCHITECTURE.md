# Architecture

This document is the architectural contract for the AI-native generic voxel editor. It defines the rules that implementation, review, and tests must preserve.

[`plan.md`](./plan.md) contains the delivery roadmap and detailed baseline decisions. GitHub issues define the scope of individual slices. Approved ADRs explain hard-to-reverse trade-offs. If an ADR changes this contract, update this document in the same change; architecture must never diverge silently.

## Architectural goals

The system is optimized for these properties, in order:

1. **Data safety** — rejected work, crashes, stale asynchronous work, and hostile input cannot corrupt authoritative asset state.
2. **Determinism** — the same canonical state and command stream produce the same semantic result across supported processes and platforms.
3. **One semantic model** — human actions, imports, recovery, and AI proposals use the same document concepts and registered commands.
4. **Headless core** — semantic behavior runs and is testable in Node without React, Three.js, Tauri, a GPU, a filesystem, or an LLM.
5. **Genericity** — one unchanged core represents architecture, furniture, vehicles, vegetation, humanoids, non-humanoid creatures, mechanical assemblies, and abstract assets.
6. **Recoverability** — semantic commit, save, autosave, journaling, and recovery have explicit and honest durability semantics.
7. **Projection isolation** — the renderer and UI project authoritative state; they never become authoritative.
8. **Bounded trust** — files, native capabilities, provider output, tool arguments, images, and external formats are validated and resource-limited.
9. **Incremental performance** — localized changes produce localized semantic, worker, and GPU work.
10. **Replaceable integrations** — filesystem, renderer, worker, container-library, and model-provider details sit behind narrow adapters.

When goals conflict, preserve correctness, data safety, and explicit failure before convenience or throughput. Optimize only with reproducible evidence.

## Accepted decisions

The hard-to-reverse contracts behind this document are recorded with their alternatives, consequences, and delivery gates:

1. [Coordinate, transform, and canonical number semantics](./docs/adr/0001-coordinate-transform-and-canonical-number-semantics.md)
2. [Authoritative state and mutation capabilities](./docs/adr/0002-authoritative-state-and-mutation-capabilities.md)
3. [Command, transaction, revision, and history semantics](./docs/adr/0003-command-transaction-revision-and-history-semantics.md)
4. [Native storage, canonicalization, and versioning](./docs/adr/0004-native-storage-canonicalization-and-versioning.md)
5. [Package dependency, threading, and adapter boundaries](./docs/adr/0005-package-dependency-threading-and-adapter-boundaries.md)
6. [Generic articulation and animation runtime](./docs/adr/0006-generic-articulation-and-animation-runtime.md)
7. [Bounded provider-neutral AI proposals](./docs/adr/0007-bounded-provider-neutral-ai-proposals.md)
8. [Supported desktop and performance baseline](./docs/adr/0008-supported-desktop-and-performance-baseline.md)
9. [Default resource limits and escalation policy](./docs/adr/0009-default-resource-limits-and-escalation-policy.md)
10. [Cloud provider, consent, and privacy policy](./docs/adr/0010-cloud-provider-consent-and-privacy-policy.md)
11. [Native locking and external-format compatibility](./docs/adr/0011-native-locking-and-external-format-compatibility.md)

## System shape

```text
                         ┌──────────────────────────────┐
                         │        Desktop app           │
                         │ composition, panels, tools   │
                         └──────────────┬───────────────┘
                                        │
                 ┌──────────────────────┼───────────────────────┐
                 │                      │                       │
          ┌──────▼──────┐       ┌───────▼───────┐       ┌──────▼──────┐
          │ Editor      │       │ Agent + Skills│       │ Formats     │
          │ runtime     │       │ inspect/stage │       │ import/export│
          └──────┬──────┘       └───────┬───────┘       └──────┬──────┘
                 │                      │                       │
                 └──────────────┬───────┴───────────────┬──────┘
                                │                       │
                         ┌──────▼──────┐         ┌──────▼──────┐
                         │ Command bus │         │ Renderer    │
                         │ transactions│         │ projection  │
                         └──────┬──────┘         └──────┬──────┘
                                │                       │
                    ┌───────────▼───────────────────────▼───────────┐
                    │ Document, voxel, rigging, animation read model│
                    └───────────────────┬───────────────────────────┘
                                        │
                              ┌─────────▼─────────┐
                              │ Model + math + IDs│
                              └───────────────────┘

     Native filesystem/keychain and LLM providers connect only through adapters.
```

The desktop composition root creates implementations and injects them into modules. Semantic packages do not discover global singletons, construct platform integrations, or reach upward into the application.

## Non-negotiable invariants

### One edit path

Every persistent change within an open document executes through `CommandBus.execute` or `CommandBus.executeTransaction`. UI tools, imports into an open document, agent tools, undo, and redo construct registered commands.

`DocumentSession` is the only exception: it may install a complete aggregate for new, open, migrated, or approved recovery state after full parse, migration, and validation. Lifecycle replacement is not an editing shortcut.

### One semantic model

UI and AI behavior differ only in how intent is produced and approved. They share document schemas, command constructors, validation, transactions, history, events, and errors. Agent tools never maintain a parallel authoritative JSON model.

### Deterministic intent

A command payload contains every ID and value required for replay. Handlers do not generate IDs, read wall-clock time, call random generators, inspect UI state, or derive platform-sensitive intent secretly. Callers resolve and canonicalize those values before execution.

Stable ordering is explicit. Object, map, set, archive entry, and worker completion order are never semantic ordering guarantees.

### Atomic transactions

Transactions validate and execute against a staged sequential view. Later commands observe earlier staged effects. A failure publishes no document or voxel change, revision, history entry, dirty transition, journal request, or commit event.

One successful transaction increments the document revision exactly once, creates one history entry, and publishes one frozen post-commit event. Subscribers cannot veto or mutate the commit; subscriber exceptions are isolated.

### Runtime/persistent separation

Selection, hover, cameras, tools, panel layout, playback time, evaluated animation, constraints output, GPU resources, worker state, previews, diagnostics, and agent conversation state are runtime data. Native project serialization excludes them.

### Renderer isolation

Three.js and React Three Fiber types stay in renderer and desktop implementations. Semantic packages expose renderer-neutral DTOs and immutable read views. The scene is a disposable projection, not the source of truth.

### Generic core

Core schemas, commands, evaluators, and interfaces use generic concepts: node, volume, material, pivot, joint, constraint, clip, track, and keyframe. Asset categories and named motions are expressed as skill instructions, recipes, fixtures, or deterministic generators above the engine.

### Bounded untrusted input

Files, archives, metadata, native paths, command envelopes, tool arguments, provider output, preview images, and external formats are parsed before use and checked against configurable limits before allocation or mutation. Errors use stable codes, paths, safe messages, and optional remediation hints.

### Revision safety

Normal editing, import into an open document, AI Apply, undo, and redo declare an expected base revision. Stale work fails before staging. Identical committed transaction replay follows the idempotency policy; reusing an identifier with different canonical bytes fails.

### Compatibility safety

Persisted documents and journals carry explicit independent versions. Migrations run one version at a time. Unknown future versions fail clearly and never overwrite source material. Format changes require fixtures and migration or an explicit compatibility break approved by ADR.

## Package ownership and dependencies

The intended workspace has one desktop application and deep semantic or adapter packages. A package owns both its interface and its invariants; callers do not reconstruct those invariants.

| Module | Owns | May depend on |
|---|---|---|
| `shared` | Branded IDs, bounded primitives, results, errors, event utilities | Nothing |
| `math` | Vectors, integer vectors, quaternions, transforms, matrices, AABBs, rays | `shared` |
| `model` | All persisted DTOs, structural schemas, canonical document encoding, schema migrations | `shared`, `math` |
| `voxel` | Sparse chunk storage, coordinate mapping, region operations, voxel queries, meshing input | `shared`, `math`, `model` |
| `document` | Aggregate invariants, hierarchy and transform queries, immutable read views | `shared`, `math`, `model`, `voxel` |
| `rigging` | Pivot, joint, and constraint semantics plus pure evaluation | `shared`, `math`, `model`, `document` |
| `animation` | Clip and track semantics plus pure sampling and runtime evaluation | `shared`, `math`, `model`, `document`, `rigging` |
| `commands` | Registry, staging, transactions, revisions, history, command handlers, command migration | `shared`, `math`, `model`, `voxel`, `document`, `rigging`, `animation` |
| `renderer` | Three.js projection, meshing workers, picking, overlays, GPU lifecycle | Semantic read modules; never `commands` or editor implementations |
| `editor` | Tools and non-React editor workflows that construct commands | Semantic read modules and `commands` |
| `formats` | Native and external codecs, validation, import/export projections | Semantic read modules; platform I/O is injected |
| `agent` | Tool contracts, bounded inspection, preview transactions, agent state machine | Semantic read modules and `commands` |
| `skills` | Versioned domain instructions, recipes, deterministic generators, evaluations | Agent tool contracts and generic command proposal contracts |
| desktop app | Composition, React UI, Tauri adapters, provider adapters | All modules required for composition |

Rules:

- Dependencies point downward only. No package imports from the desktop application.
- `model` owns the complete persisted discriminated unions. Feature modules add semantic validation and evaluation; they do not extend the schema upward at runtime.
- `commands` owns the kernel and feature handler registrars. Feature packages never import a global command bus.
- `renderer` consumes immutable snapshots and runtime evaluation. It does not issue persistent commands or expose Three.js objects as domain identifiers.
- `formats` parses and serializes semantic data. Native path access and atomic replacement belong to storage adapters.
- `agent` may inspect bounded read interfaces and construct commands. It does not import editor or renderer implementations.
- Package exports and dependency checks enforce these rules. Deep cross-package imports are unsupported.

## Authoritative state and capabilities

| Owner | Responsibility | Write authority |
|---|---|---|
| `DocumentStore` | Open document, semantic records, committed revision | Private capability held by command bus and lifecycle coordinator |
| `VoxelRepository` | Sparse typed-array volumes associated with the document | Same staged transaction capability as the document |
| `DocumentSession` | New/open/replace/recover/close lifecycle | May install only fully validated aggregate and volumes |
| `PreviewSession` | Copy-on-write staged read model for proposal review | Preview namespace only; no live authority |
| `EditorStore` | Selection, hover, active tool, camera, panels, timeline cursor, notices | Runtime only |
| `SceneRuntime` | World transforms, evaluated animation, constraints, mesh and picking maps | Runtime projection only |
| `AgentSession` | Context summary, budgets, base revision, tool state, cancellation | Agent runtime and preview only |
| `FileService` | Open, atomic save, autosave, journal, keychain through scoped ports | External effects; never semantic mutation |

Public reads return immutable snapshots, copies, or immutable accessors. A mutable `Uint16Array`, map, or record owned by authoritative state never escapes through a public interface.

## Canonical semantic model

### Coordinates and transforms

- Right-handed coordinates: `+X` right, `+Y` up, `+Z` forward.
- Voxel locations are integers. Regions are half-open `[min, max)`.
- Negative chunk mapping uses mathematical floor division and positive modulo.
- Angles are radians internally.
- Quaternions serialize as `[x, y, z, w]`, are finite and normalized, and use one sign-canonicalization rule.
- Scale is finite and strictly positive in version 1. Geometry reflection uses voxel mirror operations rather than negative node scale.
- Canonical transforms store translation, pivot, rotation, and scale; matrices are runtime-only.
- Transform evaluation is `T(position) × T(pivot) × R(rotation) × S(scale) × T(-pivot)`.
- Canonical JSON is UTF-8 without BOM and follows RFC 8785 for member ordering, escaping, and ECMAScript shortest round-trippable numbers. Arrays retain schema order; absent optional fields are omitted, allowed explicit `null` is preserved, and unknown fields, non-finite values, and serialized `-0` are rejected before canonicalization. Authored values are not blanket-quantized; derived transform components use the ADR-0001 `1e-9` quantization and decomposition policy before entering a command.
- Canonical colors are lowercase `#rrggbb` or `#rrggbbaa`; color-space conversion is renderer-only.
- Persistent derived transform intent, such as preserve-world reparenting, is resolved and canonicalized by the command constructor and carried in its payload.

### Document aggregate

A document contains explicit schema versions, metadata, ordered scene nodes, material records, volume descriptors, generic components, and animation data. Bulk chunk bytes live in the associated voxel repository and serialize separately.

A node has exactly one parent reference and one ordered children list. Validators enforce reciprocity, uniqueness, acyclicity, and complete references. Deleting referenced nodes, volumes, materials, components, or animation records is rejected unless the command declares an explicit valid cascade or replacement policy.

Components form a closed, independently versioned discriminated union. Voxel, pivot, and joint components are singletons per node. Constraints carry stable IDs and deterministic order. Bounded JSON-compatible metadata is inert to engine behavior.

### Voxel storage

Version 1 uses sparse `16 × 16 × 16` chunks of unsigned 16-bit material values. Zero is empty; `1...65535` reference document materials. X is the fastest-changing local coordinate. Empty chunks are removed after mutation.

Each in-session chunk may carry runtime revision and content-hash metadata, but runtime revision is excluded from semantic state. Boundary occupancy changes invalidate the edited chunk and only the six face neighbors needed for visibility.

Bulk operations estimate and validate bounds before allocation. Their change sets contain the affected chunks and compact old values required for inversion, not entire document snapshots.

### Materials

Material IDs are exact unsigned 16-bit values supplied by callers. Zero is absent from the material table. IDs are not reused while reachable history or recovery records can mention them. Initial material properties are bounded name, canonical color, opacity, roughness, metallic, and emissive values. Opacity is in `[0,1]`; transparent voxels remain occupied and pickable, and adjacency to a non-opaque voxel does not hide a face.

All other persistent IDs are opaque serialized strings. Production callers may generate UUIDs, but the generated ID enters the command payload before execution. Tests use fixed IDs.

## Commands, transactions, and history

A command has a caller-supplied ID, type, schema version, and serializable payload. Audit metadata such as source, correlation, display label, and timestamps is outside deterministic semantic intent unless explicitly part of the asset.

Every registry entry provides:

- runtime payload parsing;
- semantic validation against a read view and configured limits;
- staged execution returning granular change information and inverse intent;
- an explicit inverse (every version 1 persistent edit command is undoable);
- declared affected resources;
- optional deterministic UI gesture coalescing.

Transaction execution follows this order:

1. Parse the envelope and enforce command, byte, and source budgets.
2. Verify expected revision and transaction idempotency.
3. Create a copy-on-write overlay for touched records and chunks.
4. Parse, validate, and execute commands sequentially against the overlay.
5. Run aggregate and referential invariants on staged state.
6. Discard everything on failure and return the failing command index in a structured error.
7. Atomically install staged state and increment revision once.
8. Create one history entry and publish one frozen post-commit event.

Every version 1 persistent edit command is undoable. Undo executes stored inverses in reverse command order as one special transaction. Redo replays original commands. A new normal commit clears redo. Lifecycle replacement resets history. Coalescing requires an explicit deterministic key and compatible affected resources on the latest unsealed entry; it combines history presentation, never semantic commits or revisions, and seals on gesture end, incompatible or intervening commit, undo/redo, lifecycle replacement, or failure. Idempotency records remain available for the open session and retained recovery horizon.

Post-commit consumers re-read a revisioned immutable snapshot. Events carry granular changed IDs and chunk coordinates but are not writable payloads. Asynchronous consumers process revisions in order.

## Persistence and recovery

The native `.vxl` container is a versioned ZIP with:

- a canonical manifest and entry index;
- canonical document JSON;
- coordinate-sorted little-endian sparse voxel streams;
- optional standard preview images outside semantic identity.

Readers validate path safety, duplicates, entry counts, compressed and uncompressed sizes, ratios, integer overflow, offsets, dimensions, codecs, checksums, metadata depth, and all resource limits before bulk allocation.

`canonicalDocumentHash` is SHA-256 over the ADR-0004 `canonicalSemanticBytes`: a version tag; length-framed RFC 8785 UTF-8 document; and length-framed non-empty chunks sorted by volume ID and signed coordinates, with all 4096 X-fastest unsigned-16 values encoded little-endian. It excludes timestamps, archive compression details, permissions, previews, UI state, runtime revisions, history, recovery data, audit logs, and diagnostics. CRC checks container or journal corruption; it is not semantic identity.

A save captures immutable snapshot `(revision R, semantic hash H_R)`, writes a same-directory temporary file, flushes where supported, atomically replaces the destination, and retains a last-known-good backup. Completion records `R` as the durable snapshot and marks the project clean only if the live semantic hash equals captured `H_R`; it never compares a hash with a Revision.

Semantic commit precedes durable recovery I/O. An ordered recovery writer appends checksummed frames and tracks `lastJournaledRevision`. Failure leaves the edit valid and dirty, reports degraded crash recovery, and schedules retry; it never claims unconfirmed durability.

Recovery loads a durable snapshot, scans to the last complete valid frame, and replays through normal command decoding, migrations, limits, and invariants. It reports a corrupt tail and never guesses past it. Recovery restores the asset, then starts a fresh bounded user history.

## Renderer and workers

The renderer maps stable node and material IDs to disposable Three.js resources. It consumes commit events and runtime evaluation, then re-reads immutable snapshots. Lifecycle replacement disposes and rebinds the complete projection.

Meshing workers receive copied immutable chunk and halo data. Requests and results carry:

- live or `preview:<session>` namespace;
- volume and chunk identity;
- chunk revision;
- cancellation identity.

Only a result matching the latest namespace, identity, and revision may update the scene. Worker completion order never determines visible state. The main thread alone owns semantic and renderer installation authority; workers are pure compute adapters over copied immutable input. Queueing is bounded, visible work is prioritized, main-thread uploads are budgeted, and every replacement disposes superseded GPU resources.

Face culling is the correctness baseline. Greedy meshing is an optimization behind the same seam and requires golden equivalence plus benchmark evidence.

## Editor interaction

`EditorStore` owns only runtime interaction state. An editor tool receives pointer and keyboard input, reads immutable semantic state, maintains a transient preview, and constructs commands on commit.

A complete gesture produces one user-meaningful history entry; pointer tools normally keep a runtime preview and commit once at gesture end. Pointer cancellation restores the exact starting state. Selection references are pruned after semantic deletion. Local/world modes, snapping, collision behavior, and transform preservation are explicit rather than inferred from UI state inside handlers. Right-angle region rotation uses the integer minimum-anchored mapping and explicit `overwrite` collision policy in ADR-0001. Picking chooses nearest non-negative distance, then resolves exact ties by X/Y/Z axis priority and stable node/volume identity.

The React interface calls editor modules and displays returned state and errors. React widgets do not encode duplicate domain invariants.

## Rigging and animation

Hierarchy is the only transform graph. A joint annotates a node; it never introduces a second parent relationship.

Version 1 constraints follow stable persisted order and apply local Euler XYZ rotation limits in radians. Constraint evaluation is pure runtime behavior applied after authored or animated local transforms and does not write the document. Positive non-uniform ancestor scale is supported because local rotation is clamped before hierarchy composition; runtime evaluation never decomposes resulting shear.

Animation data is generic: clips contain typed property tracks and stable keyframes. Validation enforces target existence, property/value compatibility, finite values, duration, loop policy, unique sorted times, and configured limits.

Rotation tracks store canonical quaternions and use shortest-path spherical interpolation. Initial interpolation modes are step, linear, and smoothstep `u² × (3 - 2u)`. `once` clamps time to `[0,duration]`; `loop` uses mathematical modulo into `[0,duration)`, with negative playback time clamped to zero. Runtime evaluation layers base document state, animation override, and constraints, then calculates hierarchy world transforms. Playback never emits commands per frame, and stopping restores base state exactly.

## AI, previews, and skills

The agent uses provider-neutral, versioned JSON-schema tool contracts. Inspection and mutation are separate capabilities. Inspection is selection-first, paginated, bounded, revision-tagged, and based on stable IDs.

Tools accept structured domain arguments only. They have no shell, source execution, unrestricted path, arbitrary URL, mutable document, or renderer-object capability. Mutation tools construct registered commands and prefer coarse semantic operations over long per-voxel streams.

An agent run owns a base revision, budgets, cancellation state, and a copy-on-write `PreviewSession`. Staged reads observe prior staged commands. Preview events and worker jobs use an isolated namespace and cannot affect live revision, history, dirty state, autosave, or recovery.

The agent state machine is:

1. understand;
2. inspect;
3. plan;
4. stage;
5. inspect staged state;
6. validate;
7. request explicit user approval;
8. apply one optimistic transaction or discard.

A revision conflict is never silently rebased. The user chooses discard, reinspect, or replan. Version 1 has no AI auto-apply path: every persistent proposal requires explicit user approval. Apply creates one labeled undoable history entry; Discard creates none.

Every session enforces limits on rounds, tokens, tool calls, commands, output bytes, voxel modifications, tracks, keyframes, duration, elapsed time, and estimated cost. Provider credentials live in the operating-system keychain. Provider-specific types remain inside adapters. Logs and diagnostics follow approved consent, retention, and redaction policies.

Skills are removable versioned knowledge: instructions, allowed tools, constraints, deterministic generators, provenance, and evaluations. They produce generic command proposals. A saved document never requires the originating skill to open, edit, animate, or export.

Visual refinement uses fixed standard-view evidence and an opt-in bounded correction loop. Images are evidence for proposed commands, never authoritative state.

## Operational support, limits, and compatibility

### Supported product

The initial desktop release supports Windows 10 22H2 or Windows 11 on x86-64, macOS 12 or later on Apple silicon and x86-64, and Ubuntu 22.04-compatible glibc 2.35 Linux on x86-64. A supported renderer requires hardware WebGL 2. The minimum tier is a four-core 64-bit CPU, 8 GiB RAM, 2 GiB free storage, and a WebGL 2 GPU with at least 1 GiB graphics memory; ADR-0008 names the reference and low-tier benchmark machines and exact measurement protocol. Unsupported graphics fails before an editing session and may never cause a Document rewrite.

Every manual workflow—create, open, edit, undo, rig, animate, save, recover, import, preview, and export—works without an account, provider credential, telemetry consent, or network. The UI meets the applicable WCAG 2.2 AA baseline, including keyboard workflows, visible focus, labelled controls, contrast, 200% scaling, announced status/errors, and reduced motion. Spatial screen-reader interpretation of viewport content, touch-only editing, and pressure-sensitive tools are not version 1 promises.

Release performance gates are measured on fixed compact, sparse, and high-surface fixtures. On the ADR-0008 reference tier, 100k occupied voxels target 60 FPS and p95 input preview below 50 ms; a one-voxel commit is below 8 ms p95; localized worker remesh is below 30 ms p95; 500k sustains 30 FPS; and 1M opens within 10 seconds, remains navigable at 20 FPS, and uses under 2 GiB. The named low tier keeps 100k usable at 30 FPS, p95 input preview below 100 ms, open/save below 5 seconds, and memory below 1.5 GiB. A missed gate blocks release or requires an explicit support-policy change.

### Default limit profile

One immutable injected limit profile is shared across parsers, Commands, history, workers, formats, and agent sessions. Version 1 hard defaults include:

| Resource | Hard maximum |
|---|---:|
| coordinate interval / extent per axis | `[-1,048,575, 1,048,575]` / 2,048 |
| Nodes / Voxel Volumes / Materials | 10,000 / 1,024 / 4,096 |
| non-empty Chunks / occupied or Transaction-touched voxels | 262,144 / 1,000,000 |
| Commands / command payload / Transaction envelope | 1,024 / 1 MiB / 16 MiB |
| history | 512 entries and 256 MiB inverses |
| input file / archive expansion | 512 MiB / 2 GiB, 4,096 entries, 100:1 ratio |
| metadata | depth 16, 10,000 members, 1 MiB canonical bytes |
| Clips / Tracks / keyframes | 256 / 10,000 / 1,000,000 |
| preview image | 2048×2048 and 16 MiB decoded RGBA |

An AI session additionally permits at most 16 model rounds, 64 tool calls, 1,024 proposed Commands, 1M proposed voxel changes, 4 MiB tool-result bytes, 128k total tokens, 10 minutes, USD 5 estimated spend, three visual iterations, and 12 images. Known usage is reserved before a request. Unknown-cost usage requires an explicit provider-side cap.

Hard-limit violations fail before allocation or mutation with a stable limit error and no forbidden side effects; a dialog cannot waive them. Raising a limit requires reviewed configuration plus benchmark or adversarial evidence. More than 100k affected voxels, 64 MiB new inverse history, file overwrite, lock stealing, source migration, or any image transmission requires explicit pre-execution confirmation even below hard limits. AI Apply always requires approval.

### Cloud privacy

Version 1's sole cloud adapter is the OpenAI API with a user-supplied key and an allowlisted tool-capable model. Cloud AI, image use, analytics, and crash uploads are independently off by default. Keys live only in the OS credential store. A run may send the user's current-run messages, fixed system/Skill/tool instructions, provider settings, bounded selection/Document summaries, explicit bounded inspection results, and staged summaries/errors. It never sends credentials, native files, journals, local paths, unrelated full voxel arrays, history payloads, clipboard data, logs, or diagnostics.

Image transmission requires per-session confirmation of provider, model, views, count, resolution, budget, and cost. The application retains no transcript by default; optional local retention expires after a user-selected 1, 7, or 30 days and is unavailable when encrypted-at-rest storage cannot be provided. Provider-side retention is disclosed rather than represented as application-controlled. Any telemetry is separately opt-in, coarse, non-content-bearing, and contains no stable cross-install identifier. Diagnostics are locally previewable and redact secrets, paths, prompts, provider payloads, and project content. Offline/provider failure has no fallback provider and no effect on manual workflows.

### Native and external formats

The native reader supports current versions plus a complete migration chain for at least the two preceding released major versions of each semantic format. The writer emits current versions only. Unknown future or unrecognized claimed-supported content fails without overwrite. Journals require matching snapshot identity and a supported command migration chain.

Writable open uses an adjacent exclusive nonce-bearing lock. Contention opens read-only by default; lock stealing requires confirmation plus same-machine dead-owner or 30-second stale-heartbeat evidence. Remote/unverifiable locks are never auto-stolen. Lock loss prevents overwrite but permits Save As. Version 1 has no merge or collaborative-editing semantics.

MagicaVoxel interchange targets VOX version 150 `MAIN`, optional `PACK`, `SIZE`/`XYZI`, and optional `RGBA`. Axes map `(vox x, vox y, vox z)` to `(X, Y, Z) = (vox x, vox z, -vox y)`; palette zero is empty. Scene graph, transforms, layers, materials, cameras, and extension chunks are reported but not interpreted. Export requires identity-transformed Volumes within 256³ and at most 255 colors; unsigned-cube origin rebasing and any unsupported hierarchy, transform, rigging, animation, metadata, or material semantics must use an explicit supported bake/loss choice or block export with a loss report.

glTF 2.0 and GLB are export-only. One voxel edge is one meter; the right-handed `+Y`-up basis and positive Z asset axis are retained. Node TRS and hierarchy map directly, pivots use deterministic helper Nodes, voxel surfaces become indexed material-grouped meshes, and PBR base color/opacity/roughness/metallic/emissive values map to core glTF material fields. Step/linear animation map directly; smoothstep is boundedly baked to linear samples; loop policy, constraints, joint annotations, unsupported metadata, history, Skills, and runtime state appear in the preflight loss report rather than disappearing silently.

## Interface and adapter design

Modules should be deep: a small interface hides substantial invariant-preserving behavior. The interface is also the test surface.

- Accept dependencies; construct concrete adapters only in the composition root.
- Return explicit results and stable errors instead of signaling semantic failures through exceptions.
- Introduce a seam when behavior truly varies. One adapter is hypothetical; two adapters make it real.
- Keep internal seams private when callers do not need the variability.
- Prefer immutable snapshots and intent-rich operations over mutable repositories and many shallow setters.
- Apply the deletion test: removing a useful module should force its complexity into multiple callers.
- Keep platform details, archive-library details, model-provider details, and Three.js details local to their adapters.

## Verification architecture

Tests cross the highest practical interface and assert external behavior rather than implementation details.

| Test class | Required evidence |
|---|---|
| Pure and property | Math, negative chunk mapping, canonicalization, shape coordinates, operation identities, graph and animation invariants |
| Command conformance | Every registered command: valid, invalid, inverse, undo, redo, codec, deterministic replay, conflict, limits, rollback |
| Integration | Document plus voxel staging, history, commit events, save snapshots, journal, lifecycle, renderer scheduling, preview transactions |
| Golden | Canonical JSON and binary, semantic hashes, migrations, shapes, mesh output, import/export, animation samples, standard views |
| Adversarial and fuzz | Native files, archives, external formats, journal tails, metadata, command and tool JSON, provider output |
| Desktop E2E | Create, edit, select, organize, rig, animate, save, recover, import, export, AI Apply/Discard/conflict, accessibility |
| Performance | Named hardware and 100k/500k/1M fixtures; command, preview, meshing, frame, memory, save/load, animation, export, AI efficiency |
| AI evaluation | Fixed documents, selections, prompts, provider/model/tool versions, budgets, structural metrics, unrelated diffs, rendered evidence |

A failure test is complete only when it asserts the absence of forbidden side effects. A deterministic test controls IDs, seeds, clocks, ordering, providers, and worker completion. Live providers are used only by explicitly credentialed evaluations.

## Forbidden dependency and behavior patterns

Architecture checks must reject:

- persistent document writes outside the command bus or validated lifecycle replacement;
- direct UI or agent mutation of records, chunks, typed-array backing data, or renderer objects;
- React, Three.js, React Three Fiber, Tauri, filesystem, network, or provider imports in semantic core packages;
- upward package dependencies, app imports from packages, deep cross-package imports, and dependency cycles;
- hidden ID, time, random, trigonometric intent, insertion-order, or worker-order dependence inside command handlers;
- serialized selection, camera, playback, preview, GPU, worker, agent scratch, diagnostics, history, or recovery runtime state;
- asset-category document types, core commands, constraints, tracks, or evaluators;
- unbounded parsing, allocation, inspection output, tool execution, agent iteration, or visual refinement;
- migrations that skip versions, silently discard unknown data, or overwrite a source before validated replacement;
- tests that require private implementation access when a public architectural seam exists.

## Changing the architecture

Use an ADR only for a decision that is hard to reverse, surprising without context, and selected from genuine alternatives. An architectural change is complete when:

1. the ADR records context, alternatives, decision, consequences, compatibility, migration, and rollback;
2. `ARCHITECTURE.md` reflects the resulting current contract;
3. dependency and architecture tests enforce the new rule;
4. schemas, commands, formats, migrations, goldens, and threat model are updated where affected;
5. the parent plan or follow-up issue records delivery impact.

Until all five conditions hold, the existing contract remains authoritative.

## Review checklist

Before approving a change, verify:

- [ ] The assigned user behavior crosses the highest practical seam end to end.
- [ ] Authoritative state has one owner and every write uses the correct capability.
- [ ] Commands are complete, serializable, deterministic, bounded, versioned, and conforming.
- [ ] Failed, stale, cancelled, or discarded work has no forbidden side effects.
- [ ] Runtime projections cannot become persisted or authoritative.
- [ ] Package dependencies point downward and platform types remain in adapters.
- [ ] The core remains generic across unrelated asset categories.
- [ ] Untrusted inputs are parsed and preflighted before allocation or mutation.
- [ ] Compatibility changes include explicit versions, migrations, and retained fixtures.
- [ ] Asynchronous work is revision-tagged, cancellable where required, and stale-safe.
- [ ] Tests assert external behavior with deterministic inputs and cover relevant failures.
- [ ] Security, privacy, accessibility, and performance effects are measured or explicitly unchanged.
