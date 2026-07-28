import { Vec3, clamp, clamp01, damp, lerp } from '../core/math.ts';
import type { Heightfield } from '../world/heightfield.ts';
import type { RiderSim } from './riderSim.ts';
import { getGrab, type GrabId } from './grabs.ts';

/**
 * Joints of the rider skeleton, in a fixed order.
 *
 * One pose type serves both producers: a procedural pose while the rider is in
 * control, and the ragdoll solver once they are not. The renderer never needs to
 * know which one it is looking at.
 */
export const JOINTS = [
  'head',
  'neck',
  'chest',
  'pelvis',
  'shoulderL',
  'elbowL',
  'handL',
  'shoulderR',
  'elbowR',
  'handR',
  'hipL',
  'kneeL',
  'footL',
  'hipR',
  'kneeR',
  'footR',
] as const;

export type JointName = (typeof JOINTS)[number];
export const JOINT_INDEX = Object.fromEntries(JOINTS.map((n, i) => [n, i])) as Record<JointName, number>;
export const JOINT_COUNT = JOINTS.length;

/** Bones, as index pairs into the joint array, with their rest lengths. */
interface Bone {
  a: number;
  b: number;
  length: number;
  /** 0-1; lower is floppier. Used as the constraint relaxation factor. */
  stiffness: number;
}

const J = JOINT_INDEX;

/** Proportions of a 1.78 m rider, in metres. */
const SEGMENT = {
  neckToHead: 0.16,
  chestToNeck: 0.19,
  pelvisToChest: 0.32,
  shoulderSpan: 0.19,
  upperArm: 0.30,
  forearm: 0.28,
  hipSpan: 0.11,
  thigh: 0.43,
  shin: 0.42,
};

function buildBones(): Bone[] {
  const bones: Bone[] = [];
  const add = (a: number, b: number, length: number, stiffness = 1) => bones.push({ a, b, length, stiffness });

  add(J.neck, J.head, SEGMENT.neckToHead);
  add(J.chest, J.neck, SEGMENT.chestToNeck);
  add(J.pelvis, J.chest, SEGMENT.pelvisToChest);

  add(J.chest, J.shoulderL, SEGMENT.shoulderSpan);
  add(J.chest, J.shoulderR, SEGMENT.shoulderSpan);
  add(J.shoulderL, J.elbowL, SEGMENT.upperArm, 0.9);
  add(J.shoulderR, J.elbowR, SEGMENT.upperArm, 0.9);
  add(J.elbowL, J.handL, SEGMENT.forearm, 0.9);
  add(J.elbowR, J.handR, SEGMENT.forearm, 0.9);

  add(J.pelvis, J.hipL, SEGMENT.hipSpan);
  add(J.pelvis, J.hipR, SEGMENT.hipSpan);
  add(J.hipL, J.kneeL, SEGMENT.thigh);
  add(J.hipR, J.kneeR, SEGMENT.thigh);
  add(J.kneeL, J.footL, SEGMENT.shin);
  add(J.kneeR, J.footR, SEGMENT.shin);

  // Cross-braces. Without these the torso folds flat and the shoulders collapse
  // through the chest on the first hard impact.
  add(J.pelvis, J.shoulderL, 0.42, 0.5);
  add(J.pelvis, J.shoulderR, 0.42, 0.5);
  add(J.shoulderL, J.shoulderR, SEGMENT.shoulderSpan * 2, 0.7);
  add(J.hipL, J.hipR, SEGMENT.hipSpan * 2, 0.8);
  add(J.chest, J.hipL, 0.36, 0.4);
  add(J.chest, J.hipR, 0.36, 0.4);
  add(J.neck, J.shoulderL, 0.24, 0.5);
  add(J.neck, J.shoulderR, 0.24, 0.5);

  return bones;
}

const BONES = buildBones();

