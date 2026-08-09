import { describe, expect, it } from "vitest";
import { nodeId } from "@voxel-maker/shared";
import { createEditorStore, snapshotEditorStore } from "./index.js";

describe("editor runtime store", () => {
  it("starts with an empty select state", () => {
    const store = createEditorStore();
    expect(store.activeTool).toBe("select");
    expect(store.selection).toEqual([]);
    expect(store.notices).toEqual([]);
  });

  it("tracks the active tool, selection mode, and selection copies", () => {
    const store = createEditorStore();
    store.setActiveTool("select");
    expect(store.selectionMode).toBe("node");
    const a = { kind: "node" as const, nodeId: nodeId("node:a") };
    const b = { kind: "node" as const, nodeId: nodeId("node:b") };
    store.setSelection([a, b]);
    expect(store.selection).toEqual([a, b]);
    store.setSelectionMode("voxel");
    expect(store.selectionMode).toBe("voxel");
    // Caller mutations must not leak into the store.
    const snapshot = snapshotEditorStore(store);
    (snapshot.selection as unknown as string[]).push("node:c");
    expect(store.selection).toEqual([a, b]);
    expect(snapshot.selectionMode).toBe("voxel");
    expect(snapshot.regionDraft).toBeUndefined();
  });

  it("collects and dismisses notices", () => {
    const store = createEditorStore();
    store.pushNotice("error", "boom");
    store.pushNotice("info", "ok");
    expect(store.notices).toHaveLength(2);
    const first = store.notices[0];
    if (first === undefined) throw new Error("missing notice");
    store.dismissNotice(first.id);
    expect(store.notices).toHaveLength(1);
    expect(store.notices[0]?.message).toBe("ok");
  });

  it("clears all notices", () => {
    const store = createEditorStore();
    store.pushNotice("error", "boom");
    store.pushNotice("info", "ok");
    store.clearNotices();
    expect(store.notices).toEqual([]);
  });

  it("notifies subscribers and honors unsubscribe", () => {
    const store = createEditorStore();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.setActiveTool("select");
    store.setSelection([]);
    expect(calls).toBe(2);
    unsubscribe();
    store.pushNotice("info", "silent");
    expect(calls).toBe(2);
  });

  it("keeps a throwing subscriber from breaking state changes", () => {
    const store = createEditorStore();
    store.subscribe(() => {
      throw new Error("subscriber failure");
    });
    expect(() => {
      store.setActiveTool("select");
    }).not.toThrow();
    expect(() => {
      store.pushNotice("warning", "still works");
    }).not.toThrow();
  });
});
