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
 * Keyboard air control.
 *
 * The defect these cover: on keyboard the rotation keys did nothing once the
 * gear left the snow. `airYaw` and `airPitch` were written only by a gamepad
 * right stick or a touch drag, and `airRoll` only ever picked up a fraction of
 * the *ground* twist axis, so a keyboard player could wind a rotation up on the
 * snow and ride it out ballistically but could not start, steer, tighten or
 * correct one in the air. Pad and phone could.
 *
 * Two levels of test, because the fix has two claims to make. The unit tests
 * assert the routing itself — the same key means lean on the snow and yaw in
 * the air, and nothing about the grounded meaning moved. The flight tests then
 * ride a real kicker on the keyboard, through the real simulation and the real
 * trick namer, and measure how much rotation each key actually buys, because a
 * key that reaches the axis but moves nothing is not a fix.
 *
 * What the flight numbers are NOT is a spin the size of a competition trick.
 * The air torque gains and the `airBudget` reservoir that meters them are
 * deliberately untouched here, and between them they cap a standing-start
 * keyboard rotation at well under half a turn. Retuning that is its own job;
 * the measured ceilings are recorded against each case below so the day the
 * gains change, the numbers that have to move are already written down.
 */

const KICKER_Z = 90;
const R2D = 180 / Math.PI;

/** Minimal DOM stand-in: the input manager only needs an event target. */
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

const down = (code: string) => (globalThis.window as unknown as EventTarget).dispatchEvent(keyEvent('keydown', code));
const up = (code: string) => (globalThis.window as unknown as EventTarget).dispatchEvent(keyEvent('keyup', code));

/** A straight groomer with one 4 m table, so every run is the same run. */
function jumpLevel() {
  const level = emptyLevel('air-control');
  level.seed = 20260728;
  level.terrain.slopeAngle = 14;
  level.terrain.length = 460;
  level.terrain.width = 160;
  level.terrain.roughness = 0;
  level.terrain.banking = 0;
  level.terrain.resolution = 0.5;
  level.snow.hardness = 0.7;
  level.snow.groomed = true;
  level.spawn = { x: 0, z: 16, heading: 0 };
  level.features.push(kicker(0, KICKER_Z, 4, { width: 18, lipAngle: 28, landingLength: 90, landingAngle: 30 }));
  return level;
}

interface RunOptions {
  /** Keys taken down the frame the gear leaves the lip and held to touchdown. */
  air?: string[];
  /** Keys held on the snow for the last 14 m of the in-run and let go at the lip. */
  windUp?: string[];
}

interface RunResult {
  /** Degrees turned about the world vertical while airborne. */
  yaw: number;
  /** Degrees turned about the rider's own lateral axis — somersault. */
  pitch: number;
  /** Degrees turned about the rider's own fore-aft axis — the Lincoln axis. */
  roll: number;
  trick: TrickResult | undefined;
}

/**
 * Rides the kicker on keyboard alone and measures the air.
 *
 * The crouch key goes down at the gate and is not released until the gear is
 * off the lip, which is simply how the jump is ridden: absorb the transition,
 * do not stand up into it. It also means no pop, so nothing but the terrain and
 * the keys under test put rotation into the rider — there is no ground wind-up
 * on any run unless `windUp` asks for one.
 */
