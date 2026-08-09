// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import {
  createMemoryShortcutStorage,
  createShortcutStore,
  type ShortcutStore,
} from "./shortcuts.js";
import { ShortcutsDialog } from "./ShortcutsDialog.js";

/**
 * Remap dialog tests (plan S7.15, ticket #43): the dialog lists every
 * command with its binding, captures a new combination from the keyboard,
 * rejects conflicts through the store, resets per-command and globally,
 * and closes with Escape while announcing conflicts as alerts.
 */

function mountDialog(
  store: ShortcutStore,
  onClose = vi.fn(),
): {
  readonly root: ReturnType<typeof createRoot>;
  readonly container: HTMLDivElement;
  readonly onClose: ReturnType<typeof vi.fn>;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ShortcutsDialog store={store} onClose={onClose} />);
  });
  return { root, container, onClose };
}

function keys(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("kbd")).map(
    (element) => element.textContent,
  );
}

function rowFor(container: HTMLElement, label: string): HTMLElement {
  const found = Array.from(
    container.querySelectorAll<HTMLElement>(".shortcut-label"),
  ).find((element) => element.textContent === label);
  if (found === undefined) throw new Error(`row not found: ${label}`);
  return found.closest("li") as HTMLElement;
}

function pressKeys(
  input: HTMLInputElement,
  key: string,
  flags: {
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly alt?: boolean;
  } = {},
): void {
  input.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      ctrlKey: flags.ctrl ?? false,
      metaKey: flags.meta ?? false,
      shiftKey: flags.shift ?? false,
      altKey: flags.alt ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("ShortcutsDialog", () => {
  it("lists every command with its platform-formatted binding", () => {
    const store = createShortcutStore({
      platform: "windows",
      storage: createMemoryShortcutStorage(),
    });
    const mounted = mountDialog(store);
    expect(mounted.container.textContent).toContain("Undo");
    expect(mounted.container.textContent).toContain("Save project");
    expect(keys(mounted.container)).toContain("Ctrl+Z");
    expect(keys(mounted.container)).toContain("Ctrl+Shift+Z");
    expect(keys(mounted.container)).toContain("Ctrl+S");
    act(() => {
      mounted.root.unmount();
    });
    mounted.container.remove();
  });

  it("captures a new binding with one keypress and persists it", () => {
    const store = createShortcutStore({
      platform: "windows",
      storage: createMemoryShortcutStorage(),
    });
    const mounted = mountDialog(store);
    const undoRow = rowFor(mounted.container, "Undo");
    const change = undoRow.querySelector("button");
    if (change === null) throw new Error("no change button");
    act(() => {
      change.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const input = undoRow.querySelector("input");
    if (input === null) throw new Error("no capture input");
    act(() => {
      pressKeys(input, "u", { ctrl: true, alt: true });
    });
    expect(store.binding("undo")).toEqual({
      ctrl: true,
      meta: false,
      shift: false,
      alt: true,
      key: "u",
    });
    expect(undoRow.querySelector("kbd")?.textContent).toBe("Ctrl+Alt+U");
    act(() => {
      mounted.root.unmount();
    });
    mounted.container.remove();
  });

  it("reports a conflicting capture and keeps capturing", () => {
    const store = createShortcutStore({
      platform: "windows",
      storage: createMemoryShortcutStorage(),
    });
    const mounted = mountDialog(store);
    const redoRow = rowFor(mounted.container, "Redo");
    act(() => {
      (redoRow.querySelector("button") as HTMLButtonElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    const input = redoRow.querySelector("input");
    if (input === null) throw new Error("no capture input");
    act(() => {
      // Ctrl+S is taken by Save project.
      pressKeys(input, "s", { ctrl: true });
    });
    const alert = redoRow.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Save project");
    expect(input).not.toBeNull();
    expect(store.binding("redo")).toEqual({ mod: true, shift: true, key: "z" });
    act(() => {
      mounted.root.unmount();
    });
    mounted.container.remove();
  });

  it("cancels a capture with Escape", () => {
    const store = createShortcutStore({
      platform: "windows",
      storage: createMemoryShortcutStorage(),
    });
    const mounted = mountDialog(store);
    const undoRow = rowFor(mounted.container, "Undo");
    act(() => {
      (undoRow.querySelector("button") as HTMLButtonElement).dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });
    const input = undoRow.querySelector("input");
    if (input === null) throw new Error("no capture input");
    act(() => {
      pressKeys(input, "Escape");
    });
    expect(undoRow.querySelector("input")).toBeNull();
    expect(store.binding("undo")).toEqual({ mod: true, key: "z" });
    act(() => {
      mounted.root.unmount();
    });
    mounted.container.remove();
  });

  it("resets one binding and all bindings", () => {
    const store = createShortcutStore({
      platform: "windows",
      storage: createMemoryShortcutStorage(),
    });
    store.setBinding("undo", { ctrl: true, alt: true, key: "u" });
    store.setBinding("redo", { ctrl: true, alt: true, key: "r" });
    const mounted = mountDialog(store);
    const undoRow = rowFor(mounted.container, "Undo");
    const reset = Array.from(undoRow.querySelectorAll("button")).find(
      (button) => button.textContent === "Reset",
    );
    if (reset === undefined) throw new Error("no reset button");
    act(() => {
      reset.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(store.binding("undo")).toEqual({ mod: true, key: "z" });
    expect(store.binding("redo")).not.toEqual({ mod: true, key: "z" });
    const resetAll = Array.from(
      mounted.container.querySelectorAll("button"),
    ).find((button) => button.textContent === "Reset all to defaults");
    if (resetAll === undefined) throw new Error("no reset-all button");
    act(() => {
      resetAll.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(store.binding("redo")).toEqual({ mod: true, shift: true, key: "z" });
    act(() => {
      mounted.root.unmount();
    });
    mounted.container.remove();
  });

  it("closes on Escape and calls the close handler", () => {
    const store = createShortcutStore({
      platform: "linux",
      storage: createMemoryShortcutStorage(),
    });
    const mounted = mountDialog(store);
    const dialog = mounted.container.querySelector('[role="dialog"]');
    if (dialog === null) throw new Error("no dialog");
    act(() => {
      dialog.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(mounted.onClose).toHaveBeenCalled();
    act(() => {
      mounted.root.unmount();
    });
    mounted.container.remove();
  });
});
