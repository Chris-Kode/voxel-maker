import { WorkspaceError, type MaterialId } from "@voxel-maker/shared";
import type { IntAabb, Vec3i } from "@voxel-maker/math";
import {
  fillBoxCommand,
  fillCylinderCommand,
  fillSphereCommand,
} from "@voxel-maker/commands";
import {
  boxCoordinates,
  cylinderCoordinates,
  sphereCoordinates,
  type ShapeAxis,
  type VoxelVolumeLimits,
} from "@voxel-maker/voxel";
import type { EditorStore } from "./runtime.js";
import {
  missingActiveMaterial,
  noActiveMaterial,
  sessionNotOpen,
  tooManyOccupiedError,
} from "./tool-errors.js";
import type { ToolActionResult, ToolDraft, ToolHost } from "./types.js";
import { spanRegion } from "./selection.js";

/**
 * Box, sphere, and cylinder tools (plan S7.7/S7.19, ticket #18).
 *
 * A shape gesture is: pointer down (pick the anchor voxel and pin its
 * volume), pointer moves (the shape is derived deterministically from the
 * anchor and the current voxel), pointer up (construct exactly one
 * registered fill command and commit it as one labeled, atomic, undoable
 * transaction). Pointer cancel or an explicit reset discards the preview
 * and commits nothing.
 *
 * Shape derivation (frozen, documented in docs/editor/selection-and-shape-
 * tools-v1.md):
 *
 * - Box: the half-open region spanning both voxels inclusively.
 * - Sphere: integer center at the anchor and integer radius equal to the
 *   Chebyshev distance (the largest axis delta) to the current voxel.
 * - Cylinder: axis-aligned along the dominant drag axis (largest absolute
 *   delta; ties resolve x, y, z; a point drag defaults to y). The base
 *   (center) sits at the minimum drag coordinate along the axis with the
 *   anchor's other coordinates, the height spans the drag length, and the
 *   radius is the largest delta on the remaining axes.
 *
 * Every parameter is clamped to the volume's coordinate domain and extent
 * limits (ADR-0009, `VoxelVolumeLimits`), so the preview always equals the
 * committed fill, and the preview voxelization is bounded by the
 * per-gesture budget (`ToolHost.maxGestureVoxels`). The occupied-voxel
 * limit is preflighted exactly (current occupancy plus the additions the
 * shape would make, read through the authoritative store): a shape that
 * cannot fit is rejected with `TOO_MANY_VOXELS` /
 * `TOO_MANY_OCCUPIED_VOXELS` before any commit and the gesture is
 * cancelled atomically. The tool never mutates semantic state: it reads
 * the immutable store, previews into the editor store, and hands one
 * command to the host on commit.
 */

export type ShapeToolKind = "box" | "sphere" | "cylinder";

export interface ShapeToolOptions {
  readonly kind: ShapeToolKind;
  readonly host: ToolHost;
  /** Runtime store the tool reads (active material) and previews into. */
  readonly editor: EditorStore;
}

export interface ShapeTool {
  readonly id: ShapeToolKind;
  /** True while a shape gesture is in progress. */
  readonly active: boolean;
  readonly draft: ToolDraft | undefined;
  pointerDown(clientX: number, clientY: number): ToolActionResult;
  pointerMove(clientX: number, clientY: number): ToolActionResult;
  pointerUp(): ToolActionResult;
  pointerCancel(): void;
  /** Discards any in-progress gesture (lifecycle replacement, tests). */
  reset(): void;
}

/** Frozen shape parameters of one in-progress gesture. */
export type ShapeParams =
  | {
      readonly kind: "box";
      readonly volumeId: ToolDraft["volumeId"];
      readonly region: IntAabb;
    }
  | {
      readonly kind: "sphere";
      readonly volumeId: ToolDraft["volumeId"];
      readonly center: Vec3i;
      readonly radius: number;
    }
  | {
      readonly kind: "cylinder";
      readonly volumeId: ToolDraft["volumeId"];
      readonly center: Vec3i;
      readonly radius: number;
      readonly height: number;
      readonly axis: ShapeAxis;
    };

const LABELS: Readonly<Record<ShapeToolKind, string>> = {
  box: "Fill box",
  sphere: "Fill sphere",
  cylinder: "Fill cylinder",
} as const;

