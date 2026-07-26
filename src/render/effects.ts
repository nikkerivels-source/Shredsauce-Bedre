import * as THREE from 'three';
import { clamp01, lerp } from '../core/math.ts';
import type { ContactReport } from '../physics/riderSim.ts';

/**
 * Carve trails.
 *
 * A rolling ribbon of quads laid down between the two edges of the contact
 * patch. Drawing geometry rather than painting into a texture keeps the tracks
 * sharp at any scale and costs one buffer update a frame instead of a multi-
 * megabyte upload.
 */
export class CarveTrail {
  readonly mesh: THREE.Mesh;
  private readonly maxSegments: number;
  private positions: Float32Array;
  private alphas: Float32Array;
  private geometry: THREE.BufferGeometry;
  private head = 0;
  private filled = 0;
  private lastLeft = new THREE.Vector3();
  private lastRight = new THREE.Vector3();
  private hasLast = false;
  private distanceSinceSegment = 0;

  constructor(maxSegments = 2600) {
    this.maxSegments = maxSegments;
    // Two triangles (6 vertices) per segment.
    this.positions = new Float32Array(maxSegments * 6 * 3);
    this.alphas = new Float32Array(maxSegments * 6);

    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setDrawRange(0, 0);

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
      uniforms: {
        uColor: { value: new THREE.Color(0x9fb6d4) },
      },
      vertexShader: `
        attribute float aAlpha;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uColor;
        varying float vAlpha;
        void main() {
          if (vAlpha <= 0.003) discard;
          gl_FragColor = vec4(uColor, vAlpha * 0.55);
        }`,
    });

    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  clear(): void {
    this.head = 0;
    this.filled = 0;
    this.hasLast = false;
    this.geometry.setDrawRange(0, 0);
  }

  /**
   * Appends a segment spanning the contact patch. `intensity` fades the track,
   * so a light edge leaves a hairline and a hard skid leaves a wide scar.
   */
  push(contacts: readonly ContactReport[], normal: THREE.Vector3, intensity: number): void {
    let first: ContactReport | null = null;
    let last: ContactReport | null = null;
    for (const c of contacts) {
      if (c.normalForce <= 1) continue;
      if (!first) first = c;
      last = c;
    }
    if (!first || !last || intensity <= 0.01) {
      this.hasLast = false;
      return;
    }

    _left.set(first.x, first.y, first.z).addScaledVector(normal, 0.02);
    _right.set(last.x, last.y, last.z).addScaledVector(normal, 0.02);
    // A skidding board scrapes a wider band than a railed edge.
    const widen = lerp(0.03, 0.16, clamp01(intensity));
    _dir.subVectors(_right, _left);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 0.1);
    _dir.normalize();
    _left.addScaledVector(_dir, -widen);
    _right.addScaledVector(_dir, widen);

    if (!this.hasLast) {
      this.lastLeft.copy(_left);
      this.lastRight.copy(_right);
      this.hasLast = true;
      this.distanceSinceSegment = 0;
      return;
    }

    // Only lay a segment every few centimetres so the buffer covers real ground.
    this.distanceSinceSegment += this.lastLeft.distanceTo(_left);
    if (this.distanceSinceSegment < 0.14) return;
    this.distanceSinceSegment = 0;

    const base = this.head * 18;
    const alphaBase = this.head * 6;
    const a = clamp01(intensity) * 0.9 + 0.1;

    const write = (offset: number, v: THREE.Vector3) => {
      this.positions[offset] = v.x;
      this.positions[offset + 1] = v.y;
      this.positions[offset + 2] = v.z;
    };
    write(base + 0, this.lastLeft);
    write(base + 3, this.lastRight);
    write(base + 6, _left);
    write(base + 9, _left);
    write(base + 12, this.lastRight);
    write(base + 15, _right);
    for (let i = 0; i < 6; i++) this.alphas[alphaBase + i] = a;

    this.lastLeft.copy(_left);
    this.lastRight.copy(_right);

    this.head = (this.head + 1) % this.maxSegments;
    this.filled = Math.min(this.filled + 1, this.maxSegments);

    const posAttr = this.geometry.getAttribute('position') as THREE.BufferAttribute;
    const alphaAttr = this.geometry.getAttribute('aAlpha') as THREE.BufferAttribute;
    posAttr.needsUpdate = true;
    alphaAttr.needsUpdate = true;
    this.geometry.setDrawRange(0, this.filled * 6);
  }

  dispose(): void {
    this.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}