function ride(opts: RunOptions = {}): RunResult {
  const level = jumpLevel();
  const lipZ = KICKER_Z + kickerGeometry(level.features[0] as Extract<(typeof level.features)[number], { kind: 'kicker' }>).rampLength;
  const baker = new TerrainBaker(level);
  const gear = getGear('park-155');
  const sim = new RiderSim(baker.field, level, buildGrindSurfaces(level, baker.field), gear, defaultTuning());
  const tracker = new TrickTracker({ discipline: gear.discipline, goofy: false });
  const input = new InputManager(new EventTarget() as unknown as HTMLElement, gear.discipline, {
    ...defaultInputSettings(gear.discipline),
  });

  const dt = 1 / 120;
  const WORLD_UP = new Vec3(0, 1, 0);
  const bodyRight = new Vec3();
  const bodyUp = new Vec3();
  const bodyFwd = new Vec3();
  const events: SimEvent[] = [];
  const windUp = opts.windUp ?? [];

  let crouching = false;
  let winding = false;
  let jumped = false;
  let wasAirborne = false;
  let held: string[] = [];
  let yaw = 0;
  let pitch = 0;
  let roll = 0;

  for (let step = 0; step < 120 * 24; step++) {
    const airborne = sim.telemetry.airborne;
    const z = sim.position.z;

    const wantCrouch = !jumped;
    if (wantCrouch !== crouching) {
      if (wantCrouch) down('Space');
      else up('Space');
      crouching = wantCrouch;
    }

    const wantWind = windUp.length > 0 && !jumped && z > lipZ - 14;
    if (wantWind !== winding) {
      for (const code of windUp) (wantWind ? down : up)(code);
      winding = wantWind;
    }

    if (airborne && !wasAirborne && z > KICKER_Z) {
      // Off the lip: let go of the wind-up, take the air keys down.
      jumped = true;
      if (winding) {
        for (const code of windUp) up(code);
        winding = false;
      }
      held = opts.air ?? [];
      for (const code of held) down(code);
    }
    if (!airborne && wasAirborne) {
      for (const code of held) up(code);
      held = [];
    }
    wasAirborne = airborne;

    const rider = input.update(dt, airborne);
    sim.step(dt, rider);
    events.length = 0;
    sim.drainEvents(events);
    tracker.update(dt, sim, rider, events);

    if (jumped && airborne) {
      sim.getBodyAxes(bodyRight, bodyUp, bodyFwd);
      const omega = sim.angularVelocity;
      yaw += omega.dot(WORLD_UP) * dt * R2D;
      pitch += omega.dot(bodyRight) * dt * R2D;
      roll += omega.dot(bodyFwd) * dt * R2D;
    }
    if (jumped && tracker.history.length > 0 && !airborne && sim.telemetry.airTime === 0) break;
  }

  for (const code of held) up(code);
  if (crouching) up('Space');
  if (winding) for (const code of windUp) up(code);
  input.dispose();

  return { yaw, pitch, roll, trick: tracker.history[tracker.history.length - 1] };
}

describe('keyboard air axes — routing', () => {
  beforeAll(installDom);
  afterAll(() => restoreWindow());

  it('sends the same keys to lean, weight and twist on the snow and to yaw, pitch and roll in the air', () => {
    const input = new InputManager(new EventTarget() as unknown as HTMLElement, 'snowboard');
    down('ArrowRight');
    down('KeyE');
    let out = input.update(1 / 60, false);
    for (let i = 0; i < 40; i++) out = input.update(1 / 60, false);
    expect(out.lean).toBeGreaterThan(0.8);
    expect(out.twist).toBeGreaterThan(0.8);
    expect(Math.abs(out.airYaw)).toBeLessThan(0.05);

    for (let i = 0; i < 40; i++) out = input.update(1 / 60, true);
    expect(out.airYaw).toBeGreaterThan(0.8);
    expect(out.airRoll).toBeGreaterThan(0.8);
    expect(Math.abs(out.lean)).toBeLessThan(0.05);
    expect(Math.abs(out.twist)).toBeLessThan(0.05);

    up('ArrowRight');
    up('KeyE');
    input.dispose();
  });

  it('drives every air axis from both of its keys, in both directions', () => {
    const input = new InputManager(new EventTarget() as unknown as HTMLElement, 'snowboard');
    const settle = () => {
      let out = input.update(1 / 60, true);
      for (let i = 0; i < 60; i++) out = input.update(1 / 60, true);
      return out;
    };

    for (const [code, axis, sign] of [
      ['KeyD', 'airYaw', 1],
      ['KeyA', 'airYaw', -1],
      ['KeyS', 'airPitch', 1],
      ['KeyW', 'airPitch', -1],
      ['KeyE', 'airRoll', 1],
      ['KeyQ', 'airRoll', -1],
    ] as const) {
      down(code);
      const out = settle();
      expect(out[axis] * sign, `${code} -> ${axis}`).toBeGreaterThan(0.8);
      up(code);
      settle();
    }
    input.dispose();
  });

  it('honours invertAirPitch on the keyboard, not only on touch', () => {
    const settings = defaultInputSettings('snowboard');
    settings.invertAirPitch = true;
    const input = new InputManager(new EventTarget() as unknown as HTMLElement, 'snowboard', settings);
    down('ArrowDown');
    let out = input.update(1 / 60, true);
    for (let i = 0; i < 60; i++) out = input.update(1 / 60, true);
    expect(out.airPitch).toBeLessThan(-0.8);
    up('ArrowDown');
    input.dispose();
  });

  it('smooths each air axis with the constant of the ground axis it replaces', () => {
    // Same key, same number of frames: the air axis must ramp exactly like the
    // ground axis, so a rotation does not read like a switch being thrown.
    const ground = new InputManager(new EventTarget() as unknown as HTMLElement, 'snowboard');
    const airborne = new InputManager(new EventTarget() as unknown as HTMLElement, 'snowboard');
    down('ArrowRight');
    let g = ground.update(1 / 60, false);
    let a = airborne.update(1 / 60, true);
    for (let i = 0; i < 5; i++) {
      g = ground.update(1 / 60, false);
      a = airborne.update(1 / 60, true);
    }
    expect(a.airYaw).toBeCloseTo(g.lean, 6);
    up('ArrowRight');
    ground.dispose();
    airborne.dispose();
  });
});

