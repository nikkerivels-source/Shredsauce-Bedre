import { clamp01 } from '../core/math.ts';
import type { Telemetry } from '../physics/riderSim.ts';
import type { TrickResult } from '../game/tricks.ts';
import type { Challenge, GameMode, SessionSummary } from '../game/session.ts';
import type { TutorialView } from '../game/tutorial.ts';
import { clear, el, formatScore, formatTime } from './dom.ts';

interface Popup {
  node: HTMLElement;
  life: number;
}

/**
 * In-run overlay.
 *
 * Everything shown here is read straight off the solver — the speedo is real
 * m/s, the edge-angle arc is the actual angle the gear is on, and the grip bar
 * is the measured lateral load. It doubles as a readout of what the physics is
 * doing, which is how you learn to carve rather than just steer.
 */
export class Hud {
  readonly root: HTMLElement;
  private speedValue: HTMLElement;
  private speedUnit: HTMLElement;
  private scoreValue: HTMLElement;
  private comboValue: HTMLElement;
  private timerValue: HTMLElement;
  private timerLabel: HTMLElement;
  private gripFill: HTMLElement;
  private edgeArc: SVGPathElement;
  private edgeText: HTMLElement;
  private airBadge: HTMLElement;
  private balanceWrap: HTMLElement;
  private balanceFill: HTMLElement;
  private popupHost: HTMLElement;
  private bailBanner: HTMLElement;
  private challengeList: HTMLElement;
  private gateCounter: HTMLElement;
  private touchRing: HTMLElement;
  private liveTrick: HTMLElement;
  private speedVeil: HTMLElement;
  private coach: HTMLElement;
  private coachStep: HTMLElement;
  private coachTitle: HTMLElement;
  private coachText: HTMLElement;
  private coachWhy: HTMLElement;
  private coachFill: HTMLElement;
  private popups: Popup[] = [];
  private bailTimer = 0;
  private liveTrickTimer = 0;
  private debugPanel: HTMLElement;
  private debugOn = false;

