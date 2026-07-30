/**
 * Render bench.
 *
 * A visual change is worth exactly as much as the pair of images that shows it,
 * and a performance claim is worth exactly as much as the number behind it. Both
 * need the same scene twice, which the game itself cannot give you: the camera
 * chases a rider who is already moving, the clock runs, and no two runs frame
 * the same pixels.
 *
 * So this page builds the real renderer — the same `WorldView`, the same level
 * builders, the same materials — and then nails everything else down. Fixed
 * level, fixed weather, fixed time of day, fixed camera, rider frozen in a
 * standing pose. Two builds of the same scene differ only by the code under
 * test.
 *
 * It is a development tool. It is not part of the game build and nothing in
 * `src/` imports it.
 *
 *   ?preset=low|medium|high   quality preset            (default high)
 *   ?level=<preset id>        stock level               (default superpark)
 *   ?view=<name>              camera, see VIEWS         (default gate)
 *   ?tod=<hours>              time of day               (default 12)
 *   ?weather=clear|overcast|snow|dawn|dusk
 *   ?frames=<n>               frames to time            (default 240)
 *   ?w=<px>&h=<px>            render size               (default 1920x1080)
 *
 * `window.benchReady` resolves with the timing report once the run is done.
 */

import * as THREE from 'three';
import { WorldView, qualityPreset } from '../src/render/renderer.ts';
import { defaultAppearance } from '../src/render/rider.ts';
import { buildPreset, PRESETS } from '../src/game/levels.ts';
import { InputManager, defaultInputSettings } from '../src/game/input.ts';
import { kicker } from '../src/game/design.ts';
import { TerrainBaker, kickerGeometry } from '../src/world/terrain.ts';
import { buildGrindSurfaces } from '../src/physics/rails.ts';
import { RiderSim, defaultTuning, neutralInput } from '../src/physics/riderSim.ts';
import { getGear } from '../src/physics/gear.ts';
import { makePose, poseFromRider } from '../src/physics/ragdoll.ts';
import { emptyLevel } from '../src/world/level.ts';
import type { LevelDef } from '../src/world/level.ts';

export interface BenchReport {
  level: string;
  preset: string;
  view: string;
  width: number;
  height: number;
  pixelRatio: number;
  frames: number;
  /** Median frame time over the timed window, milliseconds. */
  median: number;
  /** 95th percentile frame time, milliseconds. */
  p95: number;
  min: number;
  max: number;
  triangles: number;
  drawCalls: number;
  programs: number;
}

declare global {
  interface Window {
    benchReady?: Promise<BenchReport>;
  }
}

const params = new URLSearchParams(location.search);
const presetName = (params.get('preset') ?? 'high') as 'low' | 'medium' | 'high';
const levelId = params.get('level') ?? 'superpark';
const viewName = params.get('view') ?? 'gate';
const frames = Number(params.get('frames') ?? 240);
const width = Number(params.get('w') ?? 1920);
const height = Number(params.get('h') ?? 1080);

/**
 * Weather presets.
 *
 * Named rather than free-form because §6 wants the *same* conditions in a
 * before and an after, and "overcast" is easier to reproduce from a commit
 * message than six numbers.
 */
const WEATHER: Record<string, { timeOfDay: number; cloud: number; snowfall: number; wind: number; fog: number }> = {
  // Exactly `defaultWeather()`. Kept in step with it by hand so a shot can be
  // taken of the conditions the game actually ships in, rather than of a
  // near-miss that happens to hide or exaggerate whatever is being judged.
  bluebird: { timeOfDay: 12, cloud: 0.02, snowfall: 0, wind: 1, fog: 0.02 },
  clear: { timeOfDay: 12, cloud: 0.05, snowfall: 0, wind: 1, fog: 0.08 },
  overcast: { timeOfDay: 12, cloud: 0.85, snowfall: 0, wind: 3, fog: 0.45 },
  snow: { timeOfDay: 12, cloud: 0.7, snowfall: 0.8, wind: 6, fog: 0.5 },
  dawn: { timeOfDay: 6.6, cloud: 0.2, snowfall: 0, wind: 1, fog: 0.22 },
  dusk: { timeOfDay: 18.4, cloud: 0.25, snowfall: 0, wind: 2, fog: 0.25 },
};

/**
 * Cameras, in metres relative to the rider standing at the spawn.
 *
 * `eye` and `look` are offsets along (across-slope, up, down-slope) from the
 * rider, and the up component is measured from the terrain under that point
 * rather than from the rider's own height. On a 1.7 km run the ground 150 m
 * downhill is tens of metres lower than the gate, so an offset from the rider
 * aims a "look slightly up" straight into empty sky.
 */
