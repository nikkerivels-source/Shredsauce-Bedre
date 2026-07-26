import { Vec3, clamp01 } from '../core/math.ts';
import { TerrainBaker } from '../world/terrain.ts';
import type { Heightfield } from '../world/heightfield.ts';
import type { GateFeature, LevelDef } from '../world/level.ts';
import { buildGrindSurfaces, type GrindSurface } from '../physics/rails.ts';
import { RiderSim, defaultTuning, neutralInput, type RiderInput, type SimEvent } from '../physics/riderSim.ts';
import { Ragdoll, makePose, poseFromRider, type RiderPose } from '../physics/ragdoll.ts';
import { getGear, type GearSpec } from '../physics/gear.ts';
import { TrickTracker, type TrickResult } from './tricks.ts';
import { ReplayRecorder } from './replay.ts';
import type { Profile } from './storage.ts';

export type GameMode = 'freeride' | 'jam' | 'timeAttack' | 'challenge';

export const MODE_LABELS: Record<GameMode, string> = {
  freeride: 'Free ride',
  jam: 'Jam session',
  timeAttack: 'Time attack',
  challenge: 'Challenge',
};

export interface Challenge {
  id: string;
  name: string;
  description: string;
  reward: number;
  /** Returns true once the run satisfies it. */
  test(state: SessionSummary): boolean;
}

export interface SessionSummary {
  score: number;
  bestCombo: number;
  tricks: TrickResult[];
  bails: number;
  topSpeed: number;
  biggestAir: number;
  longestGrind: number;
  distance: number;
  elapsed: number;
  gatesHit: number;
  gatesTotal: number;
  finished: boolean;
  finishTime: number;
}

export const CHALLENGES: Challenge[] = [
  {
    id: 'first-180',
    name: 'Get sideways',
    description: 'Land a 180 or bigger.',
    reward: 150,
    test: (s) => s.tricks.some((t) => t.landed && t.spin >= 180),
  },
  {
    id: 'grab-it',
    name: 'Hold on',
    description: 'Land a jump with a grab.',
    reward: 200,
    test: (s) => s.tricks.some((t) => t.landed && t.breakdown.grab > 0),
  },
  {
    id: 'rail-10',
    name: 'Ten metre slide',
    description: 'Grind a single feature for 10 metres.',
    reward: 250,
    test: (s) => s.longestGrind >= 10,
  },
  {
    id: 'combo-3',
    name: 'Link it up',
    description: 'Reach a 3x combo multiplier.',
    reward: 300,
    test: (s) => s.bestCombo >= 3,
  },
  {
    id: 'air-4',
    name: 'Send it',
    description: 'Get four metres off the snow.',
    reward: 350,
    test: (s) => s.biggestAir >= 4,
  },
  {
    id: 'speed-90',
    name: 'Terminal velocity',
    description: 'Hit 90 km/h.',
    reward: 300,
    test: (s) => s.topSpeed >= 25,
  },
  {
    id: 'cork-it',
    name: 'Off axis',
    description: 'Land an inverted trick.',
    reward: 500,
    test: (s) => s.tricks.some((t) => t.landed && t.inversions > 0),
  },
  {
    id: 'score-10k',
    name: 'Ten thousand',
    description: 'Score 10,000 points in a single run.',
    reward: 750,
    test: (s) => s.score >= 10000,
  },
  {
    id: 'clean-run',
    name: 'Clean lap',
    description: 'Land five tricks in a row without bailing.',
    reward: 600,
    test: (s) => s.bails === 0 && s.tricks.filter((t) => t.landed).length >= 5,
  },
];

export interface SessionEvent {
  type: 'trick' | 'gate' | 'finish' | 'timeUp' | 'challenge';
  trick?: TrickResult;
  challenge?: Challenge;
  gateIndex?: number;
  message?: string;
}

/**
 * One run on one mountain.
 *
 * Owns the terrain bake, the simulation, trick tracking and mode rules, and
 * exposes a pose plus a summary. The app layer renders it; nothing in here
 * touches the DOM or three.js, which is what lets the same class drive the
 * headless tests.
 */
export class Session {
  level: LevelDef;
  baker: TerrainBaker;
  grindSurfaces: GrindSurface[];
  sim: RiderSim;
  tricks: TrickTracker;
  readonly pose: RiderPose = makePose();
  readonly ragdoll = new Ragdoll();
  recorder = new ReplayRecorder();
  mode: GameMode = 'freeride';
  gear: GearSpec;
  profile: Profile;

