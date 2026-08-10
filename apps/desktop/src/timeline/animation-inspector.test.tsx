// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { documentId, materialId, nodeId, volumeId } from "@voxel-maker/shared";
import { createDocument, type VoxelDocument } from "@voxel-maker/model";
import {
  createDesktopComposition,
  type DesktopComposition,
  type FilePicker,
} from "../composition.js";
import { MemoryProjectStorage } from "@voxel-maker/storage";
import { autoConfirmPrompts } from "../test-prompts.js";
import { AnimationInspector } from "./AnimationInspector.js";

/**
 * Animation inspector DOM tests (plan S10.13, ticket #29): clip
 * name/duration/loop editing and single-keyframe value editing with
 * validation, all committed through the timeline controller as one
 * labeled transaction.
 */

const IDENTITY = {
  translation: [0, 0, 0],
  pivot: [0, 0, 0],
  rotation: [0, 0, 0, 1],
  scale: [1, 1, 1],
} as const;

const ROOT = nodeId("node:insp:root");
const WHEEL = nodeId("node:insp:wheel");
const MATERIAL = materialId(1);
const VOLUME = volumeId("volume:insp:0001");

function fixtureDocument(): VoxelDocument {
  return createDocument({
    documentId: documentId("document:insp:0001"),
    metadata: { title: "animation inspector" },
    rootNodeId: ROOT,
    nodes: [
      {
        nodeId: ROOT,
        name: "Root",
        parentId: null,
        children: [WHEEL],
        transform: IDENTITY,
        components: [],
      },
      {
        nodeId: WHEEL,
        name: "Wheel",
        parentId: ROOT,
        children: [],
        transform: {
          ...IDENTITY,
          rotation: [0, 0.7071067811865476, 0, 0.7071067811865476],
        },
        components: [{ kind: "voxel", schemaVersion: 1, volumeId: VOLUME }],
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

function mountInspector(): {
  readonly composition: DesktopComposition;
  readonly root: HTMLElement;
  readonly unmount: () => void;
} {
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
      <AnimationInspector
        controller={composition.timeline}
        editor={composition.editor}
      />,
    );
  });
  const section = container.querySelector<HTMLElement>("section");
  if (section === null) throw new Error("inspector not rendered");
  return {
    composition,
    root: section,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
      composition.dispose();
    },
  };
}

/** Sets a controlled input value through the native setter so React's
 * value tracker sees the change (happy-dom quirk). */
function setInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  );
  if (descriptor === undefined || typeof descriptor.set !== "function") {
    throw new Error("no native value setter");
  }
  descriptor.set.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function field(root: HTMLElement, label: string): HTMLInputElement {
  const labels = Array.from(root.querySelectorAll("label.field"));
  const found = labels.find(
    (candidate) =>
      candidate.querySelector("span")?.textContent.trim() === label,
  );
  const input = found?.querySelector<HTMLInputElement>("input");
  if (input === null || input === undefined) {
    throw new Error(`field not found: ${label}`);
  }
  return input;
}

describe("animation inspector", () => {
  it("prompts for a clip selection when none is selected", () => {
    const mounted = mountInspector();
    expect(mounted.root.textContent).toContain("Select a clip in the timeline");
    mounted.unmount();
  });

  it("edits the clip name, duration, and loop through commands", () => {
    const mounted = mountInspector();
    const { composition } = mounted;
    act(() => {
      expect(
        composition.timeline.createClip("spin", 2, "loop"),
      ).toBeUndefined();
    });
    expect(field(mounted.root, "Name").value).toBe("spin");
    const name = field(mounted.root, "Name");
    act(() => {
      setInputValue(name, "wheel-spin");
      name.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(composition.timeline.state.selectedClip?.name).toBe("wheel-spin");
    const duration = field(mounted.root, "Duration (s)");
    act(() => {
      setInputValue(duration, "4");
      duration.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(composition.timeline.state.selectedClip?.duration).toBe(4);
    mounted.unmount();
  });

  it("edits a selected keyframe's rotation value with validation", () => {
    const mounted = mountInspector();
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
      // 90 degrees about Y.
      expect(
        composition.timeline.setKeyframe(trackId, 0.5, {
          channel: "rotation",
          value: [0, 0.7071067811865476, 0, 0.7071067811865476],
        }),
      ).toBeUndefined();
    });
    expect(mounted.root.textContent).toContain("Keyframe at 0.50s");
    const xField = field(mounted.root, "X");
    expect(xField.value).toBe("0");
    const yField = field(mounted.root, "Y");
    expect(yField.value).toBe("90");
    act(() => {
      setInputValue(yField, "180");
      yField.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    const keyframe =
      composition.timeline.state.selectedClip?.tracks[0]?.keyframes[0];
    const value = keyframe?.property.value ?? [];
    expect(value[0]).toBeCloseTo(0, 12);
    expect(value[1]).toBeCloseTo(1, 12);
    expect(value[2]).toBeCloseTo(0, 12);
    expect(value[3]).toBeCloseTo(0, 12);
    // Invalid input surfaces a structured error and changes nothing.
    act(() => {
      setInputValue(yField, "not-a-number");
      yField.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(mounted.root.textContent).toContain("finite number");
    const afterInvalid =
      composition.timeline.state.selectedClip?.tracks[0]?.keyframes[0]?.property
        .value ?? [];
    expect(afterInvalid[1]).toBeCloseTo(1, 12);
    mounted.unmount();
  });

  it("deletes the clip from the inspector", () => {
    const mounted = mountInspector();
    const { composition } = mounted;
    act(() => {
      expect(
        composition.timeline.createClip("spin", 2, "loop"),
      ).toBeUndefined();
    });
    const deleteButton = Array.from(
      mounted.root.querySelectorAll<HTMLButtonElement>("button"),
    ).find((candidate) => candidate.textContent.includes("Delete clip"));
    if (deleteButton === undefined) throw new Error("no delete button");
    act(() => {
      deleteButton.click();
    });
    expect(composition.timeline.state.selectedClipId).toBeUndefined();
    mounted.unmount();
  });
});
