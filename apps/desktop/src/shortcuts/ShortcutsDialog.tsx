import { useEffect, useRef, useState } from "react";
import {
  formatBinding,
  type KeyBinding,
  type ShortcutId,
  type ShortcutStore,
} from "./shortcuts.js";

/**
 * Shortcut remapping dialog (plan S7.15, ticket #43): lists every
 * remappable command with its platform-formatted binding, captures a new
 * combination with one keypress (Escape cancels), rejects duplicates
 * through the store, and offers per-command and global reset. The dialog
 * is modal: it owns the keyboard while open (the global shortcut hook
 * suppresses itself for `role="dialog"`), restores focus to the opener on
 * close, and never captures a bare text character while the user types
 * anywhere else.
 */

export interface ShortcutsDialogProps {
  readonly store: ShortcutStore;
  readonly onClose: () => void;
}

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta", "OS"]);

export function ShortcutsDialog({
  store,
  onClose,
}: ShortcutsDialogProps): React.JSX.Element {
  const [capturing, setCapturing] = useState<ShortcutId | undefined>();
  const [captureError, setCaptureError] = useState<string | undefined>();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const headingId = "shortcuts-dialog-title";

  // Initial focus: the dialog itself, so Tab lands on the first control
  // predictably (plan S7.17 visible, predictable focus).
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const commands = store.commands();

  const captureBinding = (
    id: ShortcutId,
    event: React.KeyboardEvent<HTMLInputElement>,
  ): void => {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setCapturing(undefined);
      setCaptureError(undefined);
      return;
    }
    if (MODIFIER_KEYS.has(event.key)) return;
    const binding: KeyBinding = {
      key: event.key.toLowerCase(),
      ctrl: event.ctrlKey,
      meta: event.metaKey,
      shift: event.shiftKey,
      alt: event.altKey,
    };
    const result = store.setBinding(id, binding);
    if (result.ok) {
      setCapturing(undefined);
      setCaptureError(undefined);
    } else {
      setCaptureError(result.message);
    }
  };

  const onDialogKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key === "Escape" && capturing === undefined) {
      event.stopPropagation();
      onClose();
      return;
    }
    // Minimal focus trap: keep Tab inside the dialog while it is open.
    if (event.key === "Tab" && dialogRef.current !== null) {
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button, input, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.hasAttribute("disabled"));
      if (focusable.length === 0) return;
      const first = focusable[0] as HTMLElement;
      const last = focusable[focusable.length - 1] as HTMLElement;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };

  return (
    <div
      className="shortcuts-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className="shortcuts-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        onKeyDown={onDialogKeyDown}
      >
        <header className="shortcuts-header">
          <h2 id={headingId}>Keyboard shortcuts</h2>
          <button
            type="button"
            className="shortcuts-close"
            aria-label="Close keyboard shortcuts"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <p className="shortcuts-hint">
          Choose a command, then press the new key combination. Escape cancels
          the capture. Shortcuts never fire while you type in a text field.
        </p>
        <ul className="shortcuts-list">
          {commands.map((command) => (
            <li
              key={command.id}
              className={capturing === command.id ? "capturing" : undefined}
            >
              <span className="shortcut-label">{command.label}</span>
              {capturing === command.id ? (
                <span className="shortcut-capture">
                  <input
                    type="text"
                    readOnly
                    autoFocus
                    value=""
                    placeholder="Press keys…"
                    aria-label={`New shortcut for ${command.label}`}
                    onKeyDown={(event) => {
                      captureBinding(command.id, event);
                    }}
                  />
                  {captureError !== undefined ? (
                    <span className="shortcut-error" role="alert">
                      {captureError}
                    </span>
                  ) : null}
                </span>
              ) : (
                <kbd className="shortcut-keys">
                  {formatBinding(command.binding, store.platform)}
                </kbd>
              )}
              <span className="shortcut-actions">
                <button
                  type="button"
                  className={capturing === command.id ? "active" : undefined}
                  onClick={() => {
                    setCapturing(
                      capturing === command.id ? undefined : command.id,
                    );
                    setCaptureError(undefined);
                  }}
                >
                  {capturing === command.id ? "Cancel" : "Change"}
                </button>
                <button
                  type="button"
                  disabled={!command.remapped}
                  onClick={() => {
                    store.resetBinding(command.id);
                  }}
                >
                  Reset
                </button>
              </span>
            </li>
          ))}
        </ul>
        <footer className="shortcuts-footer">
          <button
            type="button"
            onClick={() => {
              store.resetAll();
            }}
          >
            Reset all to defaults
          </button>
          <button type="button" className="primary" onClick={onClose}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
