/**
 * Consistent 청축 (clicky blue switch) sounds for keycaps.
 * Touch pad uses a separate soft rubber tap — not the same family.
 */

let ctx = null;
let master = null;
let enabled = true;
let lastDialTick = 0;
let lastJoyTick = 0;
let lastJoyDir = null;

function ensureCtx() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.55;
  master.connect(ctx.destination);
  return ctx;
}

function resume() {
  const c = ensureCtx();
  if (c?.state === 'suspended') c.resume().catch(() => {});
  return c;
}

function noiseBuffer(duration) {
  const c = ensureCtx();
  const len = Math.max(1, Math.floor(c.sampleRate * duration));
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

function finite(n, fallback) {
  return Number.isFinite(n) ? n : fallback;
}

function envGain(g, t0, peak, attack, release) {
  const p = Math.max(0.0002, finite(peak, 0.1));
  const a = Math.max(0.0001, finite(attack, 0.001));
  const r = Math.max(0.0001, finite(release, 0.02));
  const t = finite(t0, 0);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(p, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + r);
}

/**
 * Soft rubber touch-pad tap — deliberately not a 청축 click.
 * @param {'down'|'up'} phase
 */
function playTouch(phase) {
  const c = resume();
  if (!c || !master) return;
  const t0 = c.currentTime;

  if (phase === 'down') {
    // muted low thud — pad membrane
    const th = c.createOscillator();
    const tg = c.createGain();
    th.type = 'sine';
    th.frequency.setValueAtTime(95, t0);
    th.frequency.exponentialRampToValueAtTime(48, t0 + 0.07);
    envGain(tg, t0, 0.22, 0.003, 0.09);
    th.connect(tg);
    tg.connect(master);
    th.start(t0);
    th.stop(t0 + 0.11);

    // soft mid body, no sharp square click
    const body = c.createOscillator();
    const bg = c.createGain();
    body.type = 'triangle';
    body.frequency.setValueAtTime(320, t0);
    body.frequency.exponentialRampToValueAtTime(140, t0 + 0.05);
    envGain(bg, t0, 0.1, 0.002, 0.06);
    body.connect(bg);
    bg.connect(master);
    body.start(t0);
    body.stop(t0 + 0.08);

    // filtered noise — rubber brush, not clicky
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(0.06);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    lp.Q.value = 0.7;
    const ng = c.createGain();
    envGain(ng, t0, 0.12, 0.002, 0.05);
    src.connect(lp);
    lp.connect(ng);
    ng.connect(master);
    src.start(t0);
    src.stop(t0 + 0.06);
    return;
  }

  // up — quiet soft release
  const th = c.createOscillator();
  const tg = c.createGain();
  th.type = 'sine';
  th.frequency.setValueAtTime(140, t0);
  th.frequency.exponentialRampToValueAtTime(70, t0 + 0.035);
  envGain(tg, t0, 0.06, 0.002, 0.04);
  th.connect(tg);
  tg.connect(master);
  th.start(t0);
  th.stop(t0 + 0.05);

  const src = c.createBufferSource();
  src.buffer = noiseBuffer(0.03);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 700;
  const ng = c.createGain();
  envGain(ng, t0, 0.05, 0.001, 0.025);
  src.connect(lp);
  lp.connect(ng);
  ng.connect(master);
  src.start(t0);
  src.stop(t0 + 0.03);
}

/**
 * Fixed 청축 profile — same params → same sound every press.
 * @param {'std'|'wide'|'dial'|'joy'} profile
 * @param {'down'|'up'} phase
 */
function playBlue(profile, phase) {
  const c = resume();
  if (!c || !master) return;
  const t0 = c.currentTime;

  const profiles = {
    // standard keycaps: agents + fast/approve/decline/fork/send
    std: {
      down: { hi: 2450, lo: 920, noise: 1850, thump: 175, bright: 1, body: 0.12 },
      up: { hi: 1680, lo: 720, bright: 0.7 },
    },
    // wide mic keycap — same family, slightly deeper housing
    wide: {
      down: { hi: 2200, lo: 820, noise: 1600, thump: 150, bright: 0.95, body: 0.14 },
      up: { hi: 1500, lo: 640, bright: 0.65 },
    },
    dial: {
      down: { hi: 2000, lo: 780, noise: 1500, thump: 140, bright: 0.75, body: 0.1 },
      up: { hi: 1400, lo: 600, bright: 0.55 },
    },
    joy: {
      down: { hi: 1900, lo: 700, noise: 1400, thump: 130, bright: 0.7, body: 0.15 },
      up: { hi: 1300, lo: 560, bright: 0.5 },
    },
  };

  const p = profiles[profile] || profiles.std;
  const conf = phase === 'up' ? p.up : p.down;

  if (phase === 'down') {
    const osc = c.createOscillator();
    const og = c.createGain();
    osc.type = 'square';
    osc.frequency.setValueAtTime(conf.hi, t0);
    osc.frequency.exponentialRampToValueAtTime(conf.lo, t0 + 0.018);
    envGain(og, t0, 0.22 * conf.bright, 0.0015, 0.032);
    osc.connect(og);
    og.connect(master);
    osc.start(t0);
    osc.stop(t0 + 0.04);

    const src = c.createBufferSource();
    src.buffer = noiseBuffer(0.05);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = finite(conf.noise, 1600);
    bp.Q.value = 3.2;
    const ng = c.createGain();
    envGain(ng, t0, 0.34 * conf.bright, 0.001, 0.042);
    src.connect(bp);
    bp.connect(ng);
    ng.connect(master);
    src.start(t0);
    src.stop(t0 + 0.05);

    const th = c.createOscillator();
    const tg = c.createGain();
    th.type = 'triangle';
    th.frequency.setValueAtTime(conf.thump, t0);
    th.frequency.exponentialRampToValueAtTime(62, t0 + 0.04);
    envGain(tg, t0, conf.body, 0.002, 0.055);
    th.connect(tg);
    tg.connect(master);
    th.start(t0);
    th.stop(t0 + 0.07);
    return;
  }

  // upstroke — lighter, same every time for this profile
  const osc = c.createOscillator();
  const og = c.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(conf.hi, t0);
  osc.frequency.exponentialRampToValueAtTime(conf.lo, t0 + 0.012);
  envGain(og, t0, 0.075 * conf.bright, 0.001, 0.02);
  osc.connect(og);
  og.connect(master);
  osc.start(t0);
  osc.stop(t0 + 0.025);

  const src = c.createBufferSource();
  src.buffer = noiseBuffer(0.022);
  const hp = c.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2100;
  const ng = c.createGain();
  envGain(ng, t0, 0.1 * conf.bright, 0.001, 0.018);
  src.connect(hp);
  hp.connect(ng);
  ng.connect(master);
  src.start(t0);
  src.stop(t0 + 0.022);
}

/** Map pad object kind/id → fixed keycap profile */
function profileFor(kind, id) {
  const k = String(kind || '');
  const i = String(id || '');
  const cmd = i.startsWith('cmd:') ? i.slice(4) : k;

  if (cmd === 'mic' || k === 'mic') return 'wide';
  if (k === 'touch' || cmd === 'touch') return 'touch';
  if (k === 'dial' || cmd === 'dial') return 'dial';
  if (k === 'joy' || cmd === 'joy') return 'joy';
  // all standard keycaps share one sound: agents + fast/approve/decline/fork/send
  return 'std';
}

export function playKeyDown(kind = 'cmd', id = '') {
  if (!enabled) return;
  const profile = profileFor(kind, id);
  if (profile === 'touch') playTouch('down');
  else playBlue(profile, 'down');
}

export function playKeyUp(kind = 'cmd', id = '') {
  if (!enabled) return;
  const profile = profileFor(kind, id);
  if (profile === 'touch') playTouch('up');
  else playBlue(profile, 'up');
}

/** Dial detents — same tick every step */
export function playDialTick(_delta = 1) {
  if (!enabled) return;
  const c = resume();
  if (!c || !master) return;
  const now = performance.now();
  if (now - lastDialTick < 28) return;
  lastDialTick = now;
  const t0 = c.currentTime;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = 'square';
  osc.frequency.value = 1950;
  envGain(g, t0, 0.065, 0.001, 0.011);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + 0.016);
}

/** Joy nudge — same 청축 tick for every direction */
export function playJoyTick(dir = 'up') {
  if (!enabled) return;
  const c = resume();
  if (!c || !master) return;
  const now = performance.now();
  if (dir === lastJoyDir && now - lastJoyTick < 160) return;
  lastJoyDir = dir;
  lastJoyTick = now;
  playBlue('joy', 'down');
}

export function setKeySoundsEnabled(on) {
  enabled = !!on;
}

export function areKeySoundsEnabled() {
  return enabled;
}
