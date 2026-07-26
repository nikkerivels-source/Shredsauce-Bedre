import { DEG, clamp, clamp01, fbm2D, smoothstep } from '../core/math.ts';
import { Heightfield } from './heightfield.ts';
import type {
  Feature,
  HalfpipeFeature,
  HipFeature,
  KickerFeature,
  LevelDef,
  QuarterpipeFeature,
  RollerFeature,
  TerrainBrush,
  WallrideFeature,
} from './level.ts';
import { isTerrainFeature } from './level.ts';

export interface Aabb {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/**
 * Bakes a level into a heightfield.
 *
 * The rule for combining shapes matches how a park actually gets built: natural
 * ground first, then features stamped on top taking the maximum (dirt is piled,
 * not summed, so overlapping jumps blend instead of launching to orbit), then
 * hand-sculpted brush strokes added last.
 */
export class TerrainBaker {
  readonly level: LevelDef;
  readonly field: Heightfield;

  constructor(level: LevelDef) {
    this.level = level;
    const t = level.terrain;
    this.field = new Heightfield(-t.width / 2, 0, t.width, t.length, t.resolution);
    this.bakeAll();
  }

  bakeAll(): void {
    this.bakeRegion({
      minX: this.field.minX,
      minZ: this.field.minZ,
      maxX: this.field.maxX,
      maxZ: this.field.maxZ,
    });
  }

  /**
   * Rebuilds only the cells inside `region`. The editor uses this so dragging a
   * jump around stays interactive on a large mountain.
   */
  bakeRegion(region: Aabb): void {
    const f = this.field;
    const ix0 = clamp(Math.floor(f.gridX(region.minX)), 0, f.nx - 1);
    const ix1 = clamp(Math.ceil(f.gridX(region.maxX)), 0, f.nx - 1);
    const iz0 = clamp(Math.floor(f.gridZ(region.minZ)), 0, f.nz - 1);
    const iz1 = clamp(Math.ceil(f.gridZ(region.maxZ)), 0, f.nz - 1);

    // Pass 1: natural ground.
    for (let iz = iz0; iz <= iz1; iz++) {
      const z = f.worldZ(iz);
      for (let ix = ix0; ix <= ix1; ix++) {
        const x = f.worldX(ix);
        f.heights[iz * f.nx + ix] = this.naturalHeight(x, z);
      }
    }

    // Pass 2: constructed features, restricted to the cells each one covers.
    for (const feature of this.level.features) {
      if (!isTerrainFeature(feature)) continue;
      const box = featureBounds(feature);
      if (!overlaps(box, region)) continue;
      this.stampFeature(feature, intersect(box, region));
    }

    // Wallrides are near-vertical walls; they stamp like features but clamp
    // rather than blend so the face stays sheer.
    for (const feature of this.level.features) {
      if (feature.kind !== 'wallride') continue;
      const box = featureBounds(feature);
      if (!overlaps(box, region)) continue;
      this.stampWallride(feature, intersect(box, region));
    }

    // Pass 3: sculpting strokes.
    for (const brush of this.level.brushes) {
      const box = brushBounds(brush);
      if (!overlaps(box, region)) continue;
      this.stampBrush(brush, intersect(box, region));
    }
  }

  /** Ground before anything is built on it. */
  naturalHeight(x: number, z: number): number {
    const t = this.level.terrain;
    const seed = this.level.seed;

    // Base pitch, gently varying so the hill has steeps and flats.
    const pitchVariation = fbm2D(0, z / (t.featureScale * 4), seed + 77, 2) * 6;
    const angle = clamp(t.slopeAngle + pitchVariation, 3, 60) * DEG;
    let h = -z * Math.tan(angle);

    // Rolling terrain.
    if (t.roughness > 0) {
      h += fbm2D(x / t.featureScale, z / t.featureScale, seed, 5) * t.roughness;
      h += fbm2D(x / (t.featureScale * 0.22), z / (t.featureScale * 0.22), seed + 991, 3) * t.roughness * 0.18;
    }

    // Gully banking so a rider who drifts wide gets funnelled back to the line.
    if (t.banking > 0) {
      const half = t.width / 2;
      const u = clamp01(Math.abs(x) / half);
      h += t.banking * half * 0.5 * u * u * u;
    }

    return h;
  }

