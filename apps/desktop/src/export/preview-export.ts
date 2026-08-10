import { WorkspaceError, createListenerSet } from "@voxel-maker/shared";
import type { DocumentSession } from "@voxel-maker/session";
import type { ImageStoragePort } from "@voxel-maker/storage";
import { encodePng } from "@voxel-maker/formats";
import {
  DEFAULT_PREVIEW_SIZE,
  PreviewCancelledError,
  STANDARD_PREVIEW_VIEWS,
  renderStandardPreview,
  validatePreviewSpec,
  type PreviewViewId,
} from "@voxel-maker/renderer";
import type { FilePicker, PickedPath } from "../composition.js";
import type { PromptService } from "../prompts.js";
import { PROMPT_MESSAGES } from "../prompts.js";

/**
 * Standard preview export workflow (plan S8.5/S15.2, ticket #25): renders
 * the current document from the four standard viewpoints with the fixed
 * preview protocol, encodes PNG bytes, and writes each image through the
 * scoped atomic image storage port with per-view progress, safe
 * cancellation, and overwrite confirmation.
 *
 * The service is a pure read workflow: it captures the open document's
 * read view and never mutates semantic state, history, dirty state, or
 * the recovery journal, so exported previews cannot affect document
 * semantics or the canonical hash. Cancellation is cooperative — the
 * renderer polls a cancel flag between chunks, and the workflow stops
 * between views/phases — so a cancelled export can only have written the
 * images that completed before the cancel.
 */

/** One view's lifecycle within an export run. */
export type PreviewViewState =
  | "pending"
  | "rendering"
  | "encoding"
  | "writing"
  | "done"
  | "cancelled"
  | "failed";

export interface PreviewExportViewStatus {
  readonly view: PreviewViewId;
  readonly state: PreviewViewState;
  /** Destination path once the view's image has been written. */
  readonly path: string | undefined;
}

/** Overall workflow state. */
export type PreviewExportState =
  | "idle"
  | "exporting"
  | "completed"
  | "cancelled"
  | "failed";

/** Read projection of the workflow for the shell chrome. */
export interface PreviewExportStatus {
  readonly state: PreviewExportState;
  readonly views: readonly PreviewExportViewStatus[];
  /** Chosen destination base (the four names derive from it). */
  readonly basePath: string | undefined;
  /** Structured error when the run failed. */
  readonly error: WorkspaceError | undefined;
}

/** Outcome of one export run (undefined = user cancelled the picker/confirm). */
export interface PreviewExportResult {
  readonly ok: boolean;
  /** True when the run stopped at a user cancel after partial writes. */
  readonly cancelled: boolean;
  /** Every image that was written (empty when nothing was written). */
  readonly paths: readonly string[];
  /** Structured error when `ok` is false. */
  readonly error: WorkspaceError | undefined;
}

export interface PreviewExportOptions {
  /** Requested square dimensions; defaults to `DEFAULT_PREVIEW_SIZE`. */
  readonly size?: number;
}

export interface PreviewExportService {
  readonly status: PreviewExportStatus;
  /**
   * Exports the four standard preview images next to a user-chosen base
   * path. Returns undefined when the user cancels the picker or declines
   * an overwrite; a cancelled run returns a result with `cancelled` and
   * the partial paths.
   */
  exportPreviews(
    options?: PreviewExportOptions,
  ): Promise<PreviewExportResult | undefined>;
  /** Requests a safe stop; effective between chunks, views, and phases. */
  cancel(): void;
  /** Subscribes to status changes; returns an unsubscribe function. */
  subscribe(listener: () => void): () => void;
  dispose(): void;
}

export interface PreviewExportServiceOptions {
  readonly session: DocumentSession;
  readonly imageStorage: ImageStoragePort;
  readonly picker: FilePicker;
  /** Overwrite confirmation prompt. */
  readonly prompts: PromptService;
}

/** Derives the four standard-view file names from a chosen base path. */
export function previewImagePaths(basePath: string): readonly string[] {
  return STANDARD_PREVIEW_VIEWS.map(
    (view) => `${stripPngExtension(basePath)}-${view}.png`,
  );
}

