/**
 * Park design.
 *
 * Builders for the pieces a course is actually made of, plus the spacing rules
 * that make a line ridable. A park is not a scatter of features — a jump needs
 * its landing and then enough run-out to settle and get back to speed, a rail
 * needs a straight approach, and a jib line goes before the jump line because
 * that is the order you build speed in. Everything below encodes one of those
 * rules so the levels read as layouts rather than coordinate soup.
 */

import {
  makeFeature,
  makeId,
  type Feature,
  type PropKind,
  type RailShape,
  type TerrainBrush,
} from '../world/level.ts';

// This file used to declare its own `PropKind` — eight names, shadowing the
// twenty-two in level.ts. The editor could place all of them and a hand-built
// level could not, silently, because the narrower type was the one in scope
// here. Nothing was wrong with the props; they were simply unreachable from
// the design helpers. Importing the real union is the whole fix.

// --- Single features -------------------------------------------------------

export function kicker(
  x: number,
  z: number,
  height: number,
  opts: Partial<{
    lipAngle: number;
    width: number;
    gap: number;
    landingLength: number;
    landingAngle: number;
    heading: number;
  }> = {},
): Feature {
  const f = makeFeature('kicker', x, z, opts.heading ?? 0) as Extract<Feature, { kind: 'kicker' }>;
  f.height = height;
  f.lipAngle = opts.lipAngle ?? 32;
  f.width = opts.width ?? 9;
  // Gap and landing scale with the jump so a bigger lip gets a bigger table.
  f.gap = opts.gap ?? Math.round(height * 3.4);
  f.landingLength = opts.landingLength ?? Math.round(height * 11);
  f.landingAngle = opts.landingAngle ?? 30;
  return f;
}

export function rail(
  x: number,
  z: number,
  length: number,
  opts: Partial<{ height: number; endHeight: number; shape: RailShape; kink: number; heading: number; thickness: number }> = {},
): Feature {
  const f = makeFeature('rail', x, z, opts.heading ?? 0) as Extract<Feature, { kind: 'rail' }>;
  f.length = length;
  f.height = opts.height ?? 0.85;
  f.endHeight = opts.endHeight ?? f.height;
  f.shape = opts.shape ?? 'round';
  f.kink = opts.kink ?? 0;
  f.thickness = opts.thickness ?? 0.09;
  return f;
}

export function box(
  x: number,
  z: number,
  length: number,
  opts: Partial<{ width: number; height: number; endHeight: number; heading: number }> = {},
): Feature {
  const f = makeFeature('box', x, z, opts.heading ?? 0) as Extract<Feature, { kind: 'box' }>;
  f.length = length;
  f.width = opts.width ?? 1.4;
  f.height = opts.height ?? 0.55;
  f.endHeight = opts.endHeight ?? f.height;
  return f;
}

export function roller(x: number, z: number, height: number, width = 18, length = 20): Feature {
  const f = makeFeature('roller', x, z) as Extract<Feature, { kind: 'roller' }>;
  f.height = height;
  f.width = width;
  f.length = length;
  return f;
}

export function hip(
  x: number,
  z: number,
  height: number,
  opts: Partial<{ width: number; length: number; hipAngle: number; heading: number }> = {},
): Feature {
  const f = makeFeature('hip', x, z, opts.heading ?? 0) as Extract<Feature, { kind: 'hip' }>;
  f.height = height;
  f.width = opts.width ?? 12;
  f.length = opts.length ?? 15;
  f.hipAngle = opts.hipAngle ?? 45;
  return f;
}

export function quarterpipe(
  x: number,
  z: number,
  opts: Partial<{ radius: number; vert: number; width: number; heading: number }> = {},
): Feature {
  const f = makeFeature('quarterpipe', x, z, opts.heading ?? 0) as Extract<Feature, { kind: 'quarterpipe' }>;
  f.radius = opts.radius ?? 5;
  f.vert = opts.vert ?? 1;
  f.width = opts.width ?? 16;
  return f;
}

