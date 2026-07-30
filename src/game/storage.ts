import { migrateLevel, type LevelDef } from '../world/level.ts';
import { defaultAppearance, type RiderAppearance } from '../render/rider.ts';
import type { Discipline } from '../physics/gear.ts';

const PROFILE_KEY = 'bluebird.profile.v1';
const LIBRARY_KEY = 'bluebird.levels.v1';
const SCORES_KEY = 'bluebird.scores.v1';

/**
 * Profile schema version.
 *
 * Bumped whenever a field is added, removed or changes meaning, with the
 * matching step written into `migrateProfile` in the same commit. This exists
 * from before it was needed on purpose: retrofitting a version stamp onto
 * profiles already in people's browsers means guessing what shape each one is,
 * and guessing wrong loses somebody's fifty hours.
 */
export const PROFILE_SCHEMA_VERSION = 1;

export interface Profile {
  /** Schema the stored blob was written by. See `migrateProfile`. */
  schemaVersion: number;
  /**
   * Stable local identity, generated on first run and never shown.
   *
   * Everything the player makes is stamped with it, so that when an account
   * does arrive it has something to claim rather than a pile of anonymous
   * objects. It is not a secret and it is not an account.
   */
  riderId: string;
  /**
   * Set once the local rider is claimed by a signed-in account.
   *
   * Null means signed out, which is the normal, complete, permanently supported
   * state of this game — not a state to be escaped from.
   */
  accountId: string | null;
  name: string;
  discipline: Discipline;
  goofy: boolean;
  boardId: string;
  skiId: string;
  appearance: RiderAppearance;
  /** 0 = raw physics, 1 = fully assisted. */
  assist: number;
  quality: 'low' | 'medium' | 'high';
  /**
   * Render scale, 0.5–1.
   *
   * Separate from the quality preset because it is the one performance knob
   * that trades nothing but sharpness. A phone that cannot hold 60 at native
   * resolution can drop to 0.7 and keep every effect it had.
   */
  resolutionScale: number;
  masterVolume: number;
  xp: number;
  credits: number;
  ownedGear: string[];
  /** Challenge ids the player has completed. */
  completed: string[];
  riderMass: number;
  /**
   * Season One entitlement.
   *
   * There is no server, so this is the whole record of ownership and it lives
   * in the same editable localStorage blob as everything else. That is stated
   * on the pass screen rather than pretended away — a client-only entitlement
   * cannot be enforced, and clearing site data loses it.
   */
  pass: { owned: boolean; since: number } | null;
  /** Currently worn skin id, from `SKINS`. */
  skinId: string;
}

/**
 * A readable name, so nobody has to be called "rider".
 *
 * Two words from the mountain, which reads as a name a person might have picked
 * rather than as a serial number, and is short enough for a leaderboard row.
 * The player can change it the moment they see it; this only has to be better
 * than a blank field.
 */
const NAME_FIRST = [
  'Cold', 'North', 'Quiet', 'Blue', 'Loose', 'High', 'Low', 'First', 'Last', 'Deep',
  'Bright', 'Steep', 'Wind', 'Storm', 'Dawn', 'Late', 'Far', 'Hard', 'Soft', 'Long',
];
const NAME_SECOND = [
  'Larch', 'Chute', 'Cornice', 'Spine', 'Traverse', 'Couloir', 'Ridge', 'Basin', 'Glade', 'Bowl',
  'Saddle', 'Notch', 'Gully', 'Shelf', 'Face', 'Bench', 'Col', 'Drift', 'Line', 'Slab',
];

export function randomRiderName(): string {
  const a = NAME_FIRST[Math.floor(Math.random() * NAME_FIRST.length)];
  const b = NAME_SECOND[Math.floor(Math.random() * NAME_SECOND.length)];
  return `${a} ${b}`;
}

/** Local identity. Random, opaque, and generated exactly once per browser. */
export function newRiderId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return `rider_${out}`;
}

export function defaultProfile(): Profile {
  return {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    riderId: newRiderId(),
    accountId: null,
    name: randomRiderName(),
    // It is a freeski game first. Snowboard is a choice, not the default.
    discipline: 'skis',
    goofy: false,
    boardId: 'park-155',
    skiId: 'twin-172',
    appearance: defaultAppearance(),
    assist: 0.55,
    quality: 'high',
    resolutionScale: 1,
    masterVolume: 0.7,
    xp: 0,
    credits: 500,
    ownedGear: ['park-155', 'twin-172'],
    completed: [],
    riderMass: 74,
    pass: null,
    skinId: 'house',
  };
}

