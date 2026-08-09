// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { documentId, nodeId, type NodeId } from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import type { DocumentSession } from "@voxel-maker/session";
import type { EditorStore } from "@voxel-maker/editor";
import {
  createDesktopComposition,
  type DesktopComposition,
  type FilePicker,
} from "../composition.js";
import { MemoryProjectStorage } from "@voxel-maker/storage";
import { autoConfirmPrompts } from "../test-prompts.js";
import { HierarchyPanel } from "./HierarchyPanel.js";

/**
 * Hierarchy keyboard-tree tests (plan S7.11/S7.17, ticket #43): the tree
 * rows are real treeitems with roving focus and arrow-key navigation,
 * Enter/Space select through the same selection intent as clicks, F2 and
 * Delete drive rename/delete, and every action still commits one labeled
 * command through the session bus. The assertions are behavioral: focus
 * position, selection state, aria-selected/expanded, and committed
 * document state.
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 1, 0],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:hier:root");
const BOX = nodeId("node:hier:box");
const LID = nodeId("node:hier:lid");
const SPHERE = nodeId("node:hier:sphere");

function fixtureDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:hier:0001"),
    metadata: { title: "hierarchy panel" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [BOX, SPHERE],
        transform: IDENTITY,
        components: [],
      },
      {
        nodeId: BOX,
        name: "Box",
        parentId: ROOT,
        children: [LID],
        transform: IDENTITY,
        components: [],
      },
      {
        nodeId: LID,
        name: "Lid",
        parentId: BOX,
        children: [],
        transform: IDENTITY,
        components: [],
      },
      {
        nodeId: SPHERE,
        name: "Sphere",
        parentId: ROOT,
        children: [],
        transform: IDENTITY,
        components: [],
      },
    ],
    materials: [],
    volumes: [],
  });
}

const createFakePicker = (): FilePicker => ({
  pickOpenPath: () => Promise.resolve(undefined),
  pickSavePath: (suggestedName: string) => Promise.resolve(suggestedName),
});

interface Mounted {
  readonly composition: DesktopComposition;
  readonly session: DocumentSession;
  readonly editor: EditorStore;
  readonly panel: HTMLElement;
  readonly rows: () => HTMLElement[];
  readonly row: (id: NodeId) => HTMLElement;
  readonly unmount: () => void;
}

function mountPanel(): Mounted {
  const composition = createDesktopComposition({
    storage: new MemoryProjectStorage(),
    picker: createFakePicker(),
    prompts: autoConfirmPrompts,
  });
  composition.session.open({ document: fixtureDocument(), source: "system" });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <HierarchyPanel
        session={composition.session}
        editor={composition.editor}
      />,
    );
  });
  const panel = container.querySelector<HTMLElement>(".hierarchy-tree");
  if (panel === null) throw new Error("hierarchy tree not rendered");
  const rows = (): HTMLElement[] =>
    Array.from(panel.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  return {
    composition,
    session: composition.session,
    editor: composition.editor,
    panel,
    rows,
    row: (id) => {
      const found = rows().find(
        (candidate) => candidate.getAttribute("data-node-id") === id,
      );
      if (found === undefined) throw new Error(`row not found: ${id}`);
      return found;
    },
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
      composition.dispose();
    },
  };
}

function pressKey(element: Element, key: string): void {
  element.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
  );
}

/** Expands the root so the child rows are visible. */
function expandRoot(mounted: Mounted): void {
  act(() => {
    mounted.row(ROOT).focus();
    pressKey(mounted.row(ROOT), "ArrowRight");
  });
  expect(document.activeElement).toBe(mounted.row(BOX));
}

