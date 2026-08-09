# Keyboard shortcuts and accessibility

Plan S7.15/S7.17, ticket #43. The desktop shell ships a platform-aware,
remappable shortcut service plus the WCAG 2.2 AA interaction baseline
(ADR-0008): complete keyboard traversal, visible predictable focus,
programmatic names, announced status/errors, approved contrast, and
reduced-motion honoring. The shortcut model and the dispatcher are
headless modules (`apps/desktop/src/shortcuts/`); the React shell binds
them to the window and the remap dialog.

## Shortcut service (S7.15)

- **Platform conventions**: the primary modifier is Cmd on macOS and Ctrl
  on Windows/Linux. Redo is Cmd+Shift+Z on macOS and Ctrl+Shift+Z *or*
  Ctrl+Y on Windows/Linux. Tool switching is Cmd/Ctrl+1..9 so it cannot
  collide with the viewport's plain-digit standard views (1-6).
- **Commands**: new/open/save/save-as/close/export, undo/redo, the nine
  edit tools, play/pause, and focus targets for the hierarchy, materials,
  inspector, timeline, and AI panels.
- **Text-entry safety**: shortcuts never fire from inputs, textareas,
  selects, or contenteditable targets, and never during IME composition,
  so ordinary typing cannot trigger an editor command. They also never
  fire while a modal dialog (`role="dialog" aria-modal`) or menu owns the
  keyboard, never stack on an event an earlier handler already consumed
  (`defaultPrevented`), and a bare-Space binding never fires from an
  activatable control (button, link, summary, `role="button"`), so the
  platform's Space-activation key keeps working. The viewport's bare
  keys (1-6, F/P, overlays) ignore modified keys, leaving Ctrl/Cmd
  combinations to the shortcut service.
- **Remapping**: the toolbar "Shortcuts" button opens a modal dialog
  listing every command with its current binding. "Change" captures the
  next key combination (Escape cancels); the store rejects duplicates
  with an announced error, and per-command and global reset restore the
  defaults. Remaps persist in `localStorage`
  (`voxel-maker.shortcuts.v1`).
- **Guards**: commands mirror their toolbar buttons' disabled states — a
  document command with no open document, a save during an in-flight
  save, or undo with an empty history is a silent no-op, never a partial
  action.

## Keyboard navigation (S7.17)

- **Hierarchy tree**: rows are `role="treeitem"` with roving focus.
  ArrowUp/Down move over the visible tree, ArrowRight expands a collapsed
  node (or enters its first child), ArrowLeft collapses (or moves to the
  parent), Home/End jump, Enter/Space select (same selection intent as a
  click), F2 renames, Delete removes with the same validation as the
  button. Per-row action buttons are ordinary tab stops with
  node-specific accessible names, shown on focus (not only hover).
- **Timeline**: the keyframe lanes are a tab stop where Delete removes
  selected keyframes, Key inserts a keyframe for the selected tracks at
  the playhead, ArrowLeft/Right scrub by one snap increment, and Home/End
  jump to the clip start/end. Track rows are a roving-focus list
  (`role="option"`) with Enter/Space selection and ArrowUp/Down movement;
  their interpolation select and remove buttons remain ordinary tab
  stops.
- **Viewport**: the canvas is a keyboard tab stop with a visible focus
  ring; the standard-view/overlay keys (1-6, F, P, G/X/B/K/J) and Escape
  gestures work as before.
- **Dialogs and menus**: the shortcut dialog and the recent menu close
  with Escape; the dialog restores focus to its opener.

## Labels, announcements, contrast, reduced motion

- Every control has an accessible name (visible text, `aria-label`, or a
  wrapping label), including icon-only buttons and the material color
  inputs. The status bar is a polite live region; command errors and
  phase changes render as `role="alert"`/`role="status"` notices.
- The dark theme uses the ADR-0008 palette: text and muted text keep
  >= 4.5:1, control boundaries >= 3:1 (non-text), white-on-accent reads
  4.7:1, and selection states carry a 3:1 accent bar rather than relying
  on a tint.
- Keyboard focus is a 2px `--focus` ring via `:focus-visible`, so mouse
  clicks never leave a ring and keyboard traversal always shows one.
- `prefers-reduced-motion: reduce` disables transitions and animations;
  no UI meaning depends on motion.
- 200% UI scaling: the shell uses flexible stage columns and the dialog
  widths are viewport-relative; formal 200% qualification remains part of
  the S17.7 release review (ADR-0008).

## Verification

Component tests cover the shortcut model (defaults, remapping, conflicts,
suppression), the dispatcher guards, the window binding, the remap
dialog, the hierarchy tree and timeline keyboard workflows, and the full
app shell (labels, live regions, shortcut-driven lifecycle, focus
movement, dialog modality). The CSS baseline is pinned by golden checks
in `app-css.test.ts`; the shell behavior is exercised end to end in
`app-accessibility.test.tsx`.
