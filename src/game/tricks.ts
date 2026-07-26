import { RAD, Vec3, clamp01, angleBetween } from '../core/math.ts';
import { getGrab, type GrabId } from '../physics/grabs.ts';
import type { RiderInput, RiderSim, SimEvent } from '../physics/riderSim.ts';
import type { Discipline } from '../physics/gear.ts';

export interface TrickBreakdown {
  rotation: number;
  flip: number;
  grab: number;
  air: number;
  grind: number;
}

export interface TrickResult {
  /** Full spoken name, e.g. "cab 900 double cork mute". */
  name: string;
  points: number;
  breakdown: TrickBreakdown;
  /** Landing quality, 0-1. Zero means it was not landed. */
  quality: number;
  landed: boolean;
  /** Combo multiplier that was applied. */
  multiplier: number;
  /** Degrees of rotation about the vertical axis. */
  spin: number;
  inversions: number;
  airTime: number;
  height: number;
  /** Set when the rider ate it. */
  bailReason?: string;
  time: number;
}

export interface TrickOptions {
  discipline: Discipline;
  /** Right foot forward. Flips which hand is the lead hand and spin naming. */
  goofy: boolean;
}

const WORLD_UP = new Vec3(0, 1, 0);

interface AirSegment {
  startTime: number;
  takeoffSwitch: boolean;
  /** Signed rotation about world up, radians. */
  spin: number;
  /** Signed rotation about the takeoff-relative lateral axis, radians. */
  flip: number;
  inversions: number;
  wasInverted: boolean;
  /** Accumulated rotation axis, for judging how far off-axis the trick is. */
  axis: Vec3;
  axisWeight: number;
  maxHeight: number;
  grabHold: Map<GrabId, number>;
  grabOrder: GrabId[];
  takeoffSpeed: number;
}

interface GrindSegment {
  startTime: number;
  surfaceId: string;
  /** Board yaw relative to the rail at entry, degrees, -180..180. */
  entryYaw: number;
  meanYaw: number;
  pressTime: number;
  pressSign: number;
  duration: number;
  distance: number;
}

/**
 * Watches the simulation and turns it into named, scored tricks.
 *
 * Nothing here is scripted: rotation is integrated from the body's actual
 * angular velocity, inversions are counted from which way is up, and grabs are
 * whatever the player was holding. The naming is the standard vocabulary and is
 * as faithful as a rule set can be — real riders disagree about edge cases like
 * where a rodeo stops and a misty starts, and this picks one consistent reading.
 */
export class TrickTracker {
  options: TrickOptions;
  /** Tricks completed this run, newest last. */
  readonly history: TrickResult[] = [];
  /** Fires for each completed trick so the HUD and audio can react. */
  onTrick: ((result: TrickResult) => void) | null = null;

  combo = 1;
  comboTimer = 0;
  runScore = 0;
  bestCombo = 1;

  private air: AirSegment | null = null;
  private grind: GrindSegment | null = null;
  private readonly up = new Vec3();
  private readonly right = new Vec3();
  private readonly fwd = new Vec3();
  private readonly tmp = new Vec3();

  constructor(options: TrickOptions) {
    this.options = options;
  }

  reset(): void {
    this.history.length = 0;
    this.air = null;
    this.grind = null;
    this.combo = 1;
    this.comboTimer = 0;
    this.runScore = 0;
    this.bestCombo = 1;
  }

  update(dt: number, sim: RiderSim, input: RiderInput, events: readonly SimEvent[]): void {
    sim.getBodyAxes(this.right, this.up, this.fwd);

    if (this.comboTimer > 0) {
      this.comboTimer -= dt;
      if (this.comboTimer <= 0) this.combo = 1;
    }

    if (this.air) this.accumulateAir(dt, sim, input);
    if (this.grind) this.accumulateGrind(dt, sim);

    for (const e of events) {
      switch (e.type) {
        case 'takeoff':
          this.beginAir(sim, e);
          break;
        case 'landing':
          this.finishAir(e);
          break;
        case 'grindStart':
          this.beginGrind(sim, e);
          break;
        case 'grindEnd':
          this.finishGrind(sim, e);
          break;
        case 'bail':
          this.onBail(sim, e);
          break;
        default:
          break;
      }
    }
  }

