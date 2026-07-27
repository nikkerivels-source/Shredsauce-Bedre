import { GEAR_CATALOG, gearForDiscipline, getGear, type Discipline, type GearSpec } from '../physics/gear.ts';
import { MODE_LABELS, type GameMode, type SessionSummary } from '../game/session.ts';
import { PRESETS, generateLevel } from '../game/levels.ts';
import {
  bestScoreFor,
  passOwned,
  deleteFromLibrary,
  decodeLevelCode,
  encodeLevelCode,
  levelFromXp,
  loadLibrary,
  loadScores,
  xpForLevel,
  type Profile,
} from '../game/storage.ts';
import { deleteReplay, loadReplays, type Replay } from '../game/replay.ts';
import { PROP_KINDS, defaultBackdrop, type LevelDef, type PropKind } from '../world/level.ts';
import { LevelEditor, type EditorTool } from '../game/editor.ts';
import { CAMERA_LABELS, CAMERA_MODES, type CameraMode } from '../render/cameras.ts';
import { button, clear, colorField, el, formatScore, formatTime, segmented, slider, toggle } from './dom.ts';
import { wordmark } from './wordmark.ts';
import { runStats, trailMap } from './trailmap.ts';
import { formatBytes, readBackdropImage } from './image.ts';
import {
  PASS,
  SKINS,
  beginCheckout,
  checkoutUrl,
  passGear,
  passSkins,
  skinUnlocked,
  type Skin,
} from '../game/pass.ts';

export type Screen =
  | 'main'
  | 'ride'
  | 'gear'
  | 'settings'
  | 'results'
  | 'editor'
  | 'replays'
  | 'multiplayer'
  | 'pass'
  | 'pause'
  | 'none';

export interface ShellHandlers {
  onRide(level: LevelDef, mode: GameMode): void;
  onResume(): void;
  onRestart(): void;
  onQuitToMenu(): void;
  onProfileChanged(): void;
  onOpenEditor(level: LevelDef): void;
  onLearn(): void;
  onEditorPlay(): void;
  onEditorSave(): void;
  onWatchReplay(replay: Replay): void;
  onJoinRoom(room: string, name: string): void;
  onLeaveRoom(): void;
  onCameraMode(mode: CameraMode): void;
}

/**
 * Everything outside the run itself: menus, level browser, gear, settings, the
 * editor panel and the results card.
 */
export class Shell {
  readonly root: HTMLElement;
  screen: Screen = 'main';
  profile: Profile;
  editor: LevelEditor | null = null;
  /** Updated by the app so the multiplayer panel can show who is connected. */
  roster: Array<{ id: string; name: string }> = [];
  connectionStatus = 'offline';

  private handlers: ShellHandlers;
  private body: HTMLElement;
  private toastHost: HTMLElement;
  private lastSummary: SessionSummary | null = null;
  private lastLevel: LevelDef | null = null;
  private selectedMode: GameMode = 'freeride';

  constructor(profile: Profile, handlers: ShellHandlers) {
    this.profile = profile;
    this.handlers = handlers;
    this.body = el('div', { class: 'shell-body' });
    this.toastHost = el('div', { class: 'toasts' });
    this.root = el('div', { class: 'shell' }, [this.body, this.toastHost]);
    this.show('main');
  }

  toast(message: string): void {
    const node = el('div', { class: 'toast' }, [message]);
    this.toastHost.append(node);
    setTimeout(() => node.classList.add('fade'), 2400);
    setTimeout(() => node.remove(), 3000);
  }

  show(screen: Screen): void {
    this.screen = screen;
    this.root.style.display = screen === 'none' ? 'none' : '';
    this.root.classList.toggle('compact', screen === 'editor');
    this.root.classList.toggle('title', screen === 'main');
    clear(this.body);
    switch (screen) {
      case 'main':
        this.body.append(this.buildMain());
        break;
      case 'ride':
        this.body.append(this.buildRide());
        break;
      case 'gear':
        this.body.append(this.buildGear());
        break;
      case 'settings':
        this.body.append(this.buildSettings());
        break;
      case 'results':
        this.body.append(this.buildResults());
        break;
      case 'editor':
        this.body.append(this.buildEditorPanel());
        break;
      case 'replays':
        this.body.append(this.buildReplays());
        break;
      case 'multiplayer':
        this.body.append(this.buildMultiplayer());
        break;
      case 'pass':
        this.body.append(this.buildPass());
        break;
      case 'pause':
        this.body.append(this.buildPause());
        break;
      default:
        break;
    }
  }

  setResults(summary: SessionSummary, level: LevelDef): void {
    this.lastSummary = summary;
    this.lastLevel = level;
  }

  refreshEditorPanel(): void {
    if (this.screen === 'editor') this.show('editor');
  }

  refreshMultiplayer(): void {
    if (this.screen === 'multiplayer') this.show('multiplayer');
  }

  // -------------------------------------------------------------------------

  private header(title: string, subtitle?: string): HTMLElement {
    return el('div', { class: 'screen-header' }, [
      el('h1', {}, [title]),
      subtitle ? el('p', { class: 'subtitle' }, [subtitle]) : null,
    ]);
  }

  private backBar(to: Screen = 'main'): HTMLElement {
    return el('div', { class: 'backbar' }, [button('Back', () => this.show(to), 'btn ghost small')]);
  }

