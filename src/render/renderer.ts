import * as THREE from 'three';
import { DEG, Vec3, clamp01 } from '../core/math.ts';
import type { Heightfield } from '../world/heightfield.ts';
import type { LevelDef } from '../world/level.ts';
import type { GrindSurface } from '../physics/rails.ts';
import type { ContactReport, Telemetry } from '../physics/riderSim.ts';
import type { RiderPose } from '../physics/ragdoll.ts';
import type { GearSpec } from '../physics/gear.ts';
import { CameraRig } from './cameras.ts';
import { CarveTrail, SprayParticles } from './effects.ts';
import { RiderMesh, type RiderAppearance } from './rider.ts';
import {
  Snowfall,
  buildGrindMeshes,
  buildMountainRange,
  buildTerrainSkirt,
  buildProps,
  buildTerrainMesh,
  createSky,
  createSnowMaterial,
  disposeObject,
  refreshTerrainWear,
  type SkyRig,
} from './world.ts';

export interface QualitySettings {
  shadows: boolean;
  /** Device pixel ratio ceiling. */
  maxPixelRatio: number;
  triangleBudget: number;
  particles: boolean;
  trails: boolean;
}

export function qualityPreset(name: 'low' | 'medium' | 'high'): QualitySettings {
  switch (name) {
    case 'low':
      return { shadows: false, maxPixelRatio: 1, triangleBudget: 70_000, particles: false, trails: true };
    case 'medium':
      return { shadows: true, maxPixelRatio: 1.5, triangleBudget: 160_000, particles: true, trails: true };
    case 'high':
    default:
      return { shadows: true, maxPixelRatio: 2, triangleBudget: 300_000, particles: true, trails: true };
  }
}

/** Detects a sensible starting quality from the device. */
export function detectQuality(): 'low' | 'medium' | 'high' {
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const cores = navigator.hardwareConcurrency ?? 4;
  if (mobile && cores <= 6) return 'low';
  if (mobile || cores <= 4) return 'medium';
  return 'high';
}

/**
 * Owns the three.js scene and everything drawn into it.
 *
 * Level geometry is rebuilt only when the level changes; per-frame work is
 * limited to the rider, effects and camera, so the editor can drop a jump and
 * rebake without the whole mountain being reconstructed.
 */
