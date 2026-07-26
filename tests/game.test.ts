import { describe, expect, it, beforeEach } from 'vitest';
import { emptyLevel, makeFeature, migrateLevel, type Feature } from '../src/world/level.ts';
import { TerrainBaker, featureBounds } from '../src/world/terrain.ts';
import { buildGrindSurfaces, makeGrindQuery, queryGrindSurfaces } from '../src/physics/rails.ts';
import { Vec3 } from '../src/core/math.ts';
import { TrickTracker } from '../src/game/tricks.ts';
import { RiderSim, defaultTuning, neutralInput, type SimEvent } from '../src/physics/riderSim.ts';
import { getGear } from '../src/physics/gear.ts';
import { Ragdoll, makePose, poseFromRider } from '../src/physics/ragdoll.ts';
import { ReplayPlayer, ReplayRecorder, makeReplaySample } from '../src/game/replay.ts';
import { PRESETS, generateLevel } from '../src/game/levels.ts';
import { Session } from '../src/game/session.ts';
import { LevelEditor } from '../src/game/editor.ts';
import { defaultProfile } from '../src/game/storage.ts';

describe('level format', () => {
  it('round-trips through JSON', () => {
    const level = emptyLevel('trip');
    level.features.push(makeFeature('kicker', 3, 100), makeFeature('rail', -4, 160));
    const restored = migrateLevel(JSON.parse(JSON.stringify(level)));
    expect(restored.features).toHaveLength(2);
    expect(restored.features[0].kind).toBe('kicker');
    expect(restored.name).toBe('trip');
  });

  it('rejects junk without throwing on the caller', () => {
    expect(() => migrateLevel(null)).toThrow();
    const salvaged = migrateLevel({ name: 'odd', features: [{ nope: true }, null, 42] });
    expect(salvaged.features).toHaveLength(0);
    expect(salvaged.name).toBe('odd');
  });

  it('clamps a hostile level to a survivable memory footprint', () => {
    const hostile = migrateLevel({
      name: 'huge',
      terrain: { width: 100000, length: 100000, resolution: 0.01, slopeAngle: 900, roughness: -5 },
    });
    const cells = (hostile.terrain.width / hostile.terrain.resolution) * (hostile.terrain.length / hostile.terrain.resolution);
    expect(cells).toBeLessThanOrEqual(4_000_000);
    expect(hostile.terrain.slopeAngle).toBeLessThanOrEqual(55);
    expect(hostile.terrain.roughness).toBeGreaterThanOrEqual(0);
  });

  it('gives every feature a bounding box that contains its origin', () => {
    for (const kind of ['kicker', 'rail', 'box', 'roller', 'quarterpipe', 'halfpipe', 'hip', 'wallride', 'gate', 'prop'] as const) {
      for (const heading of [0, 45, 137, -90]) {
        const feature = makeFeature(kind, 12, 240, heading);
        const bounds = featureBounds(feature);
        expect(bounds.minX).toBeLessThanOrEqual(feature.x);
        expect(bounds.maxX).toBeGreaterThanOrEqual(feature.x);
        expect(bounds.minZ).toBeLessThanOrEqual(feature.z);
        expect(bounds.maxZ).toBeGreaterThanOrEqual(feature.z);
      }
    }
  });
});

describe('presets', () => {
  it('every preset bakes and is rideable', () => {
    for (const preset of PRESETS) {
      const level = preset.build();
      const baker = new TerrainBaker(level);
      expect(baker.field.nx).toBeGreaterThan(2);
      // The spawn must not be buried inside a feature.
      const spawnHeight = baker.field.heightAt(level.spawn.x, level.spawn.z);
      expect(Number.isFinite(spawnHeight)).toBe(true);

      const sim = new RiderSim(baker.field, level, buildGrindSurfaces(level, baker.field), getGear('park-155'), defaultTuning());
      const input = neutralInput();
      for (let i = 0; i < 240; i++) sim.step(1 / 60, input);
      expect(sim.position.isFinite()).toBe(true);
      expect(sim.telemetry.speed).toBeLessThan(80);
    }
  });

  it('generates varied levels from a seed, reproducibly', () => {
    const a = generateLevel(4242, 'park');
    const b = generateLevel(4242, 'park');
    expect(a.features.length).toBe(b.features.length);
    expect(a.terrain.slopeAngle).toBeCloseTo(b.terrain.slopeAngle, 10);
    const c = generateLevel(99, 'park');
    expect(c.features.length === a.features.length && c.terrain.length === a.terrain.length).toBe(false);
  });
});

