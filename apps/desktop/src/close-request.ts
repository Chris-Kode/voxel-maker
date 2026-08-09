import type { FileService } from "./file-service.js";

/**
 * OS window close handling (plan S7.16, ticket #22): the Tauri shell asks
 * the webview before closing, and a dirty document must prompt before the
 * window disappears. The handler is a pure function over the injected file
 * service and destroy callback so Node tests can exercise the exact
 * close/discard decision without a Tauri window.
 */

export type CloseOutcome = "closed" | "cancelled";

/**
 * Resolves whether the window may close. A clean project closes
 * immediately; a dirty project goes through the file service's discard
 * prompt (the same prompt as the in-app Close button) and the window is
 * destroyed only when the user confirms. Returns `cancelled` when the user
 * declines, so the shell keeps the window open.
 */
export async function handleCloseRequest(
  fileService: FileService,
  destroy: () => Promise<void>,
): Promise<CloseOutcome> {
  if (!fileService.status.dirty) {
    await destroy();
    return "closed";
  }
  const result = await fileService.closeProject();
  if (result?.ok !== true) return "cancelled";
  await destroy();
  return "closed";
}
