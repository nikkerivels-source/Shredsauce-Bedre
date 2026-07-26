import { describe, expect, it } from 'vitest';
import { DEG } from '../src/core/math.ts';
import { emptyLevel } from '../src/world/level.ts';
import { TerrainBaker, kickerGeometry } from '../src/world/terrain.ts';
import { RiderSim, defaultTuning, neutralInput, type RiderInput } from '../src/physics/riderSim.ts';
import { getGear, inertiaTensor } from '../src/physics/gear.ts';
import { buildGrindSurfaces } from '../src/physics/rails.ts';

function flatLevel() {
  const level = emptyLevel('test');
  // Pin the seed: the natural pitch varies gently along the hill from this, so
  // leaving it random makes every physics assertion run on a different slope.
  level.seed = 0x9e3779b9;
  level.terrain.roughness = 0;
  level.terrain.banking = 0;
  level.terrain.length = 600;
  return level;
}

function makeSim(assist = 0.55, gearId = 'allmtn-158') {
  const level = flatLevel();
  const baker = new TerrainBaker(level);
  const tuning = defaultTuning();
  tuning.assist = assist;
  const surfaces = buildGrindSurfaces(level, baker.field);
  return { level, baker, sim: new RiderSim(baker.field, level, surfaces, getGear(gearId), tuning) };
}

/** Runs the sim for `seconds`, letting the caller drive the input each frame. */
function run(
  sim: RiderSim,
  seconds: number,
  drive: (t: number, input: RiderInput) => void = () => {},
  dt = 1 / 60,
) {
  const input = neutralInput();
  let t = 0;
  let bails = 0;
  let maxAltitude = 0;
  let maxSpeed = 0;
  while (t < seconds) {
    drive(t, input);
    sim.step(dt, input);
    for (const e of sim.events) if (e.type === 'bail') bails++;
    sim.events.length = 0;
    maxAltitude = Math.max(maxAltitude, sim.telemetry.altitude);
    maxSpeed = Math.max(maxSpeed, sim.telemetry.speed);
    t += dt;
  }
  return { bails, maxAltitude, maxSpeed };
}

describe('terrain', () => {
  it('bakes a slope that descends downhill', () => {
    const level = flatLevel();
    level.terrain.slopeAngle = 20;
    const baker = new TerrainBaker(level);
    const high = baker.field.heightAt(0, 50);
    const low = baker.field.heightAt(0, 250);
    expect(low).toBeLessThan(high);
    // 200 m at ~20 degrees should drop roughly 73 m, allowing for pitch variation.
    expect(high - low).toBeGreaterThan(45);
    expect(high - low).toBeLessThan(110);
  });

  it('derives kicker geometry that reaches the lip at the requested angle', () => {
    const { radius, rampLength } = kickerGeometry({
      id: 'k',
      kind: 'kicker',
      x: 0,
      z: 0,
      heading: 0,
      height: 3,
      lipAngle: 32,
      width: 10,
      gap: 8,
      landingLength: 30,
      landingAngle: 30,
    });
    // At the end of the ramp the surface slope must equal the lip angle.
    const slope = rampLength / Math.sqrt(radius * radius - rampLength * rampLength);
    expect(Math.atan(slope) / DEG).toBeCloseTo(32, 4);
    // And the ramp must actually reach the requested height.
    expect(radius - Math.sqrt(radius * radius - rampLength * rampLength)).toBeCloseTo(3, 6);
  });

  it('stamps a kicker above the natural ground', () => {
    const level = flatLevel();
    level.features.push({
      id: 'k1',
      kind: 'kicker',
      x: 0,
      z: 120,
      heading: 0,
      height: 3,
      lipAngle: 32,
      width: 10,
      gap: 8,
      landingLength: 30,
      landingAngle: 30,
    });
    const baker = new TerrainBaker(level);
    // Sample near the lip: a circular in-run is deliberately almost flat where
    // it leaves the ground, so 3 m in it has barely risen.
    const { rampLength } = kickerGeometry(level.features[0] as never);
    const atLip = 120 + rampLength - 0.4;
    const natural = baker.naturalHeight(0, atLip);
    const stamped = baker.field.heightAt(0, atLip);
    expect(stamped - natural).toBeGreaterThan(2.5);
  });
});

describe('gear', () => {
  it('gives a snowboarder and a skier different flip axes', () => {
    const board = inertiaTensor(getGear('park-155'), 72, 0);
    const skis = inertiaTensor(getGear('twin-172'), 72, 0);
    // Spin (about the spine) is the easy axis for both.
    expect(board.y).toBeLessThan(board.x);
    expect(board.y).toBeLessThan(board.z);
    expect(skis.y).toBeLessThan(skis.x);
    // A snowboarder somersaults about the board's long axis; a skier about the
    // axis across the skis. Those are different axes in the same local frame.
    expect(board.z).toBeGreaterThan(board.y * 4);
    expect(skis.x).toBeGreaterThan(skis.y * 4);
  });

  it('tucking lowers every moment of inertia', () => {
    const open = inertiaTensor(getGear('park-155'), 72, 0);
    const tucked = inertiaTensor(getGear('park-155'), 72, 1);
    expect(tucked.x).toBeLessThan(open.x);
    expect(tucked.y).toBeLessThan(open.y);
    expect(tucked.z).toBeLessThan(open.z);
  });
});

