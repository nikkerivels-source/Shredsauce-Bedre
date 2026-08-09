import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { InputManager, defaultInputSettings } from '../src/game/input.ts';
import { RiderSim, defaultTuning } from '../src/physics/riderSim.ts';
import { buildGrindSurfaces } from '../src/physics/rails.ts';
import { TerrainBaker } from '../src/world/terrain.ts';
import { getGear } from '../src/physics/gear.ts';
import { emptyLevel } from '../src/world/level.ts';

/**
 * Turning without falling over.
 *
 * The most basic thing a player does, and it did not work: holding the turn key
 * for three seconds on the first stock mountain put the rider on their back.
 * Nothing exotic — no jump, no rail, no trick. Just a turn.
 */
let restore: () => void = () => {};
beforeAll(() => {
  const w = new EventTarget();
  const p = (globalThis as Record<string, unknown>).window;
  (globalThis as Record<string, unknown>).window = w;
  restore = () => {
    (globalThis as Record<string, unknown>).window = p;
  };
});
afterAll(() => restore());

function ev(t: string, c: string): Event {
  const e = new Event(t, { cancelable: true });
  Object.defineProperty(e, 'code', { value: c });
  Object.defineProperty(e, 'repeat', { value: false });
  return e;
}
const down = (c: string) => (globalThis.window as unknown as EventTarget).dispatchEvent(ev('keydown', c));
const up = (c: string) => (globalThis.window as unknown as EventTarget).dispatchEvent(ev('keyup', c));

interface TurnResult {
  bailedAt: number;
  airFraction: number;
  peakEdge: number;
  meanSpeed: number;
}

/** Rides Home Park's terrain and holds one turn key for `seconds`. */
function heldTurn(key: string, seconds: number, hardness = 0.62): TurnResult {
  const level = emptyLevel('turn');
  level.seed = 0x50ade1;
  level.terrain.slopeAngle = 16;
  level.terrain.length = 940;
  level.terrain.width = 200;
  level.terrain.roughness = 1.4;
  level.snow.hardness = hardness;
  level.snow.groomed = true;
  level.spawn = { x: 0, z: 16, heading: 0 };
  const baker = new TerrainBaker(level);
  const gear = getGear('twin-172');
  const sim = new RiderSim(baker.field, level, buildGrindSurfaces(level, baker.field), gear, defaultTuning());
  const input = new InputManager(new EventTarget() as unknown as HTMLElement, gear.discipline, {
    ...defaultInputSettings(gear.discipline),
  });
  sim.reset(0, 16, 0);
  const dt = 1 / 120;
  for (let s = 0; s < 120 * 4; s++) sim.step(dt, input.update(dt, sim.telemetry.airborne));

  down(key);
  let bailedAt = -1;
  let air = 0;
  let peakEdge = 0;
  let speedSum = 0;
  const steps = Math.round(120 * seconds);
  for (let s = 0; s < steps; s++) {
    sim.step(dt, input.update(dt, sim.telemetry.airborne));
    if (sim.telemetry.airborne) air++;
    peakEdge = Math.max(peakEdge, Math.abs(sim.telemetry.edgeAngle));
    speedSum += sim.telemetry.speed;
    if (bailedAt < 0 && sim.state === 'bailed') bailedAt = s / 120;
  }
  up(key);
  return { bailedAt, airFraction: air / steps, peakEdge, meanSpeed: speedSum / steps };
}

describe('holding a turn', () => {
  it('does not put the rider on their back', { timeout: 60_000 }, () => {
    for (const key of ['ArrowRight', 'ArrowLeft']) {
      const r = heldTurn(key, 6);
      expect(r.bailedAt, `${key} bailed at ${r.bailedAt}s`).toBe(-1);
    }
  });

  it('keeps the gear on the snow through the turn', { timeout: 60_000 }, () => {
    // The bail was not a lean problem. The rider was being tipped onto such a
    // steep edge that the contact unloaded and they skipped off the snow, then
    // landed mid-turn on a loaded edge, which is a caught edge every time.
    const r = heldTurn('ArrowRight', 6);
    expect(r.airFraction).toBeLessThan(0.05);
  });

  it('holds an edge a skier could actually hold', { timeout: 60_000 }, () => {
    // 61 degrees came out of simply holding the key. Real carving lives in the
    // thirties and forties, and past about fifty the ski is on its side with
    // almost no contact patch left.
    const r = heldTurn('ArrowRight', 6);
    expect(r.peakEdge).toBeLessThan(52);
  });

  it('carries speed through a turn instead of scrubbing to a stop', { timeout: 60_000 }, () => {
    const r = heldTurn('ArrowRight', 6);
    expect(r.meanSpeed).toBeGreaterThan(9);
  });

  it('survives a turn on ice as well as on soft snow', { timeout: 60_000 }, () => {
    expect(heldTurn('ArrowRight', 6, 0.92).bailedAt).toBe(-1);
    expect(heldTurn('ArrowRight', 6, 0.35).bailedAt).toBe(-1);
  });
});
