import Phaser from 'phaser';
import { ABILITIES, BACKUP_OUT, COFFEE } from '../config';
import { COUCH_POS, DOORS, ROOM_RECTS, STATIONS, STATION_IDS, WORLD as W_SIM, type RoomId, type StationId } from '../sim/house';
import { REQUEST_LABEL, Sim, clockString, type ActorId, type Request, type SimEvent } from '../sim/sim';
import type { World3D } from '../three/World3D';
import { drawIcon, drawMomFace } from './art';
import { ABIL, ABILITY_R, COLORS, FONT, H, HUD, PANEL, PAUSE, STICK, W, WORLD, inWorld } from './layout';
import { ActionPanel } from './panel';

export interface SceneHooks {
  sfx: (name: string) => void;
  haptic: (p: number | number[]) => void;
  gameOver: (sim: Sim) => void;
  won: (sim: Sim) => void;
  pause: () => void;
}

type Pt = { x: number; y: number };


interface BubbleView {
  c: Phaser.GameObjects.Container;
  pos: Pt; // screen
}

const PLATE_ICON: Partial<Record<StationId, string>> = {
  coffee: 'coffee',
  snacks: 'snack',
  juice: 'juice_box',
  sippy: 'sippy_cup',
  bandaids: 'bandaid',
  thermostat: 'thermostat',
};

const MOVE_KEYS: Record<string, [number, number]> = {
  KeyW: [0, -1],
  KeyA: [-1, 0],
  KeyS: [0, 1],
  KeyD: [1, 0],
  ArrowUp: [0, -1],
  ArrowLeft: [-1, 0],
  ArrowDown: [0, 1],
  ArrowRight: [1, 0],
};

export class GameScene extends Phaser.Scene {
  sim!: Sim;
  hooks!: SceneHooks;
  readonly R: number;
  running = false;
  timeScale = 1; // tests only

  private dyn!: Phaser.GameObjects.Graphics; // highlights, rings, finger marker
  private top!: Phaser.GameObjects.Graphics; // HUD + ability buttons
  private fxTop!: Phaser.GameObjects.Graphics; // freeze tint, alarm flash
  world?: World3D; // the 3D house + camera (set by main.ts)
  private speech = new Map<ActorId, Phaser.GameObjects.Text>();
  private chips = new Map<StationId, Phaser.GameObjects.Container>();
  private bubbles = new Map<number, BubbleView>();
  private panel!: ActionPanel;
  private clockText!: Phaser.GameObjects.Text;
  private chaosText!: Phaser.GameObjects.Text;
  private abilIcons: Phaser.GameObjects.Graphics[] = [];
  private abilLabels: Phaser.GameObjects.Text[] = [];
  private toastText!: Phaser.GameObjects.Text;
  private toastT = 0;
  private textBanner!: Phaser.GameObjects.Container;
  private textBg!: Phaser.GameObjects.Graphics;
  private textFrom!: Phaser.GameObjects.Text;
  private textBody!: Phaser.GameObjects.Text;
  private textQueue: { from: string; body: string }[] = [];
  private textT = 0;
  private jokeCard!: Phaser.GameObjects.Container;
  private jokeText!: Phaser.GameObjects.Text;
  private momWin!: Phaser.GameObjects.Container;
  private momTime!: Phaser.GameObjects.Text;
  private uhHuh!: Phaser.GameObjects.Container;
  private shhText!: Phaser.GameObjects.Text;
  private zzz!: Phaser.GameObjects.Text;
  private selectBanner!: Phaser.GameObjects.Text;
  private alarmT = 0;
  private alarmText!: Phaser.GameObjects.Text;
  private weekText!: Phaser.GameObjects.Text;
  private now = 0;
  private lastNow = 0;
  private roles = new Map<number, 'stick' | 'panel'>();
  private stickDir: Pt | null = null;
  private stickKnob: Pt = { x: 0, y: 0 }; // knob offset from the stick's center
  private stickG!: Phaser.GameObjects.Graphics;
  private keysDown = new Set<string>();

  constructor() {
    super('game');
    this.R = Math.max(1, Math.min(window.devicePixelRatio || 1, 3));
  }

  txt = (
    x: number,
    y: number,
    s: string,
    size: number,
    color = '#22223b',
    style: Phaser.Types.GameObjects.Text.TextStyle = {},
  ): Phaser.GameObjects.Text =>
    this.add.text(x, y, s, { fontFamily: FONT, fontSize: `${size}px`, color, resolution: this.R, ...style });

