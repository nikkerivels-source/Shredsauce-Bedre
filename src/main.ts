import * as THREE from 'three';
import { RAD, Vec3, clamp } from './core/math.ts';
import { Session, type GameMode } from './game/session.ts';
import { LevelEditor } from './game/editor.ts';
import { InputManager } from './game/input.ts';
import { AudioEngine } from './game/audio.ts';
import { Tutorial } from './game/tutorial.ts';
import { buildPreset } from './game/levels.ts';
import {
  loadProfile,
  recordScore,
  saveProfile,
  saveToLibrary,
  type Profile,
} from './game/storage.ts';
import { ReplayPlayer, makeReplaySample, saveReplay, type Replay, type ReplaySample } from './game/replay.ts';
import { getGear } from './physics/gear.ts';
import { makePose, poseFromRider, type RiderPose } from './physics/ragdoll.ts';
import { RiderSim, defaultTuning } from './physics/riderSim.ts';
import { WorldView, detectQuality, qualityPreset } from './render/renderer.ts';
import { defaultAppearance, type RiderAppearance } from './render/rider.ts';
import type { CameraMode } from './render/cameras.ts';
import { NetClient, type RemotePlayer } from './net/client.ts';
import { Hud } from './ui/hud.ts';
import { Shell } from './ui/menus.ts';
import type { LevelDef } from './world/level.ts';
import { featureBounds } from './world/terrain.ts';

type AppMode = 'menu' | 'riding' | 'editing' | 'replay';

/**
 * Application shell: owns the loop and wires the session, renderer, input and UI
 * together. Everything with real behaviour lives in its own module; this file is
 * only responsible for the order things happen in.
 */
class App {
  private canvas: HTMLCanvasElement;
  private profile: Profile;
  private session: Session;
  private view: WorldView;
  private input: InputManager;
  private hud = new Hud();
  private shell: Shell;
  private editor: LevelEditor | null = null;
  private net: NetClient;
  private audio = new AudioEngine();
  private tutorial: Tutorial | null = null;
  private mode: AppMode = 'menu';

  private replayPlayer: ReplayPlayer | null = null;
  private replaySample: ReplaySample = makeReplaySample();
  private replaySim: RiderSim;
  private replayPose: RiderPose = makePose();

  private lastFrame = performance.now();
  private accumulatedAir = 0;
  private ghostPose: RiderPose = makePose();
  private ghostSim: RiderSim;
  private scratch = new Vec3();
  private pointerDown = false;
  private editorPointer = { x: 0, z: 0, active: false, valid: false };
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.profile = loadProfile();

    const level = buildPreset('home-park');
    this.session = new Session(level, this.profile);

    this.view = new WorldView(canvas, this.session.field, qualityPreset(this.profile.quality ?? detectQuality()));
    this.view.loadLevel(level, this.session.field, this.session.grindSurfaces);
    this.view.setRider(this.session.gear, this.profile.appearance);

    this.input = new InputManager(canvas, this.session.gear.discipline);

    // Separate simulations used purely as pose sources for replays and remote
    // riders — they are never stepped, only posed.
    this.replaySim = new RiderSim(this.session.field, level, [], this.session.gear, defaultTuning());
    this.ghostSim = new RiderSim(this.session.field, level, [], this.session.gear, defaultTuning());

    this.net = new NetClient({
      onStatus: (status) => {
        this.shell.connectionStatus = status;
        this.shell.refreshMultiplayer();
      },
      onRoster: (players) => {
        this.shell.roster = players.map((p) => ({ id: p.id, name: p.name }));
        this.shell.refreshMultiplayer();
        const ids = new Set(players.map((p) => p.id));
        for (const id of this.knownGhosts) if (!ids.has(id)) this.view.removeGhost(id);
        this.knownGhosts = ids;
      },
      onLevel: (remoteLevel) => {
        if (this.mode === 'riding') this.startRun(remoteLevel, this.session.mode, { announce: false });
      },
      onTrick: (name, playerName, points) => {
        this.hud.showMessage(`${playerName}: ${name} +${Math.round(points)}`);
      },
    });