/** Rider level derived from experience. Gear unlocks key off this. */
export function levelFromXp(xp: number): number {
  return Math.floor(Math.pow(Math.max(0, xp) / 1200, 0.62));
}

export function xpForLevel(level: number): number {
  return Math.ceil(Math.pow(level, 1 / 0.62) * 1200);
}

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing or a full quota. Losing progress is better than crashing.
  }
}

/**
 * Brings a stored profile up to the current schema.
 *
 * The contract is that this only ever *adds*. A profile written by an older
 * build must come out the other side with every field it had still set to the
 * value it had; anything missing is filled in, nothing is dropped because the
 * current build does not recognise it. Unknown keys are preserved by the spread
 * for the same reason — a downgrade should not silently destroy data a newer
 * build wrote.
 */
export function migrateProfile(stored: Partial<Profile>): Profile {
  const version = Number.isFinite(stored.schemaVersion) ? Number(stored.schemaVersion) : 0;
  const profile = { ...defaultProfile(), ...stored };

  // v0 -> v1: local identity. Profiles written before this existed have no
  // rider id and no account field, and the name may be the old fixed default.
  if (version < 1) {
    profile.riderId = typeof stored.riderId === 'string' && stored.riderId ? stored.riderId : newRiderId();
    profile.accountId = null;
    // 'rider' was the hard-coded default, so it carries no intent and can be
    // replaced. A name the player actually typed is theirs and is left alone.
    if (!stored.name || stored.name === 'rider') profile.name = randomRiderName();
  }

  profile.schemaVersion = PROFILE_SCHEMA_VERSION;
  if (typeof profile.riderId !== 'string' || !profile.riderId) profile.riderId = newRiderId();
  if (typeof profile.accountId !== 'string') profile.accountId = null;
  if (typeof profile.name !== 'string' || !profile.name.trim()) profile.name = randomRiderName();
  return profile;
}

/**
 * Brings a stored appearance up to the current slot list.
 *
 * Gloves and boots used to be drawn in the goggle colour. Splitting them into
 * their own slots is a fix, but it is also a change to what an existing player
 * sees: someone who set bright blue goggles has been riding with bright blue
 * gloves for as long as they have played, and filling the new slots with the
 * factory black would take that away without asking.
 *
 * So a profile saved before the split keeps what it had — the old goggle
 * colour is copied into both new slots — and only a profile that has never
 * seen them gets the new defaults. The player's rider looks identical across
 * the update; the difference is that the colours are now three things they can
 * set instead of one thing they could not.
 */
export function migrateAppearance(stored: Partial<RiderAppearance> | undefined): RiderAppearance {
  const appearance = { ...defaultAppearance(), ...(stored ?? {}) };
  if (stored && typeof stored.goggles === 'string') {
    if (typeof stored.gloves !== 'string') appearance.gloves = stored.goggles;
    if (typeof stored.boots !== 'string') appearance.boots = stored.goggles;
  }
  return appearance;
}

export function loadProfile(): Profile {
  const stored = read<Partial<Profile>>(PROFILE_KEY, {});
  const wasCurrent = stored.schemaVersion === PROFILE_SCHEMA_VERSION;
  const profile = migrateProfile(stored);
  profile.appearance = migrateAppearance(stored.appearance);
  if (!Array.isArray(profile.ownedGear)) profile.ownedGear = defaultProfile().ownedGear;
  if (!Array.isArray(profile.completed)) profile.completed = [];
  if (typeof profile.skinId !== 'string') profile.skinId = 'house';
  // Profiles saved before the render scale existed have no value for it, and a
  // missing one must read as native rather than as zero.
  profile.resolutionScale = Number.isFinite(profile.resolutionScale)
    ? Math.min(1, Math.max(0.5, profile.resolutionScale))
    : 1;
  // Anything other than a well-formed entitlement counts as not owning it.
  profile.pass =
    profile.pass && typeof profile.pass === 'object' && profile.pass.owned === true
      ? { owned: true, since: Number(profile.pass.since) || Date.now() }
      : null;

  // Persist a fresh or migrated profile immediately.
  //
  // Without this the rider id only reaches storage when the player happens to
  // change a setting. Someone who opens the game, builds a level and closes the
  // tab would have that level stamped with an id that is minted again — as a
  // different id — on their next visit, and the thing that was supposed to tie
  // their work together would instead be the thing that scattered it.
  if (!wasCurrent) write(PROFILE_KEY, profile);
  return profile;
}

