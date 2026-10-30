// Headless smoke test: builds nothing, expects `vite preview` (or any server) at BASE.
// Usage: node tools/smoke.mjs [baseUrl] [outDir]
import { chromium, devices } from 'playwright';
import fs from 'node:fs';

const BASE = process.argv[2] ?? 'http://localhost:4173/';
const OUT = process.argv[3] ?? 'test-results';
fs.mkdirSync(OUT, { recursive: true });

const fail = (m) => {
  console.error('FAIL', m);
  process.exitCode = 1;
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ ...devices['iPhone 13'] });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
// /api/* 404s are expected under `vite preview` (no Pages Functions there).
page.on('console', (m) => m.type() === 'error' && !/\/api\//.test(m.location()?.url ?? '') && errors.push(m.text()));

await page.goto(BASE);
await page.waitForFunction(() => window.__nick?.scene?.sim);
await page.screenshot({ path: `${OUT}/01-title.png` });

await page.tap('#startBtn');
await page.waitForSelector('#help[data-open]');
await page.screenshot({ path: `${OUT}/02-help.png` });
await page.tap('#help .close');
await page.waitForFunction(() => window.__nick.scene.running);
// Headless software GL renders slowly; run game time at 1/4 so timing windows stay testable.
await page.evaluate(() => (window.__nick.scene.timeScale = 0.25));

// The layout takes the screen's shape: the canvas must fill #game edge to edge.
const LAYOUT = await page.evaluate(() => window.__nick.layout);
const fill = await page.evaluate(() => {
  const c = document.querySelector('#game canvas').getBoundingClientRect();
  const g = document.querySelector('#game').getBoundingClientRect();
  return { cw: c.width, ch: c.height, gw: g.width, gh: g.height };
});
if (Math.abs(fill.cw - fill.gw) > 2 || Math.abs(fill.ch - fill.gh) > 2) fail(`canvas ${fill.cw}x${fill.ch} does not fill #game ${fill.gw}x${fill.gh}`);
console.log('layout', `${LAYOUT.W}x${LAYOUT.H}`, 'canvas', `${Math.round(fill.cw)}x${Math.round(fill.ch)}`);

// Map design coords -> page coords via the canvas rect.
const toPage = async (x, y) =>
  page.evaluate(([x, y, W, H]) => {
    const c = document.querySelector('#game canvas').getBoundingClientRect();
    return { x: c.left + (x / W) * c.width, y: c.top + (y / H) * c.height };
  }, [x, y, LAYOUT.W, LAYOUT.H]);
const tapDesign = async (x, y) => {
  const p = await toPage(x, y);
  await page.touchscreen.tap(p.x, p.y);
};

const sim = (fn, arg) => page.evaluate(fn, arg);
const cdp = await ctx.newCDPSession(page);
const touch = async (type, x, y) => {
  const p = await toPage(x, y);
  await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: p.x, y: p.y }] });
};
// Action pad geometry (src/game/layout.ts PANEL + panel.ts): center and the two stacked rows.
const { PANEL, STICK, ABIL } = LAYOUT;
const PX = PANEL.x + PANEL.w / 2;
const PY = PANEL.y + 94;
const ROW1 = PANEL.y + 69;
const ROW2 = PANEL.y + 129;
const tapPanel = async (x = PX, y = PY) => {
  await touch('touchStart', x, y);
  await touch('touchEnd', x, y);
};
const WORLD_Y = 74;

// Joystick: push "up" from the living room until Nick walks out the slider into the backyard.
await sim(() => (window.__nick.scene.timeScale = 1));
const start = await sim(() => ({ ...window.__nick.scene.sim.nick }));
await touch('touchStart', STICK.cx, STICK.cy - 44);
await page.waitForFunction(() => window.__nick.scene.sim.nick.room === 'backyard', null, { timeout: 30000 });
await page.screenshot({ path: `${OUT}/03-walking.png` });
await touch('touchEnd', STICK.cx, STICK.cy - 44);
await page.waitForTimeout(200);
const after = await sim(() => ({ ...window.__nick.scene.sim.nick, steering: window.__nick.scene.sim.steering }));
if (after.steering) fail('still walking after releasing the joystick');
console.log('walked', start.room, '->', after.room, `(${Math.round(after.x)},${Math.round(after.y)})`);
await sim(() => (window.__nick.scene.timeScale = 0.25));