interface Particle {
  life: number;
  maxLife: number;
  size: number;
}

/**
 * Snow spray thrown off the edges, plus the powder plume off a deep landing.
 *
 * One additive points cloud with a fixed pool; emission rate comes straight from
 * the solver's slip speed and penetration depth, so the spray is a readout of
 * what the physics is actually doing rather than a canned effect.
 */
export class SprayParticles {
  readonly points: THREE.Points;
  private readonly capacity: number;
  private positions: Float32Array;
  private velocities: Float32Array;
  private sizes: Float32Array;
  private alphas: Float32Array;
  private pool: Particle[] = [];
  private next = 0;

  constructor(capacity = 1400) {
    this.capacity = capacity;
    this.positions = new Float32Array(capacity * 3);
    this.velocities = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    for (let i = 0; i < capacity; i++) {
      this.pool.push({ life: 0, maxLife: 1, size: 1 });
      this.positions[i * 3 + 1] = -9999;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1).setUsage(THREE.DynamicDrawUsage));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
      uniforms: { uScale: { value: 600 } },
      vertexShader: `
        attribute float aSize;
        attribute float aAlpha;
        uniform float uScale;
        varying float vAlpha;
        void main() {
          vAlpha = aAlpha;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = aSize * uScale / max(1.0, -mv.z);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vAlpha;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float r = dot(d, d);
          if (r > 0.25 || vAlpha <= 0.002) discard;
          float soft = smoothstep(0.25, 0.02, r);
          gl_FragColor = vec4(vec3(0.97, 0.985, 1.0), vAlpha * soft);
        }`,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
  }

  /** Emits `count` particles from a point with an initial velocity spread. */
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, count: number, size = 0.14, life = 0.85): void {
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % this.capacity;
      const p = this.pool[i];
      p.life = life * (0.6 + Math.random() * 0.7);
      p.maxLife = p.life;
      p.size = size * (0.55 + Math.random() * 0.9);
      const o = i * 3;
      this.positions[o] = x + (Math.random() - 0.5) * 0.12;
      this.positions[o + 1] = y + Math.random() * 0.08;
      this.positions[o + 2] = z + (Math.random() - 0.5) * 0.12;
      this.velocities[o] = vx + (Math.random() - 0.5) * 1.6;
      this.velocities[o + 1] = vy + Math.random() * 1.4;
      this.velocities[o + 2] = vz + (Math.random() - 0.5) * 1.6;
    }
  }

  update(dt: number, wind: THREE.Vector3): void {
    for (let i = 0; i < this.capacity; i++) {
      const p = this.pool[i];
      if (p.life <= 0) {
        this.alphas[i] = 0;
        continue;
      }
      p.life -= dt;
      const o = i * 3;
      // Airborne snow is light: heavy drag, and the wind carries it.
      const drag = Math.exp(-2.4 * dt);
      this.velocities[o] = (this.velocities[o] - wind.x) * drag + wind.x;
      this.velocities[o + 1] = this.velocities[o + 1] * drag - 3.2 * dt;
      this.velocities[o + 2] = (this.velocities[o + 2] - wind.z) * drag + wind.z;
      this.positions[o] += this.velocities[o] * dt;
      this.positions[o + 1] += this.velocities[o + 1] * dt;
      this.positions[o + 2] += this.velocities[o + 2] * dt;

      const t = clamp01(p.life / p.maxLife);
      this.alphas[i] = t * t * 0.8;
      // Spray puffs out as it disperses.
      this.sizes[i] = p.size * (1 + (1 - t) * 1.8);
    }

    const geo = this.points.geometry;
    (geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    (geo.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
  }

  clear(): void {
    for (const p of this.pool) p.life = 0;
    this.alphas.fill(0);
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

const _left = new THREE.Vector3();
const _right = new THREE.Vector3();
const _dir = new THREE.Vector3();