  private buildMain(): HTMLElement {
    const level = levelFromXp(this.profile.xp);
    const nextAt = xpForLevel(level + 1);
    const prevAt = xpForLevel(level);
    const progress = Math.max(0, Math.min(1, (this.profile.xp - prevAt) / Math.max(1, nextAt - prevAt)));
    const gear = this.profile.discipline === 'skis' ? this.profile.skiId : this.profile.boardId;

    const replays = loadReplays().length;

    // One primary action, then everything else. The old list gave all seven
    // entries identical weight, which is exactly how a menu ends up reading as
    // a table of contents instead of a way in.
    const item = (label: string, note: string, onClick: () => void) =>
      el('button', { class: 'nav-item', type: 'button', onclick: onClick }, [
        el('span', { class: 'nav-label' }, [label]),
        note ? el('span', { class: 'nav-note' }, [note]) : null,
      ]);

    return el('div', { class: 'screen title-screen' }, [
      el('div', { class: 'brand' }, [
        wordmark(),
        el('p', { class: 'tagline' }, ['Alpine freeski simulator']),
      ]),
      el('nav', { class: 'nav' }, [
        el('button', { class: 'nav-hero', type: 'button', onclick: () => this.show('ride') }, [
          el('span', { class: 'hero-label' }, ['Ride']),
          el('span', { class: 'hero-note' }, [`${PRESETS.length} mountains · endless seeds`]),
          el('span', { class: 'hero-arrow', 'aria-hidden': 'true' }, ['→']),
        ]),
        el('div', { class: 'nav-rest' }, [
          item('Learn', 'Eight steps', () => this.handlers.onLearn()),
          item('Sessions', 'Ride together', () => this.show('multiplayer')),
          item('Build', 'Level editor', () => {
            const built = generateLevel(Date.now() >>> 0, 'park');
            built.name = 'New Line';
            built.author = this.profile.name;
            this.handlers.onOpenEditor(built);
          }),
          item('Garage', getGear(gear).name, () => this.show('gear')),
          item('Season One', passOwned(this.profile) ? 'Owned' : `$${PASS.price.toFixed(2)}`, () => this.show('pass')),
          item('Replays', replays > 0 ? `${replays} saved` : '', () => this.show('replays')),
          item('Settings', '', () => this.show('settings')),
        ]),
      ]),
      el('div', { class: 'rider-strip' }, [
        el('span', { class: 'strip-name' }, [this.profile.name]),
        el('span', { class: 'strip-sep' }, ['/']),
        el('span', { class: 'strip-meta' }, [`Level ${level}`]),
        el('span', { class: 'strip-sep' }, ['/']),
        el('span', { class: 'strip-meta' }, [`${formatScore(this.profile.credits)} cr`]),
        el('span', { class: 'xp-bar', title: `${Math.round(progress * 100)}% to level ${level + 1}` }, [
          el('span', { class: 'xp-fill', style: `width:${(progress * 100).toFixed(1)}%` }),
        ]),
      ]),
    ]);
  }

  private buildRide(): HTMLElement {
    const list = el('div', { class: 'level-list' });
    const modeRow = el('div', { class: 'mode-row' }, [
      el('span', { class: 'field-label' }, ['MODE']),
      segmented<GameMode>(
        (Object.keys(MODE_LABELS) as GameMode[]).map((m) => ({ value: m, label: MODE_LABELS[m] })),
        this.selectedMode,
        (m) => {
          this.selectedMode = m;
          renderList();
        },
      ),
    ]);

    const renderList = () => {
      clear(list);
      list.append(el('h3', { class: 'list-heading' }, ['Mountains']));
      for (const preset of PRESETS) {
        const best = bestScoreFor(preset.id, this.selectedMode);
        const level = preset.build();
        level.id = preset.id;
        const stats = runStats(level);
        list.append(
          el('button', {
            class: 'level-card',
            type: 'button',
            onclick: () => this.handlers.onRide(preset.build(), this.selectedMode),
          }, [
            el('div', { class: 'card-map' }, [trailMap(level)]),
            el('div', { class: 'card-text' }, [
              el('div', { class: 'card-title' }, [pisteMark(preset.difficulty), el('h4', {}, [preset.name])]),
              el('p', {}, [preset.tagline]),
              // One quiet line. A label under every figure means twenty-eight
              // tracked micro-captions on a seven-row list, which is noise.
              el('div', { class: 'card-stats' }, [
                el('span', {}, [`${Math.round(stats.drop)} m vert`]),
                el('span', {}, [`${(stats.length / 1000).toFixed(1)} km`]),
                el('span', {}, [`${Math.round(stats.pitch)}° avg`]),
                el('span', {}, [
                  stats.gates > 0
                    ? `${stats.gates} gates`
                    : `${stats.features} ${stats.features === 1 ? 'feature' : 'features'}`,
                ]),
              ]),
            ]),
            best
              ? el('div', { class: 'best has' }, [el('span', {}, ['Best']), formatScore(best.score)])
              : el('div', { class: 'best' }, [el('span', {}, ['Best']), 'Unridden']),
          ]),
        );
      }

      const library = loadLibrary();
      list.append(el('h3', { class: 'list-heading' }, ['Your builds']));
      if (library.length === 0) {
        list.append(el('p', { class: 'empty' }, ['Nothing saved yet. Build something.']));
      }
      for (const entry of library) {
        list.append(
          el('div', { class: 'level-card saved' }, [
            el('div', { class: 'card-text' }, [
              el('h4', {}, [entry.level.name]),
              el('p', {}, [`${entry.level.author} · ${entry.level.features.length} features`]),
            ]),
            el('div', { class: 'card-actions' }, [
              button('Ride', () => this.handlers.onRide(entry.level, this.selectedMode), 'btn small'),
              button('Edit', () => this.handlers.onOpenEditor(entry.level), 'btn small ghost'),
              button('Share', async () => {
                const code = await encodeLevelCode(entry.level);
                await copyToClipboard(code);
                this.toast('Share code copied to clipboard');
              }, 'btn small ghost'),
              button('Delete', () => {
                deleteFromLibrary(entry.level.id);
                renderList();
              }, 'btn small danger'),
            ]),
          ]),
        );
      }
    };
    renderList();

    const codeInput = el('input', { type: 'text', placeholder: 'Paste a share code', class: 'code-input' });

    return el('div', { class: 'screen' }, [
      this.backBar(),
      this.header('Ride'),
      modeRow,
      el('div', { class: 'import-row' }, [
        codeInput,
        button('Load code', async () => {
          try {
            const level = await decodeLevelCode(codeInput.value);
            this.handlers.onRide(level, this.selectedMode);
          } catch (err) {
            this.toast(err instanceof Error ? err.message : 'Could not read that code');
          }
        }, 'btn small'),
        button('Surprise me', () => {
          this.handlers.onRide(generateLevel((Math.random() * 0xffffffff) >>> 0, 'park'), this.selectedMode);
        }, 'btn small ghost'),
      ]),
      list,
    ]);
  }

