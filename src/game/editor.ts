import { DEG, clamp, makeRng } from '../core/math.ts';
import {
  cloneLevel,
  isTerrainFeature,
  makeFeature,
  makeId,
  type Feature,
  type FeatureKind,
  type LevelDef,
  type TerrainBrush,
} from '../world/level.ts';
import { expandAabb, featureBounds, unionAabb, type Aabb } from '../world/terrain.ts';
import type { Session } from './session.ts';

export type EditorTool = 'select' | 'place' | 'raise' | 'lower' | 'smooth' | 'spawn';

export interface BrushSettings {
  radius: number;
  strength: number;
  falloff: number;
}

interface Snapshot {
  features: Feature[];
  brushes: TerrainBrush[];
  spawn: LevelDef['spawn'];
}

/**
 * Level editor.
 *
 * Every mutation goes through `apply`, which snapshots for undo and re-bakes
 * only the region the change touched. That keeps dragging a jump around
 * interactive even on a 1.5 km mountain, where a full re-bake would be a
 * noticeable hitch on every mouse-move.
 */
export class LevelEditor {
  tool: EditorTool = 'select';
  placeKind: FeatureKind = 'kicker';
  brush: BrushSettings = { radius: 9, strength: 1.1, falloff: 0.7 };
  selection: string | null = null;
  /** Bumped whenever geometry changed so the view knows to rebuild. */
  revision = 0;

  private session: Session;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private readonly maxUndo = 60;
  private strokeOpen = false;

  constructor(session: Session) {
    this.session = session;
  }

  get level(): LevelDef {
    return this.session.level;
  }

