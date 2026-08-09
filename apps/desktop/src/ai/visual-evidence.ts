import {
  buildEvidenceSet,
  type EvidenceCapture,
  type EvidenceCaptureRequest,
  type VisualEvidenceImage,
} from "@voxel-maker/agent";
import { encodePng } from "@voxel-maker/formats";
import {
  renderStandardPreview,
  type PreviewRenderResult,
  type PreviewViewId,
} from "@voxel-maker/renderer";

/**
 * Renderer-backed evidence capture (plan S15.2/S15.3, ticket #40): the
 * desktop composition implements the agent package's `EvidenceCapture`
 * seam with the deterministic software preview renderer (fixed standard
 * views, S15.1) and the dependency-free PNG encoder. Every image is tied
 * to the exact store revision and canonical semantic hash it was
 * rendered from, and capture is pure compute over the read surface — it
 * never mutates semantic state, so evidence can never become
 * authoritative.
 */

/** Renders one standard view to bounded PNG evidence. */
function renderEvidence(
  request: EvidenceCaptureRequest,
  view: PreviewViewId,
): VisualEvidenceImage {
  const width = request.width ?? 512;
  const height = request.height ?? 512;
  const result: PreviewRenderResult = renderStandardPreview({
    store: request.store,
    spec: { view, width, height },
  });
  return {
    view,
    width: result.width,
    height: result.height,
    pngBytes: encodePng(result.rgba, result.width, result.height),
    rgbaBytes: result.rgba,
    revision: result.revision,
    semanticHash: result.semanticHash,
    source: request.source,
    ...(request.sessionId === undefined
      ? {}
      : { sessionId: request.sessionId }),
  };
}

/** Creates the renderer-based evidence capture for the composition root. */
export function createRendererEvidenceCapture(): EvidenceCapture {
  return {
    captureEvidence(request: EvidenceCaptureRequest) {
      const views = request.views ?? ["perspective", "front", "side", "top"];
      const images = views.map((view) =>
        renderEvidence(request, view as PreviewViewId),
      );
      const first = images[0];
      if (first === undefined) {
        throw new Error("Evidence capture requires at least one view");
      }
      return buildEvidenceSet({
        documentId: request.store.getDocument().documentId,
        revision: first.revision,
        semanticHash: first.semanticHash,
        source: request.source,
        ...(request.sessionId === undefined
          ? {}
          : { sessionId: request.sessionId }),
        images,
      });
    },
  };
}