  private wearSkin(skin: Skin): void {
    this.profile.skinId = skin.id;
    this.profile.appearance = { ...skin.appearance };
    this.handlers.onProfileChanged();
  }

  /**
   * Season One.
   *
   * One price, everything at once. The screen is deliberately blunt about what
   * it is and is not — including that payment is not wired up in this build,
   * which is the sort of thing a store page should say out loud rather than
   * discover after a click.
   */
  private buildPass(): HTMLElement {
    const owned = passOwned(this.profile);
    const gear = passGear();
    const skins = passSkins();

    const skinRow = el('div', { class: 'skin-grid' });
    for (const skin of skins) {
      skinRow.append(
        el('div', { class: 'skin showcase', title: skin.note }, [
          swatch(skin),
          el('span', { class: 'skin-name' }, [skin.name]),
        ]),
      );
    }

    const gearList = el('div', { class: 'pass-gear' });
    for (const g of gear) {
      gearList.append(
        el('div', { class: 'pass-gear-row' }, [
          el('div', {}, [
            el('h4', {}, [g.name]),
            el('p', {}, [g.description]),
          ]),
          el('span', { class: 'pass-gear-kind' }, [g.discipline === 'skis' ? 'Skis' : 'Board']),
        ]),
      );
    }

    const buy = owned
      ? el('div', { class: 'pass-owned' }, [
          el('strong', {}, ['Season One is yours.']),
          el('p', {}, ['Every kit and every ski below is unlocked in the Garage.']),
        ])
      : el('div', { class: 'pass-buy' }, [
          el('div', { class: 'pass-price' }, [
            el('span', { class: 'pass-amount' }, [`$${PASS.price.toFixed(2)}`]),
            el('span', { class: 'pass-once' }, ['once · yours forever']),
          ]),
          button(`Buy ${PASS.name}`, () => this.startCheckout(), 'btn'),
          checkoutUrl()
            ? null
            : el('p', { class: 'pass-warning' }, [
                'Payment is not connected in this build — there is no server behind it yet, so nothing can be charged. The pass is built and ready; wiring a checkout provider is the remaining step.',
              ]),
        ]);

    return el('div', { class: 'screen pass-screen' }, [
      this.backBar(),
      el('div', { class: 'pass-head' }, [
        el('span', { class: 'pass-eyebrow' }, ['Season One']),
        el('h1', {}, ['Everything, at once']),
        el('p', { class: 'subtitle' }, [PASS.tagline]),
      ]),
      buy,
      el('div', { class: 'pass-terms' }, [
        passTerm('One payment', 'Not a subscription. There is no second season to buy.'),
        passTerm('No quests', 'Nothing to grind. Every item unlocks the moment you own it.'),
        passTerm('No expiry', 'It does not end, and nothing in it is ever removed.'),
        passTerm('Nothing gated', 'No mountain, mode or editor feature is behind it. Kit and sidegrades only.'),
      ]),
      el('h3', { class: 'list-heading' }, [`${skins.length} kits`]),
      skinRow,
      el('h3', { class: 'list-heading' }, [`${gear.length} skis and boards`]),
      gearList,
      el('p', { class: 'help' }, [
        'None of this gear is stronger than what you can earn — each one trades something away. The light ski is nervous at speed, the stable one is heavy, the powder one is vague on hardpack.',
      ]),
      el('p', { class: 'help' }, [
        'Ownership is stored on this device only, so clearing site data for this site loses it.',
      ]),
    ]);
  }

  private startCheckout(): void {
    const outcome = beginCheckout();
    if (outcome.kind === 'redirect') {
      window.location.href = outcome.url;
      return;
    }
    this.toast('No payment provider is connected yet — nothing was charged.');
  }

