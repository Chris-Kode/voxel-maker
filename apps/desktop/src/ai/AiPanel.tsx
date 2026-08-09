import { useEffect, useRef, useState } from "react";
import type { AiController, AiControllerState } from "./ai-controller.js";
import {
  DEFAULT_AI_APPLY_LABEL,
  MAX_AI_PROMPT_LENGTH,
} from "./ai-controller.js";

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

  return (
    <section className="panel ai-panel" aria-label="AI assistant">
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
              <AiDiffSummary state={state} />
              {state.diff !== undefined &&
              state.diff.voxelEstimate >= LARGE_PROPOSAL_VOXELS ? (
                <p className="ai-review-warning" role="alert">
                  This is a large proposal ({String(state.diff.voxelEstimate)}{" "}
                  voxels). Review it carefully before applying.
                </p>
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
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    controller.apply(label);
                  }}
                >
                  Apply
                </button>
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
              <AiDiffSummary state={state} />
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

/** Bounded diff summary of the staged overlay (plan S11.11). */
function AiDiffSummary({
  state,
}: {
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
        {diff.changedVolumeIds.length === 1 ? "" : "s"}
        {diff.truncated ? " · list truncated" : ""}
      </p>
    </div>
  );
}