export function halfpipe(
  x: number,
  z: number,
  length: number,
  opts: Partial<{ flatWidth: number; radius: number; vert: number }> = {},
): Feature {
  const f = makeFeature('halfpipe', x, z) as Extract<Feature, { kind: 'halfpipe' }>;
  f.length = length;
  f.flatWidth = opts.flatWidth ?? 17;
  f.radius = opts.radius ?? 6.4;
  f.vert = opts.vert ?? 1.1;
  return f;
}

export function wallride(
  x: number,
  z: number,
  length: number,
  opts: Partial<{ height: number; lean: number; heading: number }> = {},
): Feature {
  const f = makeFeature('wallride', x, z, opts.heading ?? 0) as Extract<Feature, { kind: 'wallride' }>;
  f.length = length;
  f.height = opts.height ?? 3;
  f.lean = opts.lean ?? 8;
  return f;
}

export function gate(x: number, z: number, order: number, width = 8): Feature {
  const f = makeFeature('gate', x, z) as Extract<Feature, { kind: 'gate' }>;
  f.width = width;
  f.order = order;
  return f;
}

export function prop(x: number, z: number, kind: PropKind, scale = 1): Feature {
  const f = makeFeature('prop', x, z) as Extract<Feature, { kind: 'prop' }>;
  f.prop = kind;
  f.scale = scale;
  return f;
}

// --- Spacing ---------------------------------------------------------------

/**
 * Takeoff-to-takeoff distance for a jump of this lip height.
 *
 * A jump owns its landing — about eleven times the lip height, which is what
 * `kicker` builds — and then the rider needs a run-out to settle, re-centre and
 * come back up to speed before the next lip. Thirty metres does that at park
 * speeds. The result lands where real courses sit: 50-75 m between medium
 * jumps, 85-110 m between the big ones.
 */
export function jumpSpacing(height: number): number {
  return height * 11 + 30;
}

export interface JumpLineOptions {
  /** Lip heights in order down the hill. Build them progressive. */
  sizes: number[];
  /** Cross-slope offset per jump; cycles if shorter than `sizes`. */
  offsets?: number[];
  /** Lip width per jump; defaults to a sensible width for the height. */
  widths?: number[];
  lipAngle?: number;
}

/**
 * A sequence of jumps down the fall line.
 *
 * Returns the z of the last landing's end, so a caller can carry on building
 * below it without measuring by hand.
 */
export function jumpLine(out: Feature[], startZ: number, opts: JumpLineOptions): number {
  let z = startZ;
  for (let i = 0; i < opts.sizes.length; i++) {
    const height = opts.sizes[i];
    const x = opts.offsets ? opts.offsets[i % opts.offsets.length] : 0;
    const width = opts.widths ? opts.widths[i % opts.widths.length] : Math.round(6 + height * 1.7);
    out.push(kicker(x, z, height, { width, lipAngle: opts.lipAngle ?? 32 }));
    z += jumpSpacing(height);
  }
  return z;
}

// --- Dressing --------------------------------------------------------------

/** Lift towers marching down one side, as a real lift line does. */
export function liftLine(out: Feature[], x: number, fromZ: number, toZ: number, spacing = 190): void {
  for (let z = fromZ; z <= toZ; z += spacing) out.push(prop(x, z, 'liftTower', 1));
}

/** Course-edge fencing, drawn as closely spaced flags. */
export function fenceLine(out: Feature[], x: number, fromZ: number, toZ: number, spacing = 26): void {
  for (let z = fromZ; z <= toZ; z += spacing) out.push(prop(x, z, 'flag', 0.8));
}

/**
 * Trees outside a corridor.
 *
 * Deterministic from `seed` so a level always looks the same, and never inside
 * `corridor` metres of the centreline, so the piste stays clear.
 */
export function treeStand(
  out: Feature[],
  opts: { fromZ: number; toZ: number; corridor: number; edge: number; count: number; seed: number; kind?: PropKind },
): void {
  let s = opts.seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const span = opts.edge - opts.corridor;
  for (let i = 0; i < opts.count; i++) {
    const side = rand() < 0.5 ? -1 : 1;
    const x = side * (opts.corridor + rand() * span);
    const z = opts.fromZ + rand() * (opts.toZ - opts.fromZ);
    out.push(prop(x, z, opts.kind ?? 'pine', 0.75 + rand() * 0.7));
  }
}

