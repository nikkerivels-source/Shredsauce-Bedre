import { describe, expect, it, beforeEach } from 'vitest';
import {
  PROFILE_SCHEMA_VERSION,
  defaultProfile,
  migrateProfile,
  newRiderId,
  randomRiderName,
  type Profile,
} from '../src/game/storage.ts';
import { emptyLevel, migrateLevel, LEVEL_FORMAT_VERSION } from '../src/world/level.ts';

/**
 * Local identity.
 *
 * The migration is the dangerous part of this feature and the reason the schema
 * stamp was added before anything needed it. A profile is somebody's fifty
 * hours: their builds, their unlocks, the name they chose. A migration that
 * drops one field is indistinguishable from a migration that drops all of them,
 * from the point of view of the person it happened to. So these are written
 * against the *old* shapes on purpose — an object with no version and no rider
 * id is exactly what is sitting in browsers right now.
 */

/** A profile as written by the build before local identity existed. */
function legacyProfile(): Record<string, unknown> {
  return {
    name: 'rider',
    discipline: 'skis',
    goofy: true,
    boardId: 'park-155',
    skiId: 'twin-172',
    appearance: { jacket: '#112233', pants: '#445566', helmet: '#778899', goggles: '#aabbcc', board: '#ddeeff', skin: '#c99b76' },
    assist: 0.2,
    quality: 'medium',
    masterVolume: 0.35,
    xp: 41_200,
    credits: 8_600,
    ownedGear: ['park-155', 'twin-172', 'bigmtn-186'],
    completed: ['first-air', 'first-rail'],
    riderMass: 81,
    pass: { owned: true, since: 1_700_000_000_000 },
    skinId: 'ember',
  };
}

describe('C1 — local identity', () => {
  let storage: Record<string, string>;
  beforeEach(() => {
    storage = {};
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => {
        storage[k] = v;
      },
      removeItem: (k: string) => {
        delete storage[k];
      },
    };
  });

  it('gives a fresh profile an id, a readable name and no account', () => {
    const profile = defaultProfile();
    expect(profile.riderId).toMatch(/^rider_[0-9a-f]{32}$/);
    expect(profile.accountId).toBeNull();
    expect(profile.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
    // Two words, both readable, and not the word "rider".
    expect(profile.name.split(' ')).toHaveLength(2);
    expect(profile.name).not.toBe('rider');
  });

  it('mints a different id for every browser', () => {
    const ids = new Set(Array.from({ length: 200 }, () => newRiderId()));
    expect(ids.size).toBe(200);
  });

  it('offers enough names that two riders rarely collide', () => {
    const names = new Set(Array.from({ length: 400 }, () => randomRiderName()));
    expect(names.size).toBeGreaterThan(150);
  });

  it('carries every field of a pre-identity profile through the migration untouched', () => {
    const legacy = legacyProfile();
    const migrated = migrateProfile(legacy as Partial<Profile>);

    // Everything the player had is still exactly what they had.
    for (const [key, value] of Object.entries(legacy)) {
      if (key === 'name') continue; // covered separately below
      expect(migrated[key as keyof Profile], key).toEqual(value);
    }
    // And the new fields are populated rather than left undefined.
    expect(migrated.riderId).toMatch(/^rider_/);
    expect(migrated.accountId).toBeNull();
    expect(migrated.schemaVersion).toBe(PROFILE_SCHEMA_VERSION);
  });

  it('replaces the old fixed default name but never a name the player chose', () => {
    const anonymous = migrateProfile(legacyProfile() as Partial<Profile>);
    expect(anonymous.name).not.toBe('rider');

    const chosen = migrateProfile({ ...legacyProfile(), name: 'Sondre' } as Partial<Profile>);
    expect(chosen.name).toBe('Sondre');
  });

  it('keeps the same id across reloads and never re-mints one it already has', () => {
    const first = migrateProfile(legacyProfile() as Partial<Profile>);
    const again = migrateProfile(first);
    const third = migrateProfile(again);
    expect(again.riderId).toBe(first.riderId);
    expect(third.riderId).toBe(first.riderId);
  });

  it('does not drop fields written by a newer build', () => {
    // Someone rides on a newer deploy, then loads an older one. Their data must
    // survive the round trip rather than being erased by the older schema.
    const future = { ...legacyProfile(), schemaVersion: 99, somethingNew: 'keep me' };
    const migrated = migrateProfile(future as Partial<Profile>) as unknown as Record<string, unknown>;
    expect(migrated.somethingNew).toBe('keep me');
  });

  it('survives a corrupt or empty stored profile instead of throwing', () => {
    expect(() => migrateProfile({} as Partial<Profile>)).not.toThrow();
    expect(migrateProfile({ riderId: '', name: '   ' } as Partial<Profile>).riderId).toMatch(/^rider_/);
    expect(migrateProfile({ name: '   ' } as Partial<Profile>).name.trim()).not.toBe('');
  });

  it('stamps a level with its builder and leaves older levels unattributed', () => {
    const level = emptyLevel('Test Line');
    expect(level.authorId).toBe('');
    level.authorId = 'rider_abc';
    const round = migrateLevel(JSON.parse(JSON.stringify(level)));
    expect(round.authorId).toBe('rider_abc');
    expect(round.version).toBe(LEVEL_FORMAT_VERSION);

    // A level saved before the stamp existed must not be attributed to whoever
    // happens to import it.
    const old = JSON.parse(JSON.stringify(level)) as Record<string, unknown>;
    delete old.authorId;
    old.version = 4;
    expect(migrateLevel(old).authorId).toBe('');
  });
});
