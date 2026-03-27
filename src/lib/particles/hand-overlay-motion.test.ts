import { describe, expect, it } from "vitest";
import type { Vec2 } from "@/types/experience";
import {
  createDisplayHandState,
  createRingMotionBuffers,
  stepRingMotion,
  updateDisplayHandState,
  type OverlayHandInput,
} from "@/lib/particles/hand-overlay-motion";

function createSeededRandom(seed: number) {
  let value = seed >>> 0;

  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(edge1 - edge0, 0.0001)));
  return t * t * (3 - 2 * t);
}

function averageStep(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function averageParticleDisplacement(current: Float32Array, previous: Float32Array) {
  let total = 0;
  const count = current.length / 3;

  for (let index = 0; index < current.length; index += 3) {
    total += Math.hypot(current[index] - previous[index], current[index + 1] - previous[index + 1]);
  }

  return count > 0 ? total / count : 0;
}

function circularAngle(position: Vec2, center: Vec2, rotation: number, radiusX: number, radiusY: number) {
  const translatedX = position.x - center.x;
  const translatedY = position.y - center.y;
  const cosRotation = Math.cos(-rotation);
  const sinRotation = Math.sin(-rotation);
  const localX = translatedX * cosRotation - translatedY * sinRotation;
  const localY = translatedX * sinRotation + translatedY * cosRotation;

  return Math.atan2(localY / Math.max(radiusY, 0.0001), localX / Math.max(radiusX, 0.0001));
}

function isRotationOf(sequence: number[], reference: number[]) {
  if (sequence.length !== reference.length) {
    return false;
  }

  const pivot = reference.indexOf(sequence[0]);
  if (pivot < 0) {
    return false;
  }

  for (let index = 0; index < reference.length; index += 1) {
    if (sequence[index] !== reference[(pivot + index) % reference.length]) {
      return false;
    }
  }

  return true;
}

function median(values: number[]) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) * 0.5 : sorted[middle];
}

function distance(a: Vec2, b: Vec2) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function createTrailPoints(points: Vec2[], target: Vec2, length: number) {
  return [target, ...points].slice(0, length);
}

function createFingerTips(palm: Vec2, radiusX: number, radiusY: number) {
  const offsets: Vec2[] = [
    { x: -radiusX * 0.64, y: -radiusY * 0.18 },
    { x: -radiusX * 0.28, y: -radiusY * 0.52 },
    { x: 0, y: -radiusY * 0.7 },
    { x: radiusX * 0.28, y: -radiusY * 0.52 },
    { x: radiusX * 0.64, y: -radiusY * 0.24 },
  ];

  return offsets.map((offset) => ({
    x: palm.x + offset.x,
    y: palm.y + offset.y,
  }));
}

function createHandPathSample(time: number, previousPalm: Vec2 | null, previousTrail: Vec2[]): OverlayHandInput {
  const progress = smoothstep(0, 2.8, time);
  const palm = {
    x: -0.58 + progress * 1.16,
    y: Math.sin(time * 1.8) * 0.17 + Math.cos(time * 0.72) * 0.04,
  };
  const velocity = previousPalm
    ? {
        x: (palm.x - previousPalm.x) / 0.016,
        y: (palm.y - previousPalm.y) / 0.016,
      }
    : { x: 0, y: 0 };
  const speed = Math.hypot(velocity.x, velocity.y);
  const ellipseRadiusX = 0.18 + Math.sin(time * 1.24) * 0.03;
  const ellipseRadiusY = 0.24 + Math.cos(time * 1.08) * 0.024;
  const ellipseAngle = Math.atan2(velocity.y, velocity.x || 0.0001) * 0.3 + Math.sin(time * 1.42) * 0.16;

  return {
    palm,
    velocity,
    speed,
    ellipseAngle,
    ellipseRadiusX,
    ellipseRadiusY,
    fingertips: createFingerTips(palm, ellipseRadiusX, ellipseRadiusY),
    trail: createTrailPoints(previousTrail, palm, 24),
    presence: 1,
  };
}