  private buildGear(): HTMLElement {
    const riderLevel = levelFromXp(this.profile.xp);
    const hasPass = passOwned(this.profile);
    const grid = el('div', { class: 'gear-grid' });

    const renderGear = () => {
      clear(grid);
      for (const gear of gearForDiscipline(this.profile.discipline)) {
        const inPass = gear.pass === true;
        // Pass gear is not bought with credits and does not unlock by level;
        // it arrives with the pass or not at all.
        const owned = inPass ? hasPass : this.profile.ownedGear.includes(gear.id);
        const locked = inPass ? !hasPass : riderLevel < gear.unlockLevel;
        const equipped =
          gear.id === (this.profile.discipline === 'skis' ? this.profile.skiId : this.profile.boardId);
        grid.append(
          el('div', { class: `gear-card${equipped ? ' equipped' : ''}${locked ? ' locked' : ''}` }, [
            el('h4', {}, [gear.name, gear.pass ? el('span', { class: 'pass-tag' }, ['Pass']) : null]),
            el('div', { class: 'gear-brand' }, [gear.brandLine]),
            el('p', {}, [gear.description]),
            el('div', { class: 'spec-grid' }, [
              spec('Length', `${(gear.length * 100).toFixed(0)} cm`),
              spec('Sidecut', `${gear.sidecutRadius.toFixed(1)} m`),
              spec('Waist', `${(gear.waistWidth * 1000).toFixed(0)} mm`),
              spec('Flex', `${Math.round(gear.stiffness * 10)}/10`),
              spec('Camber', gear.camber),
              spec('Swing', `${gear.swingWeight.toFixed(2)}x`),
            ]),
            locked
              ? inPass
                ? el('div', { class: 'locked-note pass-note' }, [
                    'Season One',
                    button('View pass', () => this.show('pass'), 'btn tiny'),
                  ])
                : el('div', { class: 'locked-note' }, [`Unlocks at level ${gear.unlockLevel}`])
              : owned
                ? equipped
                  ? el('div', { class: 'equipped-note' }, ['Equipped'])
                  : button('Equip', () => {
                      this.equip(gear);
                      renderGear();
                    }, 'btn small')
                : button(`Buy · ${formatScore(gear.price)}`, () => {
                    if (this.profile.credits < gear.price) {
                      this.toast('Not enough credits yet.');
                      return;
                    }
                    this.profile.credits -= gear.price;
                    this.profile.ownedGear.push(gear.id);
                    this.equip(gear);
                    renderGear();
                  }, 'btn small'),
          ]),
        );
      }
    };
    renderGear();

    const skins = el('div', { class: 'skin-grid' });
    const renderSkins = () => {
      clear(skins);
      for (const skin of SKINS) {
        const unlocked = skinUnlocked(skin, hasPass);
        const worn = this.profile.skinId === skin.id;
        skins.append(
          el('button', {
            class: `skin${worn ? ' worn' : ''}${unlocked ? '' : ' locked'}`,
            type: 'button',
            title: unlocked ? skin.note : 'Comes with Season One',
            onclick: () => {
              if (!unlocked) {
                this.show('pass');
                return;
              }
              this.wearSkin(skin);
              renderSkins();
            },
          }, [
            swatch(skin),
            el('span', { class: 'skin-name' }, [skin.name]),
            skin.pass ? el('span', { class: 'pass-tag' }, ['Pass']) : null,
          ]),
        );
      }
    };
    renderSkins();

    const appearance = el('div', { class: 'appearance' }, [
      el('h3', {}, ['Kit']),
      skins,
      el('p', { class: 'help' }, ['Pick a kit, or mix your own below.']),
      colorField('Jacket', this.profile.appearance.jacket, (v) => this.setColor('jacket', v)),
      colorField('Pants', this.profile.appearance.pants, (v) => this.setColor('pants', v)),
      colorField('Helmet', this.profile.appearance.helmet, (v) => this.setColor('helmet', v)),
      colorField('Goggles', this.profile.appearance.goggles, (v) => this.setColor('goggles', v)),
      colorField('Base', this.profile.appearance.board, (v) => this.setColor('board', v)),
    ]);

    const nameInput = el('input', {
      type: 'text',
      value: this.profile.name,
      maxlength: 18,
      class: 'code-input',
      oninput: (e: Event) => {
        this.profile.name = (e.target as HTMLInputElement).value.slice(0, 18) || 'rider';
        this.handlers.onProfileChanged();
      },
    });

    return el('div', { class: 'screen' }, [
      this.backBar(),
      this.header('Garage', 'Every figure below is used by the simulation.'),
      el('div', { class: 'row' }, [
        el('label', { class: 'field' }, [el('span', { class: 'field-label' }, ['NAME']), nameInput]),
        el('div', { class: 'field' }, [
          el('span', { class: 'field-label' }, ['DISCIPLINE']),
          segmented<Discipline>(
            [
              { value: 'snowboard', label: 'Snowboard' },
              { value: 'skis', label: 'Skis' },
            ],
            this.profile.discipline,
            (d) => {
              this.profile.discipline = d;
              this.handlers.onProfileChanged();
              this.show('gear');
            },
          ),
        ]),
        el('div', { class: 'field' }, [
          el('span', { class: 'field-label' }, ['STANCE']),
          segmented(
            [
              { value: 'regular', label: 'Regular' },
              { value: 'goofy', label: 'Goofy' },
            ],
            this.profile.goofy ? 'goofy' : 'regular',
            (v) => {
              this.profile.goofy = v === 'goofy';
              this.handlers.onProfileChanged();
            },
          ),
        ]),
      ]),
      slider('Rider weight', {
        min: 45,
        max: 120,
        step: 1,
        value: this.profile.riderMass,
        format: (v) => `${v.toFixed(0)} kg`,
        onInput: (v) => {
          this.profile.riderMass = v;
          this.handlers.onProfileChanged();
        },
      }),
      appearance,
      grid,
    ]);
  }

  private equip(gear: GearSpec): void {
    if (gear.discipline === 'skis') this.profile.skiId = gear.id;
    else this.profile.boardId = gear.id;
    this.handlers.onProfileChanged();
  }

  private setColor(key: keyof Profile['appearance'], value: string): void {
    this.profile.appearance[key] = value;
    this.handlers.onProfileChanged();
  }

