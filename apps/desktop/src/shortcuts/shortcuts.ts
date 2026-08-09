/**
 * Keyboard shortcut service (plan S7.15, ticket #43): platform-aware,
 * remappable command bindings that never capture ordinary text entry and
 * never fire while a modal dialog or menu owns the keyboard. The model is
 * pure (a `ShortcutStore` over injected storage) so Node tests exercise
 * defaults, remapping, conflicts, and suppression without a DOM; the
 * React hook in `use-shortcuts.ts` binds it to the window and the
 * dispatcher in `shortcut-actions.ts` routes matched commands to the
 * composition root.
 *
 * Platform conventions: the primary modifier is Cmd on macOS and Ctrl
 * elsewhere; redo is Cmd+Shift+Z on macOS and Ctrl+Shift+Z *or* Ctrl+Y on
 * Windows/Linux. Tool switching uses Cmd/Ctrl+1..9 so it cannot collide
 * with the viewport's plain-digit standard views (1-6) or with typed
 * digits. Text-entry targets (inputs, textareas, selects, contenteditable)
 * and IME composition are always excluded, and remapping rejects
 * duplicate bindings so no two commands can claim one key.
 */

/** Runtime platform, used to resolve the primary modifier. */
export type Platform = "mac" | "windows" | "linux";

/** Identifiers of every remappable editor command (plan S7.15). */
export type ShortcutId =
  | "new-project"
  | "open-project"
  | "save-project"
  | "save-project-as"
  | "close-project"
  | "export-previews"
  | "undo"
  | "redo"
  | "select-tool"
  | "pencil-tool"
  | "erase-tool"
  | "paint-tool"
  | "eyedropper-tool"
  | "box-tool"
  | "sphere-tool"
  | "cylinder-tool"
  | "transform-tool"
  | "toggle-playback"
  | "focus-hierarchy"
  | "focus-materials"
  | "focus-inspector"
  | "focus-timeline"
  | "focus-ai";

/**
 * One key combination. Either the platform-independent `mod` flag (the
 * primary modifier) or explicit `ctrl`/`meta` flags are used, never both.
 * `key` is the lower-case character or named key ("z", "1", " ",
 * "arrowleft").
 */
export interface KeyBinding {
  readonly key: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  /** Platform primary modifier: Cmd on macOS, Ctrl elsewhere. */
  readonly mod?: boolean;
}

/** A shortcut command with its user-facing label. */
export interface ShortcutCommand {
  readonly id: ShortcutId;
  readonly label: string;
  /** The command is only meaningful while a document is open. */
  readonly needsDocument: boolean;
}

/** Every remappable command, in display order. */
export const SHORTCUT_COMMANDS: readonly ShortcutCommand[] = [
  { id: "new-project", label: "New project", needsDocument: false },
  { id: "open-project", label: "Open project", needsDocument: false },
  { id: "save-project", label: "Save project", needsDocument: true },
  { id: "save-project-as", label: "Save project as", needsDocument: true },
  { id: "close-project", label: "Close project", needsDocument: true },
  {
    id: "export-previews",
    label: "Export preview images",
    needsDocument: true,
  },
  { id: "undo", label: "Undo", needsDocument: true },
  { id: "redo", label: "Redo", needsDocument: true },
  { id: "select-tool", label: "Select tool", needsDocument: false },
  { id: "pencil-tool", label: "Pencil tool", needsDocument: false },
  { id: "erase-tool", label: "Erase tool", needsDocument: false },
  { id: "paint-tool", label: "Paint tool", needsDocument: false },
  { id: "eyedropper-tool", label: "Eyedropper tool", needsDocument: false },
  { id: "box-tool", label: "Box tool", needsDocument: false },
  { id: "sphere-tool", label: "Sphere tool", needsDocument: false },
  { id: "cylinder-tool", label: "Cylinder tool", needsDocument: false },
  { id: "transform-tool", label: "Transform tool", needsDocument: false },
  { id: "toggle-playback", label: "Play / pause", needsDocument: true },
  {
    id: "focus-hierarchy",
    label: "Focus hierarchy panel",
    needsDocument: false,
  },
  {
    id: "focus-materials",
    label: "Focus materials panel",
    needsDocument: false,
  },
  {
    id: "focus-inspector",
    label: "Focus inspector panel",
    needsDocument: false,
  },
  { id: "focus-timeline", label: "Focus timeline panel", needsDocument: false },
  { id: "focus-ai", label: "Focus AI panel", needsDocument: false },
] as const satisfies readonly ShortcutCommand[];

