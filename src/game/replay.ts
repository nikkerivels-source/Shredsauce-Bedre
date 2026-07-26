import { Quat, Vec3, clamp01 } from '../core/math.ts';
import type { RiderSim } from '../physics/riderSim.ts';
import type { GrabId } from '../physics/grabs.ts';

/**
 * A single recorded instant.
 *
 * Poses are recorded rather than inputs. Replaying inputs would be smaller, but
 * it only reproduces the run if the simulation is bit-identical, and a physics
 * tweak would silently break every saved replay and every ghost. Storing the
 * result keeps replays valid forever.
 */
export interface ReplayFrame {
  t: number;
  px: number;
  py: number;
  pz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  /** Leg extension, so the recorded stance depth is right. */
  leg: number;
  angulation: number;
  hip: number;
  grab: GrabId | null;
  twist: number;
  tuck: number;
  limp: boolean;
}

export interface ReplayMeta {
  levelId: string;
  levelName: string;
  gearId: string;
  goofy: boolean;
  score: number;
  duration: number;
  recordedAt: number;
  label: string;
}

export interface Replay {
  meta: ReplayMeta;
  frames: ReplayFrame[];
}

const RECORD_HZ = 30;

/** Captures a run at a fixed rate, keeping the last `seconds` of it. */
export class ReplayRecorder {
  readonly frames: ReplayFrame[] = [];
  private accumulator = 0;
  private elapsed = 0;
  private readonly window: number;

  constructor(seconds = 90) {
    this.window = seconds;
  }

  reset(): void {
    this.frames.length = 0;
    this.accumulator = 0;
    this.elapsed = 0;
  }

  capture(
    dt: number,
    sim: RiderSim,
    extras: { grab: GrabId | null; twist: number; tuck: number; limp: boolean },
  ): void {
    this.elapsed += dt;
    this.accumulator += dt;
    const step = 1 / RECORD_HZ;
    if (this.accumulator < step) return;
    this.accumulator = 0;

    this.frames.push({
      t: this.elapsed,
      px: sim.position.x,
      py: sim.position.y,
      pz: sim.position.z,
      qx: sim.orientation.x,
      qy: sim.orientation.y,
      qz: sim.orientation.z,
      qw: sim.orientation.w,
      leg: sim.legLength,
      angulation: sim.angulation,
      hip: sim.hipShift,
      grab: extras.grab,
      twist: extras.twist,
      tuck: extras.tuck,
      limp: extras.limp,
    });

    // Roll the window so a long free-ride session does not grow without bound.
    const cutoff = this.elapsed - this.window;
    while (this.frames.length > 2 && this.frames[0].t < cutoff) this.frames.shift();
  }

  finish(meta: Omit<ReplayMeta, 'duration' | 'recordedAt'>): Replay {
    const first = this.frames[0]?.t ?? 0;
    return {
      meta: {
        ...meta,
        duration: this.elapsed - first,
        recordedAt: Date.now(),
      },
      // Rebase so playback starts at zero.
      frames: this.frames.map((f) => ({ ...f, t: f.t - first })),
    };
  }
}

export interface ReplaySample {
  position: Vec3;
  orientation: Quat;
  legLength: number;
  angulation: number;
  hipShift: number;
  grab: GrabId | null;
  twist: number;
  tuck: number;
  limp: boolean;
}

export function makeReplaySample(): ReplaySample {
  return {
    position: new Vec3(),
    orientation: new Quat(),
    legLength: 0.9,
    angulation: 0,
    hipShift: 0,
    grab: null,
    twist: 0,
    tuck: 0,
    limp: false,
  };
}

/** Plays a replay back, interpolating between recorded frames. */
export class ReplayPlayer {
  replay: Replay;
  time = 0;
  speed = 1;
  playing = true;
  private index = 0;

  constructor(replay: Replay) {
    this.replay = replay;
  }

  get duration(): number {
    return this.replay.frames.at(-1)?.t ?? 0;
  }

  seek(t: number): void {
    this.time = Math.max(0, Math.min(this.duration, t));
    this.index = 0;
  }

  update(dt: number): void {
    if (!this.playing) return;
    this.time += dt * this.speed;
    if (this.time > this.duration) this.time = 0;
    if (this.time < 0) this.time = this.duration;
  }

  sample(out: ReplaySample): ReplaySample {
    const frames = this.replay.frames;
    if (frames.length === 0) return out;
    if (frames.length === 1) return applyFrame(frames[0], out);

    // Frames arrive in order, so scanning from the last index is O(1) in the
    // common case and still correct after a seek.
    if (frames[this.index].t > this.time) this.index = 0;
    while (this.index < frames.length - 2 && frames[this.index + 1].t <= this.time) this.index++;

    const a = frames[this.index];
    const b = frames[this.index + 1];
    const span = b.t - a.t;
    const alpha = span > 1e-6 ? clamp01((this.time - a.t) / span) : 0;

    out.position.set(
      a.px + (b.px - a.px) * alpha,
      a.py + (b.py - a.py) * alpha,
      a.pz + (b.pz - a.pz) * alpha,
    );
    out.orientation.set(a.qx, a.qy, a.qz, a.qw);
    _target.set(b.qx, b.qy, b.qz, b.qw);
    out.orientation.slerp(_target, alpha);
    out.legLength = a.leg + (b.leg - a.leg) * alpha;
    out.angulation = a.angulation + (b.angulation - a.angulation) * alpha;
    out.hipShift = a.hip + (b.hip - a.hip) * alpha;
    out.grab = a.grab;
    out.twist = a.twist + (b.twist - a.twist) * alpha;
    out.tuck = a.tuck + (b.tuck - a.tuck) * alpha;
    out.limp = a.limp;
    return out;
  }
}

function applyFrame(f: ReplayFrame, out: ReplaySample): ReplaySample {
  out.position.set(f.px, f.py, f.pz);
  out.orientation.set(f.qx, f.qy, f.qz, f.qw);
  out.legLength = f.leg;
  out.angulation = f.angulation;
  out.hipShift = f.hip;
  out.grab = f.grab;
  out.twist = f.twist;
  out.tuck = f.tuck;
  out.limp = f.limp;
  return out;
}

const _target = new Quat();

const REPLAY_KEY = 'powderline.replays.v1';

export function loadReplays(): Replay[] {
  try {
    const raw = localStorage.getItem(REPLAY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Replay[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveReplay(replay: Replay, keep = 12): Replay[] {
  const all = loadReplays();
  all.unshift(replay);
  const trimmed = all.slice(0, keep);
  try {
    localStorage.setItem(REPLAY_KEY, JSON.stringify(trimmed));
  } catch {
    // Replays are large; drop the oldest and try once more before giving up.
    try {
      localStorage.setItem(REPLAY_KEY, JSON.stringify(trimmed.slice(0, 3)));
    } catch {
      /* out of space */
    }
  }
  return trimmed;
}

export function deleteReplay(recordedAt: number): Replay[] {
  const remaining = loadReplays().filter((r) => r.meta.recordedAt !== recordedAt);
  try {
    localStorage.setItem(REPLAY_KEY, JSON.stringify(remaining));
  } catch {
    /* ignore */
  }
  return remaining;
}