  private buildSettings(): HTMLElement {
    return el('div', { class: 'screen' }, [
      this.backBar(),
      this.header('Settings'),
      el('div', { class: 'settings-block' }, [
        el('h3', {}, ['Realism']),
        el('p', { class: 'help' }, [
          'The simulation is the same at every setting. This only changes how much the rider ' +
            'corrects for you — holding an edge, squaring up on landing and staying on a rail.',
        ]),
        slider('Assist', {
          min: 0,
          max: 1,
          step: 0.05,
          value: this.profile.assist,
          format: (v) => (v < 0.05 ? 'Raw' : v < 0.4 ? 'Authentic' : v < 0.75 ? 'Assisted' : 'Relaxed'),
          onInput: (v) => {
            this.profile.assist = v;
            this.handlers.onProfileChanged();
          },
        }),
      ]),
      el('div', { class: 'settings-block' }, [
        el('h3', {}, ['Performance']),
        el('div', { class: 'field' }, [
          el('span', { class: 'field-label' }, ['QUALITY']),
          segmented(
            [
              { value: 'low', label: 'Low' },
              { value: 'medium', label: 'Medium' },
              { value: 'high', label: 'High' },
            ],
            this.profile.quality,
            (v) => {
              this.profile.quality = v as Profile['quality'];
              this.handlers.onProfileChanged();
            },
          ),
        ]),
        el('div', { class: 'field' }, [
          el('span', { class: 'field-label' }, ['CAMERA']),
          segmented<CameraMode>(
            CAMERA_MODES.map((m) => ({ value: m, label: CAMERA_LABELS[m] })),
            'chase',
            (m) => this.handlers.onCameraMode(m),
          ),
        ]),
      ]),
      el('div', { class: 'settings-block' }, [
        el('h3', {}, ['Sound']),
        el('p', { class: 'help' }, [
          'Every sound is synthesised as you ride — the pitch of your edge tracks ' +
            'how hard it is loaded, and the spray tracks how much it is slipping. ' +
            'There are no audio files.',
        ]),
        slider('Volume', {
          min: 0,
          max: 1,
          step: 0.05,
          value: this.profile.masterVolume,
          format: (v) => (v <= 0.001 ? 'off' : `${Math.round(v * 100)}%`),
          onInput: (v) => {
            this.profile.masterVolume = v;
            this.handlers.onProfileChanged();
          },
        }),
      ]),
      el('div', { class: 'settings-block' }, [
        el('h3', {}, ['Controls']),
        el('p', { class: 'help' }, [
          'Touch: one thumb steers — drag left and right to lean, down to load your legs, ' +
            'release to pop. In the air the same drag spins and flips. A second finger grabs; ' +
            'drag it to pick which grab.',
        ]),
        el('p', { class: 'help' }, [
          'Keyboard: A/D lean · W/S weight · Q/E wind up rotation · Space load and pop · ' +
            'F plant a pole · Shift tuck · Z X C V G H grabs · R reset · T camera · P photo.',
        ]),
      ]),
      el('div', { class: 'settings-block' }, [
        el('h3', {}, ['Leaderboard']),
        this.buildScoreTable(),
      ]),
    ]);
  }

  private buildScoreTable(): HTMLElement {
    const scores = loadScores().slice(0, 12);
    if (scores.length === 0) return el('p', { class: 'empty' }, ['No runs recorded yet.']);
    return el('table', { class: 'scores' }, [
      el('thead', {}, [
        el('tr', {}, [
          el('th', {}, ['Mountain']),
          el('th', {}, ['Mode']),
          el('th', {}, ['Score']),
          el('th', {}, ['Best trick']),
        ]),
      ]),
      el(
        'tbody',
        {},
        scores.map((s) =>
          el('tr', {}, [
            el('td', {}, [s.levelName]),
            el('td', {}, [MODE_LABELS[s.mode as GameMode] ?? s.mode]),
            el('td', {}, [formatScore(s.score)]),
            el('td', {}, [s.bestTrick || '—']),
          ]),
        ),
      ),
    ]);
  }

  private buildResults(): HTMLElement {
    const s = this.lastSummary;
    if (!s) return el('div', { class: 'screen' }, [this.backBar(), this.header('No run recorded')]);
    const landed = s.tricks.filter((t) => t.landed);
    const best = [...landed].sort((a, b) => b.points - a.points)[0];

    return el('div', { class: 'screen results' }, [
      this.header('Run complete', this.lastLevel?.name ?? ''),
      el('div', { class: 'big-score' }, [formatScore(s.score)]),
      el('div', { class: 'stat-grid' }, [
        spec('Best trick', best ? best.name : '—'),
        spec('Best combo', `${s.bestCombo.toFixed(1)}x`),
        spec('Tricks landed', String(landed.length)),
        spec('Bails', String(s.bails)),
        spec('Top speed', `${(s.topSpeed * 3.6).toFixed(0)} km/h`),
        spec('Biggest air', `${s.biggestAir.toFixed(1)} m`),
        spec('Longest grind', `${s.longestGrind.toFixed(1)} m`),
        spec('Distance', `${s.distance.toFixed(0)} m`),
        spec('Time', formatTime(s.elapsed)),
        s.gatesTotal > 0 ? spec('Gates', `${s.gatesHit}/${s.gatesTotal}`) : null,
      ]),
      landed.length > 0
        ? el('div', { class: 'trick-log' }, [
            el('h3', {}, ['Trick log']),
            ...landed
              .slice(-14)
              .reverse()
              .map((t) =>
                el('div', { class: 'trick-row' }, [
                  el('span', { class: 'trick-name' }, [t.name]),
                  el('span', { class: 'trick-points' }, [formatScore(t.points)]),
                ]),
              ),
          ])
        : null,
      el('div', { class: 'result-actions' }, [
        button('Ride again', () => this.handlers.onRestart()),
        button('Watch replay', () => {
          const replays = loadReplays();
          if (replays[0]) this.handlers.onWatchReplay(replays[0]);
          else this.toast('No replay saved for that run.');
        }, 'btn ghost'),
        button('Menu', () => this.handlers.onQuitToMenu(), 'btn ghost'),
      ]),
    ]);
  }

