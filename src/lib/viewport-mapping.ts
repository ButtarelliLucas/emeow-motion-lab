import type { Vec2, ViewportMapping } from "@/types/experience";

interface ViewportMappingInput {
  viewportWidth: number;
  viewportHeight: number;
  videoWidth: number;
  videoHeight: number;
}

export function createViewportMapping({
  viewportWidth,
  viewportHeight,
  videoWidth,
  videoHeight,
}: ViewportMappingInput): ViewportMapping {
  const safeViewportWidth = Math.max(1, viewportWidth);
  const safeViewportHeight = Math.max(1, viewportHeight);
  const safeVideoWidth = Math.max(1, videoWidth);
  const safeVideoHeight = Math.max(1, videoHeight);
  const scale = Math.max(safeViewportWidth / safeVideoWidth, safeViewportHeight / safeVideoHeight);
  const contentWidth = safeVideoWidth * scale;
  const contentHeight = safeVideoHeight * scale;

  return {
    viewportWidth: safeViewportWidth,
    viewportHeight: safeViewportHeight,
    videoWidth: safeVideoWidth,
    videoHeight: safeVideoHeight,
    contentWidth,
    contentHeight,
    offsetX: (safeViewportWidth - contentWidth) / 2,
    offsetY: (safeViewportHeight - contentHeight) / 2,
    sceneHalfWidth: safeViewportWidth / safeViewportHeight,
  };
}

export function mapNormalizedPointToViewport(point: Vec2, mapping: ViewportMapping): Vec2 {
  const screenX = mapping.offsetX + point.x * mapping.contentWidth;
  const screenY = mapping.offsetY + point.y * mapping.contentHeight;

  return {
    x: screenX / mapping.viewportWidth,
    y: screenY / mapping.viewportHeight,
  };
}

export function mapNormalizedPointToScene(point: Vec2, mapping: ViewportMapping): Vec2 {
  const viewportPoint = mapNormalizedPointToViewport(point, mapping);

  return {
    x: (viewportPoint.x * 2 - 1) * mapping.sceneHalfWidth,
    y: 1 - viewportPoint.y * 2,
  };
}