  private stampFeature(feature: Feature, region: Aabb): void {
    const f = this.field;
    const ix0 = clamp(Math.floor(f.gridX(region.minX)), 0, f.nx - 1);
    const ix1 = clamp(Math.ceil(f.gridX(region.maxX)), 0, f.nx - 1);
    const iz0 = clamp(Math.floor(f.gridZ(region.minZ)), 0, f.nz - 1);
    const iz1 = clamp(Math.ceil(f.gridZ(region.maxZ)), 0, f.nz - 1);
    const h = feature.heading * DEG;
    const sin = Math.sin(h);
    const cos = Math.cos(h);

    for (let iz = iz0; iz <= iz1; iz++) {
      const wz = f.worldZ(iz) - feature.z;
      for (let ix = ix0; ix <= ix1; ix++) {
        const wx = f.worldX(ix) - feature.x;
        // World -> feature local: forward = (sin, cos), right = (cos, -sin).
        const lz = wx * sin + wz * cos;
        const lx = wx * cos - wz * sin;
        const rise = this.featureRise(feature, lx, lz);
        if (rise <= 0) continue;
        const i = iz * f.nx + ix;
        const ground = this.naturalHeight(f.worldX(ix), f.worldZ(iz));
        const target = ground + rise;
        if (target > f.heights[i]) f.heights[i] = target;
      }
    }
  }

  /** Height a terrain feature adds above natural ground at a local point. */
  private featureRise(feature: Feature, lx: number, lz: number): number {
    switch (feature.kind) {
      case 'kicker':
        return kickerRise(feature, lx, lz);
      case 'roller':
        return rollerRise(feature, lx, lz);
      case 'hip':
        return hipRise(feature, lx, lz);
      case 'quarterpipe':
        return quarterpipeRise(feature, lx, lz);
      case 'halfpipe':
        return halfpipeRise(feature, lx, lz);
      default:
        return 0;
    }
  }

  private stampWallride(feature: WallrideFeature, region: Aabb): void {
    const f = this.field;
    const ix0 = clamp(Math.floor(f.gridX(region.minX)), 0, f.nx - 1);
    const ix1 = clamp(Math.ceil(f.gridX(region.maxX)), 0, f.nx - 1);
    const iz0 = clamp(Math.floor(f.gridZ(region.minZ)), 0, f.nz - 1);
    const iz1 = clamp(Math.ceil(f.gridZ(region.maxZ)), 0, f.nz - 1);
    const h = feature.heading * DEG;
    const sin = Math.sin(h);
    const cos = Math.cos(h);
    const lean = Math.tan(clamp(feature.lean, 0, 45) * DEG);

    for (let iz = iz0; iz <= iz1; iz++) {
      const wz = f.worldZ(iz) - feature.z;
      for (let ix = ix0; ix <= ix1; ix++) {
        const wx = f.worldX(ix) - feature.x;
        const lz = wx * sin + wz * cos;
        const lx = wx * cos - wz * sin;
        if (lz < 0 || lz > feature.length) continue;
        // The wall occupies lx in [0, thickness]; leaning widens the base.
        const thickness = 0.6 + feature.height * lean;
        if (lx < 0 || lx > thickness) continue;
        const endFade = Math.min(smoothstep(0, 1.2, lz), smoothstep(0, 1.2, feature.length - lz));
        const rise = feature.height * endFade;
        const i = iz * f.nx + ix;
        const ground = this.naturalHeight(f.worldX(ix), f.worldZ(iz));
        const target = ground + rise;
        if (target > f.heights[i]) f.heights[i] = target;
      }
    }
  }

