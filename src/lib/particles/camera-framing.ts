import { average, clamp, lerp } from "@/lib/math";
import type { InteractionState, Vec2 } from "@/types/experience";

export interface CameraFramingTarget {
  focus: Vec2 | null;
  zoom: number;
  particleScaleBoost: number;
  overlayScaleBoost: number;
  proximity: number;
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, 0.0001), 0, 1);
  return t * t * (3 - 2 * t);
}

export function computeCameraFramingTarget(
  interaction: InteractionState,
  reducedMotion: boolean,
): CameraFramingTarget {
  const activeHands = interaction.hands.filter((hand) => hand.presence > 0.12);

  if (activeHands.length === 0) {
    return {
      focus: null,
      zoom: 1,
      particleScaleBoost: 1,
      overlayScaleBoost: 1,
      proximity: 0,
    };
  }

  let weightedScale = 0;
  let totalWeight = 0;

  activeHands.forEach((hand) => {
    const weight = clamp(hand.presence, 0.2, 1) * clamp(hand.projectedScale * 3.6, 0.4, 1.6);
    weightedScale += hand.projectedScale * weight;
    totalWeight += weight;
  });

  const meanProjectedScale = weightedScale / Math.max(totalWeight, 0.0001);
  const proximityBase = smoothstep(0.18, 0.31, meanProjectedScale);
  const dualBoost = interaction.dualActive ? interaction.dualCloseness * 0.08 : 0;
  const depthBoost = interaction.dualActive ? interaction.dualDepthAmount * 0.05 : 0;
  const proximity = clamp(proximityBase + dualBoost + depthBoost, 0, 1);
  const focus = average(activeHands.map((hand) => hand.palm));

  return {
    focus,
    zoom: lerp(1, reducedMotion ? 1.14 : 1.24, proximity),
    particleScaleBoost: lerp(1, reducedMotion ? 1.08 : 1.18, proximity),
    overlayScaleBoost: lerp(1, reducedMotion ? 1.05 : 1.11, proximity),
    proximity,
  };
}
