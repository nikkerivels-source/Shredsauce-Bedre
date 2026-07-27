/**
 * Trail maps.
 *
 * A plan view of a run, drawn from the level's own feature list — the same
 * coordinates the sim rides. Nothing here is decoration or a stand-in: if a
 * kicker moves in the editor, it moves on the map, because there is only one
 * set of numbers.
 *
 * Fall line runs down the page, which is how every piste map in the world is
 * drawn, and the whole thing is sized to the level's real extents so a long
 * narrow slalom course looks long and narrow.
 */

import type { Feature, LevelDef } from '../world/level.ts';

const NS = 'http://www.w3.org/2000/svg';

/** Everything that gets its own silhouette. Props are drawn as scatter. */
const SHAPES = new Set(['kicker', 'rail', 'box', 'quarterpipe', 'halfpipe', 'hip', 'roller', 'wallride']);

export interface RunStats {
  /** Vertical drop over the whole run, metres. */
  drop: number;
  /** Fall-line length, metres. */
  length: number;
  /** Average pitch, degrees. */
  pitch: number;
  /** Ridable features, excluding props and gates. */
  features: number;
  /** Race gates, 0 when the run is not a course. */
  gates: number;
}

export function runStats(level: LevelDef): RunStats {
  const length = level.terrain.length;
  const pitch = level.terrain.slopeAngle;
  let features = 0;
  let gates = 0;
  for (const f of level.features) {
    if (f.kind === 'gate') gates += 1;
    else if (f.kind !== 'prop') features += 1;
  }
  return {
    drop: length * Math.sin((pitch * Math.PI) / 180),
    length,
    pitch,
    features,
    gates,
  };
}

/**
 * Draws the run.
 *
 * `width` is the drawn width in user units. Runs are several times longer than
 * they are wide, so the fall line is compressed to a fixed portrait ratio and
 * the two axes get their own scales — a true-to-scale thumbnail of a 900 m run
 * through a 220 m corridor would be an unreadable thread. The card carries the
 * real length and pitch next to the map, so nothing is being hidden.
 */
export function trailMap(level: LevelDef, width = 68): SVGSVGElement {
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'trailmap');
  svg.setAttribute('aria-hidden', 'true');

  const halfW = level.terrain.width / 2;
  const runLength = Math.max(1, level.terrain.length);
  const height = width * 1.55;
  // Metres to user units, separately per axis: the run is squashed lengthways
  // to fit a thumbnail that is taller than it is wide but nowhere near 4:1.
  const sx = width / (halfW * 2);
  const sz = height / runLength;
  const px = (x: number) => (x + halfW) * sx;
  const pz = (z: number) => z * sz;

  svg.setAttribute('viewBox', `0 0 ${width.toFixed(1)} ${height.toFixed(1)}`);

  // The piste itself, narrowing slightly toward the bottom for depth.
  const piste = document.createElementNS(NS, 'path');
  const inset = width * 0.06;
  piste.setAttribute(
    'd',
    `M0 0 H${width.toFixed(1)} L${(width - inset).toFixed(1)} ${height.toFixed(1)} H${inset.toFixed(1)} Z`,
  );
  piste.setAttribute('class', 'tm-piste');
  svg.append(piste);

  // Contours at a 50 m vertical interval, which is what a real piste map uses.
  // The spacing follows from the pitch — a steeper run stacks them closer — so
  // even an empty face reads as terrain rather than a grey rectangle.
  const rise = Math.sin((level.terrain.slopeAngle * Math.PI) / 180);
  const spacing = rise > 0.02 ? 50 / rise : runLength;
  if (spacing < runLength) {
    const contours = document.createElementNS(NS, 'g');
    contours.setAttribute('class', 'tm-contours');
    for (let z = spacing; z < runLength; z += spacing) {
      const y = pz(z);
      const t = z / runLength;
      const edge = inset * t;
      const line = document.createElementNS(NS, 'path');
      // Bowed downhill, the way a contour crossing a fall line actually sits.
      line.setAttribute(
        'd',
        `M${edge.toFixed(1)} ${y.toFixed(1)} Q${(width / 2).toFixed(1)} ${(y + height * 0.02).toFixed(1)} ${(width - edge).toFixed(1)} ${y.toFixed(1)}`,
      );
      contours.append(line);
    }
    svg.append(contours);
  }

  // Props first, so features sit on top of the trees.
  const scatter = document.createElementNS(NS, 'g');
  scatter.setAttribute('class', 'tm-scatter');
  for (const f of level.features) {
    if (f.kind !== 'prop') continue;
    if (f.prop !== 'tree' && f.prop !== 'pine') continue;
    const dot = document.createElementNS(NS, 'circle');
    dot.setAttribute('cx', px(f.x).toFixed(1));
    dot.setAttribute('cy', pz(f.z).toFixed(1));
    dot.setAttribute('r', '0.9');
    scatter.append(dot);
  }
  if (scatter.childElementCount > 0) svg.append(scatter);

  const marks = document.createElementNS(NS, 'g');
  marks.setAttribute('class', 'tm-marks');
  for (const f of level.features) {
    const node = featureShape(f, px, pz, sx, sz);
    if (node) marks.append(node);
  }
  svg.append(marks);

  // Gates get a linked line, because a course is a sequence and looks like one.
  const gates = level.features.filter((f) => f.kind === 'gate').sort((a, b) => a.z - b.z);
  if (gates.length > 1) {
    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', gates.map((g) => `${px(g.x).toFixed(1)},${pz(g.z).toFixed(1)}`).join(' '));
    line.setAttribute('class', 'tm-course');
    svg.append(line);
  }

  // Start marker on the spawn, which is where the run actually begins.
  const start = document.createElementNS(NS, 'path');
  const sxp = px(level.spawn.x);
  const szp = pz(level.spawn.z);
  start.setAttribute('d', `M${(sxp - 3).toFixed(1)} ${(szp - 2.6).toFixed(1)} h6 l-3 5 Z`);
  start.setAttribute('class', 'tm-start');
  svg.append(start);

  return svg;
}

