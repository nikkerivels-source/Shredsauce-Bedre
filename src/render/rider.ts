import * as THREE from 'three';
import { JOINT_INDEX, type RiderPose } from '../physics/ragdoll.ts';
import type { GearSpec } from '../physics/gear.ts';

export interface RiderAppearance {
  jacket: string;
  pants: string;
  helmet: string;
  goggles: string;
  board: string;
  skin: string;
}

export function defaultAppearance(): RiderAppearance {
  return {
    jacket: '#e8503a',
    pants: '#22262e',
    helmet: '#f4f6fa',
    goggles: '#1b1f28',
    board: '#2f8fd6',
    skin: '#c99b76',
  };
}

const J = JOINT_INDEX;

interface LimbSpec {
  a: number;
  b: number;
  /** Radius at the `a` end and at the `b` end, metres. */
  from: number;
  to: number;
  key: keyof RiderAppearance;
  /** Squashes the limb across the board axis so it is not a perfect tube. */
  flatten?: number;
}

/**
 * Limbs, tapered.
 *
 * Real limbs are not uniform tubes: a thigh is much thicker at the hip than at
 * the knee, and a jacket sleeve is thicker than the forearm inside it. Tapering
 * each segment and flattening the torso across its depth is most of what turns a
 * stack of capsules into something that reads as a person.
 */
const LIMBS: LimbSpec[] = [
  { a: J.pelvis, b: J.chest, from: 0.15, to: 0.185, key: 'jacket', flatten: 0.74 },
  { a: J.chest, b: J.neck, from: 0.135, to: 0.085, key: 'jacket' },
  { a: J.chest, b: J.shoulderL, from: 0.1, to: 0.088, key: 'jacket' },
  { a: J.chest, b: J.shoulderR, from: 0.1, to: 0.088, key: 'jacket' },
  { a: J.shoulderL, b: J.elbowL, from: 0.077, to: 0.058, key: 'jacket' },
  { a: J.shoulderR, b: J.elbowR, from: 0.077, to: 0.058, key: 'jacket' },
  { a: J.elbowL, b: J.handL, from: 0.055, to: 0.042, key: 'jacket' },
  { a: J.elbowR, b: J.handR, from: 0.055, to: 0.042, key: 'jacket' },
  { a: J.pelvis, b: J.hipL, from: 0.105, to: 0.098, key: 'pants' },
  { a: J.pelvis, b: J.hipR, from: 0.105, to: 0.098, key: 'pants' },
  { a: J.hipL, b: J.kneeL, from: 0.105, to: 0.082, key: 'pants' },
  { a: J.hipR, b: J.kneeR, from: 0.105, to: 0.082, key: 'pants' },
  { a: J.kneeL, b: J.footL, from: 0.082, to: 0.066, key: 'pants' },
  { a: J.kneeR, b: J.footR, from: 0.082, to: 0.066, key: 'pants' },
];

/**
 * Draws a rider from a pose.
 *
 * Limbs are tapered cylinders stretched between joints each frame, plus a fixed
 * set of details — helmet, goggles, gloves, boots — parented to the joints they
 * belong to. The same mesh serves the live rider, a ragdoll mid-crash, a replay
 * ghost and every remote player, because all four produce the same pose type.
 */
export class RiderMesh {
  readonly group = new THREE.Group();
  private limbs: THREE.Mesh[] = [];
  private head: THREE.Mesh;
  private helmetBrim: THREE.Mesh;
  private goggles: THREE.Mesh;
  private gloves: THREE.Mesh[] = [];
  private boots: THREE.Mesh[] = [];
  private board: THREE.Mesh;
  private topsheet: THREE.Mesh;
  private materials = new Map<string, THREE.MeshStandardMaterial>();
  private appearance: RiderAppearance;
  private gear: GearSpec;
  private ghost: boolean;

