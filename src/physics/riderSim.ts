import { DEG, Quat, RAD, Vec3, angleDelta, clamp, clamp01, damp, lerp, sign } from '../core/math.ts';
import type { Heightfield, SurfaceSample } from '../world/heightfield.ts';
import type { LevelDef } from '../world/level.ts';
import { camberPressure, inertiaTensor, type GearSpec } from './gear.ts';
import { getGrab, type GrabId } from './grabs.ts';
import { makeGrindQuery, queryGrindSurfaces, type GrindQuery, type GrindSurface } from './rails.ts';

/**
 * Crouch command that counts as loading a pop, and the level it must fall back
 * below to stop counting. Split so a hand resting on the threshold does not
 * flicker the state every frame.
 */
const CROUCH_ENTER = 0.35;
const CROUCH_EXIT = 0.2;

/**
 * How long the landing absorption window lasts.
 *
 * The reference shows a clear sink-and-rise on touchdown. This is the state
 * half of that; whatever reads it decides how much steering to give back.
 */
const LANDING_ABSORB = 0.25;

/**
 * What the rider is doing, as one value.
 *
 * `crouching` and `landing` are windows inside what used to be `riding`, split
 * out because both need to be seen: crouching is the pop load, landing is an
 * absorption window. Anything meaning "on a surface" must ask `onGround`, or it
 * will silently stop working during those windows.
 */
export type RiderState = 'riding' | 'crouching' | 'airborne' | 'landing' | 'grinding' | 'bailed';

/** True for every state where the gear is on a surface and steering applies. */
export function onGround(state: RiderState): boolean {
  return state === 'riding' || state === 'crouching' || state === 'landing';
}

export interface RiderInput {
  /** -1..1 across the board. Commands edge angle; the body inclines to follow. */
  lean: number;
  /** -1..1 fore/aft weighting. Presses the nose or the tail. */
  weight: number;
  /**
   * -1..1 skate push. Positive drives forward, negative brakes.
   *
   * Read only by ride models that set `pushAccel`, which today means street.
   * On a mountain gravity is the speed source and this is ignored, so the same
   * key can carry a different meaning on each without a mode switch.
   */
  push: number;
  /** -1..1 upper-body twist. Winds up rotation against the edge. */
  twist: number;
  /** 0..1 leg compression. Load it, then release to pop. */
  crouch: number;
  /** 0..1 tuck. Pulls mass toward the spin axis. */
  tuck: number;
  grab: GrabId | null;
  /** -1..1 airborne axis trims. Limited authority — you cannot spin from nothing. */
  airYaw: number;
  airPitch: number;
  airRoll: number;
  /** Held to commit to a grind rather than bouncing off a rail. */
  grind: boolean;
  /** 0..1 pole plant. Skis only. Plants the inside pole, or both when straight. */
  plant: number;
}

export function neutralInput(): RiderInput {
  return {
    lean: 0,
    weight: 0,
    push: 0,
    twist: 0,
    crouch: 0,
    tuck: 0,
    grab: null,
    airYaw: 0,
    airPitch: 0,
    airRoll: 0,
    grind: false,
    plant: 0,
  };
}

export interface SimTuning {
  gravity: number;
  airDensity: number;
  /**
   * 0 = raw physics, you balance everything yourself.
   * 1 = the game holds your edge and squares you up on landing.
   */
  assist: number;
}

/**
 * The part of the ride model that a level chooses.
 *
 * Two sets of numbers, because two kinds of riding are wanted and the numbers
 * that are right for one are wrong for the other. A mountain is a gravity
 * problem: speed comes from the pitch, there is no ceiling, and turns are long
 * because you are carrying a lot of momentum. Street is a work problem: the
 * ground is near flat, speed has to be earned and bleeds away when you stop
 * earning it, and direction changes are short skids rather than carves.
 */
export interface RideModel {
  /** Speed the drag term holds a sustained pitch to, m/s. Infinity disables it. */
  topSpeed: number;
  /** Deceleration applied whenever grounded, m/s^2. This is what bleeds speed. */
  drag: number;
  /**
   * Multiplier on the twist steering torque — the Q/E axis only.
   *
   * Measured and worth stating so nobody tunes it expecting more: it has no
   * effect whatsoever on lean turning, which is what the arrow keys do and
   * what almost all steering actually is. Sweeping it 1.0 -> 1.85 changed a
   * lean turn by nothing at all, to the digit.
   */
  turnGain: number;
  /**
   * Multiplier on the hold that drives the gear toward the travel direction.
   *
   * The sign of this is the opposite of the obvious guess and it cost a sweep
   * to find out. Weakening the hold does not make the rider turn quicker and
   * skiddier — it makes the gear slide without rotating, which reads as no turn
   * at all. Measured on street at 10 degrees, mean heading rate over a 1.5 s
   * lean: 0.3 -> 10 deg/s, 0.8 -> 136, 1.2 -> 237, 2.6 -> 538 and spinning out.
   * Turning *up* is what buys a quick direction change.
   */
  holdGain: number;
  /**
   * Forward acceleration a held push buys, m/s^2. 0 disables pushing entirely.
   *
   * This is the part that makes street possible at all. On near-flat ground
   * gravity supplies almost nothing — 9.81*sin(4 deg) is 0.68 m/s^2, less than
   * the drag below — so without an input-driven source the rider simply stops.
   * The reference agrees: speed there comes from working for it, and falls away
   * the moment you stop.
   */
  pushAccel: number;
  /**
   * Scales the leg spring, and with it how much air a pop buys.
   *
   * It scales the spring and its force limit together. It used to scale only
   * the limit, which is why it appeared to do nothing — the spring never
   * demanded the extra force it was being allowed.
   *
   * 2 is where the spec's table lands, once the crouch no longer free-falls.
   * Airtime on flat ground by load, at gain 2: 200 ms -> 0.48 s, 280 -> 0.72,
   * 320 -> 1.19, 400 -> 1.23. Above 3 the leg is stiff enough to bottom out
   * again and the curve goes back to nonsense (4.5 gives 2.70 s at 320 ms and
   * 0.23 s at 400), so this is not a knob to keep turning.
   */
  popGain: number;
  /**
   * Shortest press that still pops, seconds.
   *
   * Equal to `loadFull` on both models today, so a tap and a timed hold give
   * the same jump. Street was meant to split them — the spec asks for a tap
   * worth ~0.4 s of air against a full load's 1.0-1.2 s — and the split is not
   * currently shippable. See the note on `loadFull`.
   */
  loadFloor: number;
  /**
   * Load that counts as full, seconds. Holding past it buys nothing.
   *
   * The cap is real and works: holding stops deepening the load here rather
   * than compressing on into the bump stop.
   *
   * 0.20 and 0.36 deliver both of the spec's numbers now that the solver keeps
   * the gear on the snow: a tap is extended to 0.20 s and buys about 0.48 s of
   * air against a target of 0.4, and a full 0.36 s load buys 1.2 s against a
   * target of 1.0-1.2.
   */
  loadFull: number;
}

/** The game as it has always been. Every stock mountain uses this. */
export const MOUNTAIN_MODEL: Readonly<RideModel> = Object.freeze({
  topSpeed: Infinity,
  drag: 0,
  turnGain: 1,
  holdGain: 1,
  pushAccel: 0,
  popGain: 2,
  loadFloor: 0.2,
  loadFull: 0.36,
});

/**
 * Street.
 *
 * Measured, and two of the numbers are a compromise that should be stated
 * rather than discovered later.
 *
 * `topSpeed` is a ceiling the drag term enforces rather than a clamp, so a
 * steep block still feels faster than a flat one; it just cannot run away.
 * That part works: 12.4-14.5 m/s sustained across 4-16 degrees, against a
 * 12-16 target, and speed falls hard when you stop pushing (13.9 -> 6.8 m/s
 * in four seconds at 10 degrees).
 *
 * `pushAccel` is 7.5 and not the ~3 the spec asks for, because 3 does not
 * reach the speed the spec also asks for. The two targets fight: at the
 * `holdGain` needed for a quick direction change the contact solver scrubs
 * enough speed that a 3.4 push tops out at 5.3 m/s, and only around 7.5 gets
 * to 14. Shipping the speed target costs an initial acceleration of about
 * 17 m/s^2 rather than 3 — snappier off the mark than the reference. Fixing
 * that properly means changing how the hold scrubs, which is contact-solver
 * work the earlier specs fenced off.
 */
export const STREET_MODEL: Readonly<RideModel> = Object.freeze({
  topSpeed: 14,
  drag: 0.85,
  turnGain: 1.85,
  holdGain: 1.2,
  pushAccel: 7.5,
  popGain: 2,
  loadFloor: 0.2,
  loadFull: 0.36,
});

export function rideModel(style: 'mountain' | 'street'): Readonly<RideModel> {
  return style === 'street' ? STREET_MODEL : MOUNTAIN_MODEL;
}

export function defaultTuning(): SimTuning {
  return { gravity: 9.81, airDensity: 1.13, assist: 0.55 };
}

export interface ContactReport {
  x: number;
  y: number;
  z: number;
  penetration: number;
  normalForce: number;
  /** Sideways slip speed at this point, m/s. Drives spray. */
  slipSpeed: number;
}

/** Solved state of one pole, for rendering and for the HUD. */
export interface PoleReport {
  planted: boolean;
  /** World position of the tip — the planted point, or where it hangs. */
  tipX: number;
  tipY: number;
  tipZ: number;
  /** World position of the hand holding it. */
  handX: number;
  handY: number;
  handZ: number;
  /** Total compression carried along the strut, newtons. */
  force: number;
  /** How much of that is the rider actively pushing, newtons. */
  push: number;
  /** How much of it is the pole passively holding weight up, newtons. */
  support: number;
  /** Hand-to-tip distance at the moment of the plant, metres. */
  restLength: number;
}

export type SimEventType =
  | 'takeoff'
  | 'landing'
  | 'bail'
  | 'grindStart'
  | 'grindEnd'
  | 'bottomOut'
  | 'recover';

export interface SimEvent {
  type: SimEventType;
  time: number;
  /** Populated for landings: peak leg force in newtons. */
  impact?: number;
  /** Populated for landings: how square the board was to the velocity, 0-1. */
  quality?: number;
  /** Populated for takeoffs and landings. */
  speed?: number;
  /** Populated for bails. */
  reason?: string;
  /** Populated for grind events. */
  surfaceId?: string;
}

