import * as THREE from "three";
import { getQualityProfile } from "@/config/experience";
import { average, clamp, lerp, normalize, scale, subtract } from "@/lib/math";
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
  baseSizes: Float32Array;
}

function toSceneVector(point: Vec2) {
  return new THREE.Vector3(point.x, point.y, 0);
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
  context.strokeStyle = "rgba(255,255,255,0.92)";
  context.lineWidth = 6;
  context.beginPath();
  context.arc(size / 2, size / 2, size / 2 - 10, 0, Math.PI * 2);
  context.stroke();

  context.strokeStyle = "rgba(255,255,255,0.34)";
  context.lineWidth = 2;
  context.beginPath();
  context.arc(size / 2, size / 2, size / 2 - 24, 0, Math.PI * 2);
  context.stroke();

  return new THREE.CanvasTexture(canvas);
}

const BLUE = new THREE.Color("#7febff");
const PINK = new THREE.Color("#F83EA5");
const WHITE = new THREE.Color("#fff6fb");

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
  private particles!: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private particleBuffers!: ParticleBuffers;
  private palmRings: THREE.Sprite[] = [];
  private palmCores: THREE.Sprite[] = [];
  private tipSprites: THREE.Sprite[][] = [];
  private trailLines: THREE.Line[] = [];
  private glowTexture = createGlowTexture(1, 0);
  private ringTexture = createRingTexture();
  private readonly palettePrimary = new THREE.Color(BLUE);
  private readonly paletteSecondary = new THREE.Color(BLUE);
  private readonly paletteHighlight = new THREE.Color(WHITE);
  private readonly paletteTrail = new THREE.Color(BLUE);

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
    this.applyViewportMapping(this.viewportMapping.sceneHalfWidth, false);
    this.createHandsVisuals();
    this.setQualityTier(tier, false);
  }

  setInteraction(interaction: InteractionState) {
    this.interaction = interaction;
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

  private updatePalette(bias: number) {
    const mix = clamp((bias + 1) * 0.5, 0, 1);
    this.palettePrimary.copy(BLUE).lerp(PINK, mix);
    this.paletteSecondary.copy(this.palettePrimary).lerp(WHITE, 0.34);
    this.paletteHighlight.copy(this.palettePrimary).lerp(WHITE, 0.52);
    this.paletteTrail.copy(this.palettePrimary).lerp(WHITE, 0.16);

    if (this.particles) {
      const material = this.particles.material;
      material.uniforms.uColorA.value.copy(this.paletteSecondary);
      material.uniforms.uColorB.value.copy(this.palettePrimary);
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
        uColorA: { value: this.paletteSecondary.clone() },
        uColorB: { value: this.palettePrimary.clone() },
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
    this.updatePalette(this.interaction.paletteBias);
  }

  private createHandsVisuals() {
    for (let handIndex = 0; handIndex < 2; handIndex += 1) {
      const ringMaterial = new THREE.SpriteMaterial({
        map: this.ringTexture,
        color: this.palettePrimary.clone(),
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      });
      const coreMaterial = new THREE.SpriteMaterial({
        map: this.glowTexture,
        color: this.paletteHighlight.clone(),
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
      trailGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(24 * 3), 3));
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
    this.updatePalette(this.interaction.paletteBias);
    const { positions, velocities, sizes, alphas, seeds, baseSizes } = this.particleBuffers;
    const activeHands = this.interaction.hands.map((hand) => ({
      ...hand,
      scenePalm: hand.palm,
      sceneVelocity: scale(hand.velocity, 0.025),
      sceneRadius: Math.max(
        0.18,
        hand.radius *
          (hand.gesture === "closedFist" ? 7.2 + hand.closure * 4.6 : hand.gesture === "openPalm" ? 5.4 + hand.openAmount * 2.4 : 3.8),
      ),
    }));
    const dualCenter =
      this.interaction.dualActive && activeHands.length > 1
        ? average(activeHands.map((hand) => hand.palm))
        : null;
    const dualRadius = dualCenter ? Math.max(0.22, this.interaction.dualDistance * 0.92) : 0;
    const dualInfluenceRadius = dualRadius > 0 ? dualRadius * 1.42 : 0;
    const horizontalLimit = this.viewportMapping.sceneHalfWidth * 1.12;

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

      if (dualCenter && dualRadius > 0.06) {
        const deltaVector = subtract(dualCenter, { x, y });
        const pointDistance = Math.max(0.0001, Math.hypot(deltaVector.x, deltaVector.y));
        const direction = normalize(deltaVector);
        const orbital = normalize({ x: -direction.y, y: direction.x });
        const influence = clamp(1 - pointDistance / dualInfluenceRadius, 0, 1);
        const closeness = this.interaction.dualCloseness;
        const band = clamp(1 - Math.abs(pointDistance - dualRadius) / Math.max(dualRadius * 0.72, 0.0001), 0, 1);

        velocityX += direction.x * this.profile.attractForce * influence * (0.001 + closeness * 0.0043);
        velocityY += direction.y * this.profile.attractForce * influence * (0.001 + closeness * 0.0043);
        velocityX += orbital.x * band * (0.00018 + (1 - closeness) * 0.001);
        velocityY += orbital.y * band * (0.00018 + (1 - closeness) * 0.001);

        if (pointDistance > dualRadius * 1.08) {
          const outerPull = clamp((pointDistance - dualRadius * 1.08) / Math.max(dualRadius, 0.0001), 0, 1);
          velocityX += direction.x * outerPull * (0.00045 + closeness * 0.0012);
          velocityY += direction.y * outerPull * (0.00045 + closeness * 0.0012);
        }

        glow += influence * (0.32 + closeness * 0.48) + band * 0.22;
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
          glow += influence * (0.22 + hand.openAmount * 0.28 + hand.closure * 0.36);

          if (hand.gesture === "closedFist") {
            velocityX += direction.x * this.profile.attractForce * influence * (0.0016 + hand.closure * 0.0045);
            velocityY += direction.y * this.profile.attractForce * influence * (0.0016 + hand.closure * 0.0045);
            velocityX += tangential.x * influence * 0.00035 * (0.6 + hand.closure);
            velocityY += tangential.y * influence * 0.00035 * (0.6 + hand.closure);
          } else if (hand.gesture === "openPalm") {
            velocityX -= direction.x * this.profile.repelForce * influence * (0.0012 + hand.openAmount * 0.004);
            velocityY -= direction.y * this.profile.repelForce * influence * (0.0012 + hand.openAmount * 0.004);
            velocityX += tangential.x * influence * 0.00024 * (0.5 + hand.openAmount);
            velocityY += tangential.y * influence * 0.00024 * (0.5 + hand.openAmount);
          }

          if (hand.gesture === "sweep" || hand.speed > 1.15) {
            velocityX += hand.sceneVelocity.x * this.profile.sweepForce * influence * 0.042;
            velocityY -= hand.sceneVelocity.y * this.profile.sweepForce * influence * 0.042;
            velocityX += tangential.x * influence * 0.0005 * (hand.speed + 0.18);
            velocityY += tangential.y * influence * 0.0005 * (hand.speed + 0.18);
          }
        });
      }

      velocityX *= this.reducedMotion ? 0.958 : 0.972;
      velocityY *= this.reducedMotion ? 0.958 : 0.972;
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

      const palmPoint = toSceneVector(hand.palm);
      const pulse = 1 + Math.sin(this.interaction.lastUpdated * 0.005 + handIndex) * 0.08;
      const ringMaterial = ring.material as THREE.SpriteMaterial;
      const coreMaterial = core.material as THREE.SpriteMaterial;
      const ringFlatten = lerp(0.45, 1, hand.sideTilt);
      const coreFlatten = lerp(0.72, 1, hand.sideTilt);
      const baseScale = hand.radius * (3 + hand.openAmount * 0.8 + hand.closure * 0.9) * pulse * this.overlayScale;
      const overlayBias = clamp(this.interaction.paletteBias + (this.interaction.dualActive ? 0 : hand.paletteBias * 0.18), -1, 1);
      const overlayMix = clamp((overlayBias + 1) * 0.5, 0, 1);
      const tipPrimary = BLUE.clone().lerp(PINK, overlayMix);
      const tipSecondary = tipPrimary.clone().lerp(WHITE, 0.42);
      const trailColor = tipPrimary.clone().lerp(WHITE, 0.16);

      ring.visible = true;
      core.visible = true;
      ring.position.copy(palmPoint);
      core.position.copy(palmPoint);
      ring.scale.set(baseScale, baseScale * ringFlatten, 1);
      core.scale.set(baseScale * 0.52, baseScale * 0.52 * coreFlatten, 1);
      ringMaterial.rotation = hand.rollAngle;
      coreMaterial.rotation = hand.rollAngle;
      ringMaterial.color.copy(tipPrimary);
      coreMaterial.color.copy(tipSecondary);
      ringMaterial.opacity =
        hand.presence *
        (hand.gesture === "closedFist" ? 0.94 : hand.gesture === "openPalm" ? 0.78 : this.interaction.dualActive ? 0.72 : 0.56);
      coreMaterial.opacity = hand.presence * (0.34 + hand.openAmount * 0.22 + hand.closure * 0.32);

      tips.forEach((tip, tipIndex) => {
        const tipPoint = toSceneVector(hand.fingertips[tipIndex]);
        tip.visible = true;
        tip.position.copy(tipPoint);
        const tipScale =
          this.profile.tipScale * (tipIndex === 1 ? 1.18 : 1) * (0.72 + hand.openAmount * 0.95 + hand.closure * 0.22) * this.overlayScale;
        tip.scale.setScalar(tipScale);
        const tipMaterial = tip.material as THREE.SpriteMaterial;
        tipMaterial.color.copy(tipIndex % 2 === 0 ? tipPrimary : tipSecondary);
        tipMaterial.opacity = hand.presence * (0.42 + hand.openAmount * 0.4);
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
      trailMaterial.opacity = hand.presence * (this.interaction.dualActive ? 0.58 : 0.72);
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
}