export class WorldView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly rig: CameraRig;
  readonly trail: CarveTrail;
  readonly spray: SprayParticles;
  quality: QualitySettings;

  private rider: RiderMesh | null = null;
  private ghosts = new Map<string, RiderMesh>();
  private terrain: THREE.Mesh | null = null;
  private grinds: THREE.Group | null = null;
  private props: THREE.Group | null = null;
  private range: THREE.Group | null = null;
  private skirt: THREE.Mesh | null = null;
  private snowMaterial: THREE.MeshStandardMaterial | null = null;
  private sky: SkyRig | null = null;
  private snowfall: Snowfall | null = null;
  private field: Heightfield;
  private level: LevelDef | null = null;
  private wind = new THREE.Vector3();
  private wearTimer = 0;
  private editorHelpers = new THREE.Group();

  constructor(canvas: HTMLCanvasElement, field: Heightfield, quality: QualitySettings) {
    this.field = field;
    this.quality = quality;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: quality.maxPixelRatio <= 1.5,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
    this.renderer.shadowMap.enabled = quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.22;

    this.rig = new CameraRig(field);
    this.trail = new CarveTrail();
    this.spray = new SprayParticles();
    this.scene.add(this.trail.mesh);
    this.scene.add(this.spray.points);
    this.scene.add(this.editorHelpers);
  }

  get camera(): THREE.PerspectiveCamera {
    return this.rig.camera;
  }

  get helpers(): THREE.Group {
    return this.editorHelpers;
  }

  setQuality(quality: QualitySettings): void {
    this.quality = quality;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
    this.renderer.shadowMap.enabled = quality.shadows;
    this.spray.points.visible = quality.particles;
    this.trail.mesh.visible = quality.trails;
    if (this.level) this.loadLevel(this.level, this.field, this.currentGrinds);
  }

  private currentGrinds: readonly GrindSurface[] = [];

  /** Rebuilds all static geometry for a level. */
  loadLevel(level: LevelDef, field: Heightfield, grindSurfaces: readonly GrindSurface[]): void {
    this.level = level;
    this.field = field;
    this.currentGrinds = grindSurfaces;
    this.rig.setField(field);

    if (this.terrain) disposeObject(this.terrain);
    if (this.grinds) disposeObject(this.grinds);
    if (this.props) disposeObject(this.props);
    if (this.range) disposeObject(this.range);
    if (this.skirt) disposeObject(this.skirt);
    this.snowMaterial?.dispose();

    this.snowMaterial = createSnowMaterial(level);
    this.terrain = buildTerrainMesh(field, this.snowMaterial, this.quality.triangleBudget);
    this.terrain.receiveShadow = this.quality.shadows;
    this.scene.add(this.terrain);

    this.grinds = buildGrindMeshes(grindSurfaces);
    this.scene.add(this.grinds);

    this.props = buildProps(level, field);
    this.scene.add(this.props);

    this.skirt = buildTerrainSkirt(field, this.snowMaterial);
    this.scene.add(this.skirt);

    this.range = buildMountainRange(level, field);
    this.scene.add(this.range);

    if (!this.sky) this.sky = createSky(this.scene, level);
    else this.sky.update(level);

    if (this.snowfall) this.scene.remove(this.snowfall.points);
    this.snowfall = new Snowfall(level);
    this.scene.add(this.snowfall.points);

    const rad = level.weather.windDirection * DEG;
    this.wind.set(Math.sin(rad) * level.weather.wind, 0, Math.cos(rad) * level.weather.wind);

    this.trail.clear();
    this.spray.clear();
  }

  /** Applies weather changes without rebuilding geometry. */
  refreshWeather(level: LevelDef): void {
    this.level = level;
    this.sky?.update(level);
    if (this.snowMaterial) {
      const u = this.snowMaterial.userData.uniforms;
      if (u) {
        u.uGroomed.value = level.snow.groomed ? 1 : 0;
        u.uHardness.value = level.snow.hardness;
      }
    }
    const rad = level.weather.windDirection * DEG;
    this.wind.set(Math.sin(rad) * level.weather.wind, 0, Math.cos(rad) * level.weather.wind);
  }

  setRider(gear: GearSpec, appearance: RiderAppearance): RiderMesh {
    if (this.rider) {
      this.rider.setGear(gear);
      this.rider.setAppearance(appearance);
      return this.rider;
    }
    this.rider = new RiderMesh(gear, appearance);
    this.scene.add(this.rider.group);
    return this.rider;
  }

  /** Adds or updates a remote player or replay ghost. */
  setGhost(id: string, gear: GearSpec, appearance: RiderAppearance, pose: RiderPose): void {
    let mesh = this.ghosts.get(id);
    if (!mesh) {
      mesh = new RiderMesh(gear, appearance, { ghost: true });
      this.ghosts.set(id, mesh);
      this.scene.add(mesh.group);
    }
    mesh.setGear(gear);
    mesh.apply(pose);
  }

  removeGhost(id: string): void {
    const mesh = this.ghosts.get(id);
    if (!mesh) return;
    mesh.dispose();
    this.ghosts.delete(id);
  }

  clearGhosts(): void {
    for (const id of [...this.ghosts.keys()]) this.removeGhost(id);
  }

  /** Per-frame rider visuals: pose, tracks and spray. */
  updateRider(
    dt: number,
    pose: RiderPose,
    telemetry: Telemetry,
    contacts: readonly ContactReport[],
    velocity: Vec3,
  ): void {
    this.rider?.apply(pose);

    if (this.quality.trails && telemetry.contactCount > 0 && !telemetry.airborne) {
      _normal.set(pose.boardUp.x, pose.boardUp.y, pose.boardUp.z);
      // A pure carve leaves a thin line; a skid leaves a broad scar.
      const intensity = clamp01(0.25 + telemetry.sprayIntensity * 1.4 + (1 - telemetry.carveQuality) * 0.5);
      this.trail.push(contacts, _normal, intensity);
    }

    if (this.quality.particles) {
      this.emitSpray(dt, telemetry, contacts, velocity);
      this.spray.update(dt, this.wind);
    }
  }

  private emitSpray(
    dt: number,
    telemetry: Telemetry,
    contacts: readonly ContactReport[],
    velocity: Vec3,
  ): void {
    if (telemetry.airborne || telemetry.contactCount === 0) return;
    // Emission is driven straight off the solver: how fast the edge is slipping
    // and how deep it is buried.
    const rate = telemetry.sprayIntensity * 260 + Math.max(0, telemetry.gForce - 1.2) * 40;
    let budget = rate * dt;
    if (budget < 0.05) return;

    for (const c of contacts) {
      if (c.normalForce <= 1 || c.slipSpeed < 0.35) continue;
      const share = Math.min(6, budget * 0.25);
      if (share < 0.2) continue;
      budget -= share;
      const throwSpeed = Math.min(9, c.slipSpeed * 0.85);
      this.spray.emit(
        c.x,
        c.y,
        c.z,
        velocity.x * 0.22 + (Math.random() - 0.5) * throwSpeed,
        1.1 + throwSpeed * 0.32 + c.penetration * 8,
        velocity.z * 0.22 + (Math.random() - 0.5) * throwSpeed,
        Math.max(1, Math.round(share)),
        0.1 + c.penetration * 0.6,
        0.55 + c.penetration * 1.6,
      );
      if (budget <= 0) break;
    }
  }

  /** Big powder explosion, used on landings and crashes. */
  burst(x: number, y: number, z: number, strength: number): void {
    if (!this.quality.particles) return;
    const count = Math.min(160, Math.round(20 + strength * 90));
    this.spray.emit(x, y, z, 0, 1.8 + strength * 2.4, 0, count, 0.2 + strength * 0.22, 1.1 + strength * 0.8);
    this.rig.shake = Math.min(0.55, this.rig.shake + strength * 0.28);
  }

  render(dt: number): void {
    if (this.snowfall) this.snowfall.update(dt, this.camera.position, this.wind);
    // The dome travels with the camera so it never reaches the far plane.
    if (this.sky) this.sky.mesh.position.copy(this.camera.position);

    // Keep the shadow frustum on the rider so the map resolution is not wasted.
    //
    // The offset uses the sky rig's stored sun direction. Re-deriving it by
    // normalising the light's own world position drifts a little further every
    // frame as the rider moves down the hill, and within seconds the sun is
    // somewhere near the horizon and the whole slope goes grey.
    if (this.sky && this.rider) {
      const p = this.rider.group.position;
      const target = this.sky.sun.target;
      target.position.set(p.x, p.y, p.z);
      target.updateMatrixWorld();
      this.sky.sun.position.copy(target.position).addScaledVector(this.sky.direction, 120);
    }

    this.wearTimer += dt;
    if (this.wearTimer > 0.9 && this.terrain) {
      this.wearTimer = 0;
      refreshTerrainWear(this.terrain, this.field);
    }

    this.renderer.render(this.scene, this.camera);
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.rig.resize(width / Math.max(1, height));
  }

  dispose(): void {
    this.rider?.dispose();
    this.clearGhosts();
    this.trail.dispose();
    this.spray.dispose();
    if (this.terrain) disposeObject(this.terrain);
    if (this.grinds) disposeObject(this.grinds);
    if (this.props) disposeObject(this.props);
    if (this.range) disposeObject(this.range);
    if (this.skirt) disposeObject(this.skirt);
    this.renderer.dispose();
  }
}

const _normal = new THREE.Vector3();
