# Performance benchmarks and scale gates v1

**Status:** v1 (ticket #45, plan S6.16/S17.4, ADR-0008)

The headless benchmark harness in `@voxel-maker/benchmarks` (CLI
`@voxel-maker/bench-cli`, command `voxel-maker-bench`) makes the ADR-0008
scale and responsiveness gates reproducible: deterministic 100k/500k/1M
occupied-voxel scenes in the three ADR-0008 surface classes, measured
through the same seams the desktop uses (command bus, dirty-chunk
scheduler and mesher, native container codecs, glTF export service, the
deterministic software preview renderer, and the animation runtime), with
no GPU and no wall clock in fixtures.

## Fixtures (plan S6.16)

| Kind | Surface | Layout |
|---|---|---|
| `compact` | low surface | solid slab (100x100x10 / 50 / 100) |
| `checkerboard` | high surface | `(x+y+z)%2` occupancy, exact half density |
| `sparse` | scattered | seeded scatter, exact target occupancy |

Sizes are nominal occupied-voxel targets: 100,000 / 500,000 / 1,000,000.
Every fixture commits through the store's staging surface with a fixed
seed and stable branded ids; the committed document's canonical semantic
hash is recorded and asserted to survive the native save/load round trip,
so a fixture change (and therefore a trend baseline change) cannot happen
silently.

## Measured metrics

| Metric | What it measures | Gate (reference tier) |
|---|---|---|
| one-voxel commit | a `setVoxel` Transaction through the command bus, p95 | < 8 ms |
| localized remesh | one face-culled chunk mesh through the scheduler's worker-like executor, p95 | < 30 ms |
| queue wait | schedule -> install wait of a localized mesh, p95 | reported |
| per-frame flush | one scheduler `flush()` (dispatch + install budgets), p95 | < 16.7 ms |
| input-to-preview | commit + remesh + flush, p95 (composite headless proxy of the viewport pipeline) | < 50 ms |
| save / load | canonical `.vxl` write / validated read, p95 (5 runs) | < 2 s (100k), < 10 s (1M) |
| export | glTF/GLB export through the storage port, p95 + output bytes + peak RSS | reported; 100k always; larger sizes when the named machine can hold the intermediates; structured blocks (e.g. the export service's 1M-face limit) recorded as evidence |
| preview | deterministic software preview render (100k scenes only), p95 | reported (preview-export pipeline, not the viewport path) |
| memory | process RSS/heap peak of the editor footprint (fixture + installed meshes) | < 2 GiB (1M) |
| animation | layered runtime evaluation per frame at 100 / 1k / 10k tracks, p95 | < 16.7 ms at 10k |
| playback integrity | revision, history, and semantic hash before/after animation frames | unchanged |

### Frame-time proxy

The desktop viewport's GPU frame time is qualified on the named desktop
tiers (ADR-0008 measurement method). Headless, the harness measures the
main-thread frame pipeline — one scheduler flush (resolve copies,
dispatch, install within the frame budgets) and one full animation
runtime evaluation — which is the reproducible proxy CI can gate. The
flush budget gates (16.7 ms at 100k, 33.3 ms at 500k, 50 ms at 1M)
correspond to the 60/30/20 FPS ADR-0008 targets.

Export intermediates are excluded from the interactive memory gate
(export reports its own peak RSS); preview renders are measured only on
the 100k interactive target because the software rasterizer's transient
allocation churn scales with the scene's triangle count.

## Hardware tiers and gates

Tiers are resolved from the CPU model when the hardware is named
(`resolveTier`), and can be forced with `--tier`:

- **reference** — Apple M1 / 16 GiB (2020 Mac mini): the ADR-0008 gates
  in the table above are asserted (commit, remesh, flush, input-to-
  preview, 100k/1M save-load, 1M memory, 10k-track animation, no
  mutation).
- **low** — i5-8250U / UHD 620 / 8 GiB: 30 FPS flush proxy, input-to-
  preview < 100 ms, save/load < 5 s, memory < 1.5 GiB.
- **ci-smoke** — any other machine (CI runners): broad regression-
  detection thresholds (commit < 200 ms, remesh < 1 s, flush < 200 ms,
  save/load/export < 60 s, memory < 6 GiB, zero failed meshing jobs,
  10k-track animation < 200 ms, no persistent mutation). CI smoke gates
  never claim reference-tier numbers.

A missed gate fails the CLI (exit code 1) and blocks the CI step.

## Retained trends

`--trends <path>` compares the run against the newest retained row on the
same named hardware and appends a new row. Rows are flattened to stable
keys (`<kind>.<size>.<metric>`, e.g. `compact.100000.command.p95`),
tagged with the named hardware (CPU model, platform, arch, cores,
memory, Node version). A value regressing beyond tolerance (+20%
relative and > 2 ms absolute) fails the run, so regressions are
detected against retained evidence on the same hardware, not only
against absolute thresholds.

The tier alone is not the hardware identity: a row from a different
machine class (for example a rotated runner CPU generation on the same
`ci-smoke` tier) is never used as a baseline, so hardware rotation
cannot masquerade as a regression. The search skips such rows and uses
the newest row that matches the current named hardware, so alternating
machines (A, B, A) still compare each run against its own machine's
prior baseline; a fresh baseline starts only when no matching row
exists.

## Running

```sh
pnpm bench:smoke   # CI smoke: 100k compact+checkerboard, broad gates
pnpm bench:full    # full matrix + trends file (scheduled CI)
pnpm bench:local   # 100k/500k local qualification run
node apps/bench-cli/dist/cli.js --help
```

Every numeric option (`--sizes`, `--samples`, `--save-load-runs`,
`--preview-samples`, `--preview-size`, `--animation-frames`) must be a
positive integer. A malformed, zero, or negative value exits non-zero
with an argument error before any fixture allocation or output write
(ticket #57); a mistyped count can never certify zero-sample gates. As a
defensive second layer, gate evaluation fails any required metric whose
summary carries zero samples instead of treating empty summaries as
measurements.

On a named tier machine, qualify with:

```sh
node apps/bench-cli/dist/cli.js --tier reference --full   --samples 100 --save-load-runs 5 --json benchmarks/out/reference.json
```

## CI

- `.github/workflows/ci.yml` runs `pnpm bench:smoke` on every PR and
  main push (smoke thresholds).
- `.github/workflows/benchmark.yml` runs the full matrix on a schedule
  (and on demand), uploads the JSON report and trend history as
  artifacts, commits the appended trends to the `benchmark-trends`
  branch (retained evidence), and fails when a gate or a retained trend
  regression fails.

## Known limitations

- Headless measurements cover the CPU/main-thread seams; the GPU frame
  time, HiDPI, and battery-state protocol are desktop qualification
  (ADR-0008).
- Save/load "cold" runs are repeated in-process runs; five cold process
  starts are a desktop qualification step.
- Memory snapshots run after an explicit V8 full GC (`--expose-gc`, set
  by the benchmark scripts and CI). The report records both RSS and
  heap-used; the gates use the process peak RSS, which is a conservative
  upper bound of the single-scene footprint (V8 does not return freed
  pages to the OS), and heap-used reflects the live single-scene
  footprint.
- The 1M fixture is a reference-tier viewability gate; low tier and CI
  smoke do not assert 1M budgets.
- glTF export intermediates currently scale with voxel count (per-voxel
  box geometry; ~8-20 KB/voxel measured). The harness therefore exports
  500k/1M fixtures only when the named machine has enough memory, and
  records the skip otherwise; merging/greedy export meshing is a
  follow-up optimization, not a gate change.
- At 500k+ occupied voxels the export service refuses the volume with the
  structured `GLTF_FACE_LIMIT` error (default 1M faces, ADR-0011) before
  writing bytes; the benchmark records that block as graceful-degradation
  evidence.
