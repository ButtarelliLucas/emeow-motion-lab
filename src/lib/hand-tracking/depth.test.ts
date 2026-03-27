import { describe, expect, it } from "vitest";
import { computeDualDepthDelta, computeProjectedScale } from "@/lib/hand-tracking/depth";

describe("computeProjectedScale", () => {
  it("uses the geometric mean of the ellipse radii", () => {
    expect(computeProjectedScale(0.16, 0.25)).toBeCloseTo(0.2, 5);
  });
});

describe("computeDualDepthDelta", () => {
  it("is positive when the right hand projects larger", () => {
    expect(computeDualDepthDelta(0.18, 0.27)).toBeGreaterThan(0);
  });

  it("is negative when the left hand projects larger", () => {
    expect(computeDualDepthDelta(0.3, 0.19)).toBeLessThan(0);
  });

  it("returns nearly zero when both hands have similar projected size", () => {
    expect(Math.abs(computeDualDepthDelta(0.22, 0.221))).toBeLessThan(0.02);
  });
});