export interface RiderPose {
  /** World-space joint positions, JOINT_COUNT entries. */
  joints: Vec3[];
  /** Board centre and orientation basis, for drawing the gear. */
  boardCenter: Vec3;
  boardRight: Vec3;
  boardUp: Vec3;
  boardForward: Vec3;
  /** True while the ragdoll owns the pose. */
  limp: boolean;
  /** Solved pole tips, left then right. Skis only. */
  poleTips: [Vec3, Vec3];
  polePlanted: [boolean, boolean];
  /**
   * Smoothed motion state carried between frames.
   *
   * A rider's arms do not teleport to wherever the numbers say this instant —
   * they lag, overshoot and settle, and a landing keeps affecting them for
   * about half a second after the impact is over. That needs memory, and the
   * pose is the only thing that persists per rider, so it lives here. Every
   * value is a smoothed 0..1 or -1..1; nothing here is read by the simulation.
   */
  motion: RiderMotion;
}

export interface RiderMotion {
  /** Arm swing around the body's vertical, leading a spin. -1..1. */
  lead: number;
  /** How far the arms are up and open. 0 settled, 1 fully out. */
  lift: number;
  /** Landing shock, spikes to 1 on a hard touchdown and decays away. */
  shock: number;
  /** Inside-hand drop through a railed carve. -1..1, signed by edge. */
  carve: number;
  /** Chest lag behind the pelvis through a rotation, radians. */
  spineLag: number;
  /** Head yaw toward where the rotation is going, radians. */
  headLead: number;
  /** Previous leg length, so a pop can be told from a compression. */
  lastLeg: number;
}

export function makeMotion(): RiderMotion {
  return { lead: 0, lift: 0, shock: 0, carve: 0, spineLag: 0, headLead: 0, lastLeg: 0.92 };
}

export function makePose(): RiderPose {
  return {
    joints: Array.from({ length: JOINT_COUNT }, () => new Vec3()),
    boardCenter: new Vec3(),
    boardRight: new Vec3(1, 0, 0),
    boardUp: new Vec3(0, 1, 0),
    boardForward: new Vec3(0, 0, 1),
    limp: false,
    poleTips: [new Vec3(), new Vec3()],
    polePlanted: [false, false],
    motion: makeMotion(),
  };
}

const _right = new Vec3();
const _up = new Vec3();
const _fwd = new Vec3();
const _tmp = new Vec3();
const _poleRest = new Vec3();
const _poleArm = new Vec3();

/** Grip-to-tip length of a pole, matching the model the renderer draws. */
const POLE_HANG = 1.1;

/**
 * Poses the rider while they are still in control.
 *
 * Everything here is driven by simulation state rather than animation: the knees
 * bend by exactly the leg compression the solver computed, the torso counter-
 * rotates by the twist input, and the grabbing hand is placed at the real
 * position on the gear that the grab is defined to reach.
 */
