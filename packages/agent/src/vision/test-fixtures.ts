import type { DocumentStoreRead } from "@voxel-maker/document";
import type { VolumeId } from "@voxel-maker/shared";
import {
  buildEvidenceSet,
  type EvidenceCapture,
  type EvidenceCaptureRequest,
  type VisualEvidenceSet,
  type VisualEvidenceImage,
} from "./evidence.js";

/**
 * Deterministic evidence-capture fake (ticket #40 tests): renders the
 * standard views as tiny patterned "PNG" buffers whose bytes derive from
 * the store's revision and occupied counts, so changed geometry yields
 * changed evidence bytes (and changed image similarity) without any
 * rasterizer. The pseudo-hash is NOT the canonical semantic hash; it is
 * only a deterministic content probe for loop tests.
 */

/** Deterministic content probe of a store (occupied counts + bounds). */
export function fakeSemanticHash(store: DocumentStoreRead): string {
  let h = 0;
  for (const key of Object.keys(store.getDocument().volumes)) {
    const volume = store.getVolume(key as VolumeId);
    h = (h * 31 + (volume?.occupiedCount() ?? 0)) >>> 0;
    const bounds = volume?.occupiedBounds();
    if (bounds !== undefined) {
      h = (h * 7 + bounds.max[0] + 3 * bounds.max[1] + 5 * bounds.max[2]) >>> 0;
    }
  }
  return `fake-${h.toString(16)}`;
}

/** Builds deterministic patterned bytes sized `width * height * 4`. */
function patternedBytes(
  seed: string,
  width: number,
  height: number,
  view: string,
): Uint8Array {
  const bytes = new Uint8Array(width * height * 4);
  const seedChars = `${seed}:${view}`;
  for (let i = 0; i < bytes.byteLength; i += 1) {
    bytes[i] = (seedChars.charCodeAt(i % seedChars.length) + i) % 256;
  }
  return bytes;
}

/** Fake evidence capture with a deterministic content-probe hash. */
export function createFakeEvidenceCapture(
  options: { readonly width?: number; readonly height?: number } = {},
): EvidenceCapture {
  return {
    captureEvidence(request: EvidenceCaptureRequest): VisualEvidenceSet {
      const width = request.width ?? 8;
      const height = request.height ?? 8;
      const views = request.views ?? [
        "perspective",
        "front",
        "side",
        "top",
      ];
      const hash = fakeSemanticHash(request.store);
      const images: VisualEvidenceImage[] = views.map((view) => {
        const bytes = patternedBytes(hash, width, height, view);
        return {
          view,
          width,
          height,
          pngBytes: bytes,
          rgbaBytes: bytes,
          revision: request.store.revision,
        semanticHash: hash,
          source: request.source,
          ...(request.sessionId === undefined
            ? {}
            : { sessionId: request.sessionId }),
        };
      });
      return buildEvidenceSet({
        documentId: request.store.getDocument().documentId,
        revision: request.store.revision,
        semanticHash: hash,
        source: request.source,
        ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
        images,
      });
    },
  };
}
