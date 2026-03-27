import { describe, expect, it } from "vitest";
import {
  computeDistanceCompressionBias,
  computeReleaseBurstStrength,
  computeCenterDensityRatio,
  DUAL_IMPLOSION_COOLDOWN_MS,
  DUAL_IMPLOSION_HOLD_MS,
  shouldRearmDualImplosion,
  updateDualImplosionGate,
} from "@/lib/particles/implosion";

describe("computeCenterDensityRatio", () => {
  it("counts how many particles are inside the implosion core", () => {
    const positions = new Float32Array([
      0,
      0,
      0,
      0.06,
      0.04,
      0,
      0.22,
      0.21,
      0,
      -0.34,
      0.28,
      0,
    ]);

    const ratio = computeCenterDensityRatio(positions, { x: 0, y: 0 }, 0.1);

    expect(ratio).toBe(0.5);
  });
});

describe("updateDualImplosionGate", () => {
  it("resets hold when compression or density are below threshold", () => {
    const gate = updateDualImplosionGate({
      holdMs: 45,
      armed: true,
      compressionStrength: 0.4,
      centerDensityRatio: 0.31,
      deltaSeconds: 0.016,
    });

    expect(gate.holdMs).toBe(0);
    expect(gate.triggered).toBe(false);
  });

  it("triggers only after density stays high long enough", () => {
    const first = updateDualImplosionGate({
      holdMs: 0,
      armed: true,
      compressionStrength: 0.74,
      centerDensityRatio: 0.28,
      deltaSeconds: 0.04,
    });
    const second = updateDualImplosionGate({
      holdMs: first.holdMs,
      armed: true,
      compressionStrength: 0.74,
      centerDensityRatio: 0.28,
      deltaSeconds: DUAL_IMPLOSION_HOLD_MS / 1000 - 0.04,
    });

    expect(first.triggered).toBe(false);
    expect(second.triggered).toBe(true);
  });

  it("never triggers while the implosion is disarmed", () => {
    const gate = updateDualImplosionGate({
      holdMs: 72,
      armed: false,
      compressionStrength: 0.82,
      centerDensityRatio: 0.36,
      deltaSeconds: 0.02,
    });

    expect(gate.holdMs).toBe(0);
    expect(gate.triggered).toBe(false);
  });
});

describe("computeDistanceCompressionBias", () => {
  it("keeps compression much weaker when hands are far apart", () => {
    expect(computeDistanceCompressionBias(0)).toBeCloseTo(0.28, 3);
    expect(computeDistanceCompressionBias(1)).toBeCloseTo(1, 3);
  });

  it("ramps up smoothly as the hands get closer", () => {
    const medium = computeDistanceCompressionBias(0.5);
    const near = computeDistanceCompressionBias(0.85);

    expect(medium).toBeGreaterThan(0.4);
    expect(near).toBeGreaterThan(medium);
  });
});

describe("computeReleaseBurstStrength", () => {
  it("makes the post-implosion burst stronger when hands are closer", () => {
    expect(computeReleaseBurstStrength(0)).toBeCloseTo(0.32, 3);
    expect(computeReleaseBurstStrength(1)).toBeCloseTo(1, 3);
    expect(computeReleaseBurstStrength(0.85)).toBeGreaterThan(computeReleaseBurstStrength(0.4));
  });
});

describe("shouldRearmDualImplosion", () => {
  it("requires cooldown plus released compression", () => {
    expect(shouldRearmDualImplosion(DUAL_IMPLOSION_COOLDOWN_MS - 1, 0.12, 0.12)).toBe(false);
    expect(shouldRearmDualImplosion(DUAL_IMPLOSION_COOLDOWN_MS, 0.48, 0.42)).toBe(false);
    expect(shouldRearmDualImplosion(DUAL_IMPLOSION_COOLDOWN_MS, 0.3, 0.42)).toBe(true);
    expect(shouldRearmDualImplosion(DUAL_IMPLOSION_COOLDOWN_MS, 0.48, 0.18)).toBe(true);
  });
});
