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

/** Freeski default: dark baggy shell over bright pants. */
export function defaultAppearance(): RiderAppearance {
  return {
    jacket: '#23272f',
    pants: '#e0622a',
    helmet: '#1a1d23',
    goggles: '#101318',
    board: '#3f97e0',
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
  /** Squashes the limb across its depth so it is not a perfect tube. */
  flatten?: number;
}

/**
 * Limbs.
 *
 * Freeski outerwear is deliberately oversized — a shell two sizes too big, pants
 * that stack over the boot. So these radii are the *clothing*, not the body, and
 * they are far thicker than anatomy would suggest. Getting that wrong is what
 * makes a rider read as a generic mannequin instead of a skier.
 */
const LIMBS: LimbSpec[] = [
  { a: J.pelvis, b: J.chest, from: 0.215, to: 0.222, key: 'jacket', flatten: 0.7 },
  { a: J.chest, b: J.neck, from: 0.19, to: 0.093, key: 'jacket', flatten: 0.74 },
  { a: J.chest, b: J.shoulderL, from: 0.145, to: 0.12, key: 'jacket', flatten: 0.82 },
  { a: J.chest, b: J.shoulderR, from: 0.145, to: 0.12, key: 'jacket', flatten: 0.82 },
  // Sleeves nearly as thick as the shoulder they hang off. In the reference the
  // arms barely separate from the body — the shell reads as one broad mass and
  // only the gloves tell you where the arms end.
  { a: J.shoulderL, b: J.elbowL, from: 0.12, to: 0.104, key: 'jacket' },
  { a: J.shoulderR, b: J.elbowR, from: 0.12, to: 0.104, key: 'jacket' },
  { a: J.elbowL, b: J.handL, from: 0.1, to: 0.072, key: 'jacket' },
  { a: J.elbowR, b: J.handR, from: 0.1, to: 0.072, key: 'jacket' },
  { a: J.pelvis, b: J.hipL, from: 0.14, to: 0.135, key: 'pants' },
  { a: J.pelvis, b: J.hipR, from: 0.14, to: 0.135, key: 'pants' },
  { a: J.hipL, b: J.kneeL, from: 0.142, to: 0.126, key: 'pants' },
  { a: J.hipR, b: J.kneeR, from: 0.142, to: 0.126, key: 'pants' },
  { a: J.kneeL, b: J.footL, from: 0.126, to: 0.115, key: 'pants' },
  { a: J.kneeR, b: J.footR, from: 0.126, to: 0.115, key: 'pants' },
];

/**
 * Draws a rider from a pose.
 *
 * Limbs are tapered cylinders stretched between joints each frame, plus fixed
 * detail parented to the joints it belongs to. The same mesh serves the live
 * rider, a ragdoll mid-crash, a replay ghost and every remote player, because
 * all four produce the same pose type.
 */
export class RiderMesh {
  readonly group = new THREE.Group();
  private limbs: THREE.Mesh[] = [];
  private jointCaps: Array<{ mesh: THREE.Mesh; joint: number; radius: number; flatten: number }> = [];
  private hem: THREE.Mesh;
  private hood: THREE.Mesh;
  private head: THREE.Mesh;
  private goggles: THREE.Mesh;
  private gloves: THREE.Mesh[] = [];
  private boots: THREE.Mesh[] = [];
  /** One deck for a snowboard, two skis for skis. */
  private planks: THREE.Mesh[] = [];
  private poles: THREE.Group[] = [];
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
      const id = `${key}:${extra?.roughness ?? 'd'}:${extra?.metalness ?? 'd'}`;
      let m = this.materials.get(id);
      if (!m) {
        m = new THREE.MeshStandardMaterial({
          color: new THREE.Color(appearance[key]),
          roughness: 0.72,
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
    this.mat = mat;

    const limbGeo = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    for (const limb of LIMBS) {
      const mesh = new THREE.Mesh(limbGeo, mat(limb.key));
      mesh.castShadow = !ghost;
      this.limbs.push(mesh);
      this.group.add(mesh);
    }

    const jointGeo = new THREE.SphereGeometry(1, 10, 7);
    for (const limb of LIMBS) {
      const cap = new THREE.Mesh(jointGeo, mat(limb.key));
      this.jointCaps.push({ mesh: cap, joint: limb.b, radius: limb.to, flatten: limb.flatten ?? 1 });
      this.group.add(cap);
    }

    // Jacket hem: a flared skirt hanging to mid-thigh. This one piece does more
    // for the freeski silhouette than any amount of limb thickening — a shell
    // that stops at the hips reads as a jacket, one that hangs past them reads
    // as freeski outerwear, and the difference is most of the character.
    this.hem = new THREE.Mesh(new THREE.CylinderGeometry(0.252, 0.295, HEM_LENGTH, 16, 1, true), mat('jacket'));
    this.hem.castShadow = !ghost;
    this.group.add(this.hem);

    // Hood, bunched at the back of the neck. Reads as a lump on the shoulders
    // from behind, which is the angle the player sees almost all of the time.
    this.hood = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 9), mat('jacket'));
    this.hood.scale.set(1.3, 0.66, 0.78);
    this.hood.castShadow = !ghost;
    this.group.add(this.hood);

    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.126, 16, 12), mat('helmet'));
    this.head.scale.set(1, 1.06, 0.95);
    this.head.castShadow = !ghost;
    this.group.add(this.head);

    this.goggles = new THREE.Mesh(
      new THREE.CylinderGeometry(0.139, 0.139, 0.088, 16, 1, true, -0.95, 1.9),
      mat('goggles', { roughness: 0.14, metalness: 0.6 }),
    );
    this.group.add(this.goggles);

    const gloveGeo = new THREE.SphereGeometry(0.062, 8, 6);
    for (let i = 0; i < 2; i++) {
      const glove = new THREE.Mesh(gloveGeo, mat('goggles', { roughness: 0.8, metalness: 0 }));
      glove.castShadow = !ghost;
      this.gloves.push(glove);
      this.group.add(glove);
    }

    // Ski boots are big rigid plastic shells, not shoes, and a freeski cuff
    // comes well up the shin — the dark mass below the knee in the reference is
    // boot, not leg.
    const bootGeo = new THREE.BoxGeometry(0.15, 0.28, 0.3);
    bootGeo.translate(0, 0.055, 0);
    for (let i = 0; i < 2; i++) {
      const boot = new THREE.Mesh(bootGeo, mat('goggles', { roughness: 0.42, metalness: 0.08 }));
      boot.castShadow = !ghost;
      this.boots.push(boot);
      this.group.add(boot);
    }

    this.buildGear();
  }

  private mat: (key: keyof RiderAppearance, extra?: Partial<THREE.MeshStandardMaterialParameters>) => THREE.MeshStandardMaterial;

  /** (Re)builds the planks and poles for the current discipline. */
  private buildGear(): void {
    for (const plank of this.planks) {
      plank.geometry.dispose();
      this.group.remove(plank);
    }
    this.planks = [];
    for (const pole of this.poles) {
      pole.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
      this.group.remove(pole);
    }
    this.poles = [];

    const skis = this.gear.discipline === 'skis';
    const count = skis ? 2 : 1;
    for (let i = 0; i < count; i++) {
      const plank = new THREE.Mesh(
        makePlankGeometry(this.gear),
        this.mat('board', { roughness: 0.22, metalness: 0.22 }),
      );
      plank.castShadow = !this.ghost;
      this.planks.push(plank);
      this.group.add(plank);
    }

    // Poles are a ski thing. A snowboarder holding them would be absurd.
    if (!skis) return;
    for (let i = 0; i < 2; i++) {
      const pole = new THREE.Group();
      // Bare alloy, not a dark stick. A pole read against snow is a bright
      // highlight with a dark grip at the top — drawing it in the helmet colour
      // made it vanish into a thin scratch.
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.0115, 0.0085, 1.18, 7),
        poleMaterial(this.ghost),
      );
      shaft.position.y = -0.59;
      shaft.castShadow = !this.ghost;

      // Grip takes the pants colour, so the rider's kit reads as a set.
      const grip = new THREE.Mesh(
        new THREE.CylinderGeometry(0.021, 0.017, 0.155, 8),
        this.mat('pants', { roughness: 0.95, metalness: 0 }),
      );
      grip.position.y = -0.06;

      const strap = new THREE.Mesh(
        new THREE.TorusGeometry(0.035, 0.006, 5, 10),
        this.mat('goggles', { roughness: 0.9, metalness: 0 }),
      );
      strap.rotation.x = Math.PI / 2;
      strap.rotation.z = 0.5;
      strap.position.y = -0.015;

      // The basket sits just above the tip and stops the pole punching through
      // soft snow — it is the detail that makes a pole read as a ski pole.
      const basket = new THREE.Mesh(
        new THREE.CylinderGeometry(0.052, 0.052, 0.014, 10),
        this.mat('goggles', { roughness: 0.85, metalness: 0 }),
      );
      basket.position.y = -1.04;

      pole.add(shaft, grip, strap, basket);
      this.poles.push(pole);
      this.group.add(pole);
    }
  }

  setGear(gear: GearSpec): void {
    if (gear.id === this.gear.id) return;
    const disciplineChanged = gear.discipline !== this.gear.discipline;
    this.gear = gear;
    if (disciplineChanged) {
      this.buildGear();
      return;
    }
    for (const plank of this.planks) {
      plank.geometry.dispose();
      plank.geometry = makePlankGeometry(gear);
    }
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
      const mid = (limb.from + limb.to) * 0.5;
      mesh.scale.set(mid, length, mid * (limb.flatten ?? 1));
    }

    // Body frame, from the spine.
    _pelvis.set(joints[J.pelvis].x, joints[J.pelvis].y, joints[J.pelvis].z);
    _chest.set(joints[J.chest].x, joints[J.chest].y, joints[J.chest].z);
    _up.subVectors(_chest, _pelvis).normalize();

    _boardUp.set(pose.boardUp.x, pose.boardUp.y, pose.boardUp.z);
    _side.set(pose.boardRight.x, pose.boardRight.y, pose.boardRight.z);
    _fwd.set(pose.boardForward.x, pose.boardForward.y, pose.boardForward.z);
    _m.makeBasis(_side, _boardUp, _fwd);
    _boardQuat.setFromRotationMatrix(_m);

    // Joint caps close the open ends of the limb tubes. They take the limb's
    // flatten in the body's fore-aft axis, so a torso ends up a slab rather
    // than a beach ball — an unflattened cap at the chest is wide enough to
    // swallow the neck, the hood and most of the shoulders.
    for (const cap of this.jointCaps) {
      const p = joints[cap.joint];
      cap.mesh.position.set(p.x, p.y, p.z);
      cap.mesh.quaternion.copy(_boardQuat);
      cap.mesh.scale.set(cap.radius, cap.radius, cap.radius * cap.flatten);
    }

    // Hem hangs off the pelvis along the spine, its centre half a length below
    // the waist so the skirt covers the hips and upper thigh. It is an ellipse,
    // not a tube: wide enough side-to-side to cover a splayed stance, shallow
    // enough front-to-back not to balloon.
    this.hem.position.copy(_pelvis).addScaledVector(_up, 0.05 - HEM_LENGTH * 0.5);
    _right.crossVectors(_up, _fwd).normalize();
    _lookDir.crossVectors(_right, _up).normalize();
    _m.makeBasis(_right, _up, _lookDir);
    this.hem.quaternion.setFromRotationMatrix(_m);
    this.hem.scale.set(1, 1, HEM_FLATTEN);

    const head = joints[J.head];
    const neck = joints[J.neck];
    this.head.position.set(head.x, head.y, head.z);

    // Hood sits behind and just below the neck, bunched against the shoulders.
    this.hood.position
      .set(neck.x, neck.y, neck.z)
      .addScaledVector(_up, -0.03)
      .addScaledVector(_fwd, -0.1);
    this.hood.quaternion.copy(_boardQuat);

    _headUp.set(head.x - neck.x, head.y - neck.y, head.z - neck.z).normalize();
    // A skier looks along the skis; a snowboarder looks across the board.
    const look = this.gear.discipline === 'snowboard' ? _side : _fwd;
    _lookDir.copy(look).addScaledVector(_headUp, -_headUp.dot(look)).normalize();
    _right.crossVectors(_headUp, _lookDir).normalize();
    _m.makeBasis(_right, _headUp, _lookDir);
    this.head.quaternion.setFromRotationMatrix(_m);
    this.goggles.quaternion.copy(this.head.quaternion);
    this.goggles.position
      .copy(this.head.position)
      .addScaledVector(_lookDir, 0.014)
      .addScaledVector(_headUp, -0.014);

    this.gloves[0].position.set(joints[J.handL].x, joints[J.handL].y, joints[J.handL].z);
    this.gloves[1].position.set(joints[J.handR].x, joints[J.handR].y, joints[J.handR].z);

    for (let i = 0; i < 2; i++) {
      const foot = joints[i === 0 ? J.footL : J.footR];
      this.boots[i].position.set(foot.x, foot.y, foot.z);
      this.boots[i].quaternion.copy(_boardQuat);
    }

    if (this.planks.length === 2) {
      // Skis: one under each boot, so the stance is whatever the pose says.
      for (let i = 0; i < 2; i++) {
        const foot = joints[i === 0 ? J.footL : J.footR];
        this.planks[i].position.set(foot.x, foot.y, foot.z).addScaledVector(_boardUp, -0.075);
        this.planks[i].quaternion.copy(_boardQuat);
      }
    } else if (this.planks.length === 1) {
      this.planks[0].position.set(pose.boardCenter.x, pose.boardCenter.y, pose.boardCenter.z);
      this.planks[0].quaternion.copy(_boardQuat);
    }

    // Poles run from the hand to whatever tip the solver produced. A planted
    // pole is anchored in the snow, so it visibly stays behind as the skier
    // drives past it, and it stretches to reach — which is exactly what a pole
    // does through a stroke.
    for (let i = 0; i < this.poles.length; i++) {
      const hand = joints[i === 0 ? J.handL : J.handR];
      const tip = pose.poleTips[i];
      _poleFrom.set(hand.x, hand.y, hand.z);
      _poleTo.set(tip.x, tip.y, tip.z);
      _poleDir.subVectors(_poleTo, _poleFrom);
      const reach = _poleDir.length();
      if (reach < 0.05) {
        this.poles[i].visible = false;
        continue;
      }
      this.poles[i].visible = true;
      _poleDir.divideScalar(reach);
      this.poles[i].position.copy(_poleFrom);
      this.poles[i].quaternion.setFromUnitVectors(DOWN, _poleDir);
      // The pole is modelled a shade over a metre long; scale it along its own
      // axis so the drawn shaft always ends at the tip.
      this.poles[i].scale.set(1, reach / POLE_MODEL_LENGTH, 1);
    }
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
 * One board, or one ski.
 *
 * Built from the gear's real sidecut, so a 21 m radius GS ski visibly runs
 * straighter than a 7 m park board. For skis the width is per-ski, which is why
 * the same function serves both.
 */