// Every gesture, end to end: put a request next to Nick, wait for the panel, do it with touch events.
await sim(() => {
  const s = window.__nick.scene.sim;
  for (const a of Object.values(s.actors)) Object.assign(a, { nextReq: 1e9, nextWander: 1e9, dest: null, req: null });
  s.dog.nextAction = 1e9;
  s.thermostatAt = Infinity;
  s.requests.length = 0;
  s.interaction = null;
  Object.assign(s.nick, { x: 300, y: 300, coffee: 1 });
  for (const [id, x] of [['sis', 280], ['neighbor', 320]]) Object.assign(s.actors[id], { present: true, x, y: 300, room: 'living', state: 'idle' });
});
const inject = (spec) =>
  sim((spec) => {
    const s = window.__nick.scene.sim;
    for (const a of Object.values(s.actors)) Object.assign(a, { nextReq: 1e9, req: null });
    s.requests.length = 0;
    const r = { id: 5000 + Math.floor(Math.random() * 1e6), patience: 999, left: 999, room: 'living', ...spec };
    delete r.hand;
    s.requests.push(r);
    for (const k of r.kids ?? [r.owner]) if (s.actors[k] && k !== 'eloise') s.actors[k].req = r.id;
    if (spec.hand) s.nick.hand = spec.hand;
    return r.id;
  }, spec);
const waitPanel = (kind) =>
  page.waitForFunction((k) => window.__nick.scene.sim.interaction?.kind === k, kind, { timeout: 20000 }).catch(async (e) => {
    console.log('waitPanel', kind, await sim(() => { const s = window.__nick.scene.sim; return { it: s.interaction?.title, note: s.note, steer: s.steering, engaged: s.engaged, nick: [s.nick.x, s.nick.y], reqs: s.requests.map((r) => r.kind), ev: [s.actors.sis.x, s.actors.sis.y] }; }));
    throw e;
  });
const gone = (id) => sim((id) => !window.__nick.scene.sim.requests.some((r) => r.id === id), id);
const check = async (label, id) => {
  await page.waitForTimeout(200);
  if (!(await gone(id))) fail(`${label}: request still open`);
  else console.log('ok', label);
};