  /** Seconds remaining in timed modes; Infinity in free ride. */
  timeRemaining = Infinity;
  elapsed = 0;
  paused = false;
  readonly events: SessionEvent[] = [];
  activeChallenges: Challenge[] = [];

  private summaryState: SessionSummary = blankSummary();
  private simEvents: SimEvent[] = [];
  private gates: GateFeature[] = [];
  private nextGate = 0;
  private startZ = 0;
  private lastInput: RiderInput = neutralInput();
  private wasLimp = false;

  constructor(level: LevelDef, profile: Profile) {
    this.level = level;
    this.profile = profile;
    this.gear = getGear(profile.discipline === 'skis' ? profile.skiId : profile.boardId);
    this.baker = new TerrainBaker(level);
    this.grindSurfaces = buildGrindSurfaces(level, this.baker.field);
    const tuning = defaultTuning();
    tuning.assist = profile.assist;
    this.sim = new RiderSim(this.baker.field, level, this.grindSurfaces, this.gear, tuning);
    this.sim.riderMass = profile.riderMass;
    this.tricks = new TrickTracker({ discipline: this.gear.discipline, goofy: profile.goofy });
    this.collectGates();
    this.startZ = level.spawn.z;
  }

  get field(): Heightfield {
    return this.baker.field;
  }

  get summary(): SessionSummary {
    return this.summaryState;
  }

  /** Swaps in a new level, reusing the sim so settings survive. */
  loadLevel(level: LevelDef): void {
    this.level = level;
    this.baker = new TerrainBaker(level);
    this.grindSurfaces = buildGrindSurfaces(level, this.baker.field);
    this.sim = new RiderSim(this.baker.field, level, this.grindSurfaces, this.gear, this.sim.tuning);
    this.sim.riderMass = this.profile.riderMass;
    this.collectGates();
    this.startZ = level.spawn.z;
    this.restart(this.mode);
  }

  /** Re-bakes terrain after an edit without discarding the run. */
  rebake(): void {
    this.baker.bakeAll();
    this.rebakeGrindsOnly();
    this.collectGates();
  }

  /**
   * Rebuilds only the grind geometry. Rails sit a fixed height above the snow,
   * so any terrain edit under one moves it — but a partial terrain re-bake does
   * not need the whole mountain rebuilt to fix that.
   */
  rebakeGrindsOnly(): void {
    this.grindSurfaces = buildGrindSurfaces(this.level, this.baker.field);
    this.sim.setGrindSurfaces(this.grindSurfaces);
  }

  setGear(gear: GearSpec): void {
    this.gear = gear;
    this.sim.gear = gear;
    this.tricks.options = { discipline: gear.discipline, goofy: this.profile.goofy };
  }

  setAssist(assist: number): void {
    this.sim.tuning.assist = clamp01(assist);
  }

  restart(mode: GameMode = this.mode): void {
    this.mode = mode;
    this.sim.reset(this.level.spawn.x, this.level.spawn.z, this.level.spawn.heading);
    this.tricks.reset();
    this.recorder.reset();
    this.ragdoll.active = false;
    this.summaryState = blankSummary();
    this.summaryState.gatesTotal = this.gates.length;
    this.elapsed = 0;
    this.nextGate = 0;
    this.events.length = 0;
    this.wasLimp = false;
    this.timeRemaining = mode === 'jam' ? 150 : mode === 'timeAttack' ? 300 : Infinity;
    this.activeChallenges =
      mode === 'challenge' ? CHALLENGES.filter((c) => !this.profile.completed.includes(c.id)).slice(0, 3) : [];
  }

  update(dt: number, input: RiderInput): void {
    if (this.paused) return;
    this.lastInput = input;
    this.elapsed += dt;

    this.sim.step(dt, input);
    this.simEvents.length = 0;
    this.sim.drainEvents(this.simEvents);

    this.tricks.update(dt, this.sim, input, this.simEvents);
    this.updatePose(dt, input);
    this.updateSummary(dt);
    this.handleSimEvents();
    this.updateGates();
    this.updateTimers(dt);

    this.recorder.capture(dt, this.sim, {
      grab: input.grab,
      twist: input.twist,
      tuck: input.tuck,
      limp: this.pose.limp,
    });
  }

