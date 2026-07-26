import * as THREE from 'three';
import { Vec3, clamp, clamp01, damp, lerp } from '../core/math.ts';
import type { Heightfield } from '../world/heightfield.ts';
import type { RiderSim } from '../physics/riderSim.ts';

export type CameraMode = 'chase' | 'close' | 'cinematic' | 'firstPerson' | 'free';

export const CAMERA_MODES: CameraMode[] = ['chase', 'close', 'cinematic', 'firstPerson', 'free'];

export const CAMERA_LABELS: Record<CameraMode, string> = {
  chase: 'Chase',
  close: 'Close',
  cinematic: 'Cinematic',
  firstPerson: 'First person',
  free: 'Free',
};

interface Preset {
  distance: number;
  height: number;
  fov: number;
  /** How quickly the rig chases the rider; lower is looser and more filmic. */
  follow: number;
  lookAhead: number;
}

const PRESETS: Record<CameraMode, Preset> = {
  chase: { distance: 7.2, height: 2.5, fov: 68, follow: 5.5, lookAhead: 5 },
  close: { distance: 4.4, height: 1.7, fov: 76, follow: 8.5, lookAhead: 3 },
  cinematic: { distance: 11, height: 3.6, fov: 46, follow: 1.9, lookAhead: 9 },
  firstPerson: { distance: 0, height: 0, fov: 88, follow: 22, lookAhead: 12 },
  free: { distance: 8, height: 3, fov: 62, follow: 4, lookAhead: 4 },
};

