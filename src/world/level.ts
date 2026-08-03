/**
 * Level definition — the single serialisable description of a mountain.
 *
 * Everything the editor produces and everything the sim consumes goes through
 * this shape, so a level is fully reproducible from its JSON (plus its seed).
 */

export const LEVEL_FORMAT_VERSION = 6;

export type FeatureKind =
  | 'kicker'
  | 'rail'
  | 'box'
  | 'quarterpipe'
  | 'halfpipe'
  | 'hip'
  | 'roller'
  | 'wallride'
  | 'gate'
  | 'prop';

export type PropKind =
  | 'pine'
  | 'tree'
  | 'deadTree'
  | 'rock'
  | 'flag'
  | 'marker'
  | 'sign'
  | 'banner'
  | 'arch'
  | 'netFence'
  | 'liftTower'
  | 'chair'
  | 'cabin'
  | 'tent'
  | 'igloo'
  | 'snowcat'
  | 'snowGun'
  | 'speaker'
  | 'bench'
  | 'firePit'
  | 'barrel'
  | 'crate';

/** Every placeable item, in the order the editor lists them. */
export const PROP_KINDS: readonly PropKind[] = [
  'pine',
  'tree',
  'deadTree',
  'rock',
  'flag',
  'marker',
  'sign',
  'banner',
  'arch',
  'netFence',
  'liftTower',
  'chair',
  'cabin',
  'tent',
  'igloo',
  'snowcat',
  'snowGun',
  'speaker',
  'bench',
  'firePit',
  'barrel',
  'crate',
];

const PROP_SET = new Set<string>(PROP_KINDS);

export function isPropKind(value: unknown): value is PropKind {
  return typeof value === 'string' && PROP_SET.has(value);
}

/**
 * A picture behind the mountain.
 *
 * Held as an inline data URL rather than a link, so a level stays a single
 * self-contained object that works offline and cannot phone home from someone
 * else's browser when they ride it.
 */
export interface Backdrop {
  /** `data:image/...;base64,...` only — see `sanitizeBackdrop`. */
  image: string;
  /** How strongly it replaces the painted sky, 0-1. */
  opacity: number;
  /** Spin about the vertical axis, degrees, to aim the view. */
  rotation: number;
  /** Where the horizon sits in the image, 0 = top edge, 1 = bottom. */
  horizon: number;
  /** Vertical span of the image across the sky. Larger zooms in. */
  scale: number;
}

export function defaultBackdrop(image: string): Backdrop {
  return { image, opacity: 1, rotation: 0, horizon: 0.5, scale: 1 };
}

export type RailShape = 'round' | 'flat' | 'square';

export interface BaseFeature {
  /** Stable id so the editor can address, undo and multi-select features. */
  id: string;
  kind: FeatureKind;
  /** World position of the feature origin: x across the fall line, z down it. */
  x: number;
  z: number;
  /** Yaw in degrees; 0 points straight down the fall line. */
  heading: number;
}

/** A takeoff ramp built from a circular transition, exactly like a real jump. */
export interface KickerFeature extends BaseFeature {
  kind: 'kicker';
  /** Lip height above the surrounding terrain, metres. */
  height: number;
  /** Take-off angle at the lip, degrees. Real park jumps run 25-45. */
  lipAngle: number;
  width: number;
  /** Flat distance from the lip to the start of the landing, metres. 0 disables. */
  gap: number;
  /** Landing slope length, metres. 0 leaves the natural terrain. */
  landingLength: number;
  /** Landing steepness, degrees. */
  landingAngle: number;
}

export interface RailFeature extends BaseFeature {
  kind: 'rail';
  length: number;
  /** Height of the rail surface above the terrain at its start, metres. */
  height: number;
  /** Height at the far end — differing values make a down-rail or up-rail. */
  endHeight: number;
  shape: RailShape;
  /** Tube diameter (round) or bar width (flat/square), metres. */
  thickness: number;
  /** Degrees of kink applied at the midpoint; 0 is straight. */
  kink: number;
}