  /** Chooses between the live rider pose and the ragdoll. */
  private updatePose(dt: number, input: RiderInput): void {
    const bailed = this.sim.state === 'bailed';
    if (bailed && !this.ragdoll.active) {
      // Seed the ragdoll from the pose the rider was in the instant they lost it.
      poseFromRider(this.sim, this.pose, {
        grab: input.grab,
        twist: input.twist,
        tuck: input.tuck,
        goofy: this.profile.goofy,
      });
      this.ragdoll.seed(this.pose, this.sim.velocity, this.sim.angularVelocity, this.sim.position, dt);
    }
    if (!bailed && this.ragdoll.active) this.ragdoll.active = false;

    if (this.ragdoll.active) {
      this.ragdoll.step(dt, this.field, this.sim.tuning.gravity);
      this.ragdoll.writePose(this.pose);
    } else {
      poseFromRider(this.sim, this.pose, {
        grab: input.grab,
        twist: input.twist,
        tuck: input.tuck,
        goofy: this.profile.goofy,
      });
    }
    this.wasLimp = this.pose.limp;
  }

  private updateSummary(dt: number): void {
    const s = this.summaryState;
    const t = this.sim.telemetry;
    s.score = this.tricks.runScore;
    s.bestCombo = this.tricks.bestCombo;
    s.tricks = this.tricks.history;
    s.topSpeed = Math.max(s.topSpeed, t.speed);
    s.biggestAir = Math.max(s.biggestAir, t.altitude);
    s.longestGrind = Math.max(s.longestGrind, t.grindDistance);
    s.distance = Math.max(0, this.sim.position.z - this.startZ);
    s.elapsed = this.elapsed;
    void dt;
  }

  private handleSimEvents(): void {
    for (const e of this.simEvents) {
      if (e.type === 'bail') this.summaryState.bails++;
    }
    // Trick results arrive through the tracker's history, so pick up anything
    // new since the last frame and surface it.
    const history = this.tricks.history;
    while (this.emittedTricks < history.length) {
      const trick = history[this.emittedTricks++];
      this.events.push({ type: 'trick', trick });
    }
    if (this.mode === 'challenge') this.checkChallenges();
  }

  private emittedTricks = 0;

  private checkChallenges(): void {
    for (const challenge of [...this.activeChallenges]) {
      if (!challenge.test(this.summaryState)) continue;
      this.activeChallenges = this.activeChallenges.filter((c) => c.id !== challenge.id);
      if (!this.profile.completed.includes(challenge.id)) {
        this.profile.completed.push(challenge.id);
        this.profile.credits += challenge.reward;
        this.profile.xp += challenge.reward;
      }
      this.events.push({ type: 'challenge', challenge, message: `${challenge.name} complete` });
    }
  }

  private collectGates(): void {
    this.gates = this.level.features
      .filter((f): f is GateFeature => f.kind === 'gate')
      .sort((a, b) => a.order - b.order || a.z - b.z);
    this.summaryState.gatesTotal = this.gates.length;
  }

  private updateGates(): void {
    if (this.gates.length === 0 || this.nextGate >= this.gates.length) return;
    const gate = this.gates[this.nextGate];
    // Count it once the rider crosses the gate's line anywhere within its width.
    if (this.sim.position.z >= gate.z && Math.abs(this.sim.position.x - gate.x) <= gate.width) {
      this.nextGate++;
      this.summaryState.gatesHit++;
      this.events.push({ type: 'gate', gateIndex: this.nextGate });
    } else if (this.sim.position.z > gate.z + 8) {
      // Missed it entirely — skip ahead so one blown gate does not stall the run.
      this.nextGate++;
    }
  }

  private updateTimers(dt: number): void {
    const atBottom = this.sim.position.z >= this.field.maxZ - 12;
    if (!this.summaryState.finished && atBottom) {
      this.summaryState.finished = true;
      this.summaryState.finishTime = this.elapsed;
      this.events.push({ type: 'finish', message: 'Run complete' });
    }

    if (this.timeRemaining === Infinity) return;
    this.timeRemaining -= dt;
    if (this.timeRemaining <= 0) {
      this.timeRemaining = 0;
      this.events.push({ type: 'timeUp', message: "Time's up" });
      this.paused = true;
    }
  }

  drainEvents(sink: SessionEvent[]): void {
    for (const e of this.events) sink.push(e);
    this.events.length = 0;
  }

  get lastRiderInput(): RiderInput {
    return this.lastInput;
  }

  get isLimp(): boolean {
    return this.wasLimp;
  }

  /** Board centre, for effects that need it without re-querying the sim. */
  getBoardCenter(out: Vec3): Vec3 {
    return this.sim.getBoardCenter(out);
  }
}

function blankSummary(): SessionSummary {
  return {
    score: 0,
    bestCombo: 1,
    tricks: [],
    bails: 0,
    topSpeed: 0,
    biggestAir: 0,
    longestGrind: 0,
    distance: 0,
    elapsed: 0,
    gatesHit: 0,
    gatesTotal: 0,
    finished: false,
    finishTime: 0,
  };
}
