import { clamp } from "@/lib/math";

export function computeProjectedScale(ellipseRadiusX: number, ellipseRadiusY: number) {
  return Math.sqrt(Math.max(ellipseRadiusX, 0.0001) * Math.max(ellipseRadiusY, 0.0001));
}

export function computeDualDepthDelta(leftProjectedScale: number, rightProjectedScale: number) {
  const safeLeft = Math.max(leftProjectedScale, 0.0001);
  const safeRight = Math.max(rightProjectedScale, 0.0001);

  return clamp(Math.log(safeRight / safeLeft) / 0.35, -1, 1);
}
