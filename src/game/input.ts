import { clamp, clamp01, damp } from '../core/math.ts';
import { neutralInput, type RiderInput } from '../physics/riderSim.ts';
import { grabsFor, type GrabSpec } from '../physics/grabs.ts';
import type { Discipline } from '../physics/gear.ts';

export type UiAction = 'reset' | 'camera' | 'pause' | 'replay' | 'photo' | 'debug';

export interface InputSettings {
  /** Screen pixels of drag that equal full lean. */
  gestureSensitivity: number;
  invertAirPitch: boolean;
  /** Which eight grabs sit on the radial, in clock order from up. */
  grabWheel: string[];
  keyboard: Record<string, string>;
}

/**
 * How long a press of the jump key loads the legs before it fires.
 *
 * Measured, not guessed. The leg is an internal spring the sim integrates at
 * 1920 Hz, so it takes real time to physically compress — far longer than the
 * command axis takes to reach 1. Sweeping the hold on flat groomed snow gives
 * the air each load buys:
 *
 *     40 ms -> 0.000 s    240 ms -> 0.192 s    360 ms -> 0.558 s
 *    160 ms -> 0.117 s    280 ms -> 0.408 s    420 ms -> 0.575 s
 *    200 ms -> 0.158 s    320 ms -> 0.550 s    650 ms -> 0.550 s
 *
 * The knee is at 320 ms and it plateaus after. So that is the floor: a tap of
 * Space buys the same jump a well-timed hold does, because anything less is a
 * spring released before it compressed. It reads as a wind-up rather than as
 * lag because the rider visibly crouches through it.
 *
 * It is a floor, not a fixed cost — hold the key and the load keeps building
 * past it, and releasing after that pops on the frame you release, so timing a
 * pop off a lip is unchanged.
 */