/** Glades: trees scattered right across the run, leaving ridable gaps. */
export function glade(
  out: Feature[],
  opts: { fromZ: number; toZ: number; halfWidth: number; count: number; seed: number },
): void {
  let s = opts.seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < opts.count; i++) {
    out.push(
      prop((rand() * 2 - 1) * opts.halfWidth, opts.fromZ + rand() * (opts.toZ - opts.fromZ), 'pine', 0.8 + rand() * 0.9),
    );
  }
}

// --- Terrain sculpting -----------------------------------------------------

export function brush(x: number, z: number, radius: number, amount: number, falloff = 0.7): TerrainBrush {
  return { id: makeId('brush'), x, z, radius, amount, falloff };
}

/**
 * How far a line of overlapping strokes overshoots one stroke's amount.
 *
 * The terrain baker adds brush strokes together, so laying eight of them a few
 * metres apart with a fifteen-metre radius does not carve fifteen metres of
 * anything — it carves a hole several times deeper than asked for. This returns
 * the peak of the summed falloff for a line spaced `step` apart, so a builder
 * can divide by it and get the depth it actually named. The exponent matches
 * the baker's own `1 + 2 * (1 - falloff)`.
 */
function overlapFactor(step: number, radius: number, falloff: number): number {
  const e = 1 + 2 * (1 - Math.min(1, Math.max(0, falloff)));
  const s = Math.max(step, 1e-3);
  const reach = Math.ceil(radius / s) + 1;
  // The sum does not peak at a stroke centre. Wide soft strokes spaced well
  // inside their own radius pile up highest *between* stamps, where two
  // near-full contributions meet — sampling only at a centre underestimates,
  // and the sculpted shape comes out taller than asked for. So walk one full
  // period and take the worst case.
  let peak = 0;
  const probes = 8;
  for (let p = 0; p < probes; p++) {
    const offset = (p / probes) * s;
    let sum = 0;
    for (let k = -reach; k <= reach; k++) {
      const t2 = ((k * s + offset) / radius) ** 2;
      if (t2 >= 1) continue;
      sum += (1 - t2) ** e;
    }
    peak = Math.max(peak, sum);
  }
  return Math.max(1, peak);
}

/**
 * A raised start platform.
 *
 * Big-air and slopestyle venues build the top of the in-run up so the first
 * pitch is steeper than the hill underneath it. Two overlapping domes do that
 * without a seam.
 */
export function rollIn(out: TerrainBrush[], z: number, height: number, width = 34): void {
  out.push(brush(0, z - width * 0.35, width, height * 0.7, 0.95));
  out.push(brush(0, z, width * 0.8, height * 0.4, 0.85));
}

/**
 * Dishes a landing out below a jump.
 *
 * A built landing is concave — it takes the impact away rather than meeting the
 * rider flat. Cutting it in is what turns a stamped ramp into a shaped venue.
 */
export function landingBowl(out: TerrainBrush[], x: number, z: number, length: number, depth: number): void {
  const steps = Math.max(2, Math.round(length / 18));
  const step = length / Math.max(1, steps - 1);
  const scale = depth / overlapFactor(step, 20, 0.9);
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    out.push(brush(x, z + t * length, 20, -scale * Math.sin(t * Math.PI), 0.9));
  }
}

/** A raised spine running down the fall line. */
export function spine(out: TerrainBrush[], x: number, fromZ: number, toZ: number, height: number, width = 16): void {
  const steps = Math.max(2, Math.round((toZ - fromZ) / 14));
  const step = (toZ - fromZ) / steps;
  const scale = height / overlapFactor(step, width, 0.6);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Tapered at both ends so it grows out of the hill instead of appearing.
    out.push(brush(x, fromZ + t * (toZ - fromZ), width, scale * Math.sin(t * Math.PI) ** 0.6, 0.6));
  }
}

/**
 * A sharp drop across the hill — the top of a cliff band.
 *
 * The strokes run across the slope, so the overshoot to correct for is the one
 * along x; a small rise just above the lip keeps the takeoff clean.
 */
