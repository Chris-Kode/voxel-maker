import type { DocumentSession } from "@voxel-maker/session";
import type { EditorStore } from "@voxel-maker/editor";
import type {
  SceneAdapter,
  ScenePreviewProjection,
} from "@voxel-maker/renderer";
import {
  consentCovers,
  createAgentSession,
  createConsent,
  createInspector,
  createMutator,
  createPreviewRegistry,
  createPreviewSession,
  DISCLOSURE_CATEGORIES,
  KEYCHAIN_SERVICE,
  previewSessionId,
  Secret,
  type AgentBudgets,
  type AgentEvent,
  type AgentRunReason,
  type AgentSession,
  type ConsentStore,
  type CredentialStore,
  type PreviewDiff,
  type PreviewSession,
  type PreviewSessionId,
  type ProviderAdapter,
  type ProviderConsent,
  type ProviderUsage,
} from "@voxel-maker/agent";
import type { AnimationDescriptor } from "@voxel-maker/model";
import type { AnimationId } from "@voxel-maker/shared";

/**
 * Desktop AI controller (plan S12.10/S12.14/S12.15, ticket #34): the
 * headless seam between the AI panel and the bounded provider-neutral
 * agent loop. One controller owns the lifecycle of one proposal: it
 * starts a run over a fresh isolated preview session, projects the staged
 * overlay into the viewport under the preview namespace, and exposes
 * explicit Apply / Discard / Cancel / conflict-recovery actions. Every
 * action is UI policy over the agent package seams; the controller never
 * executes commands itself and never touches live state outside Apply
 * (one labeled undoable history entry) — Discard, cancellation, and
 * lifecycle replacement leave live revision, history, autosave, and
 * journal untouched. Offline or unconfigured providers degrade to a
 * clear status while manual editing keeps working (ADR-0008/0010).
 */

/** Max staged clip summaries kept in the panel snapshot (plan S13.5). */
const MAX_STAGED_CLIPS = 16;

/** Max characters of one user prompt. */
export const MAX_AI_PROMPT_LENGTH = 8_000;

/** Default Apply history label (one labeled undoable entry, ADR-0007). */
export const DEFAULT_AI_APPLY_LABEL = "AI proposal";

/** Bounded activity log kept in the panel snapshot. */
const MAX_ACTIVITY_ENTRIES = 48;

/** Max display length of one activity text. */
const MAX_ACTIVITY_TEXT = 220;

/** Max display length of one error message. */
const MAX_ERROR_TEXT = 300;

/** Max length of an Apply history label. */
const MAX_APPLY_LABEL = 120;

/** One normalized progress entry of a run (UI-facing, never persisted). */
export interface AiActivityEntry {
  readonly id: number;
  readonly kind: "state" | "text" | "tool" | "usage" | "error";
  /** Bounded, user-safe display text. */
  readonly message: string;
  /** Tool entry: true when the tool call succeeded. */
  readonly ok?: boolean;
  /** Tool entry: the tool name. */
  readonly tool?: string;
  /** Usage entry: the cumulative provider usage so far. */
  readonly usage?: ProviderUsage;
}

/** The phase of one AI session (plan S12.1 states, projected for the UI). */
export type AiPhase =
  | "idle"
  | "running"
  | "approve"
  | "conflict"
  | "canceled"
  | "error";

/** Immutable panel snapshot. */
export interface AiControllerState {
  readonly phase: AiPhase;
  /** True while a bounded run is in flight (Cancel is available). */
  readonly running: boolean;
  /** True when a document is open (Run is available). */
  readonly documentOpen: boolean;
  /** The prompt of the current run (the derived reinspect prompt when any). */
  readonly prompt: string;
  /** The original user prompt of the current run (replan target). */
  readonly lastPrompt: string;
  readonly providerId: string;
  readonly model: string;
  /** Credential/consent status (last known; refreshStatus re-checks). */
  readonly configured: boolean;
  readonly consented: boolean;
  /** The staged proposal is reviewable (phase approve or conflict). */
  readonly staged: boolean;
  readonly liveRevision: number | undefined;
  readonly baseRevision: number | undefined;
  readonly stagedCommandCount: number;
  readonly voxelEstimate: number;
  readonly diff: PreviewDiff | undefined;
  readonly usage: ProviderUsage | undefined;
  readonly activity: readonly AiActivityEntry[];
  readonly error:
    | { readonly code: string; readonly message: string }
    | undefined;
  readonly reason: AgentRunReason | undefined;
  /** The last Apply outcome (null until the next run). */
  readonly applied:
    | { readonly label: string; readonly stagedCommandCount: number }
    | undefined;
  /**
   * Bounded summaries of the staged overlay clips (plan S13.5): the
   * staged clips are playable before Apply through `overlayClip`.
   */
  readonly stagedClips: readonly {
    readonly animationId: string;
    readonly name: string;
    readonly duration: number;
    readonly loop: "once" | "loop";
    readonly trackCount: number;
    readonly keyframeCount: number;
  }[];
}

