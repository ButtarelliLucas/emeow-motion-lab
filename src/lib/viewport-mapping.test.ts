import { describe, expect, it } from "vitest";
import { createViewportMapping, mapNormalizedPointToScene, mapNormalizedPointToViewport } from "@/lib/viewport-mapping";

describe("viewport mapping", () => {
  it("matches object-cover math for portrait viewport against landscape camera", () => {
    const mapping = createViewportMapping({
      viewportWidth: 390,
      viewportHeight: 844,
      videoWidth: 1280,
      videoHeight: 720,
    });

    expect(mapping.contentHeight).toBeCloseTo(844, 5);
    expect(mapping.contentWidth).toBeCloseTo(1500.444, 3);
    expect(mapping.offsetX).toBeCloseTo(-555.222, 3);
    expect(mapping.offsetY).toBeCloseTo(0, 5);
    expect(mapping.sceneHalfWidth).toBeCloseTo(390 / 844, 5);
  });

  it("keeps the center of the source aligned with the center of the viewport", () => {
    const mapping = createViewportMapping({
      viewportWidth: 390,
      viewportHeight: 844,
      videoWidth: 1280,
      videoHeight: 720,
    });

    expect(mapNormalizedPointToViewport({ x: 0.5, y: 0.5 }, mapping)).toEqual({
      x: 0.5,
      y: 0.5,
    });
    expect(mapNormalizedPointToScene({ x: 0.5, y: 0.5 }, mapping)).toEqual({
      x: 0,
      y: 0,
    });
  });

  it("maps the visible left edge of the cropped video to the left scene boundary", () => {
    const mapping = createViewportMapping({
      viewportWidth: 390,
      viewportHeight: 844,
      videoWidth: 1280,
      videoHeight: 720,
    });
    const visibleLeftEdge = -mapping.offsetX / mapping.contentWidth;
    const leftScenePoint = mapNormalizedPointToScene({ x: visibleLeftEdge, y: 0.5 }, mapping);

    expect(leftScenePoint.x).toBeCloseTo(-mapping.sceneHalfWidth, 5);
    expect(leftScenePoint.y).toBeCloseTo(0, 5);
  });
});
