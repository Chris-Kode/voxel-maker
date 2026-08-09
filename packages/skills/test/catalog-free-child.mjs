/**
 * Catalog-free child process for the ticket #38 AC4 boundary proof
 * (plan S14 boundary test). Deliberately imports NONE of the skills
 * package: it opens a saved document, replays its recovery journal,
 * edits, animates, and exports it using only the generic stack
 * (commands/document/model/animation/formats), then prints the
 * recovered document's canonical semantic hash.
 *
 * The file lives outside src/ because the package boundary checker
 * scans source imports; this script is a test-only process, not a
 * package dependency. Its package imports resolve through the
 * test-only devDependencies of @voxel-maker/skills.
 */

import { readFileSync } from "node:fs";
import { createDocumentStore } from "@voxel-maker/document";
import { canonicalAssetSemanticHash } from "@voxel-maker/document";
import {
  CommandBus,
  CommandRegistry,
  DEFAULT_COMMAND_LIMITS,
  addTrackCommand,
  createAnimationCommand,
  fillBoxCommand,
  parseJournalTransaction,
  registerAnimationCommands,
  registerArticulationCommands,
  registerBatchCommands,
  registerMaterialCommands,
  registerNodeCommands,
  registerRegionCommands,
  registerVoxelCommands,
  registerVolumeCommands,
  setKeyframeCommand,
} from "@voxel-maker/commands";
import {
  animationId,
  commandId,
  keyframeId,
  materialId,
  trackId,
  transactionId,
  volumeId,
} from "@voxel-maker/shared";
import { evaluateAnimationRuntime } from "@voxel-maker/animation";
import { readVxlProject, writeVxlProject } from "@voxel-maker/formats";

// File script: argv = [node, script, documentPath, journalPath,
// editVolumeId, editMaterialId]. The edit volume defaults to the
// generator fixture volume (ticket #38); rig/motion boundary runs pass
// the fixture's own volume id (ticket #39).
const [documentPath, journalPath, editVolumeIdArg, editMaterialIdArg] =
  process.argv.slice(2);
const editVolumeId = volumeId(editVolumeIdArg ?? "volume:generator:main");
const editMaterialId = materialId(
  editMaterialIdArg === undefined ? 1 : Number(editMaterialIdArg),
);
const document = JSON.parse(readFileSync(documentPath, "utf8"));
const frames = readFileSync(journalPath, "utf8")
  .trim()
  .split("\n")
  .filter((line) => line.length > 0);

// OPEN: fresh store from the saved document — no skill catalog anywhere.
const { store: openedStore, writeCapability } = createDocumentStore({
  document,
});
const registry = new CommandRegistry();
registerVoxelCommands(registry);
registerBatchCommands(registry);
registerRegionCommands(registry);
registerNodeCommands(registry);
registerMaterialCommands(registry);
registerVolumeCommands(registry);
registerArticulationCommands(registry);
registerAnimationCommands(registry);
const bus = new CommandBus(openedStore, registry, writeCapability);

// RECOVER: replay the journal frames (the provenance-labeled apply).
let expectedRevision = openedStore.revision;
for (const frame of frames) {
  const record = parseJournalTransaction(
    JSON.parse(frame),
    DEFAULT_COMMAND_LIMITS,
  );
  const result = bus.executeTransaction(record.commands, {
    transactionId: record.transactionId,
    expectedRevision: record.expectedRevision,
    source: record.source,
    ...(record.correlationId === undefined
      ? {}
      : { correlationId: record.correlationId }),
    ...(record.label === undefined ? {} : { label: record.label }),
  });
  if (!result.ok) throw new Error("replay failed: " + JSON.stringify(result));
  expectedRevision = result.value.revisionAfter;
}
if (openedStore.revision !== frames.length) {
  throw new Error("unexpected revision after replay");
}

// The recovered document is the exact skill-created state.
const hash = canonicalAssetSemanticHash(
  openedStore.getDocument(),
  volumeReadMap(openedStore),
);
if (JSON.stringify(openedStore.getDocument()).includes("skill")) {
  throw new Error("document must not reference a skill");
}

// EDIT: extend the stairs with one more box via the ordinary bus.
const edit = bus.execute(
  fillBoxCommand(commandId("command:child:edit:0001"), {
    volumeId: editVolumeId,
    region: { min: [0, 3, 0], max: [4, 4, 1] },
    material: editMaterialId,
  }),
  {
    transactionId: transactionId("transaction:child:edit:0001"),
    expectedRevision,
    source: "ui",
  },
);
if (!edit.ok) throw new Error("edit failed: " + JSON.stringify(edit));
expectedRevision = edit.value.revisionAfter;

// ANIMATE: create a clip on the first non-root node and evaluate it.
const nodes = Object.values(openedStore.getDocument().nodes);
const target = nodes.find((node) => node.parentId !== null);
if (target === undefined) throw new Error("no target node");
const clipId = animationId("animation:child:0001");
const trackIdValue = trackId("track:child:0001");
const okCreate = bus.execute(
  createAnimationCommand(commandId("command:child:anim:0001"), {
    animationId: clipId,
    duration: 1,
    loop: "loop",
  }),
  {
    transactionId: transactionId("transaction:child:anim:0001"),
    expectedRevision,
    source: "ui",
  },
);
if (!okCreate.ok) throw new Error("animation create failed");
expectedRevision = okCreate.value.revisionAfter;
const okTrack = bus.execute(
  addTrackCommand(commandId("command:child:track:0001"), {
    animationId: clipId,
    trackId: trackIdValue,
    targetNodeId: target.nodeId,
    interpolation: "linear",
  }),
  {
    transactionId: transactionId("transaction:child:track:0001"),
    expectedRevision,
    source: "ui",
  },
);
if (!okTrack.ok) throw new Error("track add failed");
expectedRevision = okTrack.value.revisionAfter;
const okKey = bus.execute(
  setKeyframeCommand(commandId("command:child:kf:0001"), {
    animationId: clipId,
    trackId: trackIdValue,
    keyframeId: keyframeId("keyframe:child:0001"),
    time: 0,
    property: { channel: "translation", value: [0, 0, 0] },
  }),
  {
    transactionId: transactionId("transaction:child:kf:0001"),
    expectedRevision,
    source: "ui",
  },
);
if (!okKey.ok) throw new Error("keyframe failed");
const clip = openedStore.getDocument().animations[clipId];
if (clip === undefined) throw new Error("clip missing");
const runtime = evaluateAnimationRuntime(openedStore.getDocument(), clip, 0.5);
if (runtime.world.size === 0) throw new Error("animation runtime empty");

// EXPORT: .vxl container round trip through the formats package. The
// exported state is the edited and animated document; the container's
// verified semantic hash must equal the local canonical hash of that
// exact state.
const exportHash = canonicalAssetSemanticHash(
  openedStore.getDocument(),
  volumeReadMap(openedStore),
);
const exported = writeVxlProject({
  document: openedStore.getDocument(),
  volumes: volumeReadMap(openedStore),
});
if (exported.byteLength === 0) throw new Error("empty export");
const loaded = readVxlProject(exported);
if (loaded.semanticHash !== exportHash) {
  throw new Error("export semantic hash mismatch");
}

console.log("OPEN-EDIT-ANIMATE-EXPORT-OK");
console.log("HASH " + hash);

function volumeReadMap(store) {
  const volumes = new Map();
  for (const key of Object.keys(store.getDocument().volumes)) {
    const volume = store.getVolume(key);
    if (volume !== undefined) volumes.set(key, volume);
  }
  return volumes;
}
