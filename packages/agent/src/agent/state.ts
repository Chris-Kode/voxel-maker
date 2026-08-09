import { WorkspaceError } from "@voxel-maker/shared";

/**
 * Agent state machine (plan S12.1, ticket #33): the explicit states of one
 * bounded agent run. The machine is a pure transition table with no I/O,
 * provider, or budget knowledge, so every run — real or deterministic —
 * follows the same shape:
 *
 *   understand -> inspect -> plan -> stage -> inspect-staged -> validate
 *   -> approve -> commit | discard
 *
 * `cancel` and `error` are reachable from every non-terminal state;
 * terminal states are never left. The loop drives the machine; the
 * approval step is always explicit (ADR-0007), so `commit` happens only
 * through an explicit user action after `approve`.
 */

/** Every explicit agent state in stable v1 order (AC: explicit states). */
export const AGENT_STATES = [
  "understand",
  "inspect",
  "plan",
  "stage",
  "inspect-staged",
  "validate",
  "approve",
  "commit",
  "discard",
  "cancel",
  "error",
] as const;

export type AgentState = (typeof AGENT_STATES)[number];

/** States that end a run; no transition leaves them. */
export const TERMINAL_STATES: readonly AgentState[] = Object.freeze([
  "commit",
  "discard",
  "cancel",
  "error",
]);

/**
 * Explicit transition table. Loop states may re-enter themselves
 * (repeated inspection, repeated staging rounds, validation fixes);
 * `approve` leads only to explicit commit/discard or cancellation/error.
 */
export const TRANSITIONS: Readonly<Record<AgentState, readonly AgentState[]>> =
  Object.freeze({
    understand: Object.freeze(["inspect", "cancel", "error"] as const),
    inspect: Object.freeze([
      "inspect",
      "plan",
      "stage",
      "cancel",
      "error",
    ] as const),
    plan: Object.freeze(["stage", "inspect", "cancel", "error"] as const),
    stage: Object.freeze([
      "stage",
      "inspect-staged",
      "cancel",
      "error",
    ] as const),
    "inspect-staged": Object.freeze([
      "stage",
      "validate",
      "cancel",
      "error",
    ] as const),
    validate: Object.freeze(["stage", "approve", "cancel", "error"] as const),
    approve: Object.freeze(["commit", "discard", "cancel", "error"] as const),
    commit: Object.freeze([] as const),
    discard: Object.freeze([] as const),
    cancel: Object.freeze([] as const),
    error: Object.freeze([] as const),
  });

/** Stable error code for invalid machine transitions. */
export const INVALID_STATE_TRANSITION_CODE = "INVALID_STATE_TRANSITION";

function transitionError(from: AgentState, to: AgentState): WorkspaceError {
  return new WorkspaceError({
    family: "validation",
    code: INVALID_STATE_TRANSITION_CODE,
    message: `Invalid agent state transition: ${from} -> ${to}`,
    context: { from, to },
  });
}

/**
 * One agent run's state machine. `transition` returns the new state and
 * throws a stable `WorkspaceError` for transitions outside the table;
 * `cancel` and `fail` are idempotent-safe shortcuts that throw once the
 * run already terminated.
 */
export class AgentStateMachine {
  #state: AgentState;

  constructor(initial: AgentState = "understand") {
    this.#state = initial;
  }

  get state(): AgentState {
    return this.#state;
  }

  get terminated(): boolean {
    return TERMINAL_STATES.includes(this.#state);
  }

  /** True when `next` is an allowed transition from the current state. */
  canTransition(next: AgentState): boolean {
    return TRANSITIONS[this.#state].includes(next);
  }

  /** Moves to `next`; throws a stable error for invalid transitions. */
  transition(next: AgentState): AgentState {
    if (!this.canTransition(next)) throw transitionError(this.#state, next);
    this.#state = next;
    return this.#state;
  }

  /** Requests cancellation; valid from every non-terminal state. */
  cancel(): void {
    if (this.terminated) {
      throw new WorkspaceError({
        family: "validation",
        code: INVALID_STATE_TRANSITION_CODE,
        message: `Cannot cancel a terminated agent run (state: ${this.#state})`,
        context: { state: this.#state },
      });
    }
    this.#state = "cancel";
  }

  /** Fails the run; valid from every non-terminal state. */
  fail(): void {
    if (this.terminated) {
      throw new WorkspaceError({
        family: "validation",
        code: INVALID_STATE_TRANSITION_CODE,
        message: `Cannot fail a terminated agent run (state: ${this.#state})`,
        context: { state: this.#state },
      });
    }
    this.#state = "error";
  }
}
