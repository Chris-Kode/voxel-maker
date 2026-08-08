---
status: accepted
---

# Default resource limits and escalation policy

Every untrusted or potentially expansive input needs a fixed default before parsers, Commands, history, animation, and agent tools allocate memory. Limits are product policy, not adapter guesses.

## Decision

The following initial-release limits apply after migration and before allocation or persistent mutation. Counts are totals per open Document unless a narrower scope is named.

| Resource | Hard default |
|---|---:|
| voxel coordinate on any axis (inclusive) | `[-1,048,575, 1,048,575]` |
| occupied extent on any axis (`max - min`) | 2,048 |
| Nodes / Voxel Volumes | 10,000 / 1,024 |
| allocated non-empty Chunks / occupied voxels | 262,144 / 1,000,000 |
| Materials | 4,096 (IDs remain unsigned 16-bit) |
| Commands per Transaction | 1,024 |
| canonical command payload / Transaction envelope | 1 MiB / 16 MiB |
| voxels inspected, generated, or changed by one Transaction | 1,000,000 |
| history | 512 entries and 256 MiB of retained inverse data |
| native/external input file | 512 MiB compressed or on disk |
| archive entries / expanded bytes / per-entry bytes | 4,096 / 2 GiB / 512 MiB |
| archive expansion ratio | 100:1 per entry and in aggregate |
| metadata | depth 16, 10,000 members, 1 MiB canonical total, 64 KiB per string |
| Clips / Tracks / keyframes | 256 / 10,000 / 1,000,000 |
| keyframes per Track / Clip duration | 100,000 / 86,400 seconds |
| preview image | 2048×2048 pixels and 16 MiB decoded RGBA |
| concurrent worker jobs / queued jobs | logical CPU count capped at 8 / 256 |

Coordinates must also be safe for checked integer chunk math; an operation whose result would exceed either coordinate or extent limits fails before staging. Empty Chunks do not count toward the Chunk limit. File limits apply before decompression, and declared sizes, actual sizes, offsets, multiplication, and cumulative allocation are checked with overflow-safe arithmetic. A lower platform allocation ceiling wins over these product maxima.

Each AI session has these additional hard defaults:

| AI resource | Hard default |
|---|---:|
| model rounds / tool calls | 16 / 64 |
| proposed Commands / proposed voxel changes | 1,024 / 1,000,000 |
| proposed or modified Tracks / keyframes | 256 / 10,000 |
| proposed Clip duration | 3,600 seconds |
| inspection plus tool-result bytes | 4 MiB |
| input plus output tokens | 128,000 |
| elapsed wall time | 10 minutes |
| estimated provider spend | USD 5.00 |
| visual-refinement iterations / transmitted images | 3 / 12 |

The adapter must stop before a request that would exceed a known token or cost remainder. Provider usage that cannot be estimated is disabled until the user selects an explicit lower provider-side cap; it is never treated as unlimited. Cancellation releases previews and queued work but does not misrepresent an already committed Transaction as rolled back.

Hard limits are never bypassed by a confirmation dialog. They return a stable `LIMIT_EXCEEDED` family error naming the resource, configured maximum, and requested or safely estimated amount; rejection leaves Document, Revision, history, dirty state, journal, events, previews, and rendered state unchanged as applicable. Limits may be lowered by deployment or tests. Raising a hard limit requires a reviewed policy/configuration change and benchmark or adversarial evidence; ordinary project files and AI prompts cannot raise it.

Operations estimated to touch more than 100,000 voxels, retain more than 64 MiB of new inverse history, overwrite an existing file, steal a project lock, migrate a source file, or transmit any image require an explicit pre-execution confirmation even when below hard limits. AI proposal Apply always requires approval under ADR-0007. Confirmation captures exact bounded intent and is not a license for the executor to allocate beyond its preflight estimate.

When history reaches either bound, the application may evict the oldest sealed entries only after their recovery/journal retention is no longer required; it reports the shortened undo horizon. It must never evict current state, uncommitted work, or data still required for safe recovery.

## Considered options

- Memory-pressure-only limits were rejected because failure would depend on machine and allocator timing.
- One global byte ceiling was rejected because coordinates, graph depth, decompression, metadata, animation, and provider spend fail through different amplification paths.
- Confirmation above every hard limit was rejected because consent cannot make integer overflow, denial of service, or unbounded provider cost safe.
- Fixed unconfigurable limits forever were rejected because later benchmark evidence may justify a versioned policy change.

## Consequences

Parsers, command constructors, the command bus, history, workers, importers, exporters, and agent sessions share one injected immutable limit profile. They may enforce smaller format-specific bounds but may not silently enlarge these defaults. Tests need boundary, just-over-boundary, overflow, atomic-rejection, and cancellation evidence.

## Gates

This decision gates the workspace contracts (#4), all Document and Command behavior (#5–#10), persistence and recovery (#11–#14), renderer scheduling (#23), import/export (#24, #25, #41, #42), AI tools and sessions (#31–#40), hardening (#44), scale qualification (#45), and release (#46).
