import { clamp, clamp01, lerp } from '../core/math.ts';
import type { Telemetry } from '../physics/riderSim.ts';

/**
 * Sound.
 *
 * Everything is synthesised at runtime — there is not a single audio file in the
 * project. That is partly so the build stays tiny, but mostly because the sounds
 * that matter here are *continuous* and driven by physics: the pitch of an edge
 * carving is a function of how hard it is loaded and how fast it is slipping, and
 * no amount of crossfading between recorded loops reproduces that. Filtered noise
 * whose cutoff and gain are wired straight to the solver's telemetry does.
 *
 * Layers:
 *   wind    broadband noise, opens up with speed; the only thing you hear in the air
 *   carve   narrow resonant band, tracks edge angle — a clean carve sings, a skid roars
 *   spray   wide noise, gain from slip speed and penetration depth
 *   grind   metallic resonant peaks over noise while on a rail
 * plus one-shots for pop, landing, bail and the interface.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private started = false;
  private noiseBuffer: AudioBuffer | null = null;

  private wind: LoopVoice | null = null;
  private carve: LoopVoice | null = null;
  private spray: LoopVoice | null = null;
  private grind: LoopVoice | null = null;

  private masterVolume = 0.7;
  private muted = false;
  private lastLanding = 0;

  /** Resumes the context. Browsers require this to happen inside a gesture. */
  unlock(): void {
    if (this.started) {
      void this.ctx?.resume();
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    try {
      this.ctx = new Ctor();
    } catch {
      return;
    }
    this.started = true;

    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : this.masterVolume;
    this.master.connect(this.ctx.destination);

    this.noiseBuffer = makeNoiseBuffer(this.ctx);

    // Wind: gentle low-pass, rising with speed. This is what carries the sense
    // of velocity when the board is off the snow and everything else goes quiet.
    this.wind = new LoopVoice(this.ctx, this.noiseBuffer, this.master, {
      type: 'lowpass',
      frequency: 420,
      Q: 0.7,
    });

    // Carve: a narrow band that rises in pitch as the edge is set harder. A
    // railed carve is a tone; break it loose and the band widens into a roar.
    this.carve = new LoopVoice(this.ctx, this.noiseBuffer, this.master, {
      type: 'bandpass',
      frequency: 900,
      Q: 8,
    });

    // Spray: the broad hiss of displaced snow.
    this.spray = new LoopVoice(this.ctx, this.noiseBuffer, this.master, {
      type: 'highpass',
      frequency: 1400,
      Q: 0.9,
    });

    // Grind: metal, so a high-Q peak that rings.
    this.grind = new LoopVoice(this.ctx, this.noiseBuffer, this.master, {
      type: 'bandpass',
      frequency: 2100,
      Q: 16,
    });

    void this.ctx.resume();
  }

  get enabled(): boolean {
    return this.started && !!this.ctx && this.ctx.state === 'running';
  }

  setVolume(v: number): void {
    this.masterVolume = clamp01(v);
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(this.muted ? 0 : this.masterVolume, this.ctx.currentTime, 0.05);
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.setVolume(this.masterVolume);
  }

  get volume(): number {
    return this.masterVolume;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Silences the continuous layers without tearing down the graph. */
  quiet(): void {
    this.wind?.set(0, 300, 0.2);
    this.carve?.set(0, 600, 0.2);
    this.spray?.set(0, 1400, 0.2);
    this.grind?.set(0, 2000, 0.2);
  }

  /**
   * Drives the continuous layers from one frame of telemetry. Every number here
   * is a real simulation quantity, which is why the mix tracks what you are
   * doing without any state machine deciding which loop to play.
   */
  update(telemetry: Telemetry, riding: boolean): void {
    if (!this.enabled || !riding) {
      if (this.enabled) this.quiet();
      return;
    }

    const speed = telemetry.speed;
    const speedT = clamp01(speed / 28);

    // Wind is always there and dominates in the air.
    const airborne = telemetry.airborne;
    const windGain = lerp(0.02, 0.3, speedT ** 1.4) * (airborne ? 1.5 : 1);
    this.wind?.set(windGain, lerp(300, 1500, speedT), 0.09);

    if (airborne || telemetry.contactCount === 0) {
      this.carve?.set(0, 700, 0.12);
      this.spray?.set(0, 1500, 0.12);
      this.grind?.set(0, 2100, 0.08);
      return;
    }

    if (telemetry.grindSurfaceId) {
      // On metal: the tone rises with speed and the edge layers drop out.
      this.grind?.set(clamp01(speed / 14) * 0.22, lerp(1500, 3400, speedT), 0.05);
      this.carve?.set(0, 700, 0.1);
      this.spray?.set(0, 1500, 0.1);
      return;
    }
    this.grind?.set(0, 2100, 0.1);

    // Edge tone: pitch from how far the board is over, level from load and speed.
    const edge = clamp01(Math.abs(telemetry.edgeAngle) / 55);
    const load = clamp01(telemetry.gForce / 2.2);
    const carveGain = clamp01(speed / 8) * (0.05 + edge * 0.18) * (0.5 + load * 0.7);
    this.carve?.set(carveGain, lerp(420, 1750, edge), 0.07, lerp(3, 11, telemetry.carveQuality));

    // Spray: straight off the solver's own slip measure.
    const sprayGain = clamp01(telemetry.sprayIntensity * 1.5) * clamp01(speed / 6) * 0.3;
    this.spray?.set(sprayGain, lerp(900, 2600, clamp01(1 - telemetry.carveQuality)), 0.06);
  }

  // --- One-shots -----------------------------------------------------------

  /** The snap of the board leaving the snow. */
  pop(strength = 1): void {
    if (!this.enabled || !this.ctx || !this.master || !this.noiseBuffer) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(1600, t);
    filter.frequency.exponentialRampToValueAtTime(520, t + 0.12);
    filter.Q.value = 3;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.22 * clamp01(strength), t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + 0.2);
  }

  /**
   * Touchdown. `impact` is the solver's peak leg force in newtons, so a floated
   * landing barely registers and a case hits like a hammer.
   */
  landing(impact: number, quality: number): void {
    if (!this.enabled || !this.ctx || !this.master || !this.noiseBuffer) return;
    // Guard against the state machine double-firing on a chattering contact.
    if (this.ctx.currentTime - this.lastLanding < 0.08) return;
    this.lastLanding = this.ctx.currentTime;

    const t = this.ctx.currentTime;
    const force = clamp01(impact / 14000);
    const level = 0.1 + force * 0.5;

    // Body: a short low sine drop, which is the thump you feel in your knees.
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(lerp(120, 62, force), t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.18);
    const oscGain = this.ctx.createGain();
    oscGain.gain.setValueAtTime(level, t);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
    osc.connect(oscGain).connect(this.master);
    osc.start(t);
    osc.stop(t + 0.3);

    // Snow: a burst of noise, brighter the worse the landing.
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = lerp(900, 4200, 1 - clamp01(quality));
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(level * 0.7, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + 0.25);
  }

  /** Going down. Longer, rougher, and it tumbles. */
  bail(speed: number): void {
    if (!this.enabled || !this.ctx || !this.master || !this.noiseBuffer) return;
    const t = this.ctx.currentTime;
    const level = 0.18 + clamp01(speed / 25) * 0.3;

    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(2600, t);
    filter.frequency.exponentialRampToValueAtTime(320, t + 0.9);
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(level, t);
    // Two dips, so it reads as a tumble rather than one impact.
    gain.gain.linearRampToValueAtTime(level * 0.4, t + 0.18);
    gain.gain.linearRampToValueAtTime(level * 0.75, t + 0.32);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    src.connect(filter).connect(gain).connect(this.master);
    src.start(t);
    src.stop(t + 1.2);
  }

  /** Locking onto a rail. */
  grindStart(): void {
    this.blip(2600, 0.05, 0.12, 'square');
  }

  /** Landed trick. Pitch rises with how big it scored. */
  trick(points: number): void {
    const step = clamp(Math.round(points / 400), 0, 6);
    this.blip(520 * Math.pow(2, step / 12), 0.09, 0.1, 'triangle');
  }

  uiClick(): void {
    this.blip(880, 0.03, 0.05, 'triangle');
  }

  private blip(frequency: number, level: number, duration: number, type: OscillatorType): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = frequency;
    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(level, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + duration);
    osc.connect(gain).connect(this.master);
    osc.start(t);
    osc.stop(t + duration + 0.02);
  }

  dispose(): void {
    void this.ctx?.close();
    this.ctx = null;
    this.started = false;
  }
}