export interface Telemetry {
  state: RiderState;
  /** Seconds in the current state. */
  stateTime: number;
  /** "from -> to: why", for the debug overlay. */
  lastTransition: string;
  /** True when travelling backwards relative to the gear's nose. */
  switchStance: boolean;
  /** Degrees turned about world up since the last takeoff. */
  spinDeg: number;
  /** Rate about world up, deg/s. Positive is to the right. */
  spinRate: number;
  /** How far the body's own up axis is tilted off world vertical, degrees. */
  tiltDeg: number;
  speed: number;
  /** Edge angle of the gear relative to the snow, degrees. */
  edgeAngle: number;
  /** Whole-body inclination from the surface normal, degrees. */
  inclination: number;
  /** Mean slip angle across the contact patch, degrees. 0 is a pure carve. */
  slipAngle: number;
  /** 1 = railed carve, 0 = full skid. */
  carveQuality: number;
  /** Total normal force divided by static weight. */
  gForce: number;
  airborne: boolean;
  airTime: number;
  /** Height above the terrain directly below, metres. */
  altitude: number;
  legLength: number;
  legForce: number;
  /** Instantaneous turn radius in metres; Infinity when running straight. */
  turnRadius: number;
  contactCount: number;
  sprayIntensity: number;
  grindSurfaceId: string | null;
  /** Lateral balance error while grinding, -1..1. Fall off past +/-1. */
  grindBalance: number;
  /** Distance travelled along the current grind, metres. */
  grindDistance: number;
  /** How fast the rider is toppling off the rail, m/s. */
  grindBalanceRate: number;
  /** Centre of pressure along the gear, metres. Positive is nose-heavy. */
  pressureCentre: number;
  /** Lateral ground reaction in g. This is the number that reads as "grip". */
  lateralG: number;
  /** Total compression carried by planted poles, newtons. */
  poleForce: number;
  /** Of that, the part the poles are carrying as weight rather than push. */
  poleSupport: number;
  bailReason: string;
}

/**
 * Air rotation gains, as multiples of the axis inertia.
 *
 * Written as a rate command rather than a torque: because the scale carries the
 * inertia, the delivered change in angular velocity comes out the same whatever
 * the gear weighs, and the swing-weight difference between a park ski and a
 * big-mountain ski shows up where it belongs — in how hard it is to *stop* the
 * rotation — instead of in whether the trick is possible at all.
 *
 * Measured on the reference jump documented above `applyControlTorques`.
 */
const AIR_GAIN_YAW = 15;
const AIR_GAIN_PITCH = 10;
const AIR_GAIN_ROLL = 7;
/** How fast a held key spends its reservoir, per second. */
const AIR_FILL = 1.1;
/** Reservoir recovery while the axis is being pushed, per second. */
const AIR_RELAX_HELD = 0.55;
/** Reservoir recovery while the axis is released, per second. */
const AIR_RELAX_FREE = 6;

const CONTACT_SAMPLES: number = 11;
const SUBSTEP = 1 / 240;
const MAX_SUBSTEPS = 8;
const LEG_SUBSTEPS = 8;

/**
 * The leg's travel stops.
 *
 * Stiff enough to turn the leg around inside their own travel, and bounded so
 * no single substep can inject an arbitrary impulse. `BUMP_MAX` is roughly
 * thirty times body weight, which is a hard bottom-out and still a number
 * rather than whatever the penetration happened to be.
 */
const BUMP_K = 320000;
const BUMP_C = 3400;
const TOP_K = 90000;
const TOP_C = 1400;
const BUMP_MAX = 22000;
/** Absolute travel limits. Reaching these means the stops failed. */
const LEG_HARD_MIN = 0.42;
const LEG_HARD_MAX = 1.07;

/**
 * How fast the leg command may shorten, m/s.
 *
 * Fast enough that a full crouch still takes about a third of a second, which
 * is what the leg physically takes anyway; slow enough that the spring never
 * goes slack and the gear stays on the snow through the load.
 */
const CROUCH_RATE = 1.5;

/** Leg extension speed above which a pop is under way, m/s. */
const POP_BALANCE_RATE = 0.35;
/**
 * Fraction of the pop's pitching moment the rider holds.
 *
 * A real fraction now, because what it cancels is the moment the snow is
 * actually applying — accumulated from the contact normals in the solve —
 * rather than an estimate built from the leg force. That distinction is the
 * whole fix. The estimate needed a different fudge factor on every jump: 1.8
 * squared up the 4 m kicker and turned the 6 m one into a backflip, 2.6 made
 * it a double frontflip, 3.4 a triple. Cancelling the measured moment gives a
 * clean hands-off straight air on both at every fraction from 0.5 to 0.95.
 *
 * 0.7 leaves three tenths of it, so a pop off the tail still pitches — just
 * not into a somersault nobody asked for.
 */
const POP_BALANCE = 0.7;

/**
 * The rider.
 *
 * One rigid body carrying the combined rider + gear inertia, plus a single
 * internal degree of freedom for leg extension. Angular motion is integrated as
 * angular momentum rather than angular velocity, which is what makes tucking
 * mid-flight genuinely speed up a spin instead of faking it.
 */
export class RiderSim {
  readonly position = new Vec3();
  readonly velocity = new Vec3();
  readonly orientation = new Quat();
  /** World-frame angular momentum, kg·m²/s. */
  readonly angularMomentum = new Vec3();
  /** Derived each substep from the momentum and the current inertia tensor. */
  readonly angularVelocity = new Vec3();

  /**
   * Read it anywhere; write it only through `transition`.
   *
   * There were eight assignment sites and no record of how the rider got where
   * it is, which is the thing that makes state bugs hard: by the time you see
   * the wrong state you cannot tell which branch set it.
   */
  state: RiderState = 'riding';
  /** Seconds in the current state. Drives the landing window and the overlay. */
  stateTime = 0;
  /** Previous state and why it changed, for the debug overlay. */
  lastTransition = 'start';
  /** Radians about world up accumulated since the last takeoff. */
  private spinSinceTakeoff = 0;
  private readonly sTelUp = new Vec3();
  private readonly sTelRight = new Vec3();
  private readonly sTelFwd = new Vec3();
  gear: GearSpec;
  /** Ground model for this level. Set once from `level.style`. */
  ride: Readonly<RideModel> = MOUNTAIN_MODEL;
  riderMass = 72;
  tuning: SimTuning;

  /** Leg extension from the rider's centre of mass to the base, metres. */
  legLength = 0.92;
  legVelocity = 0;
  /** Rate-limited leg command. See `integrateLeg`. */
  private legTarget = 1.02;
  legForce = 0;

  /** Gear roll relative to the body — ankles and knees, radians. */
  angulation = 0;
  /**
   * Lateral displacement of the gear from directly beneath the rider, metres.
   *
   * This is the cross-over every real turn starts with: the hips move to the
   * inside and the board travels to the outside. Without it, setting an edge
   * just topples you outward — which is precisely what happens to a beginner.
   */
  hipShift = 0;

  time = 0;
  airTime = 0;
  private groundedTime = 0;
  private lastTakeoffSpeed = 0;
  private peakLegForce = 0;
  private bailTimer = 0;
  bailReason = '';

  readonly contacts: ContactReport[] = [];
  /** Left pole, then right. */
  readonly poles: [PoleReport, PoleReport] = [blankPole(), blankPole()];
  readonly events: SimEvent[] = [];
  readonly telemetry: Telemetry = {
    state: 'riding',
    stateTime: 0,
    lastTransition: 'start',
    switchStance: false,
    spinDeg: 0,
    spinRate: 0,
    tiltDeg: 0,
    speed: 0,
    edgeAngle: 0,
    inclination: 0,
    slipAngle: 0,
    carveQuality: 1,
    gForce: 1,
    airborne: false,
    airTime: 0,
    altitude: 0,
    legLength: 0.92,
    legForce: 0,
    turnRadius: Infinity,
    contactCount: 0,
    sprayIntensity: 0,
    grindSurfaceId: null,
    grindBalance: 0,
    grindDistance: 0,
    grindBalanceRate: 0,
    pressureCentre: 0,
    lateralG: 0,
    poleForce: 0,
    poleSupport: 0,
    bailReason: '',
  };

  private readonly field: Heightfield;
  private readonly level: LevelDef;
  private grindSurfaces: readonly GrindSurface[];

  // Grind state
  private grind: GrindSurface | null = null;
  private grindAlong = 0;
  private grindEntry = 0;
  private grindBalance = 0;
  private grindBalanceRate = 0;
  private grindCooldown = 0;

  /** Unit tangent of the surface currently being ground, for trick naming. */
  private readonly grindTangentVec = new Vec3();

  /** Previous hand-to-tip distance per pole, for the compression damper. */
  private lastReach = [0, 0];

  // Air control reservoirs — you can only wind your body so far.
  private airBudget = new Vec3();

  // Scratch. Reused every substep so the hot loop never allocates.
  private readonly sBodyUp = new Vec3();
  private readonly sBodyFwd = new Vec3();
  private readonly sBodyRight = new Vec3();
  private readonly sBoardUp = new Vec3();
  private readonly sBoardFwd = new Vec3();
  private readonly sBoardRight = new Vec3();
  private readonly sBoardCenter = new Vec3();
  private readonly sForce = new Vec3();
  private readonly sTorque = new Vec3();
  private readonly sNormal = new Vec3();
  private readonly sTmpA = new Vec3();
  private readonly sTmpB = new Vec3();
  private readonly sTmpC = new Vec3();
  private readonly sTmpD = new Vec3();
  private readonly sContactPoint = new Vec3();
  private readonly sContactVel = new Vec3();
  private readonly sFwdS = new Vec3();
  private readonly sLatS = new Vec3();
  private readonly sEdgeDir = new Vec3();
  private readonly sEdgeLat = new Vec3();
  private readonly sWind = new Vec3();
  private readonly sContactForce = new Vec3();
  private readonly sQuat = new Quat();
  private readonly sSurface: SurfaceSample = {
    height: 0,
    normal: new Vec3(0, 1, 0),
    looseDepth: 0,
    hardness: 0.5,
  };
  private readonly sGrindQuery: GrindQuery = makeGrindQuery();

  private accumulator = 0;
  private packTimer = 0;
  private lastNormalForce = 0;
  /** Pitching moment from contact normals alone, N·m about the lateral axis. */
  private lastNormalPitch = 0;
  private lastContactCount = 0;
  private lastSlipSum = 0;
  private lastSpraySum = 0;

  constructor(
    field: Heightfield,
    level: LevelDef,
    grindSurfaces: readonly GrindSurface[],
    gear: GearSpec,
    tuning: SimTuning = defaultTuning(),
  ) {
    this.field = field;
    this.level = level;
    this.ride = rideModel(level.style);
    this.grindSurfaces = grindSurfaces;
    this.gear = gear;
    this.tuning = tuning;
    for (let i = 0; i < CONTACT_SAMPLES; i++) {
      this.contacts.push({ x: 0, y: 0, z: 0, penetration: 0, normalForce: 0, slipSpeed: 0 });
    }
    this.reset(level.spawn.x, level.spawn.z, level.spawn.heading);
  }

  setGrindSurfaces(surfaces: readonly GrindSurface[]): void {
    this.grindSurfaces = surfaces;
    this.grind = null;
  }

  get totalMass(): number {
    return this.riderMass + this.gear.mass;
  }

