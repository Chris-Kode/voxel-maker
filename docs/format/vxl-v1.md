# Version 1 native `.vxl` container format

This document freezes the v1 native container layout (plan S5.1, ADR-0004,
ADR-0011). It is the schema of `manifest.json`, `document.json`, and the
`voxels/*.bin` streams inside a native project file. Changes to this contract
require a migration or an explicit compatibility break approved by ADR.

## Scope and guarantees

A v1 `.vxl` file is a deterministic ZIP archive holding one indexed canonical
document, sorted little-endian sparse voxel streams, and optional non-semantic
previews. The writer produces stable bytes for stable semantic content:
entries are stored uncompressed with a zero DOS timestamp, no extra fields,
and no comments; entry order is canonical; names are ASCII. Semantic identity
is SHA-256 over the canonical semantic bytes (below) and never includes ZIP
metadata, timestamps, previews, runtime chunk revisions, history, or recovery
data.

## Entry layout

```text
project.vxl (ZIP, stored entries, stable order)
├── manifest.json                 # container metadata + entry index
├── document.json                 # canonical document JSON (document-v1.md)
├── voxels/<volume-id>.bin        # one per volume, sorted by Volume ID
└── previews/<name>               # optional, sorted by name, not semantic
```

- `manifest.json` is always first; `document.json` second; voxel binaries
  sorted by Volume ID Unicode scalar sequence; previews last, sorted by name.
- Entry names are ASCII, relative, and free of empty, `.`, `..`, and
  backslash segments. Volume IDs are percent-encoded into file names:
  every UTF-8 byte outside `[A-Za-z0-9]` becomes an uppercase `%XX` escape,
  so arbitrary caller-supplied IDs (including non-ASCII text) can never
  form path segments.
- ZIP method is 0 (stored) only; readers reject any compression method.
  Compression is an adapter detail and never part of semantic identity.

## manifest.json

RFC 8785 canonical JSON (member order sorted by Unicode code unit):

```jsonc
{
  "containerVersion": 1,
  "documentSchemaVersion": 1,
  "chunkEncodingVersion": 1,
  "features": {},
  "semanticHash": "…64 lowercase hex…",
  "entries": [
    { "name": "document.json", "kind": "document", "size": 1234, "crc32": "1a2b3c4d" },
    { "name": "voxels/volume%3Ademo%3A0001.bin", "kind": "voxels", "volumeId": "volume:demo:0001", "size": 8220, "crc32": "5e6f7a8b" },
    { "name": "previews/front.png", "kind": "preview", "size": 99, "crc32": "c0ffee00" }
  ]
}
```

- Version fields evolve independently (ADR-0004). v1 supports version 1 of
  each; future majors add an ordered migration chain (ADR-0011).
- `features` is reserved; empty in v1 and ignored by readers.
- Unknown fields at the manifest or entry level are rejected
  (`UNKNOWN_MANIFEST_FIELD`): a claimed-supported version never guesses.
- `semanticHash` is SHA-256 over the canonical semantic bytes; the reader
  recomputes it from the reconstructed asset and rejects a mismatch.
- `entries` is the complete index of every non-manifest entry: name, role,
  size, and CRC-32 (8 lowercase hex digits). `volumeId` appears exactly on
  `voxels` entries and must equal the decoded entry name. Exactly one
  `document` entry is required; the reader cross-checks every indexed entry
  against the actual archive (names, sizes, checksums) and rejects unindexed
  or missing entries.

## voxels/<volume-id>.bin

All integers are little-endian:

```text
offset  size  field
0       4     magic "VXLV" (0x564C5856)
4       4     chunk encoding version (1)
8       4     chunk edge (16)
12      4     material width in bytes (2)
16      4     codec (1 = raw unsigned-16, X-fastest)
20      4     chunk count
24      4     reserved (0)
28      28*N  chunk records, strictly sorted by (x, y, z):
                0..12   x, y, z as signed 32-bit integers
                12..20  payload offset as unsigned 64-bit integer
                20..24  payload byte length (8192)
                24..28  CRC-32 of the payload
28+28*N  8192*N  payloads: 4096 unsigned-16 voxel values, X-fastest order
                 (index = x + 16 * (y + 16 * z)), little-endian
```

- Empty volumes are a 28-byte header with chunk count 0. Empty chunks are
  never written. Chunk payload bytes are byte-identical to the ADR-0004
  chunk stream frames, so the semantic hash can reuse them without
  re-encoding.
