import {
  documentId,
  nodeId,
  volumeId,
  type DocumentId,
  type NodeId,
  type VolumeId,
} from "@voxel-maker/shared";

/** Minimal versioned read model used only to prove the headless package seam. */
export interface TraceDocument {
  readonly documentId: DocumentId;
  readonly formatVersion: 1;
  readonly rootNodeId: NodeId;
  readonly volumeId: VolumeId;
}

export function createTraceDocument(): TraceDocument {
  return {
    documentId: documentId("document:trace:0001"),
    formatVersion: 1,
    rootNodeId: nodeId("node:trace:root"),
    volumeId: volumeId("volume:trace:0001"),
  };
}
