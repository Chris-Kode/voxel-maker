import { useEffect, useRef, useState } from "react";
import { PROVIDER_PRIVACY_POLICY } from "@voxel-maker/agent";
import type { AiController, AiControllerState } from "./ai-controller.js";
import {
  DEFAULT_AI_APPLY_LABEL,
  MAX_AI_PROMPT_LENGTH,
} from "./ai-controller.js";
import { PANEL_FOCUS_IDS } from "../panels/panel-utils.js";

/**
 * Integrated AI panel (plan S12.10/S12.14, ticket #34): prompt entry,
 * progress with normalized tool activity, usage, cancellation, errors,
 * bounded diffs, Apply/Discard controls, the stale-base conflict flow
 * (discard/reinspect/replan, never silent rebase), and graceful
 * offline/unconfigured degradation. All behavior lives in the AI
 * controller; this component only renders state and forwards gestures,
 * and every control is a labelled keyboard-accessible button.
 */

/** Staged proposals above this voxel estimate are flagged as large. */
const LARGE_PROPOSAL_VOXELS = 10_000;

/** Formats a signed occupancy delta for the evaluation summary. */
function formatDelta(delta: number | undefined): string {
  if (delta === undefined) return "n/a";
  return delta > 0 ? `+${String(delta)}` : String(delta);
}

/** Subscribes to the controller snapshot for the panel. */
function useAiState(controller: AiController): AiControllerState {
  const [state, setState] = useState<AiControllerState>(() => controller.state);
  useEffect(
    () =>
      controller.subscribe(() => {
        setState(controller.state);
      }),
    [controller],
  );
  return state;
}