  private buildPause(): HTMLElement {
    // A pause screen that only lists four buttons tells you nothing about the
    // run you stopped. Show where you are and how it is going.
    const s = this.lastSummary;
    return el('div', { class: 'screen pause' }, [
      el('div', { class: 'pause-head' }, [
        el('span', { class: 'pause-eyebrow' }, ['Paused']),
        el('h1', {}, [this.lastLevel?.name ?? 'Free ride']),
      ]),
      s
        ? el('div', { class: 'pause-stats' }, [
            stat(formatTime(s.elapsed), 'Elapsed'),
            stat(formatScore(s.score), 'Score'),
            stat(`${Math.round(s.topSpeed * 3.6)} km/h`, 'Top speed'),
            stat(String(s.tricks.length), 'Tricks'),
          ])
        : null,
      el('div', { class: 'pause-actions' }, [
        button('Resume', () => this.handlers.onResume()),
        button('Restart run', () => this.handlers.onRestart(), 'btn link'),
        button('Settings', () => this.show('settings'), 'btn link'),
        button('Quit to menu', () => this.handlers.onQuitToMenu(), 'btn ghost'),
      ]),
    ]);
  }

  private buildReplays(): HTMLElement {
    const replays = loadReplays();
    const list = el('div', { class: 'level-list' });
    if (replays.length === 0) list.append(el('p', { class: 'empty' }, ['No replays saved yet.']));
    for (const replay of replays) {
      list.append(
        el('div', { class: 'level-card saved' }, [
          el('h4', {}, [replay.meta.label || replay.meta.levelName]),
          el('p', {}, [
            `${formatScore(replay.meta.score)} pts · ${replay.meta.duration.toFixed(0)}s · ` +
              new Date(replay.meta.recordedAt).toLocaleString(),
          ]),
          el('div', { class: 'card-actions' }, [
            button('Watch', () => this.handlers.onWatchReplay(replay), 'btn small'),
            button('Delete', () => {
              deleteReplay(replay.meta.recordedAt);
              this.show('replays');
            }, 'btn small danger'),
          ]),
        ]),
      );
    }
    return el('div', { class: 'screen' }, [
      this.backBar(),
      this.header('Replays'),
      list,
    ]);
  }

  private buildMultiplayer(): HTMLElement {
    const roomInput = el('input', { type: 'text', class: 'code-input', placeholder: 'Room name', value: 'bluebird' });
    const roster = el('div', { class: 'roster' });
    const renderRoster = () => {
      clear(roster);
      roster.append(el('h3', {}, [`In session (${this.roster.length})`]));
      if (this.roster.length === 0) roster.append(el('p', { class: 'empty' }, ['Nobody else here yet.']));
      for (const player of this.roster) {
        roster.append(el('div', { class: 'roster-row' }, [player.name]));
      }
    };
    renderRoster();

    return el('div', { class: 'screen' }, [
      this.backBar(),
      this.header('Sessions'),
      el('p', { class: 'help' }, [
        'Everyone in a room rides the level the first player joined on. Run the bundled ' +
          'server with npm run server, or point at your own with ?server=.',
      ]),
      el('div', { class: 'import-row' }, [
        roomInput,
        button('Join', () => this.handlers.onJoinRoom(roomInput.value.trim() || 'bluebird', this.profile.name), 'btn small'),
        button('Leave', () => this.handlers.onLeaveRoom(), 'btn small ghost'),
      ]),
      el('div', { class: 'status-line' }, [`Status: ${this.connectionStatus}`]),
      roster,
    ]);
  }

  // -------------------------------------------------------------------------

