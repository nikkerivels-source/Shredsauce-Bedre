/**
 * Season One — the pass.
 *
 * One price, everything at once. No tiers to climb, no daily quests, no season
 * to miss: you buy it and every skin and every ski is yours immediately and
 * permanently. That shape is the product, so it is worth stating plainly in the
 * code as well as on the screen.
 *
 * Two design rules hold it together:
 *
 * 1. **Nothing in here is strictly better.** Every pass ski trades something
 *    away — the light one is nervous at speed, the stable one is heavy, the
 *    powder one is vague on hardpack. A pass that sells superiority makes the
 *    free game pointless, which is a worse outcome than not selling one.
 * 2. **Nothing in here is required.** No level, mode, mountain or editor
 *    feature is behind it. It is entirely cosmetic plus sidegrade equipment.
 *
 * ## On actually taking money
 *
 * This game has no server. Entitlement therefore lives in the same localStorage
 * profile as everything else, which means it is editable by anyone who opens
 * devtools — there is no way around that without a backend that can hold an
 * account and verify a receipt. `beginCheckout` below is the seam where a real
 * provider goes: point `VITE_CHECKOUT_URL` at a hosted checkout, have it return
 * to the game, and replace the local grant with a server-verified one. Until
 * that exists the pass screen says so rather than pretending.
 */

import { GEAR_CATALOG, type GearSpec } from '../physics/gear.ts';
import type { RiderAppearance } from '../render/rider.ts';

export interface Skin {
  id: string;
  name: string;
  /** One-line flavour, shown under the name. */
  note: string;
  appearance: RiderAppearance;
  /** Free skins ship with the game; the rest come with the pass. */
  pass?: boolean;
}

export const SKINS: Skin[] = [
  {
    id: 'house',
    name: 'House',
    note: 'The kit the game ships in.',
    appearance: {
      jacket: '#23272f',
      pants: '#e0622a',
      helmet: '#1a1d23',
      goggles: '#101318',
      board: '#3f97e0',
      skin: '#c99b76',
    },
  },
  {
    id: 'slate',
    name: 'Slate',
    note: 'Grey on grey. Lets the mountain do the talking.',
    appearance: {
      jacket: '#4a5058',
      pants: '#2c3138',
      helmet: '#20242a',
      goggles: '#0d1015',
      board: '#8d949c',
      skin: '#c99b76',
    },
  },
  {
    id: 'highvis',
    name: 'High Vis',
    note: 'Findable in a whiteout, which is the point.',
    appearance: {
      jacket: '#e8e34a',
      pants: '#3a3f47',
      helmet: '#1a1d23',
      goggles: '#101318',
      board: '#e8e34a',
      skin: '#c99b76',
    },
  },
  // --- Pass ---------------------------------------------------------------
  {
    id: 'patrol',
    name: 'Patrol',
    note: 'Cross on the back, first one down every morning.',
    pass: true,
    appearance: {
      jacket: '#c8202a',
      pants: '#16181c',
      helmet: '#f2f4f7',
      goggles: '#141820',
      board: '#c8202a',
      skin: '#c99b76',
    },
  },
  {
    id: 'glacier',
    name: 'Glacier',
    note: 'Ice white with a blue shift, like the back of a crevasse.',
    pass: true,
    appearance: {
      jacket: '#e6eef6',
      pants: '#9fc4dd',
      helmet: '#f4f8fc',
      goggles: '#2a6fa8',
      board: '#bcd9ec',
      skin: '#c99b76',
    },
  },
  {
    id: 'sunburst',
    name: 'Sunburst',
    note: 'Late-seventies spring skiing, entirely unashamed.',
    pass: true,
    appearance: {
      jacket: '#f0a52e',
      pants: '#f4ece0',
      helmet: '#d9451f',
      goggles: '#5a2d12',
      board: '#d9451f',
      skin: '#c99b76',
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    note: 'Black with a violet cast. Reads as a silhouette.',
    pass: true,
    appearance: {
      jacket: '#15131f',
      pants: '#241d3a',
      helmet: '#0d0b14',
      goggles: '#6d4bd6',
      board: '#6d4bd6',
      skin: '#c99b76',
    },
  },
  {
    id: 'heritage',
    name: 'Heritage',
    note: 'Waxed cotton and wool. Skis better than it looks.',
    pass: true,
    appearance: {
      jacket: '#3f5347',
      pants: '#8a6b46',
      helmet: '#2b241c',
      goggles: '#4a3a24',
      board: '#8a6b46',
      skin: '#c99b76',
    },
  },
  {
    id: 'carbon',
    name: 'Carbon',
    note: 'All black, everything. No graphics anywhere.',
    pass: true,
    appearance: {
      jacket: '#131519',
      pants: '#1b1e24',
      helmet: '#0c0e11',
      goggles: '#2a2f38',
      board: '#0c0e11',
      skin: '#c99b76',
    },
  },
  {
    id: 'bluebird',
    name: 'Bluebird',
    note: 'House colours, worn properly.',
    pass: true,
    appearance: {
      jacket: '#0b5cff',
      pants: '#f4f7fa',
      helmet: '#0740b4',
      goggles: '#0a1830',
      board: '#0b5cff',
      skin: '#c99b76',
    },
  },
];

export const PASS = {
  id: 'season-one',
  name: 'Season One',
  /** United States dollars. Charged once, ever. */
  price: 2.99,
  currency: 'USD',
  tagline: 'Everything at once, forever. No tiers, no quests, no season to miss.',
} as const;

export function getSkin(id: string): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS[0];
}

