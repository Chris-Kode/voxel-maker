---
status: accepted
---

# Bounded provider-neutral AI proposals

AI assistance must not gain broader authority than manual editing or make saved assets provider-dependent. We adopt provider-neutral bounded inspection and proposal tools, isolated previews, mandatory user approval, and one optimistic command-bus apply path.

## Decision

AI is an optional provider-neutral producer of generic Command proposals, not an authority. Versioned JSON-schema tools separate bounded, paginated, Revision-tagged inspection from mutation proposal. Each agent run owns a base Revision, cancellation state, explicit round/token/tool/command/byte/change/time/cost budgets, and an isolated `PreviewSession`; it may inspect and stage sequentially, but can affect the live Document only after explicit user approval by applying one optimistic Transaction through the command bus. Version 1 has no AI auto-apply path, regardless of proposal size or provider. Revision conflicts require discard, reinspect, or replan and are never silently rebased.
## Considered options

- Direct model mutation of Document JSON was rejected because it bypasses validation, history, limits, and least privilege.
- Shell, source execution, unrestricted filesystem/network, arbitrary URLs, and renderer-object tools were rejected because they exceed the capability needed to edit an asset.
- Provider-specific types in semantic modules were rejected because credentials, retention, and tool behavior must remain replaceable and auditable.
- Silent rebase was rejected because a proposal reviewed against one state can change meaning against another.
- Risk-based AI auto-apply was rejected for version 1 because policy classification is not yet strong enough to replace review of a persistent mutation.
- Requiring AI for saved asset interpretation was rejected because manual offline workflows and long-term compatibility must not depend on a provider or Skill.

## Consequences

Apply creates one labeled undoable history entry; Discard creates none and changes no live Revision, dirty state, autosave, or recovery data. Credentials remain in the OS keychain through scoped adapters. Logs, transmitted summaries, and optional image evidence follow approved consent, redaction, and retention policy. Skills remain removable, versioned knowledge whose output is generic Commands.

## Gates

This decision gates AI inspection (#31), preview isolation (#32), agent runtime (#33), proposal review/apply (#34), AI geometry, rigging, animation, Skills, and visual refinement (#35–#40), and AI-related security and release qualification (#44 and #46).
