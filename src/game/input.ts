import { clamp, clamp01, damp } from '../core/math.ts';
import { neutralInput, type RiderInput } from '../physics/riderSim.ts';
import { grabsFor, type GrabSpec } from '../physics/grabs.ts';
import type { Discipline } from '../physics/gear.ts';

export type UiAction = 'reset' | 'camera' | 'pause' | 'replay' | 'photo';

export interface InputSettings {
  /** Screen pixels of drag that equal full lean. */
  gestureSensitivity: number;
  invertAirPitch: boolean;
  /** Which eight grabs sit on the radial, in clock order from up. */
  grabWheel: string[];
  keyboard: Record<string, string>;
}

export function defaultKeymap(): Record<string, string> {
  return {
    KeyA: 'leanLeft',
    ArrowLeft: 'leanLeft',
    KeyD: 'leanRight',
    ArrowRight: 'leanRight',
    KeyW: 'weightNose',
    ArrowUp: 'weightNose',
    KeyS: 'weightTail',
    ArrowDown: 'weightTail',
    Space: 'crouch',
    ShiftLeft: 'tuck',
    KeyQ: 'twistLeft',
    KeyE: 'twistRight',
    KeyZ: 'grab1',
    KeyX: 'grab2',
    KeyC: 'grab3',
    KeyV: 'grab4',
    KeyF: 'grab5',
    KeyG: 'grab6',
    KeyR: 'reset',
    KeyT: 'camera',
    KeyP: 'photo',
    Escape: 'pause',
  };
}

export function defaultInputSettings(discipline: Discipline): InputSettings {
  const wheel = grabsFor(discipline).slice(0, 8).map((g) => g.id);
  return {
    gestureSensitivity: 110,
    invertAirPitch: false,
    grabWheel: wheel,
    keyboard: defaultKeymap(),
  };
}

interface Pointer {
  id: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
  startTime: number;
  /** Fastest upward speed seen, px/s. A hard flick up is a pop. */
  flickUp: number;
  lastY: number;
  lastTime: number;
  role: 'steer' | 'grab';
}

/**
 * Turns keyboard, gamepad and touch into rider input.
 *
 * The touch scheme is the one that matters on a phone: your steering thumb sets
 * an origin wherever it lands, so there is no fixed on-screen stick to miss, and
 * the same drag means lean on the ground and rotation in the air. The second
 * thumb is grabs, chosen radially, so you never take a hand off to hunt a button.
 */
export class InputManager {
  readonly input: RiderInput = neutralInput();
  settings: InputSettings;
  discipline: Discipline;
  /** Drained by the app each frame. */
  readonly actions: UiAction[] = [];
  /** True when the player is steering with touch, so the HUD can show the ring. */
  touchActive = false;
  touchOriginX = 0;
  touchOriginY = 0;
  touchX = 0;
  touchY = 0;
  grabWheelAngle: number | null = null;

  private keys = new Set<string>();
  private pointers = new Map<number, Pointer>();
  private steerPointer: Pointer | null = null;
  private grabPointer: Pointer | null = null;
  private popRequest = 0;
  private airborne = false;
  private detach: Array<() => void> = [];
  private grabList: GrabSpec[];

  // Smoothed axes so keyboard input does not feel like a switch.
  private leanAxis = 0;
  private weightAxis = 0;
  private twistAxis = 0;
  private crouchAxis = 0;

  constructor(target: HTMLElement, discipline: Discipline, settings?: InputSettings) {
    this.discipline = discipline;
    this.settings = settings ?? defaultInputSettings(discipline);
    this.grabList = grabsFor(discipline);
    this.attach(target);
  }

  setDiscipline(discipline: Discipline): void {
    this.discipline = discipline;
    this.grabList = grabsFor(discipline);
    this.settings.grabWheel = this.grabList.slice(0, 8).map((g) => g.id);
  }

  dispose(): void {
    for (const off of this.detach) off();
    this.detach = [];
  }