/** Every valid shortcut command id (shared by validation and matching). */
const SHORTCUT_IDS: ReadonlySet<ShortcutId> = new Set(
  SHORTCUT_COMMANDS.map((command) => command.id),
);

/** Detects the runtime platform from the user agent. */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "linux";
  const userAgent = navigator.userAgent;
  // `navigator.platform` is deprecated; the user agent covers the desktop
  // matrix (macOS reports "Macintosh", Windows reports "Windows").
  if (/macintosh|mac os x/i.test(userAgent)) return "mac";
  if (/windows/i.test(userAgent)) return "windows";
  return "linux";
}

/** Resolves a binding's effective modifier flags for one platform. */
export function resolveModifiers(
  binding: KeyBinding,
  platform: Platform,
): {
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
} {
  const mod = binding.mod ?? false;
  return {
    ctrl: binding.ctrl ?? (mod && platform !== "mac"),
    meta: binding.meta ?? (mod && platform === "mac"),
    shift: binding.shift ?? false,
    alt: binding.alt ?? false,
  };
}

/** Duck-typed key event: enough of KeyboardEvent for pure matching. */
export interface ShortcutKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

/** True when the event's modifiers exactly match the binding's. */
export function eventMatchesBinding(
  event: ShortcutKeyEvent,
  binding: KeyBinding,
  platform: Platform,
): boolean {
  if (binding.key.toLowerCase() !== event.key.toLowerCase()) {
    return false;
  }
  const modifiers = resolveModifiers(binding, platform);
  return (
    modifiers.ctrl === event.ctrlKey &&
    modifiers.meta === event.metaKey &&
    modifiers.shift === event.shiftKey &&
    modifiers.alt === event.altKey
  );
}

/** Canonical per-platform identity of a binding (for conflict checks). */
export function bindingKey(binding: KeyBinding, platform: Platform): string {
  const modifiers = resolveModifiers(binding, platform);
  const parts: string[] = [];
  if (modifiers.ctrl) parts.push("ctrl");
  if (modifiers.meta) parts.push("meta");
  if (modifiers.alt) parts.push("alt");
  if (modifiers.shift) parts.push("shift");
  return `${platform}:${parts.join("+")}+${binding.key.toLowerCase()}`;
}

/** Human-readable rendering of a binding for one platform. */
export function formatBinding(binding: KeyBinding, platform: Platform): string {
  const modifiers = resolveModifiers(binding, platform);
  if (platform === "mac") {
    const symbols: string[] = [];
    if (modifiers.meta) symbols.push("⌘");
    if (modifiers.ctrl) symbols.push("⌃");
    if (modifiers.alt) symbols.push("⌥");
    if (modifiers.shift) symbols.push("⇧");
    return `${symbols.join("")}${displayKey(binding.key)}`;
  }
  const names: string[] = [];
  if (modifiers.ctrl) names.push("Ctrl");
  if (modifiers.meta) names.push("Meta");
  if (modifiers.alt) names.push("Alt");
  if (modifiers.shift) names.push("Shift");
  return `${names.join("+")}${names.length > 0 ? "+" : ""}${displayKey(binding.key)}`;
}

