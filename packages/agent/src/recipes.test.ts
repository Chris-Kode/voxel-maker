import { describe, expect, it } from "vitest";
import {
  animationContextRecipe,
  composeAgentContextBlock,
  rigContextRecipe,
} from "./recipes.js";
import { FIXTURE_IDS, createInspectionStore } from "./fixtures.js";

/**
 * Agent context recipes (plan S13.1/S13.2, ticket #36 AC): the bounded
 * rig and animation summaries expose hierarchy, pivots, voxel bounds,
 * world transforms, constraints, clips, tracks, and targeted keyframe
 * detail without ever dumping authoritative full document state, and
 * truncate predictably under the response budget.
 */

const { store } = createInspectionStore();

describe("rig context recipe (plan S13.1)", () => {
  it("exposes bounded hierarchy, pivots, bounds, transforms, and constraints", () => {
    const recipe = rigContextRecipe(store);
    expect(recipe.truncated).toBe(false);
    const nodeIds = recipe.nodes.map((node) => node.nodeId);
    expect(nodeIds).toContain(FIXTURE_IDS.root);
    expect(nodeIds).toContain(FIXTURE_IDS.arm);

    const arm = recipe.nodes.find((node) => node.nodeId === FIXTURE_IDS.arm);
    expect(arm).toBeDefined();
    expect(arm?.name).toBe("Arm");
    // The fixture arm carries a pivot, a joint, and one constraint.
    expect(arm?.pivot).toEqual([0, 0.5, 0]);
    expect(arm?.hasJoint).toBe(true);
    expect(arm?.constraints).toEqual([
      {
        componentId: "component:arm:limits",
        type: "rotation-limits",
        limits: { min: [-1, -1, -1], max: [1, 1, 1] },
      },
    ]);
    // World position: arm sits at translation [1, 0, 0] under body.
    expect(arm?.worldPosition[0]).toBe(1);
    // Bounds come from the node's voxel volume descriptor.
    const body = recipe.nodes.find((node) => node.nodeId === FIXTURE_IDS.body);
    expect(body?.bounds).toBeDefined();
    // Hierarchy lists parent/children ids.
    const hierarchyById = new Map(
      recipe.hierarchy.map((entry) => [entry.nodeId, entry]),
    );
    expect(hierarchyById.get(FIXTURE_IDS.root)?.children).toEqual([
      FIXTURE_IDS.body,
      FIXTURE_IDS.decoration,
    ]);
    expect(hierarchyById.get(FIXTURE_IDS.arm)?.parentId).toBe(FIXTURE_IDS.body);
  });

  it("truncates under a lowered node budget", () => {
    const recipe = rigContextRecipe(store, { maxNodes: 2 });
    expect(recipe.nodes.length).toBeLessThanOrEqual(2);
  });
});

describe("animation context recipe (plan S13.2)", () => {
  it("exposes clip, track, and targeted edge-keyframe detail", () => {
    const recipe = animationContextRecipe(store);
    expect(recipe.total).toBe(1);
    expect(recipe.hasMore).toBe(false);
    const clip = recipe.clips[0];
    expect(clip?.animationId).toBe(FIXTURE_IDS.animationWave);
    expect(clip?.loop).toBe("loop");
    const track = clip?.tracks[0];
    expect(track?.targetNodeId).toBe(FIXTURE_IDS.arm);
    expect(track?.interpolation).toBe("smoothstep");
    expect(track?.keyframeCount).toBe(2);
    // Edge detail: first and last keyframe with canonical values.
    expect(track?.edgeKeyframes.map((entry) => entry.time)).toEqual([0, 1]);
    expect(track?.edgeKeyframes[0]?.channel).toBe("rotation");
    expect(track?.edgeKeyframes[0]?.value).toEqual([0, 0, 0, 1]);
  });

  it("pages clips and marks hasMore", () => {
    const page = animationContextRecipe(store, { pageSize: 1, page: 1 });
    expect(page.clips.length).toBe(1);
    expect(page.total).toBe(1);
    expect(page.hasMore).toBe(false);
  });

  it("targeted keyframe detail pages a selected clip's keyframes", () => {
    // The fixture track has exactly 2 keyframes; a targeted request with
    // a larger budget still reports every keyframe (bounded by the cap).
    const targeted = animationContextRecipe(store, {
      animationId: FIXTURE_IDS.animationWave,
      keyframesPerTrack: 8,
    });
    expect(targeted.total).toBe(1);
    const track = targeted.clips[0]?.tracks[0];
    expect(track?.edgeKeyframes.map((entry) => entry.time)).toEqual([0, 1]);
    expect(track?.edgeKeyframes[0]?.value).toEqual([0, 0, 0, 1]);
  });
});

describe("composeAgentContextBlock", () => {
  it("composes a bounded JSON block for the system prompt", () => {
    const block = composeAgentContextBlock(store, {
      rigging: true,
      animation: true,
    });
    expect(block.text).toContain("Rig context");
    expect(block.text).toContain("Animation context");
    expect(block.text).toContain('"constraints"');
    expect(block.text).toContain('"edgeKeyframes"');
    // No voxel dumps: the block must not contain voxel coordinate arrays.
    expect(block.text).not.toContain('"voxels"');
    // The block-level truncated flag reflects recipe truncation, not the
    // mere presence of text.
    expect(block.truncated).toBe(false);
    const tiny = composeAgentContextBlock(store, {
      rigging: true,
      recipe: { maxResponseBytes: 64 },
    });
    expect(tiny.truncated).toBe(true);
  });

  it("returns an empty block when no recipe is requested", () => {
    expect(composeAgentContextBlock(store).text).toBe("");
  });
});
