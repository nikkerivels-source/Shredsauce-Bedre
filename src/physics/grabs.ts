import type { Discipline } from './gear.ts';

export type GrabId = string;

export interface GrabSpec {
  id: GrabId;
  name: string;
  discipline: Discipline | 'both';
  /** Which hand does the work — used for the rider pose and for naming. */
  hand: 'lead' | 'trail' | 'both';
  /** Where on the gear the hand lands, normalised -1 (tail) to +1 (nose). */
  position: number;
  /** Which edge the hand reaches across. */
  edge: 'toe' | 'heel' | 'nose' | 'tail';
  /**
   * How far the grab pulls the body in, 0-1. Deeper tucks spin faster because
   * the moment of inertia genuinely drops — a tweaked-out method does not.
   */
  tuck: number;
  /** Base score contribution. */
  difficulty: number;
  /** Extra credit for holding it long and tweaking it out. */
  style: number;
  description: string;
}

export const GRABS: GrabSpec[] = [
  // --- Snowboard ---
  { id: 'indy', name: 'Indy', discipline: 'snowboard', hand: 'trail', position: 0, edge: 'toe', tuck: 0.8, difficulty: 100, style: 1.0, description: 'Trail hand, toe edge, between the feet.' },
  { id: 'mute', name: 'Mute', discipline: 'snowboard', hand: 'lead', position: 0.15, edge: 'toe', tuck: 0.78, difficulty: 120, style: 1.05, description: 'Lead hand across to the toe edge.' },
  { id: 'melon', name: 'Melon', discipline: 'snowboard', hand: 'lead', position: -0.1, edge: 'heel', tuck: 0.72, difficulty: 130, style: 1.1, description: 'Lead hand behind the back to the heel edge.' },
  { id: 'method', name: 'Method', discipline: 'snowboard', hand: 'lead', position: -0.2, edge: 'heel', tuck: 0.2, difficulty: 220, style: 1.6, description: 'Heel edge, knees bent, board pulled to the sky. All style, no spin.' },
  { id: 'stalefish', name: 'Stalefish', discipline: 'snowboard', hand: 'trail', position: 0.05, edge: 'heel', tuck: 0.68, difficulty: 150, style: 1.15, description: 'Trail hand behind the back, heel edge.' },
  { id: 'tail', name: 'Tail', discipline: 'snowboard', hand: 'trail', position: -0.95, edge: 'tail', tuck: 0.5, difficulty: 140, style: 1.2, description: 'Trail hand on the tail, board pulled up behind.' },
  { id: 'nose', name: 'Nose', discipline: 'snowboard', hand: 'lead', position: 0.95, edge: 'nose', tuck: 0.5, difficulty: 145, style: 1.2, description: 'Lead hand on the nose.' },
  { id: 'japan', name: 'Japan', discipline: 'snowboard', hand: 'lead', position: -0.55, edge: 'toe', tuck: 0.35, difficulty: 240, style: 1.7, description: 'Lead hand to the toe edge behind the back foot, boned out.' },
  { id: 'crail', name: 'Crail', discipline: 'snowboard', hand: 'trail', position: 0.85, edge: 'nose', tuck: 0.45, difficulty: 200, style: 1.3, description: 'Trail hand reaches across to the nose.' },
  { id: 'seatbelt', name: 'Seatbelt', discipline: 'snowboard', hand: 'lead', position: -0.85, edge: 'tail', tuck: 0.4, difficulty: 230, style: 1.45, description: 'Lead hand across the body to the tail.' },
  { id: 'roastbeef', name: 'Roast Beef', discipline: 'snowboard', hand: 'trail', position: -0.3, edge: 'heel', tuck: 0.42, difficulty: 210, style: 1.4, description: 'Trail hand through the legs to the heel edge.' },
  { id: 'truckdriver', name: 'Truck Driver', discipline: 'snowboard', hand: 'both', position: 0, edge: 'toe', tuck: 0.6, difficulty: 260, style: 1.5, description: 'Both hands, nose and tail. Steer it home.' },
  { id: 'tindy', name: 'Tindy', discipline: 'snowboard', hand: 'trail', position: -0.5, edge: 'toe', tuck: 0.62, difficulty: 90, style: 0.8, description: 'Indy that slipped back toward the tail. It happens.' },
  { id: 'chickensalad', name: 'Chicken Salad', discipline: 'snowboard', hand: 'trail', position: -0.2, edge: 'heel', tuck: 0.4, difficulty: 250, style: 1.5, description: 'Rear hand through the legs, heel edge, arm rotated.' },

  // --- Ski ---
  { id: 'safety', name: 'Safety', discipline: 'skis', hand: 'trail', position: -0.6, edge: 'tail', tuck: 0.72, difficulty: 100, style: 1.0, description: 'Hand to the tail of the ski behind you.' },
  { id: 'ski-mute', name: 'Mute', discipline: 'skis', hand: 'lead', position: 0.2, edge: 'toe', tuck: 0.76, difficulty: 120, style: 1.05, description: 'Cross-grab the opposite ski in front of the boot.' },
  { id: 'ski-japan', name: 'Japan', discipline: 'skis', hand: 'trail', position: -0.7, edge: 'tail', tuck: 0.3, difficulty: 240, style: 1.7, description: 'Reach behind, grab the tail, arch the back.' },
  { id: 'critical', name: 'Critical', discipline: 'skis', hand: 'lead', position: 0.9, edge: 'nose', tuck: 0.45, difficulty: 190, style: 1.35, description: 'Grab the tip of the opposite ski.' },
  { id: 'blunt', name: 'Blunt', discipline: 'skis', hand: 'trail', position: -0.9, edge: 'tail', tuck: 0.48, difficulty: 200, style: 1.4, description: 'Grab behind the boot on the same-side ski, tweaked.' },
  { id: 'ski-tail', name: 'Tail', discipline: 'skis', hand: 'trail', position: -0.95, edge: 'tail', tuck: 0.52, difficulty: 130, style: 1.15, description: 'Straightforward tail grab.' },
  { id: 'ski-nose', name: 'Nose', discipline: 'skis', hand: 'lead', position: 0.95, edge: 'nose', tuck: 0.52, difficulty: 135, style: 1.15, description: 'Straightforward tip grab.' },
  { id: 'octograb', name: 'Octograb', discipline: 'skis', hand: 'both', position: 0, edge: 'toe', tuck: 0.85, difficulty: 280, style: 1.55, description: 'Both hands, both skis, tucked into a ball.' },
  { id: 'ski-truckdriver', name: 'Truck Driver', discipline: 'skis', hand: 'both', position: 0.3, edge: 'nose', tuck: 0.65, difficulty: 250, style: 1.45, description: 'A hand on each tip. Drive it out.' },
  { id: 'genie', name: 'Genie', discipline: 'skis', hand: 'both', position: -0.5, edge: 'tail', tuck: 0.55, difficulty: 300, style: 1.6, description: 'Both hands behind, skis crossed under you.' },
];

const GRAB_MAP = new Map(GRABS.map((g) => [g.id, g]));

export function getGrab(id: GrabId | null): GrabSpec | null {
  return id ? GRAB_MAP.get(id) ?? null : null;
}

export function grabsFor(discipline: Discipline): GrabSpec[] {
  return GRABS.filter((g) => g.discipline === discipline || g.discipline === 'both');
}