export function poseFromRider(
  sim: RiderSim,
  pose: RiderPose,
  opts: { grab: GrabId | null; twist: number; tuck: number; goofy: boolean; dt?: number },
): RiderPose {
  sim.getBodyAxes(_right, _up, _fwd);
  const joints = pose.joints;
  const com = sim.position;

  // Leg compression drives how deep the stance is.
  const legs = sim.legLength;
  const crouch = clamp01((1.0 - legs) / 0.5);
  const tuck = clamp01(opts.tuck);

  const motion = pose.motion;
  updateMotion(motion, sim, _up, opts.dt ?? 1 / 60, crouch, tuck);

  sim.getBoardCenter(pose.boardCenter);
  sim.getBoardAxes(pose.boardRight, pose.boardUp, pose.boardForward);

  const set = (index: number, up: number, right: number, fwd: number) => {
    joints[index]
      .copy(com)
      .addScaled(_up, up)
      .addScaled(_right, right)
      .addScaled(_fwd, fwd);
  };

  /** As `set`, but rotated about the body's vertical by `turn` radians. */
  const setTurned = (index: number, up: number, right: number, fwd: number, turn: number) => {
    const c = Math.cos(turn);
    const sn = Math.sin(turn);
    joints[index]
      .copy(com)
      .addScaled(_up, up)
      .addScaled(_right, right * c - fwd * sn)
      .addScaled(_fwd, right * sn + fwd * c);
  };

  // Torso, measured from the centre of mass which sits around the navel.
  //
  // The spine is not rigid. Through a rotation the chest lags the pelvis and
  // then catches up, and the head goes further still in the other direction —
  // a skier looks where the spin is going before the body arrives. Both are
  // single springs in `motion`, not keyframes, so they fall out of whatever the
  // rider is actually doing.
  const spineLean = lerp(0, -0.22, tuck);
  const lag = motion.spineLag;
  set(J.pelvis, -0.08, 0, spineLean * 0.3);
  setTurned(J.chest, 0.24 - crouch * 0.05, 0, spineLean * 0.7, lag * 0.5);
  setTurned(J.neck, 0.42 - crouch * 0.07, 0, spineLean, lag * 0.8);
  setTurned(J.head, 0.57 - crouch * 0.08, 0.06 * motion.headLead, spineLean * 1.1, motion.headLead);

  // Counter-rotation: the shoulders wind against the board before a spin, and
  // ride the spine's lag through it.
  const twist = opts.twist * 0.34;
  setTurned(J.shoulderL, 0.22, -SEGMENT.shoulderSpan, twist, lag);
  setTurned(J.shoulderR, 0.22, SEGMENT.shoulderSpan, -twist, lag);

  // Feet ride the board, offset along it by the stance width.
  const stance = 0.26;
  const leadSign = opts.goofy ? -1 : 1;
  const footFwd = sim.gear.discipline === 'snowboard' ? stance : 0;
  // Skis run a wider stance than the old 0.22 m — a modern freeski stance is
  // around 27 cm between centres, and it reads as one from behind.
  const footSide = sim.gear.discipline === 'snowboard' ? 0 : 0.135;

  const boardAt = (out: Vec3, along: number, across: number) =>
    out
      .copy(pose.boardCenter)
      .addScaled(pose.boardForward, along)
      .addScaled(pose.boardRight, across)
      .addScaled(pose.boardUp, 0.04);

  boardAt(joints[J.footL], leadSign * footFwd, -footSide);
  boardAt(joints[J.footR], -leadSign * footFwd, footSide);

  // Hips sit above the feet; knees bend forward from the line between them.
  set(J.hipL, -0.1, -SEGMENT.hipSpan, 0);
  set(J.hipR, -0.1, SEGMENT.hipSpan, 0);
  placeKnee(joints[J.hipL], joints[J.footL], joints[J.kneeL], _fwd, crouch);
  placeKnee(joints[J.hipR], joints[J.footR], joints[J.kneeR], _fwd, crouch);

  // Arms: either reaching a grab or out for balance.
  const grab = getGrab(opts.grab);
  if (grab) {
    const along = grab.position * (sim.gear.length * 0.45);
    const across =
      grab.edge === 'toe' ? 0.12 : grab.edge === 'heel' ? -0.12 : 0;
    const target = _tmp
      .copy(pose.boardCenter)
      .addScaled(pose.boardForward, along)
      .addScaled(pose.boardRight, across);

    const leadHand = opts.goofy ? J.handR : J.handL;
    const trailHand = opts.goofy ? J.handL : J.handR;
    if (grab.hand === 'both') {
      joints[leadHand].copy(target).addScaled(pose.boardForward, 0.2);
      joints[trailHand].copy(target).addScaled(pose.boardForward, -0.2);
    } else if (grab.hand === 'lead') {
      joints[leadHand].copy(target);
      restHand(joints, trailHand, com, _up, _right, _fwd, opts.goofy ? -1 : 1, motion, crouch, tuck);
    } else {
      joints[trailHand].copy(target);
      restHand(joints, leadHand, com, _up, _right, _fwd, opts.goofy ? 1 : -1, motion, crouch, tuck);
    }
  } else {
    restHand(joints, J.handL, com, _up, _right, _fwd, -1, motion, crouch, tuck);
    restHand(joints, J.handR, com, _up, _right, _fwd, 1, motion, crouch, tuck);
  }

  placeElbow(joints[J.shoulderL], joints[J.handL], joints[J.elbowL], _up);
  placeElbow(joints[J.shoulderR], joints[J.handR], joints[J.elbowR], _up);

  // Poles.
  //
  // A planted pole is anchored in the snow and the solver owns it completely —
  // it must stay exactly where it was driven in while the skier travels past,
  // so nothing here is allowed to touch it.
  //
  // A pole that is *not* planted is a metre of aluminium swinging from a wrist,
  // and the solver has no opinion about it. It used to be drawn to the same
  // rigid offset every frame, which is why the poles read as two sticks glued
  // to the rider. Now the tip chases where the hand has been rather than where
  // it is: the lag is what makes it swing, and because the hand is finally
  // moving, that swing comes for free.
  const swingDt = opts.dt ?? 1 / 60;
  for (let i = 0; i < 2; i++) {
    const report = sim.poles[i];
    if (report.planted) {
      pose.poleTips[i].set(report.tipX, report.tipY, report.tipZ);
      pose.polePlanted[i] = true;
      continue;
    }
    pose.polePlanted[i] = false;

    // Where the tip would hang from a still hand: down and a little behind.
    const hand = joints[i === 0 ? J.handL : J.handR];
    _poleRest
      .copy(hand)
      .addScaled(_up, -POLE_HANG * 0.94)
      .addScaled(_fwd, -POLE_HANG * 0.3)
      .addScaled(_right, (i === 0 ? -1 : 1) * POLE_HANG * 0.12);

    const tip = pose.poleTips[i];
    // A tip that has never been placed starts at rest rather than at the world
    // origin, which would draw a pole across the entire mountain on frame one.
    if (tip.lengthSq() < 1e-6) tip.copy(_poleRest);
    // Chase, then hold the length: the shaft is rigid even though the wrist is
    // not, so the tip may lag around the hand but never further from it.
    const chase = Math.min(1, swingDt * 11);
    tip.set(
      tip.x + (_poleRest.x - tip.x) * chase,
      tip.y + (_poleRest.y - tip.y) * chase,
      tip.z + (_poleRest.z - tip.z) * chase,
    );
    _poleArm.subVectors(tip, hand);
    const reach = _poleArm.length();
    if (reach > 1e-4) tip.copy(hand).addScaled(_poleArm.scale(1 / reach), POLE_HANG);
  }

  pose.limp = false;
  return pose;
}

