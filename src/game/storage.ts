import { migrateLevel, type LevelDef } from '../world/level.ts';
import { defaultAppearance, type RiderAppearance } from '../render/rider.ts';
import type { Discipline } from '../physics/gear.ts';

const PROFILE_KEY = 'bluebird.profile.v1';
const LIBRARY_KEY = 'bluebird.levels.v1';
const SCORES_KEY = 'bluebird.scores.v1';

export interface Profile {
  name: string;
  discipline: Discipline;
  goofy: boolean;
  boardId: string;
  skiId: string;
  appearance: RiderAppearance;
  /** 0 = raw physics, 1 = fully assisted. */
  assist: number;
  quality: 'low' | 'medium' | 'high';
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

export function defaultProfile(): Profile {
  return {
    name: 'rider',
    // It is a freeski game first. Snowboard is a choice, not the default.
    discipline: 'skis',
    goofy: false,
    boardId: 'park-155',
    skiId: 'twin-172',
    appearance: defaultAppearance(),
    assist: 0.55,
    quality: 'high',
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

export function loadProfile(): Profile {
  const stored = read<Partial<Profile>>(PROFILE_KEY, {});
  const profile = { ...defaultProfile(), ...stored };
  profile.appearance = { ...defaultAppearance(), ...(stored.appearance ?? {}) };
  if (!Array.isArray(profile.ownedGear)) profile.ownedGear = defaultProfile().ownedGear;
  if (!Array.isArray(profile.completed)) profile.completed = [];
  if (typeof profile.skinId !== 'string') profile.skinId = 'house';
  // Anything other than a well-formed entitlement counts as not owning it.
  profile.pass =
    profile.pass && typeof profile.pass === 'object' && profile.pass.owned === true
      ? { owned: true, since: Number(profile.pass.since) || Date.now() }
      : null;
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
