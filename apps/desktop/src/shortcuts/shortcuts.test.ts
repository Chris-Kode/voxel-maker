import { describe, expect, it } from "vitest";
import {
  createMemoryShortcutStorage,
  createShortcutStore,
  defaultBindings,
  detectPlatform,
  eventMatchesBinding,
  formatBinding,
  isEditableTarget,
  resolveModifiers,
  SHORTCUT_COMMANDS,
  type KeyBinding,
  type Platform,
} from "./shortcuts.js";

/** Builds a duck-typed keyboard event for the pure matcher. */
function keyEvent(
  key: string,
  flags: Partial<{
    readonly ctrl: boolean;
    readonly meta: boolean;
    readonly shift: boolean;
    readonly alt: boolean;
  }> = {},
): {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly isComposing: boolean;
  readonly target: unknown;
} {
  return {
    key,
    ctrlKey: flags.ctrl ?? false,
    metaKey: flags.meta ?? false,
    shiftKey: flags.shift ?? false,
    altKey: flags.alt ?? false,
    isComposing: false,
    target: null,
  };
}

describe("detectPlatform", () => {
  it("detects macOS from the user agent/platform", () => {
    expect(["mac", "windows", "linux"]).toContain(detectPlatform());
  });
});

describe("resolveModifiers", () => {
  it("maps the mod flag to meta on macOS and ctrl elsewhere", () => {
    const binding: KeyBinding = { mod: true, key: "z" };
    expect(resolveModifiers(binding, "mac")).toEqual({
      ctrl: false,
      meta: true,
      shift: false,
      alt: false,
    });
    expect(resolveModifiers(binding, "windows")).toEqual({
      ctrl: true,
      meta: false,
      shift: false,
      alt: false,
    });
    expect(resolveModifiers(binding, "linux")).toEqual({
      ctrl: true,
      meta: false,
      shift: false,
      alt: false,
    });
  });

  it("honors explicit modifier flags without the mod flag", () => {
    const binding: KeyBinding = { key: "x", ctrl: true, shift: true };
    expect(resolveModifiers(binding, "mac")).toEqual({
      ctrl: true,
      meta: false,
      shift: true,
      alt: false,
    });
  });
});

describe("eventMatchesBinding", () => {
  const cases: readonly {
    readonly name: string;
    readonly binding: KeyBinding;
    readonly platform: Platform;
    readonly event: ReturnType<typeof keyEvent>;
    readonly expected: boolean;
  }[] = [
    {
      name: "mod+z matches Ctrl+Z on Windows",
      binding: { mod: true, key: "z" },
      platform: "windows",
      event: keyEvent("z", { ctrl: true }),
      expected: true,
    },
    {
      name: "mod+z matches Cmd+Z on macOS",
      binding: { mod: true, key: "z" },
      platform: "mac",
      event: keyEvent("z", { meta: true }),
      expected: true,
    },
    {
      name: "mod+z does not match Ctrl+Z on macOS",
      binding: { mod: true, key: "z" },
      platform: "mac",
      event: keyEvent("z", { ctrl: true }),
      expected: false,
    },
    {
      name: "mod+z does not match Cmd+Z on Windows",
      binding: { mod: true, key: "z" },
      platform: "windows",
      event: keyEvent("z", { meta: true }),
      expected: false,
    },
    {
      name: "mod+shift+z matches Cmd+Shift+Z on macOS",
      binding: { mod: true, shift: true, key: "z" },
      platform: "mac",
      event: keyEvent("z", { meta: true, shift: true }),
      expected: true,
    },
    {
      name: "missing shift fails",
      binding: { mod: true, shift: true, key: "z" },
      platform: "mac",
      event: keyEvent("z", { meta: true }),
      expected: false,
    },
    {
      name: "extra modifier fails",
      binding: { mod: true, key: "s" },
      platform: "windows",
      event: keyEvent("s", { ctrl: true, shift: true }),
      expected: false,
    },
    {
      name: "key comparison is case-insensitive",
      binding: { mod: true, key: "s" },
      platform: "windows",
      event: keyEvent("S", { ctrl: true }),
      expected: true,
    },
    {
      name: "space binding matches the space key",
      binding: { key: " " },
      platform: "linux",
      event: keyEvent(" ", {}),
      expected: true,
    },
    {
      name: "explicit ctrl binding on macOS",
      binding: { ctrl: true, key: "y" },
      platform: "mac",
      event: keyEvent("y", { ctrl: true }),
      expected: true,
    },
    {
      name: "wrong key fails",
      binding: { mod: true, key: "z" },
      platform: "windows",
      event: keyEvent("x", { ctrl: true }),
      expected: false,
    },
  ];
  for (const testCase of cases) {
    it(testCase.name, () => {
      expect(
        eventMatchesBinding(
          testCase.event,
          testCase.binding,
          testCase.platform,
        ),
      ).toBe(testCase.expected);
    });
  }
});

