// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import {
  createMemoryShortcutStorage,
  createShortcutStore,
  type ShortcutId,
  type ShortcutStore,
} from "./shortcuts.js";
import { useShortcuts } from "./use-shortcuts.js";

/**
 * Window-binding tests (plan S7.15, ticket #43): the hook forwards real
 * DOM keydown events to the store and dispatcher, and the store's
 * suppression rules (text entry, IME composition, modal keyboard owners)
 * hold end to end through the DOM.
 */

function dispatchKey(
  key: string,
  options: {
    readonly ctrlKey?: boolean;
    readonly metaKey?: boolean;
    readonly shiftKey?: boolean;
    readonly altKey?: boolean;
    readonly isComposing?: boolean;
    /** Dispatch from this element (bubbles to window with that target). */
    readonly target?: EventTarget | null;
  } = {},
): void {
  const target = options.target ?? window;
  target.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      ctrlKey: options.ctrlKey ?? false,
      metaKey: options.metaKey ?? false,
      shiftKey: options.shiftKey ?? false,
      altKey: options.altKey ?? false,
      isComposing: options.isComposing ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function Host({
  store,
  onDispatch,
}: {
  readonly store: ShortcutStore;
  readonly onDispatch: (id: ShortcutId) => void;
}): React.JSX.Element {
  useShortcuts(store, onDispatch);
  return (
    <div>
      <input aria-label="text field" />
    </div>
  );
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("useShortcuts", () => {
  it("forwards a matched keydown to the dispatcher", () => {
    const store = createShortcutStore({
      platform: "windows",
      storage: createMemoryShortcutStorage(),
    });
    const dispatch = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<Host store={store} onDispatch={dispatch} />);
    });
    act(() => {
      dispatchKey("z", { ctrlKey: true });
    });
    expect(dispatch).toHaveBeenCalledWith("undo");
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("does not fire from a text-entry target", () => {
    const store = createShortcutStore({
      platform: "windows",
      storage: createMemoryShortcutStorage(),
    });
    const dispatch = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<Host store={store} onDispatch={dispatch} />);
    });
    const input = container.querySelector("input");
    if (input === null) throw new Error("no input");
    act(() => {
      dispatchKey("z", { ctrlKey: true, target: input });
    });
    expect(dispatch).not.toHaveBeenCalled();
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("does not fire during IME composition", () => {
    const store = createShortcutStore({
      platform: "windows",
      storage: createMemoryShortcutStorage(),
    });
    const dispatch = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<Host store={store} onDispatch={dispatch} />);
    });
    act(() => {
      dispatchKey("z", { ctrlKey: true, isComposing: true });
    });
    expect(dispatch).not.toHaveBeenCalled();
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("does not fire while a modal dialog or menu owns the keyboard", () => {
    const store = createShortcutStore({
      platform: "windows",
      storage: createMemoryShortcutStorage(),
    });
    const dispatch = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<Host store={store} onDispatch={dispatch} />);
    });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    act(() => {
      dispatchKey("z", { ctrlKey: true });
    });
    expect(dispatch).not.toHaveBeenCalled();
    dialog.remove();
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);
    act(() => {
      dispatchKey("z", { ctrlKey: true });
    });
    expect(dispatch).not.toHaveBeenCalled();
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("honors remaps made through the store without rebinding", () => {
    const store = createShortcutStore({
      platform: "windows",
      storage: createMemoryShortcutStorage(),
    });
    const dispatch = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(<Host store={store} onDispatch={dispatch} />);
    });
    store.setBinding("undo", { ctrl: true, alt: true, key: "u" });
    act(() => {
      dispatchKey("u", { ctrlKey: true, altKey: true });
    });
    expect(dispatch).toHaveBeenCalledWith("undo");
    dispatch.mockClear();
    act(() => {
      dispatchKey("z", { ctrlKey: true });
    });
    expect(dispatch).not.toHaveBeenCalled();
    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
