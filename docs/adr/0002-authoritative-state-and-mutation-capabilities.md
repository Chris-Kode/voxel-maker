---
status: accepted
---

# Authoritative state and mutation capabilities

Multiple write authorities would let UI, lifecycle, renderer, and AI behavior enforce incompatible invariants. We assign one authoritative semantic owner, one command mutation capability, one validated lifecycle replacement exception, and isolated runtime projections.

## Decision

`DocumentStore` and `VoxelRepository` jointly own authoritative semantic state behind private write capabilities. Every persistent edit to an open Document goes through the command bus. `DocumentSession` alone may replace the complete aggregate and volumes for create, open, migration, approved recovery, or close, and only after full validation. Editor, renderer, playback, worker, preview, diagnostic, and agent scratch state are runtime projections; a `PreviewSession` has write authority only within its isolated copy-on-write namespace.
## Considered options

- Public mutable repositories and feature-specific write APIs were rejected because they create mutation paths that bypass shared validation, history, and recovery.
- Treating lifecycle replacement as a large edit was rejected because opening and recovery install a complete validated authority rather than express incremental intent.
- Persisting selection, evaluated animation, previews, or renderer state was rejected because projections can be rebuilt and would make semantic identity platform- or session-dependent.
- Letting AI own a parallel JSON document was rejected because human and AI edits would then obey different invariants.

## Consequences

Public reads must be immutable snapshots, copies, or accessors and may not leak mutable backing stores. Composition roots inject capabilities; semantic packages cannot discover integrations globally. Lifecycle replacement cannot be used as an editing shortcut.

## Gates

This decision gates the executable workspace seam (#4), document and command work (#5–#10), persistence and recovery (#11–#14), desktop/editor projections (#15–#23), and all preview and AI work (#31–#40).
