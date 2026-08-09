# Standard preview image export (v1)

**Plan:** S8.5/S15.1/S15.2 — PNG preview renderer/export, preview render
protocol, offscreen preview service.
**Ticket:** #25 — Export standard preview images.
**Status:** accepted (implementation baseline).

## Purpose

Users export consistent, shareable PNG images of the current asset from
four standard viewpoints: perspective, front, side, and top. Every image
uses a *fixed* protocol — framing, light, background, orientation, and
bounded requested dimensions — so exports from any document, machine, or
session look like one coherent set. Export is a pure read workflow:
previews never affect document semantics, history, dirty state, or the
canonical hash, and each file lands through a scoped atomic native write
with per-view progress, safe cancellation, and overwrite confirmation.
This document is the contract the ticket's acceptance criteria require.

## The render protocol (S15.1)

The protocol is defined in `@voxel-maker/renderer`
(`preview/preview-protocol.ts`) and is fully deterministic: the same
document and spec produce byte-identical pixels on any platform.

### Views and orientation (ADR-0001 frame: +X right, +Y up, +Z forward)

| View | Camera direction | Up | Projection |
|---|---|---|---|
| `perspective` | normalize(24, 20, 24) — the viewport's default camera direction | +Y | Perspective, 50° vertical FOV |
| `front` | +Z (looking at the asset's front) | +Y | Orthographic |
| `side` | +X (the asset's right side) | +Y | Orthographic |
| `top` | +Y (looking down) | −Z | Orthographic |

The top view's screen-up is −Z, matching the viewport's standard-view
convention: the asset front (+Z) points toward the *bottom* of the image.

### Framing

The camera target is the center of the document's world-space content
bounds (occupied voxels across all nodes, `worldContentBounds`). The
bounding sphere is fitted with `PREVIEW_FRAME_MARGIN = 1.2` on *both*
axes, so a portrait request widens the vertical half-extent instead of
clipping the horizontal one. The perspective distance follows from the
fitted half-height and FOV; orthographic views use the fitted
half-extents at a fixed viewing distance (`PREVIEW_ORTHO_DISTANCE`).
Empty documents use a deterministic fallback framing (target origin,
radius 8).

### Light and background

- Background: `#14161a` (the shell's base background) — opaque.
- Directional light: fixed world direction normalize(−0.5, 0.8, 0.5),
  ambient 0.35 + diffuse 0.65 (sums to 1 so lit colors never blow out),
  plus each material's emissive term (clamped).
- Shading is flat (per-face normals recomputed in world space, so node
  rotation and positive scale render correctly); colors are sRGB-encoded
  `#rrggbb` values; transparency uses straight-alpha over-compositing.

### Requested dimensions

The caller requests square dimensions. Bounds follow ARCHITECTURE.md's
hard default ("preview image | 2048x2048 and 16 MiB decoded RGBA"):
`MAX_PREVIEW_DIMENSION = 2048` per side and `MAX_PREVIEW_PIXELS =
4,194,304` (16 MiB decoded RGBA). The constants live once in
`@voxel-maker/shared` and are shared by the renderer protocol and the PNG
encoder. The shell offers 512/1024/2048 presets; the default is 1024.

## Rendering (`@voxel-maker/renderer`, S15.2 service)

`renderStandardPreview({ store, spec, shouldCancel? })` is pure compute
over `DocumentStoreRead`:

1. Gather the SAME face-culled chunk meshes the viewport shows
   (`buildChunkMesh`, S6.5), transformed into world space through each
   node's world matrix, with materials resolved to render constants
   (a missing material record falls back to a visible magenta).
2. Project through the fixed framing with an edge-function scanline
   z-buffer; perspective views near-clip (Sutherland–Hodgman) and
   fan-triangulate.
3. Opaque triangles render first (z-buffer), then transparent triangles
   painter-sorted far-to-near (stable tie-break by gather order),
   depth-tested, blended, without z-writes.

The result carries the rendered RGBA plus the framing metadata
(S15.2 "deterministic camera metadata"), the store revision, and the
canonical asset hash at render time. Cancellation is cooperative: the
`shouldCancel` poll runs between chunks and triangle batches and throws
`PreviewCancelledError` with zero side effects.

PNG encoding lives in `@voxel-maker/formats` (`encodePng`): RGBA8, color
type 6, filter 0, a dependency-free stored-DEFLATE zlib stream
(byte-exact, browser-safe; real compression is a documented follow-up
behind the same seam). Every input is validated and bounded before
allocation.

## Export workflow (`apps/desktop`, plan S8.7)

`createPreviewExportService` (composition root) drives one run:

```text
validate requested size
        │
        ▼
PNG-filtered save dialog (suggested <title>.png)
        │  user cancels -> abort
        ▼
derive four paths: <base>-perspective.png, -front.png, -side.png, -top.png
        │
        ▼
overwrite confirmation (one prompt listing every existing path; declining aborts)
        │
        ▼
per view: render -> encode -> scoped atomic write (progress: view + phase)
        │  cancel polled between chunks, views, and phases
        ▼
completed / cancelled (partial paths) / failed (structured error)
```

The overwrite preflight (`exists` checks plus the confirmation prompt)
is part of the run's error contract: a failing storage port surfaces a
structured `PREVIEW_IO_FAILED` error instead of an unhandled rejection.

### Scoped atomic native writes

`ImageStoragePort` (`@voxel-maker/storage`) is the adapter seam: memory
adapter for tests and the browser build, Tauri commands
`write_image_bytes_atomic`/`image_exists` (`src-tauri`) for the product.
The write is same-directory temp + flush + rename + best-effort directory
sync — the same order as project saves but with **no** `.bak` backup,
because previews are always reproducible from the document and must not
create sibling clutter. A failure before the rename leaves any previous
destination untouched. Writes are cancellation-safe by construction:
cancellation is only honored between views/phases, never mid-write.

### Semantic isolation

Export never mutates the document: no command bus, no history, no dirty
state, no journal, no autosave. The `.vxl` container already excludes
preview entries from the canonical hash (S5.5, `previews/` prefix in
`@voxel-maker/formats`); writing standalone PNGs shares that property by
never touching the container at all. The service result and tests pin
revision, semantic hash, and dirty state across runs.

## Acceptance evidence

- **Golden images** (`packages/renderer/src/preview/golden/*.png`,
  `golden.test.ts`): a representative fixture — an opaque 2×2×2 cube, a
  half-transparent voxel at a shared face, and a scaled child-node cube —
  is rendered for all four views at 96×96 and compared byte-for-byte
  against committed PNGs decoded with an independent zlib decoder.
- **Camera conventions** (`preview-protocol.test.ts`): directions, ups,
  framing margins, portrait widening, empty-content fallback, perspective
  distance, and the dimension/pixel bounds.
- **Materials/transparency/geometry** (`preview-renderer.test.ts`):
  occlusion, top-view orientation, straight-alpha blending at the shared
  face, magenta fallback for missing records, deterministic output, and
  no semantic/hash mutation.
- **Workflow** (`apps/desktop/src/export/preview-export.test.ts`): four
  valid PNG files, overwrite decline/accept, safe cancellation with
  partial paths, structured errors, and unchanged revision/hash/dirty.
- **PNG codec** (`packages/formats/src/png.test.ts`): independent-decoder
  round trips, multi-block streams, byte determinism, canonical
  structure, and bounded-input rejection with structured error codes.

## Follow-ups

- Real DEFLATE compression in the PNG encoder (behind the same seam).
- Writing previews into `.vxl` containers (`previews/` entries) and
  rendering them in the project picker (S15.x).
- Export of arbitrary custom camera views (the protocol stays
  standard-view only).