const VIEWS: Record<string, { eye: [number, number, number]; look: [number, number, number]; fov: number }> = {
  // The §5 measurement scene: rider's eye at the start gate, looking down the run.
  gate: { eye: [0, 2.4, -7], look: [0, 1.2, 26], fov: 68 },
  // Worst case for aliasing: a stand of dark pines edge-on against open snow,
  // close enough that a 4x crop lands on a real silhouette rather than on a
  // two-pixel smudge in the distance.
  treeline: { eye: [0, 3.4, 40], look: [-72, 7, 150], fov: 20 },
  // The rider at 3 m, filling the frame, for mesh and self-shadow work.
  rider: { eye: [2.3, 1.5, -1.9], look: [0, 1.05, 0], fov: 40 },
  // Straight down, for placement and density.
  aerial: { eye: [0, 210, 190], look: [0, 0, 190], fov: 55 },
  // Low and wide down the fall line, for fog, backdrop and grading.
  vista: { eye: [0, 14, -18], look: [0, 2, 220], fov: 55 },
};

function applyWeather(level: LevelDef, name: string): void {
  const w = WEATHER[name] ?? WEATHER.clear;
  level.weather.timeOfDay = Number(params.get('tod') ?? w.timeOfDay);
  level.weather.cloud = w.cloud;
  level.weather.snowfall = w.snowfall;
  level.weather.wind = w.wind;
  level.weather.fog = w.fog;
  level.weather.windDirection = 20;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[i];
}

async function run(): Promise<BenchReport> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const known = PRESETS.find((p) => p.id === levelId);
  if (!known) throw new Error(`unknown level "${levelId}" — have ${PRESETS.map((p) => p.id).join(', ')}`);

  const level = buildPreset(known.id);
  applyWeather(level, params.get('weather') ?? 'clear');

  const baker = new TerrainBaker(level);
  const field = baker.field;
  const grinds = buildGrindSurfaces(level, field);

  const quality = qualityPreset(presetName);
  const view = new WorldView(canvas, field, quality);
  view.resize(width, height);
  view.loadLevel(level, field, grinds);

  // The rider stands at the gate and is then frozen.
  //
  // The sim has to run first. Straight out of `reset` the contact solver has not
  // yet found the snow, the leg spring is at its rest length and the pose comes
  // out with limbs stretched between joints that are not where a standing body
  // puts them — which draws as a wedge across half the frame. Half a second of
  // simulation settles it; after that nothing moves again, on any run.
  const gear = getGear(level.discipline === 'skis' ? 'twin-172' : 'park-155');
  const look = defaultAppearance();
  const jacket = params.get('jacket');
  if (jacket) look.jacket = jacket;
  view.setRider(gear, look);
  const sim = new RiderSim(field, level, grinds, gear, defaultTuning());
  sim.reset(level.spawn.x, level.spawn.z, level.spawn.heading);
  const still = neutralInput();
  for (let i = 0; i < 120; i++) sim.step(1 / 240, still);
  const pose = makePose();
  poseFromRider(sim, pose, { grab: null, twist: 0, tuck: 0, goofy: false });
  view.updateRider(0, pose, sim.telemetry, [], sim.velocity);

  // Fixed camera, anchored to where the rider actually ended up rather than to
  // the spawn, so the framing does not drift when the settle changes.
  const shot = VIEWS[viewName] ?? VIEWS.gate;
  const base = new THREE.Vector3(sim.position.x, field.heightAt(sim.position.x, sim.position.z), sim.position.z);
  const camera = view.camera;
  camera.fov = shot.fov;
  camera.near = 0.12;
  camera.far = 2600;
  const eyeX = base.x + shot.eye[0];
  const eyeZ = base.z + shot.eye[2];
  const lookX = base.x + shot.look[0];
  const lookZ = base.z + shot.look[2];
  camera.position.set(eyeX, field.heightAt(eyeX, eyeZ) + shot.eye[1], eyeZ);
  camera.lookAt(lookX, field.heightAt(lookX, lookZ) + shot.look[1], lookZ);
  camera.updateProjectionMatrix();

  // Warm up: shader compiles and the first upload of every texture land here,
  // not in the timed window.
  //
  // `autoReset` goes off first. One frame can be more than one `render` call —
  // the scene into a target, then a fullscreen pass to the canvas — and with the
  // counters clearing per call the report would describe only the last of them,
  // which is a single triangle covering the screen.
  const info = view.renderer.info;
  info.autoReset = false;
  for (let i = 0; i < 30; i++) {
    view.render(1 / 60);
    await new Promise((r) => requestAnimationFrame(r));
  }

  info.reset();
  view.render(1 / 60);
  const triangles = info.render.triangles;
  const drawCalls = info.render.calls;

  // Timing.
  //
  // Per-render `performance.now()` deltas are worthless here: the WebGL calls
  // cross a process boundary into the GPU process and return long before any
  // pixel exists, so a scene that takes 40 ms to rasterise times as 1.5 ms. The
  // only honest measure available without a timer-query extension is throughput
  // — submit a batch back to back, block on `finish()` once at the end, and
  // divide. Several batches give a spread rather than a single number.
  const batch = 12;
  const batches = Math.max(4, Math.round(frames / batch));
  const samples: number[] = [];
  const gl = view.renderer.getContext();
  for (let b = 0; b < batches; b++) {
    const t0 = performance.now();
    for (let i = 0; i < batch; i++) view.render(1 / 60);
    gl.finish();
    samples.push((performance.now() - t0) / batch);
    await new Promise((r) => requestAnimationFrame(r));
  }

  const sorted = [...samples].sort((a, b) => a - b);
  return {
    level: levelId,
    preset: presetName,
    view: viewName,
    width,
    height,
    pixelRatio: view.renderer.getPixelRatio(),
    frames: batch * batches,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    triangles,
    drawCalls,
    programs: info.programs?.length ?? 0,
  };
}

