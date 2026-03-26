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
  closure: number;
  openAmount: number;
  rollAngle: number;
  sideTilt: number;
  paletteBias: number;
  gesture: Exclude<GestureState, "dualField">;
  confidence: number;
}

const WRIST = 0;
const THUMB_MCP = 2;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_PIP = 6;
const INDEX_TIP = 8;
const MIDDLE_MCP = 9;
const MIDDLE_PIP = 10;
const MIDDLE_TIP = 12;
const RING_MCP = 13;
const RING_PIP = 14;
const RING_TIP = 16;
const PINKY_MCP = 17;
const PINKY_PIP = 18;
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

interface Point3D {
  x: number;
  y: number;
  z: number;
}

function projectPoint3D(landmark: LandmarkLike, mirrorX = true): Point3D {
  return {
    x: mirrorX ? 1 - landmark.x : landmark.x,
    y: landmark.y,
    z: landmark.z ?? 0,
  };
}

function subtract3D(a: Point3D, b: Point3D): Point3D {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z,
  };
}

function cross(a: Point3D, b: Point3D): Point3D {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function length3D(vector: Point3D) {
  return Math.hypot(vector.x, vector.y, vector.z);
}

function fingerExtension(points: Vec2[], tipIndex: number, baseIndex: number, palm: Vec2, scale: number, softness = 0.82) {
  const tipDistance = distance(points[tipIndex], palm);
  const baseDistance = distance(points[baseIndex], palm);

  return clamp((tipDistance - baseDistance * 0.92) / Math.max(scale * softness, 0.0001), 0, 1);
}

function foldedTowardPalm(points: Vec2[], tipIndex: number, pipIndex: number, palm: Vec2) {
  return distance(points[tipIndex], palm) <= distance(points[pipIndex], palm) * 1.03;
}

export function measureHand(
  landmarks: LandmarkLike[],
  wasClosedFist: boolean,
  thresholds: {
    closedFistOnThreshold: number;
    closedFistOffThreshold: number;
    openAmountThreshold: number;
  },
  confidence: number,
): HandMeasurement {
  const points = landmarks.map((landmark) => projectLandmark(landmark));
  const points3D = landmarks.map((landmark) => projectPoint3D(landmark));
  const palm = average([points[WRIST], points[INDEX_MCP], points[MIDDLE_MCP], points[PINKY_MCP]]);
  const fingertips = [points[THUMB_TIP], points[INDEX_TIP], points[MIDDLE_TIP], points[RING_TIP], points[PINKY_TIP]];
  const pinchPoint = average([points[THUMB_TIP], points[INDEX_TIP]]);
  const scale = Math.max(0.18, handScale(points));
  const extensions = [
    fingerExtension(points, THUMB_TIP, THUMB_MCP, palm, scale, 0.72),
    fingerExtension(points, INDEX_TIP, INDEX_MCP, palm, scale),
    fingerExtension(points, MIDDLE_TIP, MIDDLE_MCP, palm, scale),
    fingerExtension(points, RING_TIP, RING_MCP, palm, scale),
    fingerExtension(points, PINKY_TIP, PINKY_MCP, palm, scale, 0.76),
  ];
  const openAmount = clamp(extensions.reduce((total, value) => total + value, 0) / extensions.length, 0, 1);
  const closure = clamp(1 - openAmount, 0, 1);
  const fingerFoldStates = [
    distance(points[THUMB_TIP], palm) < distance(points[THUMB_MCP], palm) * 1.28,
    foldedTowardPalm(points, INDEX_TIP, INDEX_PIP, palm),
    foldedTowardPalm(points, MIDDLE_TIP, MIDDLE_PIP, palm),
    foldedTowardPalm(points, RING_TIP, RING_PIP, palm),
    foldedTowardPalm(points, PINKY_TIP, PINKY_PIP, palm),
  ];
  const foldedCount = fingerFoldStates.filter(Boolean).length;
  const closedFist = wasClosedFist
    ? closure >= thresholds.closedFistOffThreshold && foldedCount >= 4
    : closure >= thresholds.closedFistOnThreshold && foldedCount >= 4;

  const rollVector = {
    x: points[MIDDLE_TIP].x - points[WRIST].x,
    y: points[MIDDLE_TIP].y - points[WRIST].y,
  };
  const rollAngle = Math.atan2(rollVector.x, -rollVector.y);
  const paletteBias = clamp(rollAngle / (Math.PI * 0.35), -1, 1);
  const palmNormal = cross(subtract3D(points3D[INDEX_MCP], points3D[WRIST]), subtract3D(points3D[PINKY_MCP], points3D[WRIST]));
  const sideTilt = clamp(Math.abs(palmNormal.z) / Math.max(length3D(palmNormal), 0.0001), 0, 1);
  const openness = openAmount;
  const pinchStrength = closure;

  let gesture: Exclude<GestureState, "dualField"> = "idle";

  if (closedFist) {
    gesture = "closedFist";
  } else if (openAmount >= thresholds.openAmountThreshold) {
    gesture = "openPalm";
  }

  return {
    palm,
    fingertips,
    pinchPoint,
    radius: clamp((0.12 + openAmount * 0.16 + sideTilt * 0.04) * 0.9, 0.11, 0.31),
    pinchStrength,
    openness,
    closure,
    openAmount,
    rollAngle,
    sideTilt,
    paletteBias,
    gesture,
    confidence,
  };
}