describe('grind surfaces', () => {
  it('places rails above the snow and finds the closest point', () => {
    const level = emptyLevel('rails');
    level.seed = 0x1234;
    level.terrain.roughness = 0;
    const rail = makeFeature('rail', 0, 120) as Extract<Feature, { kind: 'rail' }>;
    rail.length = 14;
    rail.height = 1;
    rail.endHeight = 1;
    level.features.push(rail);

    const baker = new TerrainBaker(level);
    const surfaces = buildGrindSurfaces(level, baker.field);
    expect(surfaces).toHaveLength(1);

    const ground = baker.field.heightAt(0, 120);
    expect(surfaces[0].points[0].y).toBeCloseTo(ground + 1, 5);
    // The rail follows the falling ground at a constant height above it, so its
    // three-dimensional length is longer than the 14 m it spans in plan view.
    expect(surfaces[0].totalLength).toBeGreaterThan(14);
    expect(surfaces[0].totalLength).toBeLessThan(15.5);

    // Probe just above the middle of the rail's own geometry — the rail drops
    // with the hill, so a point at the start height further down is metres away.
    const mid = surfaces[0].points[0].clone().lerpVectors(surfaces[0].points[0], surfaces[0].points[1], 0.5);
    const query = makeGrindQuery();
    const near = queryGrindSurfaces(surfaces, new Vec3(mid.x + 0.05, mid.y, mid.z), 1, query);
    expect(near).not.toBeNull();
    expect(near?.distance).toBeLessThan(0.2);
    expect(near?.along).toBeGreaterThan(1);

    const far = queryGrindSurfaces(surfaces, new Vec3(mid.x + 40, mid.y, mid.z), 1, query);
    expect(far).toBeNull();
  });
});

describe('trick tracker', () => {
  function setup() {
    const level = emptyLevel('trick');
    level.seed = 0x77;
    level.terrain.roughness = 0;
    const baker = new TerrainBaker(level);
    const sim = new RiderSim(baker.field, level, [], getGear('park-155'), defaultTuning());
    const tracker = new TrickTracker({ discipline: 'snowboard', goofy: false });
    return { sim, tracker };
  }

  it('names a frontside 540 and scores it', () => {
    const { sim, tracker } = setup();
    const input = neutralInput();
    const takeoff: SimEvent = { type: 'takeoff', time: 0, speed: 16 };
    tracker.update(1 / 60, sim, input, [takeoff]);

    // 1.5 rotations about world up, accumulated the way the sim would.
    sim.angularVelocity.set(0, (Math.PI * 3) / 1.2, 0);
    for (let t = 0; t < 1.2; t += 1 / 120) tracker.update(1 / 120, sim, input, []);

    tracker.update(1 / 60, sim, input, [{ type: 'landing', time: 1.25, quality: 0.9, impact: 4000, speed: 15 }]);
    const trick = tracker.history.at(-1);
    expect(trick).toBeDefined();
    expect(trick?.name).toContain('540');
    expect(trick?.name).toContain('frontside');
    expect(trick?.points).toBeGreaterThan(0);
    expect(trick?.landed).toBe(true);
  });

  it('calls the other direction backside', () => {
    const { sim, tracker } = setup();
    const input = neutralInput();
    tracker.update(1 / 60, sim, input, [{ type: 'takeoff', time: 0, speed: 16 }]);
    sim.angularVelocity.set(0, -(Math.PI * 2) / 1.0, 0);
    for (let t = 0; t < 1.0; t += 1 / 120) tracker.update(1 / 120, sim, input, []);
    tracker.update(1 / 60, sim, input, [{ type: 'landing', time: 1.05, quality: 0.85 }]);
    expect(tracker.history.at(-1)?.name).toContain('backside');
    expect(tracker.history.at(-1)?.name).toContain('360');
  });

  it('credits a held grab and scores it above the same spin without one', () => {
    const { sim, tracker } = setup();
    const plain = neutralInput();
    const grabbed = { ...neutralInput(), grab: 'melon' };

    const spin = (input: typeof plain) => {
      tracker.reset();
      tracker.update(1 / 60, sim, input, [{ type: 'takeoff', time: 0, speed: 16 }]);
      sim.angularVelocity.set(0, (Math.PI * 2) / 1.0, 0);
      for (let t = 0; t < 1.0; t += 1 / 120) tracker.update(1 / 120, sim, input, []);
      tracker.update(1 / 60, sim, input, [{ type: 'landing', time: 1.05, quality: 0.9 }]);
      return tracker.history.at(-1);
    };

    const without = spin(plain);
    const withGrab = spin(grabbed);
    expect(withGrab?.name).toContain('melon');
    expect(withGrab?.points ?? 0).toBeGreaterThan(without?.points ?? 0);
  });

  it('scores a sketchy landing lower than a stomped one', () => {
    const { sim, tracker } = setup();
    const input = neutralInput();
    const land = (quality: number) => {
      tracker.reset();
      tracker.update(1 / 60, sim, input, [{ type: 'takeoff', time: 0, speed: 16 }]);
      sim.angularVelocity.set(0, (Math.PI * 2) / 1.0, 0);
      for (let t = 0; t < 1.0; t += 1 / 120) tracker.update(1 / 120, sim, input, []);
      tracker.update(1 / 60, sim, input, [{ type: 'landing', time: 1.05, quality }]);
      return tracker.history.at(-1)?.points ?? 0;
    };
    expect(land(0.95)).toBeGreaterThan(land(0.35));
  });

  it('a bail scores nothing and resets the combo', () => {
    const { sim, tracker } = setup();
    const input = neutralInput();
    tracker.combo = 3;
    tracker.update(1 / 60, sim, input, [{ type: 'takeoff', time: 0, speed: 16 }]);
    tracker.update(1 / 60, sim, input, [{ type: 'bail', time: 0.5, reason: 'caught an edge' }]);
    expect(tracker.combo).toBe(1);
    expect(tracker.history.at(-1)?.landed).toBe(false);
    expect(tracker.history.at(-1)?.points).toBe(0);
  });

  it('does not call a plain bump a trick', () => {
    const { sim, tracker } = setup();
    const input = neutralInput();
    tracker.update(1 / 60, sim, input, [{ type: 'takeoff', time: 0, speed: 10 }]);
    tracker.update(1 / 60, sim, input, [{ type: 'landing', time: 0.1, quality: 0.9 }]);
    expect(tracker.history).toHaveLength(0);
  });
});

