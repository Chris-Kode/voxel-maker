# Support matrix v1

**Status:** v1 (issue #46, plan S17.8, ADR-0008)
**App version:** 0.1.0

## Supported platforms

| Platform | Minimum | Architectures | Required webview | Bundle targets |
|---|---|---|---|---|
| Windows | Windows 10 22H2 or Windows 11 | x86-64 | Evergreen WebView2 with WebGL 2 enabled | MSI, NSIS (EXE) |
| macOS | macOS 12 Monterey | Apple silicon and x86-64 | OS WKWebView | DMG, APP |
| Linux | Ubuntu 22.04 LTS (or glibc 2.35-compatible) | x86-64 | WebKitGTK 4.1 with hardware WebGL 2 (X11/Wayland) | DEB, RPM, AppImage |

Best effort, not release-blocking: Windows on ARM, macOS before 12,
32-bit systems, other Linux libc families, virtual machines, remote
desktops, software-only WebGL, browser/mobile builds. The app detects an
absent/blocked WebGL 2 context before opening the editor and shows a
user-safe compatibility error without touching the document.

## Hardware tiers (ADR-0008)

| Tier | Machine | Promise |
|---|---|---|
| Reference | 2020 Mac mini, Apple M1, 16 GiB, macOS 14 | 100k fixture ≥ 60 FPS and p95 input-to-preview < 50 ms; 500k ≥ 30 FPS; 1M opens ≤ 10 s, navigable ≥ 20 FPS, < 2 GiB memory; 100k open/save ≤ 2 s; 1M open/save ≤ 10 s; 10,000 tracks within the 16.7 ms p95 frame budget |
| Low | i5-8250U, 8 GiB, UHD 620, Windows 10 22H2 | 100k ≥ 30 FPS, p95 input-to-preview < 100 ms, open/save < 5 s, memory < 1.5 GiB |

Minimum hardware for support: 64-bit four-core CPU, 8 GiB RAM, 2 GiB
free storage, integrated GPU with WebGL 2 and ≥ 1 GiB graphics memory.
Cross-platform smoke additionally requires one supported Windows/NVIDIA
machine and one Ubuntu/AMD-or-Intel machine (CI matrix below).

## Input and display support

HiDPI 100/150/200%, mouse, trackpad, pen-as-pointer, standard keyboard,
reduced-motion OS setting. Touch-only editing, pressure brushes, and
multi-touch gestures are not v1 promises.

## Feature parity per platform

| Feature | macOS | Windows | Linux |
|---|---|---|---|
| Create/edit/rig/animate/save/recover/import/export | ✓ (qualified on this machine) | ✓ (CI native build + headless smoke; interactive qualification mechanical) | ✓ (CI native build + headless smoke; interactive qualification mechanical) |
| AI (OpenAI adapter, consent-gated) | ✓ | ✓ | ✓ |
| Keychain credential storage | ✓ (macOS Keychain) | ✓ (Windows Credential Manager via keyring) | ✓ (Secret Service / keyring) |
| Offline manual workflow | ✓ | ✓ | ✓ |
| Native file dialogs | ✓ | ✓ | ✓ |

## How the matrix is enforced

- PR CI: `pnpm check` + `check:security` + `check:audit` +
  `bench:smoke` on ubuntu-latest (`.github/workflows/ci.yml`).
- Scheduled CI (`.github/workflows/release.yml`): three-OS native
  `tauri build` + release smoke + checksums every night and on tag push,
  producing the platform artifact sets that make interactive
  qualification a mechanical install-and-run step.
- The per-platform evidence ledger (what was executed where, and what
  remains mechanical) is [clean-machine qualification](./clean-machine-qualification-v1.md).
