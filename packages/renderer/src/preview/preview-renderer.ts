import type { DocumentStoreRead } from "@voxel-maker/document";
import { canonicalAssetSemanticHash } from "@voxel-maker/document";
import type { Vec3 } from "@voxel-maker/math";
import { applyMatrix } from "@voxel-maker/math";
import type { MaterialId, NodeId, VolumeId } from "@voxel-maker/shared";
import type { MaterialRecord } from "@voxel-maker/model";
import type { VoxelVolumeReadView } from "@voxel-maker/voxel";
import type { ChunkSampler } from "../types.js";
import { buildChunkMesh } from "../mesher.js";
import { nodeWorldMatrices, worldContentBounds } from "../pick.js";
import {
  PREVIEW_AMBIENT,
  PREVIEW_BACKGROUND,
  PREVIEW_DIFFUSE,
  PREVIEW_LIGHT_DIRECTION,
  PREVIEW_MISSING_MATERIAL,
  PREVIEW_NEAR,
  frameStandardView,
  validatePreviewSpec,
  type PreviewFraming,
  type PreviewSpec,
} from "./preview-protocol.js";

/**
 * Deterministic software preview renderer (plan S8.5/S15.2, ticket #25):
 * projects the SAME face-culled chunk meshes the viewport shows
 * (`buildChunkMesh`, plan S6.5) through the fixed standard-view cameras
 * (S15.1) into RGBA pixels, with a fixed directional light, fixed
 * background, flat shading, per-face normals recomputed in world space
 * (so node rotation and positive scale render correctly), and
 * painter-sorted alpha blending for transparent materials.
 *
 * The renderer is pure compute over `DocumentStoreRead` — it never
 * mutates semantic state, never touches the command bus, and never reads
 * GPU or DOM state, so exported previews cannot affect document semantics
 * or the canonical hash. Output is deterministic: the same store and spec
 * produce byte-identical pixels on any platform (golden tests lock this).
 *
 * Cancellation is cooperative and safe: the optional `shouldCancel`
 * predicate is polled between chunks and between triangle batches; a
 * cancelled render throws `PreviewCancelledError` and has no side effects.
 */

/** Thrown when a render is cancelled through the `shouldCancel` poll. */
export class PreviewCancelledError extends Error {
  constructor() {
    super("Preview render cancelled");
    this.name = "PreviewCancelledError";
  }
}

/** One projected triangle in world space with its resolved material. */
interface WorldTriangle {
  readonly a: Vec3;
  readonly b: Vec3;
  readonly c: Vec3;
  /** Outward unit normal from the world-space winding (positive scale). */
  readonly normal: Vec3;
  readonly material: {
    readonly color: Vec3;
    readonly opacity: number;
    readonly emissive: number;
  };
  /** Stable gather order (deterministic transparency tie-break). */
  readonly index: number;
}