  private attach(target: HTMLElement): void {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const action = this.settings.keyboard[e.code];
      if (!action) return;
      e.preventDefault();
      if (action === 'reset') this.actions.push('reset');
      else if (action === 'camera') this.actions.push('camera');
      else if (action === 'pause') this.actions.push('pause');
      else if (action === 'photo') this.actions.push('photo');
      else this.keys.add(action);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      const action = this.settings.keyboard[e.code];
      if (!action) return;
      if (action === 'crouch' && this.keys.has('crouch')) this.popRequest = 1;
      this.keys.delete(action);
    };
    const onBlur = () => {
      this.keys.clear();
      this.pointers.clear();
      this.steerPointer = null;
      this.grabPointer = null;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      target.setPointerCapture?.(e.pointerId);
      const role: Pointer['role'] = this.steerPointer ? 'grab' : 'steer';
      const p: Pointer = {
        id: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        x: e.clientX,
        y: e.clientY,
        startTime: performance.now(),
        flickUp: 0,
        lastY: e.clientY,
        lastTime: performance.now(),
        role,
      };
      this.pointers.set(e.pointerId, p);
      if (role === 'steer') {
        this.steerPointer = p;
        this.touchActive = true;
        this.touchOriginX = e.clientX;
        this.touchOriginY = e.clientY;
        this.touchX = e.clientX;
        this.touchY = e.clientY;
      } else {
        this.grabPointer = p;
      }
    };

    const onPointerMove = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const now = performance.now();
      const dtMs = Math.max(1, now - p.lastTime);
      const upSpeed = ((p.lastY - e.clientY) / dtMs) * 1000;
      if (upSpeed > p.flickUp) p.flickUp = upSpeed;
      p.lastY = e.clientY;
      p.lastTime = now;
      p.x = e.clientX;
      p.y = e.clientY;
      if (p === this.steerPointer) {
        this.touchX = e.clientX;
        this.touchY = e.clientY;
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      this.pointers.delete(e.pointerId);
      if (p === this.steerPointer) {
        // Releasing a loaded stance pops; flicking up pops harder.
        if (this.crouchAxis > 0.25 || p.flickUp > 700) this.popRequest = 1;
        this.steerPointer = null;
        this.touchActive = false;
        // Promote a second finger to steering so the controls do not die.
        for (const other of this.pointers.values()) {
          if (other.role === 'grab') {
            other.role = 'steer';
            other.startX = other.x;
            other.startY = other.y;
            this.steerPointer = other;
            this.grabPointer = null;
            this.touchActive = true;
            this.touchOriginX = other.x;
            this.touchOriginY = other.y;
            break;
          }
        }
      }
      if (p === this.grabPointer) this.grabPointer = null;
    };

    const opts = { passive: false } as AddEventListenerOptions;
    window.addEventListener('keydown', onKeyDown, opts);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    target.addEventListener('pointerdown', onPointerDown, opts);
    target.addEventListener('pointermove', onPointerMove, opts);
    target.addEventListener('pointerup', onPointerUp);
    target.addEventListener('pointercancel', onPointerUp);
    target.addEventListener('contextmenu', (e) => e.preventDefault());