  /**
   * Backdrop picker.
   *
   * The picture is stored inside the level as inline image data, so it travels
   * with the level and works offline. That also means it costs storage, which
   * is why the size is shown rather than hidden.
   */
  private buildBackdropSection(level: LevelDef): HTMLElement {
    const backdrop = level.backdrop;
    const file = el('input', {
      type: 'file',
      accept: 'image/png,image/jpeg,image/webp',
      class: 'file-input',
      onchange: async (e: Event) => {
        const input = e.target as HTMLInputElement;
        const picked = input.files?.[0];
        if (!picked) return;
        try {
          const image = await readBackdropImage(picked);
          level.backdrop = { ...(level.backdrop ?? defaultBackdrop(image.url)), image: image.url };
          this.onWeatherChanged?.();
          this.toast(`Backdrop set — ${image.width}x${image.height}, ${formatBytes(image.bytes)}`);
          this.refreshEditorPanel();
        } catch (err) {
          this.toast(err instanceof Error ? err.message : 'Could not read that image.');
        } finally {
          input.value = '';
        }
      },
    });

    const body: Array<Node | null> = [
      el('span', { class: 'field-label' }, ['Backdrop']),
      el('label', { class: 'file-drop' }, [file, el('span', {}, [backdrop ? 'Replace picture' : 'Choose a picture'])]),
    ];

    if (backdrop) {
      const preview = el('div', { class: 'backdrop-preview' });
      preview.style.backgroundImage = `url("${backdrop.image}")`;
      const set = (patch: Partial<NonNullable<LevelDef['backdrop']>>) => {
        if (!level.backdrop) return;
        level.backdrop = { ...level.backdrop, ...patch };
        this.onWeatherChanged?.();
      };
      body.push(
        preview,
        el('div', { class: 'backdrop-size' }, [formatBytes(backdrop.image.length)]),
        slider('Strength', {
          min: 0,
          max: 1,
          step: 0.02,
          value: backdrop.opacity,
          format: (v) => v.toFixed(2),
          onInput: (v) => set({ opacity: v }),
        }),
        slider('Turn', {
          min: -180,
          max: 180,
          step: 1,
          value: backdrop.rotation,
          format: (v) => `${v.toFixed(0)}°`,
          onInput: (v) => set({ rotation: v }),
        }),
        slider('Horizon', {
          min: 0,
          max: 1,
          step: 0.01,
          value: backdrop.horizon,
          format: (v) => v.toFixed(2),
          onInput: (v) => set({ horizon: v }),
        }),
        slider('Zoom', {
          min: 0.3,
          max: 3,
          step: 0.05,
          value: backdrop.scale,
          format: (v) => `${v.toFixed(2)}x`,
          onInput: (v) => set({ scale: v }),
        }),
        el('p', { class: 'help' }, ['Sits around the horizon; the painted sky takes over overhead. Share codes leave it out.']),
        button('Remove picture', () => {
          level.backdrop = null;
          this.onWeatherChanged?.();
          this.refreshEditorPanel();
        }, 'btn small danger'),
      );
    }

    return el('div', { class: 'editor-backdrop' }, body);
  }