  // -------------------------------------------------------------------------

  private beginAir(sim: RiderSim, e: SimEvent): void {
    this.air = {
      startTime: e.time,
      takeoffSwitch: this.isSwitch(sim),
      spin: 0,
      flip: 0,
      inversions: 0,
      wasInverted: false,
      axis: new Vec3(),
      axisWeight: 0,
      maxHeight: 0,
      grabHold: new Map(),
      grabOrder: [],
      takeoffSpeed: e.speed ?? sim.velocity.length(),
    };
  }

  private accumulateAir(dt: number, sim: RiderSim, input: RiderInput): void {
    const air = this.air;
    if (!air) return;
    const omega = sim.angularVelocity;

    // Spin is rotation about the world vertical; that is what "a 900" counts.
    air.spin += omega.dot(WORLD_UP) * dt;
    // Flip is rotation about the rider's own lateral axis, which is the axis a
    // somersault turns about for both a skier and a snowboarder.
    const flipAxis = this.options.discipline === 'snowboard' ? this.fwd : this.right;
    air.flip += omega.dot(flipAxis) * dt;

    const mag = omega.length();
    if (mag > 0.4) {
      air.axis.addScaled(omega, dt);
      air.axisWeight += mag * dt;
    }

    // Upside down is measured off the rider, not the board, so a tucked cork
    // reads the same as an extended one.
    const inverted = this.up.dot(WORLD_UP) < -0.12;
    if (inverted && !air.wasInverted) air.inversions++;
    air.wasInverted = inverted;

    air.maxHeight = Math.max(air.maxHeight, sim.telemetry.altitude);

    if (input.grab) {
      air.grabHold.set(input.grab, (air.grabHold.get(input.grab) ?? 0) + dt);
      if (!air.grabOrder.includes(input.grab)) air.grabOrder.push(input.grab);
    }
  }

  private finishAir(e: SimEvent): void {
    const air = this.air;
    this.air = null;
    if (!air) return;

    const airTime = e.time - air.startTime;
    // Anything shorter than this is a bump, not a jump.
    if (airTime < 0.28 && air.maxHeight < 0.35) return;

    const quality = e.quality ?? 0;
    const spinDeg = Math.abs(air.spin) * RAD;
    const result = this.buildAirResult(air, airTime, spinDeg, quality, e.time);
    if (result.points <= 0 && result.spin < 135 && result.inversions === 0 && result.breakdown.grab <= 0) {
      return; // A plain straight air with nothing done to it is not a trick.
    }
    this.commit(result);
  }

  private buildAirResult(
    air: AirSegment,
    airTime: number,
    spinDeg: number,
    quality: number,
    time: number,
  ): TrickResult {
    const rounded = Math.round(spinDeg / 180) * 180;
    const frontside = air.spin > 0;
    const offAxis = this.axisTilt(air);

    const parts: string[] = [];
    if (air.takeoffSwitch) {
      // Switch frontside has its own word on a snowboard.
      if (this.options.discipline === 'snowboard' && frontside) {
        parts.push(rounded === 180 ? 'half cab' : 'cab');
      } else {
        parts.push('switch');
      }
    }

    if (rounded >= 180) {
      if (this.options.discipline === 'snowboard') {
        if (!(air.takeoffSwitch && frontside)) parts.push(frontside ? 'frontside' : 'backside');
      } else {
        parts.push(frontside ? 'right' : 'left');
      }
      if (!(air.takeoffSwitch && frontside && rounded === 180)) parts.push(String(rounded));
    }

    const inversionWord = this.inversionName(air, rounded, offAxis, frontside);
    if (inversionWord) parts.push(inversionWord);

    const grabName = this.grabNames(air);
    if (grabName) parts.push(grabName);

    if (parts.length === 0) parts.push(air.maxHeight > 2.5 ? 'straight air' : 'ollie');

    const breakdown: TrickBreakdown = {
      rotation: rounded >= 180 ? Math.pow(rounded / 180, 1.4) * 90 : 0,
      flip: air.inversions * 260 * (1 + clamp01(offAxis / 90) * 0.55),
      grab: this.grabPoints(air),
      air: air.maxHeight * 12 + airTime * 40 + Math.max(0, air.takeoffSpeed - 8) * 6,
      grind: 0,
    };

    const raw = breakdown.rotation + breakdown.flip + breakdown.grab + breakdown.air;
    const landingMult = quality > 0 ? 0.25 + quality * 1.15 : 0;
    return {
      name: parts.join(' '),
      points: Math.round(raw * landingMult * this.combo),
      breakdown,
      quality,
      landed: quality > 0,
      multiplier: this.combo,
      spin: rounded,
      inversions: air.inversions,
      airTime,
      height: air.maxHeight,
      time,
    };
  }

