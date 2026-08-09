import { evaluateAnimationRuntime } from "@voxel-maker/animation";
import { createConstrainedChestLidDocument, createChestLidClip, createWingFlapDocument, createWingFlapClip } from "@voxel-maker/animation";

const chest = createConstrainedChestLidDocument();
const lid = chest.nodes["node:rig:chest-lid:lid"];
console.log("lid components:", lid.components.map(c => c.kind));
const clip = createChestLidClip();
console.log("clip keyframes:", clip.tracks[0].keyframes);
const state = evaluateAnimationRuntime(chest, clip, 2);
console.log("lid local rot:", state.local.get("node:rig:chest-lid:lid").rotation);
console.log("lid world:", state.world.get("node:rig:chest-lid:lid"));

const wings = createWingFlapDocument();
const right = wings.nodes["node:rig:wings:right"];
console.log("\nright wing components:", right.components.map(c => c.kind));
const wclip = createWingFlapClip();
const wstate = evaluateAnimationRuntime(wings, wclip, 0.5);
console.log("right wing local rot:", wstate.local.get("node:rig:wings:right").rotation);
console.log("right wing world:", wstate.world.get("node:rig:wings:right"));
