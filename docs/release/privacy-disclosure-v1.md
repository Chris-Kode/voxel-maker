# User-facing privacy disclosure v1

**Status:** v1 (issue #46, ADR-0010, plan §11.2/§11.3)
**App version:** 0.1.0

This page is the plain-language privacy disclosure for Voxel Maker.
The technical policy it summarizes is
[docs/security/privacy-and-diagnostics-v1.md](../security/privacy-and-diagnostics-v1.md).

## In short

- **Voxel Maker is local-first.** Creating, opening, editing, rigging,
  animating, saving, recovering, importing, exporting, and viewing help
  work completely offline, with no account, no sign-in, and no data
  leaving your computer.
- **There is no telemetry.** The app does not phone home, does not
  collect usage statistics, and does not upload anything automatically.
- **AI is opt-in, per session.** Voxel Maker never talks to a cloud AI
  service unless you explicitly connect one and confirm, for that
  session, which provider, which model, and exactly what will be sent.
- **AI images are a separate, extra opt-in.** Visual refinement sends
  preview images only when you explicitly enable image transmission;
  images are never stored by the app and are off by default.
- **Keys stay in your keychain.** If you add an AI provider API key, it
  is stored by your operating system's credential vault (macOS
  Keychain, Windows Credential Manager, Linux Secret Service) — not in
  project files and not in logs.

## What data exists where

| Data | Where it lives | Notes |
|---|---|---|
| Your projects (`.vxl`) | On your disk, where you save them | Self-contained; you control copies/backups |
| Recovery journal | Next to each project file | Bounded, cleaned up on save/close |
| AI provider key | OS keychain | Scoped per service/account |
| Session transcript | Only if you opt in per session | Expires after your chosen 1/7/30 days; prompts only |
| Diagnostics report | Your disk, previewable before any export | Redacted by default; no upload in v1 |
| Telemetry | None | Nothing is collected |

## What is sent to a provider when you use AI

Only after you confirm a consent record that names the provider, the
model, and the transmitted categories, the app sends: your prompt,
bounded inspection results (document summary, hierarchy, bounds,
selected node/material/track data), and — only if you separately enable
image transmission — bounded preview images. Prompts and tool arguments
are never logged or retained by the app by default. The provider's own
retention terms are shown to you before connection and are outside the
app's control.

## Your controls

- Use the app fully offline with AI controls showing an unavailable
  state — nothing is sent.
- Decline consent and the AI panel stays read-only for cloud use.
- Remove the provider key from the app's settings (deletes it from the
  keychain).
- Export a redacted diagnostics report from the support panel and review
  it locally before sharing it with support (see
  [support procedures](./support-procedures-v1.md)).

## Changes

This disclosure is part of the release documentation and only changes
with a documented policy update (ADR-0010 is the consent contract).