export function passSkins(): Skin[] {
  return SKINS.filter((s) => s.pass);
}

export function passGear(): GearSpec[] {
  return GEAR_CATALOG.filter((g) => g.pass);
}

/** True when this skin or ski is available to a player in this state. */
export function skinUnlocked(skin: Skin, owned: boolean): boolean {
  return !skin.pass || owned;
}

export function gearUnlocked(gear: GearSpec, owned: boolean): boolean {
  return !gear.pass || owned;
}

/**
 * Where a real checkout lives, if one has been configured at build time.
 *
 * Set `VITE_CHECKOUT_URL` to a hosted checkout (Stripe Payment Link, Paddle,
 * Lemon Squeezy — anything that can take a return URL). Absent it, the pass
 * screen explains that payment is not connected instead of miming a purchase.
 */
export function checkoutUrl(): string | null {
  const raw = import.meta.env?.VITE_CHECKOUT_URL;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  // Only ever send someone to a real https endpoint. A javascript: or data:
  // URL here would be a redirect straight into script execution.
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export type CheckoutOutcome =
  | { kind: 'redirect'; url: string }
  | { kind: 'unconfigured' };

/**
 * Starts a purchase.
 *
 * With a provider configured this hands off to it and the browser leaves the
 * page. Without one there is nothing honest to do but say so — granting the
 * pass here anyway would be a purchase button that quietly gives things away,
 * which is worse than a button that admits it is not finished.
 */
export function beginCheckout(): CheckoutOutcome {
  const url = checkoutUrl();
  if (!url) return { kind: 'unconfigured' };
  return { kind: 'redirect', url };
}

/**
 * Handles the return leg of a hosted checkout.
 *
 * PLACEHOLDER. A real implementation must not trust a query parameter: the
 * provider's success redirect has to carry a token this game hands to a server,
 * which verifies the payment against the provider's API (or a signed webhook it
 * already received) and only then records the entitlement. A URL parameter is
 * forgeable by anyone who reads this file.
 *
 * It is gated on a provider actually being configured, so in a build with no
 * checkout — which is this one — the parameter does nothing at all.
 */
export function consumeCheckoutReturn(): boolean {
  if (!checkoutUrl()) return false;
  if (typeof window === 'undefined') return false;
  const params = new URLSearchParams(window.location.search);
  if (params.get('checkout') !== 'success') return false;
  // Clear it so a refresh does not re-trigger, and so the URL stays clean.
  params.delete('checkout');
  const query = params.toString();
  window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''));
  return true;
}
