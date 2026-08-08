import { canonicalJson } from "@voxel-maker/shared";
import { createTraceDocument } from "@voxel-maker/model";
import { traceVoxel } from "@voxel-maker/voxel";
import { traceCommand } from "@voxel-maker/commands";

export function runHeadlessTrace(): string {
  const document = createTraceDocument();
  const voxel = traceVoxel([-1, 0, 1], 1);
  const command = traceCommand(document, voxel);
  return canonicalJson({
    command: {
      accepted: command.accepted,
      commandId: command.commandId,
      revision: command.revision,
    },
    document: {
      documentId: document.documentId,
      formatVersion: document.formatVersion,
      rootNodeId: document.rootNodeId,
      volumeId: document.volumeId,
    },
    voxel: { chunk: voxel.chunk, local: voxel.local, material: voxel.material },
  });
}
