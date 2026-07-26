import { clamp01, lerp } from '../core/math.ts';

export type Discipline = 'snowboard' | 'skis';
export type CamberProfile = 'camber' | 'rocker' | 'flat' | 'hybrid';

/**
 * Physical description of a board or a pair of skis.
 *
 * These are real numbers in real units — a 156 all-mountain board really does
 * have an ~8 m sidecut — because everything downstream (turn radius, grip,
 * pop height, swing weight) is computed from them rather than hand-tuned.
 */
export interface GearSpec {
  id: string;
  name: string;
  brandLine: string;
  discipline: Discipline;
  /** Overall length, metres. */
  length: number;
  /** Width at the waist, metres. Per ski for skis. */
  waistWidth: number;
  /** Sidecut radius, metres. Small carves tight, large runs straight and fast. */
  sidecutRadius: number;
  /** Length of edge actually in the snow, metres. */
  effectiveEdge: number;
  /** 0 = noodle, 1 = race plate. Drives grip response and pop. */
  stiffness: number;
  camber: CamberProfile;
  /** Mass of the equipment, kg. */
  mass: number;
  /** Base glide friction coefficient. Lower is faster. */
  glideFriction: number;
  /** Multiplier on how much energy the deck returns when you pop. */
  pop: number;
  /** Multiplier on swing weight; long stiff gear is slower to spin. */
  swingWeight: number;
  /** Rider level at which this unlocks. */
  unlockLevel: number;
  price: number;
  description: string;
}

export const GEAR_CATALOG: GearSpec[] = [
  {
    id: 'park-155',
    name: 'Loop 155',
    brandLine: 'Powderline Park',
    discipline: 'snowboard',
    length: 1.55,
    waistWidth: 0.252,
    sidecutRadius: 7.9,
    effectiveEdge: 1.18,
    stiffness: 0.42,
    camber: 'hybrid',
    mass: 3.2,
    glideFriction: 0.042,
    pop: 1.0,
    swingWeight: 1.0,
    unlockLevel: 0,
    price: 0,
    description: 'Twin park deck. Forgiving edges, snappy pop, happy switch.',
  },
  {
    id: 'jib-149',
    name: 'Butterknife 149',
    brandLine: 'Powderline Park',
    discipline: 'snowboard',
    length: 1.49,
    waistWidth: 0.248,
    sidecutRadius: 7.2,
    effectiveEdge: 1.1,
    stiffness: 0.24,
    camber: 'rocker',
    mass: 2.9,
    glideFriction: 0.046,
    pop: 0.82,
    swingWeight: 0.88,
    unlockLevel: 2,
    price: 400,
    description: 'Soft rockered jib stick. Presses for days, washes out at speed.',
  },
  {
    id: 'allmtn-158',
    name: 'Traverse 158',
    brandLine: 'Powderline Alpine',
    discipline: 'snowboard',
    length: 1.58,
    waistWidth: 0.256,
    sidecutRadius: 8.6,
    effectiveEdge: 1.23,
    stiffness: 0.62,
    camber: 'camber',
    mass: 3.5,
    glideFriction: 0.036,
    pop: 1.15,
    swingWeight: 1.12,
    unlockLevel: 4,
    price: 900,
    description: 'Cambered all-mountain plank. Holds an edge on boilerplate.',
  },
  {
    id: 'carve-163',
    name: 'Scalpel 163',
    brandLine: 'Powderline Race',
    discipline: 'snowboard',
    length: 1.63,
    waistWidth: 0.238,
    sidecutRadius: 11.5,
    effectiveEdge: 1.35,
    stiffness: 0.92,
    camber: 'camber',
    mass: 4.1,
    glideFriction: 0.028,
    pop: 1.28,
    swingWeight: 1.35,
    unlockLevel: 8,
    price: 2200,
    description: 'Stiff alpine carver. Enormous grip, punishes a lazy edge.',
  },
  {
    id: 'powder-162',
    name: 'Whale 162',
    brandLine: 'Powderline Alpine',
    discipline: 'snowboard',
    length: 1.62,
    waistWidth: 0.272,
    sidecutRadius: 9.4,
    effectiveEdge: 1.14,
    stiffness: 0.55,
    camber: 'rocker',
    mass: 3.6,
    glideFriction: 0.033,
    pop: 0.95,
    swingWeight: 1.18,
    unlockLevel: 6,
    price: 1400,
    description: 'Big rockered nose. Floats deep snow, surfy on hardpack.',
  },
  {
    id: 'twin-172',
    name: 'Fulcrum 172',
    brandLine: 'Powderline Park',
    discipline: 'skis',
    length: 1.72,
    waistWidth: 0.094,
    sidecutRadius: 16.5,
    effectiveEdge: 1.42,
    stiffness: 0.48,
    camber: 'hybrid',
    mass: 4.0,
    glideFriction: 0.04,
    pop: 1.0,
    swingWeight: 0.95,
    unlockLevel: 0,
    price: 0,
    description: 'Twin-tip park skis. Balanced, predictable, made for switch.',
  },
  {
    id: 'jib-166',
    name: 'Feather 166',
    brandLine: 'Powderline Park',
    discipline: 'skis',
    length: 1.66,
    waistWidth: 0.088,
    sidecutRadius: 15,
    effectiveEdge: 1.3,
    stiffness: 0.3,
    camber: 'rocker',
    mass: 3.4,
    glideFriction: 0.044,
    pop: 0.86,
    swingWeight: 0.82,
    unlockLevel: 3,
    price: 500,
    description: 'Light and soft. Swings fast, gets bucked in chop.',
  },
  {
    id: 'gs-183',
    name: 'Meridian 183',
    brandLine: 'Powderline Race',
    discipline: 'skis',
    length: 1.83,
    waistWidth: 0.068,
    sidecutRadius: 21,
    effectiveEdge: 1.61,
    stiffness: 0.95,
    camber: 'camber',
    mass: 5.2,
    glideFriction: 0.026,
    pop: 1.2,
    swingWeight: 1.4,
    unlockLevel: 9,
    price: 2600,
    description: 'GS race stock. Terrifying speed, zero forgiveness.',
  },
  {
    id: 'pow-188',
    name: 'Displacement 188',
    brandLine: 'Powderline Alpine',
    discipline: 'skis',
    length: 1.88,
    waistWidth: 0.116,
    sidecutRadius: 19,
    effectiveEdge: 1.32,
    stiffness: 0.6,
    camber: 'rocker',
    mass: 5.0,
    glideFriction: 0.031,
    pop: 0.98,
    swingWeight: 1.3,
    unlockLevel: 7,
    price: 1800,
    description: 'Fat rockered powder skis. Surfs anything soft.',
  },
];