/**
 * Follow camera.
 *
 * The rig tracks the rider's velocity rather than their facing, which is what
 * keeps a spin readable — the world stays put while the rider rotates inside the
 * frame instead of the camera whipping around with them. Speed widens the field
 * of view and pulls the camera back, so going fast feels fast.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';
  /** Extra yaw the player has dragged in, radians. */
  orbitYaw = 0;
  orbitPitch = 0;
  shake = 0;
  private jitterPhase = 0;

  private readonly position = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly smoothedDir = new THREE.Vector3(0, 0, 1);
  private readonly desired = new THREE.Vector3();
  private currentFov = 68;
  private currentDistance = 7.2;
  private field: Heightfield;
  private freePos = new THREE.Vector3();
  private freeYaw = 0;
  private freePitch = -0.2;

  constructor(field: Heightfield, aspect = 1.7) {
    this.field = field;
    // Far plane reaches past the outermost ridge of the mountain backdrop.
    this.camera = new THREE.PerspectiveCamera(68, aspect, 0.12, 7000);
    this.camera.position.set(0, 12, -12);
  }

  setField(field: Heightfield): void {
    this.field = field;
  }

  cycle(): CameraMode {
    const i = CAMERA_MODES.indexOf(this.mode);
    this.mode = CAMERA_MODES[(i + 1) % CAMERA_MODES.length];
    return this.mode;
  }

  /** Nudges the free camera. Values are per-second rates. */
  driveFree(dt: number, forward: number, strafe: number, up: number, yaw: number, pitch: number): void {
    this.freeYaw += yaw * dt;
    this.freePitch = clamp(this.freePitch + pitch * dt, -1.4, 1.4);
    const speed = 26 * dt;
    const cos = Math.cos(this.freeYaw);
    const sin = Math.sin(this.freeYaw);
    this.freePos.x += (sin * forward + cos * strafe) * speed;
    this.freePos.z += (cos * forward - sin * strafe) * speed;
    this.freePos.y += up * speed;
  }

  update(dt: number, sim: RiderSim, opts: { speedFov?: boolean } = {}): void {
    const preset = PRESETS[this.mode];
    const speed = sim.velocity.length();

    if (this.mode === 'free') {
      this.camera.position.copy(this.freePos);
      const dir = new THREE.Vector3(
        Math.sin(this.freeYaw) * Math.cos(this.freePitch),
        Math.sin(this.freePitch),
        Math.cos(this.freeYaw) * Math.cos(this.freePitch),
      );
      this.camera.lookAt(this.freePos.clone().add(dir));
      this.applyFov(dt, preset.fov);
      return;
    }

    _riderPos.set(sim.position.x, sim.position.y, sim.position.z);

    // Track the direction of travel, falling back to where the board points when
    // the rider is nearly stopped.
    if (speed > 1.2) {
      _dir.set(sim.velocity.x, 0, sim.velocity.z);
      if (_dir.lengthSq() < 1e-5) _dir.set(0, 0, 1);
      _dir.normalize();
    } else {
      sim.getBoardAxes(_tmpA, _tmpB, _tmpC);
      _dir.set(_tmpC.x, 0, _tmpC.z);
      if (_dir.lengthSq() < 1e-5) _dir.set(0, 0, 1);
      _dir.normalize();
    }
    // Loose follow: the camera lags the rider's line, which is what makes a
    // carve read as a carve from behind.
    const followRate = preset.follow * (sim.state === 'airborne' ? 0.55 : 1);
    this.smoothedDir.x = damp(this.smoothedDir.x, _dir.x, followRate, dt);
    this.smoothedDir.z = damp(this.smoothedDir.z, _dir.z, followRate, dt);
    if (this.smoothedDir.lengthSq() < 1e-6) this.smoothedDir.set(0, 0, 1);
    this.smoothedDir.normalize();

    if (this.mode === 'firstPerson') {
      sim.getBodyAxes(_tmpA, _tmpB, _tmpC);
      this.camera.position.copy(_riderPos).addScaledVector(_tmpB, 0.42);
      _lookAt.copy(this.camera.position).addScaledVector(_tmpC, 4).addScaledVector(_tmpA, 0);
      this.camera.up.set(_tmpB.x, _tmpB.y, _tmpB.z);
      this.camera.lookAt(_lookAt);
      this.applyFov(dt, preset.fov + clamp01(speed / 30) * 12);
      return;
    }

    this.camera.up.set(0, 1, 0);

    // Speed pulls the camera back and opens the lens.
    const speedT = clamp01(speed / 26);
    const distance = preset.distance * lerp(0.88, 1.28, speedT);
    this.currentDistance = damp(this.currentDistance, distance, 3, dt);

    const yaw = this.orbitYaw;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    const dx = this.smoothedDir.x * cos - this.smoothedDir.z * sin;
    const dz = this.smoothedDir.x * sin + this.smoothedDir.z * cos;

    this.desired
      .copy(_riderPos)
      .addScaledVector(_tmpVec.set(dx, 0, dz), -this.currentDistance)
      .add(_tmpVec.set(0, preset.height + this.orbitPitch * 4 + speedT * 0.8, 0));

    // Never let the camera clip into the mountain.
    const ground = this.field.heightAt(this.desired.x, this.desired.z);
    if (this.desired.y < ground + 1.1) this.desired.y = ground + 1.1;

    const posRate = this.mode === 'cinematic' ? 2.2 : 9;
    this.position.x = damp(this.position.x || this.desired.x, this.desired.x, posRate, dt);
    this.position.y = damp(this.position.y || this.desired.y, this.desired.y, posRate, dt);
    this.position.z = damp(this.position.z || this.desired.z, this.desired.z, posRate, dt);

    // Look slightly ahead of the rider so you can read the terrain coming up.
    this.target
      .copy(_riderPos)
      .addScaledVector(_tmpVec.set(dx, 0, dz), preset.lookAhead * lerp(0.3, 1, speedT))
      .add(_tmpVec.set(0, 0.6, 0));

    this.camera.position.copy(this.position);

    // Constant low-level jitter at speed. Real footage is never locked off, and
    // without it 70 km/h looks exactly like 20 km/h from behind.
    const jitter = Math.max(0, speedT - 0.35) * 0.055;
    if (jitter > 0.0005) {
      this.jitterPhase += dt * (7 + speedT * 16);
      this.camera.position.x += Math.sin(this.jitterPhase * 1.7) * jitter;
      this.camera.position.y += Math.sin(this.jitterPhase * 2.3 + 1.1) * jitter * 0.8;
    }

    if (this.shake > 0.001) {
      const s = this.shake;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
      this.shake = damp(this.shake, 0, 6, dt);
    }

    this.camera.lookAt(this.target);
    const fov = opts.speedFov === false ? preset.fov : preset.fov + speedT * 12;
    this.applyFov(dt, fov);
  }

  /**
   * Slow orbit used behind the menus, so the title screen is a live shot of the
   * mountain you are about to ride rather than a still image.
   */
  showcase(dt: number, focus: THREE.Vector3, radius = 74): void {
    // A slow drift through a limited arc *behind* the focus rather than a full
    // orbit. A free orbit spends most of its cycle pointed up the hill at blank
    // snow; staying behind and looking down the fall line always frames the run,
    // the rider and the skyline together.
    this.showcaseAngle += dt * 0.11;
    const arc = Math.PI + Math.sin(this.showcaseAngle) * 0.5;
    const height = radius * 0.34;

    this.camera.up.set(0, 1, 0);
    this.camera.position.set(
      focus.x + Math.sin(arc) * radius,
      focus.y + height,
      focus.z + Math.cos(arc) * radius,
    );
    const ground = this.field.heightAt(this.camera.position.x, this.camera.position.z);
    if (this.camera.position.y < ground + 6) this.camera.position.y = ground + 6;
    this.camera.lookAt(focus.x, focus.y + 10, focus.z);
    this.applyFov(dt, 44);
  }

  private showcaseAngle = 0.7;

  /** Points the camera at a spot on the hill, used by the editor and menus. */
  frame(target: THREE.Vector3, distance: number, yaw: number, pitch: number): void {
    const x = target.x + Math.sin(yaw) * Math.cos(pitch) * distance;
    const z = target.z + Math.cos(yaw) * Math.cos(pitch) * distance;
    const y = target.y + Math.sin(pitch) * distance;
    this.camera.position.set(x, y, z);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(target);
    this.position.copy(this.camera.position);
    this.freePos.copy(this.camera.position);
    this.freeYaw = Math.atan2(target.x - x, target.z - z);
    this.freePitch = Math.asin(clamp((target.y - y) / Math.max(0.001, distance), -1, 1));
  }

  private applyFov(dt: number, fov: number): void {
    this.currentFov = damp(this.currentFov, fov, 4, dt);
    if (Math.abs(this.camera.fov - this.currentFov) > 0.01) {
      this.camera.fov = this.currentFov;
      this.camera.updateProjectionMatrix();
    }
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }
}

const _riderPos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _lookAt = new THREE.Vector3();
const _tmpVec = new THREE.Vector3();
const _tmpA = new Vec3();
const _tmpB = new Vec3();
const _tmpC = new Vec3();