  /** Distance from the rider's centre of mass down to the base of the gear. */
  get boardOffset(): number {
    return this.legLength * (this.riderMass / this.totalMass);
  }

  reset(x: number, z: number, headingDeg: number): void {
    const h = headingDeg * DEG;
    this.field.normalAt(x, z, this.sNormal);
    // Lay the gear *in* the slope, not horizontally across it — otherwise the
    // tail spawns buried and the first contact impulse launches the rider.
    this.sTmpA.set(Math.sin(h), 0, Math.cos(h)).removeComponentAlong(this.sNormal).normalize();
    this.orientation.setFromForwardUp(this.sTmpA, this.sNormal);

    // Start the legs at the compression that actually supports the rider, so
    // they are not mid-extension on the first frame.
    const kLeg = 7400 * this.gear.pop * this.ride.popGain;
    this.legLength = clamp(1.02 - (this.riderMass * this.tuning.gravity) / kLeg, 0.5, 1.02);
    this.legVelocity = 0;
    this.legTarget = 1.02;
    this.position.set(x, this.field.heightAt(x, z) + this.boardOffset, z);
    // Start with a little speed so the first turn has something to bite on.
    this.velocity.copy(this.sTmpA).scale(6);
    this.angularMomentum.setZero();
    this.angularVelocity.setZero();
    this.angulation = 0;
    this.transition('riding', 'reset');
    this.airTime = 0;
    this.groundedTime = 1;
    this.grind = null;
    this.grindBalance = 0;
    this.grindBalanceRate = 0;
    this.grindCooldown = 0;
    this.bailTimer = 0;
    this.bailReason = '';
    this.airBudget.setZero();
    this.events.length = 0;
  }

  /** Advances the simulation by `dt` seconds using fixed substeps. */
  step(dt: number, input: RiderInput): void {
    this.accumulator += Math.min(dt, 0.25);
    let steps = 0;
    while (this.accumulator >= SUBSTEP && steps < MAX_SUBSTEPS) {
      this.substep(SUBSTEP, input);
      this.accumulator -= SUBSTEP;
      steps++;
    }
    if (steps === MAX_SUBSTEPS) this.accumulator = 0;
    this.updateTelemetry();
  }

  // -------------------------------------------------------------------------

  private substep(dt: number, rawInput: RiderInput): void {
    this.time += dt;
    const input = this.state === 'bailed' ? neutralInput() : rawInput;
    const M = this.totalMass;

    this.refreshBodyFrame();
    this.updateAngularVelocity(input);

    this.sForce.setZero();
    this.sTorque.setZero();

    // Gravity acts at the centre of mass and therefore makes no torque; every
    // toppling moment in this sim comes from where the snow pushes back.
    this.sForce.y -= M * this.tuning.gravity;

    this.applyAerodynamics(input);
    this.applyRideDrag(input);
    this.solvePoles(dt, input);

    // Surface reference under the rider.
    this.field.sample(
      this.position.x,
      this.position.z,
      this.level.snow.hardness,
      this.level.snow.depth,
      this.sSurface,
    );
    this.sNormal.copy(this.sSurface.normal);

    const inclination = this.signedRoll(this.sBodyUp, this.sBodyRight);
    this.updateAngulation(input, inclination, dt);
    this.refreshBoardFrame();

    let contactNormalForce = 0;
    if (this.state === 'grinding' || (this.grindCooldown <= 0 && this.tryEngageGrind(input))) {
      contactNormalForce = this.solveGrind(input);
    } else {
      contactNormalForce = this.solveSnowContact(dt, input);
    }
    this.grindCooldown = Math.max(0, this.grindCooldown - dt);

    this.integrateLeg(dt, input, contactNormalForce);
    this.applyPopBalance();
    this.applyControlTorques(dt, input, contactNormalForce);
    this.updateFlightState(dt, contactNormalForce, input);
    this.checkBail(input, contactNormalForce);

    // Semi-implicit Euler: velocity first, then position, which is stable for
    // the stiff contact spring at this step size.
    this.velocity.addScaled(this.sForce, dt / M);
    this.position.addScaled(this.velocity, dt);
    this.angularMomentum.addScaled(this.sTorque, dt);
    this.orientation.integrate(this.angularVelocity, dt);

    this.enforceBounds();
    this.packTimer += dt;
  }