function simulateOverlayScenario({
  renderDelta,
  trackingCadences,
  duration,
}: {
  renderDelta: number;
  trackingCadences: number[];
  duration: number;
}) {
  const displayState = createDisplayHandState(5, 24);
  const ring = createRingMotionBuffers({
    count: 72,
    shellCount: 5,
    sizeRange: [7.4, 11.4],
    alphaRange: [0.78, 1],
    overlayScale: 1,
    random: createSeededRandom(42),
  });

  let time = 0;
  let nextTrackingSample = 0;
  let trackingStepIndex = 0;
  let lastTrackingPalm: Vec2 | null = null;
  let lastTrackingTrail: Vec2[] = [];
  let activeHand = createHandPathSample(0, null, []);
  let previousDisplayPalm: Vec2 | null = null;
  let previousRingSnapshot = new Float32Array(ring.positions.length);
  const rawTrackingSteps: number[] = [];
  const displaySteps: number[] = [];
  const ringSteps: number[] = [];

  while (time <= duration) {
    if (time + 0.0001 >= nextTrackingSample) {
      activeHand = createHandPathSample(time, lastTrackingPalm, lastTrackingTrail);
      if (lastTrackingPalm) {
        rawTrackingSteps.push(distance(activeHand.palm, lastTrackingPalm));
      }
      lastTrackingPalm = activeHand.palm;
      lastTrackingTrail = activeHand.trail;
      nextTrackingSample += trackingCadences[trackingStepIndex % trackingCadences.length];
      trackingStepIndex += 1;
    }

    updateDisplayHandState(displayState, activeHand, renderDelta);

    if (previousDisplayPalm) {
      displaySteps.push(distance(displayState.palm, previousDisplayPalm));
    }

    stepRingMotion(ring, {
      center: displayState.palm,
      rotation: displayState.ellipseAngle,
      radiusX: displayState.ellipseRadiusX * 1.12,
      radiusY: displayState.ellipseRadiusY * 1.12,
      jitterAmplitude: 0.0012,
      driftSpeed: 1.58,
      time,
      flowAmount: 0.024,
      zOffset: 0.001,
      bandThickness: 0.018,
      tangentSpread: 0.008,
      axisWarp: 0.18,
    });

    if (time > renderDelta * 6) {
      let totalDisplacement = 0;
      for (let index = 0; index < ring.positions.length; index += 3) {
        const dx = ring.positions[index] - previousRingSnapshot[index];
        const dy = ring.positions[index + 1] - previousRingSnapshot[index + 1];
        totalDisplacement += Math.hypot(dx, dy);
      }
      ringSteps.push(totalDisplacement / (ring.positions.length / 3));
    }

    previousDisplayPalm = { ...displayState.palm };
    previousRingSnapshot = ring.positions.slice();
    time += renderDelta;
  }

  const warmRingSteps = ringSteps.slice(4);
  const ringMedian = median(warmRingSteps);
  const ringSpikeThreshold = Math.max(0.028, ringMedian * 3.4);

  return {
    maxRawTrackingStep: Math.max(...rawTrackingSteps, 0),
    maxDisplayStep: Math.max(...displaySteps, 0),
    averageRingStep: averageStep(warmRingSteps),
    maxRingStep: Math.max(...warmRingSteps, 0),
    ringMedian,
    ringSpikeCount: warmRingSteps.filter((value) => value > ringSpikeThreshold).length,
  };
}