  constructor() {
    this.speedValue = el('span', { class: 'speed-value' }, ['0']);
    this.speedUnit = el('span', { class: 'speed-unit' }, ['km/h']);

    this.scoreValue = el('span', { class: 'score-value' }, ['0']);
    this.comboValue = el('span', { class: 'combo' }, ['']);
    this.timerValue = el('span', { class: 'timer-value' }, ['0:00.0']);
    this.timerLabel = el('span', { class: 'readout-label' }, ['Time']);

    this.gripFill = el('div', { class: 'grip-fill' });
    this.edgeText = el('div', { class: 'edge-text' }, ['0°']);
    this.airBadge = el('div', { class: 'air-badge' }, ['']);
    this.balanceFill = el('div', { class: 'balance-fill' });
    this.balanceWrap = el('div', { class: 'balance' }, [
      el('div', { class: 'balance-track' }, [this.balanceFill]),
      el('div', { class: 'balance-label' }, ['BALANCE']),
    ]);
    this.popupHost = el('div', { class: 'popups' });
    this.bailBanner = el('div', { class: 'bail-banner' });
    this.challengeList = el('div', { class: 'challenges' });
    this.gateCounter = el('div', { class: 'gates' });
    this.touchRing = el('div', { class: 'touch-ring' });
    this.liveTrick = el('div', { class: 'live-trick' });
    this.speedVeil = el('div', { class: 'speed-veil' });

    this.coachStep = el('div', { class: 'coach-step' });
    this.coachTitle = el('div', { class: 'coach-title' });
    this.coachText = el('div', { class: 'coach-text' });
    this.coachWhy = el('div', { class: 'coach-why' });
    this.coachFill = el('div', { class: 'coach-fill' });
    this.coach = el('div', { class: 'coach' }, [
      this.coachStep,
      this.coachTitle,
      this.coachText,
      this.coachWhy,
      el('div', { class: 'coach-track' }, [this.coachFill]),
    ]);
    this.coach.style.display = 'none';

    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 120 70');
    svg.setAttribute('class', 'edge-gauge');
    const track = document.createElementNS(svgNs, 'path');
    track.setAttribute('d', arcPath(-70, 70));
    track.setAttribute('class', 'edge-track');
    this.edgeArc = document.createElementNS(svgNs, 'path');
    this.edgeArc.setAttribute('class', 'edge-fill');
    svg.append(track, this.edgeArc);

    // No boxes. Readouts sit directly on the mountain over soft scrims, the way
    // a broadcast overlay does — a grey rounded rectangle behind every number
    // is the fastest way to make a game look like a web page.
    // Tuning instrument, not part of the HUD design. The spec is right that the
    // ground physics cannot be tuned without one.
    this.debugPanel = el('pre', { class: 'debug-panel' }, ['']);
    this.debugPanel.style.display = 'none';

    this.root = el('div', { class: 'hud' }, [
      this.debugPanel,
      el('div', { class: 'scrim scrim-top' }),
      el('div', { class: 'scrim scrim-bottom' }),
      el('div', { class: 'hud-top' }, [
        el('div', { class: 'readout score-readout' }, [
          el('div', { class: 'readout-label' }, ['Score']),
          el('div', { class: 'readout-line' }, [this.scoreValue, this.comboValue]),
        ]),
        el('div', { class: 'readout timer-readout' }, [
          this.timerLabel,
          this.timerValue,
          this.gateCounter,
        ]),
      ]),
      this.challengeList,
      this.popupHost,
      this.liveTrick,
      this.bailBanner,
      el('div', { class: 'hud-bottom' }, [
        el('div', { class: 'speedo' }, [
          el('div', { class: 'speedo-line' }, [this.speedValue, this.speedUnit]),
          el('div', { class: 'grip-track' }, [this.gripFill]),
        ]),
        el('div', { class: 'edge-readout' }, [
          svg,
          this.edgeText,
          el('div', { class: 'readout-label' }, ['Edge']),
        ]),
      ]),
      this.airBadge,
      this.balanceWrap,
      this.touchRing,
      this.coach,
      this.speedVeil,
    ]);
    this.balanceWrap.style.display = 'none';
    this.touchRing.style.display = 'none';
  }

  setVisible(visible: boolean): void {
    this.root.style.display = visible ? '' : 'none';
  }

  /** Refreshes the numeric readouts. */
  /** Flips the tuning overlay. Returns the new state so the caller can say so. */
  toggleDebug(): boolean {
    this.debugOn = !this.debugOn;
    this.debugPanel.style.display = this.debugOn ? '' : 'none';
    return this.debugOn;
  }

  /**
   * State and time-in-state answer "why is it doing that". The last transition
   * answers "how did it get here", which eight scattered assignment sites used
   * to make unanswerable. Speed is in m/s as well as km/h because every target
   * in the spec is stated in m/s.
   */
  private drawDebug(t: Telemetry, combo: number): void {
    this.debugPanel.textContent = [
      `state     ${t.state}  (${t.stateTime.toFixed(2)}s)`,
      `from      ${t.lastTransition}`,
      `speed     ${t.speed.toFixed(1)} m/s   ${Math.round(t.speed * 3.6)} km/h`,
      `switch    ${t.switchStance ? 'yes' : 'no'}`,
      `spin      ${t.spinDeg.toFixed(0)}deg   rate ${t.spinRate.toFixed(0)}deg/s`,
      `tilt      ${t.tiltDeg.toFixed(0)}deg off vertical`,
      `air       ${t.airTime.toFixed(2)}s   alt ${t.altitude.toFixed(2)}m`,
      `edge      ${t.edgeAngle.toFixed(0)}deg  slip ${t.slipAngle.toFixed(0)}deg  carve ${t.carveQuality.toFixed(2)}`,
      `g         ${t.gForce.toFixed(2)}   leg ${(t.legForce / 1000).toFixed(1)}kN`,
      `combo     x${combo}`,
    ].join('\n');
  }