  get selected(): Feature | null {
    return this.level.features.find((f) => f.id === this.selection) ?? null;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  // -------------------------------------------------------------------------

  private snapshot(): Snapshot {
    return {
      features: JSON.parse(JSON.stringify(this.level.features)) as Feature[],
      brushes: JSON.parse(JSON.stringify(this.level.brushes)) as TerrainBrush[],
      spawn: { ...this.level.spawn },
    };
  }

  private pushUndo(): void {
    this.undoStack.push(this.snapshot());
    if (this.undoStack.length > this.maxUndo) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  private restore(snap: Snapshot): void {
    this.level.features = snap.features;
    this.level.brushes = snap.brushes;
    this.level.spawn = { ...snap.spawn };
    this.level.updatedAt = Date.now();
    this.session.rebake();
    this.revision++;
  }

  undo(): void {
    const snap = this.undoStack.pop();
    if (!snap) return;
    this.redoStack.push(this.snapshot());
    this.restore(snap);
  }

  redo(): void {
    const snap = this.redoStack.pop();
    if (!snap) return;
    this.undoStack.push(this.snapshot());
    this.restore(snap);
  }

  /** Groups a drag into a single undo step. */
  beginStroke(): void {
    if (this.strokeOpen) return;
    this.pushUndo();
    this.strokeOpen = true;
  }

  endStroke(): void {
    this.strokeOpen = false;
  }

  // -------------------------------------------------------------------------

  /** Nearest feature to a world point, within `radius` metres. */
  pick(x: number, z: number, radius = 9): Feature | null {
    let best: Feature | null = null;
    let bestDist = radius * radius;
    for (const f of this.level.features) {
      const dx = f.x - x;
      const dz = f.z - z;
      const d = dx * dx + dz * dz;
      if (d < bestDist) {
        bestDist = d;
        best = f;
      }
    }
    return best;
  }

  select(id: string | null): void {
    this.selection = id;
  }

  place(x: number, z: number, heading = 0): Feature {
    this.pushUndo();
    const feature = makeFeature(this.placeKind, x, z, heading);
    this.level.features.push(feature);
    this.selection = feature.id;
    this.rebakeAround(featureBounds(feature));
    return feature;
  }

  moveSelected(x: number, z: number): void {
    const feature = this.selected;
    if (!feature) return;
    const before = featureBounds(feature);
    feature.x = x;
    feature.z = z;
    this.rebakeAround(unionAabb(before, featureBounds(feature)));
  }

  rotateSelected(deltaDeg: number): void {
    const feature = this.selected;
    if (!feature) return;
    this.pushUndo();
    const before = featureBounds(feature);
    feature.heading = (feature.heading + deltaDeg) % 360;
    this.rebakeAround(unionAabb(before, featureBounds(feature)));
  }

  /** Applies a partial update to the selected feature's parameters. */
  updateSelected(patch: Record<string, number | string | boolean>): void {
    const feature = this.selected;
    if (!feature) return;
    this.pushUndo();
    const before = featureBounds(feature);
    Object.assign(feature, patch);
    this.rebakeAround(unionAabb(before, featureBounds(feature)));
  }

  duplicateSelected(): Feature | null {
    const feature = this.selected;
    if (!feature) return null;
    this.pushUndo();
    const copy: Feature = { ...JSON.parse(JSON.stringify(feature)), id: makeId(feature.kind) };
    copy.z += 24;
    this.level.features.push(copy);
    this.selection = copy.id;
    this.rebakeAround(featureBounds(copy));
    return copy;
  }

  deleteSelected(): void {
    const feature = this.selected;
    if (!feature) return;
    this.pushUndo();
    const bounds = featureBounds(feature);
    this.level.features = this.level.features.filter((f) => f.id !== feature.id);
    this.selection = null;
    this.rebakeAround(bounds);
  }

  clearFeatures(): void {
    this.pushUndo();
    this.level.features = [];
    this.level.brushes = [];
    this.selection = null;
    this.session.rebake();
    this.revision++;
  }

  setSpawn(x: number, z: number, heading: number): void {
    this.pushUndo();
    this.level.spawn = { x, z, heading };
    this.level.updatedAt = Date.now();
  }

  /** Terrain sculpting. Call between beginStroke/endStroke while dragging. */
  paintTerrain(x: number, z: number, dt: number, direction: 1 | -1 | 0): void {
    const amount = direction === 0 ? 0 : direction * this.brush.strength * clamp(dt * 12, 0.05, 1);
    if (direction === 0) {
      // Smoothing is a soft negative stroke over the local average, which in
      // practice reads as gently flattening whatever is under the cursor.
      this.smoothTerrain(x, z, dt);
      return;
    }
    const stroke: TerrainBrush = {
      id: makeId('b'),
      x,
      z,
      radius: this.brush.radius,
      amount,
      falloff: this.brush.falloff,
    };
    this.level.brushes.push(stroke);
    // Strokes accumulate fast; merge nearby ones so the list does not explode.
    if (this.level.brushes.length > 900) this.compactBrushes();
    this.rebakeAround({
      minX: x - stroke.radius - 1,
      maxX: x + stroke.radius + 1,
      minZ: z - stroke.radius - 1,
      maxZ: z + stroke.radius + 1,
    });
  }

  private smoothTerrain(x: number, z: number, dt: number): void {
    const field = this.session.field;
    const r = this.brush.radius;
    // Average the surrounding height, then lay a stroke that pulls the centre
    // toward it.
    let sum = 0;
    let count = 0;
    for (let a = 0; a < 8; a++) {
      const angle = (a / 8) * Math.PI * 2;
      sum += field.heightAt(x + Math.cos(angle) * r, z + Math.sin(angle) * r);
      count++;
    }
    const target = sum / Math.max(1, count);
    const current = field.heightAt(x, z);
    const delta = (target - current) * clamp(dt * 5, 0.02, 0.6);
    if (Math.abs(delta) < 0.001) return;
    this.level.brushes.push({
      id: makeId('b'),
      x,
      z,
      radius: r,
      amount: delta,
      falloff: 1,
    });
    this.rebakeAround({ minX: x - r - 1, maxX: x + r + 1, minZ: z - r - 1, maxZ: z + r + 1 });
  }

  /** Collapses overlapping brush strokes to keep levels small and fast. */
  private compactBrushes(): void {
    const merged: TerrainBrush[] = [];
    for (const brush of this.level.brushes) {
      const near = merged.find(
        (m) => Math.hypot(m.x - brush.x, m.z - brush.z) < brush.radius * 0.25 && Math.abs(m.radius - brush.radius) < 0.6,
      );
      if (near) {
        near.amount += brush.amount;
      } else {
        merged.push({ ...brush });
      }
    }
    this.level.brushes = merged;
  }

  private rebakeAround(bounds: Aabb): void {
    this.session.baker.bakeRegion(expandAabb(bounds, 3));
    // Rails sit on the terrain, so their height has to follow it.
    this.session.rebakeGrindsOnly();
    this.level.updatedAt = Date.now();
    this.revision++;
  }

  // -------------------------------------------------------------------------

  /** Scatters a starter park so a blank level is never a blank page. */
  autoFill(seed = Date.now()): void {
    this.pushUndo();
    const rng = makeRng(seed >>> 0);
    const half = this.level.terrain.width / 2 - 22;
    let z = 80;
    while (z < this.level.terrain.length - 120) {
      const roll = rng();
      const x = (rng() - 0.5) * half;
      if (roll < 0.4) {
        const f = makeFeature('rail', x, z) as Extract<Feature, { kind: 'rail' }>;
        f.length = 12 + rng() * 8;
        f.height = 0.7 + rng() * 0.7;
        f.endHeight = 0.4 + rng() * 0.7;
        this.level.features.push(f);
        z += 55 + rng() * 25;
      } else {
        const f = makeFeature('kicker', x, z) as Extract<Feature, { kind: 'kicker' }>;
        f.height = 1.4 + rng() * 3;
        f.width = 8 + rng() * 5;
        f.gap = Math.round(f.height * 3.2);
        f.landingLength = Math.round(f.height * 11);
        this.level.features.push(f);
        z += 90 + f.height * 15 + rng() * 30;
      }
    }
    this.session.rebake();
    this.revision++;
  }

  /** Snapshot of the level ready to save or share. */
  export(): LevelDef {
    const copy = cloneLevel(this.level);
    copy.updatedAt = Date.now();
    return copy;
  }

  /** Editable numeric fields for the selected feature, for the properties panel. */
  static editableFields(feature: Feature): Array<{ key: string; label: string; min: number; max: number; step: number }> {
    const common = [{ key: 'heading', label: 'Rotation', min: -180, max: 180, step: 1 }];
    switch (feature.kind) {
      case 'kicker':
        return [
          { key: 'height', label: 'Lip height', min: 0.3, max: 9, step: 0.1 },
          { key: 'lipAngle', label: 'Lip angle', min: 10, max: 55, step: 1 },
          { key: 'width', label: 'Width', min: 3, max: 24, step: 0.5 },
          { key: 'gap', label: 'Gap', min: 0, max: 40, step: 0.5 },
          { key: 'landingLength', label: 'Landing', min: 0, max: 120, step: 1 },
          { key: 'landingAngle', label: 'Landing angle', min: 10, max: 50, step: 1 },
          ...common,
        ];
      case 'rail':
        return [
          { key: 'length', label: 'Length', min: 3, max: 40, step: 0.5 },
          { key: 'height', label: 'Start height', min: 0.1, max: 4, step: 0.05 },
          { key: 'endHeight', label: 'End height', min: 0.1, max: 4, step: 0.05 },
          { key: 'thickness', label: 'Thickness', min: 0.03, max: 0.3, step: 0.01 },
          { key: 'kink', label: 'Kink', min: -60, max: 60, step: 1 },
          ...common,
        ];
      case 'box':
        return [
          { key: 'length', label: 'Length', min: 3, max: 40, step: 0.5 },
          { key: 'width', label: 'Width', min: 0.4, max: 6, step: 0.1 },
          { key: 'height', label: 'Start height', min: 0.1, max: 4, step: 0.05 },
          { key: 'endHeight', label: 'End height', min: 0.1, max: 4, step: 0.05 },
          ...common,
        ];
      case 'quarterpipe':
        return [
          { key: 'radius', label: 'Radius', min: 1.5, max: 12, step: 0.1 },
          { key: 'vert', label: 'Vert', min: 0, max: 4, step: 0.1 },
          { key: 'width', label: 'Width', min: 4, max: 40, step: 0.5 },
          ...common,
        ];
      case 'halfpipe':
        return [
          { key: 'length', label: 'Length', min: 30, max: 500, step: 5 },
          { key: 'flatWidth', label: 'Flat width', min: 6, max: 30, step: 0.5 },
          { key: 'radius', label: 'Radius', min: 2, max: 10, step: 0.1 },
          { key: 'vert', label: 'Vert', min: 0, max: 3, step: 0.1 },
          ...common,
        ];
      case 'hip':
        return [
          { key: 'height', label: 'Height', min: 0.5, max: 8, step: 0.1 },
          { key: 'width', label: 'Width', min: 4, max: 24, step: 0.5 },
          { key: 'length', label: 'Length', min: 4, max: 40, step: 0.5 },
          { key: 'hipAngle', label: 'Hip angle', min: 10, max: 90, step: 1 },
          ...common,
        ];
      case 'roller':
        return [
          { key: 'height', label: 'Height', min: 0.3, max: 8, step: 0.1 },
          { key: 'width', label: 'Width', min: 4, max: 50, step: 0.5 },
          { key: 'length', label: 'Length', min: 4, max: 60, step: 0.5 },
        ];
      case 'wallride':
        return [
          { key: 'length', label: 'Length', min: 3, max: 40, step: 0.5 },
          { key: 'height', label: 'Height', min: 1, max: 8, step: 0.1 },
          { key: 'lean', label: 'Lean', min: 0, max: 40, step: 1 },
          ...common,
        ];
      case 'gate':
        return [
          { key: 'width', label: 'Width', min: 2, max: 30, step: 0.5 },
          { key: 'order', label: 'Order', min: 0, max: 60, step: 1 },
          ...common,
        ];
      case 'prop':
        return [{ key: 'scale', label: 'Scale', min: 0.3, max: 4, step: 0.05 }, ...common];
      default:
        return common;
    }
  }
}

/** Whether a kind changes the ground or only sits on it, for editor hints. */
export function affectsTerrain(kind: FeatureKind): boolean {
  return isTerrainFeature({ kind } as Feature);
}

export function headingFromDrag(dx: number, dz: number): number {
  return Math.atan2(dx, dz) / DEG;
}