export function cliffBand(out: TerrainBrush[], z: number, fromX: number, toX: number, drop: number): void {
  const steps = Math.max(2, Math.round(Math.abs(toX - fromX) / 12));
  const step = Math.abs(toX - fromX) / steps;
  const scale = drop / overlapFactor(step, 13, 0.15);
  const lip = (drop * 0.4) / overlapFactor(step, 12, 0.5);
  for (let i = 0; i <= steps; i++) {
    const x = fromX + (i / steps) * (toX - fromX);
    out.push(brush(x, z, 13, -scale, 0.15));
    out.push(brush(x, z - 11, 12, lip, 0.5));
  }
}

/**
 * A built ledge: a flat deck, a sharp face, and flat ground below it.
 *
 * This started life as a stair set and is not one, because it cannot be. The
 * baker adds radial strokes together, so discrete treads need stamps that do
 * not overlap down the hill — and stamps that do not overlap leave natural
 * ground between them, which is a washboard, not a staircase. Overlap them
 * enough to join up and the treads average into a ramp.
 *
 * A snow-covered urban set skis as a drop anyway: the treads fill in and you
 * are riding the fall line off a deck. So that is what this builds, and the
 * name says so.
 *
 * `drop` is the depth of the face below natural ground; the deck above it adds
 * another third of that again, so total relief is about 1.35x what you ask for.
 */
export function ledgeDrop(
  out: TerrainBrush[],
  opts: { x: number; z: number; drop: number; length: number; width: number },
): void {
  const r = Math.max(3, opts.length * 0.45);
  // Across the slope the strokes must overlap, or the face comes out scalloped
  // and a rider crossing it falls into the gaps between stamps. Normalise on
  // the spacing the strokes actually end up at — spreading `across` of them
  // evenly over `width` puts them closer together than the target step, and
  // correcting for the wrong number is how a 3 m ledge becomes a 5 m one.
  const across = Math.max(2, Math.ceil(opts.width / (r * 0.7)) + 1);
  const spacing = opts.width / (across - 1);
  const lateral = overlapFactor(spacing, r, 0.1);

  for (let j = 0; j < across; j++) {
    const x = opts.x + (j / (across - 1) - 0.5) * opts.width;
    // Deck above the lip, then the face itself.
    out.push(brush(x, opts.z - opts.length * 0.55, r, (opts.drop * 0.35) / lateral, 0.85));
    out.push(brush(x, opts.z + opts.length * 0.2, r, -opts.drop / lateral, 0.12));
    out.push(brush(x, opts.z + opts.length * 0.75, r, (-opts.drop * 0.55) / lateral, 0.6));
  }
}

/** A flat traverse cut across the fall line. */
export function catTrack(out: TerrainBrush[], z: number, fromX: number, toX: number, depth = 1.6): void {
  const steps = Math.max(2, Math.round(Math.abs(toX - fromX) / 14));
  const step = Math.abs(toX - fromX) / steps;
  const cut = depth / overlapFactor(step, 15, 0.75);
  const bank = (depth * 0.7) / overlapFactor(step, 13, 0.6);
  for (let i = 0; i <= steps; i++) {
    const x = fromX + (i / steps) * (toX - fromX);
    out.push(brush(x, z, 15, -cut, 0.75));
    out.push(brush(x, z + 15, 13, bank, 0.6));
  }
}

/**
 * Pillows: rounded mounds stacked down a face.
 *
 * The powder equivalent of a jump line — each one launches you onto the next.
 */
export function pillowLine(
  out: TerrainBrush[],
  opts: { x: number; fromZ: number; toZ: number; count: number; height: number; spread: number; seed: number },
): void {
  let s = opts.seed >>> 0;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  for (let i = 0; i < opts.count; i++) {
    const t = i / Math.max(1, opts.count - 1);
    out.push(
      brush(
        opts.x + (rand() * 2 - 1) * opts.spread,
        opts.fromZ + t * (opts.toZ - opts.fromZ),
        9 + rand() * 7,
        opts.height * (0.65 + rand() * 0.7),
        0.95,
      ),
    );
  }
}
