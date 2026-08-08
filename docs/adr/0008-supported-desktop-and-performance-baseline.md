---
status: accepted
---

# Supported desktop and performance baseline

The initial release needs a support promise that can be tested before platform-specific behavior becomes accidental. We support a bounded desktop matrix, require WebGL 2, preserve a complete offline manual workflow, and qualify performance on named low and reference tiers.

## Decision

### Supported platforms

| Platform | Initial-release minimum | Architectures | Required webview |
|---|---|---|---|
| Windows | Windows 10 22H2 or Windows 11 | x86-64 | Evergreen WebView2 with WebGL 2 enabled |
| macOS | macOS 12 Monterey | Apple silicon and x86-64 | The OS-supplied WKWebView |
| Linux | Ubuntu 22.04 LTS, or a binary-compatible distribution with glibc 2.35 | x86-64 | WebKitGTK 4.1 with hardware WebGL 2 support under X11 or Wayland |

Windows on ARM, macOS before 12, 32-bit systems, other Linux libc families, virtual machines, remote desktops, software-only WebGL, and browser/mobile builds are best effort and not release-blocking. The application must detect an absent or blocked WebGL 2 context before opening the editor and show a user-safe compatibility error; it must not corrupt or rewrite a Document merely because rendering is unavailable.

The minimum hardware tier is a 64-bit four-core CPU, 8 GiB system RAM, 2 GiB available storage, and an integrated GPU capable of WebGL 2 with at least 1 GiB shared or dedicated graphics memory. The reference tier is a 2020 Mac mini with Apple M1, 16 GiB unified RAM, its integrated GPU, and macOS 14. The low tier is a Windows 10 22H2 laptop with Intel Core i5-8250U, 8 GiB RAM, and Intel UHD 620 graphics. Equivalent machines are supported, but published performance claims are reproduced on these named tiers. Release smoke coverage also includes one supported Windows/NVIDIA machine and one Ubuntu/AMD-or-Intel machine so a pass on Apple hardware cannot stand in for cross-platform qualification.

HiDPI at 100%, 150%, and 200% scale, mouse, trackpad, pen-as-pointer, and a standard keyboard are supported. Touch-only editing, pressure-sensitive brushes, and multi-touch gestures are not initial-release promises.

### Offline and accessibility baseline

Creating, opening, editing, undoing, rigging, animating, saving, recovering, importing, exporting, and viewing local help require no account, provider credential, telemetry consent, or network. When offline or unconfigured, AI controls explain their unavailable state without blocking or degrading these workflows. Network-dependent update checks fail silently except for an explicit non-blocking status; they never block launch or local files.

The desktop UI targets the applicable WCAG 2.2 AA success criteria. Release qualification requires complete keyboard traversal of menus and panels, visible focus, programmatic names for controls, text contrast of at least 4.5:1 (3:1 for large text), non-text UI contrast of at least 3:1, status/error announcements, 200% UI scaling without lost workflows, and reduced-motion behavior following the OS setting. The 3D viewport exposes named commands and equivalent inspector/timeline controls for persistent edits; interpreting spatial voxel content with a screen reader is not promised. Shortcut remapping must not capture ordinary text entry.

### Performance gates

A release build is measured while plugged in, with default quality settings, a fixed camera and 1920×1080 logical viewport forced to device-pixel ratio 1 (a 1920×1080 framebuffer), after a 10-second warm-up. Frame and latency gates use at least 30 seconds or 100 samples and report p95; save/load uses five cold process runs. Fixtures include compact, sparse, and checkerboard/high-surface geometry so occupied-voxel count cannot hide pathological chunk or face counts. HiDPI qualification is a separate support test and does not alter benchmark DPR.

On the reference tier:

- the 100k-occupied-voxel fixture sustains at least 60 FPS, with p95 input-to-preview below 50 ms;
- a one-voxel Transaction commits in p95 below 8 ms, excluding asynchronous meshing;
- a localized face-cull remesh completes in a worker in p95 below 30 ms;
- editing produces no repeated main-thread task longer than 50 ms;
- the 500k fixture sustains at least 30 FPS in the reference view;
- the 1M fixture opens in at most 10 seconds, remains navigable at at least 20 FPS, and keeps total process memory below 2 GiB;
- the canonical 100k native file opens in at most 2 seconds and saves in at most 2 seconds; the canonical 1M native file opens and saves in at most 10 seconds;
- playback of 10,000 active Tracks stays within a 16.7 ms frame budget in p95.

On the low tier, the 100k fixture must remain usable at at least 30 FPS, p95 input-to-preview below 100 ms, open/save within 5 seconds, and total process memory below 1.5 GiB. The 1M fixture is a reference-tier viewability gate, not a low-tier editing promise.

A missed gate blocks release or requires an explicit support-matrix change; it is not converted into an anecdotal known issue. Long work reports progress, permits cancellation where safe, retains the last good rendered Revision, and never compromises semantic state.

## Considered options

- Supporting every Tauri-capable operating system was rejected because it creates an untestable compatibility promise.
- WebGL 1 and a software-rendering fallback were rejected because they cannot meet the renderer and worker performance baseline reliably.
- Online activation and account-gated features were rejected because the complete manual workflow is explicitly offline-first.
- A single high-end benchmark machine was rejected because it would hide modest-hardware regressions.
- A global FPS target without fixed fixtures and methodology was rejected because it is not reproducible.

## Consequences

Desktop packaging and E2E qualification must cover every supported OS and architecture. Unsupported graphics fails before an editing session begins, while headless semantic and file validation remain GPU-independent. Accessibility and performance failures are release failures, not optional polish.

## Gates

This decision gates workspace and desktop bootstrap (#4 and #15), rendering and editor interaction (#16–#23), accessibility (#43), performance qualification (#45), and release packaging (#46).