/** Fully rendered standard preview (S15.2 output + camera metadata). */
export interface PreviewRenderResult {
  readonly spec: PreviewSpec;
  readonly framing: PreviewFraming;
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` straight-alpha RGBA pixels (background opaque). */
  readonly rgba: Uint8Array;
  /** Store revision at render time (previews never advance it). */
  readonly revision: number;
  /** Canonical asset hash at render time (previews never change it). */
  readonly semanticHash: string;
  readonly opaqueTriangles: number;
  readonly transparentTriangles: number;
}

export interface PreviewRenderOptions {
  readonly store: DocumentStoreRead;
  readonly spec: PreviewSpec;
  /** Cooperative cancellation poll; called between chunks/batches. */
  readonly shouldCancel?: () => boolean;
}

/** Material colors are canonical `#rrggbb`; parse to 0..1 sRGB values. */
function parseHexColor(color: string): Vec3 {
  return [
    parseInt(color.slice(1, 3), 16) / 255,
    parseInt(color.slice(3, 5), 16) / 255,
    parseInt(color.slice(5, 7), 16) / 255,
  ];
}

/** Resolves a material id to render constants (missing -> magenta fallback). */
function resolveMaterial(
  documentMaterials: Readonly<Record<MaterialId, MaterialRecord>>,
  materialId: MaterialId,
): WorldTriangle["material"] {
  const record = documentMaterials[materialId];
  if (record === undefined) {
    return { color: PREVIEW_MISSING_MATERIAL, opacity: 1, emissive: 0 };
  }
  return {
    color: parseHexColor(record.color),
    opacity: record.opacity,
    emissive: record.emissive,
  };
}

/** Builds the chunk sampler the mesher needs from the authoritative store. */
function chunkSampler(
  store: DocumentStoreRead,
  volumeId: VolumeId,
  coordinate: readonly [number, number, number],
): ChunkSampler {
  const limits = store.getVolume(volumeId)?.limits;
  return (localX, localY, localZ) => {
    if (limits === undefined) return 0 as MaterialId;
    const worldX = coordinate[0] * 16 + localX;
    const worldY = coordinate[1] * 16 + localY;
    const worldZ = coordinate[2] * 16 + localZ;
    if (
      Math.abs(worldX) > limits.maxCoordinate ||
      Math.abs(worldY) > limits.maxCoordinate ||
      Math.abs(worldZ) > limits.maxCoordinate
    ) {
      return 0 as MaterialId;
    }
    return store.getVoxel(volumeId, [worldX, worldY, worldZ]);
  };
}

/**
 * Gathers every visible triangle of the document: the same face-culled
 * chunk meshes the viewport renders, transformed into world space. Node
 * iteration follows the document's stable order, chunks follow the
 * volume's stable X/Y/Z order, and materials resolve to render constants,
 * so the triangle stream is deterministic.
 */
function gatherTriangles(
  store: DocumentStoreRead,
  shouldCancel: () => boolean,
): WorldTriangle[] {
  const document = store.getDocument();
  const matrices = nodeWorldMatrices(store);
  const triangles: WorldTriangle[] = [];
  let index = 0;
  for (const key of Object.keys(document.nodes)) {
    const nodeId = key as NodeId;
    const node = document.nodes[nodeId];
    const matrix = matrices.get(nodeId);
    if (node === undefined || matrix === undefined) continue;
    for (const component of node.components) {
      if (component.kind !== "voxel") continue;
      const volume = store.getVolume(component.volumeId);
      if (volume === undefined) continue;
      for (const coordinate of volume.chunkCoordinates()) {
        if (shouldCancel()) throw new PreviewCancelledError();
        const values = volume.getChunk(coordinate);
        if (values === undefined) continue;
        const mesh = buildChunkMesh(
          values,
          chunkSampler(store, component.volumeId, coordinate),
        );
        for (const group of mesh.materialGroups) {
          const material = resolveMaterial(
            document.materials,
            group.materialId,
          );
          for (let i = group.start; i < group.start + group.count; i += 3) {
            const ia = mesh.indices[i] as number;
            const ib = mesh.indices[i + 1] as number;
            const ic = mesh.indices[i + 2] as number;
            const a = applyMatrix(matrix, [
              mesh.positions[ia * 3] as number,
              mesh.positions[ia * 3 + 1] as number,
              mesh.positions[ia * 3 + 2] as number,
            ]);
            const b = applyMatrix(matrix, [
              mesh.positions[ib * 3] as number,
              mesh.positions[ib * 3 + 1] as number,
              mesh.positions[ib * 3 + 2] as number,
            ]);
            const c = applyMatrix(matrix, [
              mesh.positions[ic * 3] as number,
              mesh.positions[ic * 3 + 1] as number,
              mesh.positions[ic * 3 + 2] as number,
            ]);
            triangles.push({
              a,
              b,
              c,
              normal: faceNormal(a, b, c),
              material,
              index,
            });
            index += 1;
          }
        }
      }
    }
  }
  return triangles;
}

/** Outward unit normal of a triangle from its world-space winding. */
function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a);
  const ac = sub(c, a);
  const cross: Vec3 = [
    ab[1] * ac[2] - ab[2] * ac[1],
    ab[2] * ac[0] - ab[0] * ac[2],
    ab[0] * ac[1] - ab[1] * ac[0],
  ];
  const length = Math.hypot(cross[0], cross[1], cross[2]);
  if (length === 0) return [0, 0, 0];
  return [cross[0] / length, cross[1] / length, cross[2] / length];
}

