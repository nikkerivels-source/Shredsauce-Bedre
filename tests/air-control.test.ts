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
 * These assert direction and separation from a hands-off run, not the size of
 * the rotation. How much a full draw is worth is a different question with its
 * own tuning, its own reference jump and its own tests, in air-feel.test.ts —
 * so the numbers recorded in the comments here are what each key was measured
 * at, and the assertions stay well clear of them.
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

/** Flat groomed snow, no features: a jump here is the jump and nothing else. */
function flatLevel() {
  const level = jumpLevel();
  level.features.length = 0;
  level.terrain.slopeAngle = 10;
  return level;
}

function jumpRig() {
  const level = flatLevel();
  const baker = new TerrainBaker(level);
  const gear = getGear('twin-172');
  const sim = new RiderSim(baker.field, level, buildGrindSurfaces(level, baker.field), gear, defaultTuning());
  const input = new InputManager(new EventTarget() as unknown as HTMLElement, gear.discipline, {
    ...defaultInputSettings(gear.discipline),
  });
  sim.reset(level.spawn.x, level.spawn.z, level.spawn.heading);
  return { sim, input };
}

/** Seconds of air bought by pressing the jump key for `holdMs`. */
function airTime(holdMs: number): number {
  const { sim, input } = jumpRig();
  const dt = 1 / 120;
  const pressAt = 3;
  let t = 0;
  let pressed = false;
  let released = false;
  let air = 0;
  for (let step = 0; step < 120 * 9; step++) {
    if (!pressed && t >= pressAt) {
      down('Space');
      pressed = true;
    }
    if (pressed && !released && t >= pressAt + holdMs / 1000) {
      up('Space');
      released = true;
    }
    sim.step(dt, input.update(dt, sim.telemetry.airborne));
    if (pressed && sim.telemetry.airborne) air += dt;
    t += dt;
  }
  if (!released) up('Space');
  return air;
}

/** Holds the key for `holdS`, reporting the crouch reached and whether it popped. */
function holdProfile(holdS: number): { crouchWhileHeld: number; poppedOnRelease: boolean } {
  const { sim, input } = jumpRig();
  const dt = 1 / 120;
  let t = 0;
  let crouchWhileHeld = 0;
  let released = false;
  let airAfterRelease = 0;
  down('Space');
  for (let step = 0; step < 120 * 9; step++) {
    if (!released && t >= holdS) {
      up('Space');
      released = true;
    }
    const i = input.update(dt, sim.telemetry.airborne);
    // Sampled a few frames in, so the ramp to full compression is not counted.
    if (!released && t > 0.5) crouchWhileHeld = Math.max(crouchWhileHeld, i.crouch);
    sim.step(dt, i);
    if (released && sim.telemetry.airborne) airAfterRelease += dt;
    t += dt;
  }
  return { crouchWhileHeld, poppedOnRelease: airAfterRelease > 0.15 };
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
    // Measured after the T9 retune: +293 deg right, -278 left, against +3 for
    // hands off. Before it, the same keys were worth 46 and -37.
    const right = ride({ air: ['ArrowRight'] });
    const left = ride({ air: ['ArrowLeft'] });
    expect(right.yaw).toBeGreaterThan(25);
    expect(left.yaw).toBeLessThan(-20);
    expect(right.yaw - quiet.yaw).toBeGreaterThan(30);
    expect(quiet.yaw - left.yaw).toBeGreaterThan(30);
  });

  it('somersaults the rider about its own lateral axis, the way the key points', () => {
    // Measured after T9: +368 deg on ArrowDown and -232 on ArrowUp, against +85
    // hands off.
    const front = ride({ air: ['ArrowDown'] });
    const back = ride({ air: ['ArrowUp'] });
    expect(front.pitch - quiet.pitch).toBeGreaterThan(35);
    expect(quiet.pitch - back.pitch).toBeGreaterThan(25);
  });

  it('rotates the rider about its own fore-aft axis — the side-flip the keyboard never had', () => {
    // Measured after T9: +236 deg on KeyE and -227 on KeyQ, against +21 hands
    // off. This is the axis a cork is built on.
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

  // --- Space is a jump button ---------------------------------------------

  it('jumps on a tap, not only on a held-then-released press', () => {
    // The leg spring loads while the key is down and fires on release, so a tap
    // used to release it before it had compressed: 40 ms of Space bought
    // 0.000 s of air, and it took a 320 ms hold to get a real jump. A press now
    // guarantees the load finishes, so every press is the same jump.
    const tap = airTime(40);
    const hold = airTime(400);
    expect(tap).toBeGreaterThan(0.4);
    // Within a frame or two of each other: a tap is not a worse jump.
    expect(Math.abs(tap - hold)).toBeLessThan(0.1);
  });

  it('still lets a long hold stay crouched and pop on release', () => {
    // Absorbing a transition and popping off the lip is the technique the whole
    // trick ladder is measured with. Automating the tap must not cost it.
    //
    // Worth recording what this measures rather than only that it passes: a
    // long hold reaches full compression and does pop, but it pops *worse* than
    // a tap — 0.9 s of hold buys 0.25 s of air against the 0.55 s a 320 ms
    // press gets, and 0.6 s and 1.4 s land in the same place. The leg bottoms
    // out on its stop and the stored energy goes nowhere. That is leg-spring
    // behaviour inside the sim, not input routing, and it is left alone here.
    const { crouchWhileHeld, poppedOnRelease } = holdProfile(0.9);
    expect(crouchWhileHeld).toBeGreaterThan(0.8);
    expect(poppedOnRelease).toBe(true);
  });

  // --- Step 3: the pop, on both ride models -------------------------------

  it('caps the load so holding too long is never better than timing it', () => {
    // The one thing step 3 asks for that is deliverable: "someone who holds the
    // button too long must not get a better jump than someone who times it".
    // The cap is on the clock, so a long hold loads exactly as deep as a timed
    // one and no deeper.
    const timed = airTime(340);
    const held = airTime(1200);
    expect(held).toBeLessThanOrEqual(timed + 0.05);
  });

  it('still jumps from a tap now that load timing is per ride model', () => {
    // The load timing moved into RideModel and is pushed into the input
    // manager per level. The mountain's numbers must not have moved with it.
    const tap = airTime(40);
    expect(tap).toBeGreaterThan(0.4);
  });
});