/**
 * Picks the four preview destinations (issue #94). The native picker
 * returns one scoped image handle per standard view (minted in Rust from
 * the single base the user chose); a picker without the multi-path
 * method falls back to one save pick and derives the four names, which
 * is valid only where the token IS the plain path (browser/test shells).
 */
async function pickPreviewDestinations(
  picker: FilePicker,
  suggested: string,
): Promise<readonly PickedPath[] | undefined> {
  if (picker.pickSaveImagePaths !== undefined) {
    return await picker.pickSaveImagePaths(suggested);
  }
  const base = await picker.pickSavePath(suggested);
  if (base === undefined) return undefined;
  return previewImagePaths(base.path).map((path) => ({ token: path, path }));
}

/** Removes a trailing `.png`/`.PNG` so `foo.png` yields `foo-<view>.png`. */
function stripPngExtension(basePath: string): string {
  return /\.png$/iu.test(basePath) ? basePath.slice(0, -4) : basePath;
}

/** Suggested destination for the export dialog (`<title>.png`). */
export function suggestedPreviewName(title: string | undefined): string {
  const base =
    typeof title === "string" && title.length > 0
      ? title.replace(/[^A-Za-z0-9._-]+/gu, "-")
      : "untitled";
  return `${base}.png`;
}

/** Converts any thrown value into a structured, user-safe error. */
function toWorkspaceError(
  error: unknown,
  fallback: { readonly family: "io" | "internal"; readonly code: string },
): WorkspaceError {
  if (error instanceof WorkspaceError) return error;
  return new WorkspaceError({
    family: fallback.family,
    code: fallback.code,
    message: error instanceof Error ? error.message : "Preview export failed",
  });
}