export interface AiControllerOptions {
  readonly session: DocumentSession;
  /** Runtime editor store: notices and selection context for inspection. */
  readonly editor: EditorStore;
  /** Renderer adapter: projects staged geometry under preview namespaces. */
  readonly adapter: SceneAdapter;
  /** Provider-neutral chat adapter (never a vendor type). */
  readonly provider: ProviderAdapter;
  /** OS-keychain-backed credential store (ADR-0010). */
  readonly credentials: CredentialStore;
  /** Explicit consent store (ADR-0010). */
  readonly consent: ConsentStore;
  /** Default model passed to the loop; defaults to the provider's model. */
  readonly model?: string;
  /** Session budget overrides; every value is clamped to [0, default]. */
  readonly budgets?: Partial<AgentBudgets>;
  /** Virtual clock for duration budgets (tests). */
  readonly clock?: { now(): number };
  /** Simulated sleep for retry backoff (tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface AiController {
  readonly state: AiControllerState;
  /** Subscribes to snapshot changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Re-checks the credential and consent status and refreshes the snapshot. */
  refreshStatus(): Promise<void>;
  /** Saves a provider API key through the credential store; never kept in state. */
  saveApiKey(key: string): Promise<boolean>;
  /** Removes the stored provider API key. */
  clearApiKey(): Promise<boolean>;
  /** Records explicit consent for the current provider and model. */
  consent(costCapUsd?: number, tokenCap?: number): Promise<boolean>;
  /** Starts one bounded run; resolves when the run reaches a terminal phase. */
  run(prompt: string): Promise<void>;
  /** Requests cancellation of the in-flight run (next run boundary). */
  cancel(): void;
  /** Applies the staged proposal as one labeled undoable history entry. */
  apply(label?: string): void;
  /** Discards the staged proposal; no history entry is created. */
  discard(): void;
  /**
   * Read-only snapshot of one staged overlay clip (plan S13.5): playback
   * consumers (timeline/playback controller) play the staged clip before
   * Apply with no live mutation. Returns undefined when the clip is not
   * staged or no proposal is open.
   */
  overlayClip(animationId: string): AnimationDescriptor | undefined;
  /** Dismisses a terminal error/canceled phase and returns to idle. */
  dismiss(): void;
  /** Conflict recovery: discards and re-inspects the changed live state. */
  reinspect(): Promise<void>;
  /** Conflict recovery: discards and re-runs the same prompt at the new revision. */
  replan(): Promise<void>;
  /** Cancels and releases the active run, projection, and subscriptions. */
  dispose(): void;
}

/** Builds the reinspect prompt after a stale-base conflict (plan S12.9). */
export function reinspectPromptFor(original: string): string {
  return (
    "The document changed while your previous proposal was pending. " +
    "Inspect the current document state and summarize what is there now, " +
    "then continue with the original request:\n\n" +
    original
  );
}

/** Bounds and normalizes an Apply history label. */
function boundLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  const trimmed = label.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, MAX_APPLY_LABEL);
}

/** Bounds one activity text. */
function boundText(text: string): string {
  return text.length <= MAX_ACTIVITY_TEXT
    ? text
    : `${text.slice(0, MAX_ACTIVITY_TEXT)}…`;
}

function stableError(
  code: string,
  message: string,
): { readonly code: string; readonly message: string } {
  return { code, message: message.slice(0, MAX_ERROR_TEXT) };
}

