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

/** Limbs, as joint pairs with a radius. */
const LIMBS: Array<[number, number, number, keyof RiderAppearance]> = [
  [J.pelvis, J.chest, 0.155, 'jacket'],
  [J.chest, J.neck, 0.105, 'jacket'],
  [J.chest, J.shoulderL, 0.085, 'jacket'],
  [J.chest, J.shoulderR, 0.085, 'jacket'],
  [J.shoulderL, J.elbowL, 0.062, 'jacket'],
  [J.shoulderR, J.elbowR, 0.062, 'jacket'],
  [J.elbowL, J.handL, 0.05, 'jacket'],
  [J.elbowR, J.handR, 0.05, 'jacket'],
  [J.pelvis, J.hipL, 0.085, 'pants'],
  [J.pelvis, J.hipR, 0.085, 'pants'],
  [J.hipL, J.kneeL, 0.082, 'pants'],
  [J.hipR, J.kneeR, 0.082, 'pants'],
  [J.kneeL, J.footL, 0.068, 'pants'],
  [J.kneeR, J.footR, 0.068, 'pants'],
];

/**
 * Draws a rider from a pose.
 *
 * Limbs are unit-length capsules stretched and oriented between joints each
 * frame, so the same mesh serves the live rider, a ragdoll mid-crash, a replay
 * ghost and every remote player in a multiplayer session.
 */
export class RiderMesh {
  readonly group = new THREE.Group();
  private limbs: THREE.Mesh[] = [];
  private head: THREE.Mesh;
  private goggles: THREE.Mesh;
  private board: THREE.Mesh;
  private materials = new Map<string, THREE.MeshStandardMaterial>();
  private appearance: RiderAppearance;
  private gear: GearSpec;

