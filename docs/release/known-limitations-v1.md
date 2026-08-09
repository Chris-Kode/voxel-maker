# Known limitations v1

**Status:** v1 (issue #46, plan §16 deferred backlog, S17.11)
**App version:** 0.1.0

This is the honest list of what the initial release does **not** do.
Nothing here is silent: every external format path reports losses or
unsupported chunks, and every deferred feature is tracked in plan.md §16.

## Platform and distribution

1. **No built-in updater in v1.** Updates are manual: download the new
   artifact, verify its SHA-256 against the published manifest, install
   over the previous version. There is no update manifest, no automatic
   download, and no silent background network use (threat-model row 14).
2. **Signing/notarization not yet applied.** macOS artifacts are
   ad-hoc signed; Windows artifacts are unsigned; Linux packages are
   unsigned. First-run prompts (Gatekeeper/SmartScreen) are expected.
   The exact signing/notarization procedure is documented in
   [signing and notarization](./signing-notarization-v1.md); applying
   it is a mechanical release step.
3. **Windows/Linux interactive qualification was not executed on this
   machine.** The three-OS native build + headless smoke matrix runs on
   CI; interactive install/launch qualification on a Windows and a Linux
   machine is a documented mechanical step
   ([clean-machine qualification](./clean-machine-qualification-v1.md)).

## Formats

4. **No glTF import** (export only: `.gltf` JSON + `.glb` binary,
   ADR-0011). Export maps pivots to helper nodes and reports helper
   identity in metadata; constraints are not represented in glTF.
5. **`.vox` (MagicaVoxel) is a bounded subset**: axis ≤ 256, palette ≤
   255 colors, no transforms — non-identity transforms block export by
   default, and hierarchy/origin rebasing requires an explicit choice
   that is always accompanied by a structured loss report. Unsupported
   `.vox` chunks are reported on import, never guessed at.
6. **`.vxl` backward window**: readers support the declared version
   window; unknown future versions fail safely and never overwrite the
   source. External export is never lossless; a loss report precedes
   every write.

## AI

7. **One cloud adapter in v1** (official OpenAI API over TLS,
   user-supplied key, allowlisted tool-capable models, ADR-0010).
   OpenAI-compatible endpoints, other vendors, bundled/local inference,
   and background cloud processing are deferred.
8. **AI is consent-gated and offline-capable.** With no credentials or
   offline, the AI panel shows its unavailable state and manual editing
   keeps working; nothing is transmitted without a per-session consent
   record (provider, model, data categories, cost/token caps).
9. **Visual refinement is bounded**: at most 12 evidence images, 3
   iterations, 2048×2048 / 16 MiB each, images off by default and never
   retained (ADR-0009).
10. **AI edits are staged, diffed, and applied as one transaction**;
   conflicting base revisions fail closed (no silent merge/overwrite).

## Editor and rendering

11. **No touch-only editing, pressure brushes, or multi-touch gestures.**
12. **Screen-reader interpretation of 3D voxel content is not
    promised**; all persistent edits have named commands and equivalent
    panel/timeline controls (WCAG 2.2 AA baseline, ADR-0008).
13. **Cross-restart undo is not promised**: recovery restores the
    document with a fresh bounded history (ADR-0003).
14. **No telemetry and no diagnostics upload in v1**; diagnostics are
    local and locally previewable. A dedicated "export diagnostics"
    button in the desktop shell is not shipped in v1 (the sanitized
    report builder and recovery reports exist headless; the shell
    export UI is a follow-up).

## Performance envelope (ADR-0008)

15. Named-tier claims are reproduced on the reference (M1/16 GiB) and
    low (i5-8250U/8 GiB) tiers; other machines are supported but
    unbenchmarked. Software WebGL, VMs, and remote desktops are not
    release-blocking targets.

## Deferred backlog

The full post-release backlog (mesh sculpting, physics, multiplayer,
plugin marketplace, glTF import, updater, additional providers, mobile)
is plan.md §16.