/**
 * Updates the smoothed motion state from what the simulation is doing.
 *
 * Everything here is a reading, never a script. There is no animation clip and
 * no timeline: a spin is fast because the body is turning fast, arms come up
 * because the gear left the snow, and a landing throws them because the leg
 * spring bottomed out. Turn the physics off and this all goes still, which is
 * the property that makes it read as a person rather than as a loop.
 */
function updateMotion(m: RiderMotion, sim: RiderSim, up: Vec3, dt: number, crouch: number, tuck: number): void {
  const t = sim.telemetry;
  const step = dt > 0 ? dt : 1 / 60;

  // Spin. A skier throws their arms around ahead of the turn and reels them in
  // as it winds up; the sign of the body-vertical rotation is all that is
  // needed to know which way. Full swing at about 460 deg/s, which is roughly
  // where a 540 sits.
  const spin = sim.angularVelocity.dot(up);
  m.lead = damp(m.lead, clamp(spin / 8, -1, 1), 7, step);

  // Off the snow the arms come up and open for balance. On it they settle.
  m.lift = damp(m.lift, t.airborne ? 1 : 0, t.airborne ? 6 : 4, step);

  // A pop is the legs extending fast; the arms go up with it. Compression on
  // the way into a jump pulls them down, which is the anticipation that makes
  // the pop read as deliberate.
  const legRate = (sim.legLength - m.lastLeg) / step;
  m.lastLeg = sim.legLength;
  if (legRate > 1.2 && !t.airborne) m.lift = Math.min(1.35, m.lift + legRate * 0.16);

  // Landing. The leg spring publishes the force it is carrying, so a hard
  // touchdown is simply a large number: hands fly out, then recover over about
  // four tenths of a second.
  if (!t.airborne && t.legForce > 9000) m.shock = Math.min(1, m.shock + (t.legForce - 9000) / 9000);
  m.shock *= Math.exp(-step / 0.13);

  // Carve. On a railed edge the inside hand drops toward the snow — the single
  // detail that makes a fast turn look fast. A skidded turn does not get it,
  // which is what `carveQuality` is for.
  const edge = clamp(t.edgeAngle / 45, -1, 1);
  const railed = t.airborne ? 0 : edge * t.carveQuality * clamp01((t.speed - 5) / 10);
  m.carve = damp(m.carve, railed, 5, step);

  // The chest lags the pelvis into a rotation and catches up out of it, and the
  // head leads: a skier looks where the spin is going before the body follows.
  m.spineLag = damp(m.spineLag, clamp(-spin * 0.055, -0.34, 0.34), 9, step);
  m.headLead = damp(m.headLead, clamp(spin * 0.1, -0.7, 0.7), 6, step);

  void crouch;
  void tuck;
}

