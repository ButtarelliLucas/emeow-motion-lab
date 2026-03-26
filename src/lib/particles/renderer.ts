import * as THREE from "three";
import { getQualityProfile } from "@/config/experience";
import { average, clamp, distance, lerp, normalize, scale, subtract } from "@/lib/math";
import { nextHigherQuality, nextLowerQuality } from "@/lib/quality";
import type { InteractionState, QualityTier, Vec2 } from "@/types/experience";

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
  baseSizes: Float32Array;
}

function toScenePoint(point: Vec2) {
  return new THREE.Vector3(point.x * 2 - 1, 1 - point.y * 2, 0);
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
  gradient.addColorStop(0.38, "rgba(128,235,255,0.9)");
  gradient.addColorStop(0.65, "rgba(255,233,175,0.35)");
  gradient.addColorStop(1, `rgba(255,255,255,${outerOpacity})`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);

  return new THREE.CanvasTexture(canvas);
}

function createRingTexture() {
  const size = 160;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("2D context unavailable");
  }

  context.clearRect(0, 0, size, size);
  context.strokeStyle = "rgba(128,235,255,0.95)";
  context.lineWidth = 6;
  context.beginPath();
  context.arc(size / 2, size / 2, size / 2 - 10, 0, Math.PI * 2);
  context.stroke();

  context.strokeStyle = "rgba(255,233,175,0.45)";
  context.lineWidth = 2;
  context.beginPath();
  context.arc(size / 2, size / 2, size / 2 - 24, 0, Math.PI * 2);
  context.stroke();

  return new THREE.CanvasTexture(canvas);
}

export class ParticleFieldRenderer {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  private readonly canvas: HTMLCanvasElement;
  private readonly onQualityChange: (tier: QualityTier) => void;
  private readonly onStats: (frameMs: number) => void;
  private readonly reducedMotion: boolean;
  private tier: QualityTier = "medium";
  private profile = getQualityProfile("medium", false);
  private interaction: InteractionState = {
    hands: [],
    handsDetected: false,
    primaryGesture: "idle",
    dualActive: false,
    lastUpdated: 0,
  };
  private running = false;
  private paused = false;
  private rafId = 0;
  private lastFrame = 0;
  private frameMs = 16.7;
  private qualityDrift = 0;
  private pointScale = 3;
  private particles!: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private particleBuffers!: ParticleBuffers;
  private palmRings: THREE.Sprite[] = [];
  private palmCores: THREE.Sprite[] = [];
  private tipSprites: THREE.Sprite[][] = [];
  private trailLines: THREE.Line[] = [];
  private glowTexture = createGlowTexture(1, 0);
  private ringTexture = createRingTexture();