function featureShape(
  f: Feature,
  px: (x: number) => number,
  pz: (z: number) => number,
  sx: number,
  sz: number,
): SVGElement | null {
  if (!SHAPES.has(f.kind)) return null;
  const x = px(f.x);
  const z = pz(f.z);

  switch (f.kind) {
    case 'kicker':
    case 'hip': {
      // A takeoff reads as a wedge pointing down the fall line.
      const w = Math.max(6, f.width * sx);
      const l = Math.max(5, ('length' in f ? f.length : f.height * 3) * sz);
      const tri = document.createElementNS(NS, 'path');
      tri.setAttribute(
        'd',
        `M${(x - w / 2).toFixed(1)} ${z.toFixed(1)} h${w.toFixed(1)} l${(-w / 2).toFixed(1)} ${l.toFixed(1)} Z`,
      );
      tri.setAttribute('class', f.kind === 'hip' ? 'tm-hip' : 'tm-kicker');
      return tri;
    }
    case 'rail':
    case 'box':
    case 'wallride': {
      const l = Math.max(5, f.length * sz);
      const w = f.kind === 'box' ? Math.max(2.6, f.width * sx) : 2.2;
      const bar = document.createElementNS(NS, 'rect');
      bar.setAttribute('x', (x - w / 2).toFixed(1));
      bar.setAttribute('y', z.toFixed(1));
      bar.setAttribute('width', w.toFixed(1));
      bar.setAttribute('height', l.toFixed(1));
      bar.setAttribute('rx', f.kind === 'rail' ? (w / 2).toFixed(1) : '0.4');
      bar.setAttribute('class', f.kind === 'box' ? 'tm-box' : 'tm-rail');
      return bar;
    }
    case 'halfpipe': {
      const l = Math.max(10, f.length * sz);
      const w = Math.max(7, (f.flatWidth + f.radius * 2) * sx);
      const pipe = document.createElementNS(NS, 'rect');
      pipe.setAttribute('x', (x - w / 2).toFixed(1));
      pipe.setAttribute('y', z.toFixed(1));
      pipe.setAttribute('width', w.toFixed(1));
      pipe.setAttribute('height', l.toFixed(1));
      pipe.setAttribute('rx', '1.6');
      pipe.setAttribute('class', 'tm-pipe');
      return pipe;
    }
    case 'quarterpipe': {
      const w = Math.max(8, f.width * sx);
      const arc = document.createElementNS(NS, 'path');
      arc.setAttribute(
        'd',
        `M${(x - w / 2).toFixed(1)} ${z.toFixed(1)} a${(w / 2).toFixed(1)} ${(w / 3).toFixed(1)} 0 0 0 ${w.toFixed(1)} 0`,
      );
      arc.setAttribute('class', 'tm-qp');
      return arc;
    }
    case 'roller': {
      const w = Math.max(8, f.width * sx);
      const l = Math.max(3, f.length * sz);
      const roll = document.createElementNS(NS, 'ellipse');
      roll.setAttribute('cx', x.toFixed(1));
      roll.setAttribute('cy', (z + l / 2).toFixed(1));
      roll.setAttribute('rx', (w / 2).toFixed(1));
      roll.setAttribute('ry', (l / 2).toFixed(1));
      roll.setAttribute('class', 'tm-roller');
      return roll;
    }
    default:
      return null;
  }
}
