import { describe, expect, it } from "vitest";
import { measureHand, type LandmarkLike } from "@/lib/hand-tracking/gestures";

function createBaseLandmarks(): LandmarkLike[] {
  return Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
}

function createOpenHand() {
  const landmarks = createBaseLandmarks();
  landmarks[0] = { x: 0.5, y: 0.74 };
  landmarks[4] = { x: 0.22, y: 0.4 };
  landmarks[5] = { x: 0.42, y: 0.56 };
  landmarks[8] = { x: 0.38, y: 0.06 };
  landmarks[9] = { x: 0.5, y: 0.5 };
  landmarks[12] = { x: 0.5, y: 0.03 };
  landmarks[16] = { x: 0.62, y: 0.08 };
  landmarks[17] = { x: 0.58, y: 0.56 };
  landmarks[20] = { x: 0.76, y: 0.18 };
  return landmarks;
}

function createPinchedHand() {
  const landmarks = createOpenHand();
  landmarks[4] = { x: 0.44, y: 0.38 };
  landmarks[8] = { x: 0.46, y: 0.39 };
  return landmarks;
}

describe("measureHand", () => {
  it("detects an open palm when fingertips are far from the palm", () => {
    const result = measureHand(
      createOpenHand(),
      false,
      {
        pinchOnThreshold: 0.42,
        pinchOffThreshold: 0.58,
        openPalmThreshold: 1.18,
      },
      0.9,
    );

    expect(result.gesture).toBe("openPalm");
    expect(result.openness).toBeGreaterThan(1.18);
  });

  it("detects a pinch when thumb and index fingertips collapse", () => {
    const result = measureHand(
      createPinchedHand(),
      false,
      {
        pinchOnThreshold: 0.42,
        pinchOffThreshold: 0.58,
        openPalmThreshold: 1.18,
      },
      0.9,
    );

    expect(result.gesture).toBe("pinch");
    expect(result.pinchStrength).toBeGreaterThan(0.7);
  });

  it("keeps pinch active during hysteresis if it was already pinched", () => {
    const landmarks = createOpenHand();
    landmarks[4] = { x: 0.43, y: 0.4 };
    landmarks[8] = { x: 0.5, y: 0.44 };

    const result = measureHand(
      landmarks,
      true,
      {
        pinchOnThreshold: 0.42,
        pinchOffThreshold: 0.58,
        openPalmThreshold: 1.18,
      },
      0.8,
    );

    expect(result.gesture).toBe("pinch");
  });
});