describe('ragdoll', () => {
  it('keeps bone lengths under a violent impact and settles on the snow', () => {
    const level = emptyLevel('crash');
    level.seed = 0xc0ffee;
    // Near-flat, so "comes to rest" is a meaningful assertion — on a real pitch
    // a crashed body keeps sliding, which is correct but untestable this way.
    level.terrain.slopeAngle = 3;
    level.terrain.roughness = 0;
    const baker = new TerrainBaker(level);
    const sim = new RiderSim(baker.field, level, [], getGear('park-155'), defaultTuning());
    const pose = makePose();
    poseFromRider(sim, pose, { grab: null, twist: 0, tuck: 0, goofy: false });

    const ragdoll = new Ragdoll();
    ragdoll.seed(pose, new Vec3(0, -25, 30), new Vec3(14, 9, 5), sim.position);
    for (let i = 0; i < 400; i++) ragdoll.step(1 / 60, baker.field);

    // Pelvis to chest is a fixed bone; a blown-up solver stretches it.
    const pelvis = ragdoll.current[3];
    const chest = ragdoll.current[2];
    expect(pelvis.distanceTo(chest)).toBeGreaterThan(0.2);
    expect(pelvis.distanceTo(chest)).toBeLessThan(0.5);

    for (const joint of ragdoll.current) {
      expect(joint.isFinite()).toBe(true);
      expect(joint.y).toBeGreaterThan(baker.field.heightAt(joint.x, joint.z) - 0.5);
    }
    expect(ragdoll.restSpeed(1 / 60)).toBeLessThan(6);
  });
});

describe('replay', () => {
  it('records and plays back the path it recorded', () => {
    const level = emptyLevel('replay');
    const baker = new TerrainBaker(level);
    const sim = new RiderSim(baker.field, level, [], getGear('park-155'), defaultTuning());
    const recorder = new ReplayRecorder(30);
    const input = neutralInput();

    for (let i = 0; i < 300; i++) {
      sim.step(1 / 60, input);
      recorder.capture(1 / 60, sim, { grab: null, twist: 0, tuck: 0, limp: false });
    }
    const replay = recorder.finish({
      levelId: 'x',
      levelName: 'x',
      gearId: 'park-155',
      goofy: false,
      score: 0,
      label: 'test',
    });
    expect(replay.frames.length).toBeGreaterThan(100);
    expect(replay.frames[0].t).toBeCloseTo(0, 5);

    const player = new ReplayPlayer(replay);
    const sample = makeReplaySample();
    player.seek(replay.frames.at(-1)!.t);
    player.sample(sample);
    expect(sample.position.distanceTo(sim.position)).toBeLessThan(1.5);

    // Interpolating mid-way must land between the two bracketing frames.
    player.seek(replay.frames[10].t + 0.5 / 30);
    player.sample(sample);
    const lo = Math.min(replay.frames[10].pz, replay.frames[11].pz);
    const hi = Math.max(replay.frames[10].pz, replay.frames[11].pz);
    expect(sample.position.z).toBeGreaterThanOrEqual(lo - 1e-6);
    expect(sample.position.z).toBeLessThanOrEqual(hi + 1e-6);
  });

  it('keeps only the trailing window of a long session', () => {
    const level = emptyLevel('long');
    const baker = new TerrainBaker(level);
    const sim = new RiderSim(baker.field, level, [], getGear('park-155'), defaultTuning());
    const recorder = new ReplayRecorder(5);
    for (let i = 0; i < 60 * 30; i++) {
      sim.step(1 / 60, sim.state === 'bailed' ? neutralInput() : neutralInput());
      recorder.capture(1 / 60, sim, { grab: null, twist: 0, tuck: 0, limp: false });
    }
    // 5 seconds at 30 Hz is about 150 frames, not 900.
    expect(recorder.frames.length).toBeLessThan(200);
  });
});