    this.detach.push(
      () => window.removeEventListener('keydown', onKeyDown, opts),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('blur', onBlur),
      () => target.removeEventListener('pointerdown', onPointerDown, opts),
      () => target.removeEventListener('pointermove', onPointerMove, opts),
      () => target.removeEventListener('pointerup', onPointerUp),
      () => target.removeEventListener('pointercancel', onPointerUp),
    );
  }

  /** Rebuilds the rider input. `airborne` switches the drag mapping. */
  update(dt: number, airborne: boolean): RiderInput {
    this.airborne = airborne;
    const i = this.input;

    let leanTarget = 0;
    let weightTarget = 0;
    let twistTarget = 0;
    let crouchTarget = 0;
    let tuck = 0;
    let grab: string | null = null;
    let airYaw = 0;
    let airPitch = 0;
    let airRoll = 0;

    // --- Keyboard ---
    if (this.keys.has('leanLeft')) leanTarget -= 1;
    if (this.keys.has('leanRight')) leanTarget += 1;
    if (this.keys.has('weightNose')) weightTarget += 1;
    if (this.keys.has('weightTail')) weightTarget -= 1;
    if (this.keys.has('twistLeft')) twistTarget -= 1;
    if (this.keys.has('twistRight')) twistTarget += 1;
    if (this.keys.has('crouch')) crouchTarget = 1;
    if (this.keys.has('tuck')) tuck = 1;
    for (let n = 1; n <= 8; n++) {
      if (this.keys.has(`grab${n}`)) {
        grab = this.settings.grabWheel[n - 1] ?? null;
        break;
      }
    }

    // --- Gamepad ---
    const pad = this.readGamepad();
    if (pad) {
      leanTarget = clamp(leanTarget + pad.leftX, -1, 1);
      weightTarget = clamp(weightTarget - pad.leftY, -1, 1);
      twistTarget = clamp(twistTarget + pad.twist, -1, 1);
      crouchTarget = Math.max(crouchTarget, pad.crouch);
      tuck = Math.max(tuck, pad.tuck);
      if (pad.grabIndex >= 0) grab = this.settings.grabWheel[pad.grabIndex] ?? grab;
      airYaw += pad.rightX;
      airPitch += pad.rightY;
    }

    // --- Touch ---
    if (this.steerPointer) {
      const s = this.settings.gestureSensitivity;
      const dx = clamp((this.steerPointer.x - this.steerPointer.startX) / s, -1, 1);
      const dy = clamp((this.steerPointer.y - this.steerPointer.startY) / s, -1, 1);
      if (airborne) {
        // In the air the same drag becomes rotation.
        airYaw += dx;
        airPitch += this.settings.invertAirPitch ? -dy : dy;
      } else {
        leanTarget = clamp(leanTarget + dx, -1, 1);
        // Dragging down loads the legs; dragging up unweights.
        crouchTarget = Math.max(crouchTarget, clamp01(dy));
        weightTarget = clamp(weightTarget - Math.max(0, -dy) * 0.8, -1, 1);
      }
      // A twist of the steering thumb past the edge winds up rotation.
      if (!airborne && Math.abs(dx) > 0.92) twistTarget = clamp(twistTarget + Math.sign(dx), -1, 1);
    }

    if (this.grabPointer) {
      const dx = this.grabPointer.x - this.grabPointer.startX;
      const dy = this.grabPointer.y - this.grabPointer.startY;
      const dist = Math.hypot(dx, dy);
      // A tap with no direction takes the first grab; a drag picks radially.
      const angle = dist > 18 ? Math.atan2(dx, -dy) : 0;
      this.grabWheelAngle = dist > 18 ? angle : 0;
      const sector = Math.round(((angle + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
      grab = this.settings.grabWheel[sector] ?? this.settings.grabWheel[0] ?? grab;
    } else {
      this.grabWheelAngle = null;
    }

    // Grabbing pulls you in even without an explicit tuck.
    if (grab) tuck = Math.max(tuck, 0.35);

    // --- Smoothing ---
    this.leanAxis = damp(this.leanAxis, leanTarget, 16, dt);
    this.weightAxis = damp(this.weightAxis, weightTarget, 12, dt);
    this.twistAxis = damp(this.twistAxis, twistTarget, 14, dt);
    // Loading is fast, releasing is instant — that is what makes a pop snap.
    this.crouchAxis =
      crouchTarget > this.crouchAxis ? damp(this.crouchAxis, crouchTarget, 22, dt) : crouchTarget;

    if (this.popRequest > 0) {
      this.crouchAxis = 0;
      this.popRequest = Math.max(0, this.popRequest - dt * 12);
    }

    i.lean = this.leanAxis;
    i.weight = this.weightAxis;
    i.twist = this.twistAxis;
    i.crouch = this.crouchAxis;
    i.tuck = clamp01(tuck);
    i.grab = grab;
    i.airYaw = clamp(airYaw, -1, 1);
    i.airPitch = clamp(airPitch, -1, 1);
    i.airRoll = clamp(airRoll + this.twistAxis * (airborne ? 0.6 : 0), -1, 1);
    i.grind = this.crouchAxis < 0.5;
    return i;
  }

  /** Grabs currently reachable, for drawing the radial menu. */
  get wheelGrabs(): GrabSpec[] {
    return this.settings.grabWheel
      .map((id) => this.grabList.find((g) => g.id === id))
      .filter((g): g is GrabSpec => !!g);
  }

  get isAirborne(): boolean {
    return this.airborne;
  }

  private readGamepad(): {
    leftX: number;
    leftY: number;
    rightX: number;
    rightY: number;
    twist: number;
    crouch: number;
    tuck: number;
    grabIndex: number;
  } | null {
    const pads = navigator.getGamepads?.();
    if (!pads) return null;
    const pad = Array.from(pads).find((p) => p && p.connected);
    if (!pad) return null;
    const dead = (v: number) => (Math.abs(v) < 0.14 ? 0 : v);
    const axes = pad.axes;
    const buttons = pad.buttons;
    const btn = (n: number) => (buttons[n]?.pressed ? 1 : 0);
    const trig = (n: number) => buttons[n]?.value ?? 0;

    let grabIndex = -1;
    // Face buttons and bumpers cover the first six grabs.
    for (let i = 0; i < 6; i++) {
      if (btn(i)) {
        grabIndex = i;
        break;
      }
    }
    return {
      leftX: dead(axes[0] ?? 0),
      leftY: dead(axes[1] ?? 0),
      rightX: dead(axes[2] ?? 0),
      rightY: dead(axes[3] ?? 0),
      twist: trig(7) - trig(6),
      crouch: trig(7),
      tuck: trig(6),
      grabIndex,
    };
  }
}