/** A looping noise source through a filter, with smoothed gain and cutoff. */
class LoopVoice {
  private gain: GainNode;
  private filter: BiquadFilterNode;
  private ctx: AudioContext;

  constructor(
    ctx: AudioContext,
    buffer: AudioBuffer,
    destination: AudioNode,
    filter: { type: BiquadFilterType; frequency: number; Q: number },
  ) {
    this.ctx = ctx;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;

    this.filter = ctx.createBiquadFilter();
    this.filter.type = filter.type;
    this.filter.frequency.value = filter.frequency;
    this.filter.Q.value = filter.Q;

    this.gain = ctx.createGain();
    this.gain.gain.value = 0;

    source.connect(this.filter).connect(this.gain).connect(destination);
    source.start();
  }

  /** All parameters ramp rather than jump, so nothing ever clicks. */
  set(gain: number, frequency: number, smoothing = 0.08, q?: number): void {
    const t = this.ctx.currentTime;
    this.gain.gain.setTargetAtTime(Math.max(0, gain), t, smoothing);
    this.filter.frequency.setTargetAtTime(clamp(frequency, 40, 18000), t, smoothing);
    if (q !== undefined) this.filter.Q.setTargetAtTime(clamp(q, 0.1, 40), t, smoothing);
  }
}

/** Two seconds of white noise, generated once and looped by every layer. */
function makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * 2);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < length; i++) {
    const white = Math.random() * 2 - 1;
    // A touch of low-pass on the source keeps the top end from being harsh
    // before the per-layer filters get to it.
    last = last * 0.32 + white * 0.68;
    data[i] = last;
  }
  // Cross-fade the seam so the two-second loop has no audible click.
  const fade = Math.floor(ctx.sampleRate * 0.02);
  for (let i = 0; i < fade; i++) {
    const k = i / fade;
    data[i] = data[i] * k + data[length - fade + i] * (1 - k);
  }
  return buffer;
}
