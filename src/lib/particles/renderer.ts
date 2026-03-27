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

interface DustBuffers {
  positions: Float32Array;
  velocities: Float32Array;
  sizes: Float32Array;
  alphas: Float32Array;
  seeds: Float32Array;
  depths: Float32Array;
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
  orbitFractions: Float32Array;
}

interface HandRingParticleSystem {
  points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  buffers: RingParticleBuffers;
}

interface TrailLineVisual {
  line: THREE.Line<THREE.BufferGeometry, THREE.ShaderMaterial>;
  positions: Float32Array;
}

interface HandWireframeVisual {
  line: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  positions: Float32Array;
}

interface SparkBurstBuffers {
  positions: Float32Array;
  velocities: Float32Array;
  sizes: Float32Array;
  alphas: Float32Array;
  ages: Float32Array;
  lifetimes: Float32Array;
  actives: Float32Array;
  seeds: Float32Array;
}

interface DisplayHandState {
  initialized: boolean;
  palm: Vec2;
  ellipseAngle: number;
  ellipseRadiusX: number;
  ellipseRadiusY: number;
  fingertips: Vec2[];
  trail: Vec2[];
  presence: number;
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

function createShockwaveTexture() {
  const size = 160;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("2D context unavailable");
  }

  const center = size / 2;
  const gradient = context.createRadialGradient(center, center, center * 0.24, center, center, center * 0.5);
  gradient.addColorStop(0, "rgba(255,255,255,0)");
  gradient.addColorStop(0.34, "rgba(255,255,255,0)");
  gradient.addColorStop(0.52, "rgba(255,255,255,0.72)");
  gradient.addColorStop(0.68, "rgba(255,255,255,0.18)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
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

function getDustCountForTier(tier: QualityTier, reducedMotion: boolean) {
  const base = tier === "high" ? 520 : tier === "medium" ? 340 : 220;
  return reducedMotion ? Math.max(140, Math.round(base * 0.72)) : base;
}

function getSparkCountForTier(tier: QualityTier, reducedMotion: boolean) {
  const base = tier === "high" ? 28 : tier === "medium" ? 20 : 12;
  return reducedMotion ? Math.max(8, Math.round(base * 0.7)) : base;
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
  private dustParticles!: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private dustBuffers!: DustBuffers;
  private releaseSparks!: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private sparkBuffers!: SparkBurstBuffers;
  private readonly implosionBloom: THREE.Sprite;
  private readonly compressionHalo: THREE.Sprite;
  private readonly releaseRing: THREE.Sprite;
  private palmRings: HandRingParticleSystem[] = [];
  private palmRingDetails: HandRingParticleSystem[] = [];
  private palmOrbitArcs: THREE.Sprite[] = [];
  private palmCores: THREE.Sprite[] = [];
  private tipSprites: THREE.Sprite[][] = [];
  private trailLines: TrailLineVisual[] = [];
  private handWireframes: HandWireframeVisual[] = [];
  private displayHands: DisplayHandState[] = [];
  private glowTexture = createGlowTexture(1, 0);
  private shockwaveTexture = createShockwaveTexture();
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
    this.compressionHalo = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: this.palettePrimary.clone(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      }),
    );
    this.compressionHalo.visible = false;
    this.releaseRing = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.shockwaveTexture,
        color: this.paletteHighlight.clone(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        opacity: 0,
      }),
    );
    this.releaseRing.visible = false;
    this.scene.add(this.implosionBloom);
    this.scene.add(this.compressionHalo);
    this.scene.add(this.releaseRing);
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
    this.shockwaveTexture.dispose();
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

    if (this.dustBuffers) {
      const dustHorizontalLimit = nextHalfWidth * 1.16;
      for (let index = 0; index < this.dustBuffers.positions.length / 3; index += 1) {
        const positionIndex = index * 3;
        const velocityIndex = index * 2;
        this.dustBuffers.positions[positionIndex] = clamp(
          this.dustBuffers.positions[positionIndex] * positionScaleX,
          -dustHorizontalLimit,
          dustHorizontalLimit,
        );
        this.dustBuffers.velocities[velocityIndex] *= positionScaleX;
      }
      this.dustParticles.geometry.attributes.position.needsUpdate = true;
    }
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
    const orbitFractions = new Float32Array(count);

    for (let index = 0; index < count; index += 1) {
      angles[index] = (index / count) * Math.PI * 2 + THREE.MathUtils.randFloatSpread(0.06);
      radialOffsets[index] = THREE.MathUtils.randFloatSpread(1);
      phaseOffsets[index] = Math.random();
      orbitFractions[index] = index / count;
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
    geometry.setAttribute("aOrbit", new THREE.BufferAttribute(orbitFractions, 1));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: this.palettePrimary.clone() },
        uHalo: { value: this.paletteSecondary.clone() },
        uOpacity: { value: 0 },
        uHighlightPhase: { value: 0 },
        uHighlightWidth: { value: 0.18 },
        uHighlightStrength: { value: 0.26 },
        uLeadBoost: { value: 0.2 },
      },
      vertexShader: `
        attribute float aSize;
        attribute float aAlpha;
        attribute vec2 aTrail;
        attribute float aOrbit;
        uniform float uOpacity;
        varying float vAlpha;
        varying vec2 vTrail;
        varying float vTrailMagnitude;
        varying float vOrbit;
        void main() {
          vAlpha = aAlpha;
          vTrail = aTrail;
          vTrailMagnitude = clamp(length(aTrail), 0.0, 1.0);
          vOrbit = aOrbit;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (1.18 + vTrailMagnitude * 0.9);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform vec3 uHalo;
        uniform float uOpacity;
        uniform float uHighlightPhase;
        uniform float uHighlightWidth;
        uniform float uHighlightStrength;
        uniform float uLeadBoost;
        varying float vAlpha;
        varying vec2 vTrail;
        varying float vTrailMagnitude;
        varying float vOrbit;
        void main() {
          vec2 uv = gl_PointCoord - vec2(0.5);
          vec2 direction = vTrailMagnitude > 0.0001 ? normalize(vTrail) : vec2(0.0, 1.0);
          vec2 perpendicularDirection = vec2(-direction.y, direction.x);
          float along = dot(uv, direction);
          float across = dot(uv, perpendicularDirection);
          float radial = length(uv);
          float head = smoothstep(0.6, 0.03, radial);
          float softGlow = smoothstep(0.92, 0.12, radial);
          float tailBody = exp(-pow(across * 4.2, 2.0)) * smoothstep(0.38, -0.46, along);
          float tailGlow = exp(-pow(across * 2.6, 2.0)) * smoothstep(0.24, -0.62, along);
          float tail = (tailBody * 0.86 + tailGlow * 0.44) * vTrailMagnitude;
          float phaseDistance = abs(vOrbit - uHighlightPhase);
          phaseDistance = min(phaseDistance, 1.0 - phaseDistance);
          float traveler = smoothstep(uHighlightWidth, 0.0, phaseDistance);
          float lead = smoothstep(0.16, -0.42, along) * vTrailMagnitude;
          float alpha = max(head, tail) * vAlpha * uOpacity;
          alpha += softGlow * (0.14 + vTrailMagnitude * 0.08 + traveler * uHighlightStrength * 0.12) * uOpacity;
          alpha += traveler * (0.08 + lead * uLeadBoost * 0.12) * vAlpha * uOpacity;
          vec3 color = mix(uColor, uHalo, smoothstep(0.58, 0.0, radial) * 0.48 + vTrailMagnitude * 0.18);
          color = mix(color, uHalo, traveler * (0.22 + lead * uLeadBoost));
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
        orbitFractions,
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
      highlightPhase: number;
      highlightWidth: number;
      highlightStrength: number;
      leadBoost: number;
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
    material.uniforms.uHighlightPhase.value = options.highlightPhase;
    material.uniforms.uHighlightWidth.value = options.highlightWidth;
    material.uniforms.uHighlightStrength.value = options.highlightStrength;
    material.uniforms.uLeadBoost.value = options.leadBoost;

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
      const trailStrength = clamp(deltaLength / 0.009, 0, 1);
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

    if (this.dustParticles) {
      const dustMaterial = this.dustParticles.material;
      dustMaterial.uniforms.uColorA.value.copy(palette.secondaryColor);
      dustMaterial.uniforms.uColorB.value.copy(palette.haloColor);
    }

    if (this.releaseSparks) {
      const sparkMaterial = this.releaseSparks.material;
      sparkMaterial.uniforms.uColor.value.copy(palette.energyColor);
      sparkMaterial.uniforms.uHalo.value.copy(palette.haloColor.clone().lerp(EVENT_GOLD, 0.22));
    }
  }

  private buildDustLayer() {
    const geometry = new THREE.BufferGeometry();
    const count = getDustCountForTier(this.tier, this.reducedMotion);
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 2);
    const sizes = new Float32Array(count);
    const alphas = new Float32Array(count);
    const seeds = new Float32Array(count);
    const depths = new Float32Array(count);
    const halfWidth = this.viewportMapping.sceneHalfWidth;

    for (let index = 0; index < count; index += 1) {
      const positionIndex = index * 3;
      const velocityIndex = index * 2;
      positions[positionIndex] = THREE.MathUtils.randFloat(-halfWidth * 1.1, halfWidth * 1.1);
      positions[positionIndex + 1] = THREE.MathUtils.randFloat(-1.08, 1.08);
      positions[positionIndex + 2] = THREE.MathUtils.randFloat(-0.22, -0.02);
      velocities[velocityIndex] = THREE.MathUtils.randFloatSpread(0.00022);
      velocities[velocityIndex + 1] = THREE.MathUtils.randFloatSpread(0.00018);
      sizes[index] = THREE.MathUtils.randFloat(0.85, 2.1) * this.pointScale;
      alphas[index] = THREE.MathUtils.randFloat(0.08, 0.22);
      seeds[index] = Math.random();
      depths[index] = THREE.MathUtils.randFloat(0, 1);
    }

    geometry.setAttribute("position", createDynamicAttribute(positions, 3));
    geometry.setAttribute("aSize", createDynamicAttribute(sizes, 1));
    geometry.setAttribute("aAlpha", createDynamicAttribute(alphas, 1));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));
    geometry.setAttribute("aDepth", new THREE.BufferAttribute(depths, 1));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColorA: { value: this.paletteSecondary.clone() },
        uColorB: { value: this.paletteHalo.clone() },
        uOpacity: { value: 0.18 },
        uGlowBoost: { value: 1 },
      },
      vertexShader: `
        attribute float aSize;
        attribute float aAlpha;
        attribute float aSeed;
        attribute float aDepth;
        varying float vAlpha;
        varying float vDepth;
        varying float vSeed;
        void main() {
          vAlpha = aAlpha;
          vDepth = aDepth;
          vSeed = aSeed;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (0.76 + aDepth * 0.78);
        }
      `,
      fragmentShader: `
        uniform vec3 uColorA;
        uniform vec3 uColorB;
        uniform float uOpacity;
        uniform float uGlowBoost;
        varying float vAlpha;
        varying float vDepth;
        varying float vSeed;
        void main() {
          vec2 uv = gl_PointCoord - vec2(0.5);
          float dist = length(uv);
          float body = smoothstep(0.56, 0.0, dist);
          float halo = smoothstep(0.84, 0.12, dist);
          vec3 color = mix(uColorA, uColorB, 0.18 + vDepth * 0.52 + sin(vSeed * 20.0) * 0.06);
          float alpha = (body * 0.68 + halo * 0.32 * uGlowBoost) * vAlpha * uOpacity;
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

    const dust = new THREE.Points(geometry, material);
    dust.frustumCulled = false;

    if (this.dustParticles) {
      this.scene.remove(this.dustParticles);
      this.dustParticles.geometry.dispose();
      this.dustParticles.material.dispose();
    }

    this.dustParticles = dust;
    this.dustBuffers = {
      positions,
      velocities,
      sizes,
      alphas,
      seeds,
      depths,
    };
    this.scene.add(this.dustParticles);
  }

  private buildSparkBurst() {
    const geometry = new THREE.BufferGeometry();
    const count = getSparkCountForTier(this.tier, this.reducedMotion);
    const positions = new Float32Array(count * 3);
    const velocities = new Float32Array(count * 2);
    const sizes = new Float32Array(count);
    const alphas = new Float32Array(count);
    const ages = new Float32Array(count);
    const lifetimes = new Float32Array(count);
    const actives = new Float32Array(count);
    const seeds = new Float32Array(count);

    for (let index = 0; index < count; index += 1) {
      sizes[index] = THREE.MathUtils.randFloat(4.8, 8.8) * this.overlayScale;
      alphas[index] = 0;
      ages[index] = 1;
      lifetimes[index] = 0.26;
      actives[index] = 0;
      seeds[index] = Math.random();
    }

    geometry.setAttribute("position", createDynamicAttribute(positions, 3));
    geometry.setAttribute("aSize", createDynamicAttribute(sizes, 1));
    geometry.setAttribute("aAlpha", createDynamicAttribute(alphas, 1));
    geometry.setAttribute("aAge", createDynamicAttribute(ages, 1));
    geometry.setAttribute("aActive", createDynamicAttribute(actives, 1));
    geometry.setAttribute("aSeed", new THREE.BufferAttribute(seeds, 1));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColor: { value: this.paletteHighlight.clone() },
        uHalo: { value: HOT_HALO.clone() },
        uOpacity: { value: 0 },
      },
      vertexShader: `
        attribute float aSize;
        attribute float aAlpha;
        attribute float aAge;
        attribute float aActive;
        varying float vAlpha;
        varying float vAge;
        varying float vActive;
        void main() {
          vAlpha = aAlpha;
          vAge = aAge;
          vActive = aActive;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * (1.12 - aAge * 0.28);
        }
      `,
      fragmentShader: `
        uniform vec3 uColor;
        uniform vec3 uHalo;
        uniform float uOpacity;
        varying float vAlpha;
        varying float vAge;
        varying float vActive;
        void main() {
          vec2 uv = gl_PointCoord - vec2(0.5);
          float dist = length(uv);
          float spark = smoothstep(0.42, 0.0, dist);
          float glow = smoothstep(0.9, 0.08, dist);
          vec3 color = mix(uColor, uHalo, spark * 0.72);
          float alpha = (spark * 0.9 + glow * 0.26) * vAlpha * uOpacity * vActive * (1.0 - vAge);
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

    const sparks = new THREE.Points(geometry, material);
    sparks.frustumCulled = false;
    sparks.visible = false;

    if (this.releaseSparks) {
      this.scene.remove(this.releaseSparks);
      this.releaseSparks.geometry.dispose();
      this.releaseSparks.material.dispose();
    }

    this.releaseSparks = sparks;
    this.sparkBuffers = {
      positions,
      velocities,
      sizes,
      alphas,
      ages,
      lifetimes,
      actives,
      seeds,
    };
    this.scene.add(this.releaseSparks);
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
          gl_PointSize = aSize * clamp(1.0 + parallax * 0.34, 0.72, 1.4);
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
          float tone = clamp(vTone, 0.0, 1.0);
          float energy = clamp(vEnergy, 0.0, 1.0);
          float speedLight = clamp(vSpeedLight, 0.0, 1.0);
          float innerCore = smoothstep(0.18, 0.0, dist);
          float body = smoothstep(0.52, 0.08, dist);
          float outerHalo = smoothstep(0.94, 0.18, dist);
          float rim = smoothstep(0.62, 0.2, dist) - smoothstep(0.28, 0.06, dist);
          vec3 base = mix(uColorShadow, uColorViolet, smoothstep(0.04, 0.64, tone));
          vec3 gesture = mix(uColorViolet, uColorBias, 0.18 + smoothstep(0.12, 0.88, tone) * 0.82);
          vec3 accent = mix(uColorAccentCool, uColorAccentWarm, clamp(0.5 + vDepth * 0.18 + tone * 0.1, 0.0, 1.0));
          vec3 color = mix(base, gesture, 0.48 + tone * 0.22);
          color = mix(color, accent, 0.16 + tone * 0.1 + energy * 0.08);
          color = mix(color, uColorEnergy, smoothstep(0.36, 0.92, energy) * 0.38);
          color = mix(color, uColorHalo, rim * (0.1 + tone * 0.08 + speedLight * 0.08));
          color = mix(color, uColorHalo, innerCore * (0.28 + tone * 0.16 + speedLight * 0.14));
          color = mix(color, uColorEnergy, innerCore * (0.08 + energy * 0.16 + speedLight * 0.06));
          color = mix(color, uColorVoid, smoothstep(0.42, 1.0, energy) * smoothstep(0.12, 0.0, dist) * 0.12);
          float alpha = body * vAlpha;
          alpha += outerHalo * (0.05 + tone * 0.06 + energy * 0.04 + speedLight * 0.1) * vAlpha;
          alpha += innerCore * (0.08 + energy * 0.06) * vAlpha;
          alpha *= 0.86 + tone * 0.18 + energy * 0.12 + speedLight * 0.1;
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

    const particles = new THREE.Points(geometry, material);
    particles.frustumCulled = false;
    particles.visible = true;

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
    this.buildDustLayer();
    this.buildSparkBurst();
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
        sizeRange: [7.4, 11.4],
        alphaRange: [0.78, 1],
      });
      const detail = this.createRingParticleSystem({
        count: 30,
        sizeRange: [4.8, 7.2],
        alphaRange: [0.58, 0.92],
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

      const trailPositions = new Float32Array(24 * 3);
      const trailProgress = new Float32Array(24);
      for (let trailIndex = 0; trailIndex < 24; trailIndex += 1) {
        trailProgress[trailIndex] = trailIndex / 23;
      }
      const trailGeometry = new THREE.BufferGeometry();
      trailGeometry.setAttribute("position", createDynamicAttribute(trailPositions, 3));
      trailGeometry.setAttribute("aProgress", new THREE.BufferAttribute(trailProgress, 1));
      const trail = new THREE.Line(
        trailGeometry,
        new THREE.ShaderMaterial({
          transparent: true,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          uniforms: {
            uColor: { value: (handIndex === 0 ? this.palettePrimary : this.paletteSecondary).clone() },
            uHeadColor: { value: this.paletteHalo.clone() },
            uOpacity: { value: 0 },
            uWireBoost: { value: 1 },
          },
          vertexShader: `
            attribute float aProgress;
            varying float vProgress;
            void main() {
              vProgress = aProgress;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: `
            uniform vec3 uColor;
            uniform vec3 uHeadColor;
            uniform float uOpacity;
            uniform float uWireBoost;
            varying float vProgress;
            void main() {
              float head = 1.0 - clamp(vProgress, 0.0, 1.0);
              float tail = 1.0 - head;
              float alpha = mix(0.06, 0.8, pow(head, 0.72)) * uOpacity;
              vec3 color = mix(uColor, uHeadColor, pow(head, 0.62) * 0.62);
              alpha *= mix(0.68, 1.0, uWireBoost * 0.4);
              gl_FragColor = vec4(color, alpha * (0.92 - tail * 0.32));
            }
          `,
        }),
      );
      trail.frustumCulled = false;
      this.trailLines.push({
        line: trail,
        positions: trailPositions,
      });
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
      this.displayHands.push({
        initialized: false,
        palm: { x: 0, y: 0 },
        ellipseAngle: 0,
        ellipseRadiusX: 0.1,
        ellipseRadiusY: 0.1,
        fingertips: Array.from({ length: 5 }, () => ({ x: 0, y: 0 })),
        trail: Array.from({ length: 24 }, () => ({ x: 0, y: 0 })),
        presence: 0,
      });
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
    this.updateDustParticles(time * 0.001, delta);
    this.updateHandsVisuals(delta);
    this.updateSparkBurst(delta);
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
      const hierarchyBoost = sizeClass < 0.24 ? 0.88 : sizeClass > 0.82 ? 1.08 : 1;
      const glowScale = lerp(0.42, 1.02, sizeClass);
      sizes[index] = baseSizes[index] * hierarchyBoost * this.pointScale * (1 + glow * glowScale);
      alphas[index] = clamp(0.24 + glow * lerp(0.72, 0.9, sizeClass) + speedLight * 0.08, 0.14, 1);
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

  private updateDustParticles(time: number, delta: number) {
    if (!this.dustBuffers || !this.dustParticles) {
      return;
    }

    const { positions, velocities, alphas, sizes, seeds, depths } = this.dustBuffers;
    const activeHands = this.interaction.hands;
    const dualCenter =
      this.interaction.dualActive && activeHands.length > 1 ? average(activeHands.map((hand) => hand.palm)) : null;
    const targetRadius = dualCenter ? Math.max(0.16, this.interaction.dualDistance * 0.56) : 0;
    const horizontalLimit = this.viewportMapping.sceneHalfWidth * 1.16;
    const dustMaterial = this.dustParticles.material;
    const wireOpacityBoost = this.wireframeMode ? 1.25 : 1;
    const wireGlowBoost = this.wireframeMode ? 1.15 : 1;
    const reducedFactor = this.reducedMotion ? 0.72 : 1;

    dustMaterial.uniforms.uOpacity.value = 0.16 * wireOpacityBoost * reducedFactor;
    dustMaterial.uniforms.uGlowBoost.value = wireGlowBoost;

    for (let index = 0; index < alphas.length; index += 1) {
      const positionIndex = index * 3;
      const velocityIndex = index * 2;
      let x = positions[positionIndex];
      let y = positions[positionIndex + 1];
      let velocityX = velocities[velocityIndex];
      let velocityY = velocities[velocityIndex + 1];
      const ambient =
        Math.sin(time * (0.08 + depths[index] * 0.04) + seeds[index] * Math.PI * 2) +
        Math.cos((x + y) * 0.9 + seeds[index] * 8.2);

      velocityX += Math.cos(ambient) * 0.000012 * (0.8 + depths[index] * 0.4);
      velocityY += Math.sin(ambient) * 0.00001 * (0.72 + depths[index] * 0.42);

      if (dualCenter && targetRadius > 0.08) {
        const toCenter = subtract(dualCenter, { x, y });
        const distance = Math.max(0.0001, Math.hypot(toCenter.x, toCenter.y));
        const direction = normalize(toCenter);
        const influence = smoothstep(targetRadius * 1.9, targetRadius * 0.3, distance) * 0.18;
        velocityX += direction.x * influence * 0.00028;
        velocityY += direction.y * influence * 0.00024;
      }

      x += velocityX * delta * 60;
      y += velocityY * delta * 60;
      velocityX *= 0.986;
      velocityY *= 0.986;

      if (x < -horizontalLimit) {
        x = horizontalLimit;
      } else if (x > horizontalLimit) {
        x = -horizontalLimit;
      }
      if (y < -1.12) {
        y = 1.12;
      } else if (y > 1.12) {
        y = -1.12;
      }

      positions[positionIndex] = x;
      positions[positionIndex + 1] = y;
      positions[positionIndex + 2] = -0.22 + depths[index] * 0.18;
      velocities[velocityIndex] = velocityX;
      velocities[velocityIndex + 1] = velocityY;
      sizes[index] = (0.82 + depths[index] * 1.28) * this.pointScale;
      alphas[index] = clamp(0.08 + depths[index] * 0.14 + Math.sin(time * 0.34 + seeds[index] * 10) * 0.03, 0.06, 0.24);
    }

    this.dustParticles.geometry.attributes.position.needsUpdate = true;
    this.dustParticles.geometry.attributes.aSize.needsUpdate = true;
    this.dustParticles.geometry.attributes.aAlpha.needsUpdate = true;
  }

  private updateSparkBurst(delta: number) {
    if (!this.sparkBuffers || !this.releaseSparks) {
      return;
    }

    const { positions, velocities, alphas, ages, lifetimes, actives, sizes } = this.sparkBuffers;
    const positionAttribute = this.releaseSparks.geometry.attributes.position;
    const alphaAttribute = this.releaseSparks.geometry.attributes.aAlpha;
    const ageAttribute = this.releaseSparks.geometry.attributes.aAge;
    const activeAttribute = this.releaseSparks.geometry.attributes.aActive;
    let anyActive = false;

    for (let index = 0; index < actives.length; index += 1) {
      if (actives[index] < 0.5) {
        continue;
      }

      anyActive = true;
      ages[index] += delta / Math.max(lifetimes[index], 0.0001);
      const normalizedAge = clamp(ages[index], 0, 1);
      const positionIndex = index * 3;
      const velocityIndex = index * 2;

      positions[positionIndex] += velocities[velocityIndex] * delta * 60;
      positions[positionIndex + 1] += velocities[velocityIndex + 1] * delta * 60;
      velocities[velocityIndex] *= 0.96;
      velocities[velocityIndex + 1] *= 0.96;
      alphas[index] = (1 - normalizedAge) * (0.72 + sizes[index] / Math.max(this.overlayScale * 12, 0.0001) * 0.22);
      if (normalizedAge >= 0.999) {
        actives[index] = 0;
        alphas[index] = 0;
      }
    }

    positionAttribute.needsUpdate = true;
    alphaAttribute.needsUpdate = true;
    ageAttribute.needsUpdate = true;
    activeAttribute.needsUpdate = true;
    this.releaseSparks.visible = anyActive;
    (this.releaseSparks.material as THREE.ShaderMaterial).uniforms.uOpacity.value = anyActive ? 1 : 0;
  }

  private updateDisplayHandState(handIndex: number, hand: InteractionState["hands"][number], delta: number) {
    const state = this.displayHands[handIndex];
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
      state.trail = state.trail.map((_, index) => {
        const target = hand.trail[index] ?? hand.palm;
        return { ...target };
      });
      return state;
    }

    state.palm = lerpPoint(state.palm, predictedPalm, geometryAlpha);
    state.ellipseAngle = lerpWrappedAngle(state.ellipseAngle, hand.ellipseAngle, angleAlpha);
    state.ellipseRadiusX = lerp(state.ellipseRadiusX, hand.ellipseRadiusX, radiusAlpha);
    state.ellipseRadiusY = lerp(state.ellipseRadiusY, hand.ellipseRadiusY, radiusAlpha);
    state.presence = lerp(state.presence, hand.presence, presenceAlpha);

    for (let index = 0; index < state.fingertips.length; index += 1) {
      const target = hand.fingertips[index] ?? hand.palm;
      state.fingertips[index] = lerpPoint(state.fingertips[index], target, tipAlpha);
    }

    for (let index = 0; index < state.trail.length; index += 1) {
      const target = hand.trail[index] ?? hand.palm;
      state.trail[index] = lerpPoint(state.trail[index], target, trailAlpha);
    }

    return state;
  }

  private resetDisplayHandState(handIndex: number) {
    const state = this.displayHands[handIndex];
    state.initialized = false;
    state.presence = 0;
  }

  private updateHandsVisuals(delta: number) {
    for (let handIndex = 0; handIndex < 2; handIndex += 1) {
      const hand = this.interaction.hands[handIndex];
      const ringSystem = this.palmRings[handIndex];
      const detailSystem = this.palmRingDetails[handIndex];
      const orbital = this.palmOrbitArcs[handIndex];
      const core = this.palmCores[handIndex];
      const tips = this.tipSprites[handIndex];
      const trail = this.trailLines[handIndex];
      const wireframe = this.handWireframes[handIndex];
      const trailAttribute = trail.line.geometry.attributes.position as THREE.BufferAttribute;

      if (!hand) {
        this.resetDisplayHandState(handIndex);
        ringSystem.points.visible = false;
        detailSystem.points.visible = false;
        orbital.visible = false;
        core.visible = false;
        tips.forEach((tip) => {
          tip.visible = false;
        });
        (trail.line.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 0;
        trail.line.visible = false;
        wireframe.line.visible = false;
        continue;
      }

      const displayHand = this.updateDisplayHandState(handIndex, hand, delta);
      const palmPoint = toSceneVector(displayHand.palm);
      const time = this.renderTime;
      const motionDamp = this.interaction.dualActive ? 0.58 : 1;
      const pulse = 1 + Math.sin(time * 1.8 + handIndex * 0.7) * 0.024;
      const ripple = hand.openImpulseAmount * 0.22;
      const contraction = hand.attractionAmount * 0.06;
      const overlayOrbitBoost = this.reducedMotion ? 0.82 : 1.62;
      const ambientOuterSpin = time * (0.3 + handIndex * 0.04) * motionDamp * overlayOrbitBoost;
      const ambientDetailSpin = time * (0.48 + handIndex * 0.05) * motionDamp * overlayOrbitBoost;
      const orbitalSpin =
        time *
        (0.72 + hand.openImpulseAmount * 1.04 + hand.openAmount * 0.18 + hand.attractionAmount * 0.12) *
        motionDamp *
        overlayOrbitBoost;
      const contourFlow =
        0.5 + Math.sin(time * (2.1 + handIndex * 0.18) + displayHand.palm.x * 2.8 + displayHand.palm.y) * 0.5;
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
      const overlayModeBoost = this.wireframeMode ? 1.12 : 1;
      const trailModeBoost = this.wireframeMode ? 1.18 : 1;
      const outerColor = overlayPalette.biasColor;
      const detailColor = overlayPalette.secondaryColor.clone().lerp(overlayPalette.accentCool, 0.34 + (1 - contourFlow) * 0.18);
      const orbitalColor = overlayPalette.biasColor.clone().lerp(overlayPalette.energyColor, 0.16 + gestureEnergy * 0.24);
      const coreColor = overlayPalette.coreColor;
      const trailColor = overlayPalette.trailColor;

      wireframe.line.visible = false;
      const ringWidth =
        Math.max(displayHand.ellipseRadiusX * 2.24 * (1 + hand.attractionAmount * 0.05 + hand.openAmount * 0.02), 0.16) *
        pulse *
        (1 + ripple * 0.35 - contraction);
      const ringHeight =
        Math.max(displayHand.ellipseRadiusY * 2.24 * (1 + hand.attractionAmount * 0.04 + hand.openAmount * 0.04), 0.2) *
        pulse *
        (1 + ripple * 0.28 - contraction * 0.82);
      const detailWidth = ringWidth * (0.94 + glowBreath * 0.02 + hand.attractionAmount * 0.02);
      const detailHeight = ringHeight * (0.94 + glowBreath * 0.02 + hand.attractionAmount * 0.02);
      const orbitalWidth = ringWidth * (1.01 + contourFlow * 0.03 + hand.openImpulseAmount * 0.05);
      const orbitalHeight = ringHeight * (1.01 + contourFlow * 0.03 + hand.openImpulseAmount * 0.04);
      const coreWidth = ringWidth * (0.36 + hand.attractionAmount * 0.06 + hand.openImpulseAmount * 0.05 + glowBreath * 0.015);
      const coreHeight = ringHeight * (0.36 + hand.attractionAmount * 0.04 + hand.openImpulseAmount * 0.05 + glowBreath * 0.015);
      const outerOpacity =
        displayHand.presence *
        (this.interaction.dualActive ? 0.78 : 0.7 + hand.attractionAmount * 0.22 + hand.openImpulseAmount * 0.16) *
        (0.94 + contourFlow * 0.14) *
        overlayModeBoost;
      const detailOpacity =
        displayHand.presence *
        (this.interaction.dualActive ? 0.44 : 0.38 + hand.attractionAmount * 0.08 + hand.openImpulseAmount * 0.08) *
        (0.82 + contourFlow * 0.14) *
        overlayModeBoost;
      const highlightPhase = (time * (0.22 + hand.openImpulseAmount * 0.08 + hand.speed * 0.03) + handIndex * 0.18) % 1;

      orbital.visible = true;
      core.visible = true;
      orbital.position.copy(palmPoint);
      core.position.copy(palmPoint);
      orbital.scale.set(orbitalWidth, orbitalHeight, 1);
      core.scale.set(coreWidth, coreHeight, 1);
      this.updateRingParticleSystem(ringSystem, {
        center: displayHand.palm,
        rotation: displayHand.ellipseAngle + ambientOuterSpin * (0.38 - hand.attractionAmount * 0.18),
        radiusX: ringWidth * 0.5,
        radiusY: ringHeight * 0.5,
        color: outerColor,
        haloColor: overlayPalette.accentCool,
        opacity: outerOpacity,
        jitterAmplitude: Math.min(ringWidth, ringHeight) * (0.004 + hand.openImpulseAmount * 0.0015),
        driftSpeed:
          (0.98 + hand.openImpulseAmount * 0.34 + hand.attractionAmount * 0.12 + hand.openAmount * 0.08) *
          overlayOrbitBoost,
        time,
        flowAmount: 0.018 + contourFlow * 0.012,
        zOffset: 0.001,
        highlightPhase,
        highlightWidth: this.reducedMotion ? 0.16 : 0.12,
        highlightStrength: this.reducedMotion ? 0.24 : 0.34,
        leadBoost: this.reducedMotion ? 0.16 : 0.28,
      });
      this.updateRingParticleSystem(detailSystem, {
        center: displayHand.palm,
        rotation: displayHand.ellipseAngle - ambientDetailSpin * (0.42 - hand.attractionAmount * 0.12),
        radiusX: detailWidth * 0.5,
        radiusY: detailHeight * 0.5,
        color: detailColor,
        haloColor: outerColor,
        opacity: detailOpacity,
        jitterAmplitude: Math.min(detailWidth, detailHeight) * 0.002,
        driftSpeed: (-0.82 - contourFlow * 0.16 - hand.openImpulseAmount * 0.08) * overlayOrbitBoost,
        time,
        flowAmount: 0.012 + glowBreath * 0.008,
        zOffset: 0.002,
        highlightPhase: (highlightPhase + 0.42) % 1,
        highlightWidth: this.reducedMotion ? 0.24 : 0.2,
        highlightStrength: 0.14,
        leadBoost: 0.08,
      });
      orbitalMaterial.rotation = displayHand.ellipseAngle + orbitalSpin;
      coreMaterial.rotation = displayHand.ellipseAngle - ambientOuterSpin * 0.08;
      orbitalMaterial.color.copy(orbitalColor);
      coreMaterial.color.copy(coreColor);
      orbitalMaterial.opacity =
        displayHand.presence *
        (this.interaction.dualActive ? 0.26 : 0.22 + hand.openImpulseAmount * 0.2 + hand.openAmount * 0.04 + hand.attractionAmount * 0.06) *
        (0.76 + contourFlow * 0.24);
      coreMaterial.opacity =
        displayHand.presence *
        (0.18 + hand.attractionAmount * 0.16 + hand.openImpulseAmount * 0.1) *
        (0.82 + glowBreath * 0.18) *
        overlayModeBoost;

      tips.forEach((tip, tipIndex) => {
        const tipPoint = toSceneVector(displayHand.fingertips[tipIndex] ?? displayHand.palm);
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
          displayHand.presence *
          (0.22 + hand.openAmount * 0.28 + hand.attractionAmount * 0.08 + hand.openImpulseAmount * 0.1);
      });

      const positions = trail.positions;
      displayHand.trail.forEach((point, trailIndex) => {
        positions[trailIndex * 3] = point.x;
        positions[trailIndex * 3 + 1] = point.y;
        positions[trailIndex * 3 + 2] = 0;
      });
      for (let trailIndex = displayHand.trail.length; trailIndex < positions.length / 3; trailIndex += 1) {
        positions[trailIndex * 3] = displayHand.palm.x;
        positions[trailIndex * 3 + 1] = displayHand.palm.y;
        positions[trailIndex * 3 + 2] = 0;
      }
      trailAttribute.needsUpdate = true;
      trail.line.visible = true;
      const trailMaterial = trail.line.material as THREE.ShaderMaterial;
      trailMaterial.uniforms.uColor.value.copy(trailColor);
      trailMaterial.uniforms.uHeadColor.value.copy(overlayPalette.haloColor.clone().lerp(overlayPalette.energyColor, 0.22));
      trailMaterial.uniforms.uOpacity.value = displayHand.presence * (this.interaction.dualActive ? 0.58 : 0.72) * trailModeBoost;
      trailMaterial.uniforms.uWireBoost.value = this.wireframeMode ? 1.16 : 1;
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
    this.triggerSparkBurst(center, radius, axis, burstStrength);
  }

  private triggerSparkBurst(center: Vec2, radius: number, axis: Vec2, burstStrength: number) {
    if (!this.sparkBuffers || !this.releaseSparks) {
      return;
    }

    const { positions, velocities, alphas, ages, lifetimes, actives, sizes, seeds } = this.sparkBuffers;
    for (let index = 0; index < actives.length; index += 1) {
      const angle = (index / actives.length) * Math.PI * 2 + seeds[index] * 0.9;
      const outward = normalize({
        x: Math.cos(angle) + axis.x * THREE.MathUtils.randFloatSpread(0.34),
        y: Math.sin(angle) + axis.y * THREE.MathUtils.randFloatSpread(0.34),
      });
      const tangential = perpendicular(outward);
      const positionIndex = index * 3;
      const velocityIndex = index * 2;
      const spawnRadius = THREE.MathUtils.randFloat(radius * 0.04, radius * (0.12 + burstStrength * 0.08));
      positions[positionIndex] = center.x + outward.x * spawnRadius;
      positions[positionIndex + 1] = center.y + outward.y * spawnRadius;
      positions[positionIndex + 2] = 0.03;
      velocities[velocityIndex] =
        outward.x * (0.012 + burstStrength * 0.014) + tangential.x * THREE.MathUtils.randFloatSpread(0.004);
      velocities[velocityIndex + 1] =
        outward.y * (0.012 + burstStrength * 0.014) + tangential.y * THREE.MathUtils.randFloatSpread(0.004);
      sizes[index] = THREE.MathUtils.randFloat(4.8, 9.6) * this.overlayScale * (0.92 + burstStrength * 0.42);
      alphas[index] = THREE.MathUtils.randFloat(0.64, 0.96);
      ages[index] = 0;
      lifetimes[index] = THREE.MathUtils.randFloat(0.18, 0.34);
      actives[index] = 1;
    }

    this.releaseSparks.geometry.attributes.position.needsUpdate = true;
    this.releaseSparks.geometry.attributes.aSize.needsUpdate = true;
    this.releaseSparks.geometry.attributes.aAlpha.needsUpdate = true;
    this.releaseSparks.geometry.attributes.aAge.needsUpdate = true;
    this.releaseSparks.geometry.attributes.aActive.needsUpdate = true;
    this.releaseSparks.visible = true;
    (this.releaseSparks.material as THREE.ShaderMaterial).uniforms.uOpacity.value = 1;
  }

  private updateImplosionVisual() {
    if (this.dualImplosion.phase === "idle" || this.dualImplosion.phase === "cooldown" || !this.dualImplosion.center) {
      this.implosionBloom.visible = false;
      this.compressionHalo.visible = false;
      this.releaseRing.visible = false;
      return;
    }

    const bloomMaterial = this.implosionBloom.material as THREE.SpriteMaterial;
    const haloMaterial = this.compressionHalo.material as THREE.SpriteMaterial;
    const ringMaterial = this.releaseRing.material as THREE.SpriteMaterial;
    const center = this.dualImplosion.center;
    const mix = clamp((this.dualImplosion.paletteBias + 1) * 0.5, 0, 1);
    const biasWave = ION_CYAN.clone().lerp(ACCRETION_PINK, mix);
    const flashColor = EVENT_GOLD.clone().lerp(HOT_HALO, 0.44).lerp(biasWave, 0.16);
    const radius = Math.max(this.dualImplosion.radius, 0.14);
    const axisAngle = Math.atan2(this.dualImplosion.axis.y, this.dualImplosion.axis.x);
    const dualFxBoost = this.wireframeMode ? 1.2 : 1;
    let opacity = 0;
    let scaleValue = radius * 1.8;
    let haloOpacity = 0;
    let haloScaleX = radius * 1.9;
    let haloScaleY = radius * 1.18;
    let ringOpacity = 0;
    let ringScale = radius * 0.82;

    if (this.dualImplosion.phase === "gather") {
      const progress = clamp(this.dualImplosion.elapsed / 0.12, 0, 1);
      opacity = 0.18 + progress * 0.16;
      scaleValue = radius * (1.9 - progress * 0.45);
      haloOpacity = (0.18 + progress * 0.14) * dualFxBoost;
      haloScaleX = radius * lerp(2.2, 1.62, progress);
      haloScaleY = radius * lerp(1.28, 0.92, progress);
    } else if (this.dualImplosion.phase === "implode") {
      const progress = clamp(this.dualImplosion.elapsed / 0.16, 0, 1);
      opacity = 0.28 + progress * 0.22;
      scaleValue = radius * (1.46 - progress * 0.68);
      haloOpacity = (0.24 + progress * 0.18) * dualFxBoost;
      haloScaleX = radius * lerp(1.56, 0.92, progress);
      haloScaleY = radius * lerp(0.94, 0.54, progress);
    } else if (this.dualImplosion.phase === "release") {
      const progress = clamp(this.dualImplosion.elapsed / 0.2, 0, 1);
      opacity = 0.46 - progress * 0.2;
      scaleValue = radius * (0.54 + progress * (1.9 + this.dualImplosion.releaseBurstStrength * 0.7));
      haloOpacity = (0.22 - progress * 0.2) * dualFxBoost;
      haloScaleX = radius * (0.9 + progress * 0.82);
      haloScaleY = radius * (0.62 + progress * 0.46);
      ringOpacity = (0.52 - progress * 0.34) * dualFxBoost;
      ringScale = radius * (0.54 + progress * (2.4 + this.dualImplosion.releaseBurstStrength * 0.86));
    } else {
      const progress = clamp(this.dualImplosion.elapsed / 0.14, 0, 1);
      opacity = (1 - progress) * 0.76;
      scaleValue = radius * (1.2 + progress * 2.8);
      haloOpacity = (1 - progress) * 0.16 * dualFxBoost;
      ringOpacity = (1 - progress) * 0.18 * dualFxBoost;
      ringScale = radius * (1.18 + progress * 1.2);
    }

    this.implosionBloom.visible = true;
    this.implosionBloom.position.set(center.x, center.y, 0);
    this.implosionBloom.scale.set(scaleValue, scaleValue, 1);
    bloomMaterial.color.copy(flashColor);
    bloomMaterial.opacity = opacity * dualFxBoost;

    this.compressionHalo.visible = haloOpacity > 0.01;
    this.compressionHalo.position.set(center.x, center.y, 0.01);
    this.compressionHalo.scale.set(haloScaleX, haloScaleY, 1);
    haloMaterial.rotation = axisAngle;
    haloMaterial.color.copy(biasWave.clone().lerp(this.paletteHalo, this.dualImplosion.phase === "release" ? 0.22 : 0.12));
    haloMaterial.opacity = haloOpacity;

    this.releaseRing.visible = ringOpacity > 0.01;
    this.releaseRing.position.set(center.x, center.y, 0.02);
    this.releaseRing.scale.set(ringScale * 1.12, ringScale, 1);
    ringMaterial.rotation = axisAngle;
    ringMaterial.color.copy(flashColor);
    ringMaterial.opacity = ringOpacity * (this.reducedMotion ? 0.82 : 1);
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
