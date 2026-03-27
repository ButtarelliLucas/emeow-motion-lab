import { describe, expect, it } from "vitest";
import { createEmptyInteractionState, TrackingStateEngine } from "@/lib/hand-tracking/tracker-core";
import type { LandmarkLike } from "@/lib/hand-tracking/gestures";
import { createViewportMapping } from "@/lib/viewport-mapping";

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

describe("TrackingStateEngine", () => {
  it("creates an empty interaction state", () => {
    const state = createEmptyInteractionState(123);

    expect(state.hands).toHaveLength(0);
    expect(state.handsDetected).toBe(false);
    expect(state.lastUpdated).toBe(123);
  });

  it("omits detailed landmarks by default", () => {
    const engine = new TrackingStateEngine({
      qualityTier: "medium",
      reducedMotion: false,
    });

    const interaction = engine.processResult(
      {
        landmarks: [createOpenHand()],
        handedness: [[{ categoryName: "Left", score: 0.92, index: 0, displayName: "Left" }]],
      } as never,
      1000,
    );

    expect(interaction.hands).toHaveLength(1);
    expect(interaction.hands[0]?.landmarks).toHaveLength(0);
    expect(interaction.hands[0]?.fingertips).toHaveLength(5);
  });

  it("includes landmarks when detailed mode is enabled", () => {
    const engine = new TrackingStateEngine({
      qualityTier: "medium",
      reducedMotion: false,
      detailedLandmarksEnabled: true,
    });

    const interaction = engine.processResult(
      {
        landmarks: [createOpenHand()],
        handedness: [[{ categoryName: "Left", score: 0.92, index: 0, displayName: "Left" }]],
      } as never,
      1000,
    );

    expect(interaction.hands[0]?.landmarks).toHaveLength(21);
  });

  it("remaps both ellipse radii when the viewport mapping changes", () => {
    const engine = new TrackingStateEngine({
      qualityTier: "medium",
      reducedMotion: false,
    });

    engine.setViewportMapping(
      createViewportMapping({
        viewportWidth: 1000,
        viewportHeight: 1000,
        videoWidth: 1000,
        videoHeight: 1000,
      }),
    );

    const first = engine.processResult(
      {
        landmarks: [createOpenHand()],
        handedness: [[{ categoryName: "Left", score: 0.92, index: 0, displayName: "Left" }]],
      } as never,
      1000,
    );

    const firstHand = first.hands[0];
    expect(firstHand).toBeDefined();

    engine.setViewportMapping(
      createViewportMapping({
        viewportWidth: 1000,
        viewportHeight: 500,
        videoWidth: 1000,
        videoHeight: 1000,
      }),
    );

    const remapped = engine.processResult(
      {
        landmarks: [],
        handedness: [],
      } as never,
      1100,
    );

    const remappedHand = remapped.hands[0];
    expect(remappedHand).toBeDefined();
    expect(remappedHand?.ellipseRadiusX).not.toBeCloseTo(firstHand!.ellipseRadiusX, 5);
    expect(remappedHand?.ellipseRadiusY).not.toBeCloseTo(firstHand!.ellipseRadiusY, 5);
  });
});