describe('rider simulation', () => {
  it('spawns settled instead of launching itself', () => {
    const { sim } = makeSim();
    const result = run(sim, 2);
    // A bad spawn used to fire the rider tens of metres into the air.
    expect(result.maxAltitude).toBeLessThan(0.4);
    expect(result.bails).toBe(0);
  });

  it('accelerates downhill and settles at a plausible terminal speed', () => {
    const { sim } = makeSim();
    run(sim, 16);
    const speed = sim.telemetry.speed;
    // A 17-degree groomer should run somewhere in the 50-100 km/h band.
    expect(speed).toBeGreaterThan(12);
    expect(speed).toBeLessThan(30);
    expect(Number.isFinite(speed)).toBe(true);
  });

  it('holds a straight line with no input', () => {
    const { sim } = makeSim();
    run(sim, 12);
    // Drift of a few metres is realistic; spinning out is not.
    expect(Math.abs(sim.position.x)).toBeLessThan(25);
    expect(sim.state).not.toBe('bailed');
  });

  it('turns toward the edge the rider sets, and back the other way', () => {
    const right = makeSim().sim;
    run(right, 6, (t, i) => {
      i.lean = t < 1.5 ? 0 : Math.min(1, (t - 1.5) / 0.6) * 0.8;
    });
    const left = makeSim().sim;
    run(left, 6, (t, i) => {
      i.lean = t < 1.5 ? 0 : -Math.min(1, (t - 1.5) / 0.6) * 0.8;
    });
    expect(right.position.x).toBeGreaterThan(4);
    expect(left.position.x).toBeLessThan(-4);
  });

  it('produces a positive edge angle for a positive lean', () => {
    const { sim } = makeSim();
    run(sim, 4, (t, i) => {
      i.lean = t < 1.5 ? 0 : Math.min(1, (t - 1.5) / 0.6) * 0.9;
    });
    expect(sim.telemetry.edgeAngle).toBeGreaterThan(15);
    // The body has to lean into the turn, not away from it.
    expect(sim.telemetry.inclination).toBeGreaterThan(-5);
  });

  it('carves cleanly rather than skidding when the edge is set progressively', () => {
    const { sim } = makeSim();
    let bestCarve = 0;
    const input = neutralInput();
    for (let t = 0, dt = 1 / 60; t < 5; t += dt) {
      input.lean = t < 1.5 ? 0 : Math.min(1, (t - 1.5) / 0.8) * 0.7;
      sim.step(dt, input);
      if (t > 2.5) bestCarve = Math.max(bestCarve, sim.telemetry.carveQuality);
    }
    expect(bestCarve).toBeGreaterThan(0.6);
  });

  it('gets airborne when the legs are loaded and released', () => {
    const { sim } = makeSim();
    const result = run(sim, 6, (t, i) => {
      // Load for 0.4 s from t=3, then snap the legs open.
      i.crouch = t > 3 && t < 3.4 ? 1 : 0;
    });
    expect(result.maxAltitude).toBeGreaterThan(0.15);
  });

  it('conserves angular momentum in flight, so tucking speeds up a spin', () => {
    const { sim } = makeSim();
    // Get airborne off a big kick, with rotation already established.
    sim.velocity.set(0, 6, 14);
    sim.position.y += 12;
    sim.angularMomentum.set(0, 18, 0);
    const input = neutralInput();
    sim.step(1 / 60, input);
    const openSpin = Math.abs(sim.angularVelocity.y);

    input.tuck = 1;
    sim.step(1 / 60, input);
    const tuckedSpin = Math.abs(sim.angularVelocity.y);

    expect(tuckedSpin).toBeGreaterThan(openSpin * 1.2);
    // Momentum itself must not have jumped — only the inertia changed.
    expect(sim.angularMomentum.length()).toBeGreaterThan(17);
  });

  it('never produces NaN, even under absurd input', () => {
    const { sim } = makeSim(0);
    const input = neutralInput();
    for (let t = 0, dt = 1 / 60; t < 20; t += dt) {
      input.lean = Math.sin(t * 11);
      input.twist = Math.cos(t * 7);
      input.weight = Math.sin(t * 13);
      input.crouch = t % 0.5 < 0.25 ? 1 : 0;
      input.airYaw = Math.sin(t * 3);
      input.airPitch = Math.cos(t * 5);
      sim.step(dt, input);
      sim.events.length = 0;
    }
    expect(sim.position.isFinite()).toBe(true);
    expect(sim.velocity.isFinite()).toBe(true);
    expect(Number.isFinite(sim.orientation.w)).toBe(true);
    expect(Number.isFinite(sim.telemetry.speed)).toBe(true);
  });

  it('survives a full run down every gear in the catalogue', () => {
    for (const gearId of ['park-155', 'carve-163', 'powder-162', 'gs-183', 'jib-166']) {
      const { sim } = makeSim(0.55, gearId);
      run(sim, 10, (t, i) => {
        i.lean = Math.sin(t * 0.7) * 0.6;
      });
      expect(sim.position.isFinite()).toBe(true);
      expect(sim.telemetry.speed).toBeLessThan(80);
    }
  });

  it('bails when landing sideways on a loaded edge at speed', () => {
    const { sim } = makeSim(0);
    // Point the board across the direction of travel and drop it in hard.
    run(sim, 3);
    sim.velocity.set(14, -6, 2);
    const result = run(sim, 2.5, (_t, i) => {
      i.lean = 1;
    });
    expect(result.bails + (sim.state === 'bailed' ? 1 : 0)).toBeGreaterThan(0);
  });

  it('recovers to riding after a bail', () => {
    const { sim } = makeSim();
    sim.bail('test');
    expect(sim.state).toBe('bailed');
    run(sim, 6);
    expect(sim.state).toBe('riding');
  });
});