  update(
    dt: number,
    telemetry: Telemetry,
    summary: SessionSummary,
    mode: GameMode,
    timeRemaining: number,
    combo: number,
  ): void {
    if (this.debugOn) this.drawDebug(telemetry, combo);

    this.speedValue.textContent = Math.round(telemetry.speed * 3.6).toString();

    // Edges close in above about 45 km/h. It is a cheap effect but it is the
    // difference between reading fast and merely being fast.
    const rush = clamp01((telemetry.speed - 12) / 20);
    this.speedVeil.style.opacity = (rush * 0.75).toFixed(3);

    this.scoreValue.textContent = formatScore(summary.score);
    if (combo > 1.01) {
      this.comboValue.textContent = `${combo.toFixed(1)}x`;
      this.comboValue.classList.add('on');
    } else {
      this.comboValue.textContent = '';
      this.comboValue.classList.remove('on');
    }

    if (mode === 'freeride') {
      this.timerLabel.textContent = 'Time';
      this.timerValue.textContent = formatTime(summary.elapsed);
    } else if (Number.isFinite(timeRemaining)) {
      this.timerLabel.textContent = 'Left';
      this.timerValue.textContent = formatTime(timeRemaining);
      this.timerValue.classList.toggle('urgent', timeRemaining < 15);
    } else {
      this.timerLabel.textContent = 'Time';
      this.timerValue.textContent = formatTime(summary.elapsed);
    }

    if (summary.gatesTotal > 0) {
      this.gateCounter.textContent = `${summary.gatesHit}/${summary.gatesTotal} gates`;
      this.gateCounter.style.display = '';
    } else {
      this.gateCounter.style.display = 'none';
    }

    // Grip: lateral load, where 1.5 g is about the limit of a good edge.
    const grip = clamp01(telemetry.lateralG / 1.5);
    this.gripFill.style.transform = `scaleX(${grip.toFixed(3)})`;
    this.gripFill.classList.toggle('slipping', telemetry.carveQuality < 0.35 && telemetry.speed > 4);

    const edge = Math.max(-70, Math.min(70, telemetry.edgeAngle));
    this.edgeArc.setAttribute('d', edge >= 0 ? arcPath(0, edge) : arcPath(edge, 0));
    this.edgeText.textContent = `${Math.round(Math.abs(edge))}°`;
    this.edgeText.classList.toggle('carving', telemetry.carveQuality > 0.75 && Math.abs(edge) > 12);

    if (telemetry.airborne) {
      this.airBadge.style.display = '';
      this.airBadge.textContent = `${telemetry.altitude.toFixed(1)} m · ${telemetry.airTime.toFixed(1)} s`;
    } else {
      this.airBadge.style.display = 'none';
    }

    if (telemetry.grindSurfaceId) {
      this.balanceWrap.style.display = '';
      const b = Math.max(-1, Math.min(1, telemetry.grindBalance));
      this.balanceFill.style.transform = `translateX(${(b * 50).toFixed(1)}%)`;
      this.balanceFill.classList.toggle('danger', Math.abs(b) > 0.65);
    } else {
      this.balanceWrap.style.display = 'none';
    }

    if (this.liveTrickTimer > 0) {
      this.liveTrickTimer -= dt;
      if (this.liveTrickTimer <= 0) this.liveTrick.textContent = '';
    }

    if (this.bailTimer > 0) {
      this.bailTimer -= dt;
      if (this.bailTimer <= 0) this.bailBanner.classList.remove('on');
    }

    for (const popup of [...this.popups]) {
      popup.life -= dt;
      if (popup.life <= 0) {
        popup.node.remove();
        this.popups = this.popups.filter((p) => p !== popup);
      } else if (popup.life < 0.45) {
        popup.node.style.opacity = (popup.life / 0.45).toFixed(2);
      }
    }
  }

  /** Live readout of the rotation as it happens, before the trick is named. */
  showLiveRotation(spinDegrees: number, inverted: boolean): void {
    if (spinDegrees < 90) {
      this.liveTrick.textContent = '';
      return;
    }
    const rounded = Math.round(spinDegrees / 90) * 90;
    this.liveTrick.textContent = inverted ? `${rounded}° · off axis` : `${rounded}°`;
    this.liveTrickTimer = 0.4;
  }

