import { commandId, type CommandId } from "@voxel-maker/shared";
import type { TraceDocument } from "@voxel-maker/model";
import type { TraceVoxel } from "@voxel-maker/voxel";

export interface TraceCommandResult {
  readonly accepted: true;
  readonly commandId: CommandId;
  readonly revision: 1;
}

/** Minimal command-facing seam; persistent command execution starts in issue #6. */
export function traceCommand(
  document: TraceDocument,
  voxel: TraceVoxel,
): TraceCommandResult {
  void document;
  void voxel;
  return {
    accepted: true,
    commandId: commandId("command:trace:0001"),
    revision: 1,
  };
}