    this.shell = new Shell(this.profile, {
      onRide: (lvl, mode) => this.startRun(lvl, mode),
      onResume: () => this.resume(),
      onRestart: () => {
        this.session.paused = false;
        this.session.restart();
        this.trickCursor = 0;
        this.tutorial?.reset();
        this.view.trail.clear();
        this.enterMode('riding');
      },
      onQuitToMenu: () => this.quitToMenu(),
      onProfileChanged: () => this.applyProfile(),
      onOpenEditor: (lvl) => this.openEditor(lvl),
      onLearn: () => {
        this.tutorial = new Tutorial();
        this.tutorial.onStepComplete = (step) => {
          this.audio.trick(900);
          this.shell.toast(step.title);
        };
        const level = buildPreset('home-park');
        level.id = 'home-park';
        this.startRun(level, 'freeride', { announce: false });
        this.shell.toast('Learn to ride');
      },
      onEditorPlay: () => {
        if (!this.editor) return;
        this.startRun(this.editor.export(), 'freeride');
      },
      onEditorSave: () => {
        if (!this.editor) return;
        saveToLibrary(this.editor.export());
        this.shell.toast('Saved to your builds');
      },
      onWatchReplay: (replay) => this.watchReplay(replay),
      onJoinRoom: (room, name) => {
        this.net.setIdentity({
          name,
          gearId: this.session.gear.id,
          goofy: this.profile.goofy,
          colors: this.profile.appearance as unknown as Record<string, string>,
        });
        this.net.join(room, this.session.level);
      },
      onLeaveRoom: () => {
        this.net.leave();
        this.view.clearGhosts();
        this.knownGhosts = new Set();
      },
      onCameraMode: (mode: CameraMode) => {
        this.view.rig.mode = mode;
      },
    });

    this.shell.root.addEventListener('pointerdown', (e) => {
      if ((e.target as HTMLElement)?.closest('button')) this.audio.uiClick();
    });
    document.body.append(this.hud.root, this.shell.root);
    this.hud.setVisible(false);

    this.shell.onRebakeAll = () => {
      this.session.rebake();
      this.view.loadLevel(this.session.level, this.session.field, this.session.grindSurfaces);
    };
    this.shell.onWeatherChanged = () => this.view.refreshWeather(this.session.level);
    this.shell.onSnowfallChanged = () =>
      this.view.loadLevel(this.session.level, this.session.field, this.session.grindSurfaces);

    this.audio.setVolume(this.profile.masterVolume);
    // Browsers will not start audio outside a user gesture, so arm it on the
    // first interaction of any kind and then never think about it again.
    const unlock = () => this.audio.unlock();
    window.addEventListener('pointerdown', unlock, { once: false });
    window.addEventListener('keydown', unlock, { once: false });

