---
status: accepted
---

# Native locking and external-format compatibility

Native files need an explicit backward and concurrent-open policy, while MagicaVoxel and glTF need intentionally lossy mappings rather than implied round-trip compatibility.

## Decision

### Native compatibility and locking

The initial reader accepts native container, Document, voxel-encoding, component, and animation versions for which a complete ordered migration chain to the current writer exists. The minimum compatibility promise after version 1 is the current major version and the two immediately preceding released major versions of each native semantic format. The writer emits only current versions. A release may support older versions longer, but dropping any version inside that window requires a breaking release and migration tooling. Unknown future versions, unknown persistent fields/components within a claimed-supported version, and missing migration steps fail clearly and never enable overwrite of the source.

Command journals are replayed only when their exact snapshot identity and command-version migration chain are supported; the native file compatibility window does not promise arbitrary historical journal replay. Opening a migrated file reports every migration. The first save defaults to Save As; replacing the source requires explicit confirmation and a last-known-good backup.

A writable open acquires an adjacent `<filename>.vxl.lock` using exclusive creation. The lock contains only a format version, random session nonce, process ID, machine-local instance ID, and creation/heartbeat times; it is runtime coordination data and never part of semantic identity. Failure to acquire opens read-only by default. The user may retry, choose Save As, or explicitly steal the lock only after a second check shows that the owning process is absent on the same machine or the heartbeat is older than 30 seconds. Remote/unverifiable locks are never auto-stolen. Lock loss during editing marks the session unable to overwrite the path; work remains editable and may be saved elsewhere. Closing removes only a lock whose nonce still matches. Locks are advisory protection, not a merge protocol; collaborative editing is unsupported.

Paths are canonicalized after the user selects them, and lock/save checks defend symlink replacement and time-of-check/time-of-use changes through the native adapter. A lock never authorizes access outside the scoped selected path.

### MagicaVoxel `.vox` subset

Import and export target MagicaVoxel VOX version 150. The initial subset reads `MAIN`, optional `PACK`, paired `SIZE`/`XYZI`, and optional `RGBA`; missing `RGBA` uses the version-150 default palette. Palette index zero is empty, used palette entries become Materials, and duplicate voxel coordinates are rejected. The right-handed file basis maps to the editor basis as `(vox x, vox y, vox z) -> (X, Y, Z) = (vox x, vox z, -vox y)`; export applies the inverse. Integer coordinates remain exact. Golden files authored in MagicaVoxel must verify the orientation before the codec is promoted.

`nTRN`, `nGRP`, `nSHP`, `LAYR`, materials, cameras, notes, and other extension chunks are not interpreted in the initial subset. Import of a file containing scene-graph chunks requires a preflight warning and imports each model as a separate root Node at identity transform; encoded graph transforms and layer visibility are not applied. Unknown chunks are skipped only when their declared bounded lengths are structurally valid, and are listed in the import report. Malformed lengths, unsupported model dimensions, or resource-limit violations reject the import atomically.

Export supports one or more identity-transformed Voxel Volumes whose occupied bounds each fit 256×256×256 and whose combined palette fits 255 non-empty colors. Because the subset writes no scene transform, coordinates that do not fit the unsigned model cube require an explicit “rebase each model to local origin” choice and a reported origin loss; otherwise export is blocked. It writes `PACK` when needed and writes `SIZE`, `XYZI`, and `RGBA` deterministically. Hierarchy, non-identity transforms, pivots, joints, constraints, Clips, metadata, opacity, roughness, metallic, emissive values, and Material distinctions that quantize to the same palette color are unsupported. Preflight must either require an explicit bake/flatten choice where a deterministic supported conversion exists or block the export with a structured loss report; it never silently drops semantic content. `.vox` is interchange, not the canonical backup format.

### glTF 2.0 / GLB export mapping

The initial release exports glTF 2.0 JSON plus buffers and binary GLB; glTF import is deferred. One voxel edge maps to one meter. The editor and glTF bases are both emitted as right-handed `+Y` up with `+X` right; editor `+Z` forward is retained as positive glTF Z, while consumers' camera-forward conventions do not alter asset coordinates. Node hierarchy and ordered local translation, canonical quaternion rotation, and positive scale map to glTF Nodes. Pivot transforms use deterministic helper Nodes so static and animated world transforms remain equivalent; helper identity is reported in export metadata and goldens.

Voxel surfaces export as renderer-independent indexed triangle meshes grouped by Material. Base color and opacity map to `baseColorFactor`, roughness and metallic to their PBR factors, and emissive to `emissiveFactor`; alpha below one uses `BLEND`, otherwise `OPAQUE`. Unsupported renderer effects are reported, not approximated silently. Clips map to glTF animations with translation, rotation, and scale channels. Step and linear interpolation map directly; smoothstep is deterministically baked to linear samples within configured export limits. Quaternion samples use shortest-path canonical values. Clip loop policy is reported as a limitation because glTF does not encode playback looping. Constraints, joint annotations, inert metadata without an approved extension, editor history, Skills, and runtime state are omitted only after a visible preflight loss report. Names are sanitized and made unique deterministically without changing stable ID mappings.

## Considered options

- Best-effort opening of future native files was rejected because unknown semantics could be destroyed on save.
- Writable concurrent opens and automatic stale-lock theft were rejected because there is no merge protocol.
- Full MagicaVoxel scene/material support was rejected as an uncontrolled expansion of the first interchange slice.
- Silent flattening on `.vox` export was rejected because it can lose hierarchy and animation.
- Treating glTF as a lossless native representation was rejected because constraints, metadata, loop policy, voxel structure, and editor state do not map exactly.
- Baking all pivots and animation directly into geometry was rejected because helper Nodes preserve hierarchy and motion with less loss.

## Consequences

Native migration fixtures must cover the declared window, and lock fault tests cover crash, stale, remote, symlink, and nonce mismatch cases. `.vox` and glTF goldens fix axes, palette/material conversion, pivots, hierarchy, and animation. Every external write follows preflight and scoped atomic-save policy.

## Gates

This decision gates native persistence/recovery (#11–#14), lifecycle UI (#22), MagicaVoxel interchange (#24), static and animated glTF export (#41 and #42), hostile-input hardening (#44), and release qualification (#46).
