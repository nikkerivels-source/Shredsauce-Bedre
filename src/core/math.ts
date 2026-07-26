/**
 * Minimal, allocation-conscious math used by the simulation.
 *
 * The physics layer deliberately does not depend on three.js: the solver runs in
 * plain Node for the unit tests, and mutating in-place keeps the fixed-step loop
 * free of per-substep garbage.
 */

export const EPSILON = 1e-9;
export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential smoothing. `rate` is the 1/e speed per second. */
export function damp(a: number, b: number, rate: number, dt: number): number {
  return b + (a - b) * Math.exp(-rate * dt);
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || EPSILON));
  return t * t * (3 - 2 * t);
}

export function sign(v: number): number {
  return v < 0 ? -1 : v > 0 ? 1 : 0;
}

/** Signed shortest angular difference, result in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

export function moveTowards(current: number, target: number, maxDelta: number): number {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + Math.sign(d) * maxDelta;
}

// ---------------------------------------------------------------------------
// Vec3
// ---------------------------------------------------------------------------

export class Vec3 {
  x: number;
  y: number;
  z: number;

  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  static up(): Vec3 {
    return new Vec3(0, 1, 0);
  }

  set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  copy(v: Vec3): this {
    this.x = v.x;
    this.y = v.y;
    this.z = v.z;
    return this;
  }

  clone(): Vec3 {
    return new Vec3(this.x, this.y, this.z);
  }

  setZero(): this {
    this.x = 0;
    this.y = 0;
    this.z = 0;
    return this;
  }

  add(v: Vec3): this {
    this.x += v.x;
    this.y += v.y;
    this.z += v.z;
    return this;
  }

  addScaled(v: Vec3, s: number): this {
    this.x += v.x * s;
    this.y += v.y * s;
    this.z += v.z * s;
    return this;
  }

  sub(v: Vec3): this {
    this.x -= v.x;
    this.y -= v.y;
    this.z -= v.z;
    return this;
  }

  scale(s: number): this {
    this.x *= s;
    this.y *= s;
    this.z *= s;
    return this;
  }

  negate(): this {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  dot(v: Vec3): number {
    return this.x * v.x + this.y * v.y + this.z * v.z;
  }

  lengthSq(): number {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }

  length(): number {
    return Math.sqrt(this.lengthSq());
  }

  distanceTo(v: Vec3): number {
    const dx = this.x - v.x;
    const dy = this.y - v.y;
    const dz = this.z - v.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  normalize(): this {
    const len = this.length();
    if (len > EPSILON) this.scale(1 / len);
    return this;
  }

  /** Cross product written into `this`. Safe when `this` aliases a or b. */
  crossVectors(a: Vec3, b: Vec3): this {
    const ax = a.x;
    const ay = a.y;
    const az = a.z;
    const bx = b.x;
    const by = b.y;
    const bz = b.z;
    this.x = ay * bz - az * by;
    this.y = az * bx - ax * bz;
    this.z = ax * by - ay * bx;
    return this;
  }

  subVectors(a: Vec3, b: Vec3): this {
    this.x = a.x - b.x;
    this.y = a.y - b.y;
    this.z = a.z - b.z;
    return this;
  }

  addVectors(a: Vec3, b: Vec3): this {
    this.x = a.x + b.x;
    this.y = a.y + b.y;
    this.z = a.z + b.z;
    return this;
  }

  lerpVectors(a: Vec3, b: Vec3, t: number): this {
    this.x = a.x + (b.x - a.x) * t;
    this.y = a.y + (b.y - a.y) * t;
    this.z = a.z + (b.z - a.z) * t;
    return this;
  }

  /** Removes the component of `this` that lies along the unit vector `n`. */
  removeComponentAlong(n: Vec3): this {
    const d = this.dot(n);
    this.x -= n.x * d;
    this.y -= n.y * d;
    this.z -= n.z * d;
    return this;
  }

  applyQuat(q: Quat): this {
    // t = 2 * (q.vec x v); v' = v + q.w * t + q.vec x t
    const { x, y, z } = this;
    const qx = q.x;
    const qy = q.y;
    const qz = q.z;
    const qw = q.w;
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    this.x = x + qw * tx + qy * tz - qz * ty;
    this.y = y + qw * ty + qz * tx - qx * tz;
    this.z = z + qw * tz + qx * ty - qy * tx;
    return this;
  }

  /** Rotates by the conjugate of `q`, i.e. world -> local for a body oriented by q. */
  applyQuatInverse(q: Quat): this {
    const { x, y, z } = this;
    const qx = -q.x;
    const qy = -q.y;
    const qz = -q.z;
    const qw = q.w;
    const tx = 2 * (qy * z - qz * y);
    const ty = 2 * (qz * x - qx * z);
    const tz = 2 * (qx * y - qy * x);
    this.x = x + qw * tx + qy * tz - qz * ty;
    this.y = y + qw * ty + qz * tx - qx * tz;
    this.z = z + qw * tz + qx * ty - qy * tx;
    return this;
  }

  isFinite(): boolean {
    return Number.isFinite(this.x) && Number.isFinite(this.y) && Number.isFinite(this.z);
  }

  toArray(): [number, number, number] {
    return [this.x, this.y, this.z];
  }

  static fromArray(a: readonly number[]): Vec3 {
    return new Vec3(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0);
  }
}