function makePlankGeometry(gear: GearSpec): THREE.BufferGeometry {
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

  // Twin-tip rocker. Park skis turn up at both ends; a cambered race ski barely
  // does, and the profile the physics uses decides which this is.
  const twin = gear.camber === 'rocker' ? 1.6 : gear.camber === 'camber' ? 0.75 : 1.15;
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const z = pos.getZ(i);
    const t = Math.min(1, Math.abs(z) / half);
    pos.setY(i, pos.getY(i) + Math.pow(t, 3.2) * 0.1 * twin);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _side = new THREE.Vector3();
const _up = new THREE.Vector3();
const _headUp = new THREE.Vector3();
const _right = new THREE.Vector3();
const _lookDir = new THREE.Vector3();
const _boardUp = new THREE.Vector3();
const _pelvis = new THREE.Vector3();
const _chest = new THREE.Vector3();
const _poleDir = new THREE.Vector3();
const _poleFrom = new THREE.Vector3();
const _poleTo = new THREE.Vector3();
/** Height of the pole group as modelled, from grip to tip. */
const POLE_MODEL_LENGTH = 1.1;

/** Hem drop from the pelvis. Long enough to reach mid-thigh. */
const HEM_LENGTH = 0.42;
/** Hem depth as a fraction of its width. A person is not a cylinder. */
const HEM_FLATTEN = 0.72;

/**
 * Pole shafts are shared, unpainted alloy — they are equipment, not kit, so
 * they sit outside the appearance palette and every rider's poles match.
 */
let _poleMat: THREE.MeshStandardMaterial | null = null;
let _poleMatGhost: THREE.MeshStandardMaterial | null = null;
function poleMaterial(ghost: boolean): THREE.MeshStandardMaterial {
  if (ghost) {
    _poleMatGhost ??= new THREE.MeshStandardMaterial({
      color: 0xc9d4de,
      roughness: 0.34,
      metalness: 0.72,
      transparent: true,
      opacity: 0.42,
      depthWrite: false,
    });
    return _poleMatGhost;
  }
  _poleMat ??= new THREE.MeshStandardMaterial({ color: 0xc9d4de, roughness: 0.34, metalness: 0.72 });
  return _poleMat;
}
const _m = new THREE.Matrix4();
const _boardQuat = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);
const DOWN = new THREE.Vector3(0, -1, 0);