{ // TAP: hand over a snack
  const id = await inject({ kind: 'snack', owner: 'sis', hand: 'snack' });
  await waitPanel('tap');
  await tapPanel();
  await check('tap', id);
}
{ // HOLD
  const id = await inject({ kind: 'watch_this', owner: 'sis' });
  await waitPanel('hold');
  await page.screenshot({ path: `${OUT}/04-action-panel.png` });
  await touch('touchStart', PX, PY);
  await page.waitForTimeout(300);
  if (!(await sim(() => window.__nick.scene.sim.engaged))) fail('holding did not lock Nick in place');
  await page.waitForFunction((id) => !window.__nick.scene.sim.requests.some((r) => r.id === id), id, { timeout: 30000 }).catch(() => {});
  await touch('touchEnd', PX, PY);
  await check('hold', id);
}
{ // CHOICE -> RUB (band-aid)
  const id = await inject({ kind: 'booboo', owner: 'neighbor', hand: 'bandaid' });
  await waitPanel('choice');
  await page.screenshot({ path: `${OUT}/04b-choice.png` });
  await tapPanel(PX, ROW1);
  await waitPanel('rub');
  // Rub back and forth across the card (it floats bottom-left, beside the joystick).
  const r0 = PANEL.x + 14;
  const r1 = PANEL.x + PANEL.w - 14;
  await touch('touchStart', r0, PY);
  for (let i = 0; i < 14 && !(await gone(id)); i++) {
    for (let x = r0; x <= r1; x += 38) await touch('touchMove', x, PY + (i % 2) * 4);
    for (let x = r1; x >= r0; x -= 38) await touch('touchMove', x, PY);
  }
  await touch('touchEnd', r0, PY);
  await check('choice+rub', id);
}
{ // SWIPE (spill under Nick's feet)
  const id = await inject({ kind: 'spill', owner: 'eloise', x: 300, y: 310, dir: 'left' });
  await waitPanel('swipe');
  await page.screenshot({ path: `${OUT}/04c-swipe.png` });
  const s0 = PANEL.x + PANEL.w - 12;
  await touch('touchStart', s0, PY);
  for (let x = s0 - 20; x >= s0 - 170; x -= 30) await touch('touchMove', x, PY + 2);
  await touch('touchEnd', s0 - 170, PY + 2);
  await check('swipe', id);
}
{ // CHOICE (screen time: No)
  const id = await inject({ kind: 'screen_time', owner: 'sis' });
  await waitPanel('choice');
  await tapPanel(PX, ROW2);
  await check('choice', id);
}
{ // MULTI (fight: tap each kid)
  const id = await inject({ kind: 'fight', owner: 'sis', kids: ['sis', 'neighbor'] });
  await waitPanel('multi');
  await page.screenshot({ path: `${OUT}/04d-fight.png` });
  await tapPanel(PX, ROW1);
  await tapPanel(PX, ROW2);
  await check('multi', id);
}
{ // MASH (grill flip): walk to the grill by holding on it, then mash
  await sim(() => {
    const s = window.__nick.scene.sim;
    s.requests.push({ id: 7777, kind: 'flip', owner: 'grill', room: 'backyard', patience: 999, left: 999 });
  });
  await sim(() => Object.assign(window.__nick.scene.sim.nick, { x: 332, y: 94 }));
  await waitPanel('mash');
  await page.screenshot({ path: `${OUT}/04e-mash.png` });
  await sim(() => (window.__nick.scene.timeScale = 0.05)); // CDP taps are ~1 s apart under software GL
  for (let i = 0; i < 9; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [await toPage(PX, PY)] });
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  }
  await check('mash', 7777);
  await sim(() => (window.__nick.scene.timeScale = 0.25));
}

