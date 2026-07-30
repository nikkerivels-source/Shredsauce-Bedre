import { describe, expect, it, beforeEach } from 'vitest';
import {
  PROP_KINDS,
  defaultBackdrop,
  emptyLevel,
  isPropKind,
  makeFeature,
  migrateLevel,
  sanitizeBackdrop,
  type Feature,
} from '../src/world/level.ts';
import { TerrainBaker, featureBounds } from '../src/world/terrain.ts';
import { buildGrindSurfaces, makeGrindQuery, queryGrindSurfaces } from '../src/physics/rails.ts';
import { Vec3 } from '../src/core/math.ts';
import { TrickTracker } from '../src/game/tricks.ts';
import { RiderSim, defaultTuning, neutralInput, type SimEvent } from '../src/physics/riderSim.ts';
import { getGear } from '../src/physics/gear.ts';
import { Ragdoll, makePose, poseFromRider } from '../src/physics/ragdoll.ts';
import { ReplayPlayer, ReplayRecorder, makeReplaySample } from '../src/game/replay.ts';
import { PRESETS, generateLevel } from '../src/game/levels.ts';
import { buildProps } from '../src/render/world.ts';
import { cliffBand, jumpLine, jumpSpacing, ledgeDrop, spine } from '../src/game/design.ts';
import { Session } from '../src/game/session.ts';
import { LevelEditor } from '../src/game/editor.ts';
import { defaultProfile, decodeLevelCode, encodeLevelCode, grantPass, passOwned } from '../src/game/storage.ts';
import {
  PASS,
  SKINS,
  beginCheckout,
  checkoutUrl,
  consumeCheckoutReturn,
  gearUnlocked,
  passAvailable,
  passGear,
  passSkins,
  skinUnlocked,
} from '../src/game/pass.ts';
import { GEAR_CATALOG } from '../src/physics/gear.ts';
import { TUTORIAL_STEPS, Tutorial } from '../src/game/tutorial.ts';

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
  // Bakes ten full mountains, which is seconds of real work rather than the
  // milliseconds vitest assumes by default. It was already close to the 5 s
  // limit and tipped over it once the air-feel suite started competing for the
  // same cores.
  it('every preset bakes and is rideable', { timeout: 30_000 }, () => {
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

  it('every mountain is actually built', () => {
    for (const preset of PRESETS) {
      const level = preset.build();
      const ridable = level.features.filter((f) => f.kind !== 'prop' && f.kind !== 'gate');
      const gates = level.features.filter((f) => f.kind === 'gate');
      // Big Air is legitimately three features — a warm-up, the booter and a
      // wall — so this is a guard against a mountain quietly becoming an empty
      // slope, not a demand that every one be a superpark.
      expect(ridable.length + gates.length).toBeGreaterThanOrEqual(3);
      expect(level.features.length).toBeGreaterThan(40);
      // Nothing may sit outside the terrain it is built on.
      const half = level.terrain.width / 2;
      for (const f of level.features) {
        expect(Math.abs(f.x)).toBeLessThanOrEqual(half + 1);
        expect(f.z).toBeGreaterThan(0);
        expect(f.z).toBeLessThan(level.terrain.length);
      }
    }
  });

  it('leaves room to land and recover between jumps', () => {
    for (const preset of PRESETS) {
      const jumps = preset
        .build()
        .features.filter((f): f is Extract<Feature, { kind: 'kicker' }> => f.kind === 'kicker')
        .sort((a, b) => a.z - b.z);
      for (let i = 1; i < jumps.length; i++) {
        const previous = jumps[i - 1];
        const gap = jumps[i].z - previous.z;
        // Only jumps on the same line matter; side hits are meant to be passed.
        if (Math.abs(jumps[i].x - previous.x) > 14) continue;
        expect(gap).toBeGreaterThan(previous.gap + previous.landingLength);
      }
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
      authorId: 'rider_test',
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

describe('tutorial', () => {
  function ctx(session: Session, over: Partial<{ speed: number; edge: number; carve: number; altitude: number; grind: number }> = {}) {
    const tel = session.sim.telemetry;
    if (over.speed !== undefined) tel.speed = over.speed;
    if (over.edge !== undefined) tel.edgeAngle = over.edge;
    if (over.carve !== undefined) tel.carveQuality = over.carve;
    if (over.altitude !== undefined) tel.altitude = over.altitude;
    if (over.grind !== undefined) tel.grindDistance = over.grind;
    return { dt: 1 / 30, session, input: neutralInput(), landed: [] };
  }

  it('walks the steps in order and only on the real measurement', () => {
    const session = new Session(emptyLevel('tut'), defaultProfile());
    const tutorial = new Tutorial();

    // Step 1 wants speed. Standing still gets you nowhere.
    let view = tutorial.update(ctx(session, { speed: 0 }));
    expect(view.index).toBe(0);
    expect(view.progress).toBeLessThan(0.2);

    view = tutorial.update(ctx(session, { speed: 12 }));
    expect(view.index).toBe(1);

    // Settle window: the next step must not start judging immediately.
    for (let i = 0; i < 60; i++) tutorial.update(ctx(session, { speed: 12 }));

    // Step 2 wants a real edge angle, held.
    for (let i = 0; i < 40; i++) view = tutorial.update(ctx(session, { speed: 12, edge: 30 }));
    expect(view.index).toBe(2);
  });

  it('will not pass the carve step on a skid', () => {
    const session = new Session(emptyLevel('tut'), defaultProfile());
    const tutorial = new Tutorial();
    tutorial.index = 2; // the carve step

    // A big edge angle but a washing-out slip angle is exactly what it must reject.
    for (let i = 0; i < 200; i++) {
      tutorial.update(ctx(session, { speed: 14, edge: 35, carve: 0.1 }));
    }
    expect(tutorial.index).toBe(2);

    // Clean it up and it passes.
    let view = tutorial.update(ctx(session, { speed: 14, edge: 35, carve: 0.9 }));
    for (let i = 0; i < 60 && view.index === 2; i++) {
      view = tutorial.update(ctx(session, { speed: 14, edge: 35, carve: 0.9 }));
    }
    expect(tutorial.index).toBeGreaterThan(2);
  });

  it('reaches completion through every step', () => {
    const session = new Session(emptyLevel('tut'), defaultProfile());
    const tutorial = new Tutorial();
    const landedTrick = {
      name: 'frontside 360 melon',
      points: 900,
      breakdown: { rotation: 200, flip: 0, grab: 300, air: 100, grind: 0 },
      quality: 0.9,
      landed: true,
      multiplier: 1,
      spin: 360,
      inversions: 0,
      airTime: 1,
      height: 2,
      time: 0,
    };
    for (let i = 0; i < 4000 && !tutorial.complete; i++) {
      const base = ctx(session, { speed: 14, edge: 30 * (i % 120 < 60 ? 1 : -1), carve: 0.9, altitude: 1.2, grind: 6 });
      tutorial.update({ ...base, landed: [landedTrick] });
    }
    expect(tutorial.complete).toBe(true);
    expect(tutorial.index).toBe(TUTORIAL_STEPS.length - 1);
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

describe('terrain sculpting', () => {
  // Brush strokes are additive, so a line of them sums well past any one
  // stroke's amount. The helpers correct for that; these pin the correction,
  // because getting it wrong is silent — the level still bakes, it is just the
  // wrong shape.
  function flatLevel() {
    const level = emptyLevel('sculpt');
    level.seed = 7;
    level.terrain.roughness = 0;
    level.terrain.banking = 0;
    level.terrain.length = 400;
    level.terrain.width = 120;
    // Baking is the expensive part, so keep these probe levels coarse.
    level.terrain.resolution = 1;
    return level;
  }

  /** Bakes once and returns height above the unsculpted ground. */
  function sampler(level: ReturnType<typeof emptyLevel>) {
    const baker = new TerrainBaker(level);
    return (x: number, z: number) => baker.field.heightAt(x, z) - baker.naturalHeight(x, z);
  }

  it('carves a cliff band to the depth it asks for', () => {
    const level = flatLevel();
    cliffBand(level.brushes, 200, -40, 40, 6);
    const relief = sampler(level);
    let deepest = 0;
    for (let z = 190; z <= 214; z += 1) deepest = Math.min(deepest, relief(0, z));
    expect(deepest).toBeLessThan(-5);
    expect(deepest).toBeGreaterThan(-7);
  });

  it('raises a spine to the height it asks for', () => {
    const level = flatLevel();
    spine(level.brushes, 0, 150, 270, 3, 16);
    const relief = sampler(level);
    let peak = 0;
    for (let z = 150; z <= 270; z += 1) peak = Math.max(peak, relief(0, z));
    expect(peak).toBeGreaterThan(2.5);
    expect(peak).toBeLessThan(3.3);
  });

  it('cuts a ledge face that is flat across the slope', () => {
    const level = flatLevel();
    ledgeDrop(level.brushes, { x: 0, z: 200, drop: 3, length: 20, width: 24 });
    const relief = sampler(level);
    const samples: number[] = [];
    for (let x = -10; x <= 10; x += 5) {
      let deepest = 0;
      for (let z = 195; z <= 220; z += 1) deepest = Math.min(deepest, relief(x, z));
      samples.push(deepest);
    }
    for (const s of samples) {
      expect(s).toBeLessThan(-2.4);
      expect(s).toBeGreaterThan(-4);
    }
    // Scalloping is the failure mode: neighbouring stamps leaving gaps.
    const spread = Math.max(...samples) - Math.min(...samples);
    expect(spread).toBeLessThan(1);
  });

  it('spaces a jump line by landing length plus a run-out', () => {
    const out: Feature[] = [];
    const end = jumpLine(out, 100, { sizes: [2, 4], offsets: [0] });
    expect(out).toHaveLength(2);
    expect(out[1].z - out[0].z).toBeCloseTo(jumpSpacing(2), 6);
    expect(end).toBeCloseTo(100 + jumpSpacing(2) + jumpSpacing(4), 6);
    const first = out[0] as Extract<Feature, { kind: 'kicker' }>;
    expect(jumpSpacing(2)).toBeGreaterThan(first.gap + first.landingLength);
  });
});

describe('backdrops and items', () => {
  const PIXEL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  // A backdrop arrives inside a level someone else built, so this is a trust
  // boundary, not a formatting nicety.
  it('accepts inline image data and nothing else', () => {
    expect(sanitizeBackdrop(defaultBackdrop(PIXEL))?.image).toBe(PIXEL);

    // A remote URL would make every player who rides the level fetch from a
    // stranger's server the moment they dropped in.
    expect(sanitizeBackdrop({ image: 'https://example.com/sky.jpg' })).toBeNull();
    expect(sanitizeBackdrop({ image: '//example.com/sky.jpg' })).toBeNull();
    // Anything that is not an image is a script-injection vector in a costume.
    expect(sanitizeBackdrop({ image: 'data:text/html;base64,PHNjcmlwdD4=' })).toBeNull();
    expect(sanitizeBackdrop({ image: 'data:image/svg+xml;base64,PHN2Zz4=' })).toBeNull();
    expect(sanitizeBackdrop({ image: 'javascript:alert(1)' })).toBeNull();
    expect(sanitizeBackdrop({ image: `data:image/png;base64,${'A'.repeat(4_000_000)}` })).toBeNull();
    expect(sanitizeBackdrop(null)).toBeNull();
    expect(sanitizeBackdrop('nope')).toBeNull();
  });

  it('clamps backdrop placement out of a hostile level', () => {
    const cleaned = sanitizeBackdrop({ image: PIXEL, opacity: 9, rotation: 5000, horizon: -3, scale: 0 });
    expect(cleaned).not.toBeNull();
    expect(cleaned!.opacity).toBeLessThanOrEqual(1);
    expect(Math.abs(cleaned!.rotation)).toBeLessThanOrEqual(180);
    expect(cleaned!.horizon).toBeGreaterThanOrEqual(0);
    expect(cleaned!.scale).toBeGreaterThan(0);
  });

  it('survives a migration that carries a picture', () => {
    const level = emptyLevel('with picture');
    level.backdrop = defaultBackdrop(PIXEL);
    const restored = migrateLevel(JSON.parse(JSON.stringify(level)));
    expect(restored.backdrop?.image).toBe(PIXEL);
  });

  it('leaves the picture out of a share code', async () => {
    const level = emptyLevel('shared');
    level.backdrop = defaultBackdrop(PIXEL);
    level.features.push(makeFeature('kicker', 0, 120));
    const code = await encodeLevelCode(level);
    const round = await decodeLevelCode(code);
    // The level travels; the picture does not, because a code carrying one is
    // far too long to paste.
    expect(round.features).toHaveLength(1);
    expect(round.backdrop).toBeNull();
    // Encoding must not mutate the level still open in the editor.
    expect(level.backdrop?.image).toBe(PIXEL);
  });

  it('falls back to a pine for an item kind it does not know', () => {
    const level = emptyLevel('items');
    const good = makeFeature('prop', 2, 50) as Extract<Feature, { kind: 'prop' }>;
    good.prop = 'snowcat';
    level.features.push(good, { ...good, id: 'x', prop: 'spaceship' } as unknown as Feature);
    const restored = migrateLevel(JSON.parse(JSON.stringify(level)));
    const props = restored.features.filter((f): f is Extract<Feature, { kind: 'prop' }> => f.kind === 'prop');
    expect(props[0].prop).toBe('snowcat');
    expect(props[1].prop).toBe('pine');
  });

  it('lists every item kind exactly once', () => {
    expect(new Set(PROP_KINDS).size).toBe(PROP_KINDS.length);
    for (const kind of PROP_KINDS) expect(isPropKind(kind)).toBe(true);
    expect(isPropKind('spaceship')).toBe(false);
  });
});

describe('season one', () => {
  it('is a one-off purchase that is not owned by default', () => {
    const profile = defaultProfile();
    expect(passOwned(profile)).toBe(false);
    expect(PASS.price).toBe(2.99);

    grantPass(profile);
    expect(passOwned(profile)).toBe(true);
    const since = profile.pass?.since;
    // Buying twice must not reset or double-charge anything.
    grantPass(profile);
    expect(profile.pass?.since).toBe(since);
  });

  it('is not on sale yet, and no path can take money or grant it', () => {
    // Coming soon has to be enforced, not just displayed. Both entry points —
    // the buy button and the provider's return leg — go through the same gate,
    // so neither can be reached by setting an environment variable or by
    // hand-editing a URL.
    expect(passAvailable()).toBe(false);
    expect(beginCheckout().kind).toBe('unavailable');
    expect(consumeCheckoutReturn()).toBe(false);
  });

  it('still honours a pass that was already bought', () => {
    // Whatever the shop says, an entitlement someone holds is theirs. Coming
    // soon must never read as "you no longer own this".
    const profile = defaultProfile();
    grantPass(profile);
    expect(passOwned(profile)).toBe(true);
    for (const skin of passSkins()) expect(skinUnlocked(skin, passOwned(profile))).toBe(true);
    for (const g of passGear()) expect(gearUnlocked(g, passOwned(profile))).toBe(true);
  });

  it('unlocks every kit and ski at once, with no quest in between', () => {
    const skins = passSkins();
    const gear = passGear();
    expect(skins.length).toBeGreaterThan(4);
    expect(gear.length).toBeGreaterThan(3);

    // Nothing is staged, tiered or conditional: ownership alone is the gate.
    for (const skin of skins) {
      expect(skinUnlocked(skin, false)).toBe(false);
      expect(skinUnlocked(skin, true)).toBe(true);
    }
    for (const g of gear) {
      expect(gearUnlocked(g, false)).toBe(false);
      expect(gearUnlocked(g, true)).toBe(true);
    }
  });

  it('leaves free players a working game', () => {
    // Free kits and a rideable board and ski for each discipline must survive
    // without the pass, or this stops being cosmetic and starts being a wall.
    expect(SKINS.filter((s) => !s.pass).length).toBeGreaterThan(1);
    for (const discipline of ['skis', 'snowboard'] as const) {
      const free = GEAR_CATALOG.filter((g) => g.discipline === discipline && !g.pass && g.price === 0);
      expect(free.length).toBeGreaterThan(0);
    }
  });

  it('sells sidegrades rather than upgrades', () => {
    // Every pass ski has to give something up against the best free gear in
    // its discipline, or the pass is pay-to-win.
    for (const g of passGear()) {
      const rivals = GEAR_CATALOG.filter((r) => r.discipline === g.discipline && !r.pass);
      const bestGlide = Math.min(...rivals.map((r) => r.glideFriction));
      const bestPop = Math.max(...rivals.map((r) => r.pop));
      const bestSwing = Math.min(...rivals.map((r) => r.swingWeight));
      const dominant = g.glideFriction <= bestGlide && g.pop >= bestPop && g.swingWeight <= bestSwing;
      expect(dominant).toBe(false);
    }
  });

  it('does not pretend to charge when no provider is configured', () => {
    // Two reasons this build cannot sell the pass: it is not on sale yet, and
    // there is no VITE_CHECKOUT_URL behind it either. Which reason answers
    // first is not the point — the invariant is that the button never redirects
    // and never quietly hands the pass over.
    const outcome = beginCheckout();
    expect(outcome.kind).not.toBe('redirect');
    expect(checkoutUrl()).toBeNull();
    const profile = defaultProfile();
    expect(passOwned(profile)).toBe(false);
  });

  it('treats a malformed entitlement as unowned', () => {
    for (const junk of [{ owned: 'yes' }, {}, { owned: false }, null, 'owned']) {
      expect(passOwned({ ...defaultProfile(), pass: junk as never })).toBe(false);
    }
  });
});

describe('scene cost', () => {
  // A long run auto-scatters a tree every six metres on top of everything the
  // level places, and a pine is four meshes. Drawn one at a time that is close
  // to two thousand draw calls of scenery before anything else in the frame,
  // which a phone cannot afford. Instancing collapses it to a few per kind, and
  // this is the guard against someone quietly un-instancing it again.
  it('draws scenery instanced, not one object per tree', () => {
    for (const preset of PRESETS) {
      const level = preset.build();
      const baker = new TerrainBaker(level);
      const group = buildProps(level, baker.field);

      let instances = 0;
      let plainMeshes = 0;
      for (const child of group.children) {
        const asInstanced = child as unknown as { isInstancedMesh?: boolean; count?: number };
        if (asInstanced.isInstancedMesh) instances += asInstanced.count ?? 0;
        else plainMeshes += 1;
      }

      // Gates and fire pits are the only things allowed to stay one-off.
      expect(group.children.length).toBeLessThan(120);
      expect(instances).toBeGreaterThan(plainMeshes);
    }
  });

  it('places every scattered tree somewhere real', () => {
    const level = PRESETS[0].build();
    const baker = new TerrainBaker(level);
    const group = buildProps(level, baker.field);
    for (const child of group.children) {
      const instanced = child as unknown as {
        isInstancedMesh?: boolean;
        instanceMatrix?: { array: Float32Array };
      };
      if (!instanced.isInstancedMesh || !instanced.instanceMatrix) continue;
      // One NaN makes the whole batch vanish rather than just one tree, so it
      // is worth checking the raw buffer rather than trusting the maths.
      for (const v of instanced.instanceMatrix.array) expect(Number.isFinite(v)).toBe(true);
    }
  });
});
