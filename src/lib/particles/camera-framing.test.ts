import { describe, expect, it } from "vitest";
import { computeCameraFramingTarget } from "@/lib/particles/camera-framing";
import type { HandVisualState, InteractionState } from "@/types/experience";

function createHand(overrides: Partial<HandVisualState>): HandVisualState {
  return {
    id: overrides.id ?? "hand-0",
    palm: overrides.palm ?? { x: 0, y: 0 },
    landmarks: overrides.landmarks ?? [],
    fingertips: overrides.fingertips ?? [],
    pinchPoint: overrides.pinchPoint ?? { x: 0, y: 0 },
    radius: overrides.radius ?? 0.2,
    pinchStrength: overrides.pinchStrength ?? 0,
    openness: overrides.openness ?? 0.8,
    closure: overrides.closure ?? 0.2,
    openAmount: overrides.openAmount ?? 0.8,
    rollAngle: overrides.rollAngle ?? 0,
    sideTilt: overrides.sideTilt ?? 0,
    paletteBias: overrides.paletteBias ?? 0,
    ellipseAngle: overrides.ellipseAngle ?? 0,
    ellipseRadiusX: overrides.ellipseRadiusX ?? 0.18,
    ellipseRadiusY: overrides.ellipseRadiusY ?? 0.24,
    projectedScale: overrides.projectedScale ?? 0.2,
    attractionAmount: overrides.attractionAmount ?? 0,
    repulsionAmount: overrides.repulsionAmount ?? 0,
    openImpulseAmount: overrides.openImpulseAmount ?? 0,
    closingImpulseAmount: overrides.closingImpulseAmount ?? 0,
    speed: overrides.speed ?? 0,
    gesture: overrides.gesture ?? "openPalm",
    trail: overrides.trail ?? [],
    velocity: overrides.velocity ?? { x: 0, y: 0 },
    confidence: overrides.confidence ?? 1,
    presence: overrides.presence ?? 1,
  };
}

function createInteraction(hands: HandVisualState[]): InteractionState {
  return {
    hands,
    handsDetected: hands.length > 0,
    primaryGesture: hands.length > 1 ? "dualField" : hands[0]?.gesture ?? "idle",
    dualActive: hands.length > 1,
    paletteBias: 0,
    dualDistance: 0,
    dualCloseness: hands.length > 1 ? 0.62 : 0,
    dualDepthDelta: 0,
    dualDepthAmount: hands.length > 1 ? 0.3 : 0,
    lastUpdated: 0,
  };
}

describe("computeCameraFramingTarget", () => {
  it("stays neutral when no hands are present", () => {
    const target = computeCameraFramingTarget(createInteraction([]), false);

    expect(target.zoom).toBe(1);
    expect(target.particleScaleBoost).toBe(1);
    expect(target.overlayScaleBoost).toBe(1);
    expect(target.focus).toBeNull();
  });

  it("increases zoom and scale as projected hand size grows", () => {
    const far = computeCameraFramingTarget(
      createInteraction([createHand({ projectedScale: 0.18, palm: { x: -0.2, y: 0.1 } })]),
      false,
    );
    const near = computeCameraFramingTarget(
      createInteraction([createHand({ projectedScale: 0.31, palm: { x: -0.2, y: 0.1 } })]),
      false,
    );

    expect(near.zoom).toBeGreaterThan(far.zoom);
    expect(near.particleScaleBoost).toBeGreaterThan(far.particleScaleBoost);
    expect(near.overlayScaleBoost).toBeGreaterThan(far.overlayScaleBoost);
  });

  it("uses the mean of both hands and focuses between them", () => {
    const target = computeCameraFramingTarget(
      createInteraction([
        createHand({ id: "left", projectedScale: 0.22, palm: { x: -0.4, y: 0.2 } }),
        createHand({ id: "right", projectedScale: 0.28, palm: { x: 0.4, y: -0.1 } }),
      ]),
      false,
    );

    expect(target.focus?.x).toBeCloseTo(0, 4);
    expect(target.focus?.y).toBeCloseTo(0.05, 4);
    expect(target.zoom).toBeGreaterThan(1.05);
  });
});