const AXES: readonly ShapeAxis[] = ["x", "y", "z"];

/** Half-open coordinate domain of a volume (ADR-0009). */
const coordinateDomain = (max: number): IntAabb => ({
  min: [-max, -max, -max],
  max: [max + 1, max + 1, max + 1],
});

/** Clamps a half-open region into the domain. */
function clampRegion(region: IntAabb, domain: IntAabb): IntAabb {
  return {
    min: [
      Math.max(region.min[0], domain.min[0]),
      Math.max(region.min[1], domain.min[1]),
      Math.max(region.min[2], domain.min[2]),
    ],
    max: [
      Math.min(region.max[0], domain.max[0]),
      Math.min(region.max[1], domain.max[1]),
      Math.min(region.max[2], domain.max[2]),
    ],
  };
}

/** Largest radius that keeps a sphere centered at `center` inside the domain. */
function sphereFitRadius(center: Vec3i, domain: IntAabb): number {
  let fit = Number.POSITIVE_INFINITY;
  for (let axis = 0; axis < 3; axis += 1) {
    const coordinate = center[axis] as number;
    fit = Math.min(
      fit,
      coordinate - (domain.min[axis] as number),
      (domain.max[axis] as number) - 1 - coordinate,
    );
  }
  return fit;
}

/**
 * Largest radius a sphere/cylinder disc may have without exceeding the
 * volume extent limit on any axis (`2r + 1 <= maxExtent`).
 */
const radiusForExtent = (maxExtent: number): number =>
  Math.floor((maxExtent - 1) / 2);

/**
 * Deterministic shape parameters for a drag from `anchor` to `current`
 * (both volume-local voxels), clamped to the volume's coordinate domain
 * and extent limit so the preview voxelization exactly matches the
 * committed fill.
 */
export function shapeParamsForDrag(
  kind: ShapeToolKind,
  volumeId: ToolDraft["volumeId"],
  anchor: Vec3i,
  current: Vec3i,
  limits: VoxelVolumeLimits,
): ShapeParams {
  const domain = coordinateDomain(limits.maxCoordinate);
  if (kind === "box") {
    const region = clampRegion(spanRegion(anchor, current), domain);
    const min = region.min;
    // Clamp each axis span to the volume extent limit (literal indices,
    // so the result type is exact under noUncheckedIndexedAccess).
    const max: [number, number, number] = [
      Math.min(region.max[0], min[0] + limits.maxExtent),
      Math.min(region.max[1], min[1] + limits.maxExtent),
      Math.min(region.max[2], min[2] + limits.maxExtent),
    ];
    return { kind, volumeId, region: { min, max } };
  }
  const deltas: readonly [number, number, number] = [
    current[0] - anchor[0],
    current[1] - anchor[1],
    current[2] - anchor[2],
  ];
  if (kind === "sphere") {
    const chebyshev = Math.max(
      Math.abs(deltas[0]),
      Math.abs(deltas[1]),
      Math.abs(deltas[2]),
    );
    return {
      kind,
      volumeId,
      center: [...anchor],
      radius: Math.min(
        chebyshev,
        sphereFitRadius(anchor, domain),
        radiusForExtent(limits.maxExtent),
      ),
    };
  }
  // Cylinder: dominant axis of the drag (largest absolute delta; ties in
  // x, y, z order; a point drag defaults to y).
  let axis: ShapeAxis = "y";
  let dominant = 0;
  for (const candidate of AXES) {
    const magnitude = Math.abs(deltas[AXES.indexOf(candidate)] as number);
    if (magnitude > dominant) {
      dominant = magnitude;
      axis = candidate;
    }
  }
  const axisIndex = AXES.indexOf(axis);
  const center: [number, number, number] = [anchor[0], anchor[1], anchor[2]];
  center[axisIndex] = Math.min(
    anchor[axisIndex] as number,
    current[axisIndex] as number,
  );
  // The cylinder spans [center[axis], center[axis] + height); clamp the
  // height to the domain and the extent limit.
  const height = Math.min(
    dominant,
    (domain.max[axisIndex] as number) - center[axisIndex],
    limits.maxExtent,
  );
  // Radius is the largest delta on the remaining axes, clamped so the
  // disc stays inside the domain at the center's other coordinates and
  // inside the extent limit. Literal indices keep the element types exact
  // under noUncheckedIndexedAccess.
  let radius = 0;
  let fit = Number.POSITIVE_INFINITY;
  const considerAxis = (other: 0 | 1 | 2): void => {
    if (other === axisIndex) return;
    radius = Math.max(radius, Math.abs(deltas[other]));
    fit = Math.min(
      fit,
      center[other] - domain.min[other],
      domain.max[other] - 1 - center[other],
    );
  };
  considerAxis(0);
  considerAxis(1);
  considerAxis(2);
  return {
    kind,
    volumeId,
    center,
    radius: Math.min(radius, fit, radiusForExtent(limits.maxExtent)),
    height,
    axis,
  };
}

