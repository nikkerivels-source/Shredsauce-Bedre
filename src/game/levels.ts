import { makeRng } from '../core/math.ts';
import {
  emptyLevel,
  makeFeature,
  makeId,
  type Feature,
  type LevelDef,
  type RailShape,
} from '../world/level.ts';

export interface LevelPreset {
  id: string;
  name: string;
  tagline: string;
  difficulty: 'green' | 'blue' | 'black' | 'double';
  build(): LevelDef;
}

function kicker(
  x: number,
  z: number,
  height: number,
  opts: Partial<{ lipAngle: number; width: number; gap: number; landingLength: number; landingAngle: number; heading: number }> = {},
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

function rail(
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

function box(
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

function roller(x: number, z: number, height: number, width = 18, length = 20): Feature {
  const f = makeFeature('roller', x, z) as Extract<Feature, { kind: 'roller' }>;
  f.height = height;
  f.width = width;
  f.length = length;
  return f;
}

function prop(x: number, z: number, kind: 'pine' | 'rock' | 'flag' | 'liftTower' | 'cabin' | 'sign' | 'tent', scale = 1): Feature {
  const f = makeFeature('prop', x, z) as Extract<Feature, { kind: 'prop' }>;
  f.prop = kind;
  f.scale = scale;
  return f;
}

function base(name: string, seed: number): LevelDef {
  const level = emptyLevel(name);
  level.id = makeId('lvl');
  level.seed = seed >>> 0;
  level.author = 'Bluebird';
  return level;
}

export const PRESETS: LevelPreset[] = [
  {
    id: 'home-park',
    name: 'Home Park',
    tagline: 'The lap you know by heart. Three jumps, three rails, no excuses.',
    difficulty: 'blue',
    build() {
      const level = base('Home Park', 0x50ade1);
      level.notes = 'A full slopestyle lap: jib line up top, jump line down the middle.';
      level.terrain.slopeAngle = 16;
      level.terrain.length = 900;
      level.terrain.roughness = 1.4;
      level.snow.hardness = 0.62;
      level.snow.groomed = true;

      level.features.push(
        box(-6, 90, 12, { height: 0.5 }),
        rail(6, 92, 14, { height: 0.8, shape: 'flat' }),
        rail(0, 150, 16, { height: 1.1, endHeight: 0.5, shape: 'round' }),
        kicker(-8, 220, 1.6, { width: 8 }),
        kicker(8, 224, 2.2),
        rail(0, 300, 18, { height: 0.95, kink: 18 }),
        kicker(0, 380, 3.0, { width: 11 }),
        box(-10, 470, 16, { width: 2.2, height: 0.7, endHeight: 0.35 }),
        rail(10, 474, 15, { height: 1.2, endHeight: 1.2 }),
        kicker(0, 560, 3.8, { width: 12, lipAngle: 34 }),
        roller(0, 680, 1.4),
        kicker(0, 740, 2.6),
        prop(-40, 120, 'liftTower', 1),
        prop(-40, 320, 'liftTower', 1),
        prop(-40, 520, 'liftTower', 1),
        prop(48, 60, 'cabin', 1),
        prop(-30, 40, 'sign', 1),
      );
      return level;
    },
  },
  {
    id: 'big-air',
    name: 'Big Air',
    tagline: 'One lip. One landing. Bring everything you have.',
    difficulty: 'black',
    build() {
      const level = base('Big Air', 0xb16a17);
      level.notes = 'A single competition booter with a long, steep in-run.';
      level.terrain.slopeAngle = 24;
      level.terrain.length = 620;
      level.terrain.width = 160;
      level.terrain.roughness = 0.6;
      level.terrain.banking = 0.5;
      level.snow.hardness = 0.72;
      level.spawn = { x: 0, z: 20, heading: 0 };

      level.features.push(
        kicker(0, 300, 6.5, { width: 16, lipAngle: 38, gap: 22, landingLength: 90, landingAngle: 36 }),
        prop(-26, 300, 'flag', 1),
        prop(26, 300, 'flag', 1),
        prop(-34, 250, 'tent', 1.4),
        prop(34, 250, 'tent', 1.4),
      );
      return level;
    },
  },
  {
    id: 'superpipe',
    name: 'Superpipe',
    tagline: '6.7 metre walls. Pump the flat, go get some air.',
    difficulty: 'black',
    build() {
      const level = base('Superpipe', 0x0aa1e5);
      level.notes = 'A full superpipe cut into the fall line. Drop in and start pumping.';
      level.terrain.slopeAngle = 18;
      level.terrain.length = 520;
      level.terrain.width = 120;
      level.terrain.roughness = 0.35;
      level.terrain.banking = 0.15;
      level.snow.hardness = 0.8;
      level.spawn = { x: 0, z: 26, heading: 0 };

      const pipe = makeFeature('halfpipe', 0, 60) as Extract<Feature, { kind: 'halfpipe' }>;
      pipe.length = 360;
      pipe.flatWidth = 17;
      pipe.radius = 6.7;
      pipe.vert = 1.2;
      level.features.push(pipe, prop(-30, 80, 'flag', 1), prop(30, 400, 'flag', 1));
      return level;
    },
  },
  {
    id: 'jib-yard',
    name: 'Jib Yard',
    tagline: 'Handrails, kinks and a down-flat-down. Balance is the whole game.',
    difficulty: 'black',
    build() {
      const level = base('Jib Yard', 0x33cc88);
      level.notes = 'Rail garden. Low speed, high consequence.';
      level.terrain.slopeAngle = 12;
      level.terrain.length = 620;
      level.terrain.width = 140;
      level.terrain.roughness = 0.8;
      level.snow.hardness = 0.75;

      const rng = makeRng(0x11b);
      let z = 70;
      let flip = 1;
      for (let i = 0; i < 9; i++) {
        const x = flip * (2 + rng() * 12);
        const kind = rng();
        if (kind < 0.35) {
          level.features.push(box(x, z, 10 + rng() * 8, { width: 1.2 + rng() * 1.4, height: 0.4 + rng() * 0.5 }));
        } else if (kind < 0.7) {
          level.features.push(
            rail(x, z, 12 + rng() * 8, {
              height: 0.9 + rng() * 0.7,
              endHeight: 0.4 + rng() * 0.4,
              shape: rng() < 0.5 ? 'round' : 'square',
            }),
          );
        } else {
          level.features.push(rail(x, z, 16 + rng() * 6, { height: 1.3, endHeight: 1.3, kink: 22 }));
        }
        z += 52 + rng() * 20;
        flip *= -1;
      }
      level.features.push(prop(-45, 100, 'cabin', 1.2), prop(44, 300, 'sign', 1));
      return level;
    },
  },
  {
    id: 'powder-bowl',
    name: 'Powder Bowl',
    tagline: 'Waist deep and untracked. Stay off your tail.',
    difficulty: 'blue',
    build() {
      const level = base('Powder Bowl', 0x77ee33);
      level.notes = 'Deep, soft and completely natural. The trees are the features.';
      level.terrain.slopeAngle = 22;
      level.terrain.length = 1100;
      level.terrain.width = 300;
      level.terrain.roughness = 6.5;
      level.terrain.featureScale = 65;
      level.terrain.banking = 0.5;
      level.snow.hardness = 0.12;
      level.snow.depth = 1.1;
      level.snow.groomed = false;
      level.weather.snowfall = 0.55;
      level.weather.cloud = 0.55;
      level.weather.fog = 0.4;
      level.weather.timeOfDay = 9;

      const rng = makeRng(0x9a1);
      for (let i = 0; i < 26; i++) {
        level.features.push(roller((rng() - 0.5) * 180, 100 + rng() * 900, 1.2 + rng() * 3.2, 14 + rng() * 26, 16 + rng() * 26));
      }
      return level;
    },
  },
  {
    id: 'race',
    name: 'Giant Slalom',
    tagline: 'Twenty gates. Carve them clean or lose the run.',
    difficulty: 'double',
    build() {
      const level = base('Giant Slalom', 0xf10c31);
      level.notes = 'Injected race snow. Only a real carve holds this pitch.';
      level.terrain.slopeAngle = 27;
      level.terrain.length = 1000;
      level.terrain.width = 130;
      level.terrain.roughness = 0.5;
      level.terrain.banking = 0.35;
      level.snow.hardness = 0.97;
      level.snow.depth = 0.05;
      level.snow.groomed = true;
      level.weather.timeOfDay = 8.5;

      let z = 80;
      let side = 1;
      for (let i = 0; i < 20; i++) {
        const gate = makeFeature('gate', side * 14, z) as Extract<Feature, { kind: 'gate' }>;
        gate.width = 8;
        gate.order = i;
        level.features.push(gate);
        z += 42;
        side *= -1;
      }
      return level;
    },
  },
  {
    id: 'superpark',
    name: 'Superpark',
    tagline: 'Everything, all at once. Pipe, booters, hips and a rail garden.',
    difficulty: 'double',
    build() {
      const level = base('Superpark', 0x5a17ba1);
      level.notes = 'The whole mountain in one lap.';
      level.terrain.slopeAngle = 19;
      level.terrain.length = 1500;
      level.terrain.width = 240;
      level.terrain.roughness = 1.8;
      level.snow.hardness = 0.65;

      const hip = makeFeature('hip', -22, 640) as Extract<Feature, { kind: 'hip' }>;
      hip.height = 3.2;
      hip.width = 13;
      hip.length = 16;
      hip.hipAngle = 50;

      const qp = makeFeature('quarterpipe', 26, 1080, 180) as Extract<Feature, { kind: 'quarterpipe' }>;
      qp.radius = 5.4;
      qp.vert = 1.2;
      qp.width = 18;

      const pipe = makeFeature('halfpipe', -70, 900) as Extract<Feature, { kind: 'halfpipe' }>;
      pipe.length = 260;
      pipe.flatWidth = 16;
      pipe.radius = 5.8;
      pipe.vert = 0.9;

      level.features.push(
        box(-8, 110, 14, { height: 0.5 }),
        rail(8, 112, 16, { height: 1.0, endHeight: 0.5 }),
        kicker(0, 200, 2.4),
        kicker(-12, 300, 3.4, { width: 11 }),
        kicker(12, 306, 3.4, { width: 11 }),
        rail(0, 420, 20, { height: 1.15, kink: 20 }),
        kicker(0, 500, 4.6, { width: 13, lipAngle: 34 }),
        hip,
        roller(10, 760, 2.2),
        pipe,
        qp,
        kicker(0, 1240, 5.4, { width: 14, lipAngle: 36 }),
        prop(-55, 200, 'liftTower', 1),
        prop(-55, 500, 'liftTower', 1),
        prop(-55, 800, 'liftTower', 1),
        prop(-55, 1100, 'liftTower', 1),
        prop(70, 120, 'cabin', 1.3),
      );
      return level;
    },
  },
];

export function getPreset(id: string): LevelPreset | null {
  return PRESETS.find((p) => p.id === id) ?? null;
}

export function buildPreset(id: string): LevelDef {
  const preset = getPreset(id) ?? PRESETS[0];
  return preset.build();
}

/**
 * Generates a fresh mountain from a seed.
 *
 * Used for the endless "surprise me" mode and as a starting point in the editor,
 * so there is always somewhere new to ride without anyone having to build it.
 */
export function generateLevel(seed: number, style: 'park' | 'natural' | 'urban' = 'park'): LevelDef {
  const rng = makeRng(seed);
  const level = base(`Seed ${(seed >>> 0).toString(36).toUpperCase()}`, seed);
  level.author = 'generated';
  level.notes = `Procedurally generated ${style} run.`;

  level.terrain.slopeAngle = style === 'urban' ? 12 + rng() * 5 : 15 + rng() * 12;
  level.terrain.length = 700 + Math.floor(rng() * 900);
  level.terrain.width = 180 + Math.floor(rng() * 140);
  level.terrain.roughness = style === 'natural' ? 3 + rng() * 5 : 0.8 + rng() * 2;
  level.terrain.featureScale = 55 + rng() * 90;
  level.snow.hardness = style === 'natural' ? 0.15 + rng() * 0.3 : 0.5 + rng() * 0.4;
  level.snow.depth = style === 'natural' ? 0.5 + rng() * 0.7 : 0.15 + rng() * 0.3;
  level.snow.groomed = style !== 'natural';
  level.weather.timeOfDay = 7 + rng() * 10;
  level.weather.cloud = rng() * 0.7;
  level.weather.snowfall = rng() * 0.5;
  level.weather.fog = rng() * 0.4;
  level.weather.wind = rng() * 6;

  let z = 70;
  const half = level.terrain.width / 2 - 20;
  while (z < level.terrain.length - 90) {
    const roll = rng();
    const x = (rng() - 0.5) * half;
    if (style === 'urban' || roll < 0.36) {
      if (rng() < 0.5) {
        level.features.push(box(x, z, 9 + rng() * 10, { width: 1.1 + rng() * 1.5, height: 0.35 + rng() * 0.6 }));
      } else {
        level.features.push(
          rail(x, z, 11 + rng() * 10, {
            height: 0.7 + rng() * 0.8,
            endHeight: 0.35 + rng() * 0.8,
            kink: rng() < 0.3 ? 15 + rng() * 15 : 0,
            shape: rng() < 0.6 ? 'round' : 'flat',
          }),
        );
      }
      z += 45 + rng() * 35;
    } else if (roll < 0.82) {
      const height = 1.2 + rng() * 4;
      level.features.push(kicker(x, z, height, { width: 8 + rng() * 6, lipAngle: 28 + rng() * 10 }));
      z += 70 + height * 16 + rng() * 40;
    } else {
      level.features.push(roller(x, z, 1 + rng() * 2.6, 12 + rng() * 18, 14 + rng() * 18));
      z += 60 + rng() * 40;
    }
  }

  return level;
}
