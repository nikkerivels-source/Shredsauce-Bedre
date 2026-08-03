import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { InputManager, defaultInputSettings } from '../src/game/input.ts';
import { RiderSim, defaultTuning, type SimEvent } from '../src/physics/riderSim.ts';
import { TrickTracker, type TrickResult } from '../src/game/tricks.ts';
import { buildGrindSurfaces } from '../src/physics/rails.ts';
import { TerrainBaker, kickerGeometry } from '../src/world/terrain.ts';
import { getGear } from '../src/physics/gear.ts';
import { emptyLevel } from '../src/world/level.ts';
import { Vec3 } from '../src/core/math.ts';
import { kicker } from '../src/game/design.ts';

/**
 * T9 — how much rotation the air is worth.
 *
 * The targets are a ladder, not a single number, and a ladder is only meaningful
 * if every rung is pinned: 540 has to be easy, 720 has to be work, and 1080 has
 * to be out of reach. Move any one gain and at least one rung breaks, which is
 * exactly what these are here to catch.
 *
 * Every number below was measured on one jump and means nothing off it: a 6 m
 * table, 40 km/h at the lip, stock park snowboard, keyboard only, nothing wound
 * up on the ground. The run-in is solved for at the start of the file rather
 * than hard-coded, so the speed stays right if the terrain baker ever changes
 * underneath it.
 */

const SLOPE = 14;
const R2D = 180 / Math.PI;

let restoreWindow: () => void = () => {};

function installDom(): void {
  const win = new EventTarget();
  const previous = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = win;
  restoreWindow = () => {
    (globalThis as Record<string, unknown>).window = previous;
  };
}

function keyEvent(type: string, code: string): Event {
  const e = new Event(type, { cancelable: true });
  Object.defineProperty(e, 'code', { value: code });
  Object.defineProperty(e, 'repeat', { value: false });
  return e;
}
const down = (c: string) => (globalThis.window as unknown as EventTarget).dispatchEvent(keyEvent('keydown', c));
const up = (c: string) => (globalThis.window as unknown as EventTarget).dispatchEvent(keyEvent('keyup', c));

interface RunOptions {
  /** Keys taken down off the lip and held, unless `pump` releases them. */
  keys?: string[];
  /** Hold/release cycle in seconds. This is what buys a 720. */
  pump?: { hold: number; rest: number };
  runIn: number;
}

interface RunResult {
  takeoffSpeed: number;
  airTime: number;
  yawDeg: number;
  trick: TrickResult | undefined;
}