export interface BoxFeature extends BaseFeature {
  kind: 'box';
  length: number;
  width: number;
  height: number;
  endHeight: number;
}

export interface QuarterpipeFeature extends BaseFeature {
  kind: 'quarterpipe';
  /** Transition radius, metres. */
  radius: number;
  /** Vertical wall above the transition, metres. */
  vert: number;
  width: number;
}

export interface HalfpipeFeature extends BaseFeature {
  kind: 'halfpipe';
  length: number;
  /** Flat bottom width, metres. */
  flatWidth: number;
  radius: number;
  vert: number;
}

export interface HipFeature extends BaseFeature {
  kind: 'hip';
  height: number;
  width: number;
  length: number;
  /** Degrees the landing is rotated away from the takeoff. */
  hipAngle: number;
}

export interface RollerFeature extends BaseFeature {
  kind: 'roller';
  height: number;
  width: number;
  length: number;
}

export interface WallrideFeature extends BaseFeature {
  kind: 'wallride';
  length: number;
  height: number;
  /** Lean from vertical, degrees. 0 is a dead-vertical wall. */
  lean: number;
}

export interface GateFeature extends BaseFeature {
  kind: 'gate';
  width: number;
  /** Ordering for race and slalom modes. */
  order: number;
}

export interface PropFeature extends BaseFeature {
  kind: 'prop';
  prop: PropKind;
  scale: number;
}

export type Feature =
  | KickerFeature
  | RailFeature
  | BoxFeature
  | QuarterpipeFeature
  | HalfpipeFeature
  | HipFeature
  | RollerFeature
  | WallrideFeature
  | GateFeature
  | PropFeature;

/** Freeform terrain sculpting stroke laid down by the editor's terrain brush. */
export interface TerrainBrush {
  id: string;
  x: number;
  z: number;
  radius: number;
  /** Positive raises, negative lowers, metres at the centre. */
  amount: number;
  /** 0 = sharp cone, 1 = wide smooth dome. */
  falloff: number;
}

export interface SnowSettings {
  /**
   * 0 = deep untouched powder, 1 = injected race ice. Drives penetration depth,
   * edge grip and how much spray comes off a skid.
   */
  hardness: number;
  /** Loose snow depth on top of the base, metres. */
  depth: number;
  /** Groomed corduroy gives predictable grip and a visible texture. */
  groomed: boolean;
}

export interface WeatherSettings {
  /** Hours, 0-24. Drives sun elevation, colour and fog. */
  timeOfDay: number;
  /** 0 = bluebird, 1 = full whiteout. */
  cloud: number;
  /** Falling snow density, 0-1. */
  snowfall: number;
  /** Wind speed in m/s; pushes airborne riders and drifts particles. */
  wind: number;
  windDirection: number;
  /** 0-1 haze that stacks with cloud. */
  fog: number;
}

export interface TerrainSettings {
  /** Level extent across the fall line, metres. */
  width: number;
  /** Level extent down the fall line, metres. */
  length: number;
  /** Average pitch in degrees. */
  slopeAngle: number;
  /** Amplitude of the natural rolling terrain, metres. */
  roughness: number;
  /** Horizontal scale of the natural terrain features, metres. */
  featureScale: number;
  /** Baked grid spacing, metres. Smaller is sharper and heavier. */
  resolution: number;
  /** Raises the sides into a natural gully so riders funnel back in. */
  banking: number;
}

/**
 * Which ride model a level uses.
 *
 * `mountain` is the game as it has always been: gravity is the speed source,
 * there is no ceiling, and a long pitch keeps giving. `street` is the reference
 * loop — near-flat ground where speed has to be worked for, held to a low
 * ceiling, with quick skiddy direction changes instead of long carves.
 *
 * It is per level and not a global setting because both are wanted. The ten
 * stock mountains are mountains; a street course is a street course; and the
 * numbers that are right for one are wrong for the other.
 */
export type RideStyle = 'mountain' | 'street';

