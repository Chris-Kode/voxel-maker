import { describe, expect, it } from "vitest";
import { WorkspaceError } from "@voxel-maker/shared";
import {
  AGENT_STATES,
  AgentStateMachine,
  TERMINAL_STATES,
  TRANSITIONS,
} from "./state.js";

/**
 * Agent state machine tests (plan S12.1, ticket #33): the run follows the
 * explicit understand -> inspect -> plan -> stage -> inspect-staged ->
 * validate -> approve -> commit/discard states with cancel and error
 * reachable from every non-terminal state and no silent skips.
 */

describe("agent state machine (AC: explicit states)", () => {
  it("exposes the canonical v1 state set", () => {
    expect(AGENT_STATES).toEqual([
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
    ]);
  });

  it("starts in understand and treats commit/discard/cancel/error as terminal", () => {
    const machine = new AgentStateMachine();
    expect(machine.state).toBe("understand");
    expect(machine.terminated).toBe(false);
    expect(TERMINAL_STATES).toEqual(["commit", "discard", "cancel", "error"]);
  });

  it("walks the canonical happy path and terminates at commit", () => {
    const machine = new AgentStateMachine();
    expect(machine.canTransition("inspect")).toBe(true);
    machine.transition("inspect");
    machine.transition("plan");
    machine.transition("stage");
    machine.transition("inspect-staged");
    machine.transition("validate");
    machine.transition("approve");
    expect(machine.terminated).toBe(false);
    machine.transition("commit");
    expect(machine.state).toBe("commit");
    expect(machine.terminated).toBe(true);
  });

  it("reaches discard from approve", () => {
    const machine = new AgentStateMachine();
    machine.transition("inspect");
    machine.transition("plan");
    machine.transition("stage");
    machine.transition("inspect-staged");
    machine.transition("validate");
    machine.transition("approve");
    machine.transition("discard");
    expect(machine.state).toBe("discard");
    expect(machine.terminated).toBe(true);
  });

  it("rejects every transition not listed in the table", () => {
    for (const from of AGENT_STATES) {
      for (const to of AGENT_STATES) {
        const machine = new AgentStateMachine(from);
        const allowed = TRANSITIONS[from].includes(to);
        expect(machine.canTransition(to), `${from} -> ${to}`).toBe(allowed);
        if (!allowed) {
          let threw = false;
          try {
            machine.transition(to);
          } catch (error) {
            threw = true;
            expect(error).toBeInstanceOf(WorkspaceError);
            if (error instanceof WorkspaceError) {
              expect(error.family).toBe("validation");
              expect(error.code).toBe("INVALID_STATE_TRANSITION");
            }
          }
          expect(threw, `${from} -> ${to} must throw`).toBe(true);
        }
      }
    }
  });

  it("allows re-entering loop states (inspect, stage, validate fixes)", () => {
    const machine = new AgentStateMachine();
    machine.transition("inspect");
    expect(machine.canTransition("inspect")).toBe(true);
    machine.transition("inspect");
    machine.transition("plan");
    machine.transition("stage");
    machine.transition("stage");
    expect(machine.canTransition("inspect-staged")).toBe(true);
    machine.transition("inspect-staged");
    machine.transition("stage");
    machine.transition("inspect-staged");
    machine.transition("validate");
    machine.transition("stage");
    machine.transition("inspect-staged");
    machine.transition("validate");
    expect(machine.canTransition("approve")).toBe(true);
  });

  it("supports cancel from every non-terminal state", () => {
    for (const state of AGENT_STATES.filter(
      (state) => !TERMINAL_STATES.includes(state),
    )) {
      const machine = new AgentStateMachine(state);
      machine.cancel();
      expect(machine.state).toBe("cancel");
      expect(machine.terminated).toBe(true);
    }
  });

  it("supports error from every non-terminal state", () => {
    for (const state of AGENT_STATES.filter(
      (state) => !TERMINAL_STATES.includes(state),
    )) {
      const machine = new AgentStateMachine(state);
      machine.fail();
      expect(machine.state).toBe("error");
      expect(machine.terminated).toBe(true);
    }
  });

  it("ignores cancel/fail once a terminal state is reached", () => {
    const machine = new AgentStateMachine("commit");
    expect(() => {
      machine.cancel();
    }).toThrow(WorkspaceError);
    expect(() => {
      machine.fail();
    }).toThrow(WorkspaceError);
    expect(machine.state).toBe("commit");
  });

  it("transitions approve only to commit, discard, cancel, or error", () => {
    const machine = new AgentStateMachine("approve");
    expect(machine.canTransition("commit")).toBe(true);
    expect(machine.canTransition("discard")).toBe(true);
    expect(machine.canTransition("cancel")).toBe(true);
    expect(machine.canTransition("error")).toBe(true);
    expect(machine.canTransition("stage")).toBe(false);
  });
});
