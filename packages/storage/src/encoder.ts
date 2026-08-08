import { writeVxlProject } from "@voxel-maker/formats";
import type { RevisionSnapshot } from "./snapshot.js";

/**
 * Encodes an immutable revision snapshot into project bytes. Encoding is a
 * pure semantic projection (plan S5.5 `writeVxlProject`); the storage port
 * owns where and how those bytes become durable.
 */
export interface ProjectEncoder {
  encodeProject(snapshot: RevisionSnapshot): Uint8Array | Promise<Uint8Array>;
}

/**
 * The v1 native encoder: a deterministic `.vxl` container whose manifest
 * `semanticHash` equals the captured snapshot hash (ADR-0004). Later tickets
 * add encoders for external formats at the same seam.
 */
export function createVxlProjectEncoder(): ProjectEncoder {
  return {
    encodeProject(snapshot) {
      return writeVxlProject({
        document: snapshot.document,
        volumes: snapshot.volumes,
      });
    },
  };
}