  pushTrick(trick: TrickResult): void {
    if (!trick.landed) {
      this.showBail(trick.bailReason ?? 'bailed');
      return;
    }
    const node = el('div', { class: 'popup' }, [
      el('div', { class: 'popup-name' }, [trick.name.toUpperCase()]),
      el('div', { class: 'popup-points' }, [
        `+${formatScore(trick.points)}`,
        trick.multiplier > 1.01 ? el('span', { class: 'popup-mult' }, [` ${trick.multiplier.toFixed(1)}x`]) : null,
      ]),
      el('div', { class: 'popup-quality' }, [qualityWord(trick.quality)]),
    ]);
    this.popupHost.prepend(node);
    this.popups.push({ node, life: 2.6 });
    while (this.popups.length > 5) {
      const oldest = this.popups.shift();
      oldest?.node.remove();
    }
  }

  showBail(reason: string): void {
    this.bailBanner.textContent = reason.toUpperCase();
    this.bailBanner.classList.add('on');
    this.bailTimer = 1.8;
  }

  showMessage(message: string): void {
    const node = el('div', { class: 'popup message' }, [message]);
    this.popupHost.prepend(node);
    this.popups.push({ node, life: 3 });
  }

  setChallenges(challenges: Challenge[]): void {
    clear(this.challengeList);
    if (challenges.length === 0) {
      this.challengeList.style.display = 'none';
      return;
    }
    this.challengeList.style.display = '';
    this.challengeList.append(el('div', { class: 'challenges-title' }, ['OBJECTIVES']));
    for (const c of challenges) {
      this.challengeList.append(
        el('div', { class: 'challenge' }, [
          el('span', { class: 'challenge-name' }, [c.name]),
          el('span', { class: 'challenge-desc' }, [c.description]),
        ]),
      );
    }
  }

  /** Shows the current tutorial step, or hides the panel when there is none. */
  setTutorial(view: TutorialView | null): void {
    if (!view) {
      this.coach.style.display = 'none';
      return;
    }
    this.coach.style.display = '';
    this.coach.classList.toggle('done', view.complete);
    this.coachStep.textContent = view.complete ? 'COMPLETE' : `STEP ${view.index + 1} OF ${view.total}`;
    this.coachTitle.textContent = view.title;
    this.coachText.textContent = view.instruction;
    this.coachWhy.textContent = view.why;
    this.coachFill.style.transform = `scaleX(${view.progress.toFixed(3)})`;
  }

  /** Draws the touch origin ring so the player can see their steering deadzone. */
  setTouchRing(active: boolean, originX: number, originY: number, x: number, y: number): void {
    if (!active) {
      this.touchRing.style.display = 'none';
      return;
    }
    this.touchRing.style.display = '';
    this.touchRing.style.left = `${originX}px`;
    this.touchRing.style.top = `${originY}px`;
    const dx = x - originX;
    const dy = y - originY;
    this.touchRing.style.setProperty('--knob-x', `${dx.toFixed(0)}px`);
    this.touchRing.style.setProperty('--knob-y', `${dy.toFixed(0)}px`);
  }
}

function qualityWord(quality: number): string {
  if (quality > 0.88) return 'stomped';
  if (quality > 0.7) return 'clean';
  if (quality > 0.45) return 'landed';
  return 'sketchy';
}

/** Arc across a 140-degree gauge, drawn between two edge angles. */
function arcPath(fromDeg: number, toDeg: number): string {
  const r = 52;
  const cx = 60;
  const cy = 60;
  const a0 = ((fromDeg - 90) * Math.PI) / 180;
  const a1 = ((toDeg - 90) * Math.PI) / 180;
  const x0 = cx + Math.cos(a0) * r;
  const y0 = cy + Math.sin(a0) * r;
  const x1 = cx + Math.cos(a1) * r;
  const y1 = cy + Math.sin(a1) * r;
  const large = Math.abs(toDeg - fromDeg) > 180 ? 1 : 0;
  const sweep = toDeg > fromDeg ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
