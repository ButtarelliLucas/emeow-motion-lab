import { clamp, lerp, normalize } from "@/lib/math";
import type { Vec2 } from "@/types/experience";

export interface OverlayHandInput {
  palm: Vec2;
  velocity: Vec2;
  speed: number;
  ellipseAngle: number;
  ellipseRadiusX: number;
  ellipseRadiusY: number;
  fingertips: Vec2[];
  trail: Vec2[];
  presence: number;
}

export interface OverlayDisplayHandState {
  initialized: boolean;
  palm: Vec2;
  ellipseAngle: number;
  ellipseRadiusX: number;
  ellipseRadiusY: number;
  fingertips: Vec2[];
  trail: Vec2[];
  presence: number;
}

export interface RingMotionBuffers {
  positions: Float32Array;
  previousPositions: Float32Array;
  sizes: Float32Array;
  alphas: Float32Array;
  trails: Float32Array;
  angles: Float32Array;
  radialOffsets: Float32Array;
  phaseOffsets: Float32Array;
  orbitFractions: Float32Array;
  laneOffsets: Float32Array;
  tangentOffsets: Float32Array;
  axisOffsets: Float32Array;
}

export interface RingMotionOptions {
  center: Vec2;
  rotation: number;
  radiusX: number;
  radiusY: number;
  jitterAmplitude: number;
  driftSpeed: number;
  time: number;
  flowAmount: number;
  zOffset: number;
  bandThickness: number;
  tangentSpread: number;
  axisWarp: number;
}

function lerpPoint(start: Vec2, end: Vec2, alpha: number): Vec2 {
  return {
    x: lerp(start.x, end.x, alpha),
    y: lerp(start.y, end.y, alpha),
  };
}

function lerpWrappedAngle(start: number, end: number, alpha: number) {
  let delta = end - start;

  while (delta > Math.PI) {
    delta -= Math.PI * 2;
  }

  while (delta < -Math.PI) {
    delta += Math.PI * 2;
  }

  return start + delta * alpha;
}

function expSmoothing(delta: number, rate: number) {
  return 1 - Math.exp(-delta * rate);
}

export function createDisplayHandState(fingertipCount: number, trailLength: number): OverlayDisplayHandState {
  return {
    initialized: false,
    palm: { x: 0, y: 0 },
    ellipseAngle: 0,
    ellipseRadiusX: 0.1,
    ellipseRadiusY: 0.1,
    fingertips: Array.from({ length: fingertipCount }, () => ({ x: 0, y: 0 })),
    trail: Array.from({ length: trailLength }, () => ({ x: 0, y: 0 })),
    presence: 0,
  };
}

export function updateDisplayHandState(state: OverlayDisplayHandState, hand: OverlayHandInput, delta: number) {
  const leadSeconds = clamp(0.012 + hand.speed * 0.008, 0.012, 0.03);
  const predictedPalm = {
    x: hand.palm.x + hand.velocity.x * leadSeconds,
    y: hand.palm.y + hand.velocity.y * leadSeconds,
  };
  const geometryAlpha = expSmoothing(delta, hand.speed > 1.1 ? 22 : 14);
  const radiusAlpha = expSmoothing(delta, 16);
  const angleAlpha = expSmoothing(delta, hand.speed > 1.1 ? 20 : 13);
  const tipAlpha = expSmoothing(delta, hand.speed > 1.1 ? 24 : 16);
  const trailAlpha = expSmoothing(delta, hand.speed > 1.1 ? 26 : 18);
  const presenceAlpha = expSmoothing(delta, 10);

  if (!state.initialized) {
    state.initialized = true;
    state.palm = { ...predictedPalm };
    state.ellipseAngle = hand.ellipseAngle;
    state.ellipseRadiusX = hand.ellipseRadiusX;
    state.ellipseRadiusY = hand.ellipseRadiusY;
    state.presence = hand.presence;
    state.fingertips = hand.fingertips.map((tip) => ({ ...tip }));
    state.trail = state.trail.map((_, index) => ({ ...(hand.trail[index] ?? hand.palm) }));
    return state;
  }

  state.palm = lerpPoint(state.palm, predictedPalm, geometryAlpha);
  state.ellipseAngle = lerpWrappedAngle(state.ellipseAngle, hand.ellipseAngle, angleAlpha);
  state.ellipseRadiusX = lerp(state.ellipseRadiusX, hand.ellipseRadiusX, radiusAlpha);
  state.ellipseRadiusY = lerp(state.ellipseRadiusY, hand.ellipseRadiusY, radiusAlpha);
  state.presence = lerp(state.presence, hand.presence, presenceAlpha);

  for (let index = 0; index < state.fingertips.length; index += 1) {
    state.fingertips[index] = lerpPoint(state.fingertips[index], hand.fingertips[index] ?? hand.palm, tipAlpha);
  }

  for (let index = 0; index < state.trail.length; index += 1) {
    state.trail[index] = lerpPoint(state.trail[index], hand.trail[index] ?? hand.palm, trailAlpha);
  }

  return state;
}