/**
 * Places the hand that is not holding a grab.
 *
 * This used to be a constant offset from the pelvis — 4 cm forward, 44 across,
 * 18 up — which meant the arms were welded on. The rider could spin, pop, land
 * and rail a carve without the hands moving a millimetre relative to the body,
 * and no amount of shading hides a mannequin.
 */
function restHand(
  joints: Vec3[],
  index: number,
  com: Vec3,
  up: Vec3,
  right: Vec3,
  fwd: Vec3,
  side: number,
  m: RiderMotion,
  crouch: number,
  tuck: number,
): void {
  // Base stance, then everything the rider is doing moves it.
  //
  // Arms pull in as the spin winds up and as speed rises, because that is both
  // what a rider does and what conservation of angular momentum rewards.
  const pullIn = Math.abs(m.lead) * 0.13 + tuck * 0.1;
  let across = side * (0.44 - pullIn) + m.lift * side * 0.07;
  let along = 0.18 + m.lift * 0.05 - m.shock * 0.12;

  // Swing the pair around the body's vertical so they lead the rotation. Done
  // as a rotation rather than as an offset so both arms stay a pair — one comes
  // across the chest while the other opens behind, which is what a spin looks
  // like from outside.
  const swing = m.lead * 0.85;
  const cos = Math.cos(swing);
  const sin = Math.sin(swing);
  const rotAcross = across * cos - along * sin;
  const rotAlong = across * sin + along * cos;
  across = rotAcross;
  along = rotAlong;

  // Height: down through a crouch, up in the air, thrown up by a landing.
  let rise = 0.04 - crouch * 0.14 + m.lift * 0.2 + m.shock * 0.34;

  // The inside hand of a carve reaches for the snow while the outside one lifts.
  // `carve` is signed by the edge, so multiplying by the side of the body picks
  // out which hand is on the inside without a branch.
  const inside = m.carve * side;
  rise -= Math.max(0, inside) * 0.44;
  across += Math.max(0, inside) * side * 0.12;
  rise += Math.max(0, -inside) * 0.1;

  joints[index].copy(com).addScaled(up, rise).addScaled(right, across).addScaled(fwd, along);
}

/** Two-bone IK with the knee pushed toward `hint`. */
function placeKnee(hip: Vec3, foot: Vec3, out: Vec3, hint: Vec3, crouch: number): void {
  out.lerpVectors(hip, foot, 0.5);
  const span = hip.distanceTo(foot);
  const bend = Math.sqrt(Math.max(0, SEGMENT.thigh * SEGMENT.thigh - (span * span) / 4));
  out.addScaled(hint, bend * (0.55 + crouch * 0.6));
}

function placeElbow(shoulder: Vec3, hand: Vec3, out: Vec3, up: Vec3): void {
  out.lerpVectors(shoulder, hand, 0.5);
  const span = shoulder.distanceTo(hand);
  const bend = Math.sqrt(Math.max(0, SEGMENT.upperArm * SEGMENT.upperArm - (span * span) / 4));
  out.addScaled(up, -bend * 0.7);
}

/**
 * Verlet ragdoll used from the moment the rider loses it.
 *
 * Position-based dynamics: integrate, then relax the bone constraints a few
 * times per step. It is unconditionally stable no matter how hard the crash was,
 * which matters because crashes are exactly when the numbers get extreme.
 */
export class Ragdoll {
  readonly current: Vec3[] = [];
  readonly previous: Vec3[] = [];
  readonly boardCenter = new Vec3();
  readonly boardRight = new Vec3(1, 0, 0);
  readonly boardUp = new Vec3(0, 1, 0);
  readonly boardForward = new Vec3(0, 0, 1);
  private boardVel = new Vec3();
  private boardSpin = new Vec3();
  active = false;

  constructor() {
    for (let i = 0; i < JOINT_COUNT; i++) {
      this.current.push(new Vec3());
      this.previous.push(new Vec3());
    }
  }

