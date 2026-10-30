// Screen geometry in design px. The 3D view fills the whole screen and the controls float on top
// of it: a slim HUD along the top, a virtual joystick bottom-right with the ability buttons above
// it, and the action card (the job Nick is next to) bottom-left beside the joystick.
// A phone keeps a 390-wide design space and any extra height goes to the view; wider screens get a
// wider (and slightly taller) design space. Every region is recomputed by setLayout(); importers
// read these live bindings / objects each frame.
export const BASE_W = 390;
const MIN_H = 600; // shortest design height
const WIDE_H = 760; // design height on square-ish or landscape screens
const MAX_ASPECT = 2; // wider than 2:1 letterboxes

export let W = BASE_W;
export let H = 844;

export const HUD = { y: 0, h: 64 };
export const WORLD = { x: 0, y: 0, w: BASE_W, h: 844 }; // the 3D view: the whole screen
export const STICK = { cx: 306, cy: 752, r: 58 };
export const PANEL = { x: 8, y: 668, w: 224, h: 164 };
export const ABILITY_R = 26;
export const ABIL = [0, 1, 2].map(() => ({ x: 0, y: 0 })); // Dad Joke, Call for Backup, Because I Said So
export const PAUSE = { x: 364, y: 32, r: 18 };

export function setLayout(w: number, h: number) {
  W = w;
  H = h;
  Object.assign(WORLD, { w: W, h: H });
  Object.assign(STICK, { cx: W - 84, cy: H - 92 });
  const pw = Math.min(STICK.cx - STICK.r - 24, 300);
  Object.assign(PANEL, { x: STICK.cx - STICK.r - 16 - pw, y: H - 12 - PANEL.h, w: pw });
  ABIL.forEach((a, i) => Object.assign(a, { x: W - 36, y: STICK.cy - STICK.r - 46 - i * 64 }));
  Object.assign(PAUSE, { x: W - 26, y: HUD.h / 2 });
}

// Design size for a viewport of vw x vh CSS px (same aspect, so the canvas fills it).
export function fitLayout(vw: number, vh: number) {
  const r = vh / Math.max(1, vw);
  const tall = MIN_H / BASE_W;
  if (r >= tall) return setLayout(BASE_W, Math.round(BASE_W * r));
  const h = MIN_H + (WIDE_H - MIN_H) * Math.min(1, (tall - r) / (tall - 1));
  setLayout(Math.round(Math.min(h / r, h * MAX_ASPECT)), Math.round(h));
}
setLayout(BASE_W, 844);

export const toScreen = (x: number, y: number) => ({ x: x + WORLD.x, y: y + WORLD.y });
export const toWorld = (x: number, y: number) => ({
  x: Math.max(0, Math.min(WORLD.w, x - WORLD.x)),
  y: Math.max(0, Math.min(WORLD.h, y - WORLD.y)),
});
export const inWorld = (x: number, y: number) => y >= HUD.h && y < WORLD.y + WORLD.h;

export const COLORS = {
  bg: 0x1d1f2b,
  ink: 0x22223b,
  paper: 0xfffaf0,
  hud: 0x2b2d42,
  chaosLo: 0x5fbf6a,
  chaosMid: 0xf2b134,
  chaosHi: 0xe5484d,
  coffee: 0x8b5a2b,
  accent: 0xff7a59,
  route: 0xffffff,
  marker: 0x3a86ff,
  panel: 0xfff4e0,
  panelEdge: 0xe8d5b0,
  ability: 0x3d405b,
  abilityLit: 0x5a5f8a,
  good: 0x2a9d8f,
  bad: 0xe5484d,
};

export const FONT = '"Trebuchet MS", ui-rounded, "SF Pro Rounded", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

// Characters are drawn front-facing (3/4 view) on the top-down plan, at these scales.
export const ACTOR_SCALE: Record<string, number> = { nick: 0.55, sis: 0.62, neighbor: 0.6, tot: 0.62, eloise: 0.62 };
