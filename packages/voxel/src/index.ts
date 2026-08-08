import {
  materialId,
  WorkspaceError,
  type MaterialId,
} from "@voxel-maker/shared";

export type TraceCoordinate = readonly [number, number, number] & {
  readonly __kind: "TraceCoordinate";
};
export interface TraceVoxel {
  readonly chunk: TraceCoordinate;
  readonly local: TraceCoordinate;
  readonly material: MaterialId;
}
const CHUNK_EDGE = 16;
const MIN_COORDINATE = -2_147_483_648;
const MAX_COORDINATE = 2_147_483_647;
const floorDiv = (value: number): number => Math.floor(value / CHUNK_EDGE);
const modulo = (value: number): number =>
  ((value % CHUNK_EDGE) + CHUNK_EDGE) % CHUNK_EDGE;

function traceCoordinate(
  value: readonly [number, number, number],
): TraceCoordinate {
  if (
    value.some(
      (component) =>
        !Number.isInteger(component) ||
        component < MIN_COORDINATE ||
        component > MAX_COORDINATE,
    )
  ) {
    throw new WorkspaceError({
      family: "validation",
      code: "INVALID_TRACE_COORDINATE",
      message: "Trace coordinates must contain bounded integers",
      context: { value: value.map((component) => String(component)) },
    });
  }
  return [...value] as unknown as TraceCoordinate;
}

/** Minimal negative-coordinate mapping used to prove the voxel seam. */
export function traceVoxel(
  coordinate: readonly [number, number, number],
  material: number,
): TraceVoxel {
  const parsed = traceCoordinate(coordinate);
  return {
    chunk: traceCoordinate([
      floorDiv(parsed[0]),
      floorDiv(parsed[1]),
      floorDiv(parsed[2]),
    ]),
    local: traceCoordinate([
      modulo(parsed[0]),
      modulo(parsed[1]),
      modulo(parsed[2]),
    ]),
    material: materialId(material),
  };
}