  constructor(canvas: HTMLCanvasElement, { tier, reducedMotion, onQualityChange, onStats }: RendererOptions) {
    this.canvas = canvas;
    this.onQualityChange = onQualityChange;
    this.onStats = onStats;
    this.reducedMotion = reducedMotion;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      powerPreference: "high-performance",
    });
    this.renderer.setClearColor(0x000000, 0);
    this.camera.position.z = 2;
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.2));
    this.createHandsVisuals();
    this.setQualityTier(tier, false);
    this.resize();
    window.addEventListener("resize", this.resize);
  }

  setInteraction(interaction: InteractionState) {
    this.interaction = interaction;
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
    window.removeEventListener("resize", this.resize);
    this.renderer.dispose();
    this.glowTexture.dispose();
    this.ringTexture.dispose();
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
    this.buildParticles();

    if (emit) {
      this.onQualityChange(tier);
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
    const baseSizes = new Float32Array(count);

    for (let index = 0; index < count; index += 1) {
      const positionIndex = index * 3;
      const velocityIndex = index * 2;
      positions[positionIndex] = THREE.MathUtils.randFloatSpread(2);
      positions[positionIndex + 1] = THREE.MathUtils.randFloatSpread(2);
      positions[positionIndex + 2] = THREE.MathUtils.randFloat(-0.06, 0.08);
      velocities[velocityIndex] = THREE.MathUtils.randFloatSpread(0.0014);
      velocities[velocityIndex + 1] = THREE.MathUtils.randFloatSpread(0.0014);
      seeds[index] = Math.random();
      baseSizes[index] = THREE.MathUtils.randFloat(1.3, 4.6);
      sizes[index] = baseSizes[index] * this.pointScale;
      alphas[index] = THREE.MathUtils.randFloat(0.18, 0.62);
    }

    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));
    geometry.setAttribute("aAlpha", new THREE.BufferAttribute(alphas, 1));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uColorA: { value: new THREE.Color("#7febff") },
        uColorB: { value: new THREE.Color("#fff0c2") },
      },
      vertexShader: `
        attribute float aSize;
        attribute float aAlpha;
        varying float vAlpha;
        varying float vMix;
        void main() {
          vAlpha = aAlpha;
          vMix = clamp((position.y + 1.0) * 0.5, 0.0, 1.0);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize;
        }
      `,
      fragmentShader: `
        uniform vec3 uColorA;
        uniform vec3 uColorB;
        varying float vAlpha;
        varying float vMix;
        void main() {
          vec2 uv = gl_PointCoord - vec2(0.5);
          float dist = length(uv);
          float alpha = smoothstep(0.52, 0.02, dist) * vAlpha;
          vec3 color = mix(uColorA, uColorB, vMix);
          gl_FragColor = vec4(color, alpha);
        }
      `,
    });

    const particles = new THREE.Points(geometry, material);
    particles.frustumCulled = false;

    if (this.particles) {
      this.scene.remove(this.particles);
      this.particles.geometry.dispose();
      this.particles.material.dispose();
    }

    this.particles = particles;
    this.particleBuffers = { positions, velocities, sizes, alphas, seeds, baseSizes };
    this.scene.add(this.particles);
  }

  private createHandsVisuals() {
    for (let handIndex = 0; handIndex < 2; handIndex += 1) {
      const ringMaterial = new THREE.SpriteMaterial({
        map: this.ringTexture,
        color: new THREE.Color("#7febff"),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const coreMaterial = new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: new THREE.Color("#fff1bf"),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const ring = new THREE.Sprite(ringMaterial);
      const core = new THREE.Sprite(coreMaterial);
      ring.visible = false;
      core.visible = false;
      this.palmRings.push(ring);
      this.palmCores.push(core);
      this.scene.add(ring, core);

      const tipGroup: THREE.Sprite[] = [];
      for (let tipIndex = 0; tipIndex < 5; tipIndex += 1) {
        const tip = new THREE.Sprite(
          new THREE.SpriteMaterial({
            map: this.glowTexture,
            color: new THREE.Color(tipIndex % 2 === 0 ? "#7febff" : "#fff0cb"),
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
      trailGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
      const trail = new THREE.Line(
        trailGeometry,
        new THREE.LineBasicMaterial({
          color: handIndex === 0 ? "#7febff" : "#fff0cb",
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      trail.frustumCulled = false;
      this.trailLines.push(trail);
      this.scene.add(trail);
    }
  }

  private readonly animate = (time: number) => {
    if (!this.running || this.paused) {
      this.rafId = 0;
      return;
    }

    const delta = Math.min(0.035, Math.max(0.012, (time - this.lastFrame) / 1000));
    this.lastFrame = time;
    const frameMs = delta * 1000;
    this.frameMs = lerp(this.frameMs, frameMs, 0.08);
    this.onStats(this.frameMs);

    this.updateParticles(time * 0.001, delta);
    this.updateHandsVisuals();
    this.renderer.render(this.scene, this.camera);
    this.adjustQuality();

    this.rafId = window.requestAnimationFrame(this.animate);
  };

  private updateParticles(time: number, delta: number) {
    const { positions, velocities, sizes, alphas, seeds, baseSizes } = this.particleBuffers;
    const activeHands = this.interaction.hands.map((hand) => ({
      ...hand,
      scenePalm: toScenePoint(hand.palm),
      sceneVelocity: scale(hand.velocity, 0.025),
      sceneRadius: Math.max(0.15, hand.radius * 2.8),
    }));
    const dualCenter =
      this.interaction.dualActive && activeHands.length > 1
        ? toScenePoint(average(activeHands.map((hand) => hand.palm)))
        : null;
    const dualRadius =
      dualCenter && activeHands.length > 1
        ? distance(activeHands[0].palm, activeHands[1].palm) * 1.9
        : 0;

    for (let index = 0; index < baseSizes.length; index += 1) {
      const positionIndex = index * 3;
      const velocityIndex = index * 2;
      let x = positions[positionIndex];
      let y = positions[positionIndex + 1];
      let velocityX = velocities[velocityIndex];
      let velocityY = velocities[velocityIndex + 1];
      let glow = 0.22 + Math.sin(time * 1.2 + seeds[index] * 10) * 0.08;

      const ambientAngle =
        Math.sin((y + time * 0.11 + seeds[index]) * 3.9) +
        Math.cos((x - time * 0.09 - seeds[index]) * 4.6);

      velocityX += Math.cos(ambientAngle) * 0.00042;
      velocityY += Math.sin(ambientAngle) * 0.00034;

      activeHands.forEach((hand) => {
        const deltaVector = subtract({ x: hand.scenePalm.x, y: hand.scenePalm.y }, { x, y });
        const pointDistance = Math.max(0.0001, Math.hypot(deltaVector.x, deltaVector.y));
        const influence = clamp(1 - pointDistance / hand.sceneRadius, 0, 1) * hand.presence;

        if (influence <= 0) {
          return;
        }

        const direction = normalize(deltaVector);
        const tangential = { x: -direction.y, y: direction.x };
        glow += influence * (hand.gesture === "openPalm" ? 0.4 : 0.5);

        if (hand.gesture === "pinch") {
          velocityX += direction.x * this.profile.attractForce * influence * 0.0023 * (0.45 + hand.pinchStrength);
          velocityY += direction.y * this.profile.attractForce * influence * 0.0023 * (0.45 + hand.pinchStrength);
        } else if (hand.gesture === "openPalm") {
          velocityX -= direction.x * this.profile.repelForce * influence * 0.002;
          velocityY -= direction.y * this.profile.repelForce * influence * 0.002;
        }

        if (hand.gesture === "sweep" || hand.speed > 1.3) {
          velocityX += hand.sceneVelocity.x * this.profile.sweepForce * influence * 0.038;
          velocityY -= hand.sceneVelocity.y * this.profile.sweepForce * influence * 0.038;
          velocityX += tangential.x * influence * 0.00055 * (hand.speed + 0.15);
          velocityY += tangential.y * influence * 0.00055 * (hand.speed + 0.15);
        }
      });

      if (dualCenter && dualRadius > 0.06) {
        const radial = subtract({ x, y }, { x: dualCenter.x, y: dualCenter.y });
        const band = Math.exp(-Math.pow(Math.hypot(radial.x, radial.y) - dualRadius, 2) / 0.055);
        const orbital = normalize({ x: -radial.y, y: radial.x });
        velocityX += orbital.x * band * 0.00115;
        velocityY += orbital.y * band * 0.00115;
        glow += band * 0.35;
      }

      velocityX *= this.reducedMotion ? 0.958 : 0.972;
      velocityY *= this.reducedMotion ? 0.958 : 0.972;
      x += velocityX * delta * 60;
      y += velocityY * delta * 60;

      if (x > 1.12) x = -1.12;
      if (x < -1.12) x = 1.12;
      if (y > 1.12) y = -1.12;
      if (y < -1.12) y = 1.12;

      positions[positionIndex] = x;
      positions[positionIndex + 1] = y;
      velocities[velocityIndex] = velocityX;
      velocities[velocityIndex + 1] = velocityY;
      sizes[index] = baseSizes[index] * this.pointScale * (1 + glow * 1.6);
      alphas[index] = clamp(0.15 + glow * 0.78, 0.08, 1);
    }

    this.particles.geometry.attributes.position.needsUpdate = true;
    this.particles.geometry.attributes.aSize.needsUpdate = true;
    this.particles.geometry.attributes.aAlpha.needsUpdate = true;
  }

  private updateHandsVisuals() {
    for (let handIndex = 0; handIndex < 2; handIndex += 1) {
      const hand = this.interaction.hands[handIndex];
      const ring = this.palmRings[handIndex];
      const core = this.palmCores[handIndex];
      const tips = this.tipSprites[handIndex];
      const trail = this.trailLines[handIndex];
      const trailAttribute = trail.geometry.attributes.position as THREE.BufferAttribute;

      if (!hand) {
        ring.visible = false;
        core.visible = false;
        tips.forEach((tip) => {
          tip.visible = false;
        });
        (trail.material as THREE.LineBasicMaterial).opacity = 0;
        continue;
      }

      const palmPoint = toScenePoint(hand.palm);
      const pulse = 1 + Math.sin(this.interaction.lastUpdated * 0.005 + handIndex) * 0.08;
      ring.visible = true;
      core.visible = true;
      ring.position.copy(palmPoint);
      core.position.copy(palmPoint);
      ring.scale.setScalar(hand.radius * 3.4 * pulse);
      core.scale.setScalar(hand.radius * 1.4 * (1 + hand.pinchStrength * 0.6));
      (ring.material as THREE.SpriteMaterial).opacity = hand.presence * (hand.gesture === "pinch" ? 0.92 : 0.55);
      (core.material as THREE.SpriteMaterial).opacity = hand.presence * (0.48 + hand.pinchStrength * 0.4);

      tips.forEach((tip, tipIndex) => {
        const tipPoint = toScenePoint(hand.fingertips[tipIndex]);
        tip.visible = true;
        tip.position.copy(tipPoint);
        const tipScale = this.profile.tipScale * (tipIndex === 1 ? 1.2 : 1) * (1 + hand.pinchStrength * 0.4);
        tip.scale.setScalar(tipScale);
        (tip.material as THREE.SpriteMaterial).opacity = hand.presence * 0.82;
      });

      const positions = trailAttribute.array as Float32Array;
      hand.trail.forEach((point, trailIndex) => {
        const trailPoint = toScenePoint(point);
        positions[trailIndex * 3] = trailPoint.x;
        positions[trailIndex * 3 + 1] = trailPoint.y;
        positions[trailIndex * 3 + 2] = 0;
      });
      for (let trailIndex = hand.trail.length; trailIndex < positions.length / 3; trailIndex += 1) {
        positions[trailIndex * 3] = palmPoint.x;
        positions[trailIndex * 3 + 1] = palmPoint.y;
        positions[trailIndex * 3 + 2] = 0;
      }
      trailAttribute.needsUpdate = true;
      (trail.material as THREE.LineBasicMaterial).opacity = hand.presence * 0.72;
    }
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

  private readonly resize = () => {
    const width = this.canvas.clientWidth || window.innerWidth;
    const height = this.canvas.clientHeight || window.innerHeight;
    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.profile.dprCap);
    this.pointScale = Math.max(1.7, Math.min(width, height) / 300);
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(width, height, false);
  };
}