export function createRingMotionBuffers({
  count,
  shellCount,
  sizeRange,
  alphaRange,
  overlayScale,
  random = Math.random,
}: {
  count: number;
  shellCount: number;
  sizeRange: [number, number];
  alphaRange: [number, number];
  overlayScale: number;
  random?: () => number;
}): RingMotionBuffers {
  const positions = new Float32Array(count * 3);
  const previousPositions = new Float32Array(count * 2);
  const sizes = new Float32Array(count);
  const alphas = new Float32Array(count);
  const trails = new Float32Array(count * 2);
  const angles = new Float32Array(count);
  const radialOffsets = new Float32Array(count);
  const phaseOffsets = new Float32Array(count);
  const orbitFractions = new Float32Array(count);
  const laneOffsets = new Float32Array(count);
  const tangentOffsets = new Float32Array(count);
  const axisOffsets = new Float32Array(count);

  for (let index = 0; index < count; index += 1) {
    angles[index] = (index / count) * Math.PI * 2 + (random() - 0.5) * 0.06;
    radialOffsets[index] = random() * 2 - 1;
    phaseOffsets[index] = random();
    orbitFractions[index] = index / count;
    const shellIndex = index % shellCount;
    const shellOffset = shellCount > 1 ? (shellIndex / (shellCount - 1)) * 2 - 1 : 0;
    laneOffsets[index] = shellOffset + (random() * 2 - 1) * 0.18;
    tangentOffsets[index] = random() * 2 - 1;
    axisOffsets[index] = random() * 2 - 1;
    sizes[index] = lerp(sizeRange[0], sizeRange[1], random()) * overlayScale;
    alphas[index] = lerp(alphaRange[0], alphaRange[1], random());
    previousPositions[index * 2] = 0;
    previousPositions[index * 2 + 1] = 0;
  }

  return {
    positions,
    previousPositions,
    sizes,
    alphas,
    trails,
    angles,
    radialOffsets,
    phaseOffsets,
    orbitFractions,
    laneOffsets,
    tangentOffsets,
    axisOffsets,
  };
}

export function stepRingMotion(buffers: RingMotionBuffers, options: RingMotionOptions) {
  const cosRotation = Math.cos(options.rotation);
  const sinRotation = Math.sin(options.rotation);
  const orbitalPhase = options.time * options.driftSpeed;

  for (let index = 0; index < buffers.angles.length; index += 1) {
    const lanePhase = buffers.phaseOffsets[index] * Math.PI * 2;
    const angle =
      buffers.angles[index] +
      orbitalPhase +
      Math.sin(options.time * (0.56 + buffers.phaseOffsets[index] * 0.68) + lanePhase) * options.flowAmount;
    const radialJitter =
      buffers.radialOffsets[index] * options.jitterAmplitude +
      Math.sin(options.time * (0.92 + buffers.phaseOffsets[index] * 0.84) + buffers.phaseOffsets[index] * Math.PI * 4) *
        options.jitterAmplitude *
        0.18;
    const laneWave = Math.sin(angle * (2.2 + buffers.axisOffsets[index] * 0.42) + lanePhase) * options.axisWarp;
    const secondaryWave = Math.cos(angle * (3.6 + buffers.axisOffsets[index] * 0.34) - lanePhase) * options.axisWarp * 0.52;
    const bandOffset = buffers.laneOffsets[index] * options.bandThickness + laneWave * options.bandThickness * 0.42;
    const tangentOffset =
      buffers.tangentOffsets[index] * options.tangentSpread * (0.56 + Math.abs(secondaryWave) * 0.48) +
      secondaryWave * options.tangentSpread * 0.18;
    const radiusX = Math.max(
      0.001,
      options.radiusX + radialJitter + bandOffset * 0.22 + secondaryWave * options.bandThickness * 0.1,
    );
    const radiusY = Math.max(
      0.001,
      options.radiusY + radialJitter - bandOffset * 0.14 + laneWave * options.bandThickness * 0.08,
    );
    let localX = Math.cos(angle) * radiusX;
    let localY = Math.sin(angle) * radiusY;
    const normal = normalize({
      x: Math.cos(angle) / Math.max(radiusX, 0.0001),
      y: Math.sin(angle) / Math.max(radiusY, 0.0001),
    });
    const tangent = normalize({
      x: -Math.sin(angle) * radiusX,
      y: Math.cos(angle) * radiusY,
    });
    localX += normal.x * bandOffset + tangent.x * tangentOffset;
    localY += normal.y * bandOffset + tangent.y * tangentOffset;
    const x = options.center.x + localX * cosRotation - localY * sinRotation;
    const y = options.center.y + localX * sinRotation + localY * cosRotation;
    const positionIndex = index * 3;
    const previousIndex = index * 2;
    const previousX = buffers.previousPositions[previousIndex];
    const previousY = buffers.previousPositions[previousIndex + 1];
    const deltaX = x - previousX;
    const deltaY = y - previousY;
    const deltaLength = Math.hypot(deltaX, deltaY);
    const trailStrength = clamp(deltaLength / 0.009, 0, 1);
    const trailDirection =
      deltaLength > 0.0001
        ? {
            x: deltaX / deltaLength,
            y: deltaY / deltaLength,
          }
        : { x: 0, y: 0 };

    buffers.positions[positionIndex] = x;
    buffers.positions[positionIndex + 1] = y;
    buffers.positions[positionIndex + 2] = options.zOffset;
    buffers.trails[previousIndex] = trailDirection.x * trailStrength;
    buffers.trails[previousIndex + 1] = trailDirection.y * trailStrength;
    buffers.previousPositions[previousIndex] = x;
    buffers.previousPositions[previousIndex + 1] = y;
  }

  return buffers;
}