/** Camera basis in view space: right, up, and the view direction. */
interface ViewBasis {
  readonly right: Vec3;
  readonly up: Vec3;
  readonly forward: Vec3;
}

function viewBasis(framing: PreviewFraming): ViewBasis {
  // eye != target for every standard view, so forward always exists.
  const forward = normalize(sub(framing.target, framing.eye)) ?? [0, 0, 1];
  // Degenerate case (forward parallel to up): deterministic fallback.
  const right = normalize(cross(forward, framing.up)) ??
    normalize(cross(forward, [1, 0, 0])) ?? [1, 0, 0];
  const up = cross(right, forward);
  return { right, up, forward };
}

/** Transforms a world point into view space (camera looks down -Z). */
function toView(basis: ViewBasis, eye: Vec3, point: Vec3): Vec3 {
  return [
    dot(basis.right, point) - dot(basis.right, eye),
    dot(basis.up, point) - dot(basis.up, eye),
    dot(basis.forward, eye) - dot(basis.forward, point),
  ];
}

interface ProjectedTriangle {
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
  readonly cx: number;
  readonly cy: number;
  /** Z-buffer depth: smaller is nearer (1/-z for perspective, -z for ortho). */
  readonly d0: number;
  readonly d1: number;
  readonly d2: number;
  /** View-space distance for painter sorting: larger = farther. */
  readonly viewDepth: number;
  readonly index: number;
  /** Blends the fixed shaded color over the destination (straight alpha). */
  readonly shade: (
    dstR: number,
    dstG: number,
    dstB: number,
  ) => [number, number, number];
  readonly isTransparent: boolean;
}

/** Projects one world triangle into one or more screen triangles (fan). */
function projectTriangle(
  triangle: WorldTriangle,
  basis: ViewBasis,
  framing: PreviewFraming,
): ProjectedTriangle[] {
  const { eye } = framing;
  const va = toView(basis, eye, triangle.a);
  const vb = toView(basis, eye, triangle.b);
  const vc = toView(basis, eye, triangle.c);
  let polygon: readonly Vec3[] = [va, vb, vc];
  if (framing.projection.kind === "perspective") {
    // Near-plane clip (Sutherland-Hodgman against z <= -near) so triangles
    // crossing the camera plane never produce garbage projections. The
    // result is a convex polygon; fan-triangulate it below.
    polygon = clipNearPlane(polygon);
    if (polygon.length < 3) return [];
  }
  const projected = polygon.map((point) => projectPoint(point, framing));
  const viewDepth = -(va[2] + vb[2] + vc[2]) / 3;
  const isTransparent = triangle.material.opacity < 1;
  const [r, g, b] = shadeColor(triangle);
  const alpha = Math.round(triangle.material.opacity * 255);
  const shade: ProjectedTriangle["shade"] = (dstR, dstG, dstB) =>
    isTransparent
      ? [blend(dstR, r, alpha), blend(dstG, g, alpha), blend(dstB, b, alpha)]
      : [r, g, b];
  const result: ProjectedTriangle[] = [];
  for (let i = 1; i < projected.length - 1; i += 1) {
    const p0 = projected[0] as [number, number, number];
    const p1 = projected[i] as [number, number, number];
    const p2 = projected[i + 1] as [number, number, number];
    result.push({
      ax: p0[0],
      ay: p0[1],
      bx: p1[0],
      by: p1[1],
      cx: p2[0],
      cy: p2[1],
      d0: p0[2],
      d1: p1[2],
      d2: p2[2],
      viewDepth,
      index: triangle.index,
      shade,
      isTransparent,
    });
  }
  return result;
}

