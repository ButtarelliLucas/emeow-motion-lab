import type { Vec2 } from "@/types/experience";

export const DUAL_COMPRESSION_GATE = 0.55;
export const DUAL_DENSITY_GATE = 0.24;
export const DUAL_IMPLOSION_HOLD_MS = 80;
export const DUAL_IMPLOSION_COOLDOWN_MS = 650;

export interface DualImplosionGateInput {
  holdMs: number;
  armed: boolean;
  compressionStrength: number;
  centerDensityRatio: number;
  deltaSeconds: number;
}

export interface DualImplosionGateOutput {
  holdMs: number;
  triggered: boolean;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, 0.0001), 0, 1);

  return t * t * (3 - 2 * t);
}

export function computeDistanceCompressionBias(dualCloseness: number) {
  return 0.28 + 0.72 * smoothstep(0.12, 0.9, dualCloseness);
}

export function computeReleaseBurstStrength(dualCloseness: number) {
  return 0.32 + 0.68 * smoothstep(0.12, 0.9, dualCloseness);
}

export function shouldRearmDualImplosion(cooldownElapsedMs: number, minClosure: number, compressionStrength: number) {
  return cooldownElapsedMs >= DUAL_IMPLOSION_COOLDOWN_MS && (minClosure <= 0.32 || compressionStrength <= 0.18);
}

export function computeCenterDensityRatio(positions: Float32Array, center: Vec2, radius: number) {
  if (radius <= 0 || positions.length === 0) {
    return 0;
  }

  const radiusSq = radius * radius;
  let insideCount = 0;

  for (let index = 0; index < positions.length; index += 3) {
    const deltaX = positions[index] - center.x;
    const deltaY = positions[index + 1] - center.y;

    if (deltaX * deltaX + deltaY * deltaY <= radiusSq) {
      insideCount += 1;
    }
  }

  return insideCount / (positions.length / 3);
}

export function updateDualImplosionGate({
  holdMs,
  armed,
  compressionStrength,
  centerDensityRatio,
  deltaSeconds,
}: DualImplosionGateInput): DualImplosionGateOutput {
  if (!armed || compressionStrength < DUAL_COMPRESSION_GATE || centerDensityRatio < DUAL_DENSITY_GATE) {
    return {
      holdMs: 0,
      triggered: false,
    };
  }

  const nextHoldMs = holdMs + deltaSeconds * 1000;

  return {
    holdMs: nextHoldMs,
    triggered: nextHoldMs >= DUAL_IMPLOSION_HOLD_MS,
  };
}