  constructor(gear: GearSpec, appearance: RiderAppearance, opts: { ghost?: boolean } = {}) {
    this.gear = gear;
    this.appearance = appearance;
    const ghost = opts.ghost ?? false;

    const mat = (key: keyof RiderAppearance, extra?: Partial<THREE.MeshStandardMaterialParameters>) => {
      const id = `${key}:${appearance[key]}:${ghost}`;
      let m = this.materials.get(id);
      if (!m) {
        m = new THREE.MeshStandardMaterial({
          color: new THREE.Color(appearance[key]),
          roughness: 0.62,
          metalness: 0.05,
          transparent: ghost,
          opacity: ghost ? 0.42 : 1,
          depthWrite: !ghost,
          ...extra,
        });
        this.materials.set(id, m);
      }
      return m;
    };

    // A unit capsule along +Y, scaled and rotated per limb each frame.
    const capsule = new THREE.CapsuleGeometry(1, 1, 4, 8);
    for (const [, , radius, key] of LIMBS) {
      const mesh = new THREE.Mesh(capsule, mat(key));
      mesh.castShadow = !ghost;
      mesh.userData.radius = radius;
      this.limbs.push(mesh);
      this.group.add(mesh);
    }

    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.125, 14, 10), mat('helmet'));
    this.head.castShadow = !ghost;
    this.group.add(this.head);

    this.goggles = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.075, 0.13), mat('goggles', { roughness: 0.2, metalness: 0.4 }));
    this.group.add(this.goggles);

    this.board = new THREE.Mesh(makeBoardGeometry(gear), mat('board', { roughness: 0.28, metalness: 0.15 }));
    this.board.castShadow = !ghost;
    this.group.add(this.board);
  }

  setGear(gear: GearSpec): void {
    if (gear.id === this.gear.id) return;
    this.gear = gear;
    this.board.geometry.dispose();
    this.board.geometry = makeBoardGeometry(gear);
  }

  get colors(): RiderAppearance {
    return this.appearance;
  }

  setAppearance(appearance: RiderAppearance): void {
    this.appearance = appearance;
    for (const [key, value] of Object.entries(appearance)) {
      for (const [id, material] of this.materials) {
        if (id.startsWith(`${key}:`)) material.color.set(value);
      }
    }
  }

  /** Reorients every limb to match the pose. */
  apply(pose: RiderPose): void {
    const joints = pose.joints;
    for (let i = 0; i < LIMBS.length; i++) {
      const [a, b, radius] = LIMBS[i];
      const mesh = this.limbs[i];
      _a.set(joints[a].x, joints[a].y, joints[a].z);
      _b.set(joints[b].x, joints[b].y, joints[b].z);
      _dir.subVectors(_b, _a);
      const length = Math.max(0.02, _dir.length());
      mesh.position.copy(_a).addScaledVector(_dir, 0.5);
      _dir.divideScalar(length);
      mesh.quaternion.setFromUnitVectors(UP, _dir);
      // CapsuleGeometry(1, 1) is 3 units tall overall; scale so the cylinder
      // section spans the bone and the caps round off the joints.
      mesh.scale.set(radius, length / 3, radius);
    }

    const head = joints[J.head];
    const neck = joints[J.neck];
    this.head.position.set(head.x, head.y, head.z);

    // Face the goggles along the direction the head leans away from the neck,
    // biased by the board's forward so the rider looks where they are going.
    _dir.set(head.x - neck.x, head.y - neck.y, head.z - neck.z).normalize();
    _fwd.set(pose.boardForward.x, pose.boardForward.y, pose.boardForward.z);
    _side.set(pose.boardRight.x, pose.boardRight.y, pose.boardRight.z);
    const look = this.gear.discipline === 'snowboard' ? _side : _fwd;
    this.goggles.position.copy(this.head.position).addScaledVector(look, 0.1).addScaledVector(_dir, 0.02);
    _m.lookAt(ORIGIN, look, _dir);
    this.goggles.quaternion.setFromRotationMatrix(_m);

    this.board.position.set(pose.boardCenter.x, pose.boardCenter.y, pose.boardCenter.z);
    _m.makeBasis(
      _side.set(pose.boardRight.x, pose.boardRight.y, pose.boardRight.z),
      _up.set(pose.boardUp.x, pose.boardUp.y, pose.boardUp.z),
      _fwd.set(pose.boardForward.x, pose.boardForward.y, pose.boardForward.z),
    );
    this.board.quaternion.setFromRotationMatrix(_m);
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
 * Board or ski outline.
 *
 * Uses the real sidecut, so a 21 m radius GS ski visibly runs straighter than a
 * 7 m park board rather than being a generic plank.
 */
function makeBoardGeometry(gear: GearSpec): THREE.BufferGeometry {
  const segments = 24;
  const half = gear.length / 2;
  const shape = new THREE.Shape();
  const pts: THREE.Vector2[] = [];

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const z = -half + t * gear.length;
    const nose = Math.abs(z) / half;
    // Sidecut: the waist is narrowest, widening toward the contact points, then
    // rounding off at the tip and tail.
    const sidecut = (z * z) / (2 * gear.sidecutRadius);
    const taper = Math.pow(Math.max(0, 1 - Math.pow(nose, 7)), 0.4);
    const width = (gear.waistWidth / 2 + sidecut) * taper;
    pts.push(new THREE.Vector2(z, width));
  }
  shape.moveTo(pts[0].x, pts[0].y);
  for (const p of pts) shape.lineTo(p.x, p.y);
  for (let i = pts.length - 1; i >= 0; i--) shape.lineTo(pts[i].x, -pts[i].y);
  shape.closePath();

  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.016,
    bevelEnabled: true,
    bevelSize: 0.006,
    bevelThickness: 0.004,
    bevelSegments: 1,
  });
  // The shape is drawn in the XY plane with X along the board; rotate it so the
  // board lies flat with +Z forward and +Y up.
  geometry.rotateY(Math.PI / 2);
  geometry.rotateZ(Math.PI / 2);
  geometry.translate(0, -0.008, 0);
  geometry.computeVertexNormals();
  return geometry;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const ORIGIN = new THREE.Vector3();
