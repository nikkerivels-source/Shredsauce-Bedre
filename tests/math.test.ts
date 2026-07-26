import { describe, expect, it } from 'vitest';
import { Quat, Vec3, angleDelta, damp, fbm2D, makeRng, valueNoise2D } from '../src/core/math.ts';

describe('Vec3', () => {
  it('handles aliasing in crossVectors', () => {
    const a = new Vec3(1, 0, 0);
    const b = new Vec3(0, 1, 0);
    a.crossVectors(a, b);
    expect(a.toArray()).toEqual([0, 0, 1]);
  });

  it('removes a component along a unit vector', () => {
    const v = new Vec3(3, 4, 5);
    const n = new Vec3(0, 1, 0);
    v.removeComponentAlong(n);
    expect(v.y).toBeCloseTo(0, 10);
    expect(v.x).toBe(3);
  });
});

describe('Quat', () => {
  it('rotates a vector and its inverse back again', () => {
    const q = new Quat().setFromAxisAngle(new Vec3(0, 1, 0), Math.PI / 3);
    const v = new Vec3(1, 2, 3);
    const original = v.clone();
    v.applyQuat(q).applyQuatInverse(q);
    expect(v.x).toBeCloseTo(original.x, 10);
    expect(v.y).toBeCloseTo(original.y, 10);
    expect(v.z).toBeCloseTo(original.z, 10);
  });

  it('builds a right-handed basis from forward and up', () => {
    const q = new Quat().setFromForwardUp(new Vec3(0, 0, 1), new Vec3(0, 1, 0));
    const right = new Vec3(1, 0, 0).applyQuat(q);
    const up = new Vec3(0, 1, 0).applyQuat(q);
    const forward = new Vec3(0, 0, 1).applyQuat(q);
    expect(right.x).toBeCloseTo(1, 6);
    expect(up.y).toBeCloseTo(1, 6);
    expect(forward.z).toBeCloseTo(1, 6);
    // right x up must equal forward for the convention the sim relies on.
    const cross = new Vec3().crossVectors(right, up);
    expect(cross.dot(forward)).toBeCloseTo(1, 6);
  });

  it('orthogonalises a forward that is not perpendicular to up', () => {
    const q = new Quat().setFromForwardUp(new Vec3(0, -0.3, 1).normalize(), new Vec3(0, 1, 0));
    const up = new Vec3(0, 1, 0).applyQuat(q);
    const forward = new Vec3(0, 0, 1).applyQuat(q);
    expect(up.dot(forward)).toBeCloseTo(0, 6);
    expect(up.length()).toBeCloseTo(1, 6);
  });

  it('conserves the rotation magnitude when integrating angular velocity', () => {
    const q = new Quat();
    const omega = new Vec3(0, 12, 0);
    // A full revolution at 12 rad/s takes 2*pi/12 seconds.
    const total = (Math.PI * 2) / 12;
    const steps = 2400;
    for (let i = 0; i < steps; i++) q.integrate(omega, total / steps);
    // Back to identity, up to quaternion double cover.
    expect(Math.abs(q.w)).toBeCloseTo(1, 4);
  });
});

describe('helpers', () => {
  it('wraps angleDelta into (-pi, pi]', () => {
    expect(angleDelta(0, Math.PI * 2 - 0.1)).toBeCloseTo(-0.1, 10);
    expect(angleDelta(-3, 3)).toBeCloseTo(-(Math.PI * 2 - 6), 10);
  });

  it('damp is framerate independent', () => {
    const oneBigStep = damp(0, 1, 5, 0.5);
    let many = 0;
    for (let i = 0; i < 50; i++) many = damp(many, 1, 5, 0.01);
    expect(many).toBeCloseTo(oneBigStep, 10);
  });

  it('makeRng is deterministic and in range', () => {
    const a = makeRng(1234);
    const b = makeRng(1234);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('noise is continuous and bounded', () => {
    for (let i = 0; i < 200; i++) {
      const x = i * 0.05;
      expect(Math.abs(valueNoise2D(x, 0.3, 7))).toBeLessThanOrEqual(1);
      const a = fbm2D(x, 0.3, 7);
      const b = fbm2D(x + 0.001, 0.3, 7);
      expect(Math.abs(a - b)).toBeLessThan(0.02);
    }
  });
});
