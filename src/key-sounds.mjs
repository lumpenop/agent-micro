/**
 * Consistent 청축 (clicky blue switch) sounds.
 * Same keycap shape/role → same sample every time (no per-key pitch drift).
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

function envGain(g, t0, peak, attack, release) {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + release);
}

/**
 * Fixed 청축 profile — same params → same sound every press.
 * @param {'std'|'wide'|'touch'|'dial'|'joy'} profile
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
    touch: {
      down: { hi: 2300, lo: 880, noise: 1700, thump: 160, bright: 0.9, body: 0.1 },
      up: { hi: 1550, lo: 680, bright: 0.6 },
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
    bp.frequency.value = conf.noise;
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
  playBlue(profileFor(kind, id), 'down');
}

export function playKeyUp(kind = 'cmd', id = '') {
  if (!enabled) return;
  playBlue(profileFor(kind, id), 'up');
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