/** Voxelizes the shape parameters, bounded by the per-operation budget. */
export function shapeCoordinates(
  params: ShapeParams,
  limits: VoxelVolumeLimits,
  maxCoordinates: number,
): readonly Vec3i[] {
  const domain = coordinateDomain(limits.maxCoordinate);
  switch (params.kind) {
    case "box":
      return boxCoordinates(params.region, {
        clip: domain,
        maxCoordinates,
      });
    case "sphere":
      return sphereCoordinates(params.center, params.radius, {
        clip: domain,
        maxCoordinates,
      });
    case "cylinder":
      return cylinderCoordinates(
        params.center,
        params.radius,
        params.height,
        params.axis,
        { clip: domain, maxCoordinates },
      );
  }
}

class ShapeToolImpl implements ShapeTool {
  readonly kind: ShapeToolKind;

  get id(): ShapeToolKind {
    return this.kind;
  }

  readonly #host: ToolHost;
  readonly #editor: EditorStore;
  #anchor: Vec3i | undefined;
  #volumeId: ToolDraft["volumeId"] | undefined;
  #params: ShapeParams | undefined;
  /** Preview voxelization of the current params; recomputed per move. */
  #voxels: Vec3i[] = [];
  #material: MaterialId | undefined;
  #active = false;

  constructor(options: ShapeToolOptions) {
    this.kind = options.kind;
    this.#host = options.host;
    this.#editor = options.editor;
  }

  get active(): boolean {
    return this.#active;
  }