export interface LevelDef {
  version: number;
  id: string;
  name: string;
  author: string;
  /**
   * Local rider id of whoever built it, or '' for anything made before ids
   * existed and for the stock mountains. The display name above can be changed
   * or duplicated; this cannot, which is what makes it worth stamping.
   */
  authorId: string;
  /** Free-text description shown in the level browser. */
  notes: string;
  seed: number;
  discipline: 'ski' | 'snowboard' | 'both';
  /** Ride model. Absent in levels saved before v6, which are all mountains. */
  style: RideStyle;
  terrain: TerrainSettings;
  snow: SnowSettings;
  weather: WeatherSettings;
  spawn: { x: number; z: number; heading: number };
  features: Feature[];
  brushes: TerrainBrush[];
  /** Optional picture drawn behind the terrain, in place of the painted sky. */
  backdrop: Backdrop | null;
  /** Unix ms; used for sorting in the local library. */
  createdAt: number;
  updatedAt: number;
}

export function defaultTerrain(): TerrainSettings {
  return {
    width: 220,
    length: 900,
    slopeAngle: 17,
    roughness: 2.2,
    featureScale: 90,
    resolution: 0.5,
    banking: 0.35,
  };
}

export function defaultSnow(): SnowSettings {
  return { hardness: 0.55, depth: 0.35, groomed: true };
}

/**
 * Bluebird, because that is the name of the game.
 *
 * The old defaults — quarter cloud, a fifth of a fog, light snowfall, sun an
 * hour and a half off noon — were a *nice* day, and every level that did not
 * override them inherited it. Nice is the problem. Cloud desaturates the sky
 * and lifts the horizon band; fog washes the skyline; falling snow puts a grey
 * veil over the whole frame. Stacked, they gave the flat pale wash that reads
 * as haze on every screenshot, and they did it to eight of the ten stock
 * mountains.
 *
 * The look this game is aiming at is a hard one: fully saturated flat blue,
 * near-clipped white snow, and a horizon that is a line rather than a fade.
 * None of it survives contact with atmosphere, so the default has none —
 * cloud and fog are left just off zero rather than at zero so the sliders
 * still have somewhere to travel from, and the sun sits at noon where its
 * colour is white and its shadows are short and blue.
 *
 * Weather is still a per-level authored value. Powder Bowl, Cornice and Last
 * Light pin their own and are untouched by this; what changes is what you get
 * when nobody asked for anything.
 *
 * Wind is the one number here that is not the one asked for. The art direction
 * called for 1 m/s; it stays at 2, because wind is not a visual setting and
 * this one is load-bearing. Snowfall is zero now, so the only thing 1 m/s
 * would have changed on screen is the drift on carve spray — while in the sim
 * wind is a real force, and airborne rotation is computed against airspeed
 * relative to it. Measured on T9's reference jump, dropping it to 1 breaks two
 * rungs of the trick ladder: both 720 pump cadences come back 540, and the
 * cork loses its inversion. That is a gameplay change bought with no picture,
 * so it is not taken. `tests/air-feel.ts` now pins the value rather than
 * inheriting it, so the ladder no longer moves when this function does.
 */
export function defaultWeather(): WeatherSettings {
  return {
    timeOfDay: 12,
    cloud: 0.02,
    snowfall: 0,
    wind: 2,
    windDirection: 20,
    fog: 0.02,
  };
}

let idCounter = 0;