function displayKey(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** Default bindings (plan S7.15 "platform conventions"). The defaults
 * themselves are platform-independent (primary modifier resolution
 * happens at match time); only `alternateBindings` varies by platform. */
export function defaultBindings(): Readonly<Record<ShortcutId, KeyBinding>> {
  const mod = { mod: true } as const;
  return {
    "new-project": { ...mod, key: "n" },
    "open-project": { ...mod, key: "o" },
    "save-project": { ...mod, key: "s" },
    "save-project-as": { ...mod, shift: true, key: "s" },
    "close-project": { ...mod, key: "w" },
    "export-previews": { ...mod, key: "e" },
    undo: { ...mod, key: "z" },
    redo: { ...mod, shift: true, key: "z" },
    "select-tool": { ...mod, key: "1" },
    "pencil-tool": { ...mod, key: "2" },
    "erase-tool": { ...mod, key: "3" },
    "paint-tool": { ...mod, key: "4" },
    "eyedropper-tool": { ...mod, key: "5" },
    "box-tool": { ...mod, key: "6" },
    "sphere-tool": { ...mod, key: "7" },
    "cylinder-tool": { ...mod, key: "8" },
    "transform-tool": { ...mod, key: "9" },
    "toggle-playback": { key: " " },
    "focus-hierarchy": { ...mod, shift: true, key: "h" },
    "focus-materials": { ...mod, shift: true, key: "m" },
    "focus-inspector": { ...mod, shift: true, key: "i" },
    "focus-timeline": { ...mod, shift: true, key: "t" },
    "focus-ai": { ...mod, shift: true, key: "a" },
  };
}

/**
 * Extra platform-convention bindings for a command (plan S7.15): redo is
 * Ctrl+Y as well as Ctrl+Shift+Z on Windows/Linux, matching the
 * dominant desktop convention. Aliases never conflict with remaps of the
 * primary binding; remapping replaces the primary only.
 */
export function alternateBindings(
  platform: Platform,
  id: ShortcutId,
): readonly KeyBinding[] {
  if (id === "redo" && platform !== "mac") {
    return [{ mod: true, key: "y" }];
  }
  return [];
}

/** A key event with the suppression fields the store needs. */
export type ShortcutEvent = ShortcutKeyEvent & {
  readonly isComposing?: boolean;
  /** True when an earlier handler already consumed the event. */
  readonly defaultPrevented?: boolean;
  readonly target?: unknown;
};

/** True when the event target is a text-entry control. */
export function isEditableTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const element = target as {
    readonly tagName?: string;
    readonly isContentEditable?: boolean;
  };
  const tag = (element.tagName ?? "").toUpperCase();
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    element.isContentEditable === true
  );
}

/**
 * True when the target is an activatable control whose Space key the
 * platform reserves (WAI-ARIA: Space activates buttons): a button, a
 * role=button element, a link, or a summary. Bare-Space shortcuts must
 * not swallow that activation.
 */
export function isActivatableTarget(target: unknown): boolean {
  if (typeof target !== "object" || target === null) return false;
  const element = target as {
    readonly tagName?: string;
    readonly role?: string | null;
    readonly href?: string | null;
  };
  const tag = (element.tagName ?? "").toUpperCase();
  return (
    tag === "BUTTON" ||
    tag === "SUMMARY" ||
    tag === "A" ||
    element.role === "button"
  );
}

/**
 * True when a modal dialog or menu currently owns the keyboard, so global
 * shortcuts must not fire (predictable focus: the dialog's own key
 * handling wins).
 */
export function isKeyboardOwnerOpen(): boolean {
  if (typeof document === "undefined") return false;
  return (
    document.querySelector('[role="dialog"][aria-modal="true"]') !== null ||
    document.querySelector('[role="menu"]') !== null
  );
}

/** Persistence seam for remapped bindings (overrides only). */
export interface ShortcutStorage {
  load(): Readonly<Record<string, unknown>>;
  save(overrides: Readonly<Record<string, KeyBinding>>): void;
}

/** In-memory storage (tests and non-browser shells). */
export function createMemoryShortcutStorage(
  initial?: Readonly<Record<string, unknown>>,
): ShortcutStorage & {
  readonly overrides: () => Readonly<Record<string, KeyBinding>>;
} {
  let overrides: Readonly<Record<string, KeyBinding>> =
    sanitizeOverrides(initial);
  return {
    load: () => ({ ...overrides }),
    save: (next) => {
      overrides = sanitizeOverrides(next);
    },
    overrides: () => overrides,
  };
}

/** localStorage-backed storage for the browser/Tauri webview shell. */
export function createLocalStorageShortcutStorage(
  key = "voxel-maker.shortcuts.v1",
): ShortcutStorage {
  return {
    load() {
      try {
        const raw = window.localStorage.getItem(key);
        if (raw === null) return {};
        return JSON.parse(raw) as Readonly<Record<string, unknown>>;
      } catch {
        return {};
      }
    },
    save(overrides) {
      try {
        window.localStorage.setItem(key, JSON.stringify(overrides));
      } catch {
        // Storage unavailable (private mode, quota): remaps stay
        // session-only rather than breaking the editor.
      }
    },
  };
}

/** Outcome of a remap attempt. */
export type ShortcutSetResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: string };

export interface ShortcutStoreOptions {
  readonly platform: Platform;
  readonly storage: ShortcutStorage;
}

/**
 * The remappable shortcut registry: defaults per platform, validated
 * overrides, duplicate rejection, and event matching with text-entry and
 * keyboard-owner suppression.
 */
