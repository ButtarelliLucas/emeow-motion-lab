import * as THREE from "three";
import { getQualityProfile } from "@/config/experience";
import { average, clamp, lerp, normalize, scale, subtract } from "@/lib/math";
import {
  computeCenterDensityRatio,
  computeDistanceCompressionBias,
  computeReleaseBurstStrength,
  shouldRearmDualImplosion,
  updateDualImplosionGate,
} from "@/lib/particles/implosion";
import { nextHigherQuality, nextLowerQuality } from "@/lib/quality";
import { createViewportMapping } from "@/lib/viewport-mapping";
import type { InteractionState, QualityTier, Vec2, ViewportMapping } from "@/types/experience";

interface RendererOptions {
  tier: QualityTier;
  reducedMotion: boolean;
  onQualityChange: (tier: QualityTier) => void;
  onStats: (frameMs: number) => void;
}

interface ParticleBuffers {
  positions: Float32Array;
  velocities: Float32Array;
  sizes: Float32Array;
  alphas: Float32Array;
  seeds: Float32Array;
  depthLayers: Float32Array;
  toneMixes: Float32Array;
  energies: Float32Array;
  speedLights: Float32Array;
  baseSizes: Float32Array;
}

interface CapsuleInfluence {
  along: number;
  closest: Vec2;
  distance: number;
  weight: number;
}

type ImplosionPhase = "idle" | "gather" | "implode" | "release" | "flash" | "cooldown";

interface DualImplosionState {
  phase: ImplosionPhase;
  elapsed: number;
  holdMs: number;
  armed: boolean;
  cooldownElapsed: number;
  center: Vec2 | null;
  radius: number;
  axis: Vec2;
  openField: number;
  paletteBias: number;
  releaseBurstStrength: number;
}

interface BiasPalette {
  biasColor: THREE.Color;
  secondaryColor: THREE.Color;
  accentCool: THREE.Color;
  accentWarm: THREE.Color;
  trailColor: THREE.Color;
  energyColor: THREE.Color;
  haloColor: THREE.Color;
  coreColor: THREE.Color;
  shadowColor: THREE.Color;
}

interface RingParticleBuffers {
  positions: Float32Array;
  previousPositions: Float32Array;
  sizes: Float32Array;
  alphas: Float32Array;
  trails: Float32Array;
  angles: Float32Array;
  radialOffsets: Float32Array;
  phaseOffsets: Float32Array;
}

interface HandRingParticleSystem {
  points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  buffers: RingParticleBuffers;
}

interface HandWireframeVisual {
  line: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  positions: Float32Array;
}

const HAND_CONNECTIONS: Array<[number, number]> = [
  [0, 1],
  [1, 2],
  [2, 3],
  [3, 4],
  [0, 5],
  [5, 6],
  [6, 7],
  [7, 8],
  [5, 9],
  [9, 10],
  [10, 11],
  [11, 12],
  [9, 13],
  [13, 14],
  [14, 15],
  [15, 16],
  [13, 17],
  [17, 18],
  [18, 19],
  [19, 20],
  [0, 17],
];

function toSceneVector(point: Vec2) {
  return new THREE.Vector3(point.x, point.y, 0);
}

function dot(a: Vec2, b: Vec2) {
  return a.x * b.x + a.y * b.y;
}

function perpendicular(vector: Vec2): Vec2 {
  return {
    x: -vector.y,
    y: vector.x,
  };
}

function capsuleInfluence(point: Vec2, start: Vec2, end: Vec2, radius: number): CapsuleInfluence {
  const segment = subtract(end, start);
  const segmentLengthSq = segment.x * segment.x + segment.y * segment.y;
  const along = segmentLengthSq > 0.000001 ? clamp(dot(subtract(point, start), segment) / segmentLengthSq, 0, 1) : 0.5;
  const closest = {
    x: start.x + segment.x * along,
    y: start.y + segment.y * along,
  };
  const distanceToSegment = Math.hypot(point.x - closest.x, point.y - closest.y);
  const normalized = clamp(1 - distanceToSegment / Math.max(radius, 0.0001), 0, 1);
  const weight = normalized * normalized * (3 - 2 * normalized);

  return {
    along,
    closest,
    distance: distanceToSegment,
    weight,
  };
}

function smoothstep(edge0: number, edge1: number, value: number) {
  const t = clamp((value - edge0) / Math.max(edge1 - edge0, 0.0001), 0, 1);

  return t * t * (3 - 2 * t);
}

function createGlowTexture(innerOpacity: number, outerOpacity: number) {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("2D context unavailable");
  }

  const gradient = context.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, `rgba(255,255,255,${innerOpacity})`);
  gradient.addColorStop(0.38, "rgba(255,255,255,0.88)");
  gradient.addColorStop(0.68, "rgba(255,255,255,0.34)");
  gradient.addColorStop(1, `rgba(255,255,255,${outerOpacity})`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  return new THREE.CanvasTexture(canvas);
}

function createOrbitalArcTexture() {
  const size = 192;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("2D context unavailable");
  }

  context.clearRect(0, 0, size, size);
  context.lineCap = "round";
  const center = size / 2;
  const arcRadius = center - 18;
  const highlightRadius = center - 30;

  const drawFadedArc = (
    radius: number,
    startAngle: number,
    endAngle: number,
    maxWidth: number,
    maxAlpha: number,
    segments: number,
  ) => {
    for (let segmentIndex = 0; segmentIndex < segments; segmentIndex += 1) {
      const fromT = segmentIndex / segments;
      const toT = (segmentIndex + 1) / segments;
      const fade = Math.sin(Math.PI * ((fromT + toT) * 0.5)) ** 1.9;
      if (fade < 0.02) {
        continue;
      }

      const fromAngle = lerp(startAngle, endAngle, fromT);
      const toAngle = lerp(startAngle, endAngle, toT);
      context.strokeStyle = `rgba(255,255,255,${maxAlpha * fade})`;
      context.lineWidth = maxWidth * (0.18 + fade * 0.82);
      context.beginPath();
      context.arc(center, center, radius, fromAngle, toAngle);
      context.stroke();
    }
  };

  drawFadedArc(arcRadius, -0.2 * Math.PI, 0.26 * Math.PI, 8, 0.94, 38);
  drawFadedArc(highlightRadius, 1.22 * Math.PI, 1.56 * Math.PI, 3.2, 0.46, 22);

  context.fillStyle = "rgba(255,255,255,0.74)";
  context.beginPath();
  context.arc(center + Math.cos(0.26 * Math.PI) * arcRadius, center + Math.sin(0.26 * Math.PI) * arcRadius, 3.2, 0, Math.PI * 2);
  context.fill();

  return new THREE.CanvasTexture(canvas);
}

const VOID = new THREE.Color("#06030B");
const SHADOW_PLUM = new THREE.Color("#170C25");
const LENSING_VIOLET = new THREE.Color("#6D47FF");
const ACCRETION_PINK = new THREE.Color("#F83EA5");
const ION_CYAN = new THREE.Color("#7FEBFF");
const EVENT_GOLD = new THREE.Color("#FFD166");
const HOT_HALO = new THREE.Color("#FFF1A6");

function createDefaultViewportMapping(canvas: HTMLCanvasElement) {
  const viewportWidth = canvas.clientWidth || window.innerWidth || 1;
  const viewportHeight = canvas.clientHeight || window.innerHeight || 1;

  return createViewportMapping({
    viewportWidth,
    viewportHeight,
    videoWidth: viewportWidth,
    videoHeight: viewportHeight,
  });
}

function createDynamicAttribute(array: Float32Array, itemSize: number) {
  return new THREE.BufferAttribute(array, itemSize).setUsage(THREE.DynamicDrawUsage);
}

