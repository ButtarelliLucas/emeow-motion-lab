import { describe, expect, it } from "vitest";
import { measureHand, type LandmarkLike } from "@/lib/hand-tracking/gestures";

const THRESHOLDS = {
  closedFistOnThreshold: 0.72,
  closedFistOffThreshold: 0.56,
  openAmountThreshold: 0.76,
};

function createBaseLandmarks(): LandmarkLike[] {
  return Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
}

function createOpenHand() {
  const landmarks = createBaseLandmarks();
  landmarks[0] = { x: 0.5, y: 0.78, z: 0 };
  landmarks[2] = { x: 0.36, y: 0.63, z: -0.02 };
  landmarks[4] = { x: 0.24, y: 0.42, z: -0.04 };
  landmarks[5] = { x: 0.42, y: 0.58, z: -0.04 };
  landmarks[6] = { x: 0.4, y: 0.39, z: -0.06 };
  landmarks[8] = { x: 0.38, y: 0.13, z: -0.08 };
  landmarks[9] = { x: 0.5, y: 0.54, z: -0.02 };
  landmarks[10] = { x: 0.5, y: 0.34, z: -0.05 };
  landmarks[12] = { x: 0.5, y: 0.08, z: -0.08 };
  landmarks[13] = { x: 0.58, y: 0.58, z: 0.03 };
  landmarks[14] = { x: 0.6, y: 0.39, z: 0.05 };
  landmarks[16] = { x: 0.62, y: 0.16, z: 0.08 };
  landmarks[17] = { x: 0.67, y: 0.6, z: 0.06 };
  landmarks[18] = { x: 0.71, y: 0.46, z: 0.08 };
  landmarks[20] = { x: 0.78, y: 0.26, z: 0.11 };
  return landmarks;
}

function createClosedFist() {
  const landmarks = createOpenHand();
  landmarks[4] = { x: 0.44, y: 0.63, z: -0.01 };
  landmarks[6] = { x: 0.43, y: 0.59, z: -0.02 };
  landmarks[8] = { x: 0.45, y: 0.67, z: -0.01 };
  landmarks[10] = { x: 0.49, y: 0.58, z: -0.02 };
  landmarks[12] = { x: 0.51, y: 0.66, z: -0.01 };
  landmarks[14] = { x: 0.56, y: 0.59, z: 0.02 };
  landmarks[16] = { x: 0.56, y: 0.67, z: 0.02 };
  landmarks[18] = { x: 0.62, y: 0.61, z: 0.03 };
  landmarks[20] = { x: 0.61, y: 0.67, z: 0.03 };
  return landmarks;
}

function createPartiallyClosedHand() {
  const landmarks = createOpenHand();
  landmarks[4] = { x: 0.28, y: 0.5, z: -0.03 };
  landmarks[8] = { x: 0.39, y: 0.31, z: -0.05 };
  landmarks[12] = { x: 0.5, y: 0.27, z: -0.06 };
  landmarks[16] = { x: 0.61, y: 0.33, z: 0.05 };
  landmarks[20] = { x: 0.71, y: 0.45, z: 0.08 };
  return landmarks;
}

function createModeratelyOpenHand() {
  const landmarks = createOpenHand();
  landmarks[4] = { x: 0.27, y: 0.47, z: -0.03 };
  landmarks[8] = { x: 0.38, y: 0.22, z: -0.07 };
  landmarks[12] = { x: 0.5, y: 0.18, z: -0.07 };
  landmarks[16] = { x: 0.61, y: 0.24, z: 0.06 };
  landmarks[20] = { x: 0.73, y: 0.34, z: 0.09 };
  return landmarks;
}

function createSideTiltedHand() {
  const landmarks = createOpenHand();
  landmarks[4] = { x: 0.39, y: 0.46, z: -0.05 };
  landmarks[5] = { ...landmarks[5], z: -0.28 };
  landmarks[5] = { ...landmarks[5], x: 0.47 };
  landmarks[8] = { ...landmarks[8], x: 0.46 };
  landmarks[9] = { ...landmarks[9], x: 0.51 };
  landmarks[12] = { ...landmarks[12], x: 0.5 };
  landmarks[13] = { ...landmarks[13], x: 0.55 };
  landmarks[16] = { ...landmarks[16], x: 0.55 };
  landmarks[17] = { ...landmarks[17], z: 0.28 };
  landmarks[17] = { ...landmarks[17], x: 0.58 };
  landmarks[20] = { ...landmarks[20], x: 0.59 };
  return landmarks;
}