  create() {
    const cam = this.cameras.main;
    cam.setOrigin(0, 0);
    cam.setZoom(this.R);
    // Transparent: the 3D view (a canvas underneath) shows through the world rectangle.

    this.dyn = this.add.graphics().setDepth(28);
    this.buildChips();
    for (const id of ['evelyn', 'nora', 'tyler', 'eloise'] as const)
      this.speech.set(
        id,
        this.txt(0, 0, '', 11, '#22223b', { backgroundColor: '#ffffff', padding: { x: 5, y: 2 }, fontStyle: 'bold' })
          .setOrigin(0.5, 1)
          .setDepth(36)
          .setVisible(false),
      );

    this.shhText = this.txt(0, 0, 'Shhh', 10, '#ffffff', { fontStyle: 'bold' }).setOrigin(0.5).setDepth(31).setVisible(false);
    this.zzz = this.txt(0, 0, 'z Z z', 12, '#3d405b', { fontStyle: 'bold' }).setOrigin(0.5).setDepth(31).setVisible(false);

    this.top = this.add.graphics().setDepth(60);
    this.buildHud();
    this.buildAbilities();
    this.panel = new ActionPanel(this, () => this.sim, this.txt);
    this.panel.onCancelSelect = () => (this.panel.selectMode = false);
    this.events.on('panel-sfx', (n: string) => this.hooks?.sfx(n));

    this.fxTop = this.add.graphics().setDepth(65);
    this.stickG = this.add.graphics().setDepth(55);
    this.buildOverlays();

    // Two thumbs: one on the joystick, one on the action card. Each pointer keeps the role it started with.
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      const w = cam.getWorldPoint(p.x, p.y);
      this.onDown(p.id, w.x, w.y);
    });
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => {
      if (!p.isDown) return;
      const w = cam.getWorldPoint(p.x, p.y);
      const role = this.roles.get(p.id);
      if (role === 'stick') this.stickTo(w.x, w.y);
      else if (role === 'panel') this.panel.pointerMove(w.x, w.y);
    });
    const up = (p: Phaser.Input.Pointer) => {
      const w = cam.getWorldPoint(p.x, p.y);
      this.onUp(p.id, w.x, w.y);
    };
    this.input.on('pointerup', up);
    this.input.on('pointerupoutside', up);
    this.input.on('gameout', () => this.releaseInput());

    this.input.keyboard?.on('keydown', (e: KeyboardEvent) => this.onKey(e, true));
    this.input.keyboard?.on('keyup', (e: KeyboardEvent) => this.onKey(e, false));

    this.sim = new Sim(1);
    this.relayout();
    this.game.events.emit('scene-ready');
  }

  // ------------------------------------------------------------ run control
  startRun(seed: number, week = 1) {
    this.sim = new Sim(seed, week);
    this.running = true;
    this.panel.selectMode = false;
    this.roles.clear();
    this.stickDir = null;
    this.stickKnob = { x: 0, y: 0 };
    this.keysDown.clear();
    this.weekText.setText(`WEEK ${week} · GAME NIGHT 5:00`);
    this.textQueue = [];
    this.textT = 0;
    this.toastT = 0;
    this.alarmT = 0;
    this.textBanner.setVisible(false);
    this.toastText.setVisible(false);
    this.jokeCard.setVisible(false);
    for (const b of this.bubbles.values()) b.c.destroy();
    this.bubbles.clear();
    this.world?.sync(this.sim, 0, 0);
  }

  // Called when the game pauses: let go of everything held.
  releaseInput() {
    this.roles.clear();
    this.stickDir = null;
    this.stickKnob = { x: 0, y: 0 };
    this.keysDown.clear();
    this.sim?.setMoveTarget(null);
    this.sim?.setMoveDir(null);
    this.panel?.pointerUp(-1, -1);
  }

  update(_t: number, _deltaMs: number) {
    if (!this.sim) return;
    // Wall-clock dt: 1 real second must be 1 game minute even when frames are slow
    // (Phaser's own delta is smoothed and clamped). Long gaps are capped; the game pauses on hide.
    const nowMs = performance.now();
    const dt = this.lastNow ? Math.min((nowMs - this.lastNow) / 1000, 0.25) : 0;
    this.lastNow = nowMs;
    const sdt = dt * this.timeScale;
    this.now += dt;
    if (this.running) {
      this.sim.update(sdt);
      this.handleEvents(this.sim.drainEvents());
    }
    if (this.world) {
      this.world.sync(this.sim, this.running ? sdt : 0, this.now, dt);
      this.world.render();
    }
    this.render(dt);
    this.panel.update(this.running ? sdt : 0);
  }

  // ------------------------------------------------------------ input
  private onDown(id: number, x: number, y: number) {
    if (!this.running) return;
    const sim = this.sim;
    if (Math.hypot(x - PAUSE.x, y - PAUSE.y) <= PAUSE.r + 8) return this.hooks.pause();
    const ai = ABIL.findIndex((a) => Math.hypot(x - a.x, y - a.y) <= ABILITY_R + 8);
    if (ai >= 0) return this.useAbility(ai);
    if (sim.facetime.prompt && Math.abs(x - this.uhHuh.x) <= 92 && Math.abs(y - this.uhHuh.y) <= 32) {
      sim.answerUhHuh();
      return;
    }
    // The card (when one is showing) wins over the joystick's generous touch zone where they meet.
    if (this.panel.contains(x, y)) {
      this.roles.set(id, 'panel');
      return this.panel.pointerDown(x, y);
    }
    if (Math.hypot(x - STICK.cx, y - STICK.cy) <= STICK.r + 24) {
      this.roles.set(id, 'stick');
      this.stickTo(x, y);
      return;
    }
    if (inWorld(x, y) && this.panel.selectMode) {
      const b = this.nearestBubble(x, y, 32);
      if (b != null) {
        sim.callBackup(b);
        this.panel.selectMode = false;
      }
    }
  }

  // Virtual joystick: Nick walks the way the knob points (any angle). Small dead zone in the middle.
  private stickTo(x: number, y: number) {
    const dx = x - STICK.cx;
    const dy = y - STICK.cy;
    const d = Math.hypot(dx, dy);
    const k = d > STICK.r ? STICK.r / d : 1;
    this.stickKnob = { x: dx * k, y: dy * k };
    const dir = d >= 12 ? { x: dx / d, y: dy / d } : null;
    if (dir && !this.stickDir) this.hooks?.haptic(6);
    this.stickDir = dir;
    this.applyMove();
  }

  private applyMove() {
    if (this.stickDir) return this.sim.setMoveDir(this.stickDir);
    let dx = 0;
    let dy = 0;
    for (const k of this.keysDown) {
      dx += MOVE_KEYS[k][0];
      dy += MOVE_KEYS[k][1];
    }
    this.sim.setMoveDir(dx || dy ? { x: dx, y: dy } : null);
  }

  private onUp(id: number, x: number, y: number) {
    const role = this.roles.get(id);
    this.roles.delete(id);
    if (role === 'stick') {
      this.stickDir = null;
      this.stickKnob = { x: 0, y: 0 };
      this.applyMove();
    } else if (role === 'panel') this.panel.pointerUp(x, y);
  }

  useAbility(i: number) {
    const sim = this.sim;
    if (!this.running) return;
    if (i === 0) sim.dadJoke();
    else if (i === 1) {
      if (sim.backupCharges <= 0) return this.toast(BACKUP_OUT);
      if (!sim.requests.length) return this.toast('Nothing to hand off. Yet.');
      this.panel.selectMode = !this.panel.selectMode;
      this.hooks.sfx('tap');
    } else if (i === 2) sim.becauseISaidSo();
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (!this.running) return;
    const it = this.sim.interaction;
    // Arrows belong to the panel while a swipe or rub is up; WASD always walks.
    const panelArrows = !!it && (it.kind === 'swipe' || it.kind === 'rub') && e.code.startsWith('Arrow');
    if (MOVE_KEYS[e.code] && !panelArrows) {
      if (down) this.keysDown.add(e.code);
      else this.keysDown.delete(e.code);
      this.applyMove();
      e.preventDefault();
      return;
    }
    if (!down) return this.panel.keyUp(e.code);
    if (e.code === 'Digit1' || e.code === 'Numpad1') return this.useAbility(0);
    if (e.code === 'Digit2' || e.code === 'Numpad2') return this.useAbility(1);
    if (e.code === 'Digit3' || e.code === 'Numpad3') return this.useAbility(2);
    if (e.code === 'KeyU' && this.sim.answerUhHuh()) return;
    if (this.panel.keyDown(e.code, e.repeat)) e.preventDefault();
  }

  private nearestBubble(x: number, y: number, r: number): number | null {
    let best: number | null = null;
    let bd = r;
    for (const [id, b] of this.bubbles) {
      const d = Math.hypot(b.pos.x - x, b.pos.y - y);
      if (d <= bd) {
        bd = d;
        best = id;
      }
    }
    return best;
  }

  // ------------------------------------------------------------ events
  private handleEvents(evs: SimEvent[]) {
    for (const e of evs) {
      switch (e.type) {
        case 'toast':
          this.toast(e.text);
          break;
        case 'text':
          this.textQueue.push({ from: e.from, body: e.body });
          break;
        case 'sfx':
          this.hooks.sfx(e.name);
          break;
        case 'haptic':
          this.hooks.haptic(e.pattern);
          break;
        case 'shake':
          // Phaser scales shake by camera zoom; divide it back out.
          this.cameras.main.shake(450, (e.strength * 0.6) / this.R);
          if (e.strength > 0.008) this.alarmT = 2.2;
          break;
        case 'joke':
          this.jokeText.setText(e.text);
          this.jokeCard.setVisible(true).setAlpha(0).setScale(0.9);
          this.tweens.add({ targets: this.jokeCard, alpha: 1, scale: 1, duration: 160, ease: 'Back.easeOut' });
          break;
        case 'expired':
          this.popBubble(e.req.id, false);
          break;
        case 'resolved':
          this.popBubble(e.req.id, true);
          break;
        case 'won':
          this.running = false;
          this.releaseInput();
          this.panel.selectMode = false;
          window.setTimeout(() => this.hooks.won(this.sim), 700);
          break;
        case 'gameover':
          this.running = false;
          this.releaseInput();
          this.panel.selectMode = false;
          // Real-time delay (the scene clock crawls if frames are slow).
          window.setTimeout(() => this.hooks.gameOver(this.sim), 900);
          break;
      }
    }
  }

  toast(text: string) {
    this.toastText.setText(text).setVisible(true).setAlpha(1);
    this.toastT = 2.4;
  }

  private popBubble(id: number, good: boolean) {
    const b = this.bubbles.get(id);
    if (!b) return;
    this.bubbles.delete(id);
    this.tweens.add({
      targets: b.c,
      scale: good ? 1.4 : 0.6,
      alpha: 0,
      y: b.c.y - (good ? 14 : -6),
      duration: 260,
      onComplete: () => b.c.destroy(),
    });
  }

  // ------------------------------------------------------------ build
  // Floating icon chips over stations, room name tags, and "?" marks for shoe spots,
  // all placed each frame by projecting from the 3D camera.
  private buildChips() {
    for (const s of STATION_IDS) {
      const icon = PLATE_ICON[s] ?? (s === 'grill' ? 'burger' : s === 'door' ? 'paw' : s.startsWith('spot_') ? 'shoe' : s === 'highchair' || s === 'playpen' ? 'nora' : '');
      if (!icon) continue;
      const g = this.add.graphics();
      g.fillStyle(0x000000, 0.18).fillCircle(1, 2, 12);
      g.fillStyle(0xffffff, 0.95).fillCircle(0, 0, 12);
      const ic = this.add.graphics();
      drawIcon(ic, icon, 15);
      const q = this.txt(0, -1, '?', 13, '#22223b', { fontStyle: 'bold' }).setOrigin(0.5).setVisible(false).setName('q');
      this.chips.set(s, this.add.container(0, 0, [g, ic, q]).setDepth(20));
    }
  }

  private buildHud() {
    this.clockText = this.txt(12, 4, '9:00 AM', 28, '#ffffff', { fontStyle: 'bold' }).setDepth(61);
    this.weekText = this.txt(14, 40, 'WEEK 1 · GAME NIGHT 5:00', 9, '#ffd166', { fontStyle: 'bold' }).setDepth(61);
    this.txt(176, 4, 'CHAOS', 9, '#c9cbe6', { fontStyle: 'bold' }).setDepth(61);
    this.chaosText = this.txt(0, 4, '0', 9, '#ffffff', { fontStyle: 'bold' }).setOrigin(1, 0).setDepth(61);
    this.txt(176, 36, 'COFFEE', 9, '#c9cbe6', { fontStyle: 'bold' }).setDepth(61);
  }

  // Round ability buttons stacked above the joystick, each with a caption (keys 1-3 on a keyboard).
  private buildAbilities() {
    const icons = ['joke', 'backup', 'bis'];
    for (let i = 0; i < 3; i++) {
      const g = this.add.graphics().setDepth(62);
      drawIcon(g, icons[i], 22);
      this.abilIcons.push(g);
      this.abilLabels.push(
        this.txt(0, 0, '', 9, '#ffffff', { fontStyle: 'bold', align: 'center', stroke: '#22223b', strokeThickness: 3 }).setOrigin(1, 0.5).setDepth(62),
      );
    }
  }

  // Right edge of the HUD meters: just left of the pause button on a phone, capped on wide screens.
  private hudRight() {
    return 176 + Math.min(W - 176 - 54, 420);
  }

  private buildOverlays() {
    const bg = (this.textBg = this.add.graphics());
    const ic = this.add.graphics({ x: 34, y: 27 });
    ic.fillStyle(0x34c759, 1).fillRoundedRect(-14, -14, 28, 28, 7);
    ic.fillStyle(0xffffff, 1).fillEllipse(0, -1, 18, 13).fillTriangle(-6, 3, -9, 9, -1, 4);
    this.textFrom = this.txt(56, 7, '', 12, '#6c757d', { fontStyle: 'bold' });
    this.textBody = this.txt(56, 24, '', 14, '#22223b');
    this.textBanner = this.add.container(0, WORLD.y + 6, [bg, ic, this.textFrom, this.textBody]).setDepth(70).setVisible(false);

    this.toastText = this.txt(0, 0, '', 14, '#ffffff', {
      backgroundColor: '#22223bee',
      padding: { x: 12, y: 7 },
      align: 'center',
    })
      .setOrigin(0.5, 1)
      .setDepth(72)
      .setVisible(false);

    const jb = this.add.graphics();
    jb.fillStyle(0x000000, 0.3).fillRoundedRect(-162, -78, 324, 160, 18);
    jb.fillStyle(0xfffaf0, 1).fillRoundedRect(-165, -82, 330, 160, 18);
    jb.lineStyle(3, 0xffd166, 1).strokeRoundedRect(-165, -82, 330, 160, 18);
    const ji = this.add.graphics({ x: -138, y: -56 });
    drawIcon(ji, 'joke', 32);
    const jt = this.txt(-116, -70, 'DAD JOKE', 12, '#e76f51', { fontStyle: 'bold' });
    this.jokeText = this.txt(0, 2, '', 17, '#22223b', { align: 'center', wordWrap: { width: 296 } }).setOrigin(0.5);
    const groan = this.txt(0, 60, '*group groan*  ·  timers frozen', 11, '#8d8fa8').setOrigin(0.5);
    this.jokeCard = this.add.container(0, 0, [jb, ji, jt, this.jokeText, groan]).setDepth(71).setVisible(false);

    // FaceTime: a compact strip just above the panel, so it never covers the house's bubbles.
    const mg = this.add.graphics();
    mg.fillStyle(0x000000, 0.3).fillRoundedRect(-30, -24, 64, 56, 14);
    mg.fillStyle(0x22223b, 1).fillRoundedRect(-32, -28, 64, 56, 14);
    const face = this.add.graphics({ x: 0, y: -2 });
    drawMomFace(face, 17);
    const ml = this.txt(0, 19, 'MOM & DAD', 7, '#ffffff', { fontStyle: 'bold' }).setOrigin(0.5);
    this.momTime = this.txt(0, -19, '', 9, '#34c759', { fontStyle: 'bold' }).setOrigin(0.5);
    this.momWin = this.add.container(0, 0, [mg, face, ml, this.momTime]).setDepth(69).setVisible(false);

    const ub = this.add.graphics();
    ub.fillStyle(0x000000, 0.3).fillRoundedRect(-82, -24, 164, 56, 28);
    ub.fillStyle(0x34c759, 1).fillRoundedRect(-84, -28, 168, 56, 28);
    const ut = this.txt(0, 0, '“uh-huh”', 22, '#ffffff', { fontStyle: 'bold' }).setOrigin(0.5);
    this.uhHuh = this.add.container(0, 0, [ub, ut]).setDepth(75).setVisible(false);

    this.selectBanner = this.txt(0, 0, 'Call for Backup: tap a request', 14, '#ffffff', {
      backgroundColor: '#e76f51',
      padding: { x: 12, y: 6 },
      fontStyle: 'bold',
    })
      .setOrigin(0.5, 0)
      .setDepth(74)
      .setVisible(false);

    this.alarmText = this.txt(0, 0, 'BEEP! BEEP! BEEP!', 30, '#ffffff', {
      fontStyle: 'bold',
      stroke: '#e5484d',
      strokeThickness: 6,
    })
      .setOrigin(0.5)
      .setDepth(73)
      .setVisible(false);
  }

  // Place everything that depends on the screen size (src/game/layout.ts). Called on create and
  // whenever main.ts refits the layout to a new viewport.
  relayout() {
    if (!this.panel) return; // not created yet; create() lays out
    const cam = this.cameras.main;
    cam.setSize(W * this.R, H * this.R);
    this.chaosText.setX(this.hudRight());
    ABIL.forEach((a, i) => {
      this.abilIcons[i].setPosition(a.x, a.y);
      this.abilLabels[i].setPosition(a.x - ABILITY_R - 6, a.y);
    });
    // Text banner: full width on a phone, capped and centered on wide screens.
    const bw = Math.min(W - 20, 520);
    this.textBg.clear();
    this.textBg.fillStyle(0x000000, 0.25).fillRoundedRect(10, 4, bw, 54, 14);
    this.textBg.fillStyle(0xf8f9fa, 0.97).fillRoundedRect(10, 0, bw, 54, 14);
    this.textBody.setWordWrapWidth(bw - 70);
    this.textBanner.setX((W - bw) / 2 - 10).setY(HUD.h + 6);
    this.toastText.setX(W / 2).setY(PANEL.y - 12).setWordWrapWidth(Math.min(W - 60, 460));
    this.jokeCard.setPosition(W / 2, (HUD.h + PANEL.y) / 2);
    // FaceTime: Grandma's window and the "uh-huh" button sit just above the action card.
    this.momWin.setPosition(PANEL.x + 36, PANEL.y - 40);
    this.uhHuh.setPosition(PANEL.x + 160, PANEL.y - 40);
    this.selectBanner.setPosition(W / 2, HUD.h + 8);
    this.alarmText.setPosition(W / 2, (HUD.h + PANEL.y) / 2);
    this.panel.relayout();
  }

  // ------------------------------------------------------------ positions
  // Screen point (design px) over a world point at height h.
  private proj(x: number, y: number, h: number): Pt & { behind?: boolean } {
    if (this.world) return this.world.project(x, y, h);
    return { x: WORLD.x + x, y: WORLD.y + y - h * 0.5 };
  }

  private headOf(id: ActorId): Pt {
    const a = this.sim.actors[id];
    const h = this.world?.heightOf(id) ?? 40;
    if (a.state === 'carried') return this.proj(this.sim.nick.x, this.sim.nick.y, 80);
    if (a.state === 'asleep') return this.proj(COUCH_POS.x, COUCH_POS.y, 36);
    return this.proj(a.x, a.y, h);
  }

  // Where a request's bubble floats (screen space, may be off the 3D view).
  private bubblePoint(r: Request): Pt {
    if (r.kind === 'flip') return this.proj(STATIONS.grill.x, STATIONS.grill.y, 78);
    if (r.kind === 'thermostat') return this.proj(STATIONS.thermostat.x, STATIONS.thermostat.y, 92);
    if (r.kind === 'needs_out') {
      const p = this.headOf('eloise');
      return { x: p.x, y: p.y - 26 };
    }
    if (r.kind === 'spill') return this.proj(r.x ?? 0, r.y ?? 0, 34);
    const kids = (r.kids ?? [r.owner]) as ActorId[];
    const ps = kids.map((k) => this.headOf(k));
    return { x: ps.reduce((s, p) => s + p.x, 0) / ps.length, y: Math.min(...ps.map((p) => p.y)) - 26 };
  }

  // ------------------------------------------------------------ render
  private render(dt: number) {
    const sim = this.sim;
    const g = this.dyn;
    g.clear();
    this.renderStick();
    if (sim.goalMin !== 480) this.weekText.setText(`WEEK ${sim.week} · GAME NIGHT ${clockString(sim.goalMin).replace(' PM', '')}`);

    this.renderChips(g);
    for (const id of ['evelyn', 'nora', 'tyler', 'eloise'] as ActorId[]) {
      const a = sim.actors[id];
      const t = this.speech.get(id)!;
      t.setVisible(false);
      if (!a.present || a.state === 'asleep') continue;
      const text = a.state === 'crying' ? (id === 'nora' ? 'WAAAH' : 'WAAAAH!') : a.speech;
      if (!text) continue;
      const p = this.headOf(id);
      if (!this.onView(p)) continue;
      t.setText(text).setVisible(true).setPosition(p.x, p.y - (a.req != null ? 52 : 6));
    }

    this.renderBubbles(g, dt);
    this.renderMinimap(g);
    this.renderNap();
    this.renderHud();
    this.renderOverlays(dt);
  }

  // The joystick: a translucent base and a knob that follows the thumb.
  private renderStick() {
    const g = this.stickG;
    g.clear();
    const { cx, cy, r } = STICK;
    const on = !!this.stickDir;
    g.fillStyle(0x22223b, on ? 0.45 : 0.32).fillCircle(cx, cy, r);
    g.lineStyle(2, 0xffffff, on ? 0.55 : 0.35).strokeCircle(cx, cy, r);
    // Faint arrow ticks so it reads as a control before you touch it.
    g.fillStyle(0xffffff, 0.35);
    for (const [ax, ay] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const bx = cx + ax * (r - 12);
      const by = cy + ay * (r - 12);
      g.fillTriangle(bx + ax * 6, by + ay * 6, bx - ay * 6, by + ax * 6, bx + ay * 6, by - ax * 6);
    }
    const kx = cx + this.stickKnob.x;
    const ky = cy + this.stickKnob.y;
    g.fillStyle(0x000000, 0.2).fillCircle(kx, ky + 3, 26);
    g.fillStyle(on ? COLORS.accent : 0xf8f9fa, on ? 0.95 : 0.85).fillCircle(kx, ky, 26);
  }

  private onView(p: Pt & { behind?: boolean }, pad = 0) {
    return !p.behind && p.x >= WORLD.x + pad && p.x <= WORLD.x + WORLD.w - pad && p.y >= WORLD.y + pad && p.y <= WORLD.y + WORLD.h - pad;
  }

  private renderChips(g: Phaser.GameObjects.Graphics) {
    const sim = this.sim;
    const shoe = new Map<StationId, boolean>();
    for (const r of sim.requests) if (r.kind === 'lost_shoe') for (const s of r.spots ?? []) shoe.set(s, !!r.checked?.includes(s));
    for (const [s, c] of this.chips) {
      const st = STATIONS[s];
      const h = s === 'grill' ? 58 : s === 'thermostat' ? 70 : s === 'door' ? 90 : s.startsWith('spot_') ? 34 : 58;
      const p = this.proj(st.x, st.y, h);
      const spot = s.startsWith('spot_');
      // Shoe spots only show while a lost shoe sends you there.
      const show = this.onView(p, 6) && (!spot || shoe.has(s));
      c.setVisible(show).setPosition(p.x, p.y);
      const q = c.getByName('q') as Phaser.GameObjects.Text;
      if (spot && show) {
        q.setText(shoe.get(s) ? '✓' : '?').setVisible(true);
        (c.list[1] as Phaser.GameObjects.Graphics).setVisible(false);
      }
    }
    // Grill smoke.
    if (sim.grill.on) {
      const p = this.proj(STATIONS.grill.x, STATIONS.grill.y, 46);
      const flip = sim.requests.find((r) => r.kind === 'flip');
      const burn = flip ? 1 - flip.left / flip.patience : 0;
      const puff = (this.now * 0.8) % 1;
      if (this.onView(p)) {
        g.fillStyle(flip ? 0x555555 : 0xdddddd, (1 - puff) * (0.35 + burn * 0.5));
        g.fillCircle(p.x + puff * 8, p.y - puff * 30, 4 + puff * 9);
      }
    }
  }

  // A small floor plan in the corner: rooms, Nick, the kids, and where requests are.
  private renderMinimap(g: Phaser.GameObjects.Graphics) {
    const sim = this.sim;
    const sc = 0.2;
    const ox = WORLD.x + WORLD.w - W_SIM.w * sc - 8;
    const oy = HUD.h + 8;
    const M = (x: number, y: number) => ({ x: ox + x * sc, y: oy + y * sc });
    g.fillStyle(0x1d1f2b, 0.75).fillRoundedRect(ox - 3, oy - 3, W_SIM.w * sc + 6, W_SIM.h * sc + 6, 6);
    const col: Record<RoomId, number> = { backyard: 0x76bd79, kitchen: 0xe8e6dc, living: 0xc68b59, garage: 0xa3abb5 };
    for (const r of Object.keys(ROOM_RECTS) as RoomId[]) {
      const R = ROOM_RECTS[r];
      const a = M(R.x, R.y);
      g.fillStyle(col[r], 0.95).fillRect(a.x, a.y, R.w * sc, R.h * sc);
    }
    g.fillStyle(0xf3e3c3, 1);
    for (const d of DOORS) {
      const a = M(d.x, d.y);
      if (d.axis === 'h') g.fillRect(a.x - (d.span * sc) / 2, a.y - 1.5, d.span * sc, 3);
      else g.fillRect(a.x - 1.5, a.y - (d.span * sc) / 2, 3, d.span * sc);
    }
    const pulse = Math.sin(this.now * 10) > 0;
    for (const r of sim.requests) {
      const a = sim.anchorOf(r);
      const p = M(a.x, a.y);
      const frac = isFinite(r.left) ? r.left / r.patience : 0;
      const c = frac > 0.5 ? COLORS.chaosLo : frac > 0.25 ? COLORS.chaosMid : COLORS.chaosHi;
      if (frac > 0.25 || pulse) g.fillStyle(c, 1).fillCircle(p.x, p.y, 3.5);
    }
    for (const id of ['evelyn', 'nora', 'tyler', 'eloise'] as ActorId[]) {
      const a = sim.actors[id];
      if (!a.present || a.state === 'carried') continue;
      const p = M(a.x, a.y);
      g.fillStyle(id === 'eloise' ? 0x9c8f7a : 0xffffff, 1).fillCircle(p.x, p.y, 1.8);
    }
    const n = M(sim.nick.x, sim.nick.y);
    g.fillStyle(COLORS.accent, 1).fillCircle(n.x, n.y, 3);
    g.lineStyle(1, 0xffffff, 1).strokeCircle(n.x, n.y, 3);
  }

  private renderBubbles(g: Phaser.GameObjects.Graphics, dt: number) {
    const sim = this.sim;
    const live = new Set<number>();
    for (const r of sim.requests) {
      live.add(r.id);
      let b = this.bubbles.get(r.id);
      const target = this.bubblePoint(r);
      if (!b) {
        const bg = this.add.graphics();
        bg.fillStyle(0x000000, 0.2).fillCircle(1, 2, 17);
        bg.fillStyle(0xffffff, 1).fillCircle(0, 0, 17);
        bg.fillTriangle(-5, 13, 5, 13, 0, 21);
        const ic = this.add.graphics();
        drawIcon(ic, r.kind, 20);
        const label = this.txt(0, 27, REQUEST_LABEL[r.kind].toUpperCase(), 8, '#ffffff', {
          fontStyle: 'bold',
          backgroundColor: '#22223bdd',
          padding: { x: 3, y: 1 },
        }).setOrigin(0.5, 0);
        b = { c: this.add.container(target.x, target.y, [bg, ic, label]).setDepth(30), pos: { ...target } };
        b.c.setScale(0.3);
        this.tweens.add({ targets: b.c, scale: 1, duration: 220, ease: 'Back.easeOut' });
        this.bubbles.set(r.id, b);
      }
      // Off the 3D view: pin to the edge, with an arrow toward it.
      const pad = 24;
      const off = !this.onView(target as Pt & { behind?: boolean }, pad);
      const edge = {
        x: Phaser.Math.Clamp(target.x, WORLD.x + pad, WORLD.x + WORLD.w - pad),
        y: Phaser.Math.Clamp(target.y, HUD.h + pad, Math.min(PANEL.y, STICK.cy - STICK.r) - pad - 22), // stay clear of the controls
      };
      b.pos = approach(b.pos, edge, 900, dt);
      b.c.setPosition(b.pos.x, b.pos.y);
      if (off) {
        const ang = Math.atan2(target.y - edge.y, target.x - edge.x);
        const ax = b.pos.x + Math.cos(ang) * 27;
        const ay = b.pos.y + Math.sin(ang) * 27;
        g.fillStyle(0xffffff, 1).fillTriangle(
          ax + Math.cos(ang) * 7,
          ay + Math.sin(ang) * 7,
          ax + Math.cos(ang + 2.3) * 7,
          ay + Math.sin(ang + 2.3) * 7,
          ax + Math.cos(ang - 2.3) * 7,
          ay + Math.sin(ang - 2.3) * 7,
        );
      }
      const frac = isFinite(r.left) ? Math.max(0, r.left / r.patience) : 1;
      const color = !isFinite(r.left) ? COLORS.bad : sim.frozen ? 0x8ecae6 : r.id === sim.promisedId ? 0x4ea8de : frac > 0.5 ? COLORS.chaosLo : frac > 0.25 ? COLORS.chaosMid : COLORS.chaosHi;
      g.lineStyle(5, 0x22223b, 0.55).strokeCircle(b.pos.x, b.pos.y, 20);
      g.lineStyle(4, color, 1);
      g.beginPath();
      g.arc(b.pos.x, b.pos.y, 20, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * frac, false);
      g.strokePath();
      if (!this.tweens.isTweening(b.c)) b.c.setScale(!isFinite(r.left) || frac < 0.3 ? 1 + Math.sin(this.now * 14) * 0.06 : 1);
      if (this.panel.selectMode) g.lineStyle(3, 0xe76f51, 0.6 + 0.4 * Math.sin(this.now * 8)).strokeCircle(b.pos.x, b.pos.y, 26);
    }
    for (const [id, b] of this.bubbles) if (!live.has(id) && !this.tweens.isTweening(b.c)) this.popBubble(id, true);
  }

  private renderNap() {
    const sim = this.sim;
    const asleep = sim.nap.state === 'asleep';
    this.shhText.setVisible(asleep);
    this.zzz.setVisible(asleep);
    if (!asleep) return;
    const c = this.proj(COUCH_POS.x, COUCH_POS.y, 46);
    const g = this.dyn;
    const x = c.x - 40;
    const y = c.y - 34;
    const n = sim.nap.noise / 100;
    g.fillStyle(0x22223b, 0.85).fillRoundedRect(x, y, 80, 16, 8);
    g.fillStyle(n > 0.66 ? COLORS.chaosHi : n > 0.33 ? COLORS.chaosMid : COLORS.chaosLo, 1).fillRoundedRect(x + 2, y + 2, Math.max(4, 76 * n), 12, 6);
    this.shhText.setPosition(c.x, y + 8);
    this.zzz.setPosition(c.x + 26 + Math.sin(this.now * 2) * 3, c.y - 26 - ((this.now * 8) % 10));
  }

  private renderHud() {
    const sim = this.sim;
    const g = this.top;
    g.clear();
    // A slim translucent strip: the house shows through.
    g.fillStyle(COLORS.hud, 0.78).fillRect(0, HUD.y, W, HUD.h);
    this.clockText.setText(sim.clock);
    const cx = 176;
    const cw = this.hudRight() - cx;
    const ch = sim.chaos / 100;
    g.fillStyle(0x1d1f2b, 0.9).fillRoundedRect(cx, 16, cw, 16, 8);
    const col = ch < 0.5 ? COLORS.chaosLo : ch < 0.8 ? COLORS.chaosMid : COLORS.chaosHi;
    g.fillStyle(col, 1).fillRoundedRect(cx + 2, 18, Math.max(8, (cw - 4) * ch), 12, 6);
    if (ch >= 0.8) g.lineStyle(2, COLORS.chaosHi, 0.5 + 0.5 * Math.sin(this.now * 10)).strokeRoundedRect(cx, 16, cw, 16, 8);
    this.chaosText.setText(`${Math.floor(sim.chaos)}`);
    const cf = sim.nick.coffee;
    const fw = Math.min(cw, 160);
    g.fillStyle(0x1d1f2b, 0.9).fillRoundedRect(cx, 48, fw, 10, 5);
    g.fillStyle(cf < COFFEE.slowBelow ? COLORS.bad : COLORS.coffee, 1).fillRoundedRect(cx + 2, 50, Math.max(6, (fw - 4) * cf), 6, 3);
    g.lineStyle(1, 0xffffff, 0.3).lineBetween(cx + fw * COFFEE.slowBelow, 48, cx + fw * COFFEE.slowBelow, 58);

    // Pause.
    g.fillStyle(0x3d405b, 0.95).fillCircle(PAUSE.x, PAUSE.y, PAUSE.r);
    g.fillStyle(0xffffff, 1).fillRoundedRect(PAUSE.x - 6, PAUSE.y - 7, 4, 14, 1).fillRoundedRect(PAUSE.x + 2, PAUSE.y - 7, 4, 14, 1);

    // Abilities: cooldowns sweep around the button; Call for Backup shows its charges.
    const cds = [sim.jokeCd / ABILITIES.dadJoke.cooldownSec, sim.backupCharges > 0 ? 0 : 1, sim.bissCd / ABILITIES.becauseISaidSo.cooldownSec];
    const names = ['Dad Joke', 'Backup', 'Because\nI Said So'];
    ABIL.forEach((a, i) => {
      const lit = i === 1 && this.panel.selectMode;
      const ready = cds[i] <= 0;
      g.fillStyle(0x000000, 0.25).fillCircle(a.x, a.y + 3, ABILITY_R);
      g.fillStyle(lit ? 0xe76f51 : ready ? 0xfffaf0 : 0x8d8fa8, ready || lit ? 0.95 : 0.7).fillCircle(a.x, a.y, ABILITY_R);
      g.lineStyle(3, lit ? 0xffffff : ready ? COLORS.accent : 0x5a5f8a, 1).strokeCircle(a.x, a.y, ABILITY_R);
      if (!ready && i !== 1) {
        g.lineStyle(4, 0x22223b, 0.8);
        g.beginPath();
        g.arc(a.x, a.y, ABILITY_R - 2, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * cds[i], false);
        g.strokePath();
      }
      this.abilIcons[i].setAlpha(ready || lit ? 1 : 0.45);
      const sub = i === 0 ? (sim.jokeCd > 0 ? ` ${Math.ceil(sim.jokeCd)}s` : '') : i === 1 ? ` ${'●'.repeat(sim.backupCharges)}${'○'.repeat(ABILITIES.callBackup.charges - sim.backupCharges)}` : sim.bissCd > 0 ? ` ${Math.ceil(sim.bissCd)}s` : '';
      this.abilLabels[i].setText(names[i] + sub);
    });
  }

  private renderOverlays(dt: number) {
    const sim = this.sim;
    const g = this.fxTop;
    g.clear();
    if (sim.frozen) g.fillStyle(0x8ecae6, 0.16).fillRect(WORLD.x, WORLD.y, WORLD.w, WORLD.h);
    else if (this.jokeCard.visible && this.jokeCard.alpha === 1 && !this.tweens.isTweening(this.jokeCard)) {
      this.tweens.add({ targets: this.jokeCard, alpha: 0, duration: 200, onComplete: () => this.jokeCard.setVisible(false) });
    }
    if (this.alarmT > 0) {
      this.alarmT -= dt;
      const on = Math.floor(this.alarmT * 6) % 2 === 0;
      g.fillStyle(0xe5484d, on ? 0.22 : 0.06).fillRect(WORLD.x, WORLD.y, WORLD.w, WORLD.h);
      this.alarmText.setVisible(on);
    } else this.alarmText.setVisible(false);

    if (this.toastT > 0) {
      this.toastT -= dt;
      this.toastText.setAlpha(Math.min(1, this.toastT * 3));
      this.toastText.setY(sim.facetime.state === 'active' ? PANEL.y - 70 : PANEL.y - 12);
      if (this.toastT <= 0) this.toastText.setVisible(false);
    }
    if (this.textT > 0) {
      this.textT -= dt;
      if (this.textT <= 0) this.textBanner.setVisible(false);
    } else if (this.textQueue.length) {
      const m = this.textQueue.shift()!;
      this.textFrom.setText(m.from.toUpperCase() + '  ·  now');
      this.textBody.setText(m.body);
      this.textBanner.setVisible(true).setY(WORLD.y - 40).setAlpha(0);
      this.tweens.add({ targets: this.textBanner, y: WORLD.y + 6, alpha: 1, duration: 220, ease: 'Cubic.easeOut' });
      this.textT = 3;
    }
    const ft = sim.facetime.state === 'active';
    this.momWin.setVisible(ft);
    if (ft) this.momTime.setText(`0:${String(Math.max(0, Math.ceil(sim.facetime.left))).padStart(2, '0')}`);
    const pr = sim.facetime.prompt;
    this.uhHuh.setVisible(!!pr && this.running);
    if (pr) {
      this.uhHuh.setScale(1 + Math.sin(this.now * 12) * 0.03);
      g.fillStyle(0xffffff, 0.9).fillRoundedRect(this.uhHuh.x - 66, this.uhHuh.y + 20, 132 * Math.max(0, pr.left / 2.6), 5, 2);
    }
    this.selectBanner.setVisible(this.panel.selectMode && this.running);
  }
}

function approach(p: Pt, goal: Pt, speed: number, dt: number): Pt {
  const dx = goal.x - p.x;
  const dy = goal.y - p.y;
  const d = Math.hypot(dx, dy);
  const step = speed * dt;
  if (d <= step || d < 0.5) return { ...goal };
  return { x: p.x + (dx / d) * step, y: p.y + (dy / d) * step };
}