// ---------------------------------------------------------------------------
// Quat
// ---------------------------------------------------------------------------

export class Quat {
  x: number;
  y: number;
  z: number;
  w: number;

  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }

  set(x: number, y: number, z: number, w: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    return this;
  }

  copy(q: Quat): this {
    this.x = q.x;
    this.y = q.y;
    this.z = q.z;
    this.w = q.w;
    return this;
  }

  clone(): Quat {
    return new Quat(this.x, this.y, this.z, this.w);
  }

  identity(): this {
    return this.set(0, 0, 0, 1);
  }

  setFromAxisAngle(axis: Vec3, angle: number): this {
    const half = angle * 0.5;
    const s = Math.sin(half);
    this.x = axis.x * s;
    this.y = axis.y * s;
    this.z = axis.z * s;
    this.w = Math.cos(half);
    return this;
  }

  multiplyQuaternions(a: Quat, b: Quat): this {
    const ax = a.x;
    const ay = a.y;
    const az = a.z;
    const aw = a.w;
    const bx = b.x;
    const by = b.y;
    const bz = b.z;
    const bw = b.w;
    this.x = aw * bx + ax * bw + ay * bz - az * by;
    this.y = aw * by - ax * bz + ay * bw + az * bx;
    this.z = aw * bz + ax * by - ay * bx + az * bw;
    this.w = aw * bw - ax * bx - ay * by - az * bz;
    return this;
  }

  premultiply(q: Quat): this {
    return this.multiplyQuaternions(q, this);
  }

  multiply(q: Quat): this {
    return this.multiplyQuaternions(this, q);
  }

  conjugate(): this {
    this.x = -this.x;
    this.y = -this.y;
    this.z = -this.z;
    return this;
  }

  normalize(): this {
    const len = Math.sqrt(this.x * this.x + this.y * this.y + this.z * this.z + this.w * this.w);
    if (len > EPSILON) {
      const inv = 1 / len;
      this.x *= inv;
      this.y *= inv;
      this.z *= inv;
      this.w *= inv;
    } else {
      this.identity();
    }
    return this;
  }

  dot(q: Quat): number {
    return this.x * q.x + this.y * q.y + this.z * q.z + this.w * q.w;
  }

  /**
   * Integrates the orientation by an angular velocity (world frame, rad/s) for
   * `dt` seconds using the exact exponential map, which stays stable at the very
   * high spin rates a corked 1440 reaches.
   */
  integrate(omega: Vec3, dt: number): this {
    const angle = omega.length() * dt;
    if (angle < 1e-8) return this;
    const inv = 1 / omega.length();
    const half = angle * 0.5;
    const s = Math.sin(half);
    const dq = _qi.set(omega.x * inv * s, omega.y * inv * s, omega.z * inv * s, Math.cos(half));
    return this.premultiply(dq).normalize();
  }

  /** Rotation taking `from` onto `to` (both assumed unit length). */
  setFromUnitVectors(from: Vec3, to: Vec3): this {
    let r = from.dot(to) + 1;
    if (r < 1e-6) {
      // Anti-parallel: pick any orthogonal axis.
      r = 0;
      if (Math.abs(from.x) > Math.abs(from.z)) {
        this.set(-from.y, from.x, 0, r);
      } else {
        this.set(0, -from.z, from.y, r);
      }
    } else {
      this.set(
        from.y * to.z - from.z * to.y,
        from.z * to.x - from.x * to.z,
        from.x * to.y - from.y * to.x,
        r,
      );
    }
    return this.normalize();
  }

  /**
   * Builds an orientation from a forward and up reference using a right-handed
   * basis where local +Z is forward, +Y is up and +X is right.
   */
  setFromForwardUp(forward: Vec3, up: Vec3): this {
    const f = _v1.copy(forward).normalize();
    const u = _v2.copy(up);
    u.removeComponentAlong(f);
    if (u.lengthSq() < 1e-8) {
      u.set(0, 1, 0).removeComponentAlong(f);
      if (u.lengthSq() < 1e-8) u.set(1, 0, 0).removeComponentAlong(f);
    }
    u.normalize();
    const r = _v3.crossVectors(u, f).normalize();

    // Column-major rotation matrix [r, u, f] -> quaternion.
    const m00 = r.x;
    const m10 = r.y;
    const m20 = r.z;
    const m01 = u.x;
    const m11 = u.y;
    const m21 = u.z;
    const m02 = f.x;
    const m12 = f.y;
    const m22 = f.z;

    const trace = m00 + m11 + m22;
    if (trace > 0) {
      const s = 0.5 / Math.sqrt(trace + 1);
      this.w = 0.25 / s;
      this.x = (m21 - m12) * s;
      this.y = (m02 - m20) * s;
      this.z = (m10 - m01) * s;
    } else if (m00 > m11 && m00 > m22) {
      const s = 2 * Math.sqrt(1 + m00 - m11 - m22);
      this.w = (m21 - m12) / s;
      this.x = 0.25 * s;
      this.y = (m01 + m10) / s;
      this.z = (m02 + m20) / s;
    } else if (m11 > m22) {
      const s = 2 * Math.sqrt(1 + m11 - m00 - m22);
      this.w = (m02 - m20) / s;
      this.x = (m01 + m10) / s;
      this.y = 0.25 * s;
      this.z = (m12 + m21) / s;
    } else {
      const s = 2 * Math.sqrt(1 + m22 - m00 - m11);
      this.w = (m10 - m01) / s;
      this.x = (m02 + m20) / s;
      this.y = (m12 + m21) / s;
      this.z = 0.25 * s;
    }
    return this.normalize();
  }

  slerp(target: Quat, t: number): this {
    let cos = this.dot(target);
    let tx = target.x;
    let ty = target.y;
    let tz = target.z;
    let tw = target.w;
    if (cos < 0) {
      cos = -cos;
      tx = -tx;
      ty = -ty;
      tz = -tz;
      tw = -tw;
    }
    if (cos > 0.9995) {
      this.x += (tx - this.x) * t;
      this.y += (ty - this.y) * t;
      this.z += (tz - this.z) * t;
      this.w += (tw - this.w) * t;
      return this.normalize();
    }
    const theta = Math.acos(cos);
    const sinTheta = Math.sin(theta);
    const a = Math.sin((1 - t) * theta) / sinTheta;
    const b = Math.sin(t * theta) / sinTheta;
    this.x = this.x * a + tx * b;
    this.y = this.y * a + ty * b;
    this.z = this.z * a + tz * b;
    this.w = this.w * a + tw * b;
    return this.normalize();
  }

  toArray(): [number, number, number, number] {
    return [this.x, this.y, this.z, this.w];
  }

  static fromArray(a: readonly number[]): Quat {
    return new Quat(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0, a[3] ?? 1);
  }
}

/** Angle in radians between two unit vectors, numerically safe at the poles. */
export function angleBetween(a: Vec3, b: Vec3): number {
  return Math.acos(clamp(a.dot(b), -1, 1));
}

/**
 * Deterministic 32-bit PRNG (mulberry32). Levels and weather seed from this so a
 * shared seed reproduces the exact same mountain on every device.
 */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function rng(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2D value noise with smooth interpolation, driven by a seeded hash. */
export function valueNoise2D(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed);
  const b = hash2(xi + 1, yi, seed);
  const c = hash2(xi, yi + 1, seed);
  const d = hash2(xi + 1, yi + 1, seed);
  return lerp(lerp(a, b, u), lerp(c, d, u), v) * 2 - 1;
}

export function fbm2D(x: number, y: number, seed: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let fx = x;
  let fy = y;
  for (let i = 0; i < octaves; i++) {
    sum += valueNoise2D(fx, fy, seed + i * 1013) * amp;
    norm += amp;
    amp *= gain;
    fx *= lacunarity;
    fy *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Shared scratch values. Never hold a reference to these across a call boundary.
const _qi = new Quat();
const _v1 = new Vec3();
const _v2 = new Vec3();
const _v3 = new Vec3();