describe('editor', () => {
  let session: Session;
  let editor: LevelEditor;

  beforeEach(() => {
    const level = emptyLevel('edit');
    level.terrain.length = 400;
    session = new Session(level, defaultProfile());
    editor = new LevelEditor(session);
  });

  it('places, moves and deletes features, and undoes each step', () => {
    editor.placeKind = 'kicker';
    const feature = editor.place(2, 150);
    expect(session.level.features).toHaveLength(1);

    editor.select(feature.id);
    editor.beginStroke();
    editor.moveSelected(20, 180);
    editor.endStroke();
    expect(editor.selected?.x).toBe(20);

    editor.deleteSelected();
    expect(session.level.features).toHaveLength(0);

    editor.undo();
    expect(session.level.features).toHaveLength(1);
    editor.undo();
    expect(session.level.features[0].x).toBe(2);
    editor.redo();
    expect(session.level.features[0].x).toBe(20);
  });

  it('raises terrain where the brush is dragged', () => {
    const before = session.field.heightAt(0, 200);
    editor.tool = 'raise';
    editor.brush.radius = 10;
    editor.brush.strength = 3;
    editor.beginStroke();
    for (let i = 0; i < 20; i++) editor.paintTerrain(0, 200, 1 / 60, 1);
    editor.endStroke();
    expect(session.field.heightAt(0, 200)).toBeGreaterThan(before + 0.3);

    editor.undo();
    expect(session.field.heightAt(0, 200)).toBeCloseTo(before, 3);
  });

  it('keeps rails sitting on the terrain after it is sculpted under them', () => {
    editor.placeKind = 'rail';
    const rail = editor.place(0, 200);
    const railHeight = () => session.grindSurfaces[0].points[0].y - session.field.heightAt(rail.x, rail.z);
    const original = railHeight();

    editor.tool = 'raise';
    editor.brush.radius = 14;
    editor.brush.strength = 3;
    editor.beginStroke();
    for (let i = 0; i < 25; i++) editor.paintTerrain(0, 200, 1 / 60, 1);
    editor.endStroke();

    expect(railHeight()).toBeCloseTo(original, 1);
  });

  it('auto-fill produces a rideable park', () => {
    editor.autoFill(7);
    expect(session.level.features.length).toBeGreaterThan(1);
    const sim = session.sim;
    const input = neutralInput();
    for (let i = 0; i < 600; i++) sim.step(1 / 60, input);
    expect(sim.position.isFinite()).toBe(true);
  });
});

describe('session', () => {
  it('tracks a run summary and finishes at the bottom', () => {
    const level = emptyLevel('session');
    level.terrain.length = 200;
    level.terrain.slopeAngle = 25;
    const session = new Session(level, defaultProfile());
    session.restart('freeride');
    const input = neutralInput();
    for (let i = 0; i < 60 * 40; i++) session.update(1 / 60, input);
    expect(session.summary.distance).toBeGreaterThan(50);
    expect(session.summary.topSpeed).toBeGreaterThan(5);
    expect(session.summary.finished).toBe(true);
  });

  it('counts down and stops a jam session', () => {
    const session = new Session(emptyLevel('jam'), defaultProfile());
    session.restart('jam');
    expect(session.timeRemaining).toBe(150);
    const input = neutralInput();
    for (let i = 0; i < 60 * 5; i++) session.update(1 / 60, input);
    expect(session.timeRemaining).toBeLessThan(150);
    expect(session.timeRemaining).toBeGreaterThan(140);
  });
});