class AiControllerImpl implements AiController {
  readonly #session: DocumentSession;
  readonly #editor: EditorStore;
  readonly #adapter: SceneAdapter;
  readonly #provider: ProviderAdapter;
  readonly #credentials: CredentialStore;
  readonly #consentStore: ConsentStore;
  readonly #model: string;
  readonly #budgets: Partial<AgentBudgets> | undefined;
  readonly #clock: { now(): number } | undefined;
  readonly #sleep: ((ms: number) => Promise<void>) | undefined;
  readonly #listeners = new Set<() => void>();
  /** Bounded activity entries of the current run. */
  readonly #activity: AiActivityEntry[] = [];
  #activitySequence = 0;
  #runSequence = 0;
  #configured = false;
  #consented = false;
  #unsubscribeLifecycle: () => void;
  #phase: AiPhase = "idle";
  #prompt = "";
  #lastPrompt = "";
  #liveRevision: number | undefined;
  #baseRevision: number | undefined;
  #stagedCommandCount = 0;
  #voxelEstimate = 0;
  #diff: PreviewDiff | undefined;
  #usage: ProviderUsage | undefined;
  #error: { code: string; message: string } | undefined;
  #reason: AgentRunReason | undefined;
  #applied: { label: string; stagedCommandCount: number } | undefined;
  #agentSession: AgentSession | undefined;
  #preview: PreviewSession | undefined;
  #projection: ScenePreviewProjection | undefined;
  #disposed = false;

