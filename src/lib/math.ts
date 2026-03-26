import type { Vec2 } from "@/types/experience";

export function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function lerp(start: number, end: number, alpha: number) {
  return start + (end - start) * alpha;
}

export function lerpVec2(start: Vec2, end: Vec2, alpha: number): Vec2 {
  return {
    x: lerp(start.x, end.x, alpha),
    y: lerp(start.y, end.y, alpha),
  };
}

export function distance(a: Vec2, b: Vec2) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function length(vector: Vec2) {
  return Math.hypot(vector.x, vector.y);
}

export function subtract(a: Vec2, b: Vec2): Vec2 {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
  };
}

export function add(a: Vec2, b: Vec2): Vec2 {
  return {
    x: a.x + b.x,
    y: a.y + b.y,
  };
}

export function scale(vector: Vec2, factor: number): Vec2 {
  return {
    x: vector.x * factor,
    y: vector.y * factor,
  };
}

export function normalize(vector: Vec2): Vec2 {
  const vectorLength = length(vector) || 1;

  return {
    x: vector.x / vectorLength,
    y: vector.y / vectorLength,
  };
}

export function average(points: Vec2[]): Vec2 {
  if (points.length === 0) {
    return { x: 0.5, y: 0.5 };
  }

  const sum = points.reduce(
    (acc, point) => ({
      x: acc.x + point.x,
      y: acc.y + point.y,
    }),
    { x: 0, y: 0 },
  );

  return {
    x: sum.x / points.length,
    y: sum.y / points.length,
  };
}
