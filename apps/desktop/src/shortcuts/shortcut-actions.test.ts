import { describe, expect, it, vi } from "vitest";
import type { EditorStore } from "@voxel-maker/editor";
import { MemoryProjectStorage } from "@voxel-maker/storage";
import {
  createDesktopComposition,
  type DesktopComposition,
  type FilePicker,
} from "../composition.js";
import { autoConfirmPrompts } from "../test-prompts.js";
import {
  createShortcutDispatcher,
  type FocusPanelId,
} from "./shortcut-actions.js";

/**
 * Shortcut dispatcher tests (plan S7.15, ticket #43): matched commands
 * drive the same composition-root seams as the toolbar buttons, guarded
 * exactly like their disabled states (no document, save in flight, empty
 * history). The dispatcher is the behavior seam between the shortcut
 * registry and the app shell, so these tests run against the real
 * composition with the in-memory storage adapter.
 */

const createFakePicker = (): FilePicker => ({
  pickOpenPath: () => Promise.resolve(undefined),
  pickSavePath: (suggestedName: string) =>
    Promise.resolve({ token: suggestedName, path: suggestedName }),
});

interface Harness {
  readonly composition: DesktopComposition;
  readonly dispatch: (
    id: Parameters<ReturnType<typeof createShortcutDispatcher>>[0],
  ) => void;
  readonly focused: FocusPanelId[];
}

function createHarness(): Harness {
  const composition = createDesktopComposition({
    storage: new MemoryProjectStorage(),
    picker: createFakePicker(),
    prompts: autoConfirmPrompts,
  });
  const focused: FocusPanelId[] = [];
  const dispatch = createShortcutDispatcher({
    composition,
    focusPanel: (panel) => {
      focused.push(panel);
    },
  });
  return { composition, dispatch, focused };
}

describe("shortcut dispatcher", () => {
  it("creates a project with the new-project command", () => {
    const harness = createHarness();
    harness.dispatch("new-project");
    expect(harness.composition.fileService.status.documentId).toBeDefined();
    harness.composition.dispose();
  });

  it("saves the open project with the save command", async () => {
    const harness = createHarness();
    harness.dispatch("new-project");
    harness.dispatch("save-project");
    await vi.waitFor(() => {
      expect(harness.composition.fileService.status.path).toBeDefined();
    });
    harness.composition.dispose();
  });

  it("silently ignores document commands without an open document", () => {
    const harness = createHarness();
    expect(() => {
      harness.dispatch("save-project");
      harness.dispatch("close-project");
      harness.dispatch("export-previews");
      harness.dispatch("undo");
      harness.dispatch("redo");
      harness.dispatch("toggle-playback");
    }).not.toThrow();
    expect(harness.composition.fileService.status.documentId).toBeUndefined();
    harness.composition.dispose();
  });

  it("switches tools and clears a pending transform preview", () => {
    const harness = createHarness();
    harness.dispatch("new-project");
    const editor: EditorStore = harness.composition.editor;
    editor.setActiveTool("transform");
    editor.setTransformPreview({
      operation: "delete",
      entries: [],
      movedVoxels: 0,
      removedVoxels: 0,
      overwrittenVoxels: 0,
    });
    harness.dispatch("pencil-tool");
    expect(editor.activeTool).toBe("pencil");
    expect(editor.transformPreview).toBeUndefined();
    harness.dispatch("transform-tool");
    expect(editor.activeTool).toBe("transform");
    harness.composition.dispose();
  });

  it("undoes and redoes through the history seam", () => {
    const harness = createHarness();
    harness.dispatch("new-project");
    const materialPanel = harness.composition.materialPanel;
    expect(materialPanel.createMaterial()).toBeUndefined();
    expect(materialPanel.state.canUndo).toBe(true);
    harness.dispatch("undo");
    expect(materialPanel.state.canUndo).toBe(false);
    expect(materialPanel.state.canRedo).toBe(true);
    harness.dispatch("redo");
    expect(materialPanel.state.canRedo).toBe(false);
    harness.composition.dispose();
  });

  it("toggles timeline playback", () => {
    const harness = createHarness();
    const timeline = harness.composition.timeline;
    expect(timeline.state.playing).toBe(false);
    harness.dispatch("new-project");
    timeline.createClip("spin", 2, "loop");
    harness.dispatch("toggle-playback");
    expect(timeline.state.playing).toBe(true);
    harness.dispatch("toggle-playback");
    expect(timeline.state.playing).toBe(false);
    harness.composition.dispose();
  });

  it("routes focus commands to the injected focus targets", () => {
    const harness = createHarness();
    harness.dispatch("focus-hierarchy");
    harness.dispatch("focus-timeline");
    harness.dispatch("focus-ai");
    expect(harness.focused).toEqual(["hierarchy", "timeline", "ai"]);
    harness.composition.dispose();
  });
});
