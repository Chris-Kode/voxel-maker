import { WorkspaceError } from "@voxel-maker/shared";
import type { SaveCoordinator } from "@voxel-maker/storage";

/**
 * Debounced autosave binding for one open document (plan S5.8, ticket
 * #22). The binding watches the save coordinator's dirty transitions:
 * when the project becomes dirty and a path exists, it schedules one
 * snapshot save after `delayMs`; a save already in flight, a pending
 * timer, or a scheduled retry suppresses new timers. Failures surface
 * through `onFailure` and schedule one bounded retry. Lifecycle
 * replacement disposes the binding (cancelling the timer and any
 * retry), which is how autosave bindings are reset on replace.
 *
 * Autosave is runtime projection policy: it never mutates semantic
 * state, writes only through the same serialized save coordinator as a
 * manual save, and a stale completion can never clear dirty state
 * (S5.14).
 */

export interface AutosaveController {
  /** Cancels the pending timer and any retry; the binding is terminal. */
  dispose(): void;
}

export interface AutosaveOptions {
  readonly coordinator: SaveCoordinator;
  /** Current project path; autosave pauses while no path exists. */
  readonly path: () => string | undefined;
  /** Debounce between the last dirty transition and the write. */
  readonly delayMs: number;
  readonly onStart?: () => void;
  readonly onSettled?: () => void;
  readonly onFailure?: (error: WorkspaceError) => void;
}

export function createAutosave(options: AutosaveOptions): AutosaveController {
  const { coordinator, path, delayMs } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inflight: Promise<unknown> | undefined;
  let retries = 0;
  let disposed = false;

  const schedule = (): void => {
    if (disposed || timer !== undefined || inflight !== undefined) return;
    if (path() === undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delayMs);
  };

  const run = async (): Promise<void> => {
    const currentPath = path();
    if (currentPath === undefined) return;
    inflight = coordinator.save(currentPath);
    options.onStart?.();
    try {
      await inflight;
      retries = 0;
    } catch (error) {
      options.onFailure?.(
        error instanceof WorkspaceError
          ? error
          : new WorkspaceError({
              family: "io",
              code: "AUTOSAVE_FAILED",
              message:
                error instanceof Error ? error.message : "Autosave failed",
            }),
      );
      if (!disposed && retries < 1) {
        // One bounded retry after the debounce; a second failure waits
        // for the next dirty transition.
        retries += 1;
        timer = setTimeout(() => {
          timer = undefined;
          void run();
        }, delayMs);
      }
    } finally {
      inflight = undefined;
      options.onSettled?.();
    }
  };

  const unsubscribe = coordinator.subscribe((event) => {
    if (event.kind === "dirty-changed" && event.dirty) schedule();
  });

  return {
    dispose() {
      disposed = true;
      unsubscribe();
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