  /** Snapshots the rider's live pose and momentum as the ragdoll's initial state. */
  seed(pose: RiderPose, velocity: Vec3, angularVelocity: Vec3, com: Vec3, dt = 1 / 60): void {
    for (let i = 0; i < JOINT_COUNT; i++) {
      this.current[i].copy(pose.joints[i]);
      // Encode velocity as the previous position, including the spin the rider
      // carried in — a crash out of a corked 900 keeps tumbling.
      const r = _tmp.subVectors(pose.joints[i], com);
      const pointVel = _spin.crossVectors(angularVelocity, r).add(velocity);
      this.previous[i].copy(pose.joints[i]).addScaled(pointVel, -dt);
    }
    this.boardCenter.copy(pose.boardCenter);
    this.boardRight.copy(pose.boardRight);
    this.boardUp.copy(pose.boardUp);
    this.boardForward.copy(pose.boardForward);
    this.boardVel.copy(velocity);
    this.boardSpin.copy(angularVelocity).scale(0.5);
    this.active = true;
  }

  step(dt: number, field: Heightfield, gravity = 9.81): void {
    if (!this.active) return;
    const damping = Math.exp(-0.35 * dt);

    for (let i = 0; i < JOINT_COUNT; i++) {
      const cur = this.current[i];
      const prev = this.previous[i];
      const vx = (cur.x - prev.x) * damping;
      const vy = (cur.y - prev.y) * damping;
      const vz = (cur.z - prev.z) * damping;
      prev.copy(cur);
      cur.x += vx;
      cur.y += vy - gravity * dt * dt;
      cur.z += vz;
    }

    for (let iter = 0; iter < 6; iter++) {
      for (const bone of BONES) {
        const a = this.current[bone.a];
        const b = this.current[bone.b];
        _tmp.subVectors(b, a);
        const dist = _tmp.length();
        if (dist < 1e-6) continue;
        const diff = ((dist - bone.length) / dist) * 0.5 * bone.stiffness;
        a.addScaled(_tmp, diff);
        b.addScaled(_tmp, -diff);
      }
      this.collide(field);
    }

    // The board tumbles alongside, still attached at the feet.
    const feet = _tmp.lerpVectors(this.current[J.footL], this.current[J.footR], 0.5);
    this.boardCenter.lerpVectors(this.boardCenter, feet, 0.4);
    const groundY = field.heightAt(this.boardCenter.x, this.boardCenter.z);
    if (this.boardCenter.y < groundY + 0.05) this.boardCenter.y = groundY + 0.05;
    _spin.subVectors(this.current[J.footR], this.current[J.footL]);
    if (_spin.lengthSq() > 1e-6) {
      this.boardForward.copy(_spin).normalize();
      this.boardRight.crossVectors(this.boardUp, this.boardForward).normalize();
      this.boardUp.crossVectors(this.boardForward, this.boardRight).normalize();
    }
  }

  private collide(field: Heightfield): void {
    for (let i = 0; i < JOINT_COUNT; i++) {
      const p = this.current[i];
      const ground = field.heightAt(p.x, p.z) + 0.07;
      if (p.y >= ground) continue;
      p.y = ground;
      // Scrub sideways speed so the body slides to a stop instead of skating.
      const prev = this.previous[i];
      prev.x = lerp(prev.x, p.x, 0.35);
      prev.z = lerp(prev.z, p.z, 0.35);
      if (prev.y > p.y) prev.y = p.y;
    }
  }

  /** Copies the solved bodies into the shared pose structure. */
  writePose(pose: RiderPose): void {
    for (let i = 0; i < JOINT_COUNT; i++) pose.joints[i].copy(this.current[i]);
    pose.boardCenter.copy(this.boardCenter);
    pose.boardRight.copy(this.boardRight);
    pose.boardUp.copy(this.boardUp);
    pose.boardForward.copy(this.boardForward);
    pose.limp = true;
  }

  /** Average speed of the body, used to decide when the crash has settled. */
  restSpeed(dt: number): number {
    let sum = 0;
    for (let i = 0; i < JOINT_COUNT; i++) sum += this.current[i].distanceTo(this.previous[i]);
    return sum / JOINT_COUNT / Math.max(dt, 1e-4);
  }
}

const _spin = new Vec3();