  get draft(): ToolDraft | undefined {
    if (!this.#active || this.#params === undefined) return undefined;
    // The voxel array is a live view owned by the tool for the duration of
    // the gesture; consumers must read it between notifications and never
    // retain or mutate it (the draft object is replaced on every update).
    return {
      volumeId: this.#params.volumeId,
      voxels: this.#voxels,
      material: this.#material,
    };
  }

  pointerDown(clientX: number, clientY: number): ToolActionResult {
    // A second down while a gesture is captured is a no-op (safety).
    if (this.#active) return { ok: true };
    const store = this.#host.store;
    if (store === undefined) return { ok: false, error: sessionNotOpen() };
    const material = this.#editor.activeMaterial;
    if (material === undefined) {
      return { ok: false, error: noActiveMaterial() };
    }
    if (store.getDocument().materials[material] === undefined) {
      return { ok: false, error: missingActiveMaterial(material) };
    }
    const hit = this.#host.pick(clientX, clientY);
    if (hit === undefined) return { ok: true };
    this.#anchor = hit.voxel;
    this.#volumeId = hit.volumeId;
    this.#material = material;
    this.#params = this.#paramsFor(hit.voxel);
    this.#active = true;
    const error = this.#preflightVoxels();
    if (error !== undefined) return { ok: false, error };
    this.#editor.setDraft(this.draft);
    return { ok: true };
  }

  pointerMove(clientX: number, clientY: number): ToolActionResult {
    if (!this.#active || this.#volumeId === undefined) return { ok: true };
    const hit = this.#host.pick(clientX, clientY);
    if (hit === undefined) return { ok: true };
    // A shape stays in the volume it started on: picks over other volumes
    // are ignored (deterministic, no accidental cross-node fill).
    if (hit.volumeId !== this.#volumeId) return { ok: true };
    this.#params = this.#paramsFor(hit.voxel);
    const error = this.#preflightVoxels();
    if (error !== undefined) return { ok: false, error };
    this.#editor.setDraft(this.draft);
    return { ok: true };
  }

  pointerUp(): ToolActionResult {
    if (!this.#active || this.#params === undefined) return { ok: true };
    const params = this.#params;
    const material = this.#material;
    this.reset();
    if (material === undefined) return { ok: true };
    let command: ReturnType<
      | typeof fillBoxCommand
      | typeof fillSphereCommand
      | typeof fillCylinderCommand
    >;
    switch (params.kind) {
      case "box":
        command = fillBoxCommand(this.#host.nextCommandId(), {
          volumeId: params.volumeId,
          region: params.region,
          material,
        });
        break;
      case "sphere":
        command = fillSphereCommand(this.#host.nextCommandId(), {
          volumeId: params.volumeId,
          center: params.center,
          radius: params.radius,
          material,
        });
        break;
      case "cylinder": {
        // A zero-height cylinder fills nothing: commit nothing rather
        // than a no-op history entry.
        if (params.height === 0) return { ok: true };
        command = fillCylinderCommand(this.#host.nextCommandId(), {
          volumeId: params.volumeId,
          center: params.center,
          radius: params.radius,
          height: params.height,
          axis: params.axis,
          material,
        });
        break;
      }
    }
    const error = this.#host.commit([command], LABELS[this.kind]);
    if (error !== undefined) return { ok: false, error };
    return { ok: true };
  }

  pointerCancel(): void {
    this.reset();
  }

  reset(): void {
    this.#active = false;
    this.#anchor = undefined;
    this.#volumeId = undefined;
    this.#params = undefined;
    this.#voxels = [];
    this.#material = undefined;
    this.#editor.setDraft(undefined);
  }

  /** Shape parameters for the current voxel relative to the anchor. */
  #paramsFor(voxel: Vec3i): ShapeParams {
    const anchor = this.#anchor;
    const volumeId = this.#volumeId;
    if (anchor === undefined || volumeId === undefined) {
      throw new Error("shape gesture has no anchor");
    }
    const store = this.#host.store;
    const limits = store?.getVolume(volumeId)?.limits;
    if (limits === undefined) {
      throw new Error("shape gesture has no volume limits");
    }
    return shapeParamsForDrag(this.kind, volumeId, anchor, voxel, limits);
  }

  /**
   * Preflights the current shape params and publishes the bounded preview
   * voxels. Fails before any commit and before any unbounded allocation:
   * a shape that cannot fit the ADR-0009 budget or the volume's
   * occupied-voxel limit cancels the gesture atomically (no draft, no
   * params, no commit) and returns the structured error. Pointer-down
   * and pointer-move share this path so the gesture can never be left
   * half-started.
   */
  #preflightVoxels(): WorkspaceError | undefined {
    try {
      this.#voxels = [...this.#boundedVoxels()];
    } catch (error) {
      if (error instanceof WorkspaceError) {
        this.reset();
        return error;
      }
      throw error;
    }
    return undefined;
  }

  /**
   * Bounded preview voxelization of the current shape parameters, with an
   * exact preflight of the volume's occupied-voxel limit (ADR-0009):
   * additions are counted against the authoritative store so a fill that
   * the commit would reject is reported before the preview is published.
   */
  #boundedVoxels(): readonly Vec3i[] {
    const params = this.#params;
    if (params === undefined) return [];
    const store = this.#host.store;
    if (store === undefined) return [];
    const volume = store.getVolume(params.volumeId);
    if (volume === undefined) return [];
    const coordinates = shapeCoordinates(
      params,
      volume.limits,
      this.#host.maxGestureVoxels,
    );
    let additions = 0;
    for (const coordinate of coordinates) {
      if (store.getVoxel(params.volumeId, coordinate) === 0) additions += 1;
    }
    if (volume.occupiedCount() + additions > volume.limits.maxOccupiedVoxels) {
      throw tooManyOccupiedError(
        volume.occupiedCount() + additions,
        volume.limits.maxOccupiedVoxels,
      );
    }
    return coordinates;
  }
}

/** Creates a box, sphere, or cylinder tool for one composition. */
export function createShapeTool(options: ShapeToolOptions): ShapeTool {
  return new ShapeToolImpl(options);
}
