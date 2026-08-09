/**
 * User-facing confirmation prompts for project lifecycle decisions
 * (plan S7.16, ticket #22): dirty-close, overwrite, and recovery-choice
 * prompts are injected into the file service so the workflow stays
 * testable in Node and the browser/Tauri shell supplies the same
 * `window.confirm` surface. Prompts are UI policy, never semantic logic:
 * the file service decides WHAT is asked, the shell decides HOW it is
 * shown.
 */

export interface PromptService {
  /**
   * Asks the user to confirm a destructive or irreversible action. The
   * message is user-safe and already explains the consequence; resolving
   * `true` means "proceed", `false` means "cancel".
   */
  confirm(message: string): Promise<boolean>;
}

/**
 * The default shell prompt: a native `window.confirm` dialog. Access is
 * lazy so creating the service in a Node test environment never touches
 * `window`; in a non-browser environment a prompt resolves `false`
 * (cancel), which is the safe default for automated shells.
 */
export function createDefaultPrompts(): PromptService {
  return {
    confirm(message) {
      if (typeof window === "undefined") {
        return Promise.resolve(false);
      }
      return Promise.resolve(window.confirm(message));
    },
  };
}

/** Shared message wording so the browser and tests agree exactly. */
export const PROMPT_MESSAGES = {
  discardChanges:
    "The current project has unsaved changes. Discard them and continue?",
  overwriteProject:
    "A project file already exists at this location. Replace it?",
  overwritePreviews: (paths: readonly string[]): string =>
    `The following preview image${paths.length === 1 ? "" : "s"} already ${
      paths.length === 1 ? "exists" : "exist"
    }: ${paths.join(", ")}. Replace ${paths.length === 1 ? "it" : "them"}?`,
  applyRecovery: (count: number): string =>
    `This project has ${String(count)} unsaved change${
      count === 1 ? "" : "s"
    } recorded for recovery. Apply ${count === 1 ? "it" : "them"}?`,
  applyDegradedRecovery: (recovered: number, total: number): string =>
    `This project has ${String(total)} recorded changes, but only ${String(
      recovered,
    )} could be recovered. Apply the recovered changes?`,
} as const;