  /** How far the mean rotation axis tipped away from vertical, in degrees. */
  private axisTilt(air: AirSegment): number {
    if (air.axisWeight < 0.15 || air.axis.lengthSq() < 1e-6) return 0;
    this.tmp.copy(air.axis).normalize();
    const angle = angleBetween(this.tmp, WORLD_UP) * RAD;
    return angle > 90 ? 180 - angle : angle;
  }

  /**
   * Names the inverted part of a trick.
   *
   * The vocabulary genuinely is contested between riders; this settles on one
   * consistent reading rather than pretending there is a single right answer.
   */
  private inversionName(air: AirSegment, spin: number, offAxis: number, frontside: boolean): string {
    if (air.inversions === 0) {
      // A very flat rotation with no inversion is still worth calling out.
      return spin >= 540 && offAxis > 55 ? 'flatspin' : '';
    }
    const count = air.inversions === 1 ? '' : air.inversions === 2 ? 'double ' : air.inversions === 3 ? 'triple ' : 'quad ';

    if (spin < 270) {
      // Little or no spin: it is simply a flip.
      return air.flip > 0 ? `${count}frontflip`.trim() : `${count}backflip`.trim();
    }

    if (this.options.discipline === 'snowboard') {
      // Rodeo is a backside off-axis flip initiated backwards; everything else
      // inverted with spin gets called a cork.
      if (air.flip < 0 && !frontside && offAxis > 40) return `${count}rodeo`;
      return `${count}cork`;
    }

    // Skiing splits the same motion into more names depending on which way the
    // flip was initiated relative to the spin.
    if (offAxis > 62) return `${count}flatspin`;
    if (air.flip > 0 && frontside) return `${count}misty`;
    if (air.flip < 0 && !frontside) return `${count}rodeo`;
    if (air.flip < 0) return `${count}bio`;
    return `${count}cork`;
  }

  private grabNames(air: AirSegment): string {
    const held = air.grabOrder
      .filter((id) => (air.grabHold.get(id) ?? 0) >= 0.18)
      .sort((a, b) => (air.grabHold.get(b) ?? 0) - (air.grabHold.get(a) ?? 0));
    if (held.length === 0) return '';
    const names = held.slice(0, 2).map((id) => getGrab(id)?.name.toLowerCase() ?? id);
    return names.length === 2 ? `${names[0]} to ${names[1]}` : names[0];
  }

  private grabPoints(air: AirSegment): number {
    let total = 0;
    for (const [id, hold] of air.grabHold) {
      const spec = getGrab(id);
      if (!spec || hold < 0.18) continue;
      // Credit scales with how long it was held, saturating just over half a
      // second — the point where a grab reads as tweaked rather than tapped.
      total += spec.difficulty * clamp01(hold / 0.55) * spec.style;
    }
    return total;
  }

  // -------------------------------------------------------------------------

  private beginGrind(sim: RiderSim, e: SimEvent): void {
    const yaw = this.railYaw(sim);
    this.grind = {
      startTime: e.time,
      surfaceId: e.surfaceId ?? '',
      entryYaw: yaw,
      meanYaw: yaw,
      pressTime: 0,
      pressSign: 0,
      duration: 0,
      distance: 0,
    };
  }