export function makeId(prefix = 'f'): string {
  idCounter += 1;
  const rand = Math.floor(Math.random() * 0x10000).toString(36);
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${rand}`;
}

export function emptyLevel(name = 'Untitled Line'): LevelDef {
  const now = Date.now();
  return {
    version: LEVEL_FORMAT_VERSION,
    id: makeId('lvl'),
    name,
    author: 'you',
    authorId: '',
    notes: '',
    seed: (Math.random() * 0xffffffff) >>> 0,
    discipline: 'both',
    style: 'mountain',
    terrain: defaultTerrain(),
    snow: defaultSnow(),
    weather: defaultWeather(),
    spawn: { x: 0, z: 24, heading: 0 },
    features: [],
    brushes: [],
    backdrop: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Per-kind defaults used when the editor drops a fresh feature. */
export function makeFeature(kind: FeatureKind, x: number, z: number, heading = 0): Feature {
  const base = { id: makeId(kind), kind, x, z, heading };
  switch (kind) {
    case 'kicker':
      return { ...base, kind, height: 2.2, lipAngle: 32, width: 9, gap: 8, landingLength: 26, landingAngle: 30 };
    case 'rail':
      return { ...base, kind, length: 14, height: 0.9, endHeight: 0.9, shape: 'round', thickness: 0.09, kink: 0 };
    case 'box':
      return { ...base, kind, length: 12, width: 1.4, height: 0.6, endHeight: 0.6 };
    case 'quarterpipe':
      return { ...base, kind, radius: 4.5, vert: 0.8, width: 14 };
    case 'halfpipe':
      return { ...base, kind, length: 120, flatWidth: 17, radius: 6.4, vert: 1.1 };
    case 'hip':
      return { ...base, kind, height: 2.6, width: 12, length: 14, hipAngle: 45 };
    case 'roller':
      return { ...base, kind, height: 1.6, width: 16, length: 18 };
    case 'wallride':
      return { ...base, kind, length: 10, height: 3, lean: 8 };
    case 'gate':
      return { ...base, kind, width: 8, order: 0 };
    case 'prop':
      return { ...base, kind, prop: 'pine', scale: 1 };
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled feature kind ${String(exhaustive)}`);
    }
  }
}

/** Terrain-modifying features change the baked heightfield; the rest are colliders or decor. */
export function isTerrainFeature(f: Feature): boolean {
  return (
    f.kind === 'kicker' ||
    f.kind === 'quarterpipe' ||
    f.kind === 'halfpipe' ||
    f.kind === 'hip' ||
    f.kind === 'roller'
  );
}

/** Features the grind solver needs to know about. */
export function isGrindFeature(f: Feature): f is RailFeature | BoxFeature {
  return f.kind === 'rail' || f.kind === 'box';
}

/**
 * Normalises anything that claims to be a level: fills in missing fields from
 * older format versions and clamps values that would break the baker.
 */
