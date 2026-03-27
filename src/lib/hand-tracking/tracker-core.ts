import type {
  Category,
  HandLandmarkerResult,
  NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import { EXPERIENCE_CONFIG, getQualityProfile } from "@/config/experience";
import { computeDualDepthDelta, computeProjectedScale } from "@/lib/hand-tracking/depth";
import { measureHand } from "@/lib/hand-tracking/gestures";
import { nextGestureImpulse } from "@/lib/hand-tracking/impulses";
import { clamp, distance, lerp, lerpVec2, length } from "@/lib/math";
import { createViewportMapping, mapNormalizedPointToScene } from "@/lib/viewport-mapping";
import type {
  GestureState,
  HandVisualState,
  InteractionState,
  QualityTier,
  Vec2,
  ViewportMapping,
} from "@/types/experience";

interface InternalHandState extends HandVisualState {
  rawPalm: Vec2;
  rawLandmarks: Vec2[];
  rawFingertips: Vec2[];
  rawPinchPoint: Vec2;
  rawTrail: Vec2[];
  rawOpenAmount: number;
  rawClosure: number;
  lastSeenAt: number;
}

function detectSweepGesture(speed: number, currentGesture: Exclude<GestureState, "dualField">) {
  if (currentGesture !== "idle") {
    return currentGesture;
  }

  return speed >= EXPERIENCE_CONFIG.sweepSpeedThreshold ? "sweep" : "idle";
}

function handednessKey(handedness: Category[][], index: number) {
  const category = handedness[index]?.[0]?.categoryName?.toLowerCase();
  return category ? `hand-${category}` : `hand-${index}`;
}

function smoothingAlpha(moving: boolean, stillAlpha: number, movingAlpha: number) {
  return moving ? movingAlpha : stillAlpha;
}

function lerpAngle(start: number, end: number, alpha: number) {
  let delta = end - start;

  while (delta > Math.PI) {
    delta -= Math.PI * 2;
  }

  while (delta < -Math.PI) {
    delta += Math.PI * 2;
  }

  return start + delta * alpha;
}

function defaultViewportMapping() {
  return createViewportMapping({
    viewportWidth: 1,
    viewportHeight: 1,
    videoWidth: 1,
    videoHeight: 1,
  });
}

export function createEmptyInteractionState(lastUpdated: number): InteractionState {
  return {
    hands: [],
    handsDetected: false,
    primaryGesture: "idle",
    dualActive: false,
    paletteBias: 0,
    dualDistance: 0,
    dualCloseness: 0,
    dualDepthDelta: 0,
    dualDepthAmount: 0,
    lastUpdated,
  };
}

export class TrackingStateEngine {
  private readonly hands = new Map<string, InternalHandState>();
  private readonly reducedMotion: boolean;
  private trailLength: number;
  private viewportMapping: ViewportMapping = defaultViewportMapping();
  private detailedLandmarksEnabled: boolean;

  constructor({
    qualityTier,
    reducedMotion,
    detailedLandmarksEnabled = false,
  }: {
    qualityTier: QualityTier;
    reducedMotion: boolean;
    detailedLandmarksEnabled?: boolean;
  }) {
    this.reducedMotion = reducedMotion;
    this.trailLength = getQualityProfile(qualityTier, reducedMotion).trailLength;
    this.detailedLandmarksEnabled = detailedLandmarksEnabled;
  }

  setViewportMapping(mapping: ViewportMapping) {
    const previousMapping = this.viewportMapping;
    const horizontalScale = mapping.sceneHalfWidth / Math.max(previousMapping.sceneHalfWidth, 0.0001);
    this.viewportMapping = mapping;

    this.hands.forEach((hand, key) => {
      this.hands.set(key, {
        ...hand,
        palm: mapNormalizedPointToScene(hand.rawPalm, mapping),
        landmarks: hand.rawLandmarks.map((point) => mapNormalizedPointToScene(point, mapping)),
        fingertips: hand.rawFingertips.map((tip) => mapNormalizedPointToScene(tip, mapping)),
        pinchPoint: mapNormalizedPointToScene(hand.rawPinchPoint, mapping),
        trail: hand.rawTrail.map((point) => mapNormalizedPointToScene(point, mapping)),
        ellipseRadiusX: hand.ellipseRadiusX * horizontalScale,
        ellipseRadiusY: hand.ellipseRadiusY,
      });
    });
  }

  setQualityTier(qualityTier: QualityTier) {
    this.trailLength = getQualityProfile(qualityTier, this.reducedMotion).trailLength;
  }

  setDetailedLandmarksEnabled(enabled: boolean) {
    this.detailedLandmarksEnabled = enabled;

    if (!enabled) {
      this.hands.forEach((hand, key) => {
        this.hands.set(key, {
          ...hand,
          landmarks: [],
          rawLandmarks: [],
        });
      });
    }
  }

  reset(lastUpdated: number) {
    this.hands.clear();
    return createEmptyInteractionState(lastUpdated);
  }

  processResult(result: HandLandmarkerResult, now: number): InteractionState {
    const nextKeys = new Set<string>();

    result.landmarks.forEach((landmarks, index) => {
      const key = handednessKey(result.handedness, index);
      nextKeys.add(key);

      const confidence = result.handedness[index]?.[0]?.score ?? 0.8;
      const previous = this.hands.get(key);
      const measured = measureHand(
        landmarks as NormalizedLandmark[],
        previous?.gesture === "closedFist",
        {
          closedFistOnThreshold: EXPERIENCE_CONFIG.closedFistOnThreshold,
          closedFistOffThreshold: EXPERIENCE_CONFIG.closedFistOffThreshold,
          openAmountThreshold: EXPERIENCE_CONFIG.openAmountThreshold,
        },
        confidence,
      );
      const elapsedSeconds = Math.max(0.016, (now - (previous?.lastSeenAt ?? now - 16)) / 1000);
      const openImpulseTarget = nextGestureImpulse(
        previous?.openImpulseAmount ?? 0,
        measured.openAmount,
        previous?.rawOpenAmount ?? measured.openAmount,
        elapsedSeconds,
      );
      const closingImpulseTarget = nextGestureImpulse(
        previous?.closingImpulseAmount ?? 0,
        measured.closure,
        previous?.rawClosure ?? measured.closure,
        elapsedSeconds,
      );
      const rawVelocity = previous
        ? {
            x: (measured.palm.x - previous.rawPalm.x) / elapsedSeconds,
            y: (measured.palm.y - previous.rawPalm.y) / elapsedSeconds,
          }
        : { x: 0, y: 0 };
      const rawSpeed = length(rawVelocity);
      const moving = previous ? distance(measured.palm, previous.rawPalm) > 0.012 || rawSpeed > 0.55 : false;

      const rawPalm = previous
        ? lerpVec2(previous.rawPalm, measured.palm, smoothingAlpha(moving, 0.42, 0.62))
        : measured.palm;
      const rawLandmarks = this.detailedLandmarksEnabled
        ? landmarks.map((point, landmarkIndex) =>
            previous?.rawLandmarks[landmarkIndex]
              ? lerpVec2(
                  previous.rawLandmarks[landmarkIndex],
                  { x: point.x, y: point.y },
                  smoothingAlpha(moving, 0.32, 0.52),
                )
              : { x: point.x, y: point.y },
          )
        : [];
      const rawFingertips = measured.fingertips.map((tip, fingertipIndex) =>
        previous?.rawFingertips[fingertipIndex]
          ? lerpVec2(previous.rawFingertips[fingertipIndex], tip, smoothingAlpha(moving, 0.38, 0.58))
          : tip,
      );
      const rawPinchPoint = previous
        ? lerpVec2(previous.rawPinchPoint, measured.pinchPoint, smoothingAlpha(moving, 0.4, 0.64))
        : measured.pinchPoint;
      const palm = mapNormalizedPointToScene(rawPalm, this.viewportMapping);
      const sceneLandmarks = this.detailedLandmarksEnabled
        ? rawLandmarks.map((point) => mapNormalizedPointToScene(point, this.viewportMapping))
        : [];
      const fingertips = rawFingertips.map((tip) => mapNormalizedPointToScene(tip, this.viewportMapping));
      const pinchPoint = mapNormalizedPointToScene(rawPinchPoint, this.viewportMapping);
      const ellipseXAnchor = mapNormalizedPointToScene(
        {
          x: rawPalm.x + measured.ellipseAxisX.x * measured.ellipseRadiusX,
          y: rawPalm.y + measured.ellipseAxisX.y * measured.ellipseRadiusX,
        },
        this.viewportMapping,
      );
      const ellipseYAnchor = mapNormalizedPointToScene(
        {
          x: rawPalm.x + measured.ellipseAxisY.x * measured.ellipseRadiusY,
          y: rawPalm.y + measured.ellipseAxisY.y * measured.ellipseRadiusY,
        },
        this.viewportMapping,
      );
      const ellipseRadiusXTarget = Math.max(0.06, distance(ellipseXAnchor, palm));
      const ellipseRadiusYTarget = Math.max(0.08, distance(ellipseYAnchor, palm));
      const ellipseAngleTarget = Math.atan2(ellipseXAnchor.y - palm.y, ellipseXAnchor.x - palm.x);
      const projectedScaleTarget = computeProjectedScale(ellipseRadiusXTarget, ellipseRadiusYTarget);
      const velocity = previous
        ? {
            x: (palm.x - previous.palm.x) / elapsedSeconds,
            y: (palm.y - previous.palm.y) / elapsedSeconds,
          }
        : { x: 0, y: 0 };
      const gesture = detectSweepGesture(rawSpeed, measured.gesture);
      const rawTrail = [rawPalm, ...(previous?.rawTrail ?? [])].slice(0, this.trailLength);
      const trail = rawTrail.map((point) => mapNormalizedPointToScene(point, this.viewportMapping));
      const radiusTarget = measured.radius * (this.viewportMapping.contentHeight / this.viewportMapping.viewportHeight);

      this.hands.set(key, {
        id: key,
        confidence: lerp(previous?.confidence ?? confidence, confidence, 0.3),
        palm,
        landmarks: sceneLandmarks,
        fingertips,
        pinchPoint,
        radius: lerp(previous?.radius ?? radiusTarget, radiusTarget, 0.36),
        pinchStrength: lerp(previous?.pinchStrength ?? measured.pinchStrength, measured.pinchStrength, 0.35),
        openness: lerp(previous?.openness ?? measured.openness, measured.openness, 0.35),
        closure: lerp(previous?.closure ?? measured.closure, measured.closure, 0.32),
        openAmount: lerp(previous?.openAmount ?? measured.openAmount, measured.openAmount, 0.32),
        rollAngle: lerp(previous?.rollAngle ?? measured.rollAngle, measured.rollAngle, 0.28),
        sideTilt: lerp(previous?.sideTilt ?? measured.sideTilt, measured.sideTilt, 0.26),
        paletteBias: lerp(previous?.paletteBias ?? measured.paletteBias, measured.paletteBias, 0.24),
        ellipseAngle: previous
          ? lerpAngle(previous.ellipseAngle, ellipseAngleTarget, smoothingAlpha(moving, 0.24, 0.4))
          : ellipseAngleTarget,
        ellipseRadiusX: lerp(
          previous?.ellipseRadiusX ?? ellipseRadiusXTarget,
          ellipseRadiusXTarget,
          smoothingAlpha(moving, 0.24, 0.42),
        ),
        ellipseRadiusY: lerp(
          previous?.ellipseRadiusY ?? ellipseRadiusYTarget,
          ellipseRadiusYTarget,
          smoothingAlpha(moving, 0.24, 0.42),
        ),
        projectedScale: lerp(
          previous?.projectedScale ?? projectedScaleTarget,
          projectedScaleTarget,
          smoothingAlpha(moving, 0.24, 0.42),
        ),
        attractionAmount: lerp(
          previous?.attractionAmount ?? measured.attractionAmount,
          measured.attractionAmount,
          smoothingAlpha(moving, 0.22, 0.4),
        ),
        repulsionAmount: lerp(
          previous?.repulsionAmount ?? measured.repulsionAmount,
          measured.repulsionAmount,
          smoothingAlpha(moving, 0.22, 0.4),
        ),
        openImpulseAmount: openImpulseTarget,
        closingImpulseAmount: closingImpulseTarget,
        speed: rawSpeed,
        gesture,
        trail,
        velocity,
        presence: 1,
        rawPalm,
        rawLandmarks,
        rawFingertips,
        rawPinchPoint,
        rawTrail,
        rawOpenAmount: measured.openAmount,
        rawClosure: measured.closure,
        lastSeenAt: now,
      });
    });

    const activeHands = Array.from(this.hands.entries()).flatMap(([key, hand]) => {
      if (nextKeys.has(key)) {
        return [hand];
      }

      const age = now - hand.lastSeenAt;
      if (age > EXPERIENCE_CONFIG.handGraceMs) {
        this.hands.delete(key);
        return [];
      }

      return [
        {
          ...hand,
          presence: clamp(1 - age / EXPERIENCE_CONFIG.handGraceMs, 0, 1),
        },
      ];
    });

    activeHands.sort((left, right) => left.palm.x - right.palm.x);
    const dualActive = activeHands.length > 1;
    const primaryGesture = dualActive ? "dualField" : activeHands[0]?.gesture ?? "idle";
    const dualDistance = dualActive ? distance(activeHands[0].palm, activeHands[1].palm) : 0;
    const rawDualDistance = dualActive ? distance(activeHands[0].rawPalm, activeHands[1].rawPalm) : 0;
    const dualCloseness = dualActive
      ? 1 -
        clamp(
          (rawDualDistance - EXPERIENCE_CONFIG.dualCloseDistance) /
            Math.max(EXPERIENCE_CONFIG.dualFarDistance - EXPERIENCE_CONFIG.dualCloseDistance, 0.0001),
          0,
          1,
        )
      : 0;
    const paletteBias = dualActive
      ? clamp((activeHands[1].palm.y - activeHands[0].palm.y) / 0.65, -1, 1)
      : activeHands[0]?.paletteBias ?? 0;
    const dualDepthDelta = dualActive
      ? computeDualDepthDelta(activeHands[0].projectedScale, activeHands[1].projectedScale)
      : 0;
    const dualDepthAmount = Math.abs(dualDepthDelta);

    return {
      hands: activeHands,
      handsDetected: activeHands.length > 0,
      primaryGesture,
      dualActive,
      paletteBias,
      dualDistance,
      dualCloseness,
      dualDepthDelta,
      dualDepthAmount,
      lastUpdated: now,
    };
  }
}
