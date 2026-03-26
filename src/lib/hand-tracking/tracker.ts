import {
  FilesetResolver,
  HandLandmarker,
  type Category,
  type HandLandmarkerResult,
  type NormalizedLandmark,
} from "@mediapipe/tasks-vision";
import { EXPERIENCE_CONFIG, getQualityProfile } from "@/config/experience";
import { assetUrl } from "@/lib/assets";
import { measureHand } from "@/lib/hand-tracking/gestures";
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

interface TrackerCallbacks {
  onInteraction: (interaction: InteractionState) => void;
  onTrackingMetrics: (trackingMs: number) => void;
}

interface TrackerOptions {
  qualityTier: QualityTier;
  reducedMotion: boolean;
  callbacks: TrackerCallbacks;
}

interface InternalHandState extends HandVisualState {
  rawPalm: Vec2;
  rawFingertips: Vec2[];
  rawPinchPoint: Vec2;
  rawTrail: Vec2[];
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

function defaultViewportMapping() {
  return createViewportMapping({
    viewportWidth: 1,
    viewportHeight: 1,
    videoWidth: 1,
    videoHeight: 1,
  });
}

export class HandTrackerController {
  private landmarker: HandLandmarker | null = null;
  private video: HTMLVideoElement | null = null;
  private readonly callbacks: TrackerCallbacks;
  private running = false;
  private paused = false;
  private rafId = 0;
  private videoFrameId = 0;
  private lastTrackedAt = 0;
  private lastVideoTime = -1;
  private readonly hands = new Map<string, InternalHandState>();
  private readonly reducedMotion: boolean;
  private trackIntervalMs: number;
  private trailLength: number;
  private viewportMapping: ViewportMapping = defaultViewportMapping();

  constructor({ qualityTier, reducedMotion, callbacks }: TrackerOptions) {
    this.callbacks = callbacks;
    this.reducedMotion = reducedMotion;
    this.trackIntervalMs = 1000 / EXPERIENCE_CONFIG.trackingTargetFps[qualityTier];
    this.trailLength = getQualityProfile(qualityTier, reducedMotion).trailLength;
  }

  async init() {
    const vision = await FilesetResolver.forVisionTasks(assetUrl("mediapipe/wasm/"));

    try {
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: assetUrl("models/hand_landmarker.task"),
          delegate: "GPU",
        },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.45,
      });
    } catch {
      this.landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: {
          modelAssetPath: assetUrl("models/hand_landmarker.task"),
          delegate: "CPU",
        },
        runningMode: "VIDEO",
        numHands: 2,
        minHandDetectionConfidence: 0.55,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.45,
      });
    }
  }

  attachVideo(video: HTMLVideoElement) {
    this.video = video;
  }

  setViewportMapping(mapping: ViewportMapping) {
    this.viewportMapping = mapping;

    this.hands.forEach((hand, key) => {
      this.hands.set(key, {
        ...hand,
        palm: mapNormalizedPointToScene(hand.rawPalm, mapping),
        fingertips: hand.rawFingertips.map((tip) => mapNormalizedPointToScene(tip, mapping)),
        pinchPoint: mapNormalizedPointToScene(hand.rawPinchPoint, mapping),
        trail: hand.rawTrail.map((point) => mapNormalizedPointToScene(point, mapping)),
      });
    });
  }

  setQualityTier(qualityTier: QualityTier) {
    this.trackIntervalMs = 1000 / EXPERIENCE_CONFIG.trackingTargetFps[qualityTier];
    this.trailLength = getQualityProfile(qualityTier, this.reducedMotion).trailLength;
  }

  start() {
    if (!this.landmarker || !this.video || this.running) {
      return;
    }

    this.running = true;
    this.paused = false;
    this.lastTrackedAt = 0;
    this.lastVideoTime = -1;
    this.scheduleNextTick();
  }

  stop() {
    this.running = false;
    this.cancelScheduledTick();
  }

  setPaused(paused: boolean) {
    this.paused = paused;

    if (paused) {
      this.cancelScheduledTick();
      return;
    }

    if (this.running && !this.rafId && !this.videoFrameId) {
      this.scheduleNextTick();
    }
  }

  reset() {
    this.hands.clear();
    this.callbacks.onInteraction({
      hands: [],
      handsDetected: false,
      primaryGesture: "idle",
      dualActive: false,
      paletteBias: 0,
      dualDistance: 0,
      dualCloseness: 0,
      lastUpdated: performance.now(),
    });
  }

  destroy() {
    this.stop();
    this.landmarker?.close();
    this.landmarker = null;
    this.hands.clear();
  }

  private cancelScheduledTick() {
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }

    if (this.videoFrameId && this.video?.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this.videoFrameId);
      this.videoFrameId = 0;
    }
  }

  private scheduleNextTick() {
    if (!this.running || this.paused) {
      return;
    }

    if (this.video?.requestVideoFrameCallback) {
      this.videoFrameId = this.video.requestVideoFrameCallback(this.handleVideoFrame);
      return;
    }

    this.rafId = window.requestAnimationFrame(this.tick);
  }

  private readonly handleVideoFrame = (now: number) => {
    this.videoFrameId = 0;
    this.tick(now);
  };

  private readonly tick = (now: number) => {
    if (!this.running || this.paused) {
      this.cancelScheduledTick();
      return;
    }

    const video = this.video;
    if (!this.landmarker || !video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      this.scheduleNextTick();
      return;
    }

    const usingVideoFrames = typeof video.requestVideoFrameCallback === "function";
    if ((!usingVideoFrames && video.currentTime === this.lastVideoTime) || now - this.lastTrackedAt < this.trackIntervalMs) {
      this.scheduleNextTick();
      return;
    }

    this.lastTrackedAt = now;
    this.lastVideoTime = video.currentTime;

    const startedAt = performance.now();
    const result = this.landmarker.detectForVideo(video, now);
    const trackingMs = performance.now() - startedAt;

    this.callbacks.onTrackingMetrics(trackingMs);
    this.processResult(result, now);
    this.scheduleNextTick();
  };

  private processResult(result: HandLandmarkerResult, now: number) {
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
      const rawFingertips = measured.fingertips.map((tip, fingertipIndex) =>
        previous?.rawFingertips[fingertipIndex]
          ? lerpVec2(previous.rawFingertips[fingertipIndex], tip, smoothingAlpha(moving, 0.38, 0.58))
          : tip,
      );
      const rawPinchPoint = previous
        ? lerpVec2(previous.rawPinchPoint, measured.pinchPoint, smoothingAlpha(moving, 0.4, 0.64))
        : measured.pinchPoint;
      const palm = mapNormalizedPointToScene(rawPalm, this.viewportMapping);
      const fingertips = rawFingertips.map((tip) => mapNormalizedPointToScene(tip, this.viewportMapping));
      const pinchPoint = mapNormalizedPointToScene(rawPinchPoint, this.viewportMapping);
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
        speed: rawSpeed,
        gesture,
        trail,
        velocity,
        presence: 1,
        rawPalm,
        rawFingertips,
        rawPinchPoint,
        rawTrail,
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

    this.callbacks.onInteraction({
      hands: activeHands,
      handsDetected: activeHands.length > 0,
      primaryGesture,
      dualActive,
      paletteBias,
      dualDistance,
      dualCloseness,
      lastUpdated: now,
    });
  }
}