- Readers preflight magic, versions, geometry constants, exact total length,
  chunk count against limits, strict table order, in-domain coordinates,
  sequential offsets, and per-chunk CRC-32 before returning copied data.

## Canonical semantic identity (ADR-0004)

`canonicalSemanticHash` is SHA-256 over `canonicalSemanticBytes`:

```text
ASCII  "vxl-semantic-v1\n"
u64le  length of canonical document JSON bytes
bytes  canonical document JSON (document-v1.md)
then, for every volume sorted by Volume ID Unicode scalar sequence,
for every non-empty chunk sorted by signed (x, y, z):
  u32le  Volume ID byte length
  bytes  UTF-8 Volume ID
  i32le  x, y, z
  u32le  chunk byte length (8192)
  bytes  4096 unsigned-16 voxel values, X-fastest, little-endian
```

Lengths and coordinates are range-checked before encoding. The hash excludes
timestamps, archive compression, permissions, previews, UI state, runtime
revisions, history, recovery data, audit logs, and diagnostics. Reloading a
valid container preserves the hash; a save completes only when the live
semantic hash equals the hash captured with the snapshot revision.

## Versioning and compatibility policy

- The writer emits only current versions (all 1 in v1).
- The initial reader accepts every released version 1 format. After future
  majors exist, the reader supports the current major and up to the two
  immediately preceding released majors of each semantic format, with a
  complete ordered migration chain (ADR-0011). The document-schema part of
  that chain lives in the `@voxel-maker/model` migration registry
  (`createMigrationChain`, plan S2.11): ordered pure `vN -> vN+1` steps, no
  skipping, a retained fixture per transition, and a report of what ran.
  While v1 is the only released major the registry is empty and every
  reader gate (manifest field, document field, chain input) rejects
  anything else; the first major that bumps `documentSchemaVersion` wires
  the registry into the reader together with backup-on-upgrade (plan
  S5.11) and must retain its transition fixture before the chain grows.
- Unknown future versions, unknown persistent fields inside a
  claimed-supported version, and missing migration steps fail clearly and
  never enable overwrite of the source file. The reader is pure: a rejected
  or migrated read returns data or a structured error and never touches the
  source bytes; only a later, explicitly user-approved save may replace the
  original, and only after the migrated asset validated (plan S5.11).
- Command journals are replayed only when their exact snapshot identity and
  command-version migration chain are supported (recovery, ticket #14).
- The v1 chunk payload framing is exactly 8,192 bytes (4096 unsigned-16
  values) and is the only framing this contract has ever defined. A writer
  bug (issue #85) briefly emitted 16,384-byte chunk frames whose manifest
  `semanticHash` no conforming reader can reproduce; since no release
  shipped that framing (no tags, package 0.1.0 unreleased), the corrected
  writer regenerated the checked-in fixture corpus
  (`scripts/generate-native-fixtures.mjs`, `fixtures/native/README.md`)
  instead of adding a reader-side migration. Files written with the buggy
  framing are rejected by the reader with `SEMANTIC_HASH_MISMATCH` and are
  never silently accepted or overwritten.

## Reader preflight summary

Before returning any data, the reader validates: ZIP structure and EOCD
sanity (including agreeing entry counts and no multi-disk archives); path
safety, duplicates, and name bounds; entry count, per-entry and total size
limits; stored-only method (compression is a compatibility error); ZIP64
size/offset/length markers; the stored-format ratio preflight (declared
entry sizes may never exceed the archive byte length, rejecting size bombs
before extraction); central/local header consistency; non-overlapping data
ranges; per-entry CRC-32; manifest versions and index consistency; document
schema version and document limits; volume chunk table structure, geometry,
coordinates, safe u64-to-Number offsets, and checksums; and finally the
semantic hash. Container-level defaults (plan S5.4 / ADR-0009) may only be
lowered by callers: a 512 MiB raw input-file cap (issue #96, enforced
before any scan), 4096 entries, 256-byte names, 1 GiB per entry, 2 GiB
total. The writer enforces the same defaults, so it can never emit a
container its own reader rejects.

A checked-in adversarial and compatibility corpus
([`fixtures/native/`](../../fixtures/native/), plan S5.12) pins this
contract: `corpus.json` maps every rejected fixture to the exact stable
`family`/`code` it must produce (traversal, duplicates, bombs, truncation,
huge declarations, ZIP64 markers, checksum failures, missing and unindexed
references, document cycles, chunk-table corruption, future versions, and
unknown fields), and the golden fixture pins the writer's bytes and the
semantic hash.