  /**
   * Pole plants.
   *
   * A pole is a strut, not a button. The tip is planted at a fixed world point
   * and from then on it can only *push* — a planted pole carries compression and
   * nothing else. The rider drives against it until the arm runs out of reach,
   * at which point the pole trails free and the stroke is over. That single
   * constraint produces both behaviours for free: plant beside you and the force
   * is lateral, so it pivots you into the turn; plant behind and it is
   * longitudinal, so it drives you forward across a flat.
   *
   * The stroke length is what stops this being a free speed button. You get one
   * arm's worth of push per plant and then you have to reset.
   */
  private solvePoles(dt: number, input: RiderInput): void {
    if (this.gear.discipline !== 'skis') {
      this.poles[0].planted = false;
      this.poles[1].planted = false;
      this.poles[0].force = 0;
      this.poles[1].force = 0;
      return;
    }

    // Committing to a turn plants the inside pole on its own, scaled by assist.
    // With assist off it is entirely down to the player.
    const auto = this.tuning.assist * clamp01((Math.abs(input.lean) - 0.45) / 0.35);
    const demand = clamp01(Math.max(input.plant, auto));
    const turning = Math.abs(input.lean) > 0.25;
    const insideSide = turning ? sign(input.lean) : 0;

    const poleLength = 1.22;
    const snowHold = lerp(0.5, 1, this.sSurface.hardness);

    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const pole = this.poles[i];
      // In a turn only the inside pole is in play; running straight, both are.
      const active = demand > 0.06 && (insideSide === 0 || insideSide === side);

      const hand = _poleHand
        .copy(this.position)
        .addScaled(this.sBodyUp, -0.02)
        .addScaled(this.sBodyRight, side * 0.44)
        .addScaled(this.sBodyFwd, 0.22);
      pole.handX = hand.x;
      pole.handY = hand.y;
      pole.handZ = hand.z;

      if (!pole.planted) {
        pole.force = 0;
        pole.push = 0;
        pole.support = 0;
        // Trailing: a skier carries the poles swept back, near horizontal, with
        // the tips just clear of the snow. Hanging them straight down instead
        // buries the tips on every run and drags permanently.
        const rest = _poleDirTmp
          .copy(this.sBodyUp)
          .scale(-0.62)
          .addScaled(this.sBodyFwd, -0.92)
          .addScaled(this.sBodyRight, side * 0.18)
          .normalize();
        _poleTip.copy(hand).addScaled(rest, poleLength);

        // How far the tip *would* go under if nothing stopped it. Carried low
        // enough — a deep crouch, or a compression — and it ploughs. It is a
        // small cost, but dragging your poles is sloppy and it should show.
        const restGround = this.field.heightAt(_poleTip.x, _poleTip.z);
        const buried = restGround - _poleTip.y;
        // The tip rests on the snow rather than through it, for the renderer.
        pole.tipX = _poleTip.x;
        pole.tipY = buried > 0 ? restGround : _poleTip.y;
        pole.tipZ = _poleTip.z;

        if (buried > 0 && onGround(this.state)) {
          const speed = this.velocity.length();
          const drag = Math.min(90, 26 * Math.min(buried, 0.25) * speed * speed * (1 - snowHold * 0.5));
          if (drag > 0.5 && speed > 0.1) {
            _poleForce.copy(this.velocity).scale(-drag / speed);
            this.sForce.add(_poleForce);
            _poleR.subVectors(hand, this.position);
            this.sTorque.add(_poleTorque.crossVectors(_poleR, _poleForce));
            pole.force = drag;
          }
        }

        if (!active || !onGround(this.state)) continue;

        // Where the tip goes depends on what the plant is *for*, and the two
        // are genuinely different actions:
        //
        //   Turning — plant ahead and to the inside. The strut then pushes back
        //   and inward, which is a pivot and a brake. That is what a turn plant
        //   does in reality, and why racers use it for timing rather than speed.
        //
        //   Running straight — plant at the boot. The tip is left behind as you
        //   glide over it, the strut swings to point forward, and that is where
        //   propulsion comes from. Planting ahead and expecting to be pushed
        //   along has the geometry backwards.
        const ahead = turning ? 0.5 : -0.08;
        const reach = _poleDirTmp
          .copy(this.sBodyUp)
          .scale(-1)
          .addScaled(this.sBodyFwd, ahead)
          .addScaled(this.sBodyRight, side * 0.26)
          .normalize();
        _poleTip.copy(hand).addScaled(reach, poleLength);
        const ground = this.field.heightAt(_poleTip.x, _poleTip.z);
        // Only bites if the tip actually reaches the snow.
        if (_poleTip.y > ground + 0.12) continue;
        pole.planted = true;
        pole.tipX = _poleTip.x;
        pole.tipY = ground;
        pole.tipZ = _poleTip.z;
        // The shaft is rigid, so the length that matters for the rest of this
        // stroke is how far the tip ended up from the hand — not the nominal
        // length of the pole. Whatever is left over is buried in the snow.
        pole.restLength = Math.hypot(
          hand.x - pole.tipX,
          hand.y - pole.tipY,
          hand.z - pole.tipZ,
        );
        // Seed the damper, or the first frame of the stroke reads a closing
        // speed left over from the previous plant.
        this.lastReach[i] = pole.restLength;
        continue;
      }

      // --- Planted: push along the strut -----------------------------------
      _poleTip.set(pole.tipX, pole.tipY, pole.tipZ);
      const strut = _poleDirTmp.subVectors(hand, _poleTip);
      const reachLeft = strut.length();
      if (!active || reachLeft > poleLength || !onGround(this.state)) {
        pole.planted = false;
        pole.force = 0;
        pole.push = 0;
        pole.support = 0;
        continue;
      }
      strut.scale(1 / Math.max(reachLeft, 1e-4));

      // A push you can actually sustain across the reach, tailing off as the
      // arm straightens out. The hard limit on a stroke is the geometry above,
      // not this curve.
      const stroke = clamp01(1 - reachLeft / poleLength);
      const armForce = 175 * demand * snowHold * (0.62 + stroke * 0.55);

      // Resistance. The shaft is rigid, so once it is planted it also holds you
      // *up*: any motion that would drive the hand closer to the tip than the
      // pole is long has to compress a metal tube, and it does not compress. Put
      // weight on it in a steep and it props you there, which is most of what a
      // pole is for on anything technical.
      //
      // Unilateral, because a pole can push and cannot pull, and capped because
      // past a few hundred newtons the tip punches through the snow or the shaft
      // folds — at which point it stops holding you and you are going down.
      const squash = pole.restLength - reachLeft;
      let support = 0;
      if (squash > 0) {
        const approach = (this.lastReach[i] - reachLeft) / Math.max(dt, 1e-5);
        const maxSupport = 720 * snowHold;
        support = clamp(9000 * squash + 260 * Math.max(0, approach), 0, maxSupport);
      }

      pole.push = armForce;
      pole.support = support;
      pole.force = armForce + support;

      const force = _poleForce.copy(strut).scale(pole.force);
      this.sForce.add(force);
      const r = _poleR.subVectors(hand, this.position);
      this.sTorque.add(_poleTorque.crossVectors(r, force));
      this.lastReach[i] = reachLeft;
    }
  }

  private refreshBodyFrame(): void {
    this.sBodyRight.set(1, 0, 0).applyQuat(this.orientation);
    this.sBodyUp.set(0, 1, 0).applyQuat(this.orientation);
    this.sBodyFwd.set(0, 0, 1).applyQuat(this.orientation);
  }

  private refreshBoardFrame(): void {
    // The gear is the body rolled about its own forward axis by the angulation.
    // Negated because a positive roll about local +Z lifts the toe edge, and
    // positive angulation means driving that edge *into* the snow.
    this.sQuat.setFromAxisAngle(_localZ, -this.angulation);
    const q = _boardQuat.copy(this.orientation).multiply(this.sQuat);
    this.sBoardRight.set(1, 0, 0).applyQuat(q);
    this.sBoardUp.set(0, 1, 0).applyQuat(q);
    this.sBoardFwd.set(0, 0, 1).applyQuat(q);
    this.sBoardCenter
      .copy(this.position)
      .addScaled(this.sBodyUp, -this.boardOffset)
      .addScaled(this.sBodyRight, this.hipShift);
  }

  /** ω = R I⁻¹ Rᵀ L, recomputed every substep so tucking changes it instantly. */
  private updateAngularVelocity(input: RiderInput): void {
    const grab = getGrab(input.grab);
    const tuck = clamp01(Math.max(input.tuck, grab ? grab.tuck : 0, input.crouch * 0.5));
    const I = inertiaTensor(this.gear, this.riderMass, tuck);
    const local = this.sTmpA.copy(this.angularMomentum).applyQuatInverse(this.orientation);
    local.set(local.x / I.x, local.y / I.y, local.z / I.z);
    this.angularVelocity.copy(local).applyQuat(this.orientation);
    this.currentInertia.set(I.x, I.y, I.z);
  }

  private readonly currentInertia = new Vec3(13, 2, 13);

  /**
   * The street speed budget.
   *
   * Two terms, and they do different jobs. `drag` is a flat deceleration that
   * runs the whole time you are on the ground: it is why speed falls away when
   * you stop working for it, which is the thing that makes street street. The
   * ceiling term is quadratic in the overshoot past `topSpeed`, so it does
   * nothing at all below the ceiling — a steep block still feels faster than a
   * flat one — and rises hard above it rather than clamping, which would read
   * as hitting a wall.
   *
   * Grounded only. In the air the rider is ballistic and the existing
   * aerodynamics already own that.
   */
  private applyRideDrag(input: RiderInput): void {
    if (!onGround(this.state) && this.state !== 'grinding') return;
    const model = this.ride;
    if (model.drag <= 0 && !Number.isFinite(model.topSpeed)) return;

    const v = this.sTmpA.copy(this.velocity);
    v.y = 0;
    const speed = v.length();
    if (speed < 0.05) return;
    v.scale(1 / speed);

    let decel = model.drag;
    if (Number.isFinite(model.topSpeed) && speed > model.topSpeed) {
      const over = speed - model.topSpeed;
      decel += over * over * 0.9;
    }
    this.sForce.addScaled(v, -decel * this.totalMass);

    // Pushing. Only below the ceiling, and only along the direction the gear is
    // actually pointing, so it skates you forward rather than shoving you
    // sideways out of a turn.
    if (model.pushAccel > 0 && input.push > 0 && speed < model.topSpeed) {
      const fwd = this.sTmpB.copy(this.sFwdS);
      fwd.y = 0;
      const len = fwd.length();
      if (len > 0.01) {
        fwd.scale(1 / len);
        // Pushing backwards is braking, not reverse: the sign follows travel.
        const sense = fwd.dot(v) < 0 ? -1 : 1;
        this.sForce.addScaled(fwd, sense * input.push * model.pushAccel * this.totalMass);
      }
    }
  }

  private applyAerodynamics(input: RiderInput): void {
    const w = this.level.weather;
    const windRad = w.windDirection * DEG;
    this.sWind.set(Math.sin(windRad) * w.wind, 0, Math.cos(windRad) * w.wind);
    const rel = this.sTmpB.subVectors(this.velocity, this.sWind);
    const speed = rel.length();
    if (speed < 0.01) return;

    const grab = getGrab(input.grab);
    const tuck = clamp01(Math.max(input.tuck, grab ? grab.tuck : 0));
    // Frontal area shrinks when you ball up — worth real speed on a straight.
    const cdA = lerp(0.62, 0.29, tuck);
    const drag = 0.5 * this.tuning.airDensity * cdA * speed;
    this.sForce.addScaled(rel, -drag);

    // Airborne bodies shed rotation slowly; on the ground the snow dominates.
    if (this.state === 'airborne') {
      this.sTorque.addScaled(this.angularVelocity, -0.09 * this.currentInertia.y);
    }
  }

  /**
   * Turns the lean input into an ankle/knee angle.
   *
   * With assist off this is a direct joint command and holding an edge is your
   * problem. With assist on the game solves for the angulation that produces the
   * edge angle you asked for given how far the body has already inclined.
   */
  private updateAngulation(input: RiderInput, inclination: number, dt: number): void {
    const maxAngulation = 48 * DEG;
    const maxEdge = 64 * DEG;
    const raw = input.lean * maxAngulation;
    const assisted = input.lean * maxEdge - inclination;
    const target = clamp(lerp(raw, assisted, this.tuning.assist), -maxAngulation, maxAngulation);
    // Ankles and knees are fast but not instant.
    this.angulation = damp(this.angulation, target, 9, dt);

    // Cross-over: leaning right drives the board out to the left, which is what
    // tips the body into the turn in the first place. Hips move slower than
    // ankles, so committing to a turn takes real time.
    //
    // How far inside you move scales with the load the turn is carrying — the
    // same thing a rider does instinctively. Without it the geometry can never
    // reach the equilibrium where the ground reaction runs through the centre of
    // mass, and the turn is held up by the assist instead of by the rider.
    const commitment = 0.45 + 0.75 * clamp01(this.lastLateralG);
    const maxShift = 0.58;
    const shiftTarget = clamp(-input.lean * 0.52 * commitment, -maxShift, maxShift);
    this.hipShift = damp(this.hipShift, shiftTarget, 6.5, dt);
  }

  /** Signed roll of `up` about the forward axis relative to the surface normal. */
  private signedRoll(up: Vec3, right: Vec3): number {
    const s = clamp(-right.dot(this.sNormal), -1, 1);
    const c = clamp(up.dot(this.sNormal), -1, 1);
    return Math.atan2(s, c);
  }

  // -------------------------------------------------------------------------
  // Snow contact
  // -------------------------------------------------------------------------

  private solveSnowContact(dt: number, input: RiderInput): number {
    const gear = this.gear;
    const M = this.totalMass;
    const snow = this.sSurface;

    const edgeAngle = this.signedRoll(this.sBoardUp, this.sBoardRight);
    // Blend the engaged edge in over the first few degrees so a flat board runs
    // straight instead of snapping between edges.
    const edgeSign = clamp(edgeAngle / (7 * DEG), -1, 1);
    const absEdge = Math.abs(edgeAngle);

    // Classic carving relation: a tilted sidecut describes a tighter arc.
    const sidecutR = Math.max(1.6, gear.sidecutRadius * Math.cos(clamp(absEdge, 0, 1.35)));

    // Snow stiffness spans two orders of magnitude between powder and ice.
    const kSnow = Math.exp(lerp(Math.log(7600), Math.log(1.29e6), snow.hardness));
    const cSnow = 2 * 0.45 * Math.sqrt(kSnow * 0.12 * M);

    const halfEdge = gear.effectiveEdge / 2;
    const muGlide = gear.glideFriction * lerp(1.5, 0.75, snow.hardness);
    // A steep edge bites; a flat base has nothing to hold with.
    const gripFactor = 0.3 + 0.7 * Math.sin(clamp(absEdge, 0, Math.PI / 2));
    const muLatMax = lerp(1.05, 1.55, snow.hardness) * gripFactor * (0.85 + 0.3 * gear.stiffness);
    const corneringB = lerp(6.5, 15.5, snow.hardness) * (0.8 + 0.4 * gear.stiffness);

    const pen = _penetration;
    const normals = _normalForce;
    const zPos = _zPos;

    // --- Pass 1: geometry and raw normal force -----------------------------
    let weightSum = 0;
    for (let i = 0; i < CONTACT_SAMPLES; i++) {
      const u = -1 + (2 * i) / (CONTACT_SAMPLES - 1);
      const camber = camberPressure(gear.camber, u, gear.stiffness);
      const foreAft = Math.max(0.04, 1 + input.weight * u * 1.35);
      _weights[i] = camber * foreAft;
      weightSum += _weights[i];
    }
    const invWeight = weightSum > 0 ? 1 / weightSum : 0;

    let contactCount = 0;
    for (let i = 0; i < CONTACT_SAMPLES; i++) {
      const u = -1 + (2 * i) / (CONTACT_SAMPLES - 1);
      const zi = u * halfEdge;
      zPos[i] = zi;
      // Engaged edge bulges away from the centreline following the sidecut.
      const xi = edgeSign * (gear.waistWidth / 2 + (zi * zi) / (2 * gear.sidecutRadius));

      const cp = this.sContactPoint
        .copy(this.sBoardCenter)
        .addScaled(this.sBoardRight, xi)
        .addScaled(this.sBoardFwd, zi);

      const report = this.contacts[i];
      report.x = cp.x;
      report.y = cp.y;
      report.z = cp.z;
      report.slipSpeed = 0;

      const groundY = this.field.heightAt(cp.x, cp.z);
      // Convert the vertical gap into a distance along the surface normal.
      const penetration = (groundY - cp.y) * this.sNormal.y;
      pen[i] = penetration;
      report.penetration = Math.max(0, penetration);
      if (penetration <= 0) {
        normals[i] = 0;
        report.normalForce = 0;
        continue;
      }
      contactCount++;

      const r = this.sTmpC.subVectors(cp, this.position);
      const vel = this.sContactVel.crossVectors(this.angularVelocity, r).add(this.velocity);
      const compressionRate = Math.max(0, -vel.dot(this.sNormal));
      const w = _weights[i] * invWeight;
      normals[i] = Math.max(
        0,
        w * (kSnow * Math.pow(penetration, 1.2) + cSnow * compressionRate),
      );
    }

    // --- Board flex --------------------------------------------------------
    // A board is a beam, not a rigid plate: it bends to conform, spreading load
    // along its length. Without this the pressure piles onto whichever end is
    // deepest, which puts the centre of pressure ahead of the centre of mass and
    // makes the board directionally unstable — an arrow with its fletching at
    // the front. A stiffer board spreads load further.
    const spread = 0.35 + 0.4 * gear.stiffness;
    const passes = gear.stiffness > 0.6 ? 2 : 1;
    for (let pass = 0; pass < passes; pass++) {
      for (let i = 0; i < CONTACT_SAMPLES; i++) _flexTmp[i] = normals[i];
      for (let i = 0; i < CONTACT_SAMPLES; i++) {
        const a = _flexTmp[i > 0 ? i - 1 : 0];
        const b = _flexTmp[i];
        const c = _flexTmp[i < CONTACT_SAMPLES - 1 ? i + 1 : CONTACT_SAMPLES - 1];
        normals[i] = b * (1 - spread) + ((a + b + c) / 3) * spread;
      }
    }

    // --- Pass 2: friction and accumulation ---------------------------------
    let totalNormal = 0;
    let slipSum = 0;
    let spraySum = 0;
    let copMoment = 0;
    let normalPitch = 0;
    this.sContactForce.setZero();

    // Surface-plane basis aligned with the gear. Constant across the contact
    // patch, so it is computed once rather than per sample.
    this.sFwdS.copy(this.sBoardFwd).removeComponentAlong(this.sNormal);
    if (this.sFwdS.lengthSq() < 1e-8) return 0;
    this.sFwdS.normalize();
    this.sLatS.crossVectors(this.sNormal, this.sFwdS);

    const maxHold = 24000 * (0.35 + snow.hardness);

    for (let i = 0; i < CONTACT_SAMPLES; i++) {
      if (pen[i] <= 0 || normals[i] <= 0) continue;
      const normalForce = Math.min(normals[i], maxHold);
      totalNormal += normalForce;
      copMoment += normalForce * zPos[i];

      const report = this.contacts[i];
      report.normalForce = normalForce;

      const cp = this.sContactPoint.set(report.x, report.y, report.z);
      const r = this.sTmpC.subVectors(cp, this.position);
      const vel = this.sContactVel.crossVectors(this.angularVelocity, r).add(this.velocity);
      const vNormal = vel.dot(this.sNormal);

      // Local edge tangent: the sidecut steers each point a little differently,
      // which is what makes the board turn rather than just slide.
      const theta = edgeSign * (zPos[i] / sidecutR);
      const cosT = Math.cos(theta);
      const sinT = Math.sin(theta);
      this.sEdgeDir.set(
        this.sFwdS.x * cosT + this.sLatS.x * sinT,
        this.sFwdS.y * cosT + this.sLatS.y * sinT,
        this.sFwdS.z * cosT + this.sLatS.z * sinT,
      );
      this.sEdgeLat.crossVectors(this.sNormal, this.sEdgeDir);

      const vt = this.sTmpD.copy(vel).addScaled(this.sNormal, -vNormal);
      const vLong = vt.dot(this.sEdgeDir);
      const vLat = vt.dot(this.sEdgeLat);

      // Brush-model lateral force: builds with slip angle, peaks, then breaks
      // away. Past the peak the edge is skidding and you are spraying snow.
      const slipAngle = Math.atan2(vLat, Math.abs(vLong) + 0.6);
      const latMag = normalForce * muLatMax * Math.sin(1.45 * Math.atan(corneringB * slipAngle));
      let fLat = -latMag;

      // Friction can never do more than stop the sliding. Capping by the impulse
      // that exactly nulls the slip keeps the stiff edge response stable at this
      // timestep without softening the physics.
      const stopForce = (this.effectiveMassAlong(r, this.sEdgeLat) * Math.abs(vLat)) / dt;
      if (Math.abs(fLat) > stopForce) fLat = -sign(vLat) * stopForce;

      // Longitudinal: base glide, plus the cost of shovelling snow aside. The
      // plow term is what makes deep powder slow and a groomed run fast.
      const plow =
        3.0 * pen[i] * gear.waistWidth * (1 - snow.hardness * 0.75) * vLong * Math.abs(vLong);
      let glide = -sign(vLong) * normalForce * muGlide;
      const stopLong = (this.effectiveMassAlong(r, this.sEdgeDir) * Math.abs(vLong)) / dt;
      if (Math.abs(glide) > stopLong) glide = -sign(vLong) * stopLong;
      let fLong = glide - plow;

      // Sanity rail against a numerical spike; the brush model is the real limit.
      const ceiling = normalForce * 2.2;
      const mag = Math.hypot(fLat, fLong);
      if (mag > ceiling && mag > 1e-6) {
        const k = ceiling / mag;
        fLat *= k;
        fLong *= k;
      }

      this.sTmpA
        .copy(this.sNormal)
        .scale(normalForce)
        .addScaled(this.sEdgeLat, fLat)
        .addScaled(this.sEdgeDir, fLong);
      this.sForce.add(this.sTmpA);
      this.sContactForce.add(this.sTmpA);
      this.sTorque.add(this.sTmpB.crossVectors(r, this.sTmpA));

      // The pitching moment the *normal* forces alone put about the centre of
      // mass. Measured rather than estimated, because estimating it from the
      // leg force needed a different fudge factor on every jump.
      this.sTmpD.copy(this.sNormal).scale(normalForce);
      normalPitch += this.sTmpB.crossVectors(r, this.sTmpD).dot(this.sLatS);

      const slipSpeed = Math.abs(vLat);
      slipSum += Math.abs(slipAngle);
      spraySum += slipSpeed * (0.4 + pen[i] * 3);
      report.slipSpeed = slipSpeed;
    }

    // Skidding packs the snow down, so a well-used line gets faster and icier.
    if (this.packTimer > 0.05 && contactCount > 0) {
      this.packTimer = 0;
      this.field.packSnow(this.sBoardCenter.x, this.sBoardCenter.z, 0.6, 0.03 + spraySum * 0.0015);
    }

    this.lastNormalForce = totalNormal;
    this.lastContactCount = contactCount;
    this.lastSlipSum = contactCount > 0 ? slipSum / contactCount : 0;
    this.lastSpraySum = spraySum;
    this.lastEdgeAngle = edgeAngle;
    this.lastSidecutR = sidecutR;
    this.lastCop = totalNormal > 1 ? copMoment / totalNormal : 0;
    this.lastNormalPitch = normalPitch;
    const nComp = this.sContactForce.dot(this.sNormal);
    this.lastLateralG =
      this.sTmpA.copy(this.sContactForce).addScaled(this.sNormal, -nComp).length() /
      (M * this.tuning.gravity);

    if (contactCount > 0) {
      this.applyBalanceAssist(input.lean);
      this.applyPostureControl(input, totalNormal);
    }
    return totalNormal;
  }

  private lastCop = 0;
  private lastLateralG = 0;
  private idealLean = 0;

  /**
   * Fore/aft postural control.
   *
   * Descending, gravity's downhill component acts at the rider's centre of mass
   * roughly 0.9 m above the snow and tries to pitch them over the nose. Standing
   * up against that is not an assist, it is the single most basic thing a rider
   * does, so this runs at a useful gain even with assist at zero. The `weight`
   * input biases the target, which is how presses and butters happen.
   */
  private applyPostureControl(input: RiderInput, normalForce: number): void {
    const pitch = Math.atan2(this.sBodyFwd.dot(this.sNormal), this.sBodyUp.dot(this.sNormal));
    const target = -input.weight * 26 * DEG;
    const error = clamp(target - pitch, -1.0, 1.0);
    const scale = this.totalMass * this.tuning.gravity * this.boardOffset;
    const gain = scale * (1.4 + 1.4 * this.tuning.assist);
    const damping = 2 * 0.9 * Math.sqrt(gain * Math.max(this.currentInertia.x, 0.1));
    const pitchRate = this.angularVelocity.dot(this.sBodyRight);
    // Rolling positively about the body's right axis pitches the rider forward,
    // which lowers the signed pitch angle, so both terms are negated.
    const torque = -error * gain - pitchRate * damping;
    this.sTorque.addScaled(this.sBodyRight, torque * clamp01(normalForce / 200));
  }

  private lastEdgeAngle = 0;
  private lastSidecutR = Infinity;

  /**
   * Effective mass seen by an impulse applied at offset `r` along unit `dir`:
   * 1 / (1/m + (r×dir)·I⁻¹·(r×dir)). This is the standard rigid-body constraint
   * mass, and it is what makes the friction cap above correct rather than a
   * fudge — it accounts for the body rotating away from the impulse.
   */
  private effectiveMassAlong(r: Vec3, dir: Vec3): number {
    const k = _emA.crossVectors(r, dir);
    const local = _emB.copy(k).applyQuatInverse(this.orientation);
    const I = this.currentInertia;
    local.set(local.x / I.x, local.y / I.y, local.z / I.z);
    local.applyQuat(this.orientation);
    const angularTerm = k.dot(local);
    return 1 / (1 / this.totalMass + Math.max(0, angularTerm));
  }

  /**
   * Optional stabilising torque. This is the only place the sim cheats, and how
   * hard it cheats is a slider the player owns.
   *
   * The target is the textbook inclination for the turn the edge is describing,
   * tan(ψ) = v²/(gR) — so even with assist on you are being pushed toward the
   * angle a real rider would be at, not pinned upright.
   */
  private applyBalanceAssist(lean: number): void {
    const a = this.tuning.assist;
    if (a <= 0.001) return;
    const inclination = this.signedRoll(this.sBodyUp, this.sBodyRight);

    // Target the angle at which the *measured* ground reaction points straight
    // through the rider's centre of mass — the textbook balanced lean for
    // whatever turn the edge is currently describing.
    const normal = this.sContactForce.dot(this.sNormal);
    const lateral = this.sTmpA
      .copy(this.sContactForce)
      .addScaled(this.sNormal, -normal)
      .dot(this.sBodyRight);

    // Scale that by how much turn the player actually asked for. Balance on its
    // own is satisfied by *any* radius, including one that keeps tightening:
    // more lean makes more force, which raises the balanced angle, which asks
    // for more lean, and the rider spirals off the fall line without ever
    // touching the controls. Anchoring the target to the input breaks the loop —
    // no input means the rider intends to stand up and run straight, which is
    // exactly what a real rider does when they stop steering.
    const intent = clamp01(Math.abs(lean) * 1.3);
    const rawIdeal = Math.atan2(lateral, Math.max(normal, 1)) * intent;

    // Low-pass the target; the measured force responds to the lean this
    // controller drives, so feeding it back raw is tight enough to oscillate.
    this.idealLean = damp(this.idealLean, rawIdeal, 7, SUBSTEP);
    const error = clamp(this.idealLean - inclination, -1.2, 1.2);

    // Scale against the toppling moment this has to fight: N·r at the contact.
    const topplingScale = this.totalMass * this.tuning.gravity * this.boardOffset;
    const gain = a * topplingScale * 2.6;
    // Damped past critical. The loop gain rises with the square of speed, so a
    // ratio that feels fine at walking pace rings itself apart at 70 km/h.
    const damping = 2 * 1.35 * Math.sqrt(gain * Math.max(this.currentInertia.z, 0.1));
    const rollRate = this.angularVelocity.dot(this.sBodyFwd);
    // Rolling positively about the forward axis *lowers* the signed roll angle,
    // so both terms are negated to drive the error down rather than up.
    const torque = -error * gain - rollRate * damping;
    this.sTorque.addScaled(this.sBodyFwd, torque);
  }

  // -------------------------------------------------------------------------
  // Grinding
  // -------------------------------------------------------------------------

  private tryEngageGrind(input: RiderInput): boolean {
    if (this.state === 'bailed' || this.grindSurfaces.length === 0) return false;
    this.refreshBoardFrame();
    const q = queryGrindSurfaces(this.grindSurfaces, this.sBoardCenter, 0.55, this.sGrindQuery);
    if (!q) return false;

    // You have to arrive from above and roughly along the thing.
    const heightAbove = this.sBoardCenter.y - q.point.y;
    if (heightAbove < -0.22 || heightAbove > 0.45) return false;
    const along = Math.abs(this.sBoardFwd.dot(q.tangent));
    const speed = this.velocity.length();
    if (speed < 1.2) return false;
    // A boardslide is sideways to the rail, so allow anything but a T-bone at
    // speed on a narrow rail.
    if (q.surface.kind === 'rail' && along < 0.25 && !input.grind) return false;
    if (this.velocity.y > 2.5) return false;

    this.grind = q.surface;
    this.grindAlong = q.along;
    this.grindEntry = q.along;
    this.grindBalance = clamp(q.distance / Math.max(0.12, q.surface.halfWidth + 0.12), -1, 1) * 0.25;
    this.grindBalanceRate = 0;
    this.transition('grinding', 'engaged a rail');
    this.events.push({ type: 'grindStart', time: this.time, surfaceId: q.surface.id, speed });
    return true;
  }

  private solveGrind(input: RiderInput): number {
    const surface = this.grind;
    if (!surface) {
      this.transition('riding', 'rail vanished');
      return 0;
    }
    const M = this.totalMass;
    const q = queryGrindSurfaces([surface], this.sBoardCenter, 6, this.sGrindQuery);
    if (!q) {
      this.releaseGrind();
      return 0;
    }

    // Ran off the end.
    if (q.along <= 0.05 || q.along >= surface.totalLength - 0.05) {
      const past = this.sTmpA.subVectors(this.sBoardCenter, q.point).dot(q.tangent);
      if (Math.abs(past) > 0.4) {
        this.releaseGrind();
        return 0;
      }
    }
    this.grindAlong = q.along;

    // Rail frame.
    const tangent = this.sTmpA.copy(q.tangent);
    this.grindTangentVec.copy(tangent);
    const up = this.sTmpB.set(0, 1, 0);
    const side = this.sTmpC.crossVectors(tangent, up).normalize();

    // Vertical support, applied at the rail so the body above it is an inverted
    // pendulum you have to actively balance.
    const drop = q.point.y - this.sBoardCenter.y;
    const vAtRail = this.sContactVel
      .crossVectors(this.angularVelocity, this.sTmpD.subVectors(q.point, this.position))
      .add(this.velocity);
    const vUp = vAtRail.y;
    const k = 42000;
    const c = 2 * 0.7 * Math.sqrt(k * M);
    let normalForce = k * drop - c * vUp;
    normalForce = clamp(normalForce, 0, 26000);

    this.sTmpD.set(0, normalForce, 0);
    this.sForce.add(this.sTmpD);
    const r = _rTmp.subVectors(q.point, this.position);
    this.sTorque.add(_tTmp.crossVectors(r, this.sTmpD));

    // Sliding friction along the rail, plus much higher resistance sideways.
    const vAlong = vAtRail.dot(tangent);
    const vSide = vAtRail.dot(side);
    const fAlong = -sign(vAlong) * normalForce * surface.friction;
    const fSide = -clamp(vSide * 320, -normalForce * 1.4, normalForce * 1.4);
    this.sTmpD.copy(tangent).scale(fAlong).addScaled(side, fSide);
    this.sForce.add(this.sTmpD);
    this.sTorque.add(_tTmp.crossVectors(r, this.sTmpD));

    // Balance. The rail is a pivot and the rider is an inverted pendulum on top
    // of it: gravity already destabilises this through the normal force applied
    // at the rail, so all that is needed here is the rider's own correction.
    const comOffset = _rTmp.subVectors(this.position, q.point).dot(side);
    const comRate = this.velocity.dot(side);
    const tolerance = 0.16 + surface.halfWidth * 1.5 + (1 - surface.instability) * 0.5;
    const rawBalance = comOffset / tolerance;
    this.grindBalance = rawBalance;
    this.grindBalanceRate = comRate;

    // A positive torque about the rail tangent swings the rider toward +side,
    // so correcting a +side lean needs a negative one.
    const authority = 240 * (0.5 + 0.5 * this.tuning.assist);
    const playerTorque = input.lean * authority * sign(this.sBodyRight.dot(side));
    const assistKp = this.tuning.assist * 900;
    const assistKd = this.tuning.assist * 260;
    const correction = -(comOffset * assistKp + comRate * assistKd);
    this.sTorque.addScaled(tangent, correction + playerTorque);

    if (Math.abs(rawBalance) > 1.35) {
      this.releaseGrind();
      if (Math.abs(rawBalance) > 1.9) this.bail('slipped off the rail');
      return normalForce;
    }

    // Popping off is just releasing the legs — same as anywhere else.
    if (input.crouch < 0.15 && this.legVelocity > 1.6) {
      this.releaseGrind();
    }

    this.lastNormalForce = normalForce;
    this.lastContactCount = 1;
    this.lastSlipSum = 0;
    this.lastSpraySum = 0;
    return normalForce;
  }

  private releaseGrind(): void {
    if (!this.grind) return;
    this.events.push({
      type: 'grindEnd',
      time: this.time,
      surfaceId: this.grind.id,
      speed: this.velocity.length(),
    });
    this.grind = null;
    this.grindCooldown = 0.25;
    if (this.state === 'grinding') this.transition('airborne', 'popped off the rail');
  }

  // -------------------------------------------------------------------------
  // Legs
  // -------------------------------------------------------------------------

  /**
   * The one internal degree of freedom.
   *
   * r̈ = F_leg/µ − F_contact/m_gear, where µ is the reduced mass of the rider and
   * the gear. Extending drives the light gear down hard into the snow and the
   * reaction lifts the rider — which is exactly what an ollie is.
   */
  /**
   * Push through where you are actually loaded.
   *
   * The leg drives the gear down and the snow pushes back at the centre of
   * pressure. On flat ground the centre of pressure sits under the rider and
   * the reaction is a clean lift. As a ramp ends it moves back under the tail,
   * and the same extension then has a moment arm about the centre of mass —
   * so a strong pop off a lip pitches the rider forward. Hands off the
   * controls on the reference kicker that was 123 degrees of pitch and a
   * frontflip nobody asked for.
   *
   * A real skier does not eat that. They push through the foot that is loaded
   * and hold the fore-aft with ankle and core, which is exactly a moment about
   * the lateral axis opposing the one the extension creates. The rider here is
   * rigid and cannot, so it is applied explicitly.
   *
   * Two things keep this from being an auto-balance assist. It is gated on the
   * leg actually extending fast — it is the pop, not a permanent hand on the
   * tiller — and it cancels a fraction rather than all of it, so a badly
   * balanced pop off the tail still pitches, just not into a somersault.
   */
  private applyPopBalance(): void {
    if (!onGround(this.state)) return;
    if (this.legVelocity < POP_BALANCE_RATE) return;
    // Cancel a fraction of the moment the snow is actually applying, not a
    // guess at it. Because it is the measured quantity, one fraction works on
    // every jump instead of needing a different fudge per kicker.
    this.sTorque.addScaled(this.sLatS, -POP_BALANCE * this.lastNormalPitch);
  }

  private integrateLeg(dt: number, input: RiderInput, contactForce: number): void {
    const minLeg = 0.5;
    const maxLeg = 1.02;
    const gearMass = this.gear.mass;
    const mu = (this.riderMass * gearMass) / (this.riderMass + gearMass);
    const kLeg = 7400 * this.gear.pop * this.ride.popGain;
    const cLeg = 620;
    const maxForce = 4200 * this.gear.pop * this.ride.popGain;

    // The commanded length.
    //
    // What follows is the diagnosis of a real defect that is NOT fixed here,
    // written down because it took a long measurement to find and the next
    // attempt should not have to repeat it. `CROUCH_RATE` and `legTarget` are
    // the machinery for the fix; the rate limit itself is off, because it
    // cannot ship on its own. See the note at the end.
    //
    // The command jumps
    // straight to the crouched length, and since the spring is push-only it
    // returns exactly zero the moment the command falls below the current
    // length — so the leg went slack and the rider free-fell through the entire
    // load. Traced on flat ground: contact force 0.0 kN for 250 ms while
    // vertical velocity ran from -0.34 to -2.67 m/s, then a 9 g slam into the
    // bump stop, and only then a pop that had to spend most of itself
    // cancelling the fall it had just caused.
    //
    // That one line explains all three symptoms reported against this solver.
    // The uncommanded frontflip off a lip: the legs are slack, so the ramp
    // ending puts the whole reaction through one end of the gear. The
    // non-monotonic rotation ladder and the non-monotonic airtime: how much
    // downward velocity the free-fall accumulated depends on how long the load
    // ran, and the pop has to cancel it before it can lift anything, so a
    // longer load can easily be worse than a shorter one.
    //
    // A skier bending their knees does not take their weight off the snow, so
    // the fix is to rate-limit how fast the command may shorten. That works:
    // with it on, contact is held through the load and the 9 g bottom-out is
    // gone.
    //
    // It cannot ship alone. Removing the free-fall removes most of what the
    // jump was actually made of — with the limit on and the leg at its current
    // strength, a tap buys 0.03 s of air, which is no jump at all. Restoring a
    // real jump needs the leg roughly twice as stiff (`popGain` 2), and that
    // lands the spec's airtime table exactly: 200 ms load -> 0.48 s, 320 ->
    // 1.19, 400 -> 1.23, against targets of 0.4 and 1.0-1.2.
    //
    // And a leg that strong throws the rider off a ramp. Hands off the
    // controls on the T9 reference kicker, `popGain` 2 gives 123 degrees of
    // pitch and a named frontflip nobody asked for, against 90 degrees and no
    // inversion at gain 1. Isolated: the frontflip tracks `popGain` alone and
    // is identical with the rate limit on or off. The leg fires through a
    // fixed point rather than through the centre of pressure, so as the ramp
    // ends and support moves under the tail, a strong extension pitches the
    // rider forward.
    //
    // So the remaining work is to make the pop push through the contact
    // patch's centre of pressure. Until then the safe configuration is the one
    // shipped here: the stop fixes above, which are unambiguously correct on
    // their own, with the rate limit off and the leg at its original strength.
    const wanted = lerp(maxLeg, minLeg + 0.06, clamp01(input.crouch));
    this.legTarget =
      wanted < this.legTarget ? Math.max(wanted, this.legTarget - CROUCH_RATE * dt) : wanted;
    const target = this.legTarget;
    const sub = dt / LEG_SUBSTEPS;
    let peak = 0;

    for (let i = 0; i < LEG_SUBSTEPS; i++) {
      // The muscle. Push-only — a leg cannot pull the gear up — and limited to
      // what the rider can actually produce.
      let f = clamp(kLeg * (target - this.legLength) - cLeg * this.legVelocity, 0, maxForce);

      // The stops, as compression-only elements with one-sided damping.
      //
      // The damping term used to be `- 2600 * legVelocity` with no sign test,
      // which resists motion in *both* directions. Below the stop that is
      // 2600 N per m/s fighting the leg on its way back out — so a pop that
      // started from a bottomed-out leg was cancelled by the stop that had just
      // caught it, and "the release adds nothing" was literally true. A real
      // bump stop resists being driven further in and does nothing at all on
      // the way out, which is what these do now.
      //
      // Both are bounded. The old ones were added *after* the force limit, so
      // 240000 N/m of penetration went in unclamped and the impulse a landing
      // delivered depended on how far the integrator happened to overshoot in
      // one substep.
      if (this.legLength < minLeg) {
        const depth = minLeg - this.legLength;
        const into = Math.min(0, this.legVelocity);
        f += Math.min(BUMP_K * depth - BUMP_C * into, BUMP_MAX);
      } else if (this.legLength > maxLeg) {
        const depth = this.legLength - maxLeg;
        const into = Math.max(0, this.legVelocity);
        f -= Math.min(TOP_K * depth + TOP_C * into, BUMP_MAX);
      }

      peak = Math.max(peak, f);
      const accel = f / mu - contactForce / gearMass;
      this.legVelocity += accel * sub;
      this.legLength += this.legVelocity * sub;

      // Travel limits, as a last resort only. These used to sit 16 cm inside
      // the bump stop and zero the velocity when hit, which threw away kinetic
      // energy at a moment that depended on the phase of the oscillation — the
      // same load held 20 ms longer would or would not hit it, and the pop that
      // came out differed by a factor of two either way. The stops above are
      // now stiff enough to turn the leg round before it gets here, so this is
      // a guard against a divergent step rather than part of the model.
      if (this.legLength < LEG_HARD_MIN) {
        this.legLength = LEG_HARD_MIN;
        if (this.legVelocity < 0) this.legVelocity = 0;
      } else if (this.legLength > LEG_HARD_MAX) {
        this.legLength = LEG_HARD_MAX;
        if (this.legVelocity > 0) this.legVelocity = 0;
      }
    }

    this.legForce = peak;
    if (this.state !== 'airborne') this.peakLegForce = Math.max(this.peakLegForce, peak);
    if (peak > 11000) {
      this.events.push({ type: 'bottomOut', time: this.time, impact: peak });
    }
  }

  // -------------------------------------------------------------------------
  // Control
  // -------------------------------------------------------------------------

  /**
   * Steering, on the snow and in the air.
   *
   * ## The air model, and the numbers it is tuned to
   *
   * A rider in the air is a closed system. Nothing outside the body can add
   * angular momentum to it, so the only honest way to let a player rotate is to
   * let them trade: wind one part of the body against another, and the rest of
   * the body turns the other way. That is what `airBudget` is. Each axis holds a
   * signed reservoir, pushing spends it, and once it is spent that direction is
   * finished until the body unwinds. It is not a stamina bar and it is not a
   * cooldown — it is the reason a real skier cannot keep adding rotation
   * forever, and removing it would make the whole simulation a lie.
   *
   * What the reservoir does *not* decide is how much rotation one full draw is
   * worth. That is `AIR_GAIN_*`, and it is a feel number rather than a physical
   * one, so it is set from a measurement rather than from an argument.
   *
   * The reference jump, which every one of these numbers was measured against:
   * a 6 m table, 40 km/h at the lip, stock park snowboard, keyboard only, no
   * rotation wound up on the ground, popped cleanly. That is 1.9 seconds of air.
   *
   *   540  reachable    — hold the spin key off the lip and ride it out
   *   720  hard         — needs the reservoir released and drawn a second time,
   *                       and only some release timings get there
   *   1080 unreachable  — 653 deg is the best of sixty hold-and-pump timings,
   *                       and 1080 needs 990
   *
   * `AIR_FILL` sets how fast a held key spends the reservoir: at 1.1 per second
   * it empties over roughly 0.9 s, so holding from the lip is the natural play
   * rather than a tap at exactly the right instant, and it is worth one clean
   * 540. Everything above that has to come from `AIR_RELAX_FREE` — letting the
   * axis go, letting the body unwind, and going again inside the same air.
   *
   * A cork 5 lands with spin and side-flip held together off the lip. That is
   * the trick the whole control model exists to produce, so it is the one the
   * roll gain is set by: at 12 it comes out a 360, at 14 a 540.
   *
   * If these targets are ever re-measured, re-measure them on that jump. A
   * different lip, a different speed or a different board is a different number
   * and proves nothing about this one.
   */
  private applyControlTorques(dt: number, input: RiderInput, contactForce: number): void {
    const grounded = contactForce > 60;

    if (grounded) {
      // Twisting the upper body steers the gear, reacting against the edge. The
      // harder the edge is loaded, the more authority you have.
      const grip = clamp01(contactForce / (this.totalMass * this.tuning.gravity * 1.4));
      const yawTorque = input.twist * 52 * grip * this.ride.turnGain;
      this.sTorque.addScaled(this.sNormal, yawTorque);

      this.applyDirectionalHold(dt, input, grip);

      // Weighting the nose or tail pitches the body over the contact patch.
      const pitchTorque = -input.weight * 26 * grip;
      this.sTorque.addScaled(this.sBodyRight, pitchTorque);

      // Bleed the air-control reservoir back while you are on the ground.
      this.airBudget.scale(Math.exp(-4 * dt));
      return;
    }

    // Airborne: limited authority. You cannot manufacture angular momentum out
    // of nothing, so every axis draws down a reservoir that recovers slowly.
    const I = this.currentInertia;
    const authority = 1 - this.tuning.assist * 0.15;
    this.applyAirAxis(dt, this.sBodyUp, input.airYaw, AIR_GAIN_YAW * I.y, 'y', authority);
    this.applyAirAxis(dt, this.sBodyRight, input.airPitch, AIR_GAIN_PITCH * I.x, 'x', authority);
    this.applyAirAxis(dt, this.sBodyFwd, input.airRoll, AIR_GAIN_ROLL * I.z, 'z', authority);

    // Unwinding recovers the reservoir, and it recovers faster on an axis the
    // rider is not currently pushing. That is what separates a 540 from a 720:
    // hold the key from the lip and you get one full draw, which is a clean 540
    // and nothing more. Let go, let the body come back, and go again, and there
    // is a second draw in it — but only if the air is long enough and the timing
    // is right, which is exactly where the difficulty of a 720 should live.
    this.relaxAirAxis(dt, 'y', input.airYaw);
    this.relaxAirAxis(dt, 'x', input.airPitch);
    this.relaxAirAxis(dt, 'z', input.airRoll);
  }

  /**
   * Keeping the board pointed along the line you are travelling.
   *
   * A board is directionally neutral — the pressure is symmetric fore and aft,
   * so nothing weathervanes it straight and the smallest disturbance integrates
   * into a spin-out over a few seconds. Real riders are not passive; they hold
   * the line continuously with their ankles and hips. That is what this is. It
   * drives the slip angle toward zero, which is also exactly the pure-carve
   * condition, so it cooperates with the edge rather than fighting it, and the
   * twist input backs it off so deliberate slides and butters still work.
   */
  private applyDirectionalHold(dt: number, input: RiderInput, grip: number): void {
    const vs = this.sTmpA.copy(this.velocity).removeComponentAlong(this.sNormal);
    const speed = vs.length();
    if (speed < 1.5) {
      this.prevBeta = 0;
      return;
    }
    const vLong = vs.dot(this.sFwdS);
    const vLat = vs.dot(this.sLatS);
    const beta = -Math.atan2(vLat, Math.abs(vLong) + 0.3);
    const betaRate = dt > 0 ? angleDelta(this.prevBeta, beta) / dt : 0;
    this.prevBeta = beta;

    // Reversing into switch should not read as a 180-degree error.
    if (Math.abs(beta) > 1.3) return;

    const I = this.currentInertia.y;
    const strength =
      (0.4 + 0.6 * this.tuning.assist) * grip * (1 - Math.min(1, Math.abs(input.twist))) * this.ride.holdGain;
    const kp = I * 46 * strength;
    const kd = I * 9 * strength;
    this.sTorque.addScaled(this.sNormal, -beta * kp - betaRate * kd);
  }

  private prevBeta = 0;

  /**
   * Bleeds one axis of the reservoir back toward neutral.
   *
   * Held, it barely recovers — you cannot push against a body that is already
   * wound out. Released, it comes back several times faster, because letting the
   * limbs return is the whole mechanism.
   */
  private relaxAirAxis(dt: number, key: 'x' | 'y' | 'z', command: number): void {
    // Blended rather than switched. The key is smoothed on its way in, so it
    // spends a tenth of a second on the way down through any threshold you pick,
    // and a hard cut-off there decides the whole feel of a pumped rotation on
    // rounding. How much the body is still pushing is a quantity, so treat it
    // as one.
    const push = Math.min(1, Math.abs(command));
    const rate = AIR_RELAX_FREE + (AIR_RELAX_HELD - AIR_RELAX_FREE) * push;
    this.airBudget[key] *= Math.exp(-rate * dt);
  }

  private applyAirAxis(
    dt: number,
    axis: Vec3,
    command: number,
    scale: number,
    key: 'x' | 'y' | 'z',
    authority: number,
  ): void {
    if (Math.abs(command) < 0.01) return;
    const used = this.airBudget[key];
    // Once the body is wound out in one direction there is nothing left to pull
    // against; you have to unwind before you can push that way again.
    const headroom = clamp01(1 - used * sign(command));
    if (headroom <= 0.001) return;
    const torque = command * scale * headroom * authority;
    this.sTorque.addScaled(axis, torque);
    this.airBudget[key] = clamp(used + command * dt * AIR_FILL, -1, 1);
  }

  // -------------------------------------------------------------------------
  // State transitions
  // -------------------------------------------------------------------------

  /**
   * The only writer of `state`.
   *
   * A no-op bounces rather than resetting `stateTime`, so "how long have I been
   * airborne" stays true even if something asks for the state it is already in.
   */
  private transition(next: RiderState, reason: string): void {
    if (next === this.state) return;
    this.lastTransition = `${this.state} -> ${next}: ${reason}`;
    this.state = next;
    this.stateTime = 0;
  }

  private updateFlightState(dt: number, contactForce: number, input: RiderInput): void {
    this.stateTime += dt;
    if (this.state === 'airborne') this.spinSinceTakeoff += this.angularVelocity.y * dt;
    if (this.state === 'grinding') {
      this.airTime = 0;
      this.groundedTime += dt;
      return;
    }
    if (this.state === 'bailed') {
      this.bailTimer -= dt;
      // Sliding to a near stop only happens on a flat runout. On any real pitch
      // a crashed rider keeps sliding, so recovery waits for the timer plus
      // being back on the snow at a survivable speed, with a hard cap so it can
      // never strand the player.
      const grounded = contactForce > 200;
      const slowEnough = this.velocity.lengthSq() < 210;
      const settled = grounded && slowEnough;
      if (this.bailTimer <= -3 || (this.bailTimer <= 0 && settled)) {
        this.transition('riding', 'recovered');
        this.bailReason = '';
        this.angularMomentum.scale(0.1);
        this.events.push({ type: 'recover', time: this.time });
      }
      return;
    }

    const airborne = contactForce < 45;
    if (airborne) {
      this.airTime += dt;
      this.groundedTime = 0;
      if (this.state !== 'airborne' && this.airTime > 0.05) {
        this.transition('airborne', 'takeoff');
        this.spinSinceTakeoff = 0;
        this.lastTakeoffSpeed = this.velocity.length();
        this.peakLegForce = 0;
        this.events.push({ type: 'takeoff', time: this.time, speed: this.lastTakeoffSpeed });
      }
    } else {
      this.groundedTime += dt;
      if (this.state === 'airborne' && this.groundedTime > 0.02) {
        const quality = this.landingQuality();
        this.transition('landing', 'touchdown');
        this.events.push({
          type: 'landing',
          time: this.time,
          impact: this.peakLegForce,
          quality,
          speed: this.velocity.length(),
        });
        this.airTime = 0;
      }
      if (this.state !== 'airborne') this.airTime = 0;

      // Grounded windows, in priority order: absorbing a landing beats loading
      // the next pop, because you cannot pop out of a compression you have not
      // finished taking.
      if (this.state === 'landing' && this.stateTime >= LANDING_ABSORB) {
        this.transition('riding', 'absorbed');
      }
      if (this.state === 'riding' && input.crouch > CROUCH_ENTER) {
        this.transition('crouching', 'loading a pop');
      } else if (this.state === 'crouching' && input.crouch < CROUCH_EXIT) {
        this.transition('riding', 'released the load');
      }
    }
  }

  /**
   * How well the gear was pointed when it touched down. 1 is dead square to the
   * direction of travel and flat to the slope; 0 is sideways and edge-first.
   */
  private landingQuality(): number {
    const speed = this.velocity.length();
    if (speed < 0.5) return 1;
    const vDir = this.sTmpA.copy(this.velocity).normalize();
    const alignment = Math.abs(this.sBoardFwd.dot(vDir));
    const flatness = clamp01(this.sBoardUp.dot(this.sNormal));
    const impactPenalty = clamp01(1 - this.peakLegForce / 14000);
    return clamp01(alignment * 0.45 + flatness * 0.3 + impactPenalty * 0.25);
  }

  private checkBail(input: RiderInput, contactForce: number): void {
    if (this.state === 'bailed' || this.state === 'airborne') return;

    // Cased it: legs slammed shut harder than a body can absorb.
    if (this.peakLegForce > 15500) {
      this.bail('cased the landing');
      return;
    }

    if (contactForce > 60) {
      const speed = this.velocity.length();
      if (speed > 6) {
        const vDir = this.sTmpA.copy(this.velocity).normalize();
        const alignment = Math.abs(this.sBoardFwd.dot(vDir));
        const edgeAngle = Math.abs(this.signedRoll(this.sBoardUp, this.sBoardRight));
        // Landing sideways onto a loaded edge is a caught edge, every time.
        if (alignment < 0.32 && edgeAngle > 26 * DEG && this.groundedTime < 0.3) {
          this.bail('caught an edge');
          return;
        }
      }
      // Toppled over past the point a human could recover from.
      const inclination = Math.abs(this.signedRoll(this.sBodyUp, this.sBodyRight));
      if (inclination > 82 * DEG && speed < 22) {
        this.bail('lost the edge');
        return;
      }
      // Landed upside down.
      if (this.sBodyUp.y < -0.15 && speed > 3) {
        this.bail('landed inverted');
        return;
      }
    }
    void input;
  }

  bail(reason: string): void {
    if (this.state === 'bailed') return;
    this.transition('bailed', reason);
    this.bailReason = reason;
    this.bailTimer = 1.4;
    this.grind = null;
    this.poles[0].planted = false;
    this.poles[1].planted = false;
    // Dump some energy into tumbling so the crash reads as a crash.
    this.angularMomentum.addScaled(this.sBodyRight, this.velocity.length() * 2.5);
    this.velocity.scale(0.72);
    this.events.push({ type: 'bail', time: this.time, reason, speed: this.velocity.length() });
  }

  private enforceBounds(): void {
    const f = this.field;
    const margin = 2;
    this.position.x = clamp(this.position.x, f.minX + margin, f.maxX - margin);
    this.position.z = clamp(this.position.z, f.minZ + margin, f.maxZ - margin);

    // Never let a numerical blow-up leave the rider in a broken state.
    if (!this.position.isFinite() || !this.velocity.isFinite()) {
      this.reset(this.level.spawn.x, this.level.spawn.z, this.level.spawn.heading);
      return;
    }
    const ground = f.heightAt(this.position.x, this.position.z);
    if (this.position.y < ground - 4) {
      this.position.y = ground + this.boardOffset;
      this.velocity.y = Math.max(0, this.velocity.y);
    }
    const maxSpeed = 75;
    const sp = this.velocity.length();
    if (sp > maxSpeed) this.velocity.scale(maxSpeed / sp);
    const maxSpin = 45;
    const spin = this.angularMomentum.length();
    if (spin > maxSpin * 12) this.angularMomentum.scale((maxSpin * 12) / spin);
  }

  // -------------------------------------------------------------------------

  private updateTelemetry(): void {
    const t = this.telemetry;
    const M = this.totalMass;
    t.state = this.state;
    t.speed = this.velocity.length();
    t.edgeAngle = this.lastEdgeAngle * RAD;
    t.inclination = this.signedRoll(this.sBodyUp, this.sBodyRight) * RAD;
    t.slipAngle = this.lastSlipSum * RAD;
    // A carve is a slip angle near zero; anything past ~12 degrees is a skid.
    t.carveQuality = clamp01(1 - this.lastSlipSum / (12 * DEG));
    t.gForce = this.lastNormalForce / (M * this.tuning.gravity);
    t.stateTime = this.stateTime;
    t.lastTransition = this.lastTransition;
    this.getBoardAxes(this.sTelRight, this.sTelUp, this.sTelFwd);
    t.switchStance = this.velocity.lengthSq() > 2.25 && this.sTelFwd.dot(this.velocity) < 0;
    t.spinDeg = this.spinSinceTakeoff * RAD;
    t.spinRate = this.angularVelocity.y * RAD;
    // acos of body-up against world-up: 0 is upright, 90 is on its side.
    t.tiltDeg = Math.acos(clamp(this.sTelUp.y, -1, 1)) * RAD;
    t.airborne = this.state === 'airborne';
    t.airTime = this.airTime;
    t.altitude = this.sBoardCenter.y - this.field.heightAt(this.sBoardCenter.x, this.sBoardCenter.z);
    t.legLength = this.legLength;
    t.legForce = this.legForce;
    t.turnRadius = Math.abs(this.lastEdgeAngle) > 2 * DEG ? this.lastSidecutR : Infinity;
    t.contactCount = this.lastContactCount;
    t.sprayIntensity = clamp01(this.lastSpraySum / 90);
    t.grindSurfaceId = this.grind ? this.grind.id : null;
    t.grindBalance = clamp(this.grindBalance, -1.5, 1.5);
    t.grindDistance = this.grind ? Math.abs(this.grindAlong - this.grindEntry) : 0;
    t.grindBalanceRate = this.grindBalanceRate;
    t.pressureCentre = this.lastCop;
    t.lateralG = this.lastLateralG;
    t.poleForce = this.poles[0].force + this.poles[1].force;
    t.poleSupport = this.poles[0].support + this.poles[1].support;
    t.bailReason = this.bailReason;
  }

  /** Tangent of the rail being ground, or null when not on one. */
  get grindTangent(): Vec3 | null {
    return this.grind ? this.grindTangentVec : null;
  }

  /** World-space board centre, for rendering and trick detection. */
  getBoardCenter(out: Vec3): Vec3 {
    return out.copy(this.sBoardCenter);
  }

  getBoardAxes(right: Vec3, up: Vec3, forward: Vec3): void {
    right.copy(this.sBoardRight);
    up.copy(this.sBoardUp);
    forward.copy(this.sBoardFwd);
  }

  getBodyAxes(right: Vec3, up: Vec3, forward: Vec3): void {
    right.copy(this.sBodyRight);
    up.copy(this.sBodyUp);
    forward.copy(this.sBodyFwd);
  }

  drainEvents(sink: SimEvent[]): void {
    for (const e of this.events) sink.push(e);
    this.events.length = 0;
  }
}

const _localZ = new Vec3(0, 0, 1);
const _boardQuat = new Quat();
const _weights = new Float64Array(CONTACT_SAMPLES);
const _penetration = new Float64Array(CONTACT_SAMPLES);
const _normalForce = new Float64Array(CONTACT_SAMPLES);
const _flexTmp = new Float64Array(CONTACT_SAMPLES);
const _zPos = new Float64Array(CONTACT_SAMPLES);
const _rTmp = new Vec3();
const _poleHand = new Vec3();
const _poleTip = new Vec3();
const _poleDirTmp = new Vec3();
const _poleForce = new Vec3();
const _poleR = new Vec3();
const _poleTorque = new Vec3();

function blankPole(): PoleReport {
  return {
    planted: false,
    tipX: 0,
    tipY: 0,
    tipZ: 0,
    handX: 0,
    handY: 0,
    handZ: 0,
    force: 0,
    push: 0,
    support: 0,
    restLength: 0,
  };
}
const _emA = new Vec3();
const _emB = new Vec3();
const _tTmp = new Vec3();