export function getGear(id: string): GearSpec {
  return GEAR_CATALOG.find((g) => g.id === id) ?? GEAR_CATALOG[0];
}

export function gearForDiscipline(discipline: Discipline): GearSpec[] {
  return GEAR_CATALOG.filter((g) => g.discipline === discipline);
}

/**
 * Relative pressure a camber profile puts on the snow at a normalised position
 * along the edge (-1 tail, 0 waist, +1 nose).
 *
 * Camber pushes the contact points down hard, which is why cambered gear grips
 * and why it catches an edge. Rocker lifts the tip and tail so pressure piles up
 * under your feet — loose, easy to butter, vague at speed.
 */
export function camberPressure(profile: CamberProfile, u: number, stiffness: number): number {
  const a = Math.abs(u);
  switch (profile) {
    case 'camber': {
      // Peaks near the contact points, light underfoot.
      const shape = 0.45 + 1.1 * Math.pow(a, 1.6);
      return lerp(1, shape, clamp01(0.55 + stiffness * 0.45));
    }
    case 'rocker': {
      // Heavy underfoot, tip and tail float free.
      const shape = 1.6 - 1.35 * Math.pow(a, 1.4);
      return Math.max(0.05, shape);
    }
    case 'flat':
      return 1;
    case 'hybrid':
    default: {
      // Flat between the feet with a little rocker at the ends.
      const shape = 1.2 - 0.55 * Math.pow(a, 2.2);
      return Math.max(0.2, shape);
    }
  }
}

/**
 * Principal moments of inertia (kg·m²) of the rider + gear system expressed in
 * the board's local frame.
 *
 * The frame is the same for both disciplines — +Z along the gear, +X across it,
 * +Y up through the rider — but a snowboarder stands sideways and a skier faces
 * forward, so the same axis means a somersault for one and a cartwheel for the
 * other. That asymmetry is why board and ski tricks are named differently, and
 * it falls out of these numbers instead of being special-cased later.
 */
export function inertiaTensor(gear: GearSpec, riderMass: number, tuck: number): {
  x: number;
  y: number;
  z: number;
} {
  const t = clamp01(tuck);
  // A tucked human pulls mass toward the rotation axis; roughly a 2.5x drop in
  // somersault inertia and a 1.6x drop about the long axis.
  const somersault = lerp(12.5, 5.0, t) * (riderMass / 72);
  const cartwheel = lerp(13.0, 6.0, t) * (riderMass / 72);
  const spin = lerp(1.9, 1.15, t) * (riderMass / 72);

  // Gear contribution: a plank of length L about the axes perpendicular to it,
  // plus the parallel-axis term for hanging ~0.85 m below the rider's centre.
  const stance = 0.85;
  const gearPerp = (gear.mass * gear.length * gear.length) / 12;
  const gearOffset = gear.mass * stance * stance;

  if (gear.discipline === 'snowboard') {
    return {
      // Across the board = through the rider's chest: cartwheel axis.
      x: (cartwheel + gearPerp + gearOffset) * gear.swingWeight,
      // Board normal = the rider's spine: the spin axis.
      y: (spin + gearPerp) * gear.swingWeight,
      // Along the board = through the rider's hips: the flip axis.
      z: (somersault + gearOffset) * gear.swingWeight,
    };
  }
  return {
    // Across the skis = through the skier's hips: the flip axis.
    x: (somersault + gearPerp + gearOffset) * gear.swingWeight,
    y: (spin + gearPerp) * gear.swingWeight,
    // Along the skis = the skier's line of sight: the cartwheel/roll axis.
    z: (cartwheel + gearOffset) * gear.swingWeight,
  };
}
