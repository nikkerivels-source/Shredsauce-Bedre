import { makeRng } from '../core/math.ts';
import { emptyLevel, makeId, type LevelDef } from '../world/level.ts';
import {
  box,
  brush,
  catTrack,
  cliffBand,
  fenceLine,
  gate,
  glade,
  halfpipe,
  hip,
  jumpLine,
  kicker,
  landingBowl,
  liftLine,
  pillowLine,
  prop,
  quarterpipe,
  rail,
  roller,
  rollIn,
  spine,
  ledgeDrop,
  treeStand,
  wallride,
} from './design.ts';

export interface LevelPreset {
  id: string;
  name: string;
  tagline: string;
  difficulty: 'green' | 'blue' | 'black' | 'double';
  build(): LevelDef;
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
    tagline: 'The lap you know by heart. Jib line up top, three jumps down the guts.',
    difficulty: 'blue',
    build() {
      const level = base('Home Park', 0x50ade1);
      level.notes = 'A full slopestyle lap. Rails first while you are slow, jumps once you have speed.';
      level.terrain.slopeAngle = 16;
      level.terrain.length = 940;
      level.terrain.width = 200;
      level.terrain.roughness = 1.4;
      level.snow.hardness = 0.62;
      level.snow.groomed = true;

      const f = level.features;
      const b = level.brushes;

      // A built roll-in, so the first thirty metres are steeper than the hill.
      rollIn(b, 44, 2.4, 30);

      // Jib line. Two lines side by side, so there is a choice every time.
      f.push(
        box(-7, 92, 13, { width: 1.8, height: 0.5 }),
        rail(7, 94, 14, { height: 0.8, shape: 'flat' }),
        rail(-8, 150, 16, { height: 1.05, endHeight: 0.45 }),
        box(8, 152, 15, { width: 2.4, height: 0.6, endHeight: 0.3 }),
        rail(0, 214, 18, { height: 1.0, kink: 18 }),
      );

      // Jump line, progressive. Spacing comes from the lip heights.
      const after = jumpLine(f, 300, { sizes: [1.8, 2.6, 3.4], offsets: [-7, 7, 0], lipAngle: 32 });

      // Mid-course jib break, then the two biggest hits.
      f.push(
        box(-11, after + 12, 17, { width: 2.2, height: 0.75, endHeight: 0.35 }),
        rail(11, after + 16, 16, { height: 1.25 }),
        wallride(-24, after + 70, 12, { height: 3.2, lean: 10, heading: 12 }),
      );
      jumpLine(f, after + 120, { sizes: [4.2], offsets: [0], lipAngle: 34 });

      // Run-out: a hip off the right, a quarterpipe wall on the left.
      f.push(
        hip(16, 790, 3.0, { width: 13, length: 16, hipAngle: 48 }),
        quarterpipe(-22, 860, { radius: 5, vert: 1, width: 18, heading: 180 }),
        roller(0, 830, 1.2, 26, 22),
      );

      liftLine(f, -58, 80, 900);
      fenceLine(f, 46, 60, 900, 40);
      treeStand(f, { fromZ: 40, toZ: 930, corridor: 62, edge: 94, count: 90, seed: 0x4a11 });
      f.push(prop(66, 50, 'cabin', 1.2), prop(-38, 40, 'sign', 1), prop(38, 44, 'tent', 1));
      return level;
    },
  },
  {
    id: 'big-air',
    name: 'Big Air',
    tagline: 'A warm-up, then seven metres of lip and a hundred of landing.',
    difficulty: 'black',
    build() {
      const level = base('Big Air', 0xb16a17);
      level.notes = 'Competition venue: scaffolded in-run, one enormous booter, dished landing.';
      level.terrain.slopeAngle = 24;
      level.terrain.length = 700;
      level.terrain.width = 170;
      level.terrain.roughness = 0.55;
      level.terrain.banking = 0.5;
      level.snow.hardness = 0.74;
      level.weather.timeOfDay = 16.5;
      level.spawn = { x: 0, z: 18, heading: 0 };

      const f = level.features;
      const b = level.brushes;

      // The start ramp is built up, then the in-run is smoothed flat: a big-air
      // scaffold is a straight, fast, entirely artificial pitch.
      rollIn(b, 40, 5.5, 40);
      for (let z = 90; z < 250; z += 18) b.push(brush(0, z, 30, 0.5, 0.95));

      f.push(kicker(0, 190, 2.4, { width: 11, lipAngle: 30 }));

      // The booter, and a landing dished out below it.
      f.push(kicker(0, 360, 7, { width: 17, lipAngle: 38, gap: 24, landingLength: 100, landingAngle: 37 }));
      landingBowl(b, 0, 400, 96, 2.6);
      // A counter-slope to pull speed off in the outrun, as every venue has.
      for (let z = 540; z < 600; z += 14) b.push(brush(0, z, 34, 1.6, 0.9));

      f.push(quarterpipe(0, 650, { radius: 5.6, vert: 1.4, width: 26, heading: 180 }));

      fenceLine(f, -30, 120, 620, 22);
      fenceLine(f, 30, 120, 620, 22);
      f.push(
        prop(-40, 350, 'tent', 1.5),
        prop(40, 350, 'tent', 1.5),
        prop(-40, 430, 'tent', 1.2),
        prop(40, 430, 'tent', 1.2),
        prop(-46, 190, 'sign', 1.2),
        prop(46, 640, 'cabin', 1.3),
      );
      treeStand(f, { fromZ: 40, toZ: 690, corridor: 54, edge: 78, count: 60, seed: 0x71c });
      return level;
    },
  },
  {
    id: 'superpipe',
    name: 'Superpipe',
    tagline: '6.7 metre walls, then a hip and a wall to finish on.',
    difficulty: 'black',
    build() {
      const level = base('Superpipe', 0x0aa1e5);
      level.notes = 'Cut into the fall line, with a drop-in deck and a transition park below.';
      level.terrain.slopeAngle = 18;
      level.terrain.length = 620;
      level.terrain.width = 140;
      level.terrain.roughness = 0.3;
      level.terrain.banking = 0.15;
      level.snow.hardness = 0.82;
      level.spawn = { x: 0, z: 22, heading: 0 };

      const f = level.features;
      const b = level.brushes;

      rollIn(b, 40, 2.2, 26);
      f.push(halfpipe(0, 70, 360, { flatWidth: 17, radius: 6.7, vert: 1.2 }));

      // Transition park in the outrun: hip, spine and a wall.
      spine(b, 0, 470, 530, 2.4, 15);
      f.push(
        hip(-16, 470, 3.2, { width: 13, length: 16, hipAngle: 52 }),
        hip(16, 470, 3.2, { width: 13, length: 16, hipAngle: -52 }),
        quarterpipe(-26, 560, { radius: 5.4, vert: 1.3, width: 20, heading: 180 }),
        quarterpipe(26, 560, { radius: 5.4, vert: 1.3, width: 20, heading: 180 }),
        roller(0, 590, 1.4, 30, 20),
      );

      fenceLine(f, -26, 70, 430, 30);
      fenceLine(f, 26, 70, 430, 30);
      f.push(
        prop(-38, 120, 'tent', 1.3),
        prop(38, 240, 'tent', 1.3),
        prop(-38, 400, 'sign', 1),
        prop(42, 600, 'cabin', 1.2),
      );
      liftLine(f, -52, 90, 580);
      treeStand(f, { fromZ: 40, toZ: 610, corridor: 46, edge: 64, count: 54, seed: 0x2b8 });
      return level;
    },
  },
  {
    id: 'jib-yard',
    name: 'Jib Yard',
    tagline: 'Down-flat-down, a cannon box and a wall. Balance is the whole game.',
    difficulty: 'black',
    build() {
      const level = base('Jib Yard', 0x33cc88);
      level.notes = 'Hand-built rail garden on a shallow pitch. Low speed, high consequence.';
      level.terrain.slopeAngle = 12;
      level.terrain.length = 700;
      level.terrain.width = 150;
      level.terrain.roughness = 0.6;
      level.snow.hardness = 0.78;
      level.snow.groomed = true;

      const f = level.features;
      const b = level.brushes;

      rollIn(b, 40, 1.8, 24);

      // Warm-up: flat box, then a flat-down.
      f.push(
        box(-6, 84, 12, { width: 2.2, height: 0.45 }),
        box(6, 86, 14, { width: 1.6, height: 0.5, endHeight: 0.25 }),
      );

      // Down-flat-down: three sections read as one rail because they line up.
      f.push(
        rail(0, 150, 9, { height: 1.35, endHeight: 0.75 }),
        rail(0, 160, 8, { height: 0.75 }),
        rail(0, 169, 9, { height: 0.75, endHeight: 0.2 }),
      );

      // Kinked handrail off a built platform, and a flat-bar alternative.
      b.push(brush(-12, 232, 13, 1.7, 0.5));
      f.push(
        rail(-12, 240, 20, { height: 1.9, endHeight: 0.5, kink: 24, shape: 'round' }),
        rail(12, 244, 18, { height: 0.9, shape: 'square' }),
      );

      // Cannon box: short, steep, and it fires you out flat.
      f.push(box(0, 320, 11, { width: 1.3, height: 1.55, endHeight: 0.3 }));

      // Rainbow, and a wall to bank off after it.
      f.push(
        rail(-10, 386, 17, { height: 0.7, endHeight: 0.7, kink: -20 }),
        wallride(14, 384, 14, { height: 3.4, lean: 6, heading: -14 }),
      );

      // Stair set with a handrail down it — the urban centrepiece.
      ledgeDrop(b, { x: -6, z: 450, drop: 2.9, length: 20, width: 13 });
      f.push(rail(-6, 448, 26, { height: 1.5, endHeight: 0.35, shape: 'square', thickness: 0.12 }));

      // Two small jumps, so the yard is not all rails.
      jumpLine(f, 530, { sizes: [1.6, 2.2], offsets: [8, -8], lipAngle: 30 });

      f.push(
        box(0, 660, 15, { width: 2.6, height: 0.6, endHeight: 0.6 }),
        prop(-46, 110, 'cabin', 1.3),
        prop(44, 300, 'sign', 1),
        prop(-44, 470, 'sign', 0.9),
        prop(46, 620, 'tent', 1.1),
      );
      fenceLine(f, -32, 70, 690, 34);
      fenceLine(f, 32, 70, 690, 34);
      treeStand(f, { fromZ: 40, toZ: 690, corridor: 48, edge: 68, count: 64, seed: 0x11b });
      return level;
    },
  },
  {
    id: 'powder-bowl',
    name: 'Powder Bowl',
    tagline: 'Pillows, cliff bands and gladed trees. Stay off your tail.',
    difficulty: 'blue',
    build() {
      const level = base('Powder Bowl', 0x77ee33);
      level.notes = 'Everything here is terrain. Natural booters, a cliff band and a pillow line.';
      level.terrain.slopeAngle = 22;
      level.terrain.length = 1200;
      level.terrain.width = 320;
      level.terrain.roughness = 6.5;
      level.terrain.featureScale = 65;
      level.terrain.banking = 0.5;
      level.snow.hardness = 0.12;
      level.snow.depth = 1.1;
      level.snow.groomed = false;
      level.weather.snowfall = 0.55;
      level.weather.cloud = 0.5;
      level.weather.fog = 0.35;
      level.weather.timeOfDay = 9;

      const f = level.features;
      const b = level.brushes;

      // Upper face: a pillow line down the left, a rolling shoulder right.
      pillowLine(b, { x: -46, fromZ: 120, toZ: 360, count: 9, height: 3.4, spread: 14, seed: 0x9a1 });
      spine(b, 40, 150, 340, 3.6, 22);

      // The cliff band across the middle, with a soft landing under it.
      cliffBand(b, 430, -90, 90, 4.6);
      landingBowl(b, 0, 445, 60, 1.4);

      // Natural booters: wide, soft, no gap — lips the wind built.
      f.push(
        kicker(-30, 520, 2.6, { width: 20, lipAngle: 26, gap: 0, landingLength: 30, landingAngle: 26 }),
        kicker(34, 560, 3.2, { width: 22, lipAngle: 27, gap: 0, landingLength: 36, landingAngle: 27 }),
        kicker(0, 700, 4.0, { width: 26, lipAngle: 28, gap: 4, landingLength: 46, landingAngle: 28 }),
      );

      // A cat track cuts the bowl, and gives a natural road gap.
      catTrack(b, 820, -110, 110, 2.2);
      f.push(kicker(-10, 800, 2.8, { width: 16, lipAngle: 32, gap: 14, landingLength: 30 }));

      // Lower face: rolls and a second pillow line skier's right.
      pillowLine(b, { x: 52, fromZ: 900, toZ: 1080, count: 7, height: 2.8, spread: 16, seed: 0x33f });
      for (let i = 0; i < 10; i++) {
        f.push(roller(-70 + i * 15, 900 + (i % 4) * 45, 1.4 + (i % 3) * 0.8, 18 + (i % 3) * 8, 20));
      }

      glade(f, { fromZ: 200, toZ: 420, halfWidth: 120, count: 70, seed: 0xbe1 });
      glade(f, { fromZ: 880, toZ: 1180, halfWidth: 140, count: 90, seed: 0xbe2 });
      treeStand(f, { fromZ: 60, toZ: 1180, corridor: 126, edge: 150, count: 120, seed: 0xa77 });
      f.push(prop(-120, 80, 'sign', 1.1), prop(118, 1140, 'cabin', 1.3));
      return level;
    },
  },
  {
    id: 'race',
    name: 'Giant Slalom',
    tagline: 'Thirty gates, a hairpin and a roll. Carve them clean or lose the run.',
    difficulty: 'double',
    build() {
      const level = base('Giant Slalom', 0xf10c31);
      level.notes = 'Injected race snow with a real rhythm: open turns, a flush, a hairpin, a roll.';
      level.terrain.slopeAngle = 27;
      // Thirty gates at this rhythm need about 1130 m; the rest is run-out to
      // the finish. Set the course first, then size the hill to hold it.
      level.terrain.length = 1400;
      level.terrain.width = 140;
      level.terrain.roughness = 0.45;
      level.terrain.banking = 0.35;
      level.snow.hardness = 0.97;
      level.snow.depth = 0.05;
      level.snow.groomed = true;
      level.weather.timeOfDay = 8.5;

      const f = level.features;
      const b = level.brushes;

      // A course is a rhythm, not a metronome: open turns to build speed, a
      // tight flush to break it, a hairpin, then open again to the finish.
      const rhythm: Array<{ offset: number; gap: number }> = [
        ...Array.from({ length: 6 }, () => ({ offset: 15, gap: 44 })),
        ...Array.from({ length: 5 }, () => ({ offset: 9, gap: 30 })),
        { offset: 4, gap: 22 },
        { offset: 4, gap: 22 },
        { offset: 4, gap: 22 },
        ...Array.from({ length: 7 }, () => ({ offset: 17, gap: 46 })),
        ...Array.from({ length: 5 }, () => ({ offset: 11, gap: 32 })),
        ...Array.from({ length: 4 }, () => ({ offset: 16, gap: 42 })),
      ];

      let z = 90;
      let side = 1;
      rhythm.forEach((step, i) => {
        f.push(gate(side * step.offset, z, i, 8));
        z += step.gap;
        side *= -1;
      });

      // A compression mid-course, where the course-setters always put one.
      for (let x = -60; x <= 60; x += 15) b.push(brush(x, 620, 20, 1.9, 0.8));

      f.push(roller(0, 700, 1.1, 60, 26));

      fenceLine(f, -34, 70, z + 40, 20);
      fenceLine(f, 34, 70, z + 40, 20);
      f.push(
        prop(-30, 70, 'sign', 1.2),
        prop(-26, z + 30, 'tent', 1.4),
        prop(26, z + 30, 'tent', 1.4),
        prop(46, z + 60, 'cabin', 1.2),
      );
      liftLine(f, -56, 90, 1330);
      treeStand(f, { fromZ: 60, toZ: 1380, corridor: 46, edge: 64, count: 90, seed: 0xf10 });
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
      level.notes = 'The whole mountain in one lap. Nothing here is small.';
      level.terrain.slopeAngle = 19;
      level.terrain.length = 1700;
      level.terrain.width = 260;
      level.terrain.roughness = 1.6;
      level.snow.hardness = 0.66;
      level.weather.timeOfDay = 11;

      const f = level.features;
      const b = level.brushes;

      rollIn(b, 44, 2.8, 34);

      // Upper jib garden.
      f.push(
        box(-8, 108, 14, { width: 2.2, height: 0.5 }),
        rail(8, 110, 16, { height: 1.0, endHeight: 0.5 }),
        rail(-9, 176, 20, { height: 1.4, endHeight: 0.4, kink: 22 }),
        box(9, 180, 18, { width: 2.8, height: 0.7, endHeight: 0.35 }),
        wallride(-26, 236, 14, { height: 3.6, lean: 8, heading: 14 }),
      );

      // Main jump line: four hits, progressive.
      const after = jumpLine(f, 300, { sizes: [2.4, 3.4, 4.6, 5.6], offsets: [0, -12, 12, 0], lipAngle: 34 });

      // Transition zone: a spine with a hip either side.
      spine(b, -22, after + 20, after + 90, 3.2, 18);
      f.push(
        hip(-22, after + 30, 3.4, { width: 14, length: 17, hipAngle: 50 }),
        hip(-22, after + 30, 3.4, { width: 14, length: 17, hipAngle: -50 }),
        roller(18, after + 70, 2.2, 24, 22),
      );

      // Pipe on the left, quarterpipe wall on the right, side by side.
      f.push(
        halfpipe(-72, 1020, 280, { flatWidth: 16, radius: 5.8, vert: 0.9 }),
        quarterpipe(30, 1120, { radius: 5.6, vert: 1.3, width: 22, heading: 180 }),
        quarterpipe(58, 1180, { radius: 4.8, vert: 1.0, width: 18, heading: 180 }),
      );

      // Closing hits.
      f.push(
        box(0, 1330, 20, { width: 2.4, height: 0.8, endHeight: 0.4 }),
        kicker(0, 1420, 6.2, { width: 16, lipAngle: 36 }),
      );
      landingBowl(b, 0, 1455, 70, 2.2);

      liftLine(f, -104, 100, 1650);
      fenceLine(f, 82, 80, 1650, 44);
      treeStand(f, { fromZ: 60, toZ: 1680, corridor: 94, edge: 122, count: 130, seed: 0x5a1 });
      f.push(
        prop(96, 130, 'cabin', 1.4),
        prop(-58, 80, 'sign', 1.2),
        prop(60, 900, 'tent', 1.3),
        prop(-40, 1400, 'tent', 1.2),
      );
      return level;
    },
  },
  {
    id: 'last-light',
    name: 'Last Light',
    tagline: 'Stair sets, handrails and a road gap, lit by the last of the sun.',
    difficulty: 'black',
    build() {
      const level = base('Last Light', 0x1e2a44);
      level.notes = 'An urban build: concrete steps, ledges, walls and one very long handrail.';
      level.terrain.slopeAngle = 13;
      level.terrain.length = 760;
      level.terrain.width = 150;
      level.terrain.roughness = 0.35;
      level.terrain.banking = 0.1;
      level.snow.hardness = 0.86;
      level.snow.depth = 0.1;
      level.snow.groomed = true;
      level.weather.timeOfDay = 17.4;
      level.weather.cloud = 0.2;
      level.weather.fog = 0.15;

      const f = level.features;
      const b = level.brushes;

      rollIn(b, 40, 2.2, 22);

      // Plaza: two ledges and a flat bar, all low and close together.
      f.push(
        box(-9, 96, 14, { width: 2.6, height: 0.55 }),
        box(9, 100, 12, { width: 2.6, height: 0.75 }),
        rail(0, 150, 15, { height: 0.55, shape: 'square', thickness: 0.13 }),
      );

      // Seven-stair with a handrail, and a ledge down the other side.
      ledgeDrop(b, { x: -10, z: 210, drop: 3.2, length: 22, width: 14 });
      f.push(
        rail(-10, 208, 24, { height: 1.4, endHeight: 0.3, shape: 'square', thickness: 0.12 }),
        box(6, 212, 22, { width: 2.0, height: 1.3, endHeight: 0.25 }),
      );

      // The wall: a long bank you can carry speed across.
      f.push(wallride(-22, 320, 22, { height: 4.2, lean: 5, heading: 8 }));

      // Road gap. A cat track cuts the hill; the kicker sends you over it.
      catTrack(b, 430, -80, 80, 3.2);
      f.push(kicker(0, 402, 3.2, { width: 12, lipAngle: 36, gap: 26, landingLength: 34, landingAngle: 32 }));

      // Double-kink handrail off a built deck — the hardest thing here.
      b.push(brush(12, 500, 14, 2.6, 0.45));
      f.push(
        rail(12, 508, 28, { height: 2.4, endHeight: 0.4, kink: 28, shape: 'round' }),
        box(-14, 512, 18, { width: 2.2, height: 0.9, endHeight: 0.4 }),
      );

      // Closing hip off a bank, and a wall to finish.
      spine(b, 0, 590, 640, 2.6, 16);
      f.push(
        hip(0, 600, 2.8, { width: 12, length: 15, hipAngle: 46 }),
        quarterpipe(-18, 690, { radius: 4.6, vert: 1.4, width: 18, heading: 180 }),
      );

      f.push(
        prop(-40, 90, 'cabin', 1.5),
        prop(40, 200, 'cabin', 1.3),
        prop(-42, 340, 'sign', 1.1),
        prop(44, 480, 'sign', 1),
        prop(-44, 620, 'tent', 1.1),
      );
      fenceLine(f, -30, 80, 720, 30);
      fenceLine(f, 30, 80, 720, 30);
      treeStand(f, { fromZ: 60, toZ: 740, corridor: 48, edge: 68, count: 50, seed: 0x1e2 });
      return level;
    },
  },
  {
    id: 'glacier',
    name: 'Glacier',
    tagline: 'Spring slush up high. Long, wide and fast, with hits everywhere.',
    difficulty: 'green',
    build() {
      const level = base('Glacier', 0x8fd7ff);
      level.notes = 'A wide open face with soft snow and natural rollers. Somewhere to just ski.';
      level.terrain.slopeAngle = 15;
      level.terrain.length = 1300;
      level.terrain.width = 340;
      level.terrain.roughness = 3.4;
      level.terrain.featureScale = 110;
      level.terrain.banking = 0.25;
      level.snow.hardness = 0.34;
      level.snow.depth = 0.35;
      level.snow.groomed = false;
      level.weather.timeOfDay = 13;
      level.weather.cloud = 0.1;

      const f = level.features;
      const b = level.brushes;

      // Long rolling ground swell, rather than built features.
      for (let i = 0; i < 14; i++) {
        const x = ((i % 5) - 2) * 52;
        spine(b, x, 150 + i * 78, 210 + i * 78, 1.8 + (i % 3) * 0.9, 26);
      }

      // Side hits spread right across the face, so any line has something.
      const hits: Array<[number, number, number]> = [
        [-90, 240, 1.8],
        [-30, 300, 2.2],
        [40, 270, 2.0],
        [95, 340, 2.4],
        [-70, 470, 2.6],
        [10, 520, 3.0],
        [80, 560, 2.2],
        [-110, 640, 2.0],
        [-20, 720, 3.4],
        [60, 780, 2.6],
        [-80, 880, 2.8],
        [30, 950, 3.2],
        [110, 1000, 2.2],
        [-40, 1090, 2.6],
      ];
      for (const [x, z, h] of hits) {
        f.push(kicker(x, z, h, { width: 12 + h * 3, lipAngle: 28, gap: Math.round(h * 2), landingLength: Math.round(h * 10) }));
      }

      for (let i = 0; i < 16; i++) {
        f.push(roller(((i * 67) % 260) - 130, 200 + i * 66, 1.2 + (i % 4) * 0.7, 20 + (i % 3) * 10, 22));
      }

      f.push(
        box(-14, 420, 16, { width: 3.2, height: 0.5 }),
        rail(14, 424, 16, { height: 0.8, endHeight: 0.5 }),
        box(0, 860, 18, { width: 3.4, height: 0.55 }),
      );

      liftLine(f, -140, 120, 1250, 210);
      treeStand(f, { fromZ: 80, toZ: 1280, corridor: 146, edge: 160, count: 90, seed: 0x8fd });
      f.push(prop(150, 120, 'cabin', 1.6), prop(-150, 1240, 'sign', 1.2), prop(140, 700, 'tent', 1.3));
      return level;
    },
  },
  {
    id: 'cornice',
    name: 'Cornice',
    tagline: 'Drop the lip, thread the cliff band, do not lose an edge.',
    difficulty: 'double',
    build() {
      const level = base('Cornice', 0xd94f2b);
      level.notes = 'Steep, exposed and wind-scoured. Two cliff bands and nowhere flat to think.';
      level.terrain.slopeAngle = 33;
      level.terrain.length = 1000;
      level.terrain.width = 240;
      level.terrain.roughness = 4.8;
      level.terrain.featureScale = 52;
      level.terrain.banking = 0.55;
      level.snow.hardness = 0.66;
      level.snow.depth = 0.35;
      level.snow.groomed = false;
      level.weather.timeOfDay = 10;
      level.weather.wind = 9;
      level.weather.cloud = 0.3;
      level.weather.snowfall = 0.2;

      const f = level.features;
      const b = level.brushes;

      // The cornice itself: a built lip you drop off to start the run.
      for (let x = -70; x <= 70; x += 14) b.push(brush(x, 62, 15, 3.4, 0.25));
      landingBowl(b, 0, 78, 44, 1.8);

      // First band: a broken cliff with a rideable gap in the middle.
      cliffBand(b, 260, -110, -26, 6.2);
      cliffBand(b, 260, 26, 110, 6.2);
      landingBowl(b, -66, 274, 40, 1.6);
      landingBowl(b, 66, 274, 40, 1.6);

      // Spines between the bands — the only clean line down.
      spine(b, -40, 330, 470, 4.2, 18);
      spine(b, 40, 330, 470, 4.2, 18);

      // Second band, lower and continuous. Commit or traverse out.
      cliffBand(b, 560, -95, 95, 5.4);
      landingBowl(b, 0, 576, 56, 2.0);

      f.push(
        kicker(-44, 540, 3.0, { width: 14, lipAngle: 34, gap: 18, landingLength: 34, landingAngle: 34 }),
        kicker(46, 545, 3.4, { width: 14, lipAngle: 34, gap: 20, landingLength: 38, landingAngle: 34 }),
      );

      // Run-out: a gladed apron that finally lets the pitch off.
      pillowLine(b, { x: -30, fromZ: 700, toZ: 860, count: 7, height: 2.6, spread: 18, seed: 0xd94 });
      for (let i = 0; i < 8; i++) f.push(roller(-60 + i * 18, 720 + (i % 3) * 50, 1.6, 16, 18));

      glade(f, { fromZ: 680, toZ: 980, halfWidth: 100, count: 80, seed: 0xc02 });
      treeStand(f, { fromZ: 300, toZ: 980, corridor: 100, edge: 112, count: 70, seed: 0xc03 });
      f.push(prop(-96, 60, 'sign', 1.2), prop(96, 950, 'cabin', 1.2), prop(-40, 40, 'flag', 1));
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
