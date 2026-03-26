import type { GestureState, Vec2 } from "@/types/experience";
import { average, clamp, distance } from "@/lib/math";

export interface LandmarkLike {
  x: number;
  y: number;
  z?: number;
}

export interface HandMeasurement {
  palm: Vec2;
  fingertips: Vec2[];
  pinchPoint: Vec2;
  radius: number;
  pinchStrength: number;
  openness: number;
  gesture: Exclude<GestureState, "dualField">;
  confidence: number;
}

const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_TIP = 12;
const RING_TIP = 16;
const PINKY_MCP = 17;
const PINKY_TIP = 20;

export function projectLandmark(landmark: LandmarkLike, mirrorX = true): Vec2 {
  return {
    x: mirrorX ? 1 - landmark.x : landmark.x,
    y: landmark.y,
  };
}

function handScale(points: Vec2[]) {
  return distance(points[INDEX_MCP], points[PINKY_MCP]) + distance(points[WRIST], points[MIDDLE_MCP]);
}

export function measureHand(
  landmarks: LandmarkLike[],
  wasPinched: boolean,
  thresholds: {
    pinchOnThreshold: number;
    pinchOffThreshold: number;
    openPalmThreshold: number;
  },
  confidence: number,
): HandMeasurement {
  const points = landmarks.map((landmark) => projectLandmark(landmark));
  const palm = average([points[WRIST], points[INDEX_MCP], points[MIDDLE_MCP], points[PINKY_MCP]]);
  const fingertips = [points[THUMB_TIP], points[INDEX_TIP], points[MIDDLE_TIP], points[RING_TIP], points[PINKY_TIP]];
  const pinchPoint = average([points[THUMB_TIP], points[INDEX_TIP]]);
  const scale = Math.max(0.18, handScale(points));
  const pinchDistance = distance(points[THUMB_TIP], points[INDEX_TIP]) / scale;
  const openness =
    fingertips.reduce((total, tip) => total + distance(tip, palm), 0) / fingertips.length / scale;

  const pinchStrength = clamp(1 - pinchDistance / thresholds.pinchOffThreshold, 0, 1);
  const pinched = wasPinched
    ? pinchDistance < thresholds.pinchOffThreshold
    : pinchDistance < thresholds.pinchOnThreshold;

  let gesture: Exclude<GestureState, "dualField"> = "idle";

  if (pinched) {
    gesture = "pinch";
  } else if (openness > thresholds.openPalmThreshold) {
    gesture = "openPalm";
  }

  return {
    palm,
    fingertips,
    pinchPoint,
    radius: clamp(openness * 0.35, 0.1, 0.32),
    pinchStrength,
    openness,
    gesture,
    confidence,
  };
}