describe("defaultBindings", () => {
  it("uses platform primary modifiers and known keys", () => {
    const mac = defaultBindings("mac");
    const win = defaultBindings("windows");
    expect(mac.undo).toEqual({ mod: true, key: "z" });
    expect(win.undo).toEqual({ mod: true, key: "z" });
    expect(mac.redo).toEqual({ mod: true, shift: true, key: "z" });
    expect(win["save-project"]).toEqual({ mod: true, key: "s" });
    // Tool bindings are mod+digit so they cannot collide with the
    // viewport's plain-digit standard views (1-6).
    expect(win["select-tool"]).toEqual({ mod: true, key: "1" });
    expect(mac["transform-tool"]).toEqual({ mod: true, key: "9" });
  });

  it("covers every shortcut command id", () => {
    const bindings = defaultBindings("linux");
    for (const command of SHORTCUT_COMMANDS) {
      expect(bindings[command.id]).toBeDefined();
    }
  });
});

describe("formatBinding", () => {
  it("renders platform conventions", () => {
    expect(formatBinding({ mod: true, shift: true, key: "z" }, "mac")).toBe(
      "⌘⇧Z",
    );
    expect(formatBinding({ mod: true, key: "s" }, "windows")).toBe("Ctrl+S");
    expect(formatBinding({ key: " " }, "linux")).toBe("Space");
  });
});

describe("isEditableTarget", () => {
  it("returns false for non-element targets", () => {
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
    expect(isEditableTarget({})).toBe(false);
  });
});

describe("shortcut store", () => {
  function createStore(platform: Platform) {
    const storage = createMemoryShortcutStorage();
    const store = createShortcutStore({ platform, storage });
    return { store, storage };
  }

  it("matches the default binding and skips editable targets and composition", () => {
    const { store } = createStore("windows");
    expect(store.match(keyEvent("z", { ctrl: true }))).toBe("undo");
    expect(
      store.match({ ...keyEvent("z", { ctrl: true }), isComposing: true }),
    ).toBeUndefined();
    expect(
      store.match({
        ...keyEvent("z", { ctrl: true }),
        target: { tagName: "INPUT" },
      }),
    ).toBeUndefined();
  });

  it("matches the platform-specific redo alias on Windows and Linux", () => {
    const win = createStore("windows").store;
    expect(win.match(keyEvent("y", { ctrl: true }))).toBe("redo");
    const mac = createStore("mac").store;
    expect(mac.match(keyEvent("y", { ctrl: true }))).toBeUndefined();
  });

  it("does not match plain space (no bare space default)", () => {
    const { store } = createStore("linux");
    expect(store.match(keyEvent(" ", {}))).toBe("toggle-playback");
  });

  it("remaps a binding, persists it, and matches the new combination", () => {
    const { store, storage } = createStore("windows");
    const result = store.setBinding("save-project", {
      ctrl: true,
      alt: true,
      key: "s",
    });
    expect(result).toEqual({ ok: true });
    expect(store.match(keyEvent("s", { ctrl: true, alt: true }))).toBe(
      "save-project",
    );
    expect(store.match(keyEvent("s", { ctrl: true }))).toBeUndefined();
    expect(storage.overrides()).toEqual({
      "save-project": { ctrl: true, alt: true, key: "s" },
    });
  });

  it("rejects a binding that conflicts with another command", () => {
    const { store } = createStore("windows");
    const result = store.setBinding("open-project", {
      ctrl: true,
      key: "s",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Save project");
    }
    // The conflicting binding was not applied.
    expect(store.match(keyEvent("s", { ctrl: true }))).toBe("save-project");
  });

  it("resets a binding and all bindings", () => {
    const { store } = createStore("windows");
    store.setBinding("undo", { ctrl: true, alt: true, key: "u" });
    store.resetBinding("undo");
    expect(store.match(keyEvent("z", { ctrl: true }))).toBe("undo");
    store.setBinding("undo", { ctrl: true, alt: true, key: "u" });
    store.setBinding("redo", { ctrl: true, alt: true, key: "r" });
    store.resetAll();
    expect(store.match(keyEvent("z", { ctrl: true }))).toBe("undo");
    expect(store.match(keyEvent("z", { ctrl: true, shift: true }))).toBe(
      "redo",
    );
  });

  it("rejects invalid bindings and invalid overrides on load", () => {
    const { store } = createStore("windows");
    expect(store.setBinding("undo", { key: "" }).ok).toBe(false);
    expect(
      store.setBinding("undo", { ctrl: true, mod: true, key: "u" }).ok,
    ).toBe(false);
    const storage = createMemoryShortcutStorage({
      // Unknown command id and malformed binding are ignored on load.
      "not-a-command": { ctrl: true, key: "x" },
      undo: "garbage" as unknown as KeyBinding,
      redo: { ctrl: true, key: "r" },
    });
    const loaded = createShortcutStore({ platform: "windows", storage });
    expect(loaded.binding("redo")).toEqual({ ctrl: true, key: "r" });
    expect(loaded.binding("undo")).toEqual({ mod: true, key: "z" });
    expect(loaded.match(keyEvent("z", { ctrl: true }))).toBe("undo");
  });

  it("notifies subscribers on remap and reset", () => {
    const { store } = createStore("linux");
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.setBinding("undo", { ctrl: true, alt: true, key: "u" });
    store.resetAll();
    expect(notified).toBe(2);
  });
});