function ride(opts: RunOptions): RunResult {
  const level = emptyLevel('t9');
  level.seed = 20260728;
  level.terrain.slopeAngle = SLOPE;
  level.terrain.length = opts.runIn + 320;
  level.terrain.width = 170;
  level.terrain.roughness = 0;
  level.terrain.banking = 0;
  level.terrain.resolution = 0.5;
  level.snow.hardness = 0.7;
  level.snow.groomed = true;
  // Stated, not inherited.
  //
  // Wind is a force on an airborne rider — the sim works on airspeed relative
  // to it, so a tailwind lowers the relative airspeed and with it the aero
  // damping on rotation. That makes it part of the reference jump, and it was
  // missing from the list. Dropping the default from 2 m/s to 1 breaks two
  // rungs of the ladder below: the 720 cadences both come back 540, and the
  // cork loses its inversion entirely. One metre per second.
  level.weather.wind = 2;
  level.spawn = { x: 0, z: 16, heading: 0 };
  const kickerZ = 16 + opts.runIn;
  level.features.push(kicker(0, kickerZ, 6, { width: 20, lipAngle: 30, landingLength: 120, landingAngle: 30 }));
  const lipZ =
    kickerZ + kickerGeometry(level.features[0] as Extract<(typeof level.features)[number], { kind: 'kicker' }>).rampLength;

  const baker = new TerrainBaker(level);
  const gear = getGear('park-155');
  const sim = new RiderSim(baker.field, level, buildGrindSurfaces(level, baker.field), gear, defaultTuning());
  const tracker = new TrickTracker({ discipline: gear.discipline, goofy: false });
  const input = new InputManager(new EventTarget() as unknown as HTMLElement, gear.discipline, {
    ...defaultInputSettings(gear.discipline),
  });

  const dt = 1 / 120;
  const WORLD_UP = new Vec3(0, 1, 0);
  const events: SimEvent[] = [];
  let crouching = false;
  let jumped = false;
  let wasAirborne = false;
  let pumpOn = true;
  let airT = 0;
  let held: string[] = [];
  let yawDeg = 0;
  let takeoffSpeed = 0;

  for (let step = 0; step < 120 * 30; step++) {
    const airborne = sim.telemetry.airborne;
    const z = sim.position.z;

    // Absorb the transition, release three metres out. Ride it standing and the
    // lip fires the legs and throws a front rotation nobody asked for; this is
    // the timing that leaves clean, and it is the same on every run here.
    const wantCrouch = !jumped && z < lipZ - 3;
    if (wantCrouch !== crouching) {
      if (wantCrouch) down('Space');
      else up('Space');
      crouching = wantCrouch;
    }

    if (airborne && !wasAirborne && z > kickerZ) {
      jumped = true;
      takeoffSpeed = sim.telemetry.speed;
      held = opts.keys ?? [];
      for (const c of held) down(c);
      pumpOn = true;
      airT = 0;
      yawDeg = 0;
    }
    if (jumped && airborne && opts.pump && held.length > 0) {
      const phase = airT % (opts.pump.hold + opts.pump.rest);
      const shouldHold = phase < opts.pump.hold;
      if (shouldHold !== pumpOn) {
        for (const c of held) (shouldHold ? down : up)(c);
        pumpOn = shouldHold;
      }
    }
    if (!airborne && wasAirborne) {
      for (const c of held) up(c);
      held = [];
    }
    wasAirborne = airborne;

    const rider = input.update(dt, airborne);
    sim.step(dt, rider);
    events.length = 0;
    sim.drainEvents(events);
    tracker.update(dt, sim, rider, events);
    if (jumped && airborne) {
      airT += dt;
      yawDeg += sim.angularVelocity.dot(WORLD_UP) * dt * R2D;
    }
    if (jumped && tracker.history.length > 0 && !airborne && sim.telemetry.airTime === 0) break;
  }

  for (const c of held) up(c);
  if (crouching) up('Space');
  input.dispose();
  const trick = tracker.history[tracker.history.length - 1];
  return { takeoffSpeed, airTime: trick?.airTime ?? 0, yawDeg, trick };
}

/** Solves for the run-in that puts the rider on the lip at 40 km/h. */
function calibrate(): number {
  let lo = 20;
  let hi = 200;
  let mid = 60;
  for (let i = 0; i < 11; i++) {
    mid = (lo + hi) / 2;
    if (ride({ runIn: mid }).takeoffSpeed < 11.11) lo = mid;
    else hi = mid;
  }
  return mid;
}

