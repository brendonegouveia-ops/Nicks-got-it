// Screen geometry in design px. The layout fills the whole screen: a phone keeps a 390-wide design
// space and the extra height goes to the 3D view; wider screens get a wider (and slightly taller)
// design space. The HUD sits on top, the thumb deck and ability bar at the bottom, the 3D view between.
// Every region is recomputed by setLayout(); importers read these live bindings / objects each frame.
export const BASE_W = 390;
const MIN_H = 600; // shortest design height (HUD + deck + a usable 3D view)
const WIDE_H = 760; // design height on square-ish or landscape screens
const MAX_ASPECT = 2; // wider than 2:1 letterboxes

export let W = BASE_W;
export let H = 844;

export const HUD = { y: 0, h: 72 };
export const WORLD = { x: 0, y: 74, w: BASE_W, h: 520 };
// Thumb zone: D-pad on the left, action pad on the right, ability bar below.
export const DECK = { y: 598, h: 168 };
export const DPAD = { cx: 82, cy: 682, r: 74 };
export const PANEL = { x: 166, y: 600, w: 218, h: 164 };
export const BAR = { x: 0, y: 770, w: BASE_W, h: 74 };

export function setLayout(w: number, h: number) {
  W = w;
  H = h;
  Object.assign(BAR, { y: H - 74, w: W });
  Object.assign(DECK, { y: BAR.y - 172 });
  Object.assign(DPAD, { cy: BAR.y - 88 });
  const pw = Math.min(W - 172, 420);
  Object.assign(PANEL, { x: W - 6 - pw, y: BAR.y - 170, w: pw });
  Object.assign(WORLD, { w: W, h: DECK.y - 4 - WORLD.y });
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
export const inWorld = (x: number, y: number) => y >= WORLD.y && y < WORLD.y + WORLD.h;

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
export const ACTOR_SCALE: Record<string, number> = { nick: 0.55, evelyn: 0.62, tyler: 0.6, nora: 0.62, eloise: 0.62 };