  constructor(gear: GearSpec, appearance: RiderAppearance, opts: { ghost?: boolean } = {}) {
    this.gear = gear;
    this.appearance = appearance;
    this.ghost = opts.ghost ?? false;
    const ghost = this.ghost;

    const mat = (key: keyof RiderAppearance, extra?: Partial<THREE.MeshStandardMaterialParameters>) => {
      const id = `${key}:${extra?.roughness ?? 'd'}`;
      let m = this.materials.get(id);
      if (!m) {
        m = new THREE.MeshStandardMaterial({
          color: new THREE.Color(appearance[key]),
          roughness: 0.68,
          metalness: 0.02,
          transparent: ghost,
          opacity: ghost ? 0.42 : 1,
          depthWrite: !ghost,
          ...extra,
        });
        m.userData.key = key;
        this.materials.set(id, m);
      }
      return m;
    };

    // A unit cylinder along +Y, re-shaped per limb every frame. Open-ended,
    // because the joint spheres cap it far more cheaply than geometry does.
    const limbGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    for (const limb of LIMBS) {
      const mesh = new THREE.Mesh(limbGeo, mat(limb.key));
      mesh.castShadow = !ghost;
      this.limbs.push(mesh);
      this.group.add(mesh);
    }

    // Joint caps, so elbows and knees are round instead of showing a seam.
    const jointGeo = new THREE.SphereGeometry(1, 8, 6);
    for (const limb of LIMBS) {
      const cap = new THREE.Mesh(jointGeo, mat(limb.key));
      cap.castShadow = false;
      this.jointCaps.push({ mesh: cap, joint: limb.b, radius: limb.to });
      this.group.add(cap);
    }

    // Head: a helmet shell slightly flattened front to back, with a brim.
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.132, 16, 12), mat('helmet'));
    this.head.scale.set(1, 1.04, 0.94);
    this.head.castShadow = !ghost;
    this.group.add(this.head);

    this.helmetBrim = new THREE.Mesh(
      new THREE.CylinderGeometry(0.138, 0.138, 0.03, 16, 1, true),
      mat('helmet'),
    );
    this.group.add(this.helmetBrim);

    // Goggles: a curved band rather than a flat slab, so it wraps the helmet.
    this.goggles = new THREE.Mesh(
      new THREE.CylinderGeometry(0.136, 0.136, 0.082, 16, 1, true, -0.95, 1.9),
      mat('goggles', { roughness: 0.15, metalness: 0.55 }),
    );
    this.group.add(this.goggles);

    const gloveGeo = new THREE.SphereGeometry(0.055, 8, 6);
    for (let i = 0; i < 2; i++) {
      const glove = new THREE.Mesh(gloveGeo, mat('goggles', { roughness: 0.75, metalness: 0 }));
      glove.castShadow = !ghost;
      this.gloves.push(glove);
      this.group.add(glove);
    }

    const bootGeo = new THREE.BoxGeometry(0.12, 0.13, 0.24);
    for (let i = 0; i < 2; i++) {
      const boot = new THREE.Mesh(bootGeo, mat('goggles', { roughness: 0.6, metalness: 0.05 }));
      boot.castShadow = !ghost;
      this.boots.push(boot);
      this.group.add(boot);
    }

    this.board = new THREE.Mesh(makeBoardGeometry(gear), mat('board', { roughness: 0.24, metalness: 0.2 }));
    this.board.castShadow = !ghost;
    this.group.add(this.board);

    // A darker stripe down the topsheet, so rotation is readable in the air.
    this.topsheet = new THREE.Mesh(makeStripeGeometry(gear), mat('goggles', { roughness: 0.3, metalness: 0.2 }));
    this.group.add(this.topsheet);
  }

  private jointCaps: Array<{ mesh: THREE.Mesh; joint: number; radius: number }> = [];

  setGear(gear: GearSpec): void {
    if (gear.id === this.gear.id) return;
    this.gear = gear;
    this.board.geometry.dispose();
    this.board.geometry = makeBoardGeometry(gear);
    this.topsheet.geometry.dispose();
    this.topsheet.geometry = makeStripeGeometry(gear);
  }

  get colors(): RiderAppearance {
    return this.appearance;
  }

  setAppearance(appearance: RiderAppearance): void {
    this.appearance = appearance;
    for (const material of this.materials.values()) {
      const key = material.userData.key as keyof RiderAppearance | undefined;
      if (key && appearance[key]) material.color.set(appearance[key]);
    }
  }

  /** Reshapes every limb and detail to match the pose. */
  apply(pose: RiderPose): void {
    const joints = pose.joints;

    for (let i = 0; i < LIMBS.length; i++) {
      const limb = LIMBS[i];
      const mesh = this.limbs[i];
      _a.set(joints[limb.a].x, joints[limb.a].y, joints[limb.a].z);
      _b.set(joints[limb.b].x, joints[limb.b].y, joints[limb.b].z);
      _dir.subVectors(_b, _a);
      const length = Math.max(0.02, _dir.length());
      mesh.position.copy(_a).addScaledVector(_dir, 0.5);
      _dir.divideScalar(length);
      mesh.quaternion.setFromUnitVectors(UP, _dir);
      // The cylinder is built with equal ends; scaling X and Z differently is
      // what gives the taper and the flattened torso.
      const mid = (limb.from + limb.to) * 0.5;
      mesh.scale.set(mid, length, mid * (limb.flatten ?? 1));
    }

    for (const cap of this.jointCaps) {
      const p = joints[cap.joint];
      cap.mesh.position.set(p.x, p.y, p.z);
      cap.mesh.scale.setScalar(cap.radius);
    }

    const head = joints[J.head];
    const neck = joints[J.neck];
    this.head.position.set(head.x, head.y, head.z);

    // Build a head frame: up runs neck->head, forward is where the rider looks.
    _up.set(head.x - neck.x, head.y - neck.y, head.z - neck.z).normalize();
    _fwd.set(pose.boardForward.x, pose.boardForward.y, pose.boardForward.z);
    _side.set(pose.boardRight.x, pose.boardRight.y, pose.boardRight.z);
    // A snowboarder looks across the board; a skier looks along it.
    const look = this.gear.discipline === 'snowboard' ? _side : _fwd;
    _lookDir.copy(look).addScaledVector(_up, -_up.dot(look)).normalize();
    _right.crossVectors(_up, _lookDir).normalize();
    _m.makeBasis(_right, _up, _lookDir);
    this.head.quaternion.setFromRotationMatrix(_m);
    this.helmetBrim.quaternion.copy(this.head.quaternion);
    this.helmetBrim.position.copy(this.head.position).addScaledVector(_up, 0.03);
    this.goggles.quaternion.copy(this.head.quaternion);
    this.goggles.position
      .copy(this.head.position)
      .addScaledVector(_lookDir, 0.012)
      .addScaledVector(_up, -0.012);

    this.gloves[0].position.set(joints[J.handL].x, joints[J.handL].y, joints[J.handL].z);
    this.gloves[1].position.set(joints[J.handR].x, joints[J.handR].y, joints[J.handR].z);

    // Boots sit on the board and share its orientation, which is what makes the
    // feet look bound in rather than floating near it.
    _m.makeBasis(
      _side.set(pose.boardRight.x, pose.boardRight.y, pose.boardRight.z),
      _boardUp.set(pose.boardUp.x, pose.boardUp.y, pose.boardUp.z),
      _fwd.set(pose.boardForward.x, pose.boardForward.y, pose.boardForward.z),
    );
    _boardQuat.setFromRotationMatrix(_m);
    for (let i = 0; i < 2; i++) {
      const foot = joints[i === 0 ? J.footL : J.footR];
      this.boots[i].position.set(foot.x, foot.y, foot.z);
      this.boots[i].quaternion.copy(_boardQuat);
    }

    this.board.position.set(pose.boardCenter.x, pose.boardCenter.y, pose.boardCenter.z);
    this.board.quaternion.copy(_boardQuat);
    this.topsheet.position.copy(this.board.position).addScaledVector(_boardUp, 0.012);
    this.topsheet.quaternion.copy(_boardQuat);
  }

  dispose(): void {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    for (const m of this.materials.values()) m.dispose();
    this.group.parent?.remove(this.group);
  }
}