describe("hand overlay orbital continuity", () => {
  it("smooths palm motion under stable tracking cadence", () => {
    const metrics = simulateOverlayScenario({
      renderDelta: 1 / 60,
      trackingCadences: [1 / 60],
      duration: 2.8,
    });

    expect(metrics.maxDisplayStep).toBeLessThan(metrics.maxRawTrackingStep);
    expect(metrics.ringSpikeCount).toBeLessThanOrEqual(1);
  });

  it("keeps orbital continuity when tracking cadence fluctuates between 29ms and 50ms", () => {
    const metrics = simulateOverlayScenario({
      renderDelta: 1 / 60,
      trackingCadences: [0.029, 0.05, 0.034, 0.046],
      duration: 2.8,
    });

    expect(metrics.maxDisplayStep).toBeLessThan(metrics.maxRawTrackingStep * 0.82);
    expect(metrics.ringSpikeCount).toBeLessThanOrEqual(2);
    expect(metrics.maxRingStep).toBeLessThan(Math.max(0.05, metrics.ringMedian * 4.2));
  });

  it("stays bounded when both render cadence and tracking cadence are slower", () => {
    const metrics = simulateOverlayScenario({
      renderDelta: 0.028,
      trackingCadences: [0.04, 0.05, 0.06],
      duration: 2.8,
    });

    expect(metrics.maxDisplayStep).toBeLessThan(metrics.maxRawTrackingStep * 1.35);
    expect(metrics.ringSpikeCount).toBeLessThanOrEqual(3);
    expect(metrics.averageRingStep).toBeLessThan(0.04);
  });

  it("preserves orbital ordering instead of constantly reordering particles around the hand", () => {
    const ring = createRingMotionBuffers({
      count: 36,
      shellCount: 3,
      sizeRange: [7.4, 11.4],
      alphaRange: [0.78, 1],
      overlayScale: 1,
      random: createSeededRandom(7),
    });
    const center = { x: 0.12, y: -0.08 };
    const rotation = 0.34;
    const radiusX = 0.22;
    const radiusY = 0.29;
    let referenceOrder: number[] | null = null;

    for (let frame = 0; frame < 180; frame += 1) {
      const time = frame / 60;
      stepRingMotion(ring, {
        center,
        rotation,
        radiusX,
        radiusY,
        jitterAmplitude: 0.001,
        driftSpeed: 1.58,
        time,
        flowAmount: 0.024,
        zOffset: 0.001,
        bandThickness: 0.018,
        tangentSpread: 0.008,
        axisWarp: 0.18,
      });

      const order = Array.from({ length: ring.positions.length / 3 }, (_, index) => index)
        .map((index) => ({
          index,
          angle: circularAngle(
            { x: ring.positions[index * 3], y: ring.positions[index * 3 + 1] },
            center,
            rotation,
            radiusX,
            radiusY,
          ),
        }))
        .sort((a, b) => a.angle - b.angle)
        .map((entry) => entry.index);

      if (!referenceOrder) {
        referenceOrder = order;
        continue;
      }

      expect(isRotationOf(order, referenceOrder)).toBe(true);
    }
  });

  it("does not snap the whole orbital band directly to a new center in one frame", () => {
    const ring = createRingMotionBuffers({
      count: 48,
      shellCount: 4,
      sizeRange: [7.4, 11.4],
      alphaRange: [0.78, 1],
      overlayScale: 1,
      random: createSeededRandom(11),
    });

    stepRingMotion(ring, {
      center: { x: -0.2, y: 0.04 },
      rotation: 0.1,
      radiusX: 0.22,
      radiusY: 0.28,
      jitterAmplitude: 0.001,
      driftSpeed: 1.58,
      time: 0,
      flowAmount: 0.024,
      zOffset: 0.001,
      bandThickness: 0.018,
      tangentSpread: 0.008,
      axisWarp: 0.18,
    });

    const beforeJump = ring.positions.slice();
    const centerJump = distance({ x: -0.2, y: 0.04 }, { x: 0.26, y: -0.06 });

    stepRingMotion(ring, {
      center: { x: 0.26, y: -0.06 },
      rotation: 0.42,
      radiusX: 0.24,
      radiusY: 0.26,
      jitterAmplitude: 0.001,
      driftSpeed: 1.58,
      time: 1 / 60,
      flowAmount: 0.024,
      zOffset: 0.001,
      bandThickness: 0.018,
      tangentSpread: 0.008,
      axisWarp: 0.18,
    });

    const averageJump = averageParticleDisplacement(ring.positions, beforeJump);

    expect(averageJump).toBeLessThan(centerJump * 0.72);
  });
});