export function migrateLevel(raw: unknown): LevelDef {
  if (!raw || typeof raw !== 'object') throw new Error('Level data is not an object');
  const src = raw as Partial<LevelDef> & Record<string, unknown>;
  const base = emptyLevel(typeof src.name === 'string' ? src.name : 'Imported Line');

  const level: LevelDef = {
    ...base,
    version: LEVEL_FORMAT_VERSION,
    id: typeof src.id === 'string' ? src.id : base.id,
    name: typeof src.name === 'string' ? src.name : base.name,
    author: typeof src.author === 'string' ? src.author : 'unknown',
    // v4 -> v5. Levels from before the stamp existed keep an empty id rather
    // than being attributed to whoever happens to be importing them.
    authorId: typeof src.authorId === 'string' ? src.authorId : '',
    notes: typeof src.notes === 'string' ? src.notes : '',
    seed: typeof src.seed === 'number' ? src.seed >>> 0 : base.seed,
    discipline:
      src.discipline === 'ski' || src.discipline === 'snowboard' || src.discipline === 'both'
        ? src.discipline
        : 'both',
    // Absent means a level written before street existed, and everything
    // written before street existed is a mountain. Never guess from the slope
    // angle: a shallow mountain is still a mountain.
    style: src.style === 'street' ? 'street' : 'mountain',
    terrain: { ...base.terrain, ...(src.terrain as TerrainSettings | undefined) },
    snow: { ...base.snow, ...(src.snow as SnowSettings | undefined) },
    weather: { ...base.weather, ...(src.weather as WeatherSettings | undefined) },
    spawn: { ...base.spawn, ...(src.spawn as LevelDef['spawn'] | undefined) },
    features: Array.isArray(src.features) ? (src.features as Feature[]).filter(isValidFeature) : [],
    brushes: Array.isArray(src.brushes) ? (src.brushes as TerrainBrush[]).filter(isValidBrush) : [],
    backdrop: sanitizeBackdrop(src.backdrop),
    createdAt: typeof src.createdAt === 'number' ? src.createdAt : base.createdAt,
    updatedAt: Date.now(),
  };

  const t = level.terrain;
  t.width = clampNum(t.width, 60, 1200, 220);
  t.length = clampNum(t.length, 100, 4000, 900);
  t.slopeAngle = clampNum(t.slopeAngle, 2, 55, 17);
  t.roughness = clampNum(t.roughness, 0, 30, 2.2);
  t.featureScale = clampNum(t.featureScale, 8, 400, 90);
  t.resolution = clampNum(t.resolution, 0.25, 4, 0.5);
  t.banking = clampNum(t.banking, 0, 3, 0.35);

  // Keep the baked grid within a sane memory budget regardless of what a shared
  // level claims, so a hostile or careless share code can't allocate gigabytes.
  const maxCells = 4_000_000;
  while ((t.width / t.resolution) * (t.length / t.resolution) > maxCells) {
    t.resolution *= 1.5;
  }

  level.snow.hardness = clampNum(level.snow.hardness, 0, 1, 0.55);
  level.snow.depth = clampNum(level.snow.depth, 0, 2.5, 0.35);
  level.weather.timeOfDay = clampNum(level.weather.timeOfDay, 0, 24, 10.5);
  level.weather.cloud = clampNum(level.weather.cloud, 0, 1, 0.25);
  level.weather.snowfall = clampNum(level.weather.snowfall, 0, 1, 0.15);
  level.weather.wind = clampNum(level.weather.wind, 0, 30, 2);
  level.weather.fog = clampNum(level.weather.fog, 0, 1, 0.2);

  if (level.features.length > 2000) level.features.length = 2000;
  if (level.brushes.length > 4000) level.brushes.length = 4000;

  return level;
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.min(hi, Math.max(lo, n));
}

function isValidFeature(f: unknown): f is Feature {
  if (!f || typeof f !== 'object') return false;
  const c = f as Feature;
  if (typeof c.kind !== 'string' || !Number.isFinite(c.x) || !Number.isFinite(c.z)) return false;
  // An unknown item kind from a newer build (or a hand-edited file) becomes a
  // pine rather than an invisible hole in someone's level.
  if (c.kind === 'prop' && !isPropKind(c.prop)) c.prop = 'pine';
  return true;
}

/** Inline images only, and only ones we would actually decode. */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Roughly 3 MB of base64, which is about 2.2 MB of pixels. */
const MAX_BACKDROP_CHARS = 3_000_000;

/**
 * Validates a backdrop off a shared level.
 *
 * Levels arrive from other people through share codes, so this is a trust
 * boundary. Only inline base64 image data is allowed: a remote `https:` URL
 * would make every player's browser fetch from a stranger's server the moment
 * they dropped in, and anything that is not an image is a script-injection
 * vector dressed as scenery.
 */
export function sanitizeBackdrop(raw: unknown): Backdrop | null {
  if (!raw || typeof raw !== 'object') return null;
  const b = raw as Partial<Backdrop>;
  if (typeof b.image !== 'string') return null;
  if (b.image.length > MAX_BACKDROP_CHARS) return null;
  if (!DATA_IMAGE.test(b.image)) return null;
  return {
    image: b.image,
    opacity: clampNum(b.opacity, 0, 1, 1),
    rotation: clampNum(b.rotation, -180, 180, 0),
    horizon: clampNum(b.horizon, 0, 1, 0.5),
    scale: clampNum(b.scale, 0.3, 3, 1),
  };
}

function isValidBrush(b: unknown): b is TerrainBrush {
  if (!b || typeof b !== 'object') return false;
  const c = b as TerrainBrush;
  return Number.isFinite(c.x) && Number.isFinite(c.z) && Number.isFinite(c.radius);
}

export function cloneLevel(level: LevelDef): LevelDef {
  return JSON.parse(JSON.stringify(level)) as LevelDef;
}