/**
 * Rider-only capture: the same 540, frame by frame, with the world hidden.
 *
 * Judging whether a rider moves means watching the rider and nothing else. With
 * terrain and sky in shot the eye reads the scene going past and fills in motion
 * that is not there, which is exactly how a welded-on pair of arms survives
 * review. Hide everything, lock the camera to the body, and the only thing left
 * changing between frames is the pose.
 */
async function runSpin(): Promise<BenchReport> {
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const level = emptyLevel('spin');
  level.seed = 20260728;
  level.terrain.slopeAngle = 14;
  level.terrain.length = 380;
  level.terrain.width = 170;
  level.terrain.roughness = 0;
  level.terrain.banking = 0;
  level.terrain.resolution = 0.5;
  level.snow.hardness = 0.7;
  level.snow.groomed = true;
  level.spawn = { x: 0, z: 16, heading: 0 };
  const kickerZ = 75;
  level.features.push(kicker(0, kickerZ, 6, { width: 20, lipAngle: 30, landingLength: 120, landingAngle: 30 }));
  const lipZ = kickerZ + kickerGeometry(level.features[0] as Extract<(typeof level.features)[number], { kind: 'kicker' }>).rampLength;

  const baker = new TerrainBaker(level);
  const field = baker.field;
  const grinds = buildGrindSurfaces(level, field);
  const quality = qualityPreset(presetName);
  const view = new WorldView(canvas, field, quality);
  view.resize(width, height);
  view.loadLevel(level, field, grinds);
  const gear = getGear('park-155');
  view.setRider(gear, defaultAppearance());

  // Everything except the rider goes. Fog too, or the empty scene is a wall of
  // haze rather than a clean silhouette.
  view.scene.background = new THREE.Color(0x11151c);
  view.scene.fog = null;
  for (const child of [...view.scene.children]) {
    const keep = child.type === 'Group' && child.children.some((c) => c.name === 'riderRoot');
    if (!keep && child.type !== 'DirectionalLight' && child.type !== 'HemisphereLight' && child.type !== 'Group') {
      child.visible = false;
    }
  }

  const sim = new RiderSim(field, level, grinds, gear, defaultTuning());
  const input = new InputManager(canvas, gear.discipline, { ...defaultInputSettings(gear.discipline) });
  const pose = makePose();
  const dt = 1 / 120;
  const camera = view.camera;
  camera.fov = 38;
  camera.near = 0.05;
  camera.far = 200;
  camera.updateProjectionMatrix();

  const key = (type: string, code: string) => {
    const e = new Event(type, { cancelable: true });
    Object.defineProperty(e, 'code', { value: code });
    Object.defineProperty(e, 'repeat', { value: false });
    window.dispatchEvent(e);
  };

  const frames: string[] = [];
  let crouching = false;
  let jumped = false;
  let wasAir = false;
  let airFrame = 0;
  for (let s = 0; s < 120 * 25 && frames.length < 12; s++) {
    const airborne = sim.telemetry.airborne;
    const z = sim.position.z;
    const wantCrouch = !jumped && z < lipZ - 3;
    if (wantCrouch !== crouching) {
      key(wantCrouch ? 'keydown' : 'keyup', 'Space');
      crouching = wantCrouch;
    }
    if (airborne && !wasAir && z > kickerZ) {
      jumped = true;
      key('keydown', 'ArrowRight');
    }
    wasAir = airborne;
    const rider = input.update(dt, airborne);
    sim.step(dt, rider);
    const drained: SimEvent[] = [];
    sim.drainEvents(drained);
    poseFromRider(sim, pose, { grab: null, twist: rider.twist, tuck: rider.tuck, goofy: false, dt });
    view.updateRider(dt, pose, sim.telemetry, [], sim.velocity);

    if (jumped && airborne) {
      // Twelve frames spread across the air, shot from a camera that orbits
      // with the body so the rotation itself does not do the work.
      if (airFrame % 18 === 0) {
        const p = sim.position;
        camera.position.set(p.x + 2.6, p.y + 0.35, p.z - 2.6);
        camera.lookAt(p.x, p.y, p.z);
        view.render(dt);
        frames.push(canvas.toDataURL('image/png'));
      }
      airFrame++;
    }
  }
  input.dispose();
  (window as unknown as { benchFrames?: string[] }).benchFrames = frames;
  return {
    level: 'spin',
    preset: presetName,
    view: 'spin',
    width,
    height,
    pixelRatio: view.renderer.getPixelRatio(),
    frames: frames.length,
    median: 0,
    p95: 0,
    min: 0,
    max: 0,
    triangles: 0,
    drawCalls: 0,
    programs: 0,
  };
}

window.benchReady = viewName === 'spin' ? runSpin() : run();
