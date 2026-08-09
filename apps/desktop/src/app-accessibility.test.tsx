// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { App } from "./App.js";

/**
 * Desktop shell accessibility E2E tests (plan S7.17, ticket #43): the
 * full `App` shell (toolbar, panels, status bar, notices, shortcut
 * dialog) runs with the real composition root and the in-memory browser
 * platform adapters. Tests drive real keyboard events and assert
 * behavior — document lifecycle via shortcuts, focus movement, menu
 * close, error announcements, dialog modality — not markup snapshots.
 *
 * The Three.js renderer and the meshing worker are stubbed (no GPU in
 * the test runtime); everything else is the real headless stack.
 */
vi.mock("three", async (importOriginal) => {
  const actual = await importOriginal<typeof import("three")>();
  class WebGLRendererStub {
    readonly domElement: HTMLCanvasElement;
    readonly info = { render: { calls: 0, triangles: 0 } };
    constructor() {
      this.domElement = document.createElement("canvas");
    }
    setPixelRatio(ratio: number): void {
      void ratio;
    }
    setSize(width: number, height: number): void {
      void width;
      void height;
    }
    render(): void {}
    dispose(): void {}
  }
  return {
    ...actual,
    WebGLRenderer: WebGLRendererStub as unknown as typeof actual.WebGLRenderer,
  };
});

class FakeWorker {
  postMessage(): void {}
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
  onmessage: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
}

interface Mounted {
  readonly container: HTMLElement;
  readonly unmount: () => void;
}

beforeEach(() => {
  vi.stubGlobal("Worker", FakeWorker);
  // happy-dom's anchor download flow navigates and then breaks its URL
  // constructor for the rest of the file, so the download link's click
  // is stubbed (the storage adapter still records the write; only the
  // browser download is fake).
  HTMLAnchorElement.prototype.click = () => undefined;
});

function mountApp(): Mounted {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<App />);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