// Jump to the nap with Little Sis, Neighbor Kid and Eloise in play.
await sim(() => {
  const s = window.__nick.scene.sim;
  while (s.gm < 245 && !s.over) {
    s.update(0.1);
    s.chaos = Math.min(s.chaos, 40);
    window.__nick.scene.handleEvents?.(s.drainEvents());
  }
  s.drainEvents();
});
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/05-nap.png` });

// Dad joke via its button above the joystick.
await sim(() => { const s = window.__nick.scene; s.textQueue.length = 0; });
await tapDesign(ABIL[0].x, ABIL[0].y);
await page.waitForFunction(() => window.__nick.scene.jokeCard.visible && window.__nick.scene.jokeCard.alpha > 0.9);
await page.screenshot({ path: `${OUT}/06-dad-joke.png` });
if (!(await sim(() => window.__nick.scene.sim.frozen))) fail('dad joke did not freeze');

// FaceTime.
await sim(() => {
  const s = window.__nick.scene.sim;
  while (s.gm < 361.5 && !s.over) {
    s.update(0.1);
    s.chaos = Math.min(s.chaos, 40);
  }
  s.drainEvents();
});
await page.waitForFunction(() => window.__nick.scene.sim.facetime.prompt, null, { timeout: 20000 });
await page.screenshot({ path: `${OUT}/07-facetime.png` });
const missedBefore = await sim(() => window.__nick.scene.sim.facetime.missed);
const promptId = await sim(() => window.__nick.scene.sim.facetime.prompt.id);
const uhAt = await sim(() => ({ x: window.__nick.scene.uhHuh.x, y: window.__nick.scene.uhHuh.y }));
const uh = await toPage(uhAt.x, uhAt.y);
await page.touchscreen.tap(uh.x, uh.y);
const ft = await sim(() => ({ p: window.__nick.scene.sim.facetime.prompt?.id ?? null, m: window.__nick.scene.sim.facetime.missed }));
if (ft.p === promptId || ft.m !== missedBefore) fail('uh-huh tap missed ' + JSON.stringify(ft));

// Pause on blur / visibility.
await page.evaluate(() => window.dispatchEvent(new Event('blur')));
await page.waitForSelector('#pause[data-open]');
await page.screenshot({ path: `${OUT}/08-pause.png` });
await page.tap('#resumeBtn');

// Game over -> end card.
await sim(() => window.__nick.scene.sim.addChaos(200, 'smoke'));
await page.waitForSelector('#end[data-open]', { timeout: 5000 });
await page.screenshot({ path: `${OUT}/09-end.png` });

// Leaderboard (only when Pages Functions are being served).
const hasApi = await page.evaluate(async () => { const r = await fetch('/api/scores'); return r.ok && (r.headers.get('content-type') ?? '').includes('json'); });
if (hasApi) {
  // The fast-forwarded run claims ~6 game hours in well under 6 real minutes: must be refused.
  await page.fill('#nameInput', 'Smoke Test');
  await page.tap('#submitBtn');
  await page.waitForFunction(() => /Couldn|offline/.test(document.getElementById('submitMsg').textContent));
  console.log('cheat rejected:', await page.textContent('#submitMsg'));
  // An honest short run: ~12 real seconds, then post.
  await page.tap('#againBtn');
  await page.evaluate(() => (window.__nick.scene.timeScale = 1));
  await page.waitForFunction(() => window.__nick.scene.sim.t >= 12, null, { timeout: 60000 });
  await sim(() => window.__nick.scene.sim.addChaos(200, 'cry'));
  await page.waitForSelector('#end[data-open]', { timeout: 10000 });
  await page.tap('#submitBtn');
  await page.waitForFunction(() => /#\d+/.test(document.getElementById('submitMsg').textContent), null, { timeout: 10000 });
  console.log('posted:', await page.textContent('#submitMsg'));
  if (!(await page.$('#endBoard li.me'))) fail('own score not highlighted');
  await page.screenshot({ path: `${OUT}/09b-leaderboard.png` });
} else console.log('no /api: leaderboard checks skipped');

// Make it to 5:00 PM -> game night card, next week unlocked.
await page.evaluate(() => { document.getElementById('end').removeAttribute('data-open'); });
await page.tap('#titleBtn').catch(() => {});
await page.evaluate(() => document.getElementById('startBtn').click());
await page.waitForFunction(() => window.__nick.scene.running);
await sim(() => {
  const s = window.__nick.scene.sim;
  s.t = 479.5 / 1.5;
  s.chaos = 10;
});
await page.waitForSelector('#won[data-open]', { timeout: 15000 });
await page.screenshot({ path: `${OUT}/09c-game-night.png` });
console.log('won:', await page.textContent('#wonTitle'), '| next:', await page.textContent('#nextBtn'));
await page.tap('#nextBtn');
await page.waitForFunction(() => window.__nick.scene.running && window.__nick.scene.sim.week === 2);
console.log('started week', await sim(() => window.__nick.scene.sim.week));

// Landscape phone -> rotate overlay.
await page.setViewportSize({ width: 844, height: 390 });
await page.waitForTimeout(300);
const rot = await page.evaluate(() => getComputedStyle(document.getElementById('rotate')).display);
if (rot !== 'flex') fail('rotate overlay not shown in landscape');
await page.screenshot({ path: `${OUT}/10-rotate.png` });

if (errors.length) fail('page errors:\n' + errors.join('\n'));
await browser.close();
console.log(process.exitCode ? 'smoke FAILED' : 'smoke OK');