describe('keyboard air axes — in flight', () => {
  beforeAll(installDom);
  afterAll(() => restoreWindow());

  // One neutral reference run. Every claim below is a difference from this,
  // because the lip itself puts rotation into the rider before any key is
  // touched, and only the difference belongs to the keyboard.
  let quiet: RunResult;
  beforeAll(() => {
    quiet = ride();
  });

  it('leaves the lip with a trick and no rotation of its own when nothing is pressed', () => {
    expect(quiet.trick).toBeDefined();
    expect(quiet.trick?.airTime).toBeGreaterThan(1);
    expect(quiet.trick?.landed).toBe(true);
    expect(Math.abs(quiet.yaw)).toBeLessThan(10);
    expect(quiet.trick?.spin).toBe(0);
    expect(quiet.trick?.inversions).toBe(0);
  });

  it('turns the rider about the world vertical, the way the key points', () => {
    // Target for this case is a full 360. Measured at the current gains:
    // +46 deg right, -37 deg left, against +3 deg for hands off.
    const right = ride({ air: ['ArrowRight'] });
    const left = ride({ air: ['ArrowLeft'] });
    expect(right.yaw).toBeGreaterThan(25);
    expect(left.yaw).toBeLessThan(-20);
    expect(right.yaw - quiet.yaw).toBeGreaterThan(30);
    expect(quiet.yaw - left.yaw).toBeGreaterThan(30);
  });

  it('somersaults the rider about its own lateral axis, the way the key points', () => {
    // Measured: +146 deg on ArrowDown and +44 on ArrowUp, against +85 hands off.
    const front = ride({ air: ['ArrowDown'] });
    const back = ride({ air: ['ArrowUp'] });
    expect(front.pitch - quiet.pitch).toBeGreaterThan(35);
    expect(quiet.pitch - back.pitch).toBeGreaterThan(25);
  });

  it('rotates the rider about its own fore-aft axis — the side-flip the keyboard never had', () => {
    // Target for this case is a flatspin past 540 deg. Measured: +64 deg on
    // KeyE and -17 on KeyQ, against +21 hands off.
    const clockwise = ride({ air: ['KeyE'] });
    const anticlockwise = ride({ air: ['KeyQ'] });
    expect(clockwise.roll - quiet.roll).toBeGreaterThan(25);
    expect(quiet.roll - anticlockwise.roll).toBeGreaterThan(25);
  });

  it('still carries a rotation set up on the snow for a player who touches nothing in the air', () => {
    // The old path is untouched: twist on the in-run, hands off at the lip.
    // Measured: 84 deg of roll one way, -86 the other, with no air key pressed.
    const wound = ride({ windUp: ['KeyE'] });
    const other = ride({ windUp: ['KeyQ'] });
    expect(wound.trick).toBeDefined();
    expect(wound.roll).toBeGreaterThan(45);
    expect(other.roll).toBeLessThan(-45);
  });
});