/**
 * Board or ski outline, from the gear's real sidecut.
 *
 * A 21 m radius GS ski visibly runs straighter than a 7 m park board, and the
 * tip and tail rise, because those numbers are the ones the physics uses.
 */
function makeBoardGeometry(gear: GearSpec): THREE.BufferGeometry {
  const segments = 40;
  const half = gear.length / 2;
  const shape = new THREE.Shape();
  const pts: THREE.Vector2[] = [];

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const z = -half + t * gear.length;
    const nose = Math.abs(z) / half;
    const sidecut = (z * z) / (2 * gear.sidecutRadius);
    const taper = Math.pow(Math.max(0, 1 - Math.pow(nose, 8)), 0.42);
    pts.push(new THREE.Vector2(z, (gear.waistWidth / 2 + sidecut) * taper));
  }
  shape.moveTo(pts[0].x, pts[0].y);
  for (const p of pts) shape.lineTo(p.x, p.y);
  for (let i = pts.length - 1; i >= 0; i--) shape.lineTo(pts[i].x, -pts[i].y);
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.014,
    bevelEnabled: true,
    bevelSize: 0.005,
    bevelThickness: 0.004,
    bevelSegments: 1,
  });
  geometry.rotateY(Math.PI / 2);
  geometry.rotateZ(Math.PI / 2);
  geometry.translate(0, -0.007, 0);

  // Tip and tail rocker: lift the ends so the board is not a flat plank. Camber
  // profile decides how much, matching what the contact model already assumes.
  const rockerScale = gear.camber === 'rocker' ? 1.5 : gear.camber === 'camber' ? 0.7 : 1;
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const t = Math.min(1, Math.abs(z) / half);
    pos.setY(i, pos.getY(i) + Math.pow(t, 3.5) * 0.09 * rockerScale);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

/** A stripe inlaid down the topsheet, purely so spins read in the air. */
function makeStripeGeometry(gear: GearSpec): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(gear.waistWidth * 0.34, gear.length * 0.62);
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3();
const _right = new THREE.Vector3();
const _lookDir = new THREE.Vector3();
const _boardUp = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _boardQuat = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