  private stampBrush(brush: TerrainBrush, region: Aabb): void {
    const f = this.field;
    const ix0 = clamp(Math.floor(f.gridX(region.minX)), 0, f.nx - 1);
    const ix1 = clamp(Math.ceil(f.gridX(region.maxX)), 0, f.nx - 1);
    const iz0 = clamp(Math.floor(f.gridZ(region.minZ)), 0, f.nz - 1);
    const iz1 = clamp(Math.ceil(f.gridZ(region.maxZ)), 0, f.nz - 1);
    const r = Math.max(0.5, brush.radius);
    const exponent = 1 + 2 * (1 - clamp01(brush.falloff));

    for (let iz = iz0; iz <= iz1; iz++) {
      const dz = f.worldZ(iz) - brush.z;
      for (let ix = ix0; ix <= ix1; ix++) {
        const dx = f.worldX(ix) - brush.x;
        const t2 = (dx * dx + dz * dz) / (r * r);
        if (t2 >= 1) continue;
        const k = Math.pow(1 - t2, exponent);
        f.heights[iz * f.nx + ix] += brush.amount * k;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Feature shape functions. Each returns metres above natural ground.
// ---------------------------------------------------------------------------

/** Lateral taper so a feature blends into the surrounding snow at its edges. */
function lateralProfile(lx: number, width: number, edge = 1.2): number {
  const half = width / 2;
  const d = Math.abs(lx);
  if (d >= half) return 0;
  return smoothstep(half, half - edge, d);
}

/**
 * A kicker is a circular transition from flat ground to the lip angle, which is
 * how jumps are actually shaped: the rider leaves at a known angle with no
 * discontinuity in curvature, so pop timing is a real skill.
 */
export function kickerGeometry(k: KickerFeature): { radius: number; rampLength: number; knuckleZ: number } {
  const theta = clamp(k.lipAngle, 5, 70) * DEG;
  const height = Math.max(0.2, k.height);
  const radius = height / (1 - Math.cos(theta));
  const rampLength = radius * Math.sin(theta);
  return { radius, rampLength, knuckleZ: rampLength + Math.max(0, k.gap) };
}

export function kickerRise(k: KickerFeature, lx: number, lz: number): number {
  const lat = lateralProfile(lx, k.width);
  if (lat <= 0) return 0;
  const { radius, rampLength, knuckleZ } = kickerGeometry(k);
  const height = Math.max(0.2, k.height);

  let rise = 0;
  if (lz >= 0 && lz <= rampLength) {
    // Circular in-run: h = R - sqrt(R^2 - z^2).
    rise = radius - Math.sqrt(Math.max(0, radius * radius - lz * lz));
  } else if (lz > rampLength && lz <= rampLength + 0.5) {
    // Back of the lip drops away steeply.
    rise = height * (1 - (lz - rampLength) / 0.5);
  } else if (k.landingLength > 0 && lz > rampLength) {
    const knuckleHeight = height * 0.85;
    const landingAngle = clamp(k.landingAngle, 5, 60) * DEG;
    if (lz < knuckleZ) {
      // Leading face of the knuckle — the bit you do not want to case.
      rise = knuckleHeight * smoothstep(knuckleZ - 2.5, knuckleZ, lz);
    } else if (lz <= knuckleZ + k.landingLength) {
      const along = lz - knuckleZ;
      // Landing falls away faster than the hill so it flattens out at the base.
      const drop = along * Math.tan(landingAngle) * 0.55;
      rise = Math.max(0, knuckleHeight - drop);
    }
  }

  return rise * lat;
}

export function rollerRise(r: RollerFeature, lx: number, lz: number): number {
  const halfL = r.length / 2;
  if (Math.abs(lz) > halfL) return 0;
  const lat = lateralProfile(lx, r.width, 2);
  if (lat <= 0) return 0;
  const u = clamp01(1 - Math.abs(lz) / halfL);
  // Cosine dome: continuous slope at the base so you can pump it smoothly.
  const along = 0.5 - 0.5 * Math.cos(u * Math.PI);
  return r.height * along * lat;
}

export function hipRise(h: HipFeature, lx: number, lz: number): number {
  // Takeoff behaves like a kicker...
  const takeoff = kickerRise(
    {
      id: h.id,
      kind: 'kicker',
      x: 0,
      z: 0,
      heading: 0,
      height: h.height,
      lipAngle: 32,
      width: h.width,
      gap: 0,
      landingLength: 0,
      landingAngle: 30,
    },
    lx,
    lz,
  );
  // ...and the landing is the same shape rotated away to the side, which is what
  // makes a hip a hip: you jump one way and land another.
  const a = clamp(h.hipAngle, 10, 90) * DEG;
  const sin = Math.sin(a);
  const cos = Math.cos(a);
  const pivotZ = h.length * 0.35;
  const rx = lx;
  const rz = lz - pivotZ;
  const tz = rx * sin + rz * cos;
  const tx = rx * cos - rz * sin;
  const landing = Math.max(0, h.height * 0.8 - Math.max(0, tz) * 0.5) * lateralProfile(tx, h.width, 2);
  return Math.max(takeoff, landing);
}

export function quarterpipeRise(q: QuarterpipeFeature, lx: number, lz: number): number {
  const lat = lateralProfile(lx, q.width, 1.5);
  if (lat <= 0 || lz < 0) return 0;
  const r = Math.max(0.5, q.radius);
  let rise: number;
  if (lz <= r) {
    // Quarter circle from flat to vertical.
    rise = r - Math.sqrt(Math.max(0, r * r - lz * lz));
  } else if (lz <= r + 0.35) {
    // Short, very steep section standing in for the vertical lip.
    rise = r + q.vert * ((lz - r) / 0.35);
  } else {
    rise = r + q.vert;
  }
  return rise * lat;
}

export function halfpipeRise(p: HalfpipeFeature, lx: number, lz: number): number {
  if (lz < 0 || lz > p.length) return 0;
  const half = p.flatWidth / 2;
  const d = Math.abs(lx);
  if (d <= half) return 0;
  const r = Math.max(0.5, p.radius);
  const u = d - half;
  let rise: number;
  if (u <= r) {
    rise = r - Math.sqrt(Math.max(0, r * r - u * u));
  } else if (u <= r + 0.35) {
    rise = r + p.vert * ((u - r) / 0.35);
  } else {
    rise = r + p.vert;
  }
  // Fade the walls in and out at the ends so you can drop in and ride out.
  const endFade = Math.min(smoothstep(0, 6, lz), smoothstep(0, 6, p.length - lz));
  return rise * endFade;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** World-space AABB covering everything a feature can modify, with margin. */
export function featureBounds(feature: Feature): Aabb {
  let forward = 4;
  let back = 4;
  let side = 4;

  switch (feature.kind) {
    case 'kicker': {
      const { rampLength, knuckleZ } = kickerGeometry(feature);
      forward = Math.max(rampLength + 1, knuckleZ + feature.landingLength) + 3;
      back = 3;
      side = feature.width / 2 + 3;
      break;
    }
    case 'roller':
      forward = feature.length / 2 + 3;
      back = feature.length / 2 + 3;
      side = feature.width / 2 + 4;
      break;
    case 'hip':
      forward = feature.length + feature.height * 3 + 6;
      back = 4;
      side = feature.width + 8;
      break;
    case 'quarterpipe':
      forward = feature.radius + feature.vert + 4;
      back = 3;
      side = feature.width / 2 + 3;
      break;
    case 'halfpipe':
      forward = feature.length + 8;
      back = 8;
      side = feature.flatWidth / 2 + feature.radius + feature.vert + 6;
      break;
    case 'wallride':
      forward = feature.length + 3;
      back = 3;
      side = feature.height + 3;
      break;
    case 'rail':
    case 'box': {
      const len = feature.length;
      const width = feature.kind === 'box' ? feature.width : feature.thickness;
      forward = len + 3;
      back = 3;
      side = width / 2 + 3;
      break;
    }
    case 'gate':
      side = feature.width / 2 + 2;
      break;
    case 'prop':
      side = 3 * feature.scale;
      forward = 3 * feature.scale;
      back = 3 * feature.scale;
      break;
  }

  // Rotate the local box corners into world space.
  const h = feature.heading * DEG;
  const sin = Math.sin(h);
  const cos = Math.cos(h);
  const corners: Array<[number, number]> = [
    [-side, -back],
    [side, -back],
    [-side, forward],
    [side, forward],
  ];
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [lx, lz] of corners) {
    // local -> world using forward = (sin, cos), right = (cos, -sin).
    const wx = feature.x + lx * cos + lz * sin;
    const wz = feature.z - lx * sin + lz * cos;
    if (wx < minX) minX = wx;
    if (wx > maxX) maxX = wx;
    if (wz < minZ) minZ = wz;
    if (wz > maxZ) maxZ = wz;
  }
  return { minX, minZ, maxX, maxZ };
}

export function brushBounds(brush: TerrainBrush): Aabb {
  const r = brush.radius + 1;
  return { minX: brush.x - r, minZ: brush.z - r, maxX: brush.x + r, maxZ: brush.z + r };
}

export function overlaps(a: Aabb, b: Aabb): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minZ <= b.maxZ && a.maxZ >= b.minZ;
}

export function intersect(a: Aabb, b: Aabb): Aabb {
  return {
    minX: Math.max(a.minX, b.minX),
    minZ: Math.max(a.minZ, b.minZ),
    maxX: Math.min(a.maxX, b.maxX),
    maxZ: Math.min(a.maxZ, b.maxZ),
  };
}

export function unionAabb(a: Aabb, b: Aabb): Aabb {
  return {
    minX: Math.min(a.minX, b.minX),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

export function expandAabb(a: Aabb, m: number): Aabb {
  return { minX: a.minX - m, minZ: a.minZ - m, maxX: a.maxX + m, maxZ: a.maxZ + m };
}