/** Fixed shading: ambient + diffuse lambert + emissive, then clamped. */
function shadeColor(triangle: WorldTriangle): [number, number, number] {
  const { color, emissive } = triangle.material;
  const lambert = Math.max(0, dot(triangle.normal, PREVIEW_LIGHT_DIRECTION));
  const light = Math.min(
    1,
    PREVIEW_AMBIENT + PREVIEW_DIFFUSE * lambert + emissive,
  );
  return [
    Math.round(color[0] * light * 255),
    Math.round(color[1] * light * 255),
    Math.round(color[2] * light * 255),
  ];
}

/** Straight-alpha over: `dst = (src*a + dst*(255-a) + 127) >> 8`. */
function blend(dst: number, src: number, alpha: number): number {
  return (src * alpha + dst * (255 - alpha) + 127) >> 8;
}

/** Projects a view-space point to `[screenX, screenY, depth]`. */
function projectPoint(
  point: Vec3,
  framing: PreviewFraming,
): [number, number, number] {
  const { width, height, projection } = framing;
  let ndcX: number;
  let ndcY: number;
  let depth: number;
  if (projection.kind === "perspective") {
    const tanHalf = Math.tan(projection.fovY / 2);
    const aspect = width / height;
    const inverseZ = 1 / -point[2];
    ndcX = (point[0] * inverseZ) / (tanHalf * aspect);
    ndcY = (point[1] * inverseZ) / tanHalf;
    depth = inverseZ;
  } else {
    ndcX = point[0] / projection.halfWidth;
    ndcY = point[1] / projection.halfHeight;
    depth = -point[2];
  }
  return [(ndcX + 1) * 0.5 * width, (1 - ndcY) * 0.5 * height, depth];
}

/**
 * Sutherland-Hodgman clip of a polygon against the near plane
 * (`z <= -near`), used for perspective views only.
 */
function clipNearPlane(points: readonly Vec3[]): Vec3[] {
  const near = -PREVIEW_NEAR;
  const inside = (p: Vec3): boolean => p[2] <= near;
  const output: Vec3[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i] as Vec3;
    const previous = points[(i + points.length - 1) % points.length] as Vec3;
    const currentInside = inside(current);
    const previousInside = inside(previous);
    if (currentInside !== previousInside) {
      const t = (near - previous[2]) / (current[2] - previous[2]);
      output.push([
        previous[0] + t * (current[0] - previous[0]),
        previous[1] + t * (current[1] - previous[1]),
        near,
      ]);
    }
    if (currentInside) output.push(current);
  }
  return output;
}