export function createPreviewExportService(
  options: PreviewExportServiceOptions,
): PreviewExportService {
  const { session, imageStorage, picker, prompts } = options;
  const listeners = createListenerSet<undefined>();
  let cancelled = false;
  let runSerial = 0;
  let status: PreviewExportStatus = {
    state: "idle",
    views: STANDARD_PREVIEW_VIEWS.map((view) => ({
      view,
      state: "pending",
      path: undefined,
    })),
    basePath: undefined,
    error: undefined,
  };

  const notify = (): void => {
    listeners.emit(undefined);
  };

  const setStatus = (next: PreviewExportStatus): void => {
    status = next;
    notify();
  };

  const withView = (
    view: PreviewViewId,
    state: PreviewViewState,
    path?: string,
  ): PreviewExportViewStatus[] =>
    status.views.map((entry) =>
      entry.view === view ? { view, state, path } : entry,
    );

  return {
    get status() {
      return status;
    },
    async exportPreviews(exportOptions) {
      const current = session.current;
      if (current === undefined) {
        return {
          ok: false,
          cancelled: false,
          paths: [],
          error: new WorkspaceError({
            family: "conflict",
            code: "SESSION_NOT_OPEN",
            message: "No document is open to export previews",
          }),
        };
      }
      const size = exportOptions?.size ?? DEFAULT_PREVIEW_SIZE;
      // Validate the requested dimensions before any dialog or work.
      try {
        validatePreviewSpec({ view: "front", width: size, height: size });
      } catch (error) {
        return {
          ok: false,
          cancelled: false,
          paths: [],
          error: toWorkspaceError(error, {
            family: "internal",
            code: "PREVIEW_INVALID_SIZE",
          }),
        };
      }
      const title = current.store.getDocument().metadata.title;
      const suggested = suggestedPreviewName(
        typeof title === "string" ? title : undefined,
      );
      // PNG-filtered save dialog when the picker supports it. The native
      // shell mints one scoped image handle per standard view (issue
      // #94); pickers without the multi-path method fall back to one
      // save pick and derive the four names (browser/test shells).
      const picked = await pickPreviewDestinations(picker, suggested);
      if (picked === undefined) return undefined;
      const destinations = picked;
      if (destinations.length !== STANDARD_PREVIEW_VIEWS.length) {
        return {
          ok: false,
          cancelled: false,
          paths: [],
          error: toWorkspaceError(
            new Error("The image picker returned an invalid destination count"),
            { family: "io", code: "PREVIEW_IO_FAILED" },
          ),
        };
      }
      const basePath = stripPngExtension(destinations[0]?.path ?? suggested);
      const paths = destinations.map((destination) => destination.path);
      // Overwrite confirmation before any render or write: the user
      // decides once, and declining aborts the whole run. The preflight
      // is part of the run's error contract: a failing port surfaces a
      // structured error instead of an unhandled rejection.
      const existing: string[] = [];
      try {
        for (const destination of destinations) {
          if (await imageStorage.exists(destination.token)) {
            existing.push(destination.path);
          }
        }
        if (
          existing.length > 0 &&
          !(await prompts.confirm(PROMPT_MESSAGES.overwritePreviews(existing)))
        ) {
          return undefined;
        }
      } catch (error) {
        return {
          ok: false,
          cancelled: false,
          paths: [],
          error: toWorkspaceError(error, {
            family: "io",
            code: "PREVIEW_IO_FAILED",
          }),
        };
      }
      cancelled = false;
      runSerial += 1;
      const serial = runSerial;
      const store = current.store;
      setStatus({
        state: "exporting",
        views: STANDARD_PREVIEW_VIEWS.map((view) => ({
          view,
          state: "pending",
          path: undefined,
        })),
        basePath,
        error: undefined,
      });
      const written: string[] = [];
      for (let index = 0; index < STANDARD_PREVIEW_VIEWS.length; index += 1) {
        const view = STANDARD_PREVIEW_VIEWS[index] as PreviewViewId;
        const destination = destinations[index];
        if (destination === undefined) {
          return {
            ok: false,
            cancelled: false,
            paths: written,
            error: toWorkspaceError(
              new Error("The image picker returned no destination for a view"),
              { family: "io", code: "PREVIEW_IO_FAILED" },
            ),
          };
        }
        // A newer run supersedes this one (the shell disables concurrent
        // exports, but the guard keeps the invariant local).
        if (serial !== runSerial) {
          setStatus({
            state: "cancelled",
            views: withView(view, "cancelled"),
            basePath,
            error: undefined,
          });
          return {
            ok: true,
            cancelled: true,
            paths: written,
            error: undefined,
          };
        }
        try {
          setStatus({
            state: "exporting",
            views: withView(view, "rendering"),
            basePath,
            error: undefined,
          });
          const rendered = renderStandardPreview({
            store,
            spec: { view, width: size, height: size },
            shouldCancel: () => cancelled,
          });
          setStatus({
            state: "exporting",
            views: withView(view, "encoding"),
            basePath,
            error: undefined,
          });
          const png = encodePng(rendered.rgba, rendered.width, rendered.height);
          const path = destination.path;
          setStatus({
            state: "exporting",
            views: withView(view, "writing"),
            basePath,
            error: undefined,
          });
          await imageStorage.writeImageAtomic(destination.token, png);
          written.push(path);
          setStatus({
            state: "exporting",
            views: withView(view, "done", path),
            basePath,
            error: undefined,
          });
        } catch (error) {
          if (error instanceof PreviewCancelledError) {
            setStatus({
              state: "cancelled",
              views: withView(view, "cancelled"),
              basePath,
              error: undefined,
            });
            return {
              ok: true,
              cancelled: true,
              paths: written,
              error: undefined,
            };
          }
          const structured = toWorkspaceError(error, {
            family: "io",
            code: "PREVIEW_WRITE_FAILED",
          });
          setStatus({
            state: "failed",
            views: withView(view, "failed"),
            basePath,
            error: structured,
          });
          return {
            ok: false,
            cancelled: false,
            paths: written,
            error: structured,
          };
        }
      }
      setStatus({
        state: "completed",
        views: STANDARD_PREVIEW_VIEWS.map((view, index) => ({
          view,
          state: "done",
          path: paths[index],
        })),
        basePath,
        error: undefined,
      });
      return { ok: true, cancelled: false, paths: written, error: undefined };
    },
    cancel() {
      cancelled = true;
    },
    subscribe(listener) {
      return listeners.add(listener);
    },
    dispose() {
      listeners.clear();
    },
  };
}
