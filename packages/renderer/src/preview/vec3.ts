import type { Vec3 } from "@voxel-maker/math";

/**
 * Private vector helpers shared by the preview protocol and the software
 * renderer (ticket #25). One implementation keeps the two modules' math
 * in lockstep: `normalize` returns undefined for a zero vector so callers
 * decide the fallback, and every other helper is total.
 */

export function vec3Length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

/** Unit vector, or undefined for a zero vector. */
export function normalize(v: Vec3): Vec3 | undefined {
  const length = vec3Length(v);
  if (length === 0) return undefined;
  return [v[0] / length, v[1] / length, v[2] / length];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(v: Vec3, factor: number): Vec3 {
  return [v[0] * factor, v[1] * factor, v[2] * factor];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}