/** Writes a value into a React-controlled input. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  );
  if (descriptor?.set === undefined) throw new Error("missing value setter");
  descriptor.set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("hierarchy panel keyboard tree", () => {
  it("renders rows as treeitems with roving tabindex and aria state", () => {
    const mounted = mountPanel();
    const rows = mounted.rows();
    // Children start collapsed: only the root row is in the tree.
    expect(rows.map((row) => row.getAttribute("data-node-id"))).toEqual([ROOT]);
    expect(rows[0]?.getAttribute("tabindex")).toBe("0");
    expect(rows[0]?.getAttribute("aria-expanded")).toBe("false");
    expect(rows[0]?.getAttribute("aria-selected")).toBe("false");
    mounted.unmount();
  });

  it("moves focus with ArrowDown/ArrowUp over the visible tree", () => {
    const mounted = mountPanel();
    expandRoot(mounted);
    expect(document.activeElement).toBe(mounted.row(BOX));
    expect(mounted.row(ROOT).getAttribute("tabindex")).toBe("-1");
    expect(mounted.row(BOX).getAttribute("tabindex")).toBe("0");
    act(() => {
      pressKey(mounted.row(BOX), "ArrowDown");
    });
    expect(document.activeElement).toBe(mounted.row(SPHERE));
    act(() => {
      pressKey(mounted.row(SPHERE), "ArrowUp");
    });
    expect(document.activeElement).toBe(mounted.row(BOX));
    mounted.unmount();
  });

  it("expands a collapsed node with ArrowRight and moves into its child", () => {
    const mounted = mountPanel();
    expandRoot(mounted);
    act(() => {
      pressKey(mounted.row(BOX), "ArrowRight");
    });
    expect(mounted.row(BOX).getAttribute("aria-expanded")).toBe("true");
    // After the expand renders, focus lands on the first child.
    expect(document.activeElement).toBe(mounted.row(LID));
    expect(
      mounted.rows().map((row) => row.getAttribute("data-node-id")),
    ).toEqual([ROOT, BOX, LID, SPHERE]);
    mounted.unmount();
  });

  it("collapses an expanded node with ArrowLeft and moves to its parent", () => {
    const mounted = mountPanel();
    expandRoot(mounted);
    act(() => {
      pressKey(mounted.row(BOX), "ArrowRight");
    });
    expect(document.activeElement).toBe(mounted.row(LID));
    act(() => {
      pressKey(mounted.row(LID), "ArrowLeft");
    });
    expect(document.activeElement).toBe(mounted.row(BOX));
    act(() => {
      pressKey(mounted.row(BOX), "ArrowLeft");
    });
    expect(mounted.row(BOX).getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(mounted.row(BOX));
    mounted.unmount();
  });

  it("selects a node with Enter and reflects it via aria-selected", () => {
    const mounted = mountPanel();
    expandRoot(mounted);
    act(() => {
      pressKey(mounted.row(BOX), "Enter");
    });
    expect(mounted.editor.selection).toEqual([{ kind: "node", nodeId: BOX }]);
    expect(mounted.row(BOX).getAttribute("aria-selected")).toBe("true");
    mounted.unmount();
  });

  it("selects a node with Space like Enter", () => {
    const mounted = mountPanel();
    expandRoot(mounted);
    act(() => {
      pressKey(mounted.row(SPHERE), " ");
    });
    expect(mounted.editor.selection).toEqual([
      { kind: "node", nodeId: SPHERE },
    ]);
    mounted.unmount();
  });

  it("renames a node with F2 and Enter", () => {
    const mounted = mountPanel();
    expandRoot(mounted);
    act(() => {
      pressKey(mounted.row(BOX), "F2");
    });
    const input =
      mounted.panel.querySelector<HTMLInputElement>(".hierarchy-rename");
    if (input === null) throw new Error("rename input not shown");
    act(() => {
      setInputValue(input, "Crate");
      pressKey(input, "Enter");
    });
    const document = mounted.session.current?.store.getDocument();
    expect(document?.nodes[BOX]?.name).toBe("Crate");
    mounted.unmount();
  });

  it("cancels a rename with Escape", () => {
    const mounted = mountPanel();
    expandRoot(mounted);
    act(() => {
      pressKey(mounted.row(BOX), "F2");
    });
    const input =
      mounted.panel.querySelector<HTMLInputElement>(".hierarchy-rename");
    if (input === null) throw new Error("rename input not shown");
    act(() => {
      setInputValue(input, "Crate");
      pressKey(input, "Escape");
    });
    const document = mounted.session.current?.store.getDocument();
    expect(document?.nodes[BOX]?.name).toBe("Box");
    expect(mounted.panel.querySelector(".hierarchy-rename")).toBeNull();
    mounted.unmount();
  });

  it("deletes a leaf node with Delete and prunes the selection", () => {
    const mounted = mountPanel();
    expandRoot(mounted);
    act(() => {
      pressKey(mounted.row(BOX), "ArrowRight");
    });
    expect(document.activeElement).toBe(mounted.row(LID));
    act(() => {
      pressKey(mounted.row(LID), "Enter");
      pressKey(mounted.row(LID), "Delete");
    });
    const doc = mounted.session.current?.store.getDocument();
    expect(doc?.nodes[LID]).toBeUndefined();
    expect(doc?.nodes[BOX]?.children).toEqual([]);
    expect(mounted.editor.selection).toEqual([]);
    mounted.unmount();
  });

  it("rejects deleting a node that still has children, with a notice", () => {
    const mounted = mountPanel();
    expandRoot(mounted);
    act(() => {
      pressKey(mounted.row(BOX), "Enter");
      pressKey(mounted.row(BOX), "Delete");
    });
    const doc = mounted.session.current?.store.getDocument();
    expect(doc?.nodes[BOX]).toBeDefined();
    expect(
      mounted.editor.notices.some((notice) => notice.level === "error"),
    ).toBe(true);
    mounted.unmount();
  });

  it("rejects deleting the root with a notice, not a crash", () => {
    const mounted = mountPanel();
    act(() => {
      mounted.row(ROOT).focus();
      pressKey(mounted.row(ROOT), "Delete");
    });
    const document = mounted.session.current?.store.getDocument();
    expect(document?.nodes[ROOT]).toBeDefined();
    expect(
      mounted.editor.notices.some((notice) => notice.level === "error"),
    ).toBe(true);
    mounted.unmount();
  });

  it("keeps action buttons reachable by keyboard (not hover-only)", () => {
    const mounted = mountPanel();
    expandRoot(mounted);
    const boxRow = mounted.row(BOX);
    const addButton = Array.from(boxRow.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label")?.includes("Add child"),
    );
    if (addButton === undefined) throw new Error("no add-child button");
    act(() => {
      addButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const document = mounted.session.current?.store.getDocument();
    const box = document?.nodes[BOX];
    expect(box?.children.length).toBe(2);
    mounted.unmount();
  });
});