export interface ShortcutStore {
  readonly platform: Platform;
  /** The effective (default or remapped) primary binding of a command. */
  binding(id: ShortcutId): KeyBinding;
  /** Every command with its effective binding for the remap dialog. */
  commands(): readonly {
    readonly id: ShortcutId;
    readonly label: string;
    readonly needsDocument: boolean;
    readonly binding: KeyBinding;
    readonly remapped: boolean;
  }[];
  /** Remaps one command; rejects duplicates and malformed bindings. */
  setBinding(id: ShortcutId, binding: KeyBinding): ShortcutSetResult;
  resetBinding(id: ShortcutId): void;
  resetAll(): void;
  /**
   * Matches a keydown event to a command, or undefined. Never matches
   * during IME composition, from a text-entry target, or while a modal
   * dialog/menu owns the keyboard.
   */
  match(event: ShortcutEvent): ShortcutId | undefined;
  subscribe(listener: () => void): () => void;
}

function sanitizeOverrides(
  raw: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, KeyBinding>> {
  const result: Record<string, KeyBinding> = {};
  if (raw === undefined) return result;
  for (const [id, value] of Object.entries(raw)) {
    if (!SHORTCUT_IDS.has(id as ShortcutId)) continue;
    if (!isValidBinding(value)) continue;
    result[id] = value;
  }
  return result;
}

function isValidBinding(value: unknown): value is KeyBinding {
  if (typeof value !== "object" || value === null) return false;
  const binding = value as KeyBinding;
  if (typeof binding.key !== "string" || binding.key.length === 0) return false;
  if (
    binding.mod === true &&
    (binding.ctrl === true || binding.meta === true)
  ) {
    return false;
  }
  return true;
}

export function createShortcutStore(
  options: ShortcutStoreOptions,
): ShortcutStore {
  const { platform, storage } = options;
  const defaults = defaultBindings();
  let overrides: Readonly<Record<string, KeyBinding>> = sanitizeOverrides(
    storage.load(),
  );
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const effective = (id: ShortcutId): KeyBinding =>
    overrides[id] ?? defaults[id];

  const persist = (): void => {
    storage.save(overrides);
    notify();
  };

  return {
    platform,
    binding: effective,
    commands() {
      return SHORTCUT_COMMANDS.map((command) => ({
        id: command.id,
        label: command.label,
        needsDocument: command.needsDocument,
        binding: effective(command.id),
        remapped: overrides[command.id] !== undefined,
      }));
    },
    setBinding(id, binding) {
      if (!SHORTCUT_IDS.has(id)) {
        return { ok: false, message: "Unknown shortcut command" };
      }
      if (!isValidBinding(binding)) {
        return { ok: false, message: "Press a key combination to assign it" };
      }
      const canonical = bindingKey(binding, platform);
      for (const command of SHORTCUT_COMMANDS) {
        if (command.id === id) continue;
        const candidate = effective(command.id);
        if (bindingKey(candidate, platform) === canonical) {
          return {
            ok: false,
            message: `Already assigned to ${command.label}`,
          };
        }
        for (const alias of alternateBindings(platform, command.id)) {
          if (bindingKey(alias, platform) === canonical) {
            return {
              ok: false,
              message: `Already assigned to ${command.label}`,
            };
          }
        }
      }
      overrides = { ...overrides, [id]: binding };
      persist();
      return { ok: true };
    },
    resetBinding(id) {
      if (overrides[id] === undefined) return;
      const next = { ...overrides };
      const { [id]: _reset, ...rest } = next;
      void _reset;
      overrides = rest;
      persist();
    },
    resetAll() {
      if (Object.keys(overrides).length === 0) return;
      overrides = {};
      persist();
    },
    match(event) {
      if (event.isComposing === true) return undefined;
      // An earlier handler (a focused button's own Space/Enter behavior,
      // a tree row's selection key, the timeline lanes) already consumed
      // the event: a global shortcut must never stack on top of it.
      if (event.defaultPrevented === true) return undefined;
      if (isEditableTarget(event.target)) return undefined;
      // A bare-Space binding must never swallow the Space activation of
      // the focused control (WAI-ARIA: Space activates buttons, links,
      // and summaries), so it is excluded entirely for those targets.
      if (event.key === " " && isActivatableTarget(event.target)) {
        return undefined;
      }
      if (isKeyboardOwnerOpen()) return undefined;
      for (const command of SHORTCUT_COMMANDS) {
        const primary = effective(command.id);
        if (eventMatchesBinding(event, primary, platform)) return command.id;
        for (const alias of alternateBindings(platform, command.id)) {
          if (eventMatchesBinding(event, alias, platform)) return command.id;
        }
      }
      return undefined;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
