// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { documentId, materialId, nodeId, volumeId } from "@voxel-maker/shared";
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
import { TimelinePanel } from "./TimelinePanel.js";

/**
 * Timeline panel DOM-binding tests (plan S10.9-S10.11, ticket #29): the
 * React timeline renders the real controller and commits real commands
 * through the session bus. Pointer and keyboard gestures are dispatched
 * through the DOM, so the panel's drag/scrub/selection routing is
 * exercised end to end: keyframe create (double-click and Key), move
 * (drag), multi-select, delete (keyboard), interpolation, transport,
 * zoom, and the auto-key mode toggle.
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:panel:root");
const WHEEL = nodeId("node:panel:wheel");
const ARM = nodeId("node:panel:arm");
const MATERIAL = materialId(1);
const VOLUME = volumeId("volume:panel:0001");

function fixtureDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:panel:0001"),
    metadata: { title: "timeline panel" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [WHEEL, ARM],
        transform: IDENTITY,
        components: [],
      },
      {
        nodeId: WHEEL,
        name: "Wheel",
        parentId: ROOT,
        children: [],
        transform: { ...IDENTITY, translation: [1, 0, 0] },
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
      },
      {
        nodeId: ARM,
        name: "Arm",
        parentId: ROOT,
        children: [],
        transform: IDENTITY,
        components: [],
      },
    ],
    materials: [
      {
        materialId: MATERIAL,
        name: "red",
        color: "#ff0000",
        opacity: 1,
        roughness: 0.5,
        metallic: 0,
        emissive: 0,
      },
    ],
    volumes: [
      { volumeId: VOLUME, bounds: { min: [-4, -4, -4], max: [4, 4, 4] } },
    ],
  });
}

const createFakePicker = (): FilePicker => ({
  pickOpenPath: () => Promise.resolve(undefined),
  pickSavePath: (suggestedName: string) =>
    Promise.resolve({ token: suggestedName, path: suggestedName }),
});

interface Mounted {
  readonly composition: DesktopComposition;
  readonly session: DocumentSession;
  readonly editor: EditorStore;
  readonly panel: HTMLElement;
  readonly unmount: () => void;
}

function mountPanel(withDocument: boolean): Mounted {
  const composition = createDesktopComposition({
    storage: new MemoryProjectStorage(),
    picker: createFakePicker(),
    prompts: autoConfirmPrompts,
  });
  if (withDocument) {
    composition.session.open({ document: fixtureDocument(), source: "system" });
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <TimelinePanel
        controller={composition.timeline}
        editor={composition.editor}
      />,
    );
  });
  const panel = container.querySelector<HTMLElement>(".timeline-panel");
  if (panel === null) throw new Error("timeline panel not rendered");
  return {
    composition,
    session: composition.session,
    editor: composition.editor,
    panel,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
      composition.dispose();
    },
  };
}

function button(panel: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(
    panel.querySelectorAll<HTMLButtonElement>("button"),
  ).find(
    (candidate) =>
      candidate.textContent.trim() === label ||
      candidate.getAttribute("aria-label") === label,
  );
  if (found === undefined) throw new Error(`button not found: ${label}`);
  return found;
}

function select(panel: HTMLElement, ariaLabel: string): HTMLSelectElement {
  const found = Array.from(
    panel.querySelectorAll<HTMLSelectElement>("select"),
  ).find(
    (candidate) =>
      candidate.getAttribute("aria-label") === ariaLabel ||
      candidate.closest("label")?.textContent.includes(ariaLabel) === true,
  );
  if (found === undefined) throw new Error(`select not found: ${ariaLabel}`);
  return found;
}

function dispatchPointer(
  element: Element,
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  options: { readonly shiftKey?: boolean } = {},
): void {
  element.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX,
      clientY: 0,
      shiftKey: options.shiftKey ?? false,
    }),
  );
}

function keyframesOf(composition: DesktopComposition): readonly {
  readonly trackId: string;
  readonly keyframeId: string;
  readonly time: number;
}[] {
  const document = composition.session.current?.store.getDocument();
  const clip =
    document?.animations[
      composition.timeline.state.selectedClipId ?? ("none" as never)
    ];
  if (clip === undefined) return [];
  return clip.tracks.flatMap((track) =>
    track.keyframes.map((keyframe) => ({
      trackId: track.trackId,
      keyframeId: keyframe.keyframeId,
      time: keyframe.time,
    })),
  );
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("timeline panel", () => {
  it("shows the empty state without a document", () => {
    const mounted = mountPanel(false);
    expect(mounted.panel.textContent).toContain("Open a document");
    mounted.unmount();
  });

  it("lists clips and tracks and selects via the picker", () => {
    const mounted = mountPanel(true);
    const { composition } = mounted;
    act(() => {
      expect(
        composition.timeline.createClip("spin", 2, "loop"),
      ).toBeUndefined();
      expect(
        composition.timeline.addTracks([WHEEL, ARM], "rotation"),
      ).toBeUndefined();
    });
    expect(mounted.panel.textContent).toContain("spin");
    expect(mounted.panel.textContent).toContain("Wheel");
    expect(mounted.panel.textContent).toContain("Arm");
    mounted.unmount();
  });

  it("creates a keyframe with the Key button at the playhead", () => {
    const mounted = mountPanel(true);
    const { composition } = mounted;
    act(() => {
      expect(
        composition.timeline.createClip("spin", 2, "loop"),
      ).toBeUndefined();
      expect(
        composition.timeline.addTracks([WHEEL], "translation"),
      ).toBeUndefined();
      composition.timeline.scrub(0.5);
    });
    act(() => {
      button(mounted.panel, "Key").click();
    });
    const keys = keyframesOf(composition);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.time).toBe(0.5);
    mounted.unmount();
  });

  it("creates a keyframe by double-clicking a lane", () => {
    const mounted = mountPanel(true);
    const { composition } = mounted;
    act(() => {
      expect(
        composition.timeline.createClip("spin", 2, "loop"),
      ).toBeUndefined();
      expect(
        composition.timeline.addTracks([WHEEL], "rotation"),
      ).toBeUndefined();
    });
    const row = mounted.panel.querySelector<HTMLElement>(".timeline-row");
    if (row === null) throw new Error("no lane row");
    act(() => {
      row.dispatchEvent(
        new MouseEvent("dblclick", {
          bubbles: true,
          clientX: 150, // 1.5s at the default 100 px/s zoom
          clientY: 0,
        }),
      );
    });
    const keys = keyframesOf(composition);
    expect(keys).toHaveLength(1);
    expect(keys[0]?.time).toBe(1.5);
    mounted.unmount();
  });

  it("drags a keyframe to move it and commits one transaction", () => {
    const mounted = mountPanel(true);
    const { composition } = mounted;
    act(() => {
      expect(
        composition.timeline.createClip("spin", 2, "loop"),
      ).toBeUndefined();
      expect(
        composition.timeline.addTracks([WHEEL], "rotation"),
      ).toBeUndefined();
      const trackId = composition.timeline.state.tracks[0]?.track.trackId;
      if (trackId === undefined) throw new Error("missing track");
      expect(
        composition.timeline.setKeyframe(trackId, 1, {
          channel: "rotation",
          value: [0, 0, 0, 1],
        }),
      ).toBeUndefined();
    });
    const keyframe =
      mounted.panel.querySelector<HTMLButtonElement>(".timeline-keyframe");
    if (keyframe === null) throw new Error("no keyframe rendered");
    act(() => {
      dispatchPointer(keyframe, "pointerdown", 100); // 1.0s
      dispatchPointer(keyframe, "pointermove", 200); // +1.0s
      dispatchPointer(keyframe, "pointerup", 200);
    });
    const keys = keyframesOf(composition);
    expect(keys[0]?.time).toBe(2);
    mounted.unmount();
  });

  it("multi-selects keyframes with shift and deletes them with Delete", () => {
    const mounted = mountPanel(true);
    const { composition } = mounted;
    act(() => {
      expect(
        composition.timeline.createClip("spin", 2, "loop"),
      ).toBeUndefined();
      expect(
        composition.timeline.addTracks([WHEEL], "rotation"),
      ).toBeUndefined();
      const trackId = composition.timeline.state.tracks[0]?.track.trackId;
      if (trackId === undefined) throw new Error("missing track");
      expect(
        composition.timeline.setKeyframe(trackId, 0.5, {
          channel: "rotation",
          value: [0, 0, 0, 1],
        }),
      ).toBeUndefined();
      expect(
        composition.timeline.setKeyframe(trackId, 1.5, {
          channel: "rotation",
          value: [0, 0, 0, 1],
        }),
      ).toBeUndefined();
    });
    const keyframes =
      mounted.panel.querySelectorAll<HTMLButtonElement>(".timeline-keyframe");
    expect(keyframes).toHaveLength(2);
    act(() => {
      dispatchPointer(keyframes[0] as HTMLButtonElement, "pointerdown", 50);
      dispatchPointer(keyframes[0] as HTMLButtonElement, "pointerup", 50);
      dispatchPointer(keyframes[1] as HTMLButtonElement, "pointerdown", 150, {
        shiftKey: true,
      });
      dispatchPointer(keyframes[1] as HTMLButtonElement, "pointerup", 150);
    });
    expect(composition.timeline.state.selectedKeyframeIds).toHaveLength(2);
    const lanes = mounted.panel.querySelector<HTMLElement>(".timeline-lanes");
    if (lanes === null) throw new Error("no lanes");
    act(() => {
      lanes.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
      );
    });
    expect(keyframesOf(composition)).toHaveLength(0);
    mounted.unmount();
  });

  it("inserts a keyframe at the playhead with Key and scrubs with arrows", () => {
    const mounted = mountPanel(true);
    const { composition } = mounted;
    act(() => {
      expect(
        composition.timeline.createClip("spin", 2, "loop"),
      ).toBeUndefined();
      expect(
        composition.timeline.addTracks([WHEEL], "rotation"),
      ).toBeUndefined();
    });
    const lanes = mounted.panel.querySelector<HTMLElement>(".timeline-lanes");
    if (lanes === null) throw new Error("no lanes");
    const trackId = composition.timeline.state.tracks[0]?.track.trackId;
    if (trackId === undefined) throw new Error("missing track");
    act(() => {
      composition.timeline.selectTracks([trackId]);
      lanes.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Key", bubbles: true }),
      );
    });
    expect(keyframesOf(composition)).toHaveLength(1);
    expect(keyframesOf(composition)[0]?.time).toBe(0);
    act(() => {
      lanes.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(composition.timeline.state.playhead).toBeCloseTo(0.1);
    act(() => {
      lanes.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    });
    expect(composition.timeline.state.playhead).toBeCloseTo(0);
    mounted.unmount();
  });

  it("jumps the playhead with Home and End", () => {
    const mounted = mountPanel(true);
    const { composition } = mounted;
    act(() => {
      expect(
        composition.timeline.createClip("spin", 2, "loop"),
      ).toBeUndefined();
      composition.timeline.scrub(1.2);
    });
    const lanes = mounted.panel.querySelector<HTMLElement>(".timeline-lanes");
    if (lanes === null) throw new Error("no lanes");
    act(() => {
      lanes.dispatchEvent(
        new KeyboardEvent("keydown", { key: "End", bubbles: true }),
      );
    });
    expect(composition.timeline.state.playhead).toBeCloseTo(2);
    act(() => {
      lanes.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Home", bubbles: true }),
      );
    });
    expect(composition.timeline.state.playhead).toBeCloseTo(0);
    mounted.unmount();
  });

  it("selects tracks from the keyboard and moves focus with arrows", () => {
    const mounted = mountPanel(true);
    const { composition } = mounted;
    act(() => {
      expect(
        composition.timeline.createClip("spin", 2, "loop"),
      ).toBeUndefined();
      expect(
        composition.timeline.addTracks([WHEEL, ARM], "rotation"),
      ).toBeUndefined();
    });
    const rows = mounted.panel.querySelectorAll<HTMLElement>(
      '[role="option"].timeline-track',
    );
    expect(rows).toHaveLength(2);
    // Adding tracks selects them; clear first so Enter demonstrates the
    // keyboard selection path.
    act(() => {
      composition.timeline.selectTracks([]);
    });
    expect(rows[0]?.getAttribute("aria-selected")).toBe("false");
    act(() => {
      rows[0]?.focus();
      rows[0]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(composition.timeline.state.selectedTrackIds).toEqual([
      composition.timeline.state.tracks[0]?.track.trackId,
    ]);
    expect(rows[0]?.getAttribute("aria-selected")).toBe("true");
    act(() => {
      rows[0]?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(rows[1]);
    mounted.unmount();
  });

  it("removes a track through its row button", () => {
    const mounted = mountPanel(true);
    const { composition } = mounted;
    act(() => {
      expect(
        composition.timeline.createClip("spin", 2, "loop"),
      ).toBeUndefined();
      expect(
        composition.timeline.addTracks([WHEEL, ARM], "rotation"),
      ).toBeUndefined();
    });
    expect(composition.timeline.state.tracks).toHaveLength(2);
    const remove = mounted.panel.querySelector<HTMLButtonElement>(
      'button[aria-label="Remove track for Wheel"]',
    );
    if (remove === null) throw new Error("no remove-track button");
    act(() => {
      remove.click();
    });
    expect(composition.timeline.state.tracks).toHaveLength(1);
    expect(composition.timeline.state.tracks[0]?.nodeName).toBe("Arm");
    mounted.unmount();
  });

  it("toggles auto-key mode with a clear pressed indication", () => {
    const mounted = mountPanel(true);
    const { composition } = mounted;
    act(() => {
      expect(
        composition.timeline.createClip("spin", 2, "loop"),
      ).toBeUndefined();
    });
    const toggle = button(mounted.panel, "Auto-key");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(composition.timeline.state.keyMode).toBe("manual");
    act(() => {
      toggle.click();
    });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(composition.timeline.state.keyMode).toBe("auto");
    mounted.unmount();
  });

  it("commits interpolation changes and adjusts zoom", () => {
    const mounted = mountPanel(true);
    const { composition } = mounted;
    act(() => {
      expect(
        composition.timeline.createClip("spin", 2, "loop"),
      ).toBeUndefined();
      expect(
        composition.timeline.addTracks([WHEEL], "rotation"),
      ).toBeUndefined();
    });
    const interpolation = select(mounted.panel, "Interpolation of Wheel");
    act(() => {
      interpolation.value = "smoothstep";
      interpolation.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(
      composition.timeline.state.selectedClip?.tracks[0]?.interpolation,
    ).toBe("smoothstep");
    const before = composition.timeline.state.zoom;
    act(() => {
      button(mounted.panel, "Zoom in").click();
    });
    expect(composition.timeline.state.zoom).toBeGreaterThan(before);
    mounted.unmount();
  });

  it("scrubs by dragging the ruler", () => {
    const mounted = mountPanel(true);
    const { composition } = mounted;
    act(() => {
      expect(
        composition.timeline.createClip("spin", 2, "loop"),
      ).toBeUndefined();
    });
    const ruler = mounted.panel.querySelector<HTMLElement>(".timeline-ruler");
    if (ruler === null) throw new Error("no ruler");
    act(() => {
      dispatchPointer(ruler, "pointerdown", 120);
      dispatchPointer(ruler, "pointermove", 170);
      dispatchPointer(ruler, "pointerup", 170);
    });
    expect(composition.timeline.playhead).toBe(1.7);
    mounted.unmount();
  });
});