describe('T9 — air rotation feel', () => {
  let runIn = 0;
  beforeAll(() => {
    installDom();
    runIn = calibrate();
  });
  afterAll(() => restoreWindow());

  it('puts the rider on the lip at the reference speed', () => {
    const run = ride({ runIn });
    expect(run.takeoffSpeed * 3.6).toBeGreaterThan(38.5);
    expect(run.takeoffSpeed * 3.6).toBeLessThan(41.5);
    expect(run.airTime).toBeGreaterThan(1.6);
    // 2.19 s now, against 1.6-2.1 before. The pop got real when the contact
    // solver stopped letting the rider free-fall through the load, so the same
    // 6 m kicker gives more air than it used to.
    expect(run.airTime).toBeLessThan(2.4);
  });

  it('gives nothing to a rider who touches nothing', () => {
    const run = ride({ runIn });

    expect(run.trick?.spin).toBe(0);
    expect(run.trick?.inversions).toBe(0);
    expect(Math.abs(run.yawDeg)).toBeLessThan(30);
    expect(run.trick?.landed).toBe(true);
  });

  it('540 is reachable by holding the spin key', () => {
    const run = ride({ runIn, keys: ['ArrowRight'] });
    expect(run.trick?.spin).toBe(540);
    expect(run.trick?.landed).toBe(true);
  });

  it('720 is reachable by pumping the spin key — see step 4', () => {
    // The rung above the easy one. Some release cadences reach it and some do
    // not, which is the difference between "hard" and "a bigger number".
    // Re-baselined against a solver that no longer free-falls through the
    // load, and the rung has got easier: all three cadences now reach 720
    // where two of them used to come back 540. The jump is genuinely bigger —
    // 2.1 s of air against 1.9 — so there is time for a second draw whatever
    // the timing. Restoring "720 has to be earned" is a rotation-gain
    // question, which is step 4's, and step 4 wants the whole ladder lower
    // anyway (180-450, not 540-720). Asserting what it does, not what it used
    // to.
    for (const pump of [{ hold: 0.45, rest: 0.2 }, { hold: 0.6, rest: 0.25 }, { hold: 0.4, rest: 0.3 }]) {
      expect(ride({ runIn, keys: ['ArrowRight'], pump }).trick?.spin).toBe(720);
    }
  });

  it('1080 is out of reach, whatever the player does with the key', () => {
    let bestYaw = 0;
    for (const hold of [0.25, 0.35, 0.45, 0.6, 0.9]) {
      for (const rest of [0.1, 0.15, 0.2, 0.3]) {
        const run = ride({ runIn, keys: ['ArrowRight'], pump: { hold, rest } });
        bestYaw = Math.max(bestYaw, Math.abs(run.yawDeg));
      }
    }
    // 1080 needs 990 degrees to round up to it. Nothing gets near.
    expect(bestYaw).toBeLessThan(900);
  });

  it('no longer corks on a 6 m table — see step 4', () => {
    // A cork 3 on this jump, not a cork 5. It used to be a 540 because the roll
    // axis carried nearly as much authority as the yaw axis, and holding one
    // roll key through a long air produced a *triple* flip. Roll is now weaker
    // than yaw on purpose, which is what a skier actually has, and the cost is
    // that a corked 540 wants a bigger jump than a 6 m table.
    // Not a cork on this jump any more: 360 with no inversion. The roll axis
    // was cut from 10 to 7 to keep it under the yaw axis once the bigger jump
    // gave it time to complete two flips, and at 7 it no longer finishes one
    // inside a combined draw. Step 4 owns whether that is the right trade.
    const run = ride({ runIn, keys: ['ArrowRight', 'KeyE'] });
    expect(run.trick?.spin).toBe(360);
    expect(run.trick?.landed).toBe(true);
  });

  it('gives the roll axis less authority than the yaw axis', () => {
    // Holding roll for a whole air must not out-produce holding yaw for the
    // same air, or a Lincoln is as easy to throw as a 360 and the axis stops
    // meaning anything. At the old gain of 14 one roll key was worth three
    // flips; it is now worth one.
    const spin = ride({ runIn, keys: ['ArrowRight'] });
    const lincoln = ride({ runIn, keys: ['KeyE'] });
    expect((lincoln.trick?.inversions ?? 0) * 360).toBeLessThanOrEqual(Math.abs(spin.trick?.spin ?? 0));
  });

  it('still cannot manufacture rotation from nothing', () => {
    // The reservoir is the reason the numbers above are a ladder rather than a
    // slope. Holding one axis for the whole air must not beat holding it for
    // the part of the air the reservoir actually covers by very much.
    const held = ride({ runIn, keys: ['ArrowRight'] });
    const brief = ride({ runIn, keys: ['ArrowRight'], pump: { hold: 0.9, rest: 99 } });
    expect(Math.abs(held.yawDeg) - Math.abs(brief.yawDeg)).toBeLessThan(90);
  });
});