function createClockwiseEllipticHand() {
  const landmarks = createOpenHand();
  landmarks[5] = { ...landmarks[5], y: 0.48 };
  landmarks[9] = { ...landmarks[9], y: 0.54 };
  landmarks[13] = { ...landmarks[13], y: 0.63 };
  landmarks[17] = { ...landmarks[17], y: 0.69 };
  return landmarks;
}

function createCounterClockwiseEllipticHand() {
  const landmarks = createOpenHand();
  landmarks[5] = { ...landmarks[5], y: 0.68 };
  landmarks[9] = { ...landmarks[9], y: 0.61 };
  landmarks[13] = { ...landmarks[13], y: 0.53 };
  landmarks[17] = { ...landmarks[17], y: 0.48 };
  return landmarks;
}

describe("measureHand", () => {
  it("detects an open palm and exposes openAmount", () => {
    const result = measureHand(createOpenHand(), false, THRESHOLDS, 0.9);

    expect(result.gesture).toBe("openPalm");
    expect(result.openAmount).toBeGreaterThan(0.76);
    expect(result.closure).toBeLessThan(0.3);
    expect(result.repulsionAmount).toBeGreaterThan(0.75);
  });

  it("detects a closed fist and exposes closure", () => {
    const result = measureHand(createClosedFist(), false, THRESHOLDS, 0.9);

    expect(result.gesture).toBe("closedFist");
    expect(result.closure).toBeGreaterThan(0.72);
    expect(result.openAmount).toBeLessThan(0.35);
  });

  it("keeps a closed fist active during hysteresis", () => {
    const landmarks = createClosedFist();
    landmarks[8] = { x: 0.44, y: 0.61, z: -0.01 };
    landmarks[12] = { x: 0.51, y: 0.61, z: -0.01 };

    const result = measureHand(landmarks, true, THRESHOLDS, 0.85);

    expect(result.gesture).toBe("closedFist");
    expect(result.closure).toBeGreaterThan(0.56);
  });

  it("starts attraction before a fully classified fist", () => {
    const result = measureHand(createPartiallyClosedHand(), false, THRESHOLDS, 0.85);

    expect(result.attractionAmount).toBeGreaterThan(0);
    expect(result.gesture).not.toBe("closedFist");
  });

  it("starts repulsion before a fully open hand", () => {
    const result = measureHand(createModeratelyOpenHand(), false, THRESHOLDS, 0.85);

    expect(result.repulsionAmount).toBeGreaterThan(0.12);
  });

  it("maps clockwise and counter-clockwise roll into opposite palette bias", () => {
    const right = measureHand(createClockwiseEllipticHand(), false, THRESHOLDS, 0.9);
    const left = measureHand(createCounterClockwiseEllipticHand(), false, THRESHOLDS, 0.9);

    expect(Math.abs(right.rollAngle - left.rollAngle)).toBeGreaterThan(0.04);
    expect(Math.abs(right.paletteBias - left.paletteBias)).toBeGreaterThan(0.04);
    expect(Math.abs(right.rollAngle)).toBeGreaterThan(0.04);
    expect(Math.abs(left.rollAngle)).toBeGreaterThan(0.04);
  });

  it("changes ellipse angle with clockwise and counter-clockwise hand poses", () => {
    const clockwise = measureHand(createClockwiseEllipticHand(), false, THRESHOLDS, 0.9);
    const counterClockwise = measureHand(createCounterClockwiseEllipticHand(), false, THRESHOLDS, 0.9);

    expect(Math.sign(clockwise.ellipseAngle)).not.toBe(Math.sign(counterClockwise.ellipseAngle));
    expect(Math.abs(clockwise.ellipseAngle)).toBeGreaterThan(0.08);
    expect(Math.abs(counterClockwise.ellipseAngle)).toBeGreaterThan(0.08);
  });

  it("reduces sideTilt when the palm turns sideways", () => {
    const front = measureHand(createOpenHand(), false, THRESHOLDS, 0.9);
    const side = measureHand(createSideTiltedHand(), false, THRESHOLDS, 0.9);

    expect(front.sideTilt).toBeGreaterThan(side.sideTilt);
    expect(front.sideTilt).toBeGreaterThan(0.6);
    expect(front.ellipseRadiusX).toBeGreaterThan(side.ellipseRadiusX);
  });
});
