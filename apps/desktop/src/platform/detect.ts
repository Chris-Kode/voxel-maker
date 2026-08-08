/**
 * Runtime detection for the desktop shell (plan S6.1): the Tauri webview
 * exposes its IPC bridge as `window.__TAURI_INTERNALS__`; a plain browser
 * build (vite dev without the shell) falls back to the in-memory adapter.
 */
export function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window &&
    window.__TAURI_INTERNALS__ !== undefined
  );
}