    this.attachCanvasHandlers();
    window.addEventListener('resize', () => this.resize());
    this.resize();
    requestAnimationFrame(() => this.frame());
  }

  private knownGhosts = new Set<string>();
  private trickCursor = 0;

  // -------------------------------------------------------------------------

  private applyProfile(): void {
    saveProfile(this.profile);
    this.audio.setVolume(this.profile.masterVolume);
    const gear = getGear(this.profile.discipline === 'skis' ? this.profile.skiId : this.profile.boardId);
    this.session.setGear(gear);
    this.session.setAssist(this.profile.assist);
    this.session.sim.riderMass = this.profile.riderMass;
    this.session.profile = this.profile;
    this.input.setDiscipline(gear.discipline);
    this.view.setRider(gear, this.profile.appearance);
    const quality = qualityPreset(this.profile.quality);
    if (quality.triangleBudget !== this.view.quality.triangleBudget) this.view.setQuality(quality);
    else {
      this.view.quality = quality;
      this.view.renderer.shadowMap.enabled = quality.shadows;
    }
  }

  private startRun(level: LevelDef, mode: GameMode, opts: { announce?: boolean } = {}): void {
    if (opts.announce !== false) this.tutorial = null;
    this.session.loadLevel(level);
    this.session.restart(mode);
    this.session.paused = false;
    this.view.loadLevel(level, this.session.field, this.session.grindSurfaces);
    this.view.setRider(this.session.gear, this.profile.appearance);
    this.trickCursor = 0;
    this.hud.setChallenges(this.session.activeChallenges);
    this.enterMode('riding');
    if (opts.announce !== false) this.shell.toast(level.name);
  }

  private openEditor(level: LevelDef): void {
    this.session.loadLevel(level);
    this.session.paused = true;
    this.view.loadLevel(level, this.session.field, this.session.grindSurfaces);
    this.editor = new LevelEditor(this.session);
    this.shell.editor = this.editor;
    this.enterMode('editing');
    this.shell.show('editor');
    // Look down the hill from above so the whole park is visible.
    const target = new THREE.Vector3(level.spawn.x, this.session.field.heightAt(level.spawn.x, level.spawn.z + 60), level.spawn.z + 60);
    this.view.rig.mode = 'free';
    this.view.rig.frame(target, 48, Math.PI, 0.42);
  }

  private watchReplay(replay: Replay): void {
    this.replayPlayer = new ReplayPlayer(replay);
    this.enterMode('replay');
    this.shell.show('none');
    this.view.rig.mode = 'cinematic';
  }

  private enterMode(mode: AppMode): void {
    this.mode = mode;
    if (mode !== 'editing') {
      this.view.setEditorCursor(0, 0, 1, false);
      this.view.setEditorSelection(null);
    }
    this.hud.setVisible(mode === 'riding');
    if (mode === 'riding') {
      this.shell.show('none');
      if (this.view.rig.mode === 'free') this.view.rig.mode = 'chase';
    }
  }

  private resume(): void {
    this.session.paused = false;
    this.enterMode('riding');
  }

  private quitToMenu(): void {
    this.tutorial = null;
    this.hud.setTutorial(null);
    if (this.mode === 'riding') this.finishRun();
    this.session.paused = true;
    this.editor = null;
    this.shell.editor = null;
    this.replayPlayer = null;
    this.mode = 'menu';
    this.hud.setVisible(false);
    this.shell.show('main');
  }

  private pause(): void {
    if (this.mode !== 'riding') return;
    this.session.paused = true;
    this.hud.setVisible(false);
    this.shell.show('pause');
  }

  /** Banks the run: score, XP and a replay. */
  private finishRun(): void {
    const summary = this.session.summary;
    if (summary.score <= 0 && summary.tricks.length === 0) return;

    const landed = summary.tricks.filter((t) => t.landed).sort((a, b) => b.points - a.points);
    recordScore({
      levelId: this.session.level.id,
      levelName: this.session.level.name,
      mode: this.session.mode,
      score: Math.round(summary.score),
      bestTrick: landed[0]?.name ?? '',
      bestCombo: summary.bestCombo,
      time: summary.elapsed,
      at: Date.now(),
    });

    // Score converts to progression at a flat rate, so any mode advances you.
    this.profile.xp += Math.round(summary.score * 0.35);
    this.profile.credits += Math.round(summary.score * 0.12);
    saveProfile(this.profile);

    if (this.session.recorder.frames.length > 10) {
      saveReplay(
        this.session.recorder.finish({
          levelId: this.session.level.id,
          levelName: this.session.level.name,
          gearId: this.session.gear.id,
          goofy: this.profile.goofy,
          score: Math.round(summary.score),
          label: `${this.session.level.name} · ${Math.round(summary.score)}`,
        }),
      );
    }

    this.shell.setResults(summary, this.session.level);
  }

  // -------------------------------------------------------------------------

  private frame(): void {
    const now = performance.now();
    // Clamp so a background tab or a long bake does not teleport the rider.
    const dt = Math.min(0.05, (now - this.lastFrame) / 1000);
    this.lastFrame = now;

    switch (this.mode) {
      case 'riding':
        this.updateRiding(dt);
        break;
      case 'editing':
        this.updateEditing(dt);
        break;
      case 'replay':
        this.updateReplay(dt);
        break;
      default:
        this.updateMenuScene(dt);
        break;
    }

    this.view.render(dt);
    requestAnimationFrame(() => this.frame());
  }

  /**
   * Keeps the world alive behind the menus: the rider stands at the start of the
   * run and the camera circles them, so the title screen shows the actual level
   * rather than a static backdrop.
   */
  private updateMenuScene(dt: number): void {
    this.audio.quiet();
    const spawn = this.session.level.spawn;
    this.session.sim.reset(spawn.x, spawn.z, spawn.heading);
    poseFromRider(this.session.sim, this.session.pose, {
      grab: null,
      twist: 0,
      tuck: 0,
      goofy: this.profile.goofy,
    });
    this.view.updateRider(
      dt,
      this.session.pose,
      this.session.sim.telemetry,
      [],
      this.session.sim.velocity,
    );
    // Look at a point down the run rather than at the rider's feet, so the
    // title screen frames the line ahead and the peaks beyond it.
    const aheadZ = spawn.z + 70;
    _focus.set(spawn.x, this.session.field.heightAt(spawn.x, aheadZ) + 6, aheadZ);
    this.view.rig.showcase(dt, _focus);
  }

  private updateRiding(dt: number): void {
    for (const action of this.input.actions.splice(0)) {
      if (action === 'reset') {
        this.session.sim.reset(this.session.level.spawn.x, this.session.level.spawn.z, this.session.level.spawn.heading);
        this.view.trail.clear();
      } else if (action === 'camera') {
        this.shell.toast(this.view.rig.cycle());
      } else if (action === 'pause') {
        this.pause();
        return;
      } else if (action === 'photo') {
        this.savePhoto();
      }
    }

    const airborne = this.session.sim.state === 'airborne';
    const riderInput = this.input.update(dt, airborne);
    this.session.update(dt, riderInput);

    // Physics events drive both the one-shot sounds and the impact effects, so
    // the two always agree about how hard something hit.
    for (const e of this.session.simEvents) {
      if (e.type === 'takeoff') {
        this.audio.pop(clamp((e.speed ?? 8) / 16, 0.3, 1));
      } else if (e.type === 'landing') {
        const impact = e.impact ?? 0;
        this.audio.landing(impact, e.quality ?? 0);
        this.view.rig.shake = Math.min(0.6, this.view.rig.shake + Math.min(0.45, impact / 22000));
      } else if (e.type === 'bail') {
        this.audio.bail(e.speed ?? 0);
        this.view.rig.shake = Math.min(0.8, this.view.rig.shake + 0.4);
      } else if (e.type === 'grindStart') {
        this.audio.grindStart();
      }
    }

    // Surface session events.
    for (const event of this.session.events.splice(0)) {
      if (event.type === 'trick' && event.trick) {
        this.hud.pushTrick(event.trick);
        if (event.trick.landed) {
          this.net.reportTrick(event.trick.name, event.trick.points);
          this.audio.trick(event.trick.points);
        }
        if (!event.trick.landed) {
          this.session.getBoardCenter(this.scratch);
          this.view.burst(this.scratch.x, this.scratch.y, this.scratch.z, 0.7);
        }
      } else if (event.type === 'challenge' && event.challenge) {
        this.hud.showMessage(`${event.challenge.name} · +${event.challenge.reward}`);
        this.hud.setChallenges(this.session.activeChallenges);
        saveProfile(this.profile);
      } else if (event.type === 'gate') {
        this.hud.showMessage('gate');
      } else if (event.type === 'finish' || event.type === 'timeUp') {
        this.hud.showMessage(event.message ?? '');
        if (event.type === 'timeUp') {
          this.finishRun();
          this.shell.show('results');
          this.hud.setVisible(false);
          this.mode = 'menu';
          return;
        }
      }
    }

    // Landing puffs, sized by the impact the solver measured.
    const telemetry = this.session.sim.telemetry;
    if (this.accumulatedAir > 0.35 && !telemetry.airborne) {
      this.session.getBoardCenter(this.scratch);
      this.view.burst(this.scratch.x, this.scratch.y, this.scratch.z, Math.min(1, this.accumulatedAir / 2.4));
    }
    this.accumulatedAir = telemetry.airborne ? Math.max(this.accumulatedAir, telemetry.altitude) : 0;

    if (telemetry.airborne) {
      const spin = Math.abs(this.session.sim.angularVelocity.y) * telemetry.airTime * RAD;
      this.hud.showLiveRotation(spin, this.session.pose.joints.length > 0 && telemetry.airborne && this.isInverted());
    }

    this.view.updateRider(dt, this.session.pose, telemetry, this.session.sim.contacts, this.session.sim.velocity);
    this.view.rig.update(dt, this.session.sim);

    if (this.tutorial) {
      const before = this.trickCursor;
      const landedNow = this.session.tricks.history.slice(before);
      this.trickCursor = this.session.tricks.history.length;
      this.hud.setTutorial(
        this.tutorial.update({ dt, session: this.session, input: riderInput, landed: landedNow }),
      );
    }

    this.audio.update(telemetry, true);
    this.hud.update(dt, telemetry, this.session.summary, this.session.mode, this.session.timeRemaining, this.session.tricks.combo);
    this.hud.setTouchRing(
      this.input.touchActive,
      this.input.touchOriginX,
      this.input.touchOriginY,
      this.input.touchX,
      this.input.touchY,
    );

    this.updateNetwork(dt);
  }

  private isInverted(): boolean {
    this.session.sim.getBodyAxes(_r, _u, _f);
    return _u.y < -0.1;
  }

  private updateNetwork(dt: number): void {
    const sim = this.session.sim;
    this.net.update(dt, {
      position: sim.position,
      orientation: sim.orientation,
      legLength: sim.legLength,
      angulation: sim.angulation,
      hipShift: sim.hipShift,
      grab: this.session.lastRiderInput.grab,
      twist: this.session.lastRiderInput.twist,
      tuck: this.session.lastRiderInput.tuck,
      limp: this.session.isLimp,
    });

    for (const player of this.net.players.values()) {
      this.poseRemote(player);
    }
  }

  /** Drives a spare simulation into the remote player's state to pose them. */
  private poseRemote(player: RemotePlayer): void {
    const gear = getGear(player.gearId);
    this.ghostSim.gear = gear;
    this.ghostSim.position.copy(player.position);
    this.ghostSim.orientation.copy(player.orientation);
    this.ghostSim.legLength = player.legLength;
    this.ghostSim.angulation = player.angulation;
    this.ghostSim.hipShift = player.hipShift;
    poseFromRider(this.ghostSim, this.ghostPose, {
      grab: player.grab,
      twist: player.twist,
      tuck: player.tuck,
      goofy: player.goofy,
    });
    const colors: RiderAppearance = { ...defaultAppearance(), ...(player.colors as Partial<RiderAppearance>) };
    this.view.setGhost(player.id, gear, colors, this.ghostPose);
  }

  private updateEditing(dt: number): void {
    const editor = this.editor;
    if (!editor) return;

    // Free-fly the editor camera with the keyboard.
    const keys = this.editorKeys;
    this.view.rig.driveFree(
      dt,
      (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0),
      (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0),
      (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0),
      (keys.has('ArrowRight') ? 1.4 : 0) - (keys.has('ArrowLeft') ? 1.4 : 0),
      (keys.has('ArrowUp') ? 1 : 0) - (keys.has('ArrowDown') ? 1 : 0),
    );
    this.view.rig.update(dt, this.session.sim);

    // Cursor ring sized to whatever the current tool actually affects.
    const sculpting = editor.tool === 'raise' || editor.tool === 'lower' || editor.tool === 'smooth';
    const ringRadius = sculpting ? editor.brush.radius : editor.tool === 'place' ? 4 : 2.5;
    this.view.setEditorCursor(
      this.editorPointer.x,
      this.editorPointer.z,
      ringRadius,
      this.editorPointer.valid && editor.tool !== 'select',
    );
    const selected = editor.selected;
    this.view.setEditorSelection(selected ? featureBounds(selected) : null);

    if (this.editorRevision !== editor.revision) {
      this.editorRevision = editor.revision;
      this.view.loadLevel(this.session.level, this.session.field, this.session.grindSurfaces);
    }

    // Pose the rider at the spawn point so you can see the scale of what you build.
    this.session.sim.reset(this.session.level.spawn.x, this.session.level.spawn.z, this.session.level.spawn.heading);
    poseFromRider(this.session.sim, this.session.pose, { grab: null, twist: 0, tuck: 0, goofy: this.profile.goofy });
    this.view.updateRider(dt, this.session.pose, this.session.sim.telemetry, this.session.sim.contacts, this.session.sim.velocity);
  }

  private editorRevision = -1;
  private editorKeys = new Set<string>();

  private updateReplay(dt: number): void {
    const player = this.replayPlayer;
    if (!player) return;
    player.update(dt);
    player.sample(this.replaySample);

    this.replaySim.gear = getGear(player.replay.meta.gearId);
    this.replaySim.position.copy(this.replaySample.position);
    this.replaySim.orientation.copy(this.replaySample.orientation);
    this.replaySim.legLength = this.replaySample.legLength;
    this.replaySim.angulation = this.replaySample.angulation;
    this.replaySim.hipShift = this.replaySample.hipShift;
    poseFromRider(this.replaySim, this.replayPose, {
      grab: this.replaySample.grab,
      twist: this.replaySample.twist,
      tuck: this.replaySample.tuck,
      goofy: player.replay.meta.goofy,
    });

    this.view.updateRider(dt, this.replayPose, this.replaySim.telemetry, [], this.replaySim.velocity);
    this.view.rig.update(dt, this.replaySim);

    for (const action of this.input.actions.splice(0)) {
      if (action === 'camera') this.view.rig.cycle();
      if (action === 'pause' || action === 'reset') this.quitToMenu();
    }
  }

  private savePhoto(): void {
    this.view.render(0);
    this.canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `bluebird-${Date.now()}.png`;
      link.click();
      URL.revokeObjectURL(url);
    });
    this.shell.toast('Photo saved');
  }

  // -------------------------------------------------------------------------

  private attachCanvasHandlers(): void {
    window.addEventListener('keydown', (e) => {
      if (this.mode === 'editing') this.editorKeys.add(e.code);
      if (e.code === 'Escape' && this.mode === 'riding') this.pause();
      if (this.mode === 'editing' && (e.ctrlKey || e.metaKey) && e.code === 'KeyZ') {
        e.preventDefault();
        if (e.shiftKey) this.editor?.redo();
        else this.editor?.undo();
        this.shell.renderEditorProps?.();
      }
    });
    window.addEventListener('keyup', (e) => this.editorKeys.delete(e.code));

    this.canvas.addEventListener('pointerdown', (e) => {
      this.pointerDown = true;
      if (this.mode === 'editing') this.onEditorPointer(e, true);
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (this.mode !== 'editing') return;
      if (this.pointerDown) this.onEditorPointer(e, false);
      else this.trackEditorHover(e);
    });
    const release = () => {
      this.pointerDown = false;
      this.editor?.endStroke();
      this.editorPointer.active = false;
    };
    this.canvas.addEventListener('pointerup', release);
    this.canvas.addEventListener('pointercancel', release);

    this.canvas.addEventListener(
      'wheel',
      (e) => {
        if (this.mode !== 'editing') return;
        e.preventDefault();
        this.view.rig.driveFree(0.016, -Math.sign(e.deltaY) * 12, 0, 0, 0, 0);
      },
      { passive: false },
    );
  }

  /** Projects a pointer onto the terrain and applies the current editor tool. */
  private onEditorPointer(e: PointerEvent, isDown: boolean): void {
    const editor = this.editor;
    if (!editor) return;
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.view.camera);

    const hit = this.marchToTerrain(this.raycaster.ray);
    this.editorPointer.valid = !!hit;
    if (!hit) return;
    const { x, z } = hit;
    this.editorPointer.x = x;
    this.editorPointer.z = z;

    switch (editor.tool) {
      case 'select':
        if (isDown) {
          const picked = editor.pick(x, z);
          editor.select(picked?.id ?? null);
          this.shell.renderEditorProps?.();
        } else if (editor.selected) {
          if (!this.editorPointer.active) {
            editor.beginStroke();
            this.editorPointer.active = true;
          }
          editor.moveSelected(x, z);
        }
        break;
      case 'place':
        if (isDown) {
          editor.place(x, z);
          this.shell.renderEditorProps?.();
        }
        break;
      case 'raise':
      case 'lower':
      case 'smooth': {
        if (!this.editorPointer.active) {
          editor.beginStroke();
          this.editorPointer.active = true;
        }
        const direction = editor.tool === 'raise' ? 1 : editor.tool === 'lower' ? -1 : 0;
        editor.paintTerrain(x, z, 1 / 60, direction);
        break;
      }
      case 'spawn':
        if (isDown) editor.setSpawn(x, z, this.session.level.spawn.heading);
        break;
      default:
        break;
    }
  }

  /** Projects the pointer onto the terrain without applying any tool. */
  private trackEditorHover(e: PointerEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.view.camera);
    const hit = this.marchToTerrain(this.raycaster.ray);
    this.editorPointer.valid = !!hit;
    if (hit) {
      this.editorPointer.x = hit.x;
      this.editorPointer.z = hit.z;
    }
  }

  /**
   * Ray-marches the camera ray against the heightfield.
   *
   * The terrain mesh is decimated for rendering, so raycasting the mesh would
   * put the editor cursor somewhere the physics does not agree with. Marching
   * the real field keeps them consistent.
   */
  private marchToTerrain(ray: THREE.Ray): { x: number; z: number } | null {
    const field = this.session.field;
    const origin = ray.origin;
    const dir = ray.direction;
    let t = 0;
    let prevAbove = origin.y - field.heightAt(origin.x, origin.z);
    const maxDist = 1200;
    const step = 1.2;
    while (t < maxDist) {
      t += step;
      const x = origin.x + dir.x * t;
      const y = origin.y + dir.y * t;
      const z = origin.z + dir.z * t;
      if (!field.isInside(x, z)) {
        if (t > 40 && dir.y >= 0) return null;
        continue;
      }
      const above = y - field.heightAt(x, z);
      if (above <= 0 && prevAbove > 0) {
        const frac = prevAbove / (prevAbove - above);
        const hitT = t - step + step * frac;
        return {
          x: clamp(origin.x + dir.x * hitT, field.minX, field.maxX),
          z: clamp(origin.z + dir.z * hitT, field.minZ, field.maxZ),
        };
      }
      prevAbove = above;
    }
    return null;
  }

  private resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.canvas.width = width;
    this.canvas.height = height;
    this.view.resize(width, height);
  }
}

const _focus = new THREE.Vector3();
const _r = new Vec3();
const _u = new Vec3();
const _f = new Vec3();

const canvas = document.getElementById('view') as HTMLCanvasElement | null;
if (!canvas) throw new Error('Missing #view canvas');

const boot = document.getElementById('boot');
try {
  new App(canvas);
  boot?.remove();
} catch (error) {
  console.error(error);
  if (boot) {
    boot.innerHTML = '';
    boot.append(
      Object.assign(document.createElement('h1'), { textContent: 'Bluebird could not start' }),
      Object.assign(document.createElement('pre'), {
        textContent: error instanceof Error ? `${error.message}\n\n${error.stack ?? ''}` : String(error),
      }),
    );
  }
}
