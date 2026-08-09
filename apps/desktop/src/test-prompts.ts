import type { PromptService } from "./prompts.js";
import type { FileServiceResult } from "./file-service.js";

/**
 * Test prompt service: every confirmation resolves with the scripted
 * answer so workflow tests exercise the real prompt seam without a
 * browser. `autoConfirmPrompts` accepts every destructive action; create
 * a scripted service per test when a specific answer matters.
 */
export function createScriptedPrompts(
  answers: boolean | readonly boolean[],
): PromptService {
  let index = 0;
  const queue: readonly boolean[] = Array.isArray(answers)
    ? answers
    : [answers];
  return {
    confirm() {
      const answer = queue[Math.min(index, queue.length - 1)] ?? true;
      index += 1;
      return Promise.resolve(answer);
    },
  };
}

export const autoConfirmPrompts: PromptService = createScriptedPrompts(true);

/** Asserts that a workflow action produced a result (not a cancellation). */
export function requireResult(
  result: FileServiceResult | undefined,
): FileServiceResult {
  if (result === undefined) throw new Error("expected a file service result");
  return result;
}