  private accumulateGrind(dt: number, sim: RiderSim): void {
    const g = this.grind;
    if (!g) return;
    g.duration += dt;
    g.distance = Math.max(g.distance, sim.telemetry.grindDistance);
    g.meanYaw += (this.railYaw(sim) - g.meanYaw) * Math.min(1, dt * 6);
    const cop = sim.telemetry.pressureCentre;
    if (Math.abs(cop) > 0.2) {
      g.pressTime += dt;
      g.pressSign = Math.sign(cop);
    }
  }

  private finishGrind(sim: RiderSim, e: SimEvent): void {
    const g = this.grind;
    this.grind = null;
    if (!g || g.duration < 0.18 || g.distance < 0.8) return;

    const yaw = Math.abs(normalizeYaw(g.meanYaw));
    const parts: string[] = [];
    if (g.pressTime > g.duration * 0.4) {
      parts.push(g.pressSign > 0 ? 'nose press' : 'tail press');
    }

    let base: string;
    let styleMult = 1;
    if (yaw < 28) {
      base = '50-50';
    } else if (yaw > 152) {
      base = 'switch 50-50';
      styleMult = 1.2;
    } else if (yaw >= 62 && yaw <= 118) {
      // Which way the rider rotated onto the rail decides the name.
      base = normalizeYaw(g.entryYaw) > 0 ? 'boardslide' : 'lipslide';
      styleMult = 1.65;
    } else if (yaw < 62) {
      base = 'noseslide';
      styleMult = 1.35;
    } else {
      base = 'tailslide';
      styleMult = 1.4;
    }
    parts.push(base);

    const grindPoints = g.distance * 24 * styleMult + g.duration * 30;
    const breakdown: TrickBreakdown = { rotation: 0, flip: 0, grab: 0, air: 0, grind: grindPoints };
    const landed = sim.state !== 'bailed';

    this.commit({
      name: parts.join(' '),
      points: landed ? Math.round(grindPoints * this.combo) : 0,
      breakdown,
      quality: landed ? 1 : 0,
      landed,
      multiplier: this.combo,
      spin: 0,
      inversions: 0,
      airTime: 0,
      height: 0,
      time: e.time,
    });
  }

  /** Board yaw relative to the rail it is on, degrees. */
  private railYaw(sim: RiderSim): number {
    const tangent = sim.grindTangent;
    if (!tangent) return 0;
    sim.getBoardAxes(this.right, this.up, this.fwd);
    return Math.atan2(this.fwd.dot(this.right), this.fwd.dot(tangent)) * RAD;
  }

  // -------------------------------------------------------------------------

  private onBail(sim: RiderSim, e: SimEvent): void {
    const pending = this.air ?? this.grind;
    this.air = null;
    this.grind = null;
    this.combo = 1;
    this.comboTimer = 0;
    if (!pending) return;
    const result: TrickResult = {
      name: 'bail',
      points: 0,
      breakdown: { rotation: 0, flip: 0, grab: 0, air: 0, grind: 0 },
      quality: 0,
      landed: false,
      multiplier: 1,
      spin: 0,
      inversions: 0,
      airTime: 0,
      height: 0,
      bailReason: e.reason ?? sim.bailReason,
      time: e.time,
    };
    this.history.push(result);
    this.onTrick?.(result);
  }

  private commit(result: TrickResult): void {
    this.history.push(result);
    if (result.landed) {
      this.runScore += result.points;
      // Landing inside the window links the trick into the combo.
      this.combo = Math.min(8, this.combo + 0.5);
      this.bestCombo = Math.max(this.bestCombo, this.combo);
      this.comboTimer = 3;
    } else {
      this.combo = 1;
      this.comboTimer = 0;
    }
    this.onTrick?.(result);
  }

  private isSwitch(sim: RiderSim): boolean {
    sim.getBoardAxes(this.right, this.up, this.tmp);
    const speed = sim.velocity.length();
    if (speed < 1.5) return false;
    return this.tmp.dot(sim.velocity) < 0;
  }
}

function normalizeYaw(deg: number): number {
  let d = deg % 360;
  if (d > 180) d -= 360;
  if (d < -180) d += 360;
  return d;
}
