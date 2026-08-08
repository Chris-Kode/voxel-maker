---
status: accepted
---

# Coordinate, transform, and canonical number semantics

Coordinate and numeric conventions must be identical across commands, storage, rendering, and export or deterministic replay becomes impossible. We adopt one right-handed coordinate system, grid convention, canonical transform, and canonical encoding policy.

## Decision

The semantic model uses a right-handed `+X` right, `+Y` up, `+Z` forward coordinate system with one voxel equal to one scene unit; integer voxel locations; half-open regions; radians; mathematical floor division and positive modulo for negative chunk coordinates; and finite, strictly positive scale. Canonical transforms store translation, pivot, quaternion rotation, and scale and evaluate as `T(position) × T(pivot) × R(rotation) × S(scale) × T(-pivot)`; matrices remain runtime-only. Quaternions serialize as finite normalized `[x,y,z,w]` values with a positive-`w` sign rule and first-nonzero-positive tie-break, while non-finite values and serialized `-0` are rejected; trusted command constructors canonicalize computed `-0` to `0` before encoding. Canonical JSON is UTF-8 without a BOM and follows RFC 8785 JSON Canonicalization Scheme for object-member ordering, string escaping, and ECMAScript shortest round-trippable number text; arrays preserve schema-defined order. Validated schemas omit absent optional fields, preserve explicit `null` only where allowed, and reject unknown fields and serialized `-0` before canonicalization. It does not quantize caller-authored finite values. Math predicates use an absolute epsilon of `1e-9` without changing semantic equality; command constructors quantize platform-sensitive derived transform components to `1e-9`, canonicalize magnitudes below `5e-10` to zero, normalize and sign-canonicalize rotations, and reject a matrix decomposition whose recomposition differs by more than `1e-9` per element. Canonical colors are lowercase `#rrggbb` or `#rrggbbaa`; color-space conversion is runtime renderer behavior. Callers perform this canonicalization before command execution. Right-angle region rotation uses integer local coordinates anchored at the source half-open region minimum (for example `+90°` about Z maps `(x,y,z)` to `(sizeY - 1 - y,x,z)`) and version 1 writes with explicit `overwrite` collision policy. Material opacity is canonical in `[0,1]`; transparent voxels remain occupied and pickable, and a face adjacent to any non-opaque voxel remains visible for blending.
## Considered options

- Left-handed coordinates or another forward axis were rejected because they would move conversion ambiguity into every renderer and exporter boundary.
- Inclusive regions were rejected because composition and size arithmetic become error-prone at chunk boundaries.
- Persisted matrices and handler-side decomposition were rejected because equivalent transforms have multiple encodings and decomposition can vary numerically.
- Blanket decimal quantization of authored values was rejected because it would silently change valid intent; only platform-derived transform intent crosses the frozen quantization seam.
- Negative node scale was rejected for version 1 because reflection interacts ambiguously with winding, constraints, and export; geometry reflection is an explicit voxel operation.

## Consequences

Importers and exporters must convert at their boundary. Math, command constructors, serializers, and golden fixtures must enforce one canonical representation. Changing these rules requires a new compatible encoding or migration rather than a silent reinterpretation.

## Gates

This decision gates generic document and voxel semantics (#5–#9), hierarchy and transform editing (#10, #19–#20), rigging and animation (#26–#30), deterministic generation (#37), and external export (#41–#42).