export function passOwned(profile: Profile): boolean {
  return profile.pass?.owned === true;
}

/**
 * Records the entitlement locally.
 *
 * Call this only after a purchase the game can stand behind. With no server
 * there is nothing to verify against, which is exactly why the pass screen says
 * payment is not connected rather than calling this on a button press.
 */
export function grantPass(profile: Profile): void {
  if (passOwned(profile)) return;
  profile.pass = { owned: true, since: Date.now() };
}

export function saveProfile(profile: Profile): void {
  write(PROFILE_KEY, profile);
}

// ---------------------------------------------------------------------------
// Level library
// ---------------------------------------------------------------------------

export interface StoredLevel {
  level: LevelDef;
  savedAt: number;
}

export function loadLibrary(): StoredLevel[] {
  const raw = read<StoredLevel[]>(LIBRARY_KEY, []);
  if (!Array.isArray(raw)) return [];
  const out: StoredLevel[] = [];
  for (const entry of raw) {
    try {
      out.push({ level: migrateLevel(entry.level), savedAt: entry.savedAt ?? 0 });
    } catch {
      // Skip anything corrupt rather than losing the whole library.
    }
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
}

export function saveToLibrary(level: LevelDef): void {
  const library = loadLibrary().filter((e) => e.level.id !== level.id);
  library.unshift({ level, savedAt: Date.now() });
  write(LIBRARY_KEY, library.slice(0, 60));
}

export function deleteFromLibrary(id: string): void {
  write(LIBRARY_KEY, loadLibrary().filter((e) => e.level.id !== id));
}

// ---------------------------------------------------------------------------
// Share codes
// ---------------------------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Packs a level into a shareable string.
 *
 * Deflates when the browser supports compression streams, which takes a big
 * park from ~9 kB of JSON down to something you can paste into a message. The
 * "P1" / "P0" prefix records which it is so old codes keep working.
 */
export async function encodeLevelCode(level: LevelDef): Promise<string> {
  // A backdrop is several hundred kilobytes of inline image data. Compressed
  // and base64'd it is still a code far too long to paste anywhere, so a shared
  // level travels without its picture and the recipient gets the painted sky.
  // The editor says so where the picture is chosen.
  const shareable: LevelDef = level.backdrop ? { ...level, backdrop: null } : level;
  const json = JSON.stringify(shareable);
  const bytes = new TextEncoder().encode(json);
  if (typeof CompressionStream === 'undefined') return `P0${toBase64Url(bytes)}`;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const packed = new Uint8Array(await new Response(stream).arrayBuffer());
    return `P1${toBase64Url(packed)}`;
  } catch {
    return `P0${toBase64Url(bytes)}`;
  }
}

export async function decodeLevelCode(code: string): Promise<LevelDef> {
  const trimmed = code.trim();
  const version = trimmed.slice(0, 2);
  const body = trimmed.slice(2);
  if (version !== 'P0' && version !== 'P1') throw new Error('That does not look like a Bluebird code.');

  const bytes = fromBase64Url(body);
  let json: string;
  if (version === 'P1') {
    if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot read compressed codes.');
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    json = new TextDecoder().decode(await new Response(stream).arrayBuffer());
  } else {
    json = new TextDecoder().decode(bytes);
  }
  return migrateLevel(JSON.parse(json));
}

// ---------------------------------------------------------------------------
// Scores
// ---------------------------------------------------------------------------

export interface ScoreRecord {
  /** Local rider id of whoever set it. '' for scores from before ids. */
  riderId: string;
  levelId: string;
  levelName: string;
  mode: string;
  score: number;
  bestTrick: string;
  bestCombo: number;
  time: number;
  at: number;
}

export function loadScores(): ScoreRecord[] {
  const raw = read<ScoreRecord[]>(SCORES_KEY, []);
  return Array.isArray(raw) ? raw : [];
}

export function recordScore(record: ScoreRecord): ScoreRecord[] {
  const scores = loadScores();
  scores.push(record);
  scores.sort((a, b) => b.score - a.score);
  const trimmed = scores.slice(0, 200);
  write(SCORES_KEY, trimmed);
  return trimmed;
}

export function bestScoreFor(levelId: string, mode: string): ScoreRecord | null {
  return (
    loadScores()
      .filter((s) => s.levelId === levelId && s.mode === mode)
      .sort((a, b) => b.score - a.score)[0] ?? null
  );
}