  constructor(options: AiControllerOptions) {
    this.#session = options.session;
    this.#editor = options.editor;
    this.#adapter = options.adapter;
    this.#provider = options.provider;
    this.#credentials = options.credentials;
    this.#consentStore = options.consent;
    this.#model = options.model ?? options.provider.defaultModel;
    this.#budgets = options.budgets;
    this.#clock = options.clock;
    this.#sleep = options.sleep;
    this.#unsubscribeLifecycle = this.#session.subscribe(() => {
      // Lifecycle replacement ends every active proposal: a staged overlay
      // must never straddle two documents (plan S12.15).
      this.#disposeRun();
      this.#liveRevision = this.#session.current?.store.revision;
      this.#setPhase("idle");
    });
    this.#liveRevision = this.#session.current?.store.revision;
  }

  get state(): AiControllerState {
    return {
      phase: this.#phase,
      running: this.#phase === "running",
      documentOpen: this.#session.current !== undefined,
      prompt: this.#prompt,
      lastPrompt: this.#lastPrompt,
      providerId: this.#provider.providerId,
      model: this.#model,
      configured: this.#configured,
      consented: this.#consented,
      staged: this.#phase === "approve" || this.#phase === "conflict",
      liveRevision: this.#session.current?.store.revision ?? this.#liveRevision,
      baseRevision: this.#baseRevision,
      stagedCommandCount: this.#stagedCommandCount,
      voxelEstimate: this.#voxelEstimate,
      diff: this.#diff,
      usage: this.#usage,
      activity: Object.freeze([...this.#activity]),
      error: this.#error,
      reason: this.#reason,
      applied: this.#applied,
      stagedClips: this.#stagedClips(),
    };
  }

  /** Bounded staged overlay clip summaries (plan S13.5, ticket #36). */
  #stagedClips(): AiControllerState["stagedClips"] {
    const preview = this.#preview;
    if (preview === undefined || preview.closed) return [];
    try {
      const animations = Object.values(preview.getDocument().animations);
      return animations.slice(0, MAX_STAGED_CLIPS).map((clip) => ({
        animationId: clip.animationId,
        name: clip.name ?? clip.animationId,
        duration: clip.duration,
        loop: clip.loop,
        trackCount: clip.tracks.length,
        keyframeCount: clip.tracks.reduce(
          (sum, track) => sum + track.keyframes.length,
          0,
        ),
      }));
    } catch {
      return [];
    }
  }

  /** Read-only staged overlay clip snapshot for pre-Apply playback. */
  overlayClip(animationId: string): AnimationDescriptor | undefined {
    const preview = this.#preview;
    if (preview === undefined || preview.closed) return undefined;
    try {
      return preview.overlayClip(animationId as AnimationId);
    } catch {
      return undefined;
    }
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async refreshStatus(): Promise<void> {
    // Store failures (e.g. an unavailable OS keychain) degrade to the
    // unconfigured state instead of rejecting: the panel then shows the
    // configuration guidance and manual editing keeps working.
    try {
      const reference = await this.#credentials.get(
        KEYCHAIN_SERVICE,
        this.#provider.providerId,
      );
      const configured =
        reference !== undefined && reference.reveal().length > 0;
      const record = await this.#consentStore.get(
        this.#provider.providerId,
        this.#model,
      );
      const consented =
        record !== undefined &&
        consentCovers(
          record,
          { providerId: this.#provider.providerId, model: this.#model },
          this.#clock?.now() ?? Date.now(),
        );
      if (this.#configured !== configured || this.#consented !== consented) {
        this.#configured = configured;
        this.#consented = consented;
        this.#emit();
      }
    } catch {
      if (this.#configured) {
        this.#configured = false;
        this.#emit();
      }
    }
  }

  async saveApiKey(key: string): Promise<boolean> {
    const trimmed = key.trim();
    if (trimmed.length === 0) {
      this.#editor.pushNotice("error", "The API key cannot be empty");
      return false;
    }
    if (trimmed.length > 4_000) {
      this.#editor.pushNotice("error", "The API key is too long");
      return false;
    }
    try {
      await this.#credentials.save(
        KEYCHAIN_SERVICE,
        this.#provider.providerId,
        // The key crosses the credential-store seam only; it never enters
        // controller state, notices, activity, or any log.
        new Secret(trimmed),
      );
    } catch (error) {
      this.#editor.pushNotice(
        "error",
        `Could not store the API key: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return false;
    }
    await this.refreshStatus();
    this.#editor.pushNotice("info", "The AI provider key was saved");
    return true;
  }

  async clearApiKey(): Promise<boolean> {
    try {
      await this.#credentials.delete(
        KEYCHAIN_SERVICE,
        this.#provider.providerId,
      );
    } catch (error) {
      this.#editor.pushNotice(
        "error",
        `Could not remove the API key: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return false;
    }
    await this.refreshStatus();
    this.#editor.pushNotice("info", "The AI provider key was removed");
    return true;
  }

  async consent(costCapUsd?: number, tokenCap?: number): Promise<boolean> {
    try {
      const record: ProviderConsent = createConsent({
        providerId: this.#provider.providerId,
        model: this.#model,
        categories: DISCLOSURE_CATEGORIES,
        ...(costCapUsd === undefined ? {} : { costCapUsd }),
        ...(tokenCap === undefined ? {} : { tokenCap }),
        ...(this.#clock === undefined ? {} : { clock: this.#clock }),
      });
      await this.#consentStore.save(record);
    } catch (error) {
      this.#editor.pushNotice(
        "error",
        `Consent could not be recorded: ${error instanceof Error ? error.message : "unknown error"}`,
      );
      return false;
    }
    await this.refreshStatus();
    return true;
  }

  async run(prompt: string): Promise<void> {
    if (this.#phase === "running") {
      this.#editor.pushNotice("info", "An AI run is already in progress");
      return;
    }
    const trimmed = prompt.trim();
    if (trimmed.length === 0) {
      this.#editor.pushNotice("info", "Describe the edit you want first");
      return;
    }
    if (trimmed.length > MAX_AI_PROMPT_LENGTH) {
      this.#editor.pushNotice(
        "info",
        `Prompts are limited to ${String(MAX_AI_PROMPT_LENGTH)} characters`,
      );
      return;
    }
    const current = this.#session.current;
    if (current === undefined) {
      this.#editor.pushNotice("info", "Open a document before running AI");
      return;
    }
    // Authoritative configuration check at run time: a stored key (e.g.
    // the OS keychain after a restart) is never stale in the snapshot.
    let storedKey: Awaited<ReturnType<CredentialStore["get"]>>;
    try {
      storedKey = await this.#credentials.get(
        KEYCHAIN_SERVICE,
        this.#provider.providerId,
      );
    } catch {
      this.#editor.pushNotice(
        "error",
        "The provider credential store is unavailable; AI runs are disabled",
      );
      return;
    }
    if (storedKey === undefined || storedKey.reveal().length === 0) {
      this.#editor.pushNotice(
        "info",
        "AI is not configured: add a provider key in the AI panel first",
      );
      return;
    }
    if (!this.#configured) {
      this.#configured = true;
      this.#emit();
    }
    const record = await this.#consentStore.get(
      this.#provider.providerId,
      this.#model,
    );
    if (
      record === undefined ||
      !consentCovers(
        record,
        { providerId: this.#provider.providerId, model: this.#model },
        this.#clock?.now() ?? Date.now(),
      )
    ) {
      this.#setErrorState(
        "CONSENT_REQUIRED",
        "Provider use requires explicit consent for the provider, model, and transmitted data categories; review the disclosure in the AI panel",
        undefined,
      );
      return;
    }

    // Release any earlier proposal before starting the fresh run.
    this.#disposeRun();

    const preview = createPreviewSession({
      live: current.store,
      applyBus: current.bus,
      sessionId: this.#nextSessionId(current.store.revision),
    });
    const inspector = createInspector({
      store: preview,
      capabilities: ["inspect"],
      port: {
        getSelection: () => this.#editor.selection,
      },
    });
    const mutator = createMutator({
      store: preview,
      registry: createPreviewRegistry(),
      session: preview,
      capabilities: ["mutate"],
    });
    const agent = createAgentSession({
      provider: this.#provider,
      inspector,
      mutator,
      preview,
      consent: record,
      userPrompt: trimmed,
      ...(this.#budgets === undefined ? {} : { budgets: this.#budgets }),
      ...(this.#clock === undefined ? {} : { clock: this.#clock }),
      ...(this.#sleep === undefined ? {} : { sleep: this.#sleep }),
      onEvent: (event) => {
        this.#onEvent(event);
      },
      isLiveCurrent: () => this.#liveCurrent(),
    });

    this.#agentSession = agent;
    this.#preview = preview;
    const projection = this.#adapter.projectPreview(preview, preview.namespace);
    this.#projection = projection;
    this.#prompt = trimmed;
    this.#lastPrompt = trimmed;
    this.#liveRevision = current.store.revision;
    this.#baseRevision = preview.baseRevision;
    this.#diff = undefined;
    this.#usage = undefined;
    this.#error = undefined;
    this.#reason = undefined;
    this.#applied = undefined;
    this.#activity.length = 0;
    this.#setPhase("running");

    const result = await agent.run();
    if (this.#disposed || this.#agentSession !== agent) return;
    if (result.ok) {
      this.#stagedCommandCount = result.stagedCommands;
      this.#diff = result.diff;
      this.#voxelEstimate = result.diff.voxelEstimate;
      this.#setPhase("approve");
      return;
    }
    // The loop fails closed (cancel/limit/provider/conflict): the preview
    // session is already released, so the staged viewport overlay must go
    // with it — only an approved proposal keeps its projection. The local
    // handle is disposed even when a lifecycle replacement already
    // disposed it (dispose is idempotent).
    projection.dispose();
    this.#projection = undefined;
    if (result.reason === "conflict") {
      this.#error = stableError(
        "REVISION_CONFLICT",
        result.error instanceof Error
          ? result.error.message
          : "The live document changed while the run was in flight",
      );
      this.#reason = "conflict";
      this.#setPhase("conflict");
      return;
    }
    if (result.reason === "canceled") {
      this.#setPhase("canceled");
      return;
    }
    this.#setErrorState(
      result.error instanceof Error && "code" in result.error
        ? String((result.error as { code: unknown }).code)
        : "AI_RUN_FAILED",
      result.error instanceof Error
        ? result.error.message
        : "The AI run failed",
      result.reason,
    );
  }

  cancel(): void {
    if (this.#agentSession === undefined || this.#phase !== "running") return;
    try {
      this.#agentSession.cancel();
    } catch (error) {
      this.#editor.pushNotice(
        "error",
        error instanceof Error ? error.message : "Could not cancel the AI run",
      );
    }
  }

  apply(label?: string): void {
    if (this.#agentSession === undefined || this.#phase !== "approve") {
      this.#editor.pushNotice("info", "There is no approved proposal to apply");
      return;
    }
    const bounded = boundLabel(label) ?? DEFAULT_AI_APPLY_LABEL;
    const result = this.#agentSession.apply({ label: bounded });
    if (result.ok) {
      const staged = this.#stagedCommandCount;
      this.#applied = { label: bounded, stagedCommandCount: staged };
      this.#disposeRun();
      this.#setPhase("idle");
      this.#editor.pushNotice(
        "info",
        `Applied the AI proposal as “${bounded}” (${String(staged)} command${staged === 1 ? "" : "s"})`,
      );
      return;
    }
    if (
      result.error.family === "conflict" &&
      (result.error.code === "REVISION_CONFLICT" ||
        result.error.code === "STALE_REVISION")
    ) {
      // Plan S12.9: never silently rebase — the user chooses discard,
      // reinspect, or replan. The loop released the preview on the failed
      // apply, so the staged overlay is disposed as well.
      this.#error = stableError(result.error.code, result.error.message);
      this.#reason = "conflict";
      this.#projection?.dispose();
      this.#projection = undefined;
      this.#setPhase("conflict");
      return;
    }
    this.#editor.pushNotice("error", result.error.message);
  }

  discard(): void {
    if (this.#agentSession === undefined || !this.state.staged) return;
    try {
      this.#agentSession.discard();
    } catch {
      // The state machine may have left `approve` (apply-time conflict);
      // the preview session still owns the staged overlay.
      this.#preview?.discard();
    }
    this.#disposeRun();
    this.#setPhase("idle");
    this.#editor.pushNotice("info", "The AI proposal was discarded");
  }

  dismiss(): void {
    if (this.#phase !== "error" && this.#phase !== "canceled") return;
    this.#disposeRun();
    this.#setPhase("idle");
  }

  async reinspect(): Promise<void> {
    const original = this.#lastPrompt;
    this.#discardSilently();
    await this.run(reinspectPromptFor(original));
  }

  async replan(): Promise<void> {
    const original = this.#lastPrompt;
    this.#discardSilently();
    await this.run(original);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeLifecycle();
    this.#disposeRun();
    this.#listeners.clear();
  }

  /** The live document is current when the same document sits at the base revision. */
  #liveCurrent(): boolean {
    const current = this.#session.current;
    const preview = this.#preview;
    if (current === undefined || preview === undefined) return false;
    return (
      current.store.getDocument().documentId === preview.documentId &&
      current.store.revision === preview.baseRevision
    );
  }

  #nextSessionId(liveRevision: number): PreviewSessionId {
    this.#runSequence += 1;
    // Bounded namespace: the worker protocol caps preview namespaces, so
    // the id never embeds the full (long) document id.
    return previewSessionId(
      `preview:desktop:${String(liveRevision)}:${String(this.#runSequence)}`,
    );
  }

  #onEvent(event: AgentEvent): void {
    switch (event.kind) {
      case "state":
        this.#pushActivity({
          kind: "state",
          message: `State: ${event.state}`,
        });
        break;
      case "text": {
        const text = event.text.trim();
        if (text.length > 0) {
          this.#pushActivity({ kind: "text", message: boundText(text) });
        }
        break;
      }
      case "tool":
        this.#pushActivity({
          kind: "tool",
          message: boundText(
            `${event.result.ok ? "Called" : "Rejected"} ${event.tool}`,
          ),
          ok: event.result.ok,
          tool: event.tool,
        });
        break;
      case "usage":
        this.#usage = {
          inputTokens:
            (this.#usage?.inputTokens ?? 0) + event.usage.inputTokens,
          outputTokens:
            (this.#usage?.outputTokens ?? 0) + event.usage.outputTokens,
        };
        this.#pushActivity({
          kind: "usage",
          message: `Usage: ${String(this.#usage.inputTokens)} in / ${String(
            this.#usage.outputTokens,
          )} out`,
          usage: this.#usage,
        });
        break;
      case "error":
        this.#pushActivity({
          kind: "error",
          message: boundText(event.error.message),
        });
        break;
    }
    this.#emit();
  }

  #pushActivity(entry: Omit<AiActivityEntry, "id">): void {
    this.#activitySequence += 1;
    this.#activity.push({ id: this.#activitySequence, ...entry });
    if (this.#activity.length > MAX_ACTIVITY_ENTRIES) {
      this.#activity.splice(0, this.#activity.length - MAX_ACTIVITY_ENTRIES);
    }
  }

  /** Drops the active run, preview session, and viewport projection. */
  #disposeRun(): void {
    this.#projection?.dispose();
    this.#projection = undefined;
    try {
      this.#preview?.discard();
    } catch {
      // The preview is already released; discarding is idempotent.
    }
    this.#agentSession = undefined;
    this.#preview = undefined;
  }

  /** Discards without notices (used by reinspect/replan chaining). */
  #discardSilently(): void {
    if (this.#agentSession === undefined) return;
    try {
      this.#agentSession.discard();
    } catch {
      this.#preview?.discard();
    }
    this.#disposeRun();
  }

  #setPhase(phase: AiPhase): void {
    this.#phase = phase;
    this.#emit();
  }

  #setErrorState(
    code: string,
    message: string,
    reason: AgentRunReason | undefined,
  ): void {
    this.#error = stableError(code, message);
    this.#reason = reason;
    this.#setPhase("error");
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }
}

/** Creates the AI controller bound to one composition. */
export function createAiController(options: AiControllerOptions): AiController {
  return new AiControllerImpl(options);
}
