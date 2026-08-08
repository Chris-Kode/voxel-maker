---
status: accepted
---

# Cloud provider, consent, and privacy policy

AI is optional, but enabling it crosses a network and organizational trust boundary. The product must identify the initial provider, disclose exactly what can leave the device, avoid silent retention, and remain useful when cloud access is absent.

## Decision

The initial release supports one cloud adapter: the official OpenAI API over TLS at `https://api.openai.com`, using a user-supplied API key and a user-selected tool-capable model from the adapter's allowlist. Requests may use the operating system's configured HTTPS proxy but may not use an application-operated relay or arbitrary endpoint. OpenAI account creation, billing, availability, model behavior, and provider-side retention remain third-party concerns disclosed before connection. The adapter requests provider non-storage/no-training mode when the selected endpoint supports it, but the UI states the provider's actual published retention terms and date. OpenAI-compatible endpoints, other vendors, bundled/local inference, and background cloud processing are not supported in the initial release. Provider-neutral interfaces remain mandatory so adding an adapter later does not change Document or Command semantics.

Cloud AI is off by default. The first connection requires the user to select the provider, review a concise data disclosure, supply a key, and explicitly enable it. The key is stored only through the operating-system credential store, is never serialized into a Document, transcript, journal, diagnostic bundle, telemetry event, or ordinary log, and can be removed from the application. The app must not validate a key by sending Document content.

A text-only agent run may transmit only:

- the user's current prompt and messages retained in that run;
- fixed system, safety, Skill, tool-schema, coordinate, and limit instructions;
- provider/model/settings identifiers;
- the live base Revision and bounded summaries of the current selection and Document;
- the results of inspection tools explicitly used during the run, including requested names, metadata, transforms, material properties, animation summaries, and bounded voxel samples;
- staged Command summaries, validation errors, and bounded diffs needed to refine the proposal.

It never transmits credentials, raw native containers, recovery journals, local paths, unrelated full voxel arrays, history payloads, clipboard contents, logs, diagnostics, or hidden files. User-authored names, metadata, and prior transcript text are quoted as untrusted data, never instructions. The disclosure UI shows these categories before enablement and provides per-run provider, model, text-context categories, budget, and image status.

Images are off by default independently of text AI. Each visual-refinement session requires explicit confirmation that names the selected standard views, image count, maximum resolution, provider, model, and estimated cost. Only newly rendered bounded standard views and their camera metadata may be sent. Images are not reused in another session or silently attached to text requests.

The application retains no AI transcript after the session by default. An explicit per-session “retain transcript” choice stores a local encrypted-at-rest record when the OS storage adapter supports it; otherwise retention is unavailable rather than plaintext. Retained records have a user-selectable 1-, 7-, or 30-day expiry, defaulting to 7 days, and can be deleted immediately. The provider may retain requests under its own published policy; the app must link or summarize that policy and cannot claim zero retention on the provider's behalf.

Product analytics and crash uploads are off by default and require separate consent. A future telemetry implementation may send only coarse app/platform version, feature counters, durations, stable error codes, and bucketed resource counts. It may not send prompts, tool arguments/results, images, Document content or hashes, node/material names, metadata, credentials, full paths, or a stable cross-install identifier. Uploaded telemetry or crash records expire server-side within 30 days; disabling consent stops future upload and offers deletion of any install-scoped records when the backend can identify them without creating a permanent cross-install identity. Ordinary local logs roll at 20 MiB or seven days and contain no prompts, tool arguments/results, project content, raw paths, tokens, authorization fields, or images. Crash and diagnostic export is separately initiated, locally previewable, and redacts authorization values, query strings, home/user names, paths, prompts, provider payloads, project content, and secrets. Update checks disclose their network access and can be disabled.

With no key, rejected consent, provider failure, exhausted budget, or no network, the agent session fails closed with a normalized non-destructive status and releases its Preview Session. All manual, persistence, recovery, rigging, animation, import, preview, and export behavior remains available offline. There is no fallback that sends data to a different provider.

## Considered options

- A product-hosted proxy and product account were rejected because they add custody, authentication, and retention obligations unnecessary for the first release.
- Multiple providers and arbitrary compatible endpoints were rejected because the initial privacy and behavior surface would be too broad to qualify.
- Silent context collection and blanket consent were rejected because users could not understand what a particular run transmits.
- Image consent bundled with text consent was rejected because rendered asset views are a distinct disclosure.
- Default transcript, telemetry, or crash-report retention was rejected because prompts and assets may be commercially sensitive.

## Consequences

Provider behavior remains non-deterministic and external, while inspection, staging, limits, approval, and Apply remain local deterministic authority. Privacy UI and redaction audits are release gates. Changing the supported provider, transmitted categories, retention defaults, or telemetry fields is a policy change requiring review and updated disclosures/tests.

## Gates

This decision gates provider and credential work (#33), AI review and evaluation (#34–#40), privacy hardening (#44), and release support documentation (#46).