const JUMP_MIN_LOAD = 0.32;

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
    // Grabs sit on both the number row and the bottom row. The numbers are
    // where anyone coming from another snow game will reach first; the letters
    // are where a hand already on WASD can get to without moving. Neither is
    // the "real" binding and removing either would cost somebody their muscle
    // memory for nothing.
    Digit1: 'grab1',
    Digit2: 'grab2',
    Digit3: 'grab3',
    Digit4: 'grab4',
    Digit5: 'grab5',
    Digit6: 'grab6',
    KeyZ: 'grab1',
    KeyX: 'grab2',
    KeyC: 'grab3',
    KeyV: 'grab4',
    KeyG: 'grab5',
    KeyH: 'grab6',
    KeyF: 'plant',
    KeyR: 'reset',
    KeyT: 'camera',
    KeyP: 'photo',
    Backquote: 'debug',
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
  /**
   * Seconds the jump key has been loading, or -1 when it is not.
   *
   * Space is a jump button. It was not one: the leg spring loads while the key
   * is down and fires when it is released, so a *tap* released the spring
   * before it had compressed and produced nothing at all. Measured on flat
   * groomed snow at 1/120 — 40 ms of Space bought 0.000 s of air, 80 ms bought
   * 0.042 s, and it took 300 ms of hold-then-release to get a real 0.55 s
   * jump. A jump button that does nothing unless you know to hold it for a
   * third of a second is not a jump button.
   *
   * So a press now guarantees the load completes. Let go early and the loading
   * keeps running to JUMP_MIN_LOAD before it pops, which is the difference
   * between "Space jumps" and "Space jumps if you hold it right". Hold longer
   * and nothing changes from before: the load keeps building and fires the
   * moment you release, so absorbing a transition and popping off the lip is
   * the same technique it always was, and holding it down still just leaves
   * you crouched.
   */
  private jumpLoad = -1;
  private jumpHeld = false;
  private airborne = false;
  private detach: Array<() => void> = [];
  private grabList: GrabSpec[];

  // Smoothed axes so keyboard input does not feel like a switch.
  private leanAxis = 0;
  private weightAxis = 0;
  private twistAxis = 0;
  private crouchAxis = 0;
  // The air axes get the same treatment, and the same constants as the ground
  // axis each one replaces. A binary key must not read like a stick slammed to
  // the stop.
  private airYawAxis = 0;
  private airPitchAxis = 0;
  private airRollAxis = 0;

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

  /**
   * True when the keystroke belongs to something the player is typing into.
   *
   * The rider controls are bound to plain letters, and the handler calls
   * `preventDefault` on every key it recognises so the page does not scroll when
   * you steer. Bound to `window` with no check for what has focus, that also
   * suppresses character insertion — which meant a, c, d, e, f, g, h, p, q, r,
   * s, t, v, w, x, z and space could not be typed into the level name, the rider
   * name, a room name or the share-code box, and Escape paused the game instead
   * of leaving the field.
   */
  private static isTyping(e: Event): boolean {
    const el = e.target as (Element & { isContentEditable?: boolean }) | null;
    if (!el || typeof (el as Element).closest !== 'function') return false;
    if (el.isContentEditable) return true;
    return !!el.closest('input, textarea, select, [contenteditable]');
  }

  private attach(target: HTMLElement): void {
    const onKeyDown = (e: KeyboardEvent) => {
      if (InputManager.isTyping(e)) return;
      if (e.repeat) return;
      const action = this.settings.keyboard[e.code];
      if (!action) return;
      e.preventDefault();
      if (action === 'reset') this.actions.push('reset');
      else if (action === 'camera') this.actions.push('camera');
      else if (action === 'pause') this.actions.push('pause');
      else if (action === 'photo') this.actions.push('photo');
      else if (action === 'debug') this.actions.push('debug');
      else {
        if (action === 'crouch' && !this.keys.has('crouch')) {
          this.jumpLoad = 0;
          this.jumpHeld = true;
        }
        this.keys.add(action);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (InputManager.isTyping(e)) return;
      const action = this.settings.keyboard[e.code];
      if (!action) return;
      // Releasing the jump key does not pop by itself any more — it hands over
      // to the loader in update(), which pops as soon as the load is deep
      // enough. Past that depth "as soon as" is this frame, so a hold and
      // release still fires exactly when the key comes up.
      if (action === 'crouch' && this.keys.has('crouch')) this.jumpHeld = false;
      this.keys.delete(action);
    };
    const onBlur = () => {
      this.keys.clear();
      this.pointers.clear();
      this.steerPointer = null;
      this.grabPointer = null;
    };
    // Clicking into a field mid-input would otherwise leave whatever was held
    // down held forever: the key-up lands on the field and is ignored above.
    const onFocusIn = (e: Event) => {
      if (InputManager.isTyping(e)) this.keys.clear();
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
    window.addEventListener('focusin', onFocusIn);
    target.addEventListener('pointerdown', onPointerDown, opts);
    target.addEventListener('pointermove', onPointerMove, opts);
    target.addEventListener('pointerup', onPointerUp);
    target.addEventListener('pointercancel', onPointerUp);
    target.addEventListener('contextmenu', (e) => e.preventDefault());

    this.detach.push(
      () => window.removeEventListener('keydown', onKeyDown, opts),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('blur', onBlur),
      () => window.removeEventListener('focusin', onFocusIn),
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
    let plant = 0;
    let airYaw = 0;
    let airPitch = 0;
    let airRoll = 0;

    // --- Keyboard ---
    //
    // The same three key pairs mean different things depending on whether the
    // gear is on the snow, and that is the whole point. Grounded they lean,
    // weight and twist exactly as they always have. Airborne they drive yaw,
    // pitch and roll — the three independent rotation axes the game is built
    // around, and which the keyboard previously had no access to at all. A
    // keyboard player could wind a spin up on the ground and ride it out
    // ballistically, but could not start, steer, tighten or correct a rotation
    // once the skis left the snow. Gamepad and touch could.
    //
    // One branch, not two copies: the raw key state is read once and routed.
    const kbLean = (this.keys.has('leanRight') ? 1 : 0) - (this.keys.has('leanLeft') ? 1 : 0);
    const kbWeight = (this.keys.has('weightNose') ? 1 : 0) - (this.keys.has('weightTail') ? 1 : 0);
    const kbTwist = (this.keys.has('twistRight') ? 1 : 0) - (this.keys.has('twistLeft') ? 1 : 0);

    let kbAirYaw = 0;
    let kbAirPitch = 0;
    let kbAirRoll = 0;
    if (airborne) {
      kbAirYaw = kbLean;
      // Tail-weight keys rotate front, nose-weight keys rotate back, which is
      // the same sense as dragging a thumb down the screen.
      kbAirPitch = this.settings.invertAirPitch ? kbWeight : -kbWeight;
      kbAirRoll = kbTwist;
    } else {
      leanTarget += kbLean;
      weightTarget += kbWeight;
      twistTarget += kbTwist;
    }

    // The jump loader. Runs while a press is loading, whether or not the key is
    // still down, and fires once the legs are compressed enough to be worth
    // releasing. A held key never reaches the release branch, so holding still
    // means staying crouched.
    if (this.jumpLoad >= 0) {
      crouchTarget = 1;
      this.jumpLoad += dt;
      if (!this.jumpHeld && this.jumpLoad >= JUMP_MIN_LOAD) {
        this.popRequest = 1;
        this.jumpLoad = -1;
      }
    }
    if (this.keys.has('crouch')) crouchTarget = 1;
    if (this.keys.has('tuck')) tuck = 1;
    if (this.keys.has('plant')) plant = 1;
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
      plant = Math.max(plant, pad.plant);
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
    this.airYawAxis = damp(this.airYawAxis, kbAirYaw, 16, dt);
    this.airPitchAxis = damp(this.airPitchAxis, kbAirPitch, 12, dt);
    this.airRollAxis = damp(this.airRollAxis, kbAirRoll, 14, dt);
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
    i.airYaw = clamp(airYaw + this.airYawAxis, -1, 1);
    i.airPitch = clamp(airPitch + this.airPitchAxis, -1, 1);
    i.airRoll = clamp(airRoll + this.airRollAxis + this.twistAxis * (airborne ? 0.6 : 0), -1, 1);
    i.grind = this.crouchAxis < 0.5;
    i.plant = clamp01(plant);
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
    plant: number;
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
    // Face buttons cover the first four grabs; the bumpers are poling and tuck.
    for (let i = 0; i < 4; i++) {
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
      // Left bumper: the hand that is already free.
      plant: btn(4),
      grabIndex,
    };
  }
}