export function AiPanel({
  controller,
}: {
  readonly controller: AiController;
}): React.JSX.Element {
  const state = useAiState(controller);
  const [prompt, setPrompt] = useState("");
  const [label, setLabel] = useState(DEFAULT_AI_APPLY_LABEL);
  const [keyText, setKeyText] = useState("");
  const [costCap, setCostCap] = useState("1.00");
  const [evidenceResolution, setEvidenceResolution] = useState("512");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const keyInputRef = useRef<HTMLInputElement | null>(null);

  const canRun =
    state.documentOpen &&
    state.configured &&
    state.consented &&
    !state.running &&
    !state.staged;

  const saveKey = async (): Promise<void> => {
    setBusy(true);
    try {
      const saved = await controller.saveApiKey(keyText);
      if (saved) {
        setKeyText("");
        keyInputRef.current?.focus();
      }
    } finally {
      setBusy(false);
    }
  };

  const consent = async (): Promise<void> => {
    setBusy(true);
    try {
      const cap = Number(costCap);
      await controller.consent(
        Number.isFinite(cap) && cap > 0 ? cap : undefined,
      );
    } finally {
      setBusy(false);
    }
  };

  const run = (): void => {
    if (prompt.trim().length === 0) return;
    void controller.run(prompt);
  };

  const consentImages = async (): Promise<void> => {
    setBusy(true);
    try {
      const resolution = Number(evidenceResolution);
      await controller.consentImages(
        Number.isInteger(resolution) && resolution >= 256 && resolution <= 1024
          ? resolution
          : undefined,
      );
    } finally {
      setBusy(false);
    }
  };

  const gated = state.refinement?.evaluation?.promotable === false;

  return (
    <section
      className="panel ai-panel"
      aria-label="AI assistant"
      id={PANEL_FOCUS_IDS.ai}
      tabIndex={-1}
    >
      <h2>AI Assistant</h2>
      {!state.documentOpen ? (
        <p className="panel-empty">Open a document to use the AI assistant.</p>
      ) : null}

      <details
        className="ai-settings"
        open={settingsOpen}
        onToggle={(event) => {
          setSettingsOpen(event.currentTarget.open);
          if (event.currentTarget.open) {
            void controller.refreshStatus();
          }
        }}
      >
        <summary>Provider settings</summary>
        <p className="ai-provider-line">
          {state.providerId} · {state.model}
        </p>
        {!state.configured ? (
          <div className="ai-key-form">
            <label>
              <span>API key</span>
              <input
                ref={keyInputRef}
                type="password"
                value={keyText}
                maxLength={4000}
                disabled={busy}
                aria-label="Provider API key"
                placeholder="sk-…"
                onChange={(event) => {
                  setKeyText(event.target.value);
                }}
              />
            </label>
            <button
              type="button"
              disabled={busy || keyText.trim().length === 0}
              onClick={() => void saveKey()}
            >
              Save key
            </button>
            <p className="ai-hint">
              AI runs are unavailable until a provider key is stored. The key is
              kept in the operating-system keychain and never written to your
              project.
            </p>
          </div>
        ) : (
          <div className="ai-key-stored">
            <span>Provider key stored</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void controller.clearApiKey()}
            >
              Remove key
            </button>
          </div>
        )}
      </details>

      {state.configured && state.consented ? (
        <div
          className="ai-visual"
          role="group"
          aria-label="Visual refinement evidence"
        >
          <label className="ai-check">
            <input
              type="checkbox"
              checked={state.visualEnabled}
              disabled={busy}
              aria-label="Enable visual refinement evidence"
              onChange={(event) => {
                controller.setVisualEnabled(event.target.checked);
              }}
            />
            <span>Refine proposals with standard-view images</span>
          </label>
          {state.visualEnabled && state.imageConsent === undefined ? (
            <div className="ai-image-consent">
              <p>
                Images are off by default and are a separate disclosure from
                text AI. Approving enables the visual-refinement phase to
                transmit the four standard views (perspective, front, side, top)
                of your staged proposal at a bounded resolution, count, and
                estimated cost.
              </p>
              <p className="ai-hint">
                {state.providerId} privacy policy:{" "}
                {PROVIDER_PRIVACY_POLICY.summary} (policy as of{" "}
                {PROVIDER_PRIVACY_POLICY.recordedAt},{" "}
                <a
                  href={PROVIDER_PRIVACY_POLICY.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  provider policy
                </a>
                ).
              </p>
              <label className="ai-cost-cap">
                <span>Evidence resolution (px)</span>
                <select
                  value={evidenceResolution}
                  disabled={busy}
                  aria-label="Evidence resolution"
                  onChange={(event) => {
                    setEvidenceResolution(event.target.value);
                  }}
                >
                  <option value="256">256×256</option>
                  <option value="512">512×512</option>
                  <option value="1024">1024×1024</option>
                </select>
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => void consentImages()}
              >
                Approve image transmission
              </button>
            </div>
          ) : null}
          {state.imageConsent !== undefined ? (
            <p className="ai-hint">
              Image transmission approved for{" "}
              {String(state.imageConsent.views.length)} standard views at up to{" "}
              {String(state.imageConsent.maxResolution)}px,{" "}
              {String(state.imageConsent.maxImages)} images per session, est. $
              {String(state.imageConsent.estimatedCostUsd)}.{" "}
              <button
                type="button"
                className="link"
                disabled={busy}
                onClick={() => void controller.clearImageConsent()}
              >
                Revoke
              </button>
            </p>
          ) : null}
          {state.refinement !== undefined ? (
            <p className="ai-hint">
              Last run: {String(state.refinement.iterations)} visual iteration
              {state.refinement.iterations === 1 ? "" : "s"},{" "}
              {String(state.refinement.imagesSent)} image
              {state.refinement.imagesSent === 1 ? "" : "s"} transmitted.
            </p>
          ) : null}
        </div>
      ) : null}

      {state.configured && !state.consented ? (
        <div className="ai-consent" role="group" aria-label="Provider consent">
          <p>
            Running AI sends text to {state.providerId} ({state.model}). Review
            what is transmitted and enable the provider:
          </p>
          <ul>
            <li>your prompt and the run&apos;s messages</li>
            <li>the fixed system safety, tool, and limit instructions</li>
            <li>provider, model, and settings identifiers</li>
            <li>bounded document selection summaries and base revision</li>
            <li>explicitly used inspection tool results</li>
            <li>staged command summaries, validation errors, bounded diffs</li>
          </ul>
          <label className="ai-cost-cap">
            <span>Per-run cost cap (USD)</span>
            <input
              type="number"
              min={0.01}
              step={0.01}
              value={costCap}
              disabled={busy}
              onChange={(event) => {
                setCostCap(event.target.value);
              }}
            />
          </label>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => void consent()}
          >
            I understand and enable {state.model}
          </button>
        </div>
      ) : null}

      {state.configured && state.consented ? (
        <div className="ai-workspace">
          {state.phase === "idle" ? (
            <div className="ai-prompt-form">
              <label>
                <span>Describe the edit</span>
                <textarea
                  value={prompt}
                  rows={4}
                  maxLength={MAX_AI_PROMPT_LENGTH}
                  placeholder="e.g. Shorten the chair legs by one voxel"
                  aria-label="AI edit request"
                  onChange={(event) => {
                    setPrompt(event.target.value);
                  }}
                />
              </label>
              <button
                type="button"
                className="primary"
                disabled={!canRun}
                onClick={run}
              >
                Run
              </button>
            </div>
          ) : null}

          {state.phase === "running" ? (
            <div className="ai-running" role="status" aria-live="polite">
              <p>Working on “{state.prompt}”…</p>
              <button
                type="button"
                className="cancel"
                onClick={() => {
                  controller.cancel();
                }}
              >
                Cancel
              </button>
            </div>
          ) : null}

          {state.phase === "approve" ? (
            <div
              className="ai-approve"
              role="group"
              aria-label="Review proposal"
            >
              <h3>Proposal ready for review</h3>
              <AiDiffSummary controller={controller} state={state} />
              {state.diff !== undefined &&
              state.diff.voxelEstimate >= LARGE_PROPOSAL_VOXELS ? (
                <p className="ai-review-warning" role="alert">
                  This is a large proposal ({String(state.diff.voxelEstimate)}{" "}
                  voxels). Review it carefully before applying.
                </p>
              ) : null}
              {state.refinement?.evaluation !== undefined ? (
                <div className="ai-refinement-eval" role="group">
                  {state.refinement.lastCritique !== undefined ? (
                    <p>
                      Last critique: {state.refinement.lastCritique.category} —
                      {state.refinement.lastCritique.evidence}
                    </p>
                  ) : null}
                  <p>
                    Visual refinement evaluation: structural occupancy changed
                    by {formatDelta(state.refinement.evaluation.occupancyDelta)}
                    , visual similarity{" "}
                    {Math.round(
                      state.refinement.evaluation.overallSimilarity * 100,
                    )}
                    %.
                  </p>
                  {state.refinement.evaluation.regressions.length > 0 ? (
                    <p className="ai-review-warning" role="alert">
                      Regression gate:{" "}
                      {state.refinement.evaluation.regressions.join(", ")}. This
                      proposal is not promoted automatically — review it before
                      applying.
                    </p>
                  ) : null}
                </div>
              ) : null}
              <label className="ai-label">
                <span>History label</span>
                <input
                  type="text"
                  value={label}
                  maxLength={120}
                  aria-label="History label"
                  onChange={(event) => {
                    setLabel(event.target.value);
                  }}
                />
              </label>
              <div className="ai-actions">
                {gated ? (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      controller.applyForced(label);
                    }}
                  >
                    Apply anyway
                  </button>
                ) : (
                  <button
                    type="button"
                    className="primary"
                    onClick={() => {
                      controller.apply(label);
                    }}
                  >
                    Apply
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    controller.discard();
                  }}
                >
                  Discard
                </button>
              </div>
            </div>
          ) : null}

          {state.phase === "conflict" ? (
            <div className="ai-conflict" role="alert">
              <h3>The document changed while the proposal was pending</h3>
              <p>
                The proposal was staged at revision{" "}
                {String(state.baseRevision ?? 0)}; the document is now at
                revision {String(state.liveRevision ?? 0)}. It was never
                silently rebased — choose how to continue:
              </p>
              <AiDiffSummary controller={controller} state={state} />
              <div className="ai-actions">
                <button
                  type="button"
                  onClick={() => {
                    controller.discard();
                  }}
                >
                  Discard
                </button>
                <button
                  type="button"
                  onClick={() => {
                    void controller.reinspect();
                  }}
                >
                  Reinspect
                </button>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    void controller.replan();
                  }}
                >
                  Replan
                </button>
              </div>
            </div>
          ) : null}

          {state.phase === "canceled" ? (
            <div className="ai-terminal" role="status">
              <p>The AI run was cancelled. Nothing was changed.</p>
              <button
                type="button"
                onClick={() => {
                  controller.dismiss();
                }}
              >
                Dismiss
              </button>
            </div>
          ) : null}

          {state.phase === "error" ? (
            <div className="ai-terminal" role="alert">
              <p>
                {state.error !== undefined
                  ? state.error.message
                  : "The AI run failed."}
              </p>
              {state.reason !== undefined ? (
                <p className="ai-hint">Reason: {state.reason}</p>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  controller.dismiss();
                }}
              >
                Dismiss
              </button>
            </div>
          ) : null}

          {state.applied !== undefined ? (
            <p className="ai-applied" role="status">
              Applied “{state.applied.label}” (
              {String(state.applied.stagedCommandCount)} command
              {state.applied.stagedCommandCount === 1 ? "" : "s"}).
            </p>
          ) : null}

          {state.activity.length > 0 ? (
            <div className="ai-activity" aria-label="Run activity">
              <h3>Activity</h3>
              <ul>
                {state.activity.map((entry) => (
                  <li key={entry.id} className={`ai-activity-${entry.kind}`}>
                    {entry.kind === "tool" ? (
                      <span
                        className={entry.ok === false ? "ai-failed" : undefined}
                      >
                        {entry.ok === false ? "✗" : "✓"} {entry.message}
                      </span>
                    ) : (
                      <span>{entry.message}</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {state.usage !== undefined ? (
            <p className="ai-usage">
              Tokens: {String(state.usage.inputTokens)} in /{" "}
              {String(state.usage.outputTokens)} out
            </p>
          ) : null}
        </div>
      ) : null}

      {!state.configured ? (
        <p className="ai-hint">
          The AI workflow is unavailable until it is configured; every manual
          editing workflow keeps working.
        </p>
      ) : null}
    </section>
  );
}

/**
 * Staged overlay clip player (plan S13.5, ticket #36): plays one staged
 * clip through the controller's read-only sampler before Apply. Runtime
 * projection only — no commands, no revisions, no live mutation.
 */
function StagedClipPlayer({
  controller,
  clips,
}: {
  readonly controller: AiController;
  readonly clips: readonly {
    readonly animationId: string;
    readonly name: string;
    readonly duration: number;
  }[];
}): React.JSX.Element | null {
  const [selectedId, setSelectedId] = useState(clips[0]?.animationId ?? "");
  const [playing, setPlaying] = useState(false);
  const [sample, setSample] = useState<
    | { readonly time: number; readonly movedNodes: readonly string[] }
    | undefined
  >(undefined);
  const timerRef = useRef<number | null>(null);
  const startedAtRef = useRef<number>(0);

  const selected =
    clips.find((clip) => clip.animationId === selectedId) ?? clips[0];
  const activeId = selected?.animationId ?? "";
  const duration = selected?.duration ?? 0;

  const stop = (): void => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setPlaying(false);
    setSample(undefined);
  };

  useEffect(
    () => () => {
      stop();
    },
    [],
  );

  const play = (): void => {
    if (activeId.length === 0 || duration <= 0) return;
    stop();
    setPlaying(true);
    startedAtRef.current = performance.now();
    const tick = (): void => {
      const elapsed = (performance.now() - startedAtRef.current) / 1000;
      const time = elapsed % duration;
      setSample(controller.sampleStagedClip(activeId, time) ?? undefined);
    };
    tick();
    timerRef.current = window.setInterval(tick, 120);
  };

  if (clips.length === 0) return null;
  return (
    <div className="ai-clip-player">
      <p>Staged overlay clip playback (pre-Apply, runtime-only):</p>
      <label>
        Clip{" "}
        <select
          value={activeId}
          onChange={(event) => {
            setSelectedId(event.target.value);
            stop();
          }}
        >
          {clips.map((clip) => (
            <option key={clip.animationId} value={clip.animationId}>
              {clip.name}
            </option>
          ))}
        </select>
      </label>{" "}
      {playing ? (
        <button type="button" onClick={stop}>
          Stop
        </button>
      ) : (
        <button type="button" onClick={play}>
          Play overlay clip
        </button>
      )}
      {sample !== undefined ? (
        <p>
          t={sample.time.toFixed(2)}s ·{" "}
          {sample.movedNodes.length === 0
            ? "no nodes moving"
            : `${String(sample.movedNodes.length)} node${sample.movedNodes.length === 1 ? "" : "s"} moving`}
        </p>
      ) : null}
    </div>
  );
}

/** Bounded diff summary of the staged overlay (plan S11.11). */
function AiDiffSummary({
  controller,
  state,
}: {
  readonly controller: AiController;
  readonly state: AiControllerState;
}): React.JSX.Element {
  const diff = state.diff;
  if (diff === undefined) {
    return <p className="ai-diff-empty">No staged changes to review.</p>;
  }
  return (
    <div className="ai-diff">
      <p>
        {String(diff.stagedCommandCount)} staged command
        {diff.stagedCommandCount === 1 ? "" : "s"} ·{" "}
        {String(diff.voxelEstimate)} voxels · base revision{" "}
        {String(diff.baseRevision)}
      </p>
      {diff.commandTypes.length > 0 ? (
        <ul>
          {diff.commandTypes.map((entry) => (
            <li key={entry.type}>
              {entry.type} × {String(entry.count)}
            </li>
          ))}
        </ul>
      ) : null}
      <p>
        {String(diff.changedNodeIds.length)} node
        {diff.changedNodeIds.length === 1 ? "" : "s"} ·{" "}
        {String(diff.changedMaterialIds.length)} material
        {diff.changedMaterialIds.length === 1 ? "" : "s"} ·{" "}
        {String(diff.changedVolumeIds.length)} volume
        {diff.changedVolumeIds.length === 1 ? "" : "s"} ·{" "}
        {String(diff.changedAnimationIds.length)} clip
        {diff.changedAnimationIds.length === 1 ? "" : "s"}
        {diff.truncated ? " · list truncated" : ""}
      </p>
      {state.stagedClips.length > 0 ? (
        <div className="ai-staged-clips">
          <p>
            {String(state.stagedClips.length)} staged overlay clip
            {state.stagedClips.length === 1 ? "" : "s"}:
          </p>
          <ul>
            {state.stagedClips.map((clip) => (
              <li key={clip.animationId}>
                {clip.name} · {String(clip.duration)}s · {clip.loop} ·{" "}
                {String(clip.trackCount)} track
                {clip.trackCount === 1 ? "" : "s"} ·{" "}
                {String(clip.keyframeCount)} keyframe
                {clip.keyframeCount === 1 ? "" : "s"}
              </li>
            ))}
          </ul>
          <StagedClipPlayer controller={controller} clips={state.stagedClips} />
        </div>
      ) : null}
    </div>
  );
}
