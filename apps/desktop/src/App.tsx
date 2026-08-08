import { useEffect, useState } from "react";
import { createDesktopComposition } from "./composition.js";
import { createDefaultPlatform } from "./platform/index.js";
import { Viewport } from "./viewport/Viewport.js";
import type { FileServiceResult } from "./file-service.js";

/**
 * Desktop shell chrome (plan S6.1/S6.2): a minimal header with project
 * lifecycle actions plus the viewport. All behavior lives behind the
 * composition root; this component only renders state and forwards
 * gestures.
 */
export function App(): React.JSX.Element {
  const [composition] = useState(() =>
    createDesktopComposition(createDefaultPlatform()),
  );
  const [status, setStatus] = useState(() => composition.fileService.status);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<FileServiceResult | undefined>();

  useEffect(
    () =>
      composition.fileService.subscribe(() => {
        setStatus(composition.fileService.status);
      }),
    [composition],
  );

  const run = async (
    action: () => Promise<FileServiceResult | undefined> | FileServiceResult,
  ): Promise<void> => {
    setBusy(true);
    try {
      const result = await action();
      if (result !== undefined) setLastResult(result);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app">
      <header className="toolbar">
        <span className="brand">Voxel Maker</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => composition.fileService.newProject())}
        >
          New
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(() => composition.fileService.openProject())}
        >
          Open
        </button>
        <button
          type="button"
          disabled={busy || status.documentId === undefined}
          onClick={() => void run(() => composition.fileService.saveProject())}
        >
          Save
        </button>
        <button
          type="button"
          disabled={busy || status.documentId === undefined}
          onClick={() => void run(() => composition.fileService.closeProject())}
        >
          Close
        </button>
      </header>
      <main className="stage">
        <Viewport composition={composition} />
      </main>
      <footer className="statusbar" aria-live="polite">
        <span>
          {status.documentId === undefined
            ? "No document open"
            : `Document ${status.documentId}`}
        </span>
        <span>
          {status.revision === undefined
            ? ""
            : `Revision ${String(status.revision)}`}
        </span>
        <span>
          {status.nodeCount === undefined
            ? ""
            : `${String(status.nodeCount)} nodes`}
        </span>
        <span>{status.path ?? ""}</span>
        {lastResult !== undefined &&
        !lastResult.ok &&
        lastResult.error !== undefined ? (
          <span className="error">{lastResult.error.message}</span>
        ) : null}
      </footer>
    </div>
  );
}
