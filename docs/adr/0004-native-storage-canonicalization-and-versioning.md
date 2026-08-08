---
status: accepted
---

# Native storage, canonicalization, and versioning

Native storage must survive interruption while producing stable semantic identity across platforms and archive libraries. We adopt an independently versioned ZIP container, exact canonical semantic bytes, explicit migrations, and immutable-snapshot atomic saves.

## Decision

The native `.vxl` format is a versioned ZIP container with a canonical manifest and document JSON, coordinate-sorted little-endian sparse voxel streams, and optional non-semantic previews. Document, chunk encoding, command, journal, and container versions evolve independently and migrate one supported version at a time. Semantic identity is SHA-256 over `canonicalSemanticBytes`: ASCII `vxl-semantic-v1\n`; an unsigned 64-bit little-endian canonical-document byte length; the RFC 8785 UTF-8 Document bytes; then each non-empty chunk sorted by Volume ID Unicode scalar sequence and signed `(x,y,z)`, framed as unsigned 32-bit little-endian Volume ID byte length, UTF-8 Volume ID, three signed 32-bit little-endian coordinates, unsigned 32-bit little-endian chunk byte length, and all 4096 unsigned-16 voxel values in X-fastest little-endian order. All lengths and coordinates are range-checked before encoding. CRC detects container or journal corruption but is not identity. Saves capture an immutable snapshot pair `(Revision R, semantic hash H_R)`, write and flush a same-directory temporary file where supported, atomically replace the destination, and preserve a last-known-good backup.
## Considered options

- A monolithic JSON file was rejected because bulk voxel data is large and inefficient while still needing deterministic ordering.
- A library-specific ZIP representation was rejected because archive-library behavior is an adapter detail and compression metadata is not semantic.
- Hashing compressed bytes was rejected because compression, timestamps, permissions, and entry metadata can vary without semantic change.
- In-place save was rejected because interruption could destroy the last known-good project.
- Best-effort loading of unknown future versions was rejected because guessing can silently corrupt source material.

## Consequences

Readers must preflight path safety, duplicates, sizes, ratios, offsets, codecs, checksums, and configured limits before allocation. Format changes require retained golden fixtures plus migration or an explicit compatibility-break ADR. A stale save completion records `R` as the durable snapshot and clears dirty state only when the live semantic hash equals captured `H_R`; a Revision and a hash are never compared to each other.

## Gates

This decision gates canonical document round-tripping (#5), native format, migration, save, and recovery (#11–#14), lifecycle workflows (#22), MagicaVoxel and preview output (#24–#25), security hardening (#44), and release compatibility (#46).