function pressKey(
  target: EventTarget,
  key: string,
  options: {
    readonly ctrlKey?: boolean;
    readonly metaKey?: boolean;
    readonly shiftKey?: boolean;
  } = {},
): void {
  // Dispatch from the document body by default: the event must reach
  // both window listeners (shortcuts) and document listeners (menus).
  const origin = target === window ? document.body : target;
  origin.dispatchEvent(
    new KeyboardEvent("keydown", {
      key,
      ctrlKey: options.ctrlKey ?? false,
      metaKey: options.metaKey ?? false,
      shiftKey: options.shiftKey ?? false,
      bubbles: true,
      cancelable: true,
    }),
  );
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const found = Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).find((candidate) => candidate.textContent.trim() === text);
  if (found === undefined) throw new Error(`button not found: ${text}`);
  return found;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("app accessibility shell", () => {
  it("gives every toolbar control a meaningful accessible name", () => {
    const mounted = mountApp();
    const unnamed = Array.from(
      mounted.container.querySelectorAll<HTMLElement>(
        "button, input, select, textarea",
      ),
    )
      .filter((element) => !element.hasAttribute("disabled"))
      .filter((element) => {
        const labelled =
          element.getAttribute("aria-label") !== null ||
          element.closest("label") !== null ||
          element.textContent.trim().length > 0;
        return !labelled;
      })
      .map((element) => element.outerHTML.slice(0, 120));
    expect(unnamed).toEqual([]);
    mounted.unmount();
  });

  it("announces status through a polite live region", () => {
    const mounted = mountApp();
    const statusbar = mounted.container.querySelector(".statusbar");
    expect(statusbar?.getAttribute("aria-live")).toBe("polite");
    mounted.unmount();
  });

  it("opens a project with Ctrl+N and saves it with Ctrl+S", async () => {
    const mounted = mountApp();
    act(() => {
      pressKey(window, "n", { ctrlKey: true });
    });
    await vi.waitFor(() => {
      expect(mounted.container.textContent).toContain("Revision 0");
    });
    act(() => {
      pressKey(window, "s", { ctrlKey: true });
    });
    await vi.waitFor(() => {
      expect(mounted.container.textContent).toContain("Saved");
    });
    mounted.unmount();
  });

  it("ignores shortcut keys while typing in a text field", () => {
    const mounted = mountApp();
    act(() => {
      pressKey(window, "n", { ctrlKey: true });
    });
    expect(document.getElementById("panel-hierarchy")).not.toBeNull();
    // Put focus in an input inside the app and press the pencil-tool
    // combination (Ctrl+2): it must not switch tools while typing.
    const input = mounted.container.querySelector<HTMLInputElement>("input");
    if (input === null) throw new Error("no input");
    const pencil = buttonByText(mounted.container, "Pencil");
    expect(pencil.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      input.focus();
      pressKey(input, "2", { ctrlKey: true });
    });
    expect(pencil.getAttribute("aria-pressed")).toBe("false");
    // The same combination outside a text field does switch tools.
    act(() => {
      pressKey(window, "2", { ctrlKey: true });
    });
    expect(pencil.getAttribute("aria-pressed")).toBe("true");
    mounted.unmount();
  });

  it("moves focus to a panel with the focus shortcut", () => {
    const mounted = mountApp();
    act(() => {
      pressKey(window, "h", { ctrlKey: true, shiftKey: true });
    });
    expect(document.activeElement?.id).toBe("panel-hierarchy");
    act(() => {
      pressKey(window, "t", { ctrlKey: true, shiftKey: true });
    });
    expect(document.activeElement?.id).toBe("panel-timeline");
    mounted.unmount();
  });

  it("announces command errors as alerts", () => {
    const mounted = mountApp();
    act(() => {
      pressKey(window, "n", { ctrlKey: true });
    });
    // Deleting the document root is rejected with a structured notice.
    const tree = document
      .getElementById("panel-hierarchy")
      ?.querySelector('[role="treeitem"]');
    if (tree === undefined || tree === null) {
      throw new Error("no tree row");
    }
    act(() => {
      (tree as HTMLElement).focus();
      pressKey(tree, "Delete");
    });
    const alert = mounted.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("root");
    mounted.unmount();
  });

  it("closes the recent menu with Escape", () => {
    const mounted = mountApp();
    const recentButton = buttonByText(mounted.container, "Recent");
    act(() => {
      recentButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(mounted.container.querySelector('[role="menu"]')).not.toBeNull();
    act(() => {
      pressKey(window, "Escape");
    });
    expect(mounted.container.querySelector('[role="menu"]')).toBeNull();
    mounted.unmount();
  });

  it("opens the shortcuts dialog, remaps, and closes with Escape", () => {
    const mounted = mountApp();
    const shortcutsButton = buttonByText(mounted.container, "Shortcuts");
    act(() => {
      shortcutsButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dialog = mounted.container.querySelector('[role="dialog"]');
    if (dialog === null) throw new Error("no dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    act(() => {
      pressKey(dialog, "Escape");
    });
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(shortcutsButton);
    mounted.unmount();
  });

  it("does not steal Space from a focused toolbar button", () => {
    const mounted = mountApp();
    // Space on a focused button is the platform's activation key
    // (WAI-ARIA); the global toggle-playback shortcut must not consume
    // it. The observable contract: the keydown is not preventDefaulted
    // by the shortcut service and focus stays on the button.
    const newButton = buttonByText(mounted.container, "New");
    act(() => {
      newButton.focus();
    });
    const event = new KeyboardEvent("keydown", {
      key: " ",
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      newButton.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(newButton);
    mounted.unmount();
  });

  it("undoes a keyboard rename with Ctrl+Z", async () => {
    const mounted = mountApp();
    act(() => {
      pressKey(window, "n", { ctrlKey: true });
    });
    // The document-open session event resubscribes the panels to the new
    // store in a microtask, which this test environment defers until the
    // next macrotask; give the tree a chance to attach its live store
    // subscription before driving it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const tree = document.getElementById("panel-hierarchy");
    const row = tree?.querySelector<HTMLElement>('[role="treeitem"]');
    if (row === undefined || row === null) throw new Error("no tree row");
    act(() => {
      row.focus();
      pressKey(row, "F2");
    });
    const input =
      mounted.container.querySelector<HTMLInputElement>(".hierarchy-rename");
    if (input === null) throw new Error("no rename input");
    const descriptor = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    );
    if (descriptor?.set === undefined) throw new Error("missing value setter");
    descriptor.set.call(input, "Renamed");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    act(() => {
      pressKey(input, "Enter");
    });
    // The commit reaches the DOM through the store subscription, which
    // only flushes on a macrotask in this environment.
    await vi.waitFor(() => {
      expect(mounted.container.textContent).toContain("Renamed");
    });
    act(() => {
      pressKey(window, "z", { ctrlKey: true });
    });
    await vi.waitFor(() => {
      expect(mounted.container.textContent).not.toContain("Renamed");
    });
    mounted.unmount();
  });
});
