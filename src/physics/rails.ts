import { DEG, Vec3, clamp } from '../core/math.ts';
import type { BoxFeature, LevelDef, RailFeature } from '../world/level.ts';
import { isGrindFeature } from '../world/level.ts';
import type { Heightfield } from '../world/heightfield.ts';

export type GrindKind = 'rail' | 'box';

/**
 * A grindable edge, flattened into a polyline of world-space points along the
 * surface the board actually slides on.
 */
export interface GrindSurface {
  id: string;
  kind: GrindKind;
  /** Top-surface centreline. Two points for a straight rail, three if kinked. */
  points: Vec3[];
  /** Cumulative arc length at each point. */
  arc: number[];
  totalLength: number;
  /** Half the slideable width. A round rail is a knife edge, a box is forgiving. */
  halfWidth: number;
  /** Sliding friction coefficient along the surface. */
  friction: number;
  /**
   * How unstable the surface is to balance on, 0-1. Round rails roll the board
   * off under you; flat bars and boxes sit still.
   */
  instability: number;
}

export interface GrindQuery {
  surface: GrindSurface;
  /** Closest point on the centreline. */
  point: Vec3;
  /** Unit tangent, pointing along increasing arc length. */
  tangent: Vec3;
  /** Distance along the surface from the start. */
  along: number;
  /** Perpendicular distance from the centreline. */
  distance: number;
}

const _a = new Vec3();
const _b = new Vec3();
const _ab = new Vec3();
const _ap = new Vec3();
const _closest = new Vec3();

/** Builds the grindable geometry for a level. */
export function buildGrindSurfaces(level: LevelDef, field: Heightfield): GrindSurface[] {
  const out: GrindSurface[] = [];
  for (const feature of level.features) {
    if (!isGrindFeature(feature)) continue;
    out.push(feature.kind === 'rail' ? buildRail(feature, field) : buildBox(feature, field));
  }
  return out;
}

function localToWorld(
  originX: number,
  originZ: number,
  heading: number,
  lx: number,
  lz: number,
): { x: number; z: number } {
  const h = heading * DEG;
  const sin = Math.sin(h);
  const cos = Math.cos(h);
  return { x: originX + lx * cos + lz * sin, z: originZ - lx * sin + lz * cos };
}

function buildRail(rail: RailFeature, field: Heightfield): GrindSurface {
  const length = Math.max(1, rail.length);
  const points: Vec3[] = [];
  const kink = rail.kink;
  const stops = Math.abs(kink) > 0.5 ? [0, 0.5, 1] : [0, 1];

  for (const t of stops) {
    // A kink bends the rail sideways at the midpoint.
    const lateral = Math.abs(kink) > 0.5 ? Math.sin(t * Math.PI) * Math.tan(clamp(kink, -60, 60) * DEG) * length * 0.25 : 0;
    const { x, z } = localToWorld(rail.x, rail.z, rail.heading, lateral, t * length);
    const ground = field.heightAt(x, z);
    const h = rail.height + (rail.endHeight - rail.height) * t;
    points.push(new Vec3(x, ground + h, z));
  }

  const thickness = Math.max(0.03, rail.thickness);
  return finishSurface({
    id: rail.id,
    kind: 'rail',
    points,
    halfWidth: thickness / 2,
    friction: 0.055,
    // A round tube is the hardest thing in the park to stay on top of.
    instability: rail.shape === 'round' ? 1 : rail.shape === 'flat' ? 0.55 : 0.7,
  });
}

function buildBox(box: BoxFeature, field: Heightfield): GrindSurface {
  const length = Math.max(1, box.length);
  const points: Vec3[] = [];
  for (const t of [0, 1]) {
    const { x, z } = localToWorld(box.x, box.z, box.heading, 0, t * length);
    const ground = field.heightAt(x, z);
    const h = box.height + (box.endHeight - box.height) * t;
    points.push(new Vec3(x, ground + h, z));
  }
  return finishSurface({
    id: box.id,
    kind: 'box',
    points,
    halfWidth: Math.max(0.15, box.width / 2),
    friction: 0.075,
    instability: 0.18,
  });
}

function finishSurface(partial: Omit<GrindSurface, 'arc' | 'totalLength'>): GrindSurface {
  const arc: number[] = [0];
  let total = 0;
  for (let i = 1; i < partial.points.length; i++) {
    total += partial.points[i].distanceTo(partial.points[i - 1]);
    arc.push(total);
  }
  return { ...partial, arc, totalLength: total };
}

/**
 * Closest point on a grind surface to `p`, or null when nothing is within
 * `maxDistance`. Levels hold a handful of rails so a linear scan with an early
 * bounding reject is faster than any acceleration structure would be.
 */
export function queryGrindSurfaces(
  surfaces: readonly GrindSurface[],
  p: Vec3,
  maxDistance: number,
  out: GrindQuery,
): GrindQuery | null {
  let best: GrindQuery | null = null;
  let bestDist = maxDistance;

  for (const surface of surfaces) {
    for (let i = 1; i < surface.points.length; i++) {
      _a.copy(surface.points[i - 1]);
      _b.copy(surface.points[i]);
      _ab.subVectors(_b, _a);
      const abLenSq = _ab.lengthSq();
      if (abLenSq < 1e-6) continue;
      _ap.subVectors(p, _a);
      const t = clamp(_ap.dot(_ab) / abLenSq, 0, 1);
      _closest.copy(_a).addScaled(_ab, t);
      const dist = _closest.distanceTo(p);
      if (dist >= bestDist) continue;
      bestDist = dist;
      out.surface = surface;
      out.point.copy(_closest);
      out.tangent.copy(_ab).normalize();
      out.along = surface.arc[i - 1] + t * Math.sqrt(abLenSq);
      out.distance = dist;
      best = out;
    }
  }
  return best;
}

export function makeGrindQuery(): GrindQuery {
  return {
    surface: null as unknown as GrindSurface,
    point: new Vec3(),
    tangent: new Vec3(),
    along: 0,
    distance: Infinity,
  };
}