export class ParticleFieldRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private readonly onQualityChange: (tier: QualityTier) => void;
  private readonly onStats: (frameMs: number) => void;
  private readonly reducedMotion: boolean;
  private tier: QualityTier = "medium";
  private profile = getQualityProfile("medium", false);
  private viewportMapping: ViewportMapping;
  private interaction: InteractionState = {
    hands: [],
    handsDetected: false,
    primaryGesture: "idle",
    dualActive: false,
    paletteBias: 0,
    dualDistance: 0,
    dualCloseness: 0,
    dualDepthDelta: 0,
    dualDepthAmount: 0,
    lastUpdated: 0,
  };
  private running = false;
  private paused = false;
  private rafId = 0;
  private lastFrame = 0;
  private frameMs = 16.7;
  private qualityDrift = 0;
  private pointScale = 3;
  private overlayScale = 1;
  private renderTime = 0;
  private particles!: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private particleBuffers!: ParticleBuffers;
  private readonly implosionBloom: THREE.Sprite;
  private palmRings: HandRingParticleSystem[] = [];
  private palmRingDetails: HandRingParticleSystem[] = [];
  private palmOrbitArcs: THREE.Sprite[] = [];
  private palmCores: THREE.Sprite[] = [];
  private tipSprites: THREE.Sprite[][] = [];
  private trailLines: THREE.Line[] = [];
  private handWireframes: HandWireframeVisual[] = [];
  private glowTexture = createGlowTexture(1, 0);
  private orbitalArcTexture = createOrbitalArcTexture();
  private readonly palettePrimary = new THREE.Color(LENSING_VIOLET);
  private readonly paletteSecondary = new THREE.Color(LENSING_VIOLET);
  private readonly paletteHighlight = new THREE.Color(EVENT_GOLD);
  private readonly paletteTrail = new THREE.Color(LENSING_VIOLET);
  private readonly paletteVoid = new THREE.Color(VOID);
  private readonly paletteShadow = new THREE.Color(SHADOW_PLUM);
  private readonly paletteHalo = new THREE.Color(HOT_HALO);
  private dualImplosion: DualImplosionState = this.createIdleImplosionState();
  private wireframeMode = false;

  constructor(canvas: HTMLCanvasElement, { tier, reducedMotion, onQualityChange, onStats }: RendererOptions) {
    this.onQualityChange = onQualityChange;
    this.onStats = onStats;
    this.reducedMotion = reducedMotion;
    this.viewportMapping = createDefaultViewportMapping(canvas);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.camera.position.z = 2;
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    this.implosionBloom = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: this.paletteHighlight.clone(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      }),
    );
    this.implosionBloom.visible = false;
    this.scene.add(this.implosionBloom);
    this.applyViewportMapping(this.viewportMapping.sceneHalfWidth, false);
    this.createHandsVisuals();
    this.setQualityTier(tier, false);
  }

  setInteraction(interaction: InteractionState) {
    this.interaction = interaction;
  }

  setWireframeMode(enabled: boolean) {
    this.wireframeMode = enabled;
    if (this.particles) {
      this.particles.visible = true;
    }
    if (enabled) {
      this.implosionBloom.visible = false;
    }
  }

  private createIdleImplosionState(): DualImplosionState {
    return {
      phase: "idle",
      elapsed: 0,
      holdMs: 0,
      armed: true,
      cooldownElapsed: 0,
      center: null,
      radius: 0,
      axis: { x: 1, y: 0 },
      openField: 0,
      paletteBias: this.interaction.paletteBias,
      releaseBurstStrength: 0,
    };
  }

  setViewportMapping(mapping: ViewportMapping) {
    const previousHalfWidth = this.viewportMapping.sceneHalfWidth;
    this.viewportMapping = mapping;
    this.applyViewportMapping(previousHalfWidth);
  }

  updateQualityTier(tier: QualityTier) {
    if (tier !== this.tier) {
      this.setQualityTier(tier, false);
    }
  }

  setPaused(paused: boolean) {
    this.paused = paused;

    if (!paused && this.running && !this.rafId) {
      this.rafId = window.requestAnimationFrame(this.animate);
    }
  }

  start() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.lastFrame = performance.now();
    this.rafId = window.requestAnimationFrame(this.animate);
  }

  stop() {
    this.running = false;
    if (this.rafId) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  dispose() {
    this.stop();
    this.renderer.dispose();
    this.glowTexture.dispose();
    this.orbitalArcTexture.dispose();
    this.scene.traverse((child) => {
      const maybeWithGeometry = child as THREE.Object3D & { geometry?: { dispose?: () => void } };
      if (maybeWithGeometry.geometry) {
        maybeWithGeometry.geometry.dispose?.();
      }

      const maybeWithMaterial = child as THREE.Object3D & {
        material?: { dispose?: () => void } | Array<{ dispose?: () => void }>;
      };
      if (maybeWithMaterial.material) {
        const material = maybeWithMaterial.material;
        if (Array.isArray(material)) {
          material.forEach((entry) => entry.dispose?.());
        } else {
          material.dispose?.();
        }
      }
    });
  }

  private setQualityTier(tier: QualityTier, emit = true) {
    this.tier = tier;
    this.profile = getQualityProfile(tier, this.reducedMotion);
    this.applyViewportMapping(this.viewportMapping.sceneHalfWidth, false);
    this.buildParticles();

    if (emit) {
      this.onQualityChange(tier);
    }
  }

  private applyViewportMapping(previousHalfWidth: number, remapParticles = true) {
    const { viewportWidth, viewportHeight, sceneHalfWidth } = this.viewportMapping;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.profile.dprCap);

    this.camera.left = -sceneHalfWidth;
    this.camera.right = sceneHalfWidth;
    this.camera.top = 1;
    this.camera.bottom = -1;
    this.camera.updateProjectionMatrix();

    this.pointScale = Math.max(1.7, Math.min(viewportWidth, viewportHeight) / 300);
    this.overlayScale = clamp(390 / Math.max(320, Math.min(viewportWidth, viewportHeight)), 0.72, 1.08);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(viewportWidth, viewportHeight, false);

    if (remapParticles && this.particleBuffers) {
      this.remapParticleField(previousHalfWidth);
    }
  }

  private remapParticleField(previousHalfWidth: number) {
    const { positions, velocities } = this.particleBuffers;
    const nextHalfWidth = this.viewportMapping.sceneHalfWidth;
    const positionScaleX = nextHalfWidth / Math.max(previousHalfWidth, 0.0001);
    const horizontalLimit = nextHalfWidth * 1.12;

    for (let index = 0; index < positions.length / 3; index += 1) {
      const positionIndex = index * 3;
      const velocityIndex = index * 2;
      positions[positionIndex] = clamp(positions[positionIndex] * positionScaleX, -horizontalLimit, horizontalLimit);
      velocities[velocityIndex] *= positionScaleX;
    }

    this.particles.geometry.attributes.position.needsUpdate = true;
  }

  private createBiasPalette(bias: number, energy: number): BiasPalette {
    const mix = clamp((bias + 1) * 0.5, 0, 1);
    const biasMagnitude = Math.abs(bias);
    const biasWave = ION_CYAN.clone().lerp(ACCRETION_PINK, mix);
    const accentCool = LENSING_VIOLET.clone().lerp(ION_CYAN, 0.32 + (1 - mix) * 0.58);
    const accentWarm = LENSING_VIOLET.clone().lerp(ACCRETION_PINK, 0.32 + mix * 0.58);
    const biasColor = LENSING_VIOLET.clone().lerp(biasWave, 0.24 + biasMagnitude * 0.62);
    const secondaryColor = LENSING_VIOLET.clone().lerp(biasWave, 0.14 + biasMagnitude * 0.3);
    const trailColor = accentCool.clone().lerp(accentWarm, mix).lerp(LENSING_VIOLET, 0.18);
    const energyColor = biasColor.clone().lerp(EVENT_GOLD, 0.1 + energy * 0.42);
    const haloColor = biasColor.clone().lerp(HOT_HALO, 0.08 + energy * 0.18);
    const coreColor = secondaryColor.clone().lerp(biasColor, 0.38).lerp(HOT_HALO, energy * 0.1);
    const shadowColor = SHADOW_PLUM.clone().lerp(LENSING_VIOLET, 0.22 + biasMagnitude * 0.08);

    return {
      biasColor,
      secondaryColor,
      accentCool,
      accentWarm,
      trailColor,
      energyColor,
      haloColor,
      coreColor,
      shadowColor,
    };
  }

  private createRingParticleSystem({
    count,
    sizeRange,
    alphaRange,
  }: {
    count: number;
    sizeRange: [number, number];
    alphaRange: [number, number];
  }): HandRingParticleSystem {
    const positions = new Float32Array(count * 3);
    const previousPositions = new Float32Array(count * 2);
    const sizes = new Float32Array(count);
    const alphas = new Float32Array(count);
    const trails = new Float32Array(count * 2);
    const angles = new Float32Array(count);
    const radialOffsets = new Float32Array(count);
    const phaseOffsets = new Float32Array(count);

    for (let index = 0; index < count; index += 1) {
      angles[index] = (index / count) * Math.PI * 2 + THREE.MathUtils.randFloatSpread(0.06);
      radialOffsets[index] = THREE.MathUtils.randFloatSpread(1);
      phaseOffsets[index] = Math.random();
      sizes[index] = THREE.MathUtils.randFloat(sizeRange[0], sizeRange[1]) * this.overlayScale;
      alphas[index] = THREE.MathUtils.randFloat(alphaRange[0], alphaRange[1]);
      previousPositions[index * 2] = 0;
      previousPositions[index * 2 + 1] = 0;
    }

      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", createDynamicAttribute(positions, 3));
      geometry.setAttribute("aSize", createDynamicAttribute(sizes, 1));
      geometry.setAttribute("aAlpha", createDynamicAttribute(alphas, 1));
      geometry.setAttribute("aTrail", createDynamicAttribute(trails, 2));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: this.palettePrimary.clone() },
        uHalo: { value: this.paletteSecondary.clone() },
        uOpacity: { value: 0 },
      },
      vertexShader: `
        attribute float aSize;
        attribute float aAlpha;
        attribute vec2 aTrail;
        uniform float uOpacity;
        varying float vAlpha;
        varying vec2 vTrail;
        varying float vTrailMagnitude;
        void main() {
          vAlpha = aAlpha;
          vTrail = aTrail;
          vTrailMagnitude = clamp(length(aTrail), 0.0, 1.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (1.22 + vTrailMagnitude * 0.82);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform vec3 uHalo;
        uniform float uOpacity;
        varying float vAlpha;
        varying vec2 vTrail;
        varying float vTrailMagnitude;
        void main() {
          vec2 uv = gl_PointCoord - vec2(0.5);
          vec2 direction = vTrailMagnitude > 0.0001 ? normalize(vTrail) : vec2(0.0, 1.0);
          vec2 perpendicularDirection = vec2(-direction.y, direction.x);
          float along = dot(uv, direction);
          float across = dot(uv, perpendicularDirection);
          float radial = length(uv);
          float head = smoothstep(0.62, 0.04, radial);
          float softGlow = smoothstep(0.86, 0.1, radial);
          float tailBody = exp(-pow(across * 4.0, 2.0)) * smoothstep(0.34, -0.4, along);
          float tailGlow = exp(-pow(across * 2.8, 2.0)) * smoothstep(0.26, -0.56, along);
          float tail = (tailBody * 0.82 + tailGlow * 0.42) * vTrailMagnitude;
          float alpha = max(head, tail) * vAlpha * uOpacity + softGlow * (0.18 + vTrailMagnitude * 0.08) * uOpacity;
          vec3 color = mix(uColor, uHalo, smoothstep(0.52, 0.0, radial) * 0.54 + vTrailMagnitude * 0.24);
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

    const points = new THREE.Points(geometry, material);
    points.frustumCulled = false;
    points.visible = false;

    return {
      points,
      buffers: {
        positions,
        previousPositions,
        sizes,
        alphas,
        trails,
        angles,
        radialOffsets,
        phaseOffsets,
      },
    };
  }

  private updateRingParticleSystem(
    system: HandRingParticleSystem,
    options: {
      center: Vec2;
      rotation: number;
      radiusX: number;
      radiusY: number;
      color: THREE.Color;
      haloColor: THREE.Color;
      opacity: number;
      jitterAmplitude: number;
      driftSpeed: number;
      time: number;
      flowAmount: number;
      zOffset: number;
    },
  ) {
    const { positions, previousPositions, trails, angles, radialOffsets, phaseOffsets } = system.buffers;
    const geometry = system.points.geometry;
    const material = system.points.material;
    const cosRotation = Math.cos(options.rotation);
    const sinRotation = Math.sin(options.rotation);

    material.uniforms.uColor.value.copy(options.color);
    material.uniforms.uHalo.value.copy(options.haloColor);
    material.uniforms.uOpacity.value = options.opacity;

    for (let index = 0; index < angles.length; index += 1) {
      const orbitalRate = options.time * options.driftSpeed * (1 + (phaseOffsets[index] - 0.5) * 0.08);
      const angle =
        angles[index] +
        orbitalRate +
        Math.sin(options.time * (0.56 + phaseOffsets[index] * 0.68) + phaseOffsets[index] * Math.PI * 2) * options.flowAmount;
      const radialJitter =
        radialOffsets[index] * options.jitterAmplitude +
        Math.sin(options.time * (0.92 + phaseOffsets[index] * 0.84) + phaseOffsets[index] * Math.PI * 4) * options.jitterAmplitude * 0.18;
      const radiusX = Math.max(0.001, options.radiusX + radialJitter);
      const radiusY = Math.max(0.001, options.radiusY + radialJitter);
      const localX = Math.cos(angle) * radiusX;
      const localY = Math.sin(angle) * radiusY;
      const x = options.center.x + localX * cosRotation - localY * sinRotation;
      const y = options.center.y + localX * sinRotation + localY * cosRotation;
      const positionIndex = index * 3;
      const previousIndex = index * 2;
      const previousX = previousPositions[previousIndex];
      const previousY = previousPositions[previousIndex + 1];
      const deltaX = x - previousX;
      const deltaY = y - previousY;
      const deltaLength = Math.hypot(deltaX, deltaY);
      const trailStrength = clamp(deltaLength / 0.014, 0, 1);
      const trailDirection =
        deltaLength > 0.0001
          ? {
              x: deltaX / deltaLength,
              y: deltaY / deltaLength,
            }
          : { x: 0, y: 0 };

      positions[positionIndex] = x;
      positions[positionIndex + 1] = y;
      positions[positionIndex + 2] = options.zOffset;
      trails[previousIndex] = trailDirection.x * trailStrength;
      trails[previousIndex + 1] = trailDirection.y * trailStrength;
      previousPositions[previousIndex] = x;
      previousPositions[previousIndex + 1] = y;
    }

    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aTrail.needsUpdate = true;
    system.points.visible = options.opacity > 0.01;
  }

  private updatePalette(
    bias: number,
    energy: number,
    depth: {
      center: Vec2 | null;
      axis: Vec2;
      radius: number;
      amount: number;
      bias: number;
    },
  ) {
    const palette = this.createBiasPalette(bias, energy);
    this.palettePrimary.copy(palette.biasColor);
    this.paletteSecondary.copy(palette.secondaryColor);
    this.paletteHighlight.copy(palette.energyColor);
    this.paletteTrail.copy(palette.trailColor);
    this.paletteVoid.copy(VOID);
    this.paletteShadow.copy(palette.shadowColor);
    this.paletteHalo.copy(palette.haloColor);

    if (this.particles) {
      const material = this.particles.material;
      material.uniforms.uColorVoid.value.copy(this.paletteVoid);
      material.uniforms.uColorShadow.value.copy(this.paletteShadow);
      material.uniforms.uColorViolet.value.copy(LENSING_VIOLET);
      material.uniforms.uColorAccentCool.value.copy(palette.accentCool);
      material.uniforms.uColorAccentWarm.value.copy(palette.accentWarm);
      material.uniforms.uColorBias.value.copy(palette.biasColor);
      material.uniforms.uColorEnergy.value.copy(this.paletteHighlight);
      material.uniforms.uColorHalo.value.copy(this.paletteHalo);
      material.uniforms.uDepthCenter.value.set(depth.center?.x ?? 0, depth.center?.y ?? 0);
      material.uniforms.uDepthAxis.value.set(depth.axis.x, depth.axis.y);
      material.uniforms.uDepthRadius.value = depth.radius;
      material.uniforms.uDepthAmount.value = depth.amount;
      material.uniforms.uDepthBias.value = depth.bias;
    }
  }

  private buildParticles() {
    const geometry = new THREE.BufferGeometry();
    const count = this.profile.particleCount;
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 2);
    const sizes = new Float32Array(count);
    const alphas = new Float32Array(count);
    const seeds = new Float32Array(count);
    const depthLayers = new Float32Array(count);
    const toneMixes = new Float32Array(count);
    const energies = new Float32Array(count);
    const speedLights = new Float32Array(count);
    const baseSizes = new Float32Array(count);
    const halfWidth = this.viewportMapping.sceneHalfWidth;

    for (let index = 0; index < count; index += 1) {
      const positionIndex = index * 3;
      const velocityIndex = index * 2;
      positions[positionIndex] = THREE.MathUtils.randFloat(-halfWidth, halfWidth);
      positions[positionIndex + 1] = THREE.MathUtils.randFloatSpread(2);
      positions[positionIndex + 2] = THREE.MathUtils.randFloat(-0.06, 0.08);
      velocities[velocityIndex] = THREE.MathUtils.randFloatSpread(0.0014);
      velocities[velocityIndex + 1] = THREE.MathUtils.randFloatSpread(0.0014);
      seeds[index] = Math.random();
      depthLayers[index] = THREE.MathUtils.randFloat(-1, 1);
      const sizeSeed = Math.random();
      if (sizeSeed < 0.24) {
        baseSizes[index] = THREE.MathUtils.randFloat(0.7, 1.6);
      } else if (sizeSeed < 0.84) {
        baseSizes[index] = THREE.MathUtils.randFloat(2.1, 4.8);
      } else {
        baseSizes[index] = THREE.MathUtils.randFloat(5.6, 8.6);
      }
      sizes[index] = baseSizes[index] * this.pointScale;
      alphas[index] = THREE.MathUtils.randFloat(0.3, 0.8);
      toneMixes[index] = THREE.MathUtils.randFloat(0.34, 0.74);
      energies[index] = 0;
      speedLights[index] = 0;
    }

      geometry.setAttribute("position", createDynamicAttribute(positions, 3));
      geometry.setAttribute("aSize", createDynamicAttribute(sizes, 1));
      geometry.setAttribute("aAlpha", createDynamicAttribute(alphas, 1));
      geometry.setAttribute("aDepth", new THREE.BufferAttribute(depthLayers, 1));
      geometry.setAttribute("aTone", createDynamicAttribute(toneMixes, 1));
      geometry.setAttribute("aEnergy", createDynamicAttribute(energies, 1));
      geometry.setAttribute("aSpeedLight", createDynamicAttribute(speedLights, 1));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColorVoid: { value: this.paletteVoid.clone() },
        uColorShadow: { value: this.paletteShadow.clone() },
        uColorViolet: { value: LENSING_VIOLET.clone() },
        uColorAccentCool: { value: ION_CYAN.clone() },
        uColorAccentWarm: { value: this.palettePrimary.clone() },
        uColorBias: { value: this.palettePrimary.clone() },
        uColorEnergy: { value: this.paletteHighlight.clone() },
        uColorHalo: { value: this.paletteHalo.clone() },
        uDepthCenter: { value: new THREE.Vector2(0, 0) },
        uDepthAxis: { value: new THREE.Vector2(1, 0) },
        uDepthRadius: { value: 1 },
        uDepthAmount: { value: 0 },
        uDepthBias: { value: 0 },
      },
      vertexShader: `
        attribute float aSize;
        attribute float aAlpha;
        attribute float aDepth;
        attribute float aTone;
        attribute float aEnergy;
        attribute float aSpeedLight;
        uniform vec2 uDepthCenter;
        uniform vec2 uDepthAxis;
        uniform float uDepthRadius;
        uniform float uDepthAmount;
        uniform float uDepthBias;
        varying float vAlpha;
        varying float vTone;
        varying float vEnergy;
        varying float vDepth;
        varying float vSpeedLight;
        void main() {
          vec2 position2d = position.xy;
          vec2 relative = position2d - uDepthCenter;
          float axisDistance = dot(relative, uDepthAxis);
          float sideNorm = clamp(axisDistance / max(uDepthRadius, 0.0001), -1.0, 1.0);
          float forwardness = sideNorm * sign(uDepthBias);
          float parallax = aDepth * uDepthAmount * forwardness;
          vec2 depthPerpendicular = vec2(-uDepthAxis.y, uDepthAxis.x);
          vec2 shifted = position2d + uDepthAxis * parallax * 0.16 + depthPerpendicular * parallax * 0.05 * forwardness;
          vAlpha = aAlpha;
          vTone = aTone;
          vEnergy = aEnergy;
          vDepth = clamp(0.5 + parallax * 1.25, 0.0, 1.0);
          vSpeedLight = aSpeedLight;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(shifted, position.z + parallax * 0.08, 1.0);
          gl_PointSize = aSize * clamp(1.0 + parallax * 0.35, 0.72, 1.45);
        }
      `,
      fragmentShader: `
        uniform vec3 uColorVoid;
        uniform vec3 uColorShadow;
        uniform vec3 uColorViolet;
        uniform vec3 uColorAccentCool;
        uniform vec3 uColorAccentWarm;
        uniform vec3 uColorBias;
        uniform vec3 uColorEnergy;
        uniform vec3 uColorHalo;
        varying float vAlpha;
        varying float vTone;
        varying float vEnergy;
        varying float vDepth;
        varying float vSpeedLight;
        void main() {
          vec2 uv = gl_PointCoord - vec2(0.5);
          float dist = length(uv);
          float alpha = smoothstep(0.56, 0.02, dist) * vAlpha;
          float tone = clamp(vTone, 0.0, 1.0);
          float energy = clamp(vEnergy, 0.0, 1.0);
          float speedLight = clamp(vSpeedLight, 0.0, 1.0);
          float innerCore = smoothstep(0.22, 0.0, dist);
          float coreHalo = smoothstep(0.36, 0.02, dist);
          vec3 base = mix(uColorShadow, uColorViolet, smoothstep(0.04, 0.64, tone));
          vec3 gesture = mix(uColorViolet, uColorBias, 0.18 + smoothstep(0.12, 0.88, tone) * 0.82);
          vec3 accent = mix(uColorAccentCool, uColorAccentWarm, clamp(0.5 + vDepth * 0.18 + tone * 0.1, 0.0, 1.0));
          vec3 color = mix(base, gesture, 0.54 + tone * 0.18);
          color = mix(color, accent, 0.2 + tone * 0.12 + energy * 0.08);
          color = mix(color, uColorVoid, smoothstep(0.36, 0.98, energy) * smoothstep(0.1, 0.0, dist) * 0.14);
          color = mix(color, uColorEnergy, smoothstep(0.34, 0.9, energy) * 0.42);
          color = mix(color, uColorHalo, smoothstep(0.84, 1.0, energy) * 0.28);
          color = mix(color, uColorHalo, innerCore * (0.2 + tone * 0.18 + speedLight * 0.16));
          color = mix(color, uColorEnergy, innerCore * (energy * 0.12 + speedLight * 0.08));
          alpha += coreHalo * (0.08 + tone * 0.06 + speedLight * 0.08) * vAlpha;
          alpha *= 0.88 + tone * 0.22 + energy * 0.16 + speedLight * 0.12;
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

    const particles = new THREE.Points(geometry, material);
    particles.frustumCulled = false;
    particles.visible = !this.wireframeMode;

    if (this.particles) {
      this.scene.remove(this.particles);
      this.particles.geometry.dispose();
      this.particles.material.dispose();
    }

    this.particles = particles;
    this.particleBuffers = {
      positions,
      velocities,
      sizes,
      alphas,
      seeds,
      depthLayers,
      toneMixes,
      energies,
      speedLights,
      baseSizes,
    };
    this.scene.add(this.particles);
    this.updatePalette(this.interaction.paletteBias, 0, {
      center: null,
      axis: { x: 1, y: 0 },
      radius: 1,
      amount: 0,
      bias: 0,
    });
  }

  private createHandsVisuals() {
    for (let handIndex = 0; handIndex < 2; handIndex += 1) {
      const ring = this.createRingParticleSystem({
        count: 52,
        sizeRange: [6.8, 10.6],
        alphaRange: [0.72, 1],
      });
      const detail = this.createRingParticleSystem({
        count: 30,
        sizeRange: [4.2, 6.8],
        alphaRange: [0.52, 0.88],
      });
      const orbitalMaterial = new THREE.SpriteMaterial({
        map: this.orbitalArcTexture,
        color: this.paletteHighlight.clone(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const coreMaterial = new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: this.palettePrimary.clone(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const orbital = new THREE.Sprite(orbitalMaterial);
      const core = new THREE.Sprite(coreMaterial);
      orbital.visible = false;
      core.visible = false;
      this.palmRings.push(ring);
      this.palmRingDetails.push(detail);
      this.palmOrbitArcs.push(orbital);
      this.palmCores.push(core);
      this.scene.add(ring.points, detail.points, orbital, core);

      const tipGroup: THREE.Sprite[] = [];
      for (let tipIndex = 0; tipIndex < 5; tipIndex += 1) {
        const tip = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: this.glowTexture,
            color: (tipIndex % 2 === 0 ? this.palettePrimary : this.paletteSecondary).clone(),
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
          }),
        );
        tip.visible = false;
        tipGroup.push(tip);
        this.scene.add(tip);
      }
      this.tipSprites.push(tipGroup);

      const trailGeometry = new THREE.BufferGeometry();
        trailGeometry.setAttribute("position", createDynamicAttribute(new Float32Array(24 * 3), 3));
      const trail = new THREE.Line(
        trailGeometry,
        new THREE.LineBasicMaterial({
          color: (handIndex === 0 ? this.palettePrimary : this.paletteSecondary).clone(),
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      trail.frustumCulled = false;
      this.trailLines.push(trail);
      this.scene.add(trail);

      const wireframePositions = new Float32Array(HAND_CONNECTIONS.length * 2 * 3);
      const wireframeGeometry = new THREE.BufferGeometry();
        wireframeGeometry.setAttribute("position", createDynamicAttribute(wireframePositions, 3));
      const wireframeLine = new THREE.LineSegments(
        wireframeGeometry,
        new THREE.LineBasicMaterial({
          color: this.paletteSecondary.clone(),
          transparent: true,
          opacity: 0,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
        }),
      );
      wireframeLine.frustumCulled = false;
      wireframeLine.visible = false;
      this.handWireframes.push({
        line: wireframeLine,
        positions: wireframePositions,
      });
      this.scene.add(wireframeLine);
    }
  }

  private readonly animate = (time: number) => {
    if (!this.running || this.paused) {
      this.rafId = 0;
      return;
    }

    const delta = Math.min(0.035, Math.max(0.012, (time - this.lastFrame) / 1000));
    this.lastFrame = time;
    this.renderTime = time * 0.001;
    const frameMs = delta * 1000;
    this.frameMs = lerp(this.frameMs, frameMs, 0.08);
    this.onStats(this.frameMs);

    this.updateParticles(time * 0.001, delta);
    this.updateHandsVisuals();
    this.updateImplosionVisual();
    this.renderer.render(this.scene, this.camera);
    this.adjustQuality();

    this.rafId = window.requestAnimationFrame(this.animate);
  };

  private updateParticles(time: number, delta: number) {
    const paletteBias = this.dualImplosion.phase === "idle" ? this.interaction.paletteBias : this.dualImplosion.paletteBias;
    const { positions, velocities, sizes, alphas, seeds, depthLayers, toneMixes, energies, speedLights, baseSizes } =
      this.particleBuffers;
    const activeHands = this.interaction.hands.map((hand) => ({
      ...hand,
      scenePalm: hand.palm,
      sceneVelocity: scale(hand.velocity, 0.025),
      sceneRadius: Math.max(
        0.18,
        Math.max(hand.ellipseRadiusX, hand.ellipseRadiusY) *
          (3.6 + hand.attractionAmount * 5.6 + hand.openImpulseAmount * 5.4),
      ),
    }));
    const dualCenter =
      this.interaction.dualActive && activeHands.length > 1
        ? average(activeHands.map((hand) => hand.palm))
        : null;
    const targetRadius = dualCenter ? Math.max(0.14, this.interaction.dualDistance * 0.5) : 0;
    const dualHandsSpan = dualCenter && activeHands.length > 1 ? subtract(activeHands[1].palm, activeHands[0].palm) : { x: 1, y: 0 };
    const dualAxis = normalize(dualHandsSpan);
    const dualPerpendicular = perpendicular(dualAxis);
    const edgeBandWidth = targetRadius > 0 ? Math.max(0.08, targetRadius * 0.26) : 0;
    const coreRadius = targetRadius > 0 ? Math.max(0.05, targetRadius * 0.3) : 0;
    const implosionRadius = targetRadius > 0 ? Math.min(coreRadius * 1.35, targetRadius * 0.45) : 0;
    const closeness = this.interaction.dualCloseness;
    const openField = 1 - closeness;
    const distanceCompressionBias = computeDistanceCompressionBias(closeness);
    const dualCompressionHold =
      dualCenter && activeHands.length > 1 ? smoothstep(0.42, 0.82, Math.min(activeHands[0].closure, activeHands[1].closure)) : 0;
    const dualCompressionImpulse =
      dualCenter && activeHands.length > 1
        ? Math.min(activeHands[0].closingImpulseAmount, activeHands[1].closingImpulseAmount)
        : 0;
    const rawDualCompressionStrength = clamp(dualCompressionHold + dualCompressionImpulse * 0.6, 0, 1);
    const effectiveCompressionStrength = rawDualCompressionStrength * distanceCompressionBias;
    const releaseBurstStrength = computeReleaseBurstStrength(closeness);
    const releaseActive = this.dualImplosion.phase === "release";
    const flashActive = this.dualImplosion.phase === "flash";
    const cooldownActive = this.dualImplosion.phase === "cooldown";
    const recoveryRamp = cooldownActive ? smoothstep(0.12, 1, this.dualImplosion.cooldownElapsed / 650) : 0;
    const cooldownCenterMultiplier = releaseActive ? 0 : flashActive ? 0.06 : cooldownActive ? lerp(0.1, 0.92, recoveryRamp) : 1;
    const centerPullStrength = (0.00095 + closeness * 0.0021 + effectiveCompressionStrength * 0.0034) * cooldownCenterMultiplier;
    const outerReturnStrength =
      (0.0016 + closeness * 0.0018 + effectiveCompressionStrength * 0.0018) *
      (releaseActive ? 0.42 : flashActive ? 0.58 : cooldownActive ? lerp(0.68, 0.96, recoveryRamp) : 1);
    const orbitalStrength =
      (0.00008 + openField * 0.00048) *
      (1 - effectiveCompressionStrength * 0.72) *
      (releaseActive ? 1.48 : flashActive ? 1.42 : cooldownActive ? lerp(1.3, 1.08, recoveryRamp) : 1);
    const nebulaInfluence = clamp(
      0.12 + openField * 0.82 + (releaseActive ? 0.16 : flashActive ? 0.18 : cooldownActive ? lerp(0.16, 0.04, recoveryRamp) : 0),
      0,
      1,
    );
    const nebulaRadius = targetRadius > 0 ? Math.max(0.1, targetRadius * (0.54 + openField * 0.34)) : 0;
    const dualLeftPalm = activeHands[0]?.palm ?? dualCenter;
    const dualRightPalm = activeHands[1]?.palm ?? dualCenter;
    const horizontalLimit = this.viewportMapping.sceneHalfWidth * 1.12;
    const implosionPhase = this.dualImplosion.phase;
    const implosionCenter = this.dualImplosion.center;
    const depthBias = this.interaction.dualDepthDelta;
    const depthAmount = this.interaction.dualActive ? this.interaction.dualDepthAmount : 0;
    const flashStrength =
      implosionPhase === "flash" ? 1 - clamp(this.dualImplosion.elapsed / 0.14, 0, 1) : 0;
    const paletteEnergy = clamp(
      effectiveCompressionStrength * 0.2 +
        (implosionPhase === "gather" ? 0.14 : 0) +
        (implosionPhase === "implode" ? 0.48 : 0) +
        (implosionPhase === "release" ? 0.34 : 0) +
        flashStrength * 0.26,
      0,
      1,
    );
    this.updatePalette(paletteBias, paletteEnergy, {
      center: dualCenter,
      axis: dualAxis,
      radius: Math.max(targetRadius, 0.22),
      amount: depthAmount,
      bias: depthBias,
    });

    for (let index = 0; index < baseSizes.length; index += 1) {
      const positionIndex = index * 3;
      const velocityIndex = index * 2;
      let x = positions[positionIndex];
      let y = positions[positionIndex + 1];
      let velocityX = velocities[velocityIndex];
      let velocityY = velocities[velocityIndex + 1];
      let glow = 0.22 + Math.sin(time * 1.2 + seeds[index] * 10) * 0.08;
      let tone = 0.18 + depthLayers[index] * 0.04;
      let energy = 0;

      const ambientAngle =
        Math.sin((y + time * 0.11 + seeds[index]) * 3.9) +
        Math.cos((x - time * 0.09 - seeds[index]) * 4.6);

      velocityX += Math.cos(ambientAngle) * 0.00042;
      velocityY += Math.sin(ambientAngle) * 0.00034;

      if ((implosionPhase === "gather" || implosionPhase === "implode" || implosionPhase === "release") && implosionCenter) {
        const point = { x, y };
        const offsetFromCenter = subtract(point, implosionCenter);
        const pointDistance = Math.max(0.0001, Math.hypot(offsetFromCenter.x, offsetFromCenter.y));
        const inward = normalize(subtract(implosionCenter, point));
        const burstStrength = implosionPhase === "release" ? this.dualImplosion.releaseBurstStrength : 0;
        const outward =
          pointDistance > 0.014
            ? normalize(offsetFromCenter)
            : normalize({
                x: Math.cos(seeds[index] * Math.PI * 2) + this.dualImplosion.axis.x * 0.35,
                y: Math.sin(seeds[index] * Math.PI * 2) + this.dualImplosion.axis.y * 0.35,
              });
        const tangential = normalize(perpendicular(outward));
        const phaseRadius = Math.max(this.dualImplosion.radius, 0.16);
        const phaseProgress =
          implosionPhase === "gather"
            ? clamp(this.dualImplosion.elapsed / 0.12, 0, 1)
            : implosionPhase === "implode"
              ? clamp(this.dualImplosion.elapsed / 0.16, 0, 1)
              : clamp(this.dualImplosion.elapsed / 0.2, 0, 1);

        if (implosionPhase === "gather") {
          const gatherForce = 0.0036 + phaseProgress * 0.0048;
          const orbitalLift = 0.0002 * (1 - phaseProgress);
          velocityX += inward.x * gatherForce * (0.8 + pointDistance / phaseRadius);
          velocityY += inward.y * gatherForce * (0.8 + pointDistance / phaseRadius);
          velocityX += tangential.x * orbitalLift;
          velocityY += tangential.y * orbitalLift;
          glow += 0.34 + (1 - phaseProgress) * 0.18;
        } else {
          if (implosionPhase === "implode") {
            const implodeForce = 0.008 + phaseProgress * 0.012;
            const collapse = 0.08 + phaseProgress * 0.2;
            velocityX += inward.x * implodeForce * (0.9 + pointDistance / phaseRadius);
            velocityY += inward.y * implodeForce * (0.9 + pointDistance / phaseRadius);
            x = lerp(x, implosionCenter.x, collapse);
            y = lerp(y, implosionCenter.y, collapse);
            glow += 0.62 + phaseProgress * 0.48;
          } else {
            const axisSkew = Math.sin(seeds[index] * Math.PI * 6.4);
            const releaseForce = (0.0038 + burstStrength * 0.0068) * (1 - phaseProgress * 0.34);
            const tangentialJitter = (0.00024 + burstStrength * 0.00048) * (1 - phaseProgress);
            const axialStretch = burstStrength * 0.00042 * axisSkew;

            velocityX += outward.x * releaseForce * (0.85 + pointDistance / Math.max(phaseRadius * 0.42, 0.0001));
            velocityY += outward.y * releaseForce * (0.85 + pointDistance / Math.max(phaseRadius * 0.42, 0.0001));
            velocityX += tangential.x * tangentialJitter;
            velocityY += tangential.y * tangentialJitter;
            velocityX += this.dualImplosion.axis.x * axialStretch;
            velocityY += this.dualImplosion.axis.y * axialStretch;
            if (pointDistance < phaseRadius * 0.08) {
              x = lerp(x, implosionCenter.x + outward.x * phaseRadius * (0.16 + burstStrength * 0.12), 0.16);
              y = lerp(y, implosionCenter.y + outward.y * phaseRadius * (0.16 + burstStrength * 0.12), 0.16);
            }
            glow += 0.34 + burstStrength * 0.34 + (1 - phaseProgress) * 0.18;
          }
        }
        tone = clamp(0.42 + (1 - pointDistance / Math.max(phaseRadius, 0.0001)) * 0.44 + burstStrength * 0.08, 0, 1);
        energy = clamp(
          implosionPhase === "gather"
            ? 0.34 + (1 - pointDistance / Math.max(phaseRadius, 0.0001)) * 0.28 + phaseProgress * 0.12
            : implosionPhase === "implode"
              ? 0.74 + (1 - pointDistance / Math.max(phaseRadius, 0.0001)) * 0.26 + phaseProgress * 0.2
              : 0.46 + burstStrength * 0.26 + (1 - phaseProgress) * 0.22,
          0,
          1,
        );
      } else if (dualCenter && targetRadius > 0.06 && dualLeftPalm && dualRightPalm) {
        const point = { x, y };
        const centerToPoint = subtract(point, dualCenter);
        const pointDistance = Math.max(0.0001, Math.hypot(centerToPoint.x, centerToPoint.y));
        const outward = normalize(centerToPoint);
        const inward = { x: -outward.x, y: -outward.y };
        const orbital = normalize(perpendicular(outward));
        const insideField = clamp((pointDistance - coreRadius) / Math.max(targetRadius - coreRadius, 0.0001), 0, 1);
        const edgeProximity = smoothstep(targetRadius - edgeBandWidth, targetRadius, pointDistance);
        const outsideDistance = Math.max(0, pointDistance - targetRadius);
        const outsideWeight = clamp(outsideDistance / Math.max(targetRadius * 0.45, 0.0001), 0, 1);
        const capsule = capsuleInfluence(point, dualLeftPalm, dualRightPalm, nebulaRadius);
        const linePull = normalize(subtract(capsule.closest, point));
        const longitudinalPhase = Math.sin(time * 0.82 + seeds[index] * 11.2 + capsule.along * 2.8);
        const turbulencePhase = Math.cos(time * 1.24 - seeds[index] * 9.1 + pointDistance * 5.7);
        const sideNormalized = clamp(dot(centerToPoint, dualAxis) / Math.max(targetRadius, 0.0001), -1, 1);
        const frontness = sideNormalized * Math.sign(depthBias || 0);
        const depthGlow = depthAmount * Math.max(0, frontness) * (0.32 + depthLayers[index] * 0.38);

        if (pointDistance < coreRadius * 1.45) {
          const coreWeight = 1 - clamp(pointDistance / Math.max(coreRadius * 1.45, 0.0001), 0, 1);
          const coreRepulsionStrength =
            0.00082 + (1 - effectiveCompressionStrength) * 0.0021 + ((releaseActive || flashActive || cooldownActive) ? 0.00022 : 0);
          velocityX += outward.x * coreWeight * (coreRepulsionStrength + coreWeight * 0.0018);
          velocityY += outward.y * coreWeight * (coreRepulsionStrength + coreWeight * 0.0018);
          velocityX += inward.x * coreWeight * effectiveCompressionStrength * 0.00046;
          velocityY += inward.y * coreWeight * effectiveCompressionStrength * 0.00046;
          glow += coreWeight * (0.18 + effectiveCompressionStrength * 0.12);
        } else if (pointDistance <= targetRadius) {
          const centerBias = 0.48 + insideField * 0.74 + effectiveCompressionStrength * 0.92;
          velocityX += inward.x * centerBias * centerPullStrength;
          velocityY += inward.y * centerBias * centerPullStrength;
        } else {
          velocityX += inward.x * (0.85 + outsideWeight * 1.4 + effectiveCompressionStrength * 0.42) * outerReturnStrength;
          velocityY += inward.y * (0.85 + outsideWeight * 1.4 + effectiveCompressionStrength * 0.42) * outerReturnStrength;
        }

        velocityX += orbital.x * (0.08 + edgeProximity * 0.9 + openField * 0.12) * orbitalStrength;
        velocityY += orbital.y * (0.08 + edgeProximity * 0.9 + openField * 0.12) * orbitalStrength;

        if (capsule.weight > 0.001) {
          velocityX += dualAxis.x * longitudinalPhase * capsule.weight * nebulaInfluence * (0.00016 + openField * 0.00062);
          velocityY += dualAxis.y * longitudinalPhase * capsule.weight * nebulaInfluence * (0.00016 + openField * 0.00062);
          velocityX += dualPerpendicular.x * turbulencePhase * capsule.weight * (0.00012 + nebulaInfluence * 0.00048);
          velocityY += dualPerpendicular.y * turbulencePhase * capsule.weight * (0.00012 + nebulaInfluence * 0.00048);
          velocityX += linePull.x * capsule.weight * (0.00008 + nebulaInfluence * 0.00026);
          velocityY += linePull.y * capsule.weight * (0.00008 + nebulaInfluence * 0.00026);
        }

        glow +=
          insideField * (0.22 + closeness * 0.22 + effectiveCompressionStrength * 0.24) +
          edgeProximity * 0.16 +
          capsule.weight * (0.18 + nebulaInfluence * 0.38) +
          depthGlow * 0.36;
        tone = clamp(
          0.34 +
            capsule.weight * 0.28 +
            edgeProximity * 0.18 +
            Math.max(0, 1 - pointDistance / Math.max(targetRadius, 0.0001)) * 0.16 +
            depthGlow * 0.2,
          0,
          1,
        );
        energy = clamp(
          effectiveCompressionStrength * 0.18 +
            Math.max(0, 1 - pointDistance / Math.max(coreRadius * 1.7, 0.0001)) * 0.14 +
            (releaseActive ? 0.12 : 0) +
            flashStrength * 0.12 +
            depthGlow * 0.1,
          0,
          1,
        );
      } else {
        activeHands.forEach((hand) => {
          const deltaVector = subtract(hand.scenePalm, { x, y });
          const pointDistance = Math.max(0.0001, Math.hypot(deltaVector.x, deltaVector.y));
          const influence = clamp(1 - pointDistance / hand.sceneRadius, 0, 1) * hand.presence;

          if (influence <= 0) {
            return;
          }

          const direction = normalize(deltaVector);
          const tangential = { x: -direction.y, y: direction.x };
          const attractionBias = Math.max(0, hand.attractionAmount * (1 - hand.openAmount * 0.92) - hand.openImpulseAmount * 0.45);
          const repulsionBias = hand.openImpulseAmount;
          glow += influence * (0.16 + attractionBias * 0.48 + repulsionBias * 0.66);

          if (attractionBias > 0.001) {
            velocityX += direction.x * this.profile.attractForce * influence * (0.00085 + attractionBias * 0.0062);
            velocityY += direction.y * this.profile.attractForce * influence * (0.00085 + attractionBias * 0.0062);
            velocityX += tangential.x * influence * 0.00028 * (0.35 + attractionBias);
            velocityY += tangential.y * influence * 0.00028 * (0.35 + attractionBias);
          }

          if (repulsionBias > 0.001) {
            velocityX -= direction.x * this.profile.repelForce * influence * (0.0016 + repulsionBias * 0.0102);
            velocityY -= direction.y * this.profile.repelForce * influence * (0.0016 + repulsionBias * 0.0102);
            velocityX += tangential.x * influence * 0.00028 * (0.24 + repulsionBias * 0.62);
            velocityY += tangential.y * influence * 0.00028 * (0.24 + repulsionBias * 0.62);
          }

          if (hand.gesture === "sweep" || hand.speed > 1.15) {
            velocityX += hand.sceneVelocity.x * this.profile.sweepForce * influence * 0.042;
            velocityY -= hand.sceneVelocity.y * this.profile.sweepForce * influence * 0.042;
            velocityX += tangential.x * influence * 0.0005 * (hand.speed + 0.18);
            velocityY += tangential.y * influence * 0.0005 * (hand.speed + 0.18);
          }
        });
        const baseTone = 0.32 + glow * 0.34;
        const accentEnergy = activeHands.reduce(
          (highest, hand) =>
            Math.max(
              highest,
              hand.attractionAmount * 0.24 + hand.openImpulseAmount * 0.18 + (hand.gesture === "sweep" ? 0.08 : 0),
            ),
          0,
        );
        tone = clamp(baseTone, 0, 0.92);
        energy = clamp(accentEnergy, 0, 0.6);
      }

      glow += flashStrength * 0.46;
      velocityX *= this.reducedMotion ? 0.958 : 0.972;
      velocityY *= this.reducedMotion ? 0.958 : 0.972;
      const speedMagnitude = Math.hypot(velocityX, velocityY);
      const speedLight = smoothstep(0.0014, 0.0082, speedMagnitude);
      x += velocityX * delta * 60;
      y += velocityY * delta * 60;

      if (x > horizontalLimit) x = -horizontalLimit;
      if (x < -horizontalLimit) x = horizontalLimit;
      if (y > 1.12) y = -1.12;
      if (y < -1.12) y = 1.12;

      positions[positionIndex] = x;
      positions[positionIndex + 1] = y;
      velocities[velocityIndex] = velocityX;
      velocities[velocityIndex + 1] = velocityY;
      const sizeClass = clamp((baseSizes[index] - 0.7) / 7.9, 0, 1);
      const glowScale = lerp(0.56, 1.08, sizeClass);
      sizes[index] = baseSizes[index] * this.pointScale * (1 + glow * glowScale);
      alphas[index] = clamp(0.26 + glow * 0.84 + speedLight * 0.1, 0.16, 1);
      toneMixes[index] = clamp(tone, 0, 1);
      energies[index] = clamp(energy, 0, 1);
      speedLights[index] = speedLight;
    }

    const centerDensityRatio =
      this.dualImplosion.phase === "idle" && dualCenter && implosionRadius > 0
        ? computeCenterDensityRatio(positions, dualCenter, implosionRadius)
        : 0;

    this.particles.geometry.attributes.position.needsUpdate = true;
    this.particles.geometry.attributes.aSize.needsUpdate = true;
    this.particles.geometry.attributes.aAlpha.needsUpdate = true;
    this.particles.geometry.attributes.aTone.needsUpdate = true;
    this.particles.geometry.attributes.aEnergy.needsUpdate = true;
    this.particles.geometry.attributes.aSpeedLight.needsUpdate = true;
    this.advanceDualImplosion(delta, {
      center: dualCenter,
      radius: targetRadius,
      axis: dualAxis,
      openField,
      paletteBias: this.interaction.paletteBias,
      compressionStrength: effectiveCompressionStrength,
      rawCompressionStrength: rawDualCompressionStrength,
      minClosure: dualCenter && activeHands.length > 1 ? Math.min(activeHands[0].closure, activeHands[1].closure) : 0,
      centerDensityRatio,
      releaseBurstStrength,
    });
  }

  private updateHandsVisuals() {
    for (let handIndex = 0; handIndex < 2; handIndex += 1) {
      const hand = this.interaction.hands[handIndex];
      const ringSystem = this.palmRings[handIndex];
      const detailSystem = this.palmRingDetails[handIndex];
      const orbital = this.palmOrbitArcs[handIndex];
      const core = this.palmCores[handIndex];
      const tips = this.tipSprites[handIndex];
      const trail = this.trailLines[handIndex];
      const wireframe = this.handWireframes[handIndex];
      const trailAttribute = trail.geometry.attributes.position as THREE.BufferAttribute;

      if (!hand) {
        ringSystem.points.visible = false;
        detailSystem.points.visible = false;
        orbital.visible = false;
        core.visible = false;
        tips.forEach((tip) => {
          tip.visible = false;
        });
        (trail.material as THREE.LineBasicMaterial).opacity = 0;
        wireframe.line.visible = false;
        continue;
      }

      const palmPoint = toSceneVector(hand.palm);
      const time = this.renderTime;
      const motionDamp = this.interaction.dualActive ? 0.58 : 1;
      const pulse = 1 + Math.sin(time * 1.8 + handIndex * 0.7) * 0.024;
      const ripple = hand.openImpulseAmount * 0.22;
      const contraction = hand.attractionAmount * 0.06;
      const ambientOuterSpin = time * (0.18 + handIndex * 0.02) * motionDamp;
      const ambientDetailSpin = time * (0.28 + handIndex * 0.03) * motionDamp;
      const orbitalSpin =
        time * (0.46 + hand.openImpulseAmount * 0.8 + hand.openAmount * 0.12 + hand.attractionAmount * 0.08) * motionDamp;
      const contourFlow = 0.5 + Math.sin(time * (2.1 + handIndex * 0.18) + hand.palm.x * 2.8 + hand.palm.y) * 0.5;
      const glowBreath = 0.5 + Math.sin(time * 1.4 + handIndex * 0.8) * 0.5;
      const orbitalMaterial = orbital.material as THREE.SpriteMaterial;
      const coreMaterial = core.material as THREE.SpriteMaterial;
      const overlayBias = this.interaction.dualActive ? this.interaction.paletteBias : hand.paletteBias;
      const gestureEnergy = clamp(
        hand.attractionAmount * 0.34 +
          hand.openImpulseAmount * 0.42 +
          hand.openAmount * 0.08 +
          (this.interaction.dualActive ? this.interaction.dualCloseness * 0.1 : 0),
        0,
        1,
      );
      const overlayPalette = this.createBiasPalette(overlayBias, gestureEnergy);
      const outerColor = overlayPalette.biasColor;
      const detailColor = overlayPalette.secondaryColor.clone().lerp(overlayPalette.accentCool, 0.18 + (1 - contourFlow) * 0.14);
      const orbitalColor = overlayPalette.biasColor.clone().lerp(overlayPalette.energyColor, 0.16 + gestureEnergy * 0.24);
      const coreColor = overlayPalette.coreColor;
      const trailColor = overlayPalette.trailColor;

      if (this.wireframeMode) {
        HAND_CONNECTIONS.forEach(([from, to], connectionIndex) => {
          const start = hand.landmarks[from] ?? hand.palm;
          const end = hand.landmarks[to] ?? hand.palm;
          const positionIndex = connectionIndex * 6;
          wireframe.positions[positionIndex] = start.x;
          wireframe.positions[positionIndex + 1] = start.y;
          wireframe.positions[positionIndex + 2] = 0.01;
          wireframe.positions[positionIndex + 3] = end.x;
          wireframe.positions[positionIndex + 4] = end.y;
          wireframe.positions[positionIndex + 5] = 0.01;
        });
        const wireframeMaterial = wireframe.line.material;
        wireframeMaterial.color.copy(overlayPalette.secondaryColor.clone().lerp(overlayPalette.biasColor, 0.42));
        wireframeMaterial.opacity = hand.presence * (0.1 + gestureEnergy * 0.06 + glowBreath * 0.02);
        wireframe.line.geometry.attributes.position.needsUpdate = true;
        wireframe.line.visible = hand.presence > 0.01;
      } else {
        wireframe.line.visible = false;
      }
      const ringWidth =
        Math.max(hand.ellipseRadiusX * 2.16 * (1 + hand.attractionAmount * 0.05 + hand.openAmount * 0.02), 0.16) *
        pulse *
        (1 + ripple * 0.35 - contraction);
      const ringHeight =
        Math.max(hand.ellipseRadiusY * 2.16 * (1 + hand.attractionAmount * 0.04 + hand.openAmount * 0.04), 0.2) *
        pulse *
        (1 + ripple * 0.28 - contraction * 0.82);
      const detailWidth = ringWidth * (0.94 + glowBreath * 0.02 + hand.attractionAmount * 0.02);
      const detailHeight = ringHeight * (0.94 + glowBreath * 0.02 + hand.attractionAmount * 0.02);
      const orbitalWidth = ringWidth * (1.01 + contourFlow * 0.03 + hand.openImpulseAmount * 0.05);
      const orbitalHeight = ringHeight * (1.01 + contourFlow * 0.03 + hand.openImpulseAmount * 0.04);
      const coreWidth = ringWidth * (0.36 + hand.attractionAmount * 0.06 + hand.openImpulseAmount * 0.05 + glowBreath * 0.015);
      const coreHeight = ringHeight * (0.36 + hand.attractionAmount * 0.04 + hand.openImpulseAmount * 0.05 + glowBreath * 0.015);
      const outerOpacity =
        hand.presence *
        (this.interaction.dualActive ? 0.74 : 0.66 + hand.attractionAmount * 0.22 + hand.openImpulseAmount * 0.16) *
        (0.92 + contourFlow * 0.12);
      const detailOpacity =
        hand.presence *
        (this.interaction.dualActive ? 0.46 : 0.4 + hand.attractionAmount * 0.12 + hand.openImpulseAmount * 0.1) *
        (0.84 + contourFlow * 0.18);

      orbital.visible = true;
      core.visible = true;
      orbital.position.copy(palmPoint);
      core.position.copy(palmPoint);
      orbital.scale.set(orbitalWidth, orbitalHeight, 1);
      core.scale.set(coreWidth, coreHeight, 1);
      this.updateRingParticleSystem(ringSystem, {
        center: hand.palm,
        rotation: hand.ellipseAngle + ambientOuterSpin * (0.38 - hand.attractionAmount * 0.18),
        radiusX: ringWidth * 0.5,
        radiusY: ringHeight * 0.5,
        color: outerColor,
        haloColor: overlayPalette.accentCool,
        opacity: outerOpacity,
        jitterAmplitude: Math.min(ringWidth, ringHeight) * (0.006 + hand.openImpulseAmount * 0.002),
        driftSpeed: 0.62 + hand.openImpulseAmount * 0.16 + hand.attractionAmount * 0.08,
        time,
        flowAmount: 0.014 + contourFlow * 0.008,
        zOffset: 0.001,
      });
      this.updateRingParticleSystem(detailSystem, {
        center: hand.palm,
        rotation: hand.ellipseAngle - ambientDetailSpin * (0.42 - hand.attractionAmount * 0.12),
        radiusX: detailWidth * 0.5,
        radiusY: detailHeight * 0.5,
        color: detailColor,
        haloColor: outerColor,
        opacity: detailOpacity,
        jitterAmplitude: Math.min(detailWidth, detailHeight) * 0.003,
        driftSpeed: -0.46 - contourFlow * 0.08,
        time,
        flowAmount: 0.008 + glowBreath * 0.006,
        zOffset: 0.002,
      });
      orbitalMaterial.rotation = hand.ellipseAngle + orbitalSpin;
      coreMaterial.rotation = hand.ellipseAngle - ambientOuterSpin * 0.08;
      orbitalMaterial.color.copy(orbitalColor);
      coreMaterial.color.copy(coreColor);
      orbitalMaterial.opacity =
        hand.presence *
        (this.interaction.dualActive ? 0.26 : 0.22 + hand.openImpulseAmount * 0.2 + hand.openAmount * 0.04 + hand.attractionAmount * 0.06) *
        (0.76 + contourFlow * 0.24);
      coreMaterial.opacity = hand.presence * (0.14 + hand.attractionAmount * 0.14 + hand.openImpulseAmount * 0.08) * (0.82 + glowBreath * 0.18);

      tips.forEach((tip, tipIndex) => {
        const tipPoint = toSceneVector(hand.fingertips[tipIndex]);
        tip.visible = true;
        tip.position.copy(tipPoint);
        const tipScale =
          this.profile.tipScale *
          (tipIndex === 1 ? 1.18 : 1) *
          (0.56 + hand.openAmount * 0.88 + hand.attractionAmount * 0.14 + hand.openImpulseAmount * 0.08) *
          this.overlayScale;
        tip.scale.setScalar(tipScale);
        const tipMaterial = tip.material as THREE.SpriteMaterial;
        tipMaterial.color.copy(tipIndex % 2 === 0 ? outerColor : detailColor);
        tipMaterial.opacity =
          hand.presence * (0.22 + hand.openAmount * 0.28 + hand.attractionAmount * 0.08 + hand.openImpulseAmount * 0.1);
      });

      const positions = trailAttribute.array as Float32Array;
      hand.trail.forEach((point, trailIndex) => {
        positions[trailIndex * 3] = point.x;
        positions[trailIndex * 3 + 1] = point.y;
        positions[trailIndex * 3 + 2] = 0;
      });
      for (let trailIndex = hand.trail.length; trailIndex < positions.length / 3; trailIndex += 1) {
        positions[trailIndex * 3] = hand.palm.x;
        positions[trailIndex * 3 + 1] = hand.palm.y;
        positions[trailIndex * 3 + 2] = 0;
      }
      trailAttribute.needsUpdate = true;
      const trailMaterial = trail.material as THREE.LineBasicMaterial;
      trailMaterial.color.copy(trailColor);
      trailMaterial.opacity = hand.presence * (this.interaction.dualActive ? 0.52 : 0.68);
    }
  }

  private advanceDualImplosion(
    delta: number,
    state: {
      center: Vec2 | null;
      radius: number;
      axis: Vec2;
      openField: number;
      paletteBias: number;
      compressionStrength: number;
      rawCompressionStrength: number;
      minClosure: number;
      centerDensityRatio: number;
      releaseBurstStrength: number;
    },
  ) {
    if (this.dualImplosion.phase === "idle") {
      const gate = updateDualImplosionGate({
        holdMs: this.dualImplosion.holdMs,
        armed: this.dualImplosion.armed,
        compressionStrength: state.compressionStrength,
        centerDensityRatio: state.centerDensityRatio,
        deltaSeconds: delta,
      });

      this.dualImplosion.holdMs = gate.holdMs;

      if (gate.triggered && state.center && state.radius > 0.08) {
        this.dualImplosion = {
          phase: "gather",
          elapsed: 0,
          holdMs: 0,
          armed: false,
          cooldownElapsed: 0,
          center: { ...state.center },
          radius: state.radius,
          axis: { ...state.axis },
          openField: state.openField,
          paletteBias: state.paletteBias,
          releaseBurstStrength: state.releaseBurstStrength,
        };
      }

      return;
    }

    this.dualImplosion.elapsed += delta;

    if (this.dualImplosion.phase === "gather" && this.dualImplosion.elapsed >= 0.12) {
      this.dualImplosion.phase = "implode";
      this.dualImplosion.elapsed = 0;
      return;
    }

    if (this.dualImplosion.phase === "implode" && this.dualImplosion.elapsed >= 0.16) {
      this.beginDualRelease();
      this.dualImplosion.phase = "release";
      this.dualImplosion.elapsed = 0;
      return;
    }

    if (this.dualImplosion.phase === "release" && this.dualImplosion.elapsed >= 0.2) {
      this.dualImplosion.phase = "flash";
      this.dualImplosion.elapsed = 0;
      return;
    }

    if (this.dualImplosion.phase === "flash" && this.dualImplosion.elapsed >= 0.14) {
      this.dualImplosion = {
        phase: "cooldown",
        elapsed: 0,
        holdMs: 0,
        armed: false,
        cooldownElapsed: 0,
        center: state.center ? { ...state.center } : null,
        radius: state.radius,
        axis: { ...state.axis },
        openField: state.openField,
        paletteBias: state.paletteBias,
        releaseBurstStrength: 0,
      };
      return;
    }

    if (this.dualImplosion.phase === "cooldown") {
      this.dualImplosion.cooldownElapsed += delta * 1000;
      this.dualImplosion.center = state.center ? { ...state.center } : null;
      this.dualImplosion.radius = state.radius;
      this.dualImplosion.axis = { ...state.axis };
      this.dualImplosion.openField = state.openField;
      this.dualImplosion.paletteBias = state.paletteBias;

      if (shouldRearmDualImplosion(this.dualImplosion.cooldownElapsed, state.minClosure, state.rawCompressionStrength)) {
        this.dualImplosion = {
          phase: "idle",
          elapsed: 0,
          holdMs: 0,
          armed: true,
          cooldownElapsed: 0,
          center: null,
          radius: 0,
          axis: { x: 1, y: 0 },
          openField: 0,
          paletteBias: this.interaction.paletteBias,
          releaseBurstStrength: 0,
        };
      }
    }
  }

  private beginDualRelease() {
    if (!this.dualImplosion.center || !this.particleBuffers) {
      return;
    }

    const { positions, velocities, sizes, alphas, seeds, baseSizes } = this.particleBuffers;
    const center = this.dualImplosion.center;
    const radius = Math.max(this.dualImplosion.radius, 0.16);
    const axis = normalize(this.dualImplosion.axis);
    const burstStrength = this.dualImplosion.releaseBurstStrength;

    for (let index = 0; index < baseSizes.length; index += 1) {
      const positionIndex = index * 3;
      const velocityIndex = index * 2;
      const delta = {
        x: positions[positionIndex] - center.x,
        y: positions[positionIndex + 1] - center.y,
      };
      const pointDistance = Math.hypot(delta.x, delta.y);
      const outward =
        pointDistance > radius * 0.02
          ? normalize(delta)
          : normalize({
              x: Math.cos(seeds[index] * Math.PI * 2) + axis.x * 0.35,
              y: Math.sin(seeds[index] * Math.PI * 2) + axis.y * 0.35,
            });
      const tangential = normalize(perpendicular(outward));
      const axisWave = Math.sin(seeds[index] * Math.PI * 7.2);
      const spawnRadius = THREE.MathUtils.randFloat(radius * 0.02, radius * (0.1 + burstStrength * 0.08));

      positions[positionIndex] = clamp(
        center.x + outward.x * spawnRadius,
        -this.viewportMapping.sceneHalfWidth * 1.12,
        this.viewportMapping.sceneHalfWidth * 1.12,
      );
      positions[positionIndex + 1] = clamp(center.y + outward.y * spawnRadius, -1.12, 1.12);
      positions[positionIndex + 2] = THREE.MathUtils.randFloat(-0.04, 0.08);
      velocities[velocityIndex] =
        outward.x * (0.008 + burstStrength * 0.014) +
        tangential.x * (0.0004 + burstStrength * 0.001) +
        axis.x * axisWave * burstStrength * 0.0012;
      velocities[velocityIndex + 1] =
        outward.y * (0.008 + burstStrength * 0.014) +
        tangential.y * (0.0004 + burstStrength * 0.001) +
        axis.y * axisWave * burstStrength * 0.0012;
      sizes[index] = baseSizes[index] * this.pointScale * (1.18 + burstStrength * 0.9);
      alphas[index] = THREE.MathUtils.randFloat(0.34, 0.82);
    }

    this.particles.geometry.attributes.position.needsUpdate = true;
    this.particles.geometry.attributes.aSize.needsUpdate = true;
    this.particles.geometry.attributes.aAlpha.needsUpdate = true;
  }

  private updateImplosionVisual() {
    if (
      this.wireframeMode ||
      this.dualImplosion.phase === "idle" ||
      this.dualImplosion.phase === "cooldown" ||
      !this.dualImplosion.center
    ) {
      this.implosionBloom.visible = false;
      return;
    }

      const bloomMaterial = this.implosionBloom.material as THREE.SpriteMaterial;
      const center = this.dualImplosion.center;
      const mix = clamp((this.dualImplosion.paletteBias + 1) * 0.5, 0, 1);
      const flashColor = EVENT_GOLD.clone().lerp(HOT_HALO, 0.44).lerp(ION_CYAN.clone().lerp(ACCRETION_PINK, mix), 0.16);
    const radius = Math.max(this.dualImplosion.radius, 0.14);
    let opacity = 0;
    let scaleValue = radius * 1.8;

    if (this.dualImplosion.phase === "gather") {
      const progress = clamp(this.dualImplosion.elapsed / 0.12, 0, 1);
      opacity = 0.18 + progress * 0.16;
      scaleValue = radius * (1.9 - progress * 0.45);
    } else if (this.dualImplosion.phase === "implode") {
      const progress = clamp(this.dualImplosion.elapsed / 0.16, 0, 1);
      opacity = 0.28 + progress * 0.22;
      scaleValue = radius * (1.46 - progress * 0.68);
    } else if (this.dualImplosion.phase === "release") {
      const progress = clamp(this.dualImplosion.elapsed / 0.2, 0, 1);
      opacity = 0.46 - progress * 0.2;
      scaleValue = radius * (0.54 + progress * (1.9 + this.dualImplosion.releaseBurstStrength * 0.7));
    } else {
      const progress = clamp(this.dualImplosion.elapsed / 0.14, 0, 1);
      opacity = (1 - progress) * 0.76;
      scaleValue = radius * (1.2 + progress * 2.8);
    }

    this.implosionBloom.visible = true;
    this.implosionBloom.position.set(center.x, center.y, 0);
    this.implosionBloom.scale.set(scaleValue, scaleValue, 1);
    bloomMaterial.color.copy(flashColor);
    bloomMaterial.opacity = opacity;
  }

  private adjustQuality() {
    const tooSlow = this.frameMs > 22;
    const veryFast = this.frameMs < 14;

    if (tooSlow) {
      this.qualityDrift += 1;
    } else if (veryFast) {
      this.qualityDrift -= 1;
    } else {
      this.qualityDrift *= 0.82;
    }

    if (this.qualityDrift > 75) {
      const next = nextLowerQuality(this.tier);
      if (next !== this.tier) {
        this.qualityDrift = 0;
        this.setQualityTier(next);
      }
    }

    if (!this.reducedMotion && this.qualityDrift < -180) {
      const next = nextHigherQuality(this.tier);
      if (next !== this.tier) {
        this.qualityDrift = 0;
        this.setQualityTier(next);
      }
    }
  }
}
