import { useEffect } from "react";
import type { ShortcutId, ShortcutStore } from "./shortcuts.js";

/**
 * Window-level shortcut binding (plan S7.15, ticket #43): one keydown
 * listener that asks the store to match the event (the store already
 * excludes text entry, IME composition, and modal keyboard owners) and
 * forwards matches to the dispatcher. Only one listener exists per app
 * shell, so remapping never requires rebinding.
 */
export function useShortcuts(
  store: ShortcutStore,
  dispatch: (id: ShortcutId) => void,
): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const id = store.match(event);
      if (id === undefined) return;
      event.preventDefault();
      dispatch(id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [store, dispatch]);
}