/** Rasterizes triangles with an edge-function scanline z-buffer. */
function rasterize(
  triangles: readonly ProjectedTriangle[],
  framing: PreviewFraming,
  shouldCancel: () => boolean,
): Uint8Array {
  const { width, height } = framing;
  const rgba = new Uint8Array(width * height * 4);
  const background = PREVIEW_BACKGROUND;
  for (let i = 0; i < width * height; i += 1) {
    const offset = i * 4;
    rgba[offset] = Math.round(background[0] * 255);
    rgba[offset + 1] = Math.round(background[1] * 255);
    rgba[offset + 2] = Math.round(background[2] * 255);
    rgba[offset + 3] = 255;
  }
  const depthBuffer = new Float32Array(width * height).fill(Infinity);

  const draw = (triangle: ProjectedTriangle, writeDepth: boolean): void => {
    const { ax, ay, bx, by, cx, cy, d0, d1, d2 } = triangle;
    const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area === 0) return;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx)));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
    const minY = Math.max(0, Math.floor(Math.min(ay, by, cy)));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
    const positive = area > 0;
    const EPS = 1e-7;
    for (let y = minY; y <= maxY; y += 1) {
      const py = y + 0.5;
      for (let x = minX; x <= maxX; x += 1) {
        const px = x + 0.5;
        const e0 = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
        const e1 = (cx - bx) * (py - by) - (cy - by) * (px - bx);
        const e2 = (ax - cx) * (py - cy) - (ay - cy) * (px - cx);
        const inside = positive
          ? e0 >= -EPS && e1 >= -EPS && e2 >= -EPS
          : e0 <= EPS && e1 <= EPS && e2 <= EPS;
        if (!inside) continue;
        const weight = e0 + e1 + e2;
        if (weight === 0) continue;
        const depth = (e0 * d0 + e1 * d1 + e2 * d2) / weight;
        const index = y * width + x;
        if (depth >= (depthBuffer[index] as number)) continue;
        if (writeDepth) depthBuffer[index] = depth;
        const offset = index * 4;
        const [r, g, b] = triangle.shade(
          rgba[offset] as number,
          rgba[offset + 1] as number,
          rgba[offset + 2] as number,
        );
        rgba[offset] = r;
        rgba[offset + 1] = g;
        rgba[offset + 2] = b;
        rgba[offset + 3] = 255;
      }
    }
  };

  // Opaque pass: z-buffer front-to-back, writes depth.
  let drawn = 0;
  for (const triangle of triangles) {
    if (drawn % 256 === 0 && shouldCancel()) throw new PreviewCancelledError();
    if (triangle.isTransparent) continue;
    draw(triangle, true);
    drawn += 1;
  }
  // Transparent pass: painter-sorted far-to-near, depth-tested, no z-write
  // (opaque surfaces stay authoritative behind translucent ones).
  const transparent = triangles
    .filter((triangle) => triangle.isTransparent)
    .sort((a, b) => b.viewDepth - a.viewDepth || a.index - b.index);
  for (let i = 0; i < transparent.length; i += 1) {
    if (i % 256 === 0 && shouldCancel()) throw new PreviewCancelledError();
    draw(transparent[i] as ProjectedTriangle, false);
  }
  return rgba;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(v: Vec3): Vec3 | undefined {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length === 0) return undefined;
  return [v[0] / length, v[1] / length, v[2] / length];
}

/** Renders one standard preview view of the document (S15.2 service). */
export function renderStandardPreview(
  options: PreviewRenderOptions,
): PreviewRenderResult {
  const { store, spec } = options;
  const shouldCancel = options.shouldCancel ?? ((): boolean => false);
  // Honor cancellation even when there is no geometry to gather (empty
  // documents never reach the per-chunk polls).
  if (shouldCancel()) throw new PreviewCancelledError();
  const validated = validatePreviewSpec(spec);
  const bounds = worldContentBounds(store);
  const framing = frameStandardView(
    validated.view,
    bounds,
    validated.width,
    validated.height,
  );
  const triangles = gatherTriangles(store, shouldCancel);
  const basis = viewBasis(framing);
  const projected: ProjectedTriangle[] = [];
  for (const triangle of triangles) {
    projected.push(...projectTriangle(triangle, basis, framing));
  }
  const rgba = rasterize(projected, framing, shouldCancel);
  const document = store.getDocument();
  const volumes = new Map<VolumeId, VoxelVolumeReadView>();
  for (const key of Object.keys(document.volumes)) {
    const volumeId = key as VolumeId;
    const volume = store.getVolume(volumeId);
    if (volume !== undefined) volumes.set(volumeId, volume);
  }
  return {
    spec: validated,
    framing,
    width: validated.width,
    height: validated.height,
    rgba,
    revision: store.revision,
    semanticHash: canonicalAssetSemanticHash(document, volumes),
    opaqueTriangles: triangles.filter(
      (triangle) => triangle.material.opacity >= 1,
    ).length,
    transparentTriangles: triangles.filter(
      (triangle) => triangle.material.opacity < 1,
    ).length,
  };
}
