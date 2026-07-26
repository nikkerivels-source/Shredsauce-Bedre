import { clamp01 } from '../core/math.ts';
import type { RiderInput } from '../physics/riderSim.ts';
import type { Session } from './session.ts';
import type { TrickResult } from './tricks.ts';

export interface TutorialContext {
  dt: number;
  session: Session;
  input: RiderInput;
  /** Tricks landed since the previous frame. */
  landed: TrickResult[];
}

export interface TutorialStep {
  id: string;
  title: string;
  instruction: string;
  /** Extra line explaining *why*, shown under the instruction. */
  why: string;
  /** Advances 0 -> 1. Returning 1 completes the step. */
  advance(ctx: TutorialContext, state: StepState): number;
}

interface StepState {
  /** Free accumulator for the step's own use. */
  held: number;
  flag: number;
  progress: number;
}

/**
 * Learn-to-ride.
 *
 * Each step is checked against live telemetry rather than "press this button",
 * because in this game pressing the button is not the skill. You have not
 * learned to carve when you have held left; you have learned when the solver
 * reports a real edge angle with the slip angle near zero. Testing the outcome
 * is the only way to teach a simulation.
 */
export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: 'roll',
    title: 'Point it downhill',
    instruction: 'Let go and let gravity do it. Get up to 25 km/h.',
    why: 'Everything below needs speed. An edge with nothing moving over it does nothing.',
    advance: (ctx) => clamp01(ctx.session.sim.telemetry.speed / 7),
  },
  {
    id: 'edge',
    title: 'Set an edge',
    instruction: 'Hold a lean until the EDGE gauge reads past 20°.',
    why: 'Leaning moves your hips inside and pushes the board out. That is what tips it over.',
    advance: (ctx, state) => {
      const edge = Math.abs(ctx.session.sim.telemetry.edgeAngle);
      state.held = edge > 20 ? state.held + ctx.dt : Math.max(0, state.held - ctx.dt * 1.5);
      return clamp01(state.held / 0.7);
    },
  },
  {
    id: 'carve',
    title: 'Carve, do not skid',
    instruction: 'Hold that edge until GRIP is green and steady for a full second.',
    why: 'A carve is a turn with no sideways slip. Skid and you scrub the speed you just built.',
    advance: (ctx, state) => {
      const t = ctx.session.sim.telemetry;
      const clean = t.carveQuality > 0.6 && Math.abs(t.edgeAngle) > 15 && t.speed > 6;
      state.held = clean ? state.held + ctx.dt : Math.max(0, state.held - ctx.dt);
      return clamp01(state.held / 1.1);
    },
  },
  {
    id: 'link',
    title: 'Link them',
    instruction: 'Now carve the other way, then back again.',
    why: 'Switching edges cleanly is the whole of riding. Everything else is decoration.',
    advance: (ctx, state) => {
      const t = ctx.session.sim.telemetry;
      if (Math.abs(t.edgeAngle) < 15 || t.carveQuality < 0.5) return state.progress;
      const side = Math.sign(t.edgeAngle);
      // `flag` holds the last edge that counted; every clean change scores one.
      if (side !== 0 && side !== state.flag) {
        state.flag = side;
        state.held += 1;
      }
      state.progress = clamp01(state.held / 3);
      return state.progress;
    },
  },
  {
    id: 'pop',
    title: 'Pop',
    instruction: 'Load your legs, then release. Get half a metre of air.',
    why: 'Extending drives the board into the snow and the snow throws you back. That is an ollie.',
    advance: (ctx, state) => {
      state.held = Math.max(state.held, ctx.session.sim.telemetry.altitude);
      return clamp01(state.held / 0.5);
    },
  },
  {
    id: 'spin',
    title: 'Wind up a spin',
    instruction: 'Twist against your edge before you pop, then land a 180.',
    why: 'You cannot start a spin in the air. All of it is set up on the ground against a loaded edge.',
    advance: (ctx, state) => {
      for (const trick of ctx.landed) {
        if (trick.landed && trick.spin >= 180) state.held = 1;
      }
      return state.held;
    },
  },
  {
    id: 'grab',
    title: 'Grab it',
    instruction: 'Get some air and hold a grab until you land.',
    why: 'Grabbing pulls you in, and a tighter body genuinely spins faster. Physics, not scoring.',
    advance: (ctx, state) => {
      for (const trick of ctx.landed) {
        if (trick.landed && trick.breakdown.grab > 0) state.held = 1;
      }
      return state.held;
    },
  },
  {
    id: 'rail',
    title: 'Slide a rail',
    instruction: 'Ride onto a rail and stay on it for four metres.',
    why: 'A rail is a pivot with you balanced on top. Lean against the fall to stay up.',
    advance: (ctx, state) => {
      state.held = Math.max(state.held, ctx.session.sim.telemetry.grindDistance);
      return clamp01(state.held / 4);
    },
  },
];

export interface TutorialView {
  title: string;
  instruction: string;
  why: string;
  progress: number;
  index: number;
  total: number;
  complete: boolean;
}

export class Tutorial {
  index = 0;
  complete = false;
  /** Fires whenever a step is finished, for audio and toasts. */
  onStepComplete: ((step: TutorialStep) => void) | null = null;

  private state: StepState = { held: 0, flag: 0, progress: 0 };
  private settle = 0;

  reset(): void {
    this.index = 0;
    this.complete = false;
    this.state = { held: 0, flag: 0, progress: 0 };
    this.settle = 0;
  }

  update(ctx: TutorialContext): TutorialView {
    if (this.complete) return this.view(1);

    // A short pause after each step so the player reads the next one before it
    // starts judging them.
    if (this.settle > 0) {
      this.settle -= ctx.dt;
      return this.view(0);
    }

    const step = TUTORIAL_STEPS[this.index];
    const progress = clamp01(step.advance(ctx, this.state));
    this.state.progress = progress;

    if (progress >= 1) {
      this.onStepComplete?.(step);
      this.state = { held: 0, flag: 0, progress: 0 };
      this.settle = 1.4;
      if (this.index >= TUTORIAL_STEPS.length - 1) {
        this.complete = true;
        return this.view(1);
      }
      this.index++;
      return this.view(0);
    }

    return this.view(progress);
  }

  private view(progress: number): TutorialView {
    const step = TUTORIAL_STEPS[Math.min(this.index, TUTORIAL_STEPS.length - 1)];
    return {
      title: this.complete ? 'That is riding' : step.title,
      instruction: this.complete
        ? 'You know enough to be dangerous. Go and use it.'
        : step.instruction,
      why: this.complete ? '' : step.why,
      progress,
      index: this.index,
      total: TUTORIAL_STEPS.length,
      complete: this.complete,
    };
  }
}
