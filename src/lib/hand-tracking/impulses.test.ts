import { describe, expect, it } from "vitest";
import { nextGestureImpulse } from "@/lib/hand-tracking/impulses";

describe("nextGestureImpulse", () => {
  it("creates an impulse from a positive gesture increase", () => {
    const next = nextGestureImpulse(0, 0.68, 0.42, 0.016);

    expect(next).toBe(1);
  });

  it("decays quickly when the gesture stops increasing", () => {
    const next = nextGestureImpulse(1, 0.68, 0.68, 0.1);

    expect(next).toBeLessThan(0.3);
    expect(next).toBeGreaterThan(0.2);
  });

  it("does not create a new impulse from negative change", () => {
    const next = nextGestureImpulse(0, 0.34, 0.48, 0.016);

    expect(next).toBe(0);
  });
});