  private buildEditorPanel(): HTMLElement {
    const editor = this.editor;
    if (!editor) return el('div', { class: 'screen' }, [this.header('No level open')]);
    const level = editor.level;

    const tools: Array<{ value: EditorTool; label: string }> = [
      { value: 'select', label: 'Select' },
      { value: 'place', label: 'Place' },
      { value: 'raise', label: 'Raise' },
      { value: 'lower', label: 'Lower' },
      { value: 'smooth', label: 'Smooth' },
      { value: 'spawn', label: 'Start' },
    ];

    const kinds = ['kicker', 'rail', 'box', 'roller', 'quarterpipe', 'halfpipe', 'hip', 'wallride', 'gate', 'prop'] as const;

    const props = el('div', { class: 'props' });
    const renderProps = () => {
      clear(props);
      const feature = editor.selected;
      if (!feature) {
        props.append(el('p', { class: 'empty' }, ['Nothing selected. Tap a feature on the hill.']));
        return;
      }
      props.append(el('h3', {}, [feature.kind === 'prop' ? itemLabel(feature.prop) : feature.kind]));
      if (feature.kind === 'prop') {
        props.append(
          el('div', { class: 'kind-grid swap' }, PROP_KINDS.map((item) =>
            button(itemLabel(item), () => {
              editor.updateSelected({ prop: item });
              renderProps();
            }, `btn tiny${feature.prop === item ? ' on' : ''}`),
          )),
        );
      }
      for (const field of LevelEditor.editableFields(feature)) {
        const current = Number((feature as unknown as Record<string, number>)[field.key] ?? 0);
        props.append(
          slider(field.label, {
            min: field.min,
            max: field.max,
            step: field.step,
            value: current,
            format: (v) => v.toFixed(field.step < 1 ? 2 : 0),
            onInput: (v) => editor.updateSelected({ [field.key]: v }),
          }),
        );
      }
      props.append(
        el('div', { class: 'card-actions' }, [
          button('Duplicate', () => {
            editor.duplicateSelected();
            renderProps();
          }, 'btn small ghost'),
          button('Delete', () => {
            editor.deleteSelected();
            renderProps();
          }, 'btn small danger'),
        ]),
      );
    };
    renderProps();
    this.renderEditorProps = renderProps;

    return el('div', { class: 'editor-panel' }, [
      el('div', { class: 'editor-head' }, [
        el('input', {
          type: 'text',
          class: 'code-input',
          value: level.name,
          oninput: (e: Event) => {
            level.name = (e.target as HTMLInputElement).value || 'Untitled Line';
          },
        }),
        button('Ride it', () => this.handlers.onEditorPlay(), 'btn small'),
        button('Save', () => this.handlers.onEditorSave(), 'btn small ghost'),
      ]),
      el('div', { class: 'editor-tools' }, [
        segmented<EditorTool>(tools, editor.tool, (t) => {
          editor.tool = t;
        }),
      ]),
      el('div', { class: 'editor-kinds' }, [
        el('span', { class: 'field-label' }, ['Place']),
        el('div', { class: 'kind-grid' }, kinds.map((kind) =>
          button(kind, () => {
            editor.placeKind = kind;
            editor.tool = 'place';
            this.refreshEditorPanel();
          }, `btn tiny${editor.placeKind === kind ? ' on' : ''}`),
        )),
        // The item palette only makes sense once 'prop' is the thing being
        // placed, so it appears with it rather than sitting there greyed out.
        editor.placeKind === 'prop'
          ? el('div', { class: 'item-picker' }, [
              el('span', { class: 'field-label' }, ['Item']),
              el('div', { class: 'kind-grid' }, PROP_KINDS.map((item) =>
                button(itemLabel(item), () => {
                  editor.placeProp = item;
                  this.refreshEditorPanel();
                }, `btn tiny${editor.placeProp === item ? ' on' : ''}`),
              )),
            ])
          : null,
      ]),
      this.buildBackdropSection(level),
      el('div', { class: 'editor-brush' }, [
        slider('Brush size', {
          min: 2,
          max: 40,
          step: 0.5,
          value: editor.brush.radius,
          format: (v) => `${v.toFixed(1)} m`,
          onInput: (v) => {
            editor.brush.radius = v;
          },
        }),
        slider('Brush strength', {
          min: 0.1,
          max: 4,
          step: 0.1,
          value: editor.brush.strength,
          onInput: (v) => {
            editor.brush.strength = v;
          },
        }),
      ]),
      el('div', { class: 'editor-terrain' }, [
        slider('Slope', {
          min: 4,
          max: 45,
          step: 0.5,
          value: level.terrain.slopeAngle,
          format: (v) => `${v.toFixed(1)}°`,
          onInput: (v) => {
            level.terrain.slopeAngle = v;
            this.rebakeAll();
          },
        }),
        slider('Roughness', {
          min: 0,
          max: 14,
          step: 0.2,
          value: level.terrain.roughness,
          onInput: (v) => {
            level.terrain.roughness = v;
            this.rebakeAll();
          },
        }),
        slider('Snow hardness', {
          min: 0,
          max: 1,
          step: 0.02,
          value: level.snow.hardness,
          format: (v) => (v < 0.25 ? 'powder' : v < 0.55 ? 'soft' : v < 0.8 ? 'packed' : 'ice'),
          onInput: (v) => {
            level.snow.hardness = v;
            this.onWeatherChanged?.();
          },
        }),
        slider('Time of day', {
          min: 5,
          max: 20,
          step: 0.25,
          value: level.weather.timeOfDay,
          format: (v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`,
          onInput: (v) => {
            level.weather.timeOfDay = v;
            this.onWeatherChanged?.();
          },
        }),
        slider('Cloud', {
          min: 0,
          max: 1,
          step: 0.02,
          value: level.weather.cloud,
          onInput: (v) => {
            level.weather.cloud = v;
            this.onWeatherChanged?.();
          },
        }),
        slider('Snowfall', {
          min: 0,
          max: 1,
          step: 0.02,
          value: level.weather.snowfall,
          onInput: (v) => {
            level.weather.snowfall = v;
            this.onSnowfallChanged?.();
          },
        }),
        toggle('Groomed', level.snow.groomed, (v) => {
          level.snow.groomed = v;
          this.onWeatherChanged?.();
        }),
      ]),
      props,
      el('div', { class: 'editor-foot' }, [
        button('Undo', () => {
          editor.undo();
          renderProps();
        }, 'btn small ghost'),
        button('Redo', () => {
          editor.redo();
          renderProps();
        }, 'btn small ghost'),
        button('Auto-fill', () => {
          editor.autoFill();
          renderProps();
        }, 'btn small ghost'),
        button('Clear', () => {
          editor.clearFeatures();
          renderProps();
        }, 'btn small danger'),
        button('Share code', async () => {
          const code = await encodeLevelCode(editor.export());
          await copyToClipboard(code);
          this.toast('Share code copied');
        }, 'btn small ghost'),
        button('Exit', () => this.handlers.onQuitToMenu(), 'btn small ghost'),
      ]),
    ]);
  }

  /** Set by the app so terrain-wide edits can trigger a full rebuild. */
  onRebakeAll: (() => void) | null = null;
  onWeatherChanged: (() => void) | null = null;
  onSnowfallChanged: (() => void) | null = null;
  renderEditorProps: (() => void) | null = null;

  private rebakeAll(): void {
    this.onRebakeAll?.();
  }
}

function spec(label: string, value: string): HTMLElement {
  return el('div', { class: 'spec' }, [
    el('span', { class: 'spec-label' }, [label]),
    el('span', { class: 'spec-value' }, [value]),
  ]);
}

/**
 * Piste difficulty, in the symbols every resort on earth already uses: a green
 * circle, a blue square, a black diamond, a double diamond. A player who skis
 * reads these instantly, and nobody needs the word "INTERMEDIATE" spelled out.
 */
function pisteMark(difficulty: string): HTMLElement {
  const variant = difficulty === 'green' ? '' : difficulty === 'blue' ? 'blue' : difficulty === 'black' ? 'black' : 'double';
  const pips = difficulty === 'double' ? 2 : 1;
  return el(
    'div',
    { class: `piste ${variant}`.trim(), title: difficulty },
    Array.from({ length: pips }, () => el('i', {})),
  );
}

/** Four colour chips off a kit, so it reads at a glance. */
function swatch(skin: Skin): HTMLElement {
  return el('span', { class: 'swatch' }, [
    el('i', { style: `background:${skin.appearance.jacket}` }),
    el('i', { style: `background:${skin.appearance.pants}` }),
    el('i', { style: `background:${skin.appearance.helmet}` }),
    el('i', { style: `background:${skin.appearance.board}` }),
  ]);
}

function passTerm(title: string, body: string): HTMLElement {
  return el('div', { class: 'pass-term' }, [
    el('strong', {}, [title]),
    el('span', {}, [body]),
  ]);
}

/** Turns a camelCase item id into something readable. */
function itemLabel(kind: PropKind): string {
  return kind.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

/** Figure over label, for the run stats on a level card. */
function stat(value: string, label: string): HTMLElement {
  return el('div', { class: 'card-stat' }, [
    el('span', { class: 'card-stat-value' }, [value]),
    el('span', { class: 'card-stat-label' }, [label]),
  ]);
}

async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard access is often blocked; fall back to a selectable prompt.
    window.prompt('Copy this code:', text);
  }
}

export { GEAR_CATALOG, getGear };
