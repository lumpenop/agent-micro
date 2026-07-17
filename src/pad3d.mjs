import * as THREE from './vendor/three.mjs';
import { RoundedBoxGeometry } from './vendor/geometries/RoundedBoxGeometry.mjs';
import { RoomEnvironment } from './vendor/RoomEnvironment.mjs';
import { iconImageUrl } from './icons.mjs';
import { playKeyDown, playKeyUp, playDialTick, playJoyTick } from './key-sounds.mjs';

/** Match HUD legend (--thinking/complete/input/error); idle stays neutral gray for frost */
const STATUS_COLOR = {
  idle: 0x8fa5b4,
  thinking: 0x4aa3ff,
  complete: 0x3ecf7a,
  input: 0xf0c24b,
  error: 0xef4d4d,
  off: 0x000000,
};

const LAYOUT = [
  ['touch', 'agent:0', 'agent:1', 'dial'],
  ['agent:2', 'agent:3', 'agent:4', 'agent:5'],
  ['cmd:fast', 'cmd:approve', 'cmd:decline', 'cmd:fork'],
  ['joy', 'cmd:mic', null, 'cmd:send'], // mic spans 2 via special case
];

/** Per-icon face size — send/mic settled halfway from last tweak */
function iconPlaneSize(iconId, wide = false) {
  if (iconId === 'send') return wide ? 0.56 : 0.46;
  if (iconId === 'mic') return wide ? 0.49 : 0.42;
  if (String(iconId || '').startsWith('custom_')) return wide ? 0.56 : 0.46;
  return wide ? 0.54 : 0.44;
}

function iconTexFill(iconId) {
  if (iconId === 'send') return 0.68;
  if (iconId === 'mic') return 0.61;
  if (String(iconId || '').startsWith('custom_')) return 0.7;
  return 0.64;
}

function makeIconTexture(iconId) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;

  const url = iconImageUrl(iconId, { size, color: '#141414' });
  if (!url) return tex;
  const img = new Image();
  img.onload = () => {
    // Draw oversized, then re-center on alpha bounds so every glyph sits dead-center
    const scratch = document.createElement('canvas');
    scratch.width = scratch.height = size;
    const sctx = scratch.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    const pad = size * 0.14;
    sctx.clearRect(0, 0, size, size);
    sctx.drawImage(img, pad, pad, size - pad * 2, size - pad * 2);

    const { data } = sctx.getImageData(0, 0, size, size);
    let minX = size;
    let minY = size;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (data[(y * size + x) * 4 + 3] < 12) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }

    ctx.clearRect(0, 0, size, size);
    if (maxX < minX || maxY < minY) {
      ctx.drawImage(scratch, 0, 0);
    } else {
      const bw = maxX - minX + 1;
      const bh = maxY - minY + 1;
      const side = Math.max(bw, bh);
      const target = size * iconTexFill(iconId);
      const scale = target / side;
      const dw = bw * scale;
      const dh = bh * scale;
      const dx = (size - dw) * 0.5;
      const dy = (size - dh) * 0.5;
      ctx.drawImage(scratch, minX, minY, bw, bh, dx, dy, dw, dh);
    }
    tex.needsUpdate = true;
  };
  img.src = url;
  return tex;
}

/** Shared keycap shell — every 1u key uses identical size + rounding */
const CAP = {
  w: 0.92,
  h: 0.54,
  d: 0.92,
  r: 0.19,
  segs: 6,
  wideW: 1.95,
  // Camera sits at +Z — slight nudge for cream face art
  faceZ: 0.02,
  /** Frost status disc — fixed radius, never scaled per-key */
  glowR: 0.2,
};

/** Keep status disc optically centered under the tilted top-down camera. */
function placeAgentGlow(agentMesh) {
  const glow = agentMesh?.userData?.glow;
  if (!glow || !agentMesh) return;
  const y = CAP.h * 0.5 + 0.014;
  // Light perspective counter — keep disc in the visual middle of the key
  glow.position.set(
    -agentMesh.position.x * 0.028,
    y,
    -agentMesh.position.z * 0.032 + 0.038
  );
  glow.scale.set(1, 1, 1);
  // Rebuild geometry if radius constant changed at runtime
  if (glow.geometry?.parameters?.radius !== CAP.glowR) {
    glow.geometry?.dispose?.();
    glow.geometry = new THREE.CircleGeometry(CAP.glowR, 48);
  }
}

let _capTopTex = null;
let _capTopFrostTex = null;
function capTopTexture(frost = false) {
  // Full-bleed soft lighting only — NEVER clip a roundRect (that paints black corners on UVs)
  const cached = frost ? _capTopFrostTex : _capTopTex;
  if (cached) return cached;
  const size = 256;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');

  if (frost) {
    // Original frost look (unchanged)
    const base = ctx.createRadialGradient(108, 96, 12, 128, 128, 180);
    base.addColorStop(0, '#ffffff');
    base.addColorStop(0.5, '#eaf2f9');
    base.addColorStop(0.85, '#d2e2f0');
    base.addColorStop(1, '#c0d4e6');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);
    const lip = ctx.createLinearGradient(0, 0, 0, size * 0.55);
    lip.addColorStop(0, 'rgba(255,255,255,0.35)');
    lip.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = lip;
    ctx.fillRect(0, 0, size, size);
  } else {
    // Cream: clean top face — dark AO only on the outer lip (no dirty center)
    const cx = size * 0.5;
    const cy = size * 0.5;
    const base = ctx.createRadialGradient(size * 0.42, size * 0.38, 12, cx, cy, size * 0.7);
    base.addColorStop(0, '#fffdf9');
    base.addColorStop(0.5, '#f7f3ea');
    base.addColorStop(0.85, '#efe9de');
    base.addColorStop(1, '#e4ddd0');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, size, size);

    // soft TL highlight only (no black wash across the face)
    const rim = ctx.createLinearGradient(0, 0, size * 0.6, size * 0.6);
    rim.addColorStop(0, 'rgba(255,255,255,0.42)');
    rim.addColorStop(0.45, 'rgba(255,255,255,0.1)');
    rim.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = rim;
    ctx.fillRect(0, 0, size, size);

    // Outer-edge AO only — stronger lip, still clear of the top center
    const ao = ctx.createRadialGradient(cx, cy, size * 0.48, cx, cy, size * 0.74);
    ao.addColorStop(0, 'rgba(0,0,0,0)');
    ao.addColorStop(0.42, 'rgba(0,0,0,0)');
    ao.addColorStop(0.68, 'rgba(55,45,35,0.08)');
    ao.addColorStop(0.86, 'rgba(40,32,24,0.2)');
    ao.addColorStop(1, 'rgba(28,22,16,0.34)');
    ctx.fillStyle = ao;
    ctx.fillRect(0, 0, size, size);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  if (frost) _capTopFrostTex = tex;
  else _capTopTex = tex;
  return tex;
}

let _capShadowTex = null;
function capShadowTexture() {
  if (_capShadowTex) return _capShadowTex;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size * 0.47, size * 0.47, size * 0.1, size * 0.54, size * 0.56, size * 0.5);
  g.addColorStop(0, 'rgba(0,0,0,0.38)');
  g.addColorStop(0.5, 'rgba(0,0,0,0.14)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  _capShadowTex = new THREE.CanvasTexture(c);
  _capShadowTex.colorSpace = THREE.SRGBColorSpace;
  return _capShadowTex;
}

let _glowTex = null;
function glowTexture() {
  if (_glowTex) return _glowTex;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  // Harder disc — readable at rest, same footprint when selected
  const g = ctx.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size * 0.5);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.68, 'rgba(255,255,255,1)');
  g.addColorStop(0.86, 'rgba(255,255,255,0.65)');
  g.addColorStop(0.96, 'rgba(255,255,255,0.15)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  _glowTex = new THREE.CanvasTexture(c);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}

function keycapMesh({ wide = false, frost = false, iconId = null } = {}) {
  const w = wide ? CAP.wideW : CAP.w;
  const h = CAP.h;
  const d = CAP.d;
  const r = CAP.r;

  // —— Frost: original simple shell (pre-sculpt) ——
  if (frost) {
    const geo = new RoundedBoxGeometry(w, h, d, CAP.segs, r);
    const mat = new THREE.MeshPhysicalMaterial({
      map: capTopTexture(true),
      color: 0xffffff,
      roughness: 0.35,
      metalness: 0.02,
      transparent: true,
      opacity: 0.55,
      clearcoat: 0.2,
      clearcoatRoughness: 0.5,
      transmission: 0,
      depthWrite: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;

    const skirt = new THREE.Mesh(
      new RoundedBoxGeometry(w * 0.98, h * 0.55, d * 0.98, CAP.segs, r * 0.9),
      new THREE.MeshPhysicalMaterial({
        color: 0x9bb6cc,
        roughness: 0.5,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
      })
    );
    skirt.position.y = -h * 0.12;
    mesh.add(skirt);

    const core = new THREE.Mesh(
      new RoundedBoxGeometry(w * 0.7, h * 0.38, d * 0.7, 4, r * 0.65),
      new THREE.MeshStandardMaterial({
        color: 0x6e7e8c,
        roughness: 0.72,
        metalness: 0.06,
      })
    );
    core.position.y = -h * 0.04;
    mesh.add(core);

    // Center disc — fixed radius; world offset applied after key is placed
    const glow = new THREE.Mesh(
      new THREE.CircleGeometry(CAP.glowR, 48),
      new THREE.MeshBasicMaterial({
        map: glowTexture(),
        color: STATUS_COLOR.idle,
        transparent: true,
        opacity: 0.82,
        toneMapped: false,
        depthTest: false,
        depthWrite: false,
      })
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.set(0, h * 0.5 + 0.014, 0);
    glow.scale.set(1, 1, 1);
    glow.renderOrder = 5;
    glow.raycast = () => {};
    mesh.add(glow);
    mesh.userData.glow = glow;

    const light = new THREE.PointLight(STATUS_COLOR.idle, 0.55, 1.85);
    light.position.y = 0.05;
    mesh.add(light);
    mesh.userData.light = light;

    mesh.userData.restY = 0;
    mesh.userData.pressY = -0.1;
    return mesh;
  }

  // —— Cream: matte sculpt, a bit more volume, not glossy ——
  const geo = new RoundedBoxGeometry(w * 0.97, h * 0.78, d * 0.97, CAP.segs, r);
  const mat = new THREE.MeshStandardMaterial({
    map: capTopTexture(false),
    color: 0xffffff,
    roughness: 0.72,
    metalness: 0.01,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 1.16, d * 1.16),
    new THREE.MeshBasicMaterial({
      map: capShadowTexture(),
      transparent: true,
      opacity: 0.62,
      depthWrite: false,
      toneMapped: false,
    })
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0.035, -h * 0.5, 0.045);
  shadow.renderOrder = 1;
  shadow.raycast = () => {};
  mesh.add(shadow);

  const skirt = new THREE.Mesh(
    new RoundedBoxGeometry(w * 1.03, h * 0.42, d * 1.03, CAP.segs, r * 0.95),
    new THREE.MeshStandardMaterial({
      color: 0xc8c2b4,
      roughness: 0.78,
      metalness: 0.02,
    })
  );
  skirt.position.y = -h * 0.2;
  skirt.castShadow = true;
  mesh.add(skirt);

  const top = new THREE.Mesh(
    new RoundedBoxGeometry(w * 0.9, h * 0.2, d * 0.9, CAP.segs, r * 0.88),
    new THREE.MeshStandardMaterial({
      map: capTopTexture(false),
      color: 0xffffff,
      roughness: 0.64,
      metalness: 0.01,
    })
  );
  top.position.y = h * 0.3;
  top.castShadow = true;
  mesh.add(top);

  // Soft light well — warm cream, not a dirty gray disc
  const faceY = h * 0.42 + 0.01;
  const dish = new THREE.Mesh(
    new THREE.CircleGeometry(0.27, 48),
    new THREE.MeshBasicMaterial({
      map: glowTexture(),
      color: 0xf2ebe0,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      toneMapped: false,
    })
  );
  dish.rotation.x = -Math.PI / 2;
  dish.position.set(0, faceY, CAP.faceZ);
  dish.renderOrder = 3;
  dish.raycast = () => {};
  mesh.add(dish);

  if (iconId) {
    const tex = makeIconTexture(iconId);
    const iconMat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
    });
    const iconSize = iconPlaneSize(iconId, wide);
    const iconMesh = new THREE.Mesh(new THREE.PlaneGeometry(iconSize, iconSize), iconMat);
    iconMesh.rotation.x = -Math.PI / 2;
    iconMesh.position.set(0, faceY + 0.006, CAP.faceZ);
    mesh.add(iconMesh);
    mesh.userData.iconMesh = iconMesh;
    mesh.userData.iconWide = wide;
  }

  mesh.userData.restY = 0;
  mesh.userData.pressY = -0.1;
  return mesh;
}

export function createPad3D(container, handlers = {}) {
  const scene = new THREE.Scene();
  scene.background = null;

  const w = Math.max(container.clientWidth || 0, 280);
  const h = Math.max(container.clientHeight || 0, 280);

  // Near top-down — pull back so thick rim shows
  const camera = new THREE.PerspectiveCamera(28, w / h, 0.1, 100);
  camera.position.set(0, 11.25, 1.4);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(w, h);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  container.appendChild(renderer.domElement);
  renderer.domElement.style.width = '100%';
  renderer.domElement.style.height = '100%';
  renderer.domElement.style.display = 'block';
  renderer.domElement.style.borderRadius = '36px';

  // lights — soft matte key (volume without gloss)
  const amb = new THREE.AmbientLight(0xffffff, 0.38);
  scene.add(amb);
  const key = new THREE.DirectionalLight(0xfff2e4, 1.15);
  key.position.set(-2.8, 9.8, 4.2);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.near = 1;
  key.shadow.camera.far = 24;
  key.shadow.camera.left = -5;
  key.shadow.camera.right = 5;
  key.shadow.camera.top = 5;
  key.shadow.camera.bottom = -5;
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.03;
  key.shadow.radius = 3.5;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xc8d6ea, 0.32);
  fill.position.set(5, 4, -3);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.18);
  rim.position.set(-1, 5, 5);
  scene.add(rim);
  const hemi = new THREE.HemisphereLight(0xf5f7fa, 0x6a7380, 0.42);
  scene.add(hemi);

  // Same shell — thicker outer rim only (opaque, no glass film)
  const CHASSIS_BASE = 0xb8c4d0;
  const chassis = new THREE.Mesh(
    new RoundedBoxGeometry(5.55, 0.62, 5.55, 7, 0.55),
    new THREE.MeshStandardMaterial({
      color: CHASSIS_BASE,
      roughness: 0.42,
      metalness: 0.1,
      emissive: 0x000000,
      emissiveIntensity: 0,
    })
  );
  chassis.position.y = -0.15;
  chassis.receiveShadow = true;
  chassis.castShadow = true;
  scene.add(chassis);

  let chassisRecording = false;
  /** Soft case glow from the selected clear key */
  function syncChassisGlow() {
    if (chassisRecording) {
      chassis.material.emissive.setHex(0x1ecf9a);
      chassis.material.emissiveIntensity = 0.16;
      chassis.material.color.setHex(CHASSIS_BASE);
      chassis.userData.glowPulse = false;
      return;
    }
    const lit = agents.find(
      (a) => a?.userData?.selected && a.userData.status && a.userData.status !== 'off'
    );
    if (!lit) {
      chassis.material.emissive.setHex(0x000000);
      chassis.material.emissiveIntensity = 0;
      chassis.material.color.setHex(CHASSIS_BASE);
      chassis.userData.glowPulse = false;
      return;
    }
    const hex = STATUS_COLOR[lit.userData.status] ?? STATUS_COLOR.idle;
    const glow = new THREE.Color(hex);
    // pastel shell tint + richer emissive (reference: case matches key LED)
    const tint = new THREE.Color(CHASSIS_BASE).lerp(glow, 0.42);
    chassis.material.color.copy(tint);
    chassis.material.emissive.copy(glow);
    chassis.material.emissiveIntensity = 0.28;
    chassis.userData.glowPulse = true;
  }

  // Plate inset so only the outer rim reads thicker
  const plate = new THREE.Mesh(
    new RoundedBoxGeometry(4.3, 0.14, 4.3, 5, 0.28),
    new THREE.MeshStandardMaterial({
      color: 0x5a6570,
      roughness: 0.72,
      metalness: 0.18,
    })
  );
  plate.position.y = 0.1;
  plate.receiveShadow = true;
  scene.add(plate);

  const wellRim = new THREE.Mesh(
    new RoundedBoxGeometry(4.38, 0.06, 4.38, 5, 0.3),
    new THREE.MeshStandardMaterial({
      color: 0x3e4750,
      roughness: 0.8,
      metalness: 0.1,
    })
  );
  wellRim.position.y = 0.04;
  wellRim.receiveShadow = true;
  scene.add(wellRim);

  const interactives = [];
  const agents = [];
  const cmds = {};
  const gap = 1.05;
  const originX = -1.575;
  const originZ = -1.575;

  // dial — outer Ø ≈ 0.90 (keycap 0.92)
  const dialGroup = new THREE.Group();
  const dialBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.42, 0.44, 0.1, 48),
    new THREE.MeshStandardMaterial({ color: 0x2e353c, roughness: 0.6, metalness: 0.3 })
  );
  // shadow well under the knob emphasizes the round silhouette
  const dialWell = new THREE.Mesh(
    new THREE.CircleGeometry(0.43, 48),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    })
  );
  dialWell.rotation.x = -Math.PI / 2;
  dialWell.position.y = 0.055;
  dialGroup.add(dialWell);

  // smooth knob — dark shaded side wall + bright top makes the circle read
  const dialSideMat = new THREE.MeshPhysicalMaterial({
    color: 0x767268,
    roughness: 0.52,
    clearcoat: 0.3,
    clearcoatRoughness: 0.35,
  });
  // top face: offset radial gradient → shaded dome look
  const topShade = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(104, 90, 10, 128, 128, 148);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.5, '#efece3');
    g.addColorStop(0.8, '#d2cec1');
    g.addColorStop(1, '#a8a496');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 256, 256);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  })();
  const dialTopMat = new THREE.MeshPhysicalMaterial({
    map: topShade,
    roughness: 0.24,
    clearcoat: 0.75,
    clearcoatRoughness: 0.18,
  });
  const dialKnob = new THREE.Mesh(
    new THREE.CylinderGeometry(0.355, 0.375, 0.28, 64),
    [dialSideMat, dialTopMat, dialSideMat]
  );
  dialKnob.position.y = 0.18;
  dialKnob.castShadow = true;

  const mark = new THREE.Mesh(
    new THREE.BoxGeometry(0.04, 0.04, 0.17),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4 })
  );
  mark.position.set(0, 0.15, -0.17);
  dialKnob.add(mark);

  // thin groove near the rim — subtle circular cue, stays smooth
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.31, 0.01, 8, 64),
    new THREE.MeshStandardMaterial({ color: 0xc4c0b6, roughness: 0.5 })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.145;
  dialKnob.add(ring);

  dialGroup.add(dialBase, dialKnob);
  // slightly left of the agent column
  // Top-right (swapped with Touch)
  dialGroup.position.set(originX + gap * 3 + 0.02, 0.28, originZ);
  dialGroup.userData = { type: 'dial', knob: dialKnob };
  dialBase.userData = { type: 'dial' };
  dialKnob.userData = { type: 'dial' };
  scene.add(dialGroup);
  interactives.push(dialBase, dialKnob);

  // joystick — midway between soft gray and touch-pad charcoal
  const joyGroup = new THREE.Group();
  const joyWell = new THREE.Mesh(
    new THREE.CircleGeometry(0.44, 48),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.33,
      depthWrite: false,
    })
  );
  joyWell.rotation.x = -Math.PI / 2;
  joyWell.position.y = 0.015;
  joyGroup.add(joyWell);

  const joyFloor = new THREE.Mesh(
    new THREE.CircleGeometry(0.33, 48),
    new THREE.MeshStandardMaterial({ color: 0x252a30, roughness: 0.88, metalness: 0.04 })
  );
  joyFloor.rotation.x = -Math.PI / 2;
  joyFloor.position.y = 0.055;
  joyGroup.add(joyFloor);

  const joyBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.37, 0.39, 0.1, 48),
    new THREE.MeshStandardMaterial({ color: 0x2f363c, roughness: 0.82, metalness: 0.05 })
  );
  const joyGate = new THREE.Mesh(
    new THREE.TorusGeometry(0.32, 0.024, 10, 48),
    new THREE.MeshStandardMaterial({ color: 0x5a636c, roughness: 0.72, metalness: 0.08 })
  );
  joyGate.rotation.x = Math.PI / 2;
  joyGate.position.y = 0.06;

  const joyStick = new THREE.Group();
  const joyBoot = new THREE.Mesh(
    new THREE.SphereGeometry(0.155, 28, 20),
    new THREE.MeshStandardMaterial({ color: 0x3a424a, roughness: 0.9, metalness: 0.03 })
  );
  joyBoot.scale.set(1, 0.55, 1);
  joyBoot.position.y = 0.065;
  const joyShaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.058, 0.072, 0.24, 24),
    new THREE.MeshStandardMaterial({ color: 0x5a646e, roughness: 0.78, metalness: 0.04 })
  );
  joyShaft.position.y = 0.18;
  joyShaft.castShadow = false;
  const joyCap = new THREE.Mesh(
    new THREE.SphereGeometry(0.145, 32, 24),
    new THREE.MeshStandardMaterial({ color: 0x454e56, roughness: 0.8, metalness: 0.04 })
  );
  joyCap.scale.set(1, 0.72, 1);
  joyCap.position.y = 0.32;
  joyCap.castShadow = true;
  const joyDimple = new THREE.Mesh(
    new THREE.SphereGeometry(0.1, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.45),
    new THREE.MeshStandardMaterial({ color: 0x2e343a, roughness: 0.85, side: THREE.BackSide })
  );
  joyDimple.rotation.x = Math.PI;
  joyDimple.scale.set(1, 0.4, 1);
  joyDimple.position.y = 0.4;
  joyStick.add(joyBoot, joyShaft, joyCap, joyDimple);
  // Rest lean (camera-aware) — flipped from first pass
  const JOY_REST_TILT_X = -0.16;
  const JOY_REST_TILT_Z = 0.05;
  // Tall invisible hit volume — wins over neighboring agent keys (keys sit higher)
  const joyHit = new THREE.Mesh(
    new THREE.CylinderGeometry(0.48, 0.48, 0.7, 24),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  joyHit.position.y = 0.28;
  joyHit.userData = { type: 'joy' };
  joyGroup.add(joyBase, joyGate, joyStick, joyHit);
  // Bottom-left (swapped with Touch)
  joyGroup.position.set(originX - 0.02, 0.28, originZ + gap * 3 + 0.04);
  joyGroup.userData = { type: 'joy', stick: joyStick };
  joyBase.userData = { type: 'joy' };
  joyStick.userData = { type: 'joy' };
  scene.add(joyGroup);
  interactives.push(joyBase, joyStick, joyHit);

  // touch pad (top-right) + 3 layer LEDs beside it
  const touchGroup = new THREE.Group();

  // circular capacitive pad
  const touch = new THREE.Mesh(
    new THREE.CylinderGeometry(0.22, 0.24, 0.1, 32),
    new THREE.MeshStandardMaterial({
      color: 0x141414,
      roughness: 0.35,
      metalness: 0.35,
    })
  );
  touch.castShadow = true;
  touch.position.set(-0.22, 0.06, 0);
  touchGroup.add(touch);

  // glossy highlight ring on pad
  const touchRing = new THREE.Mesh(
    new THREE.TorusGeometry(0.16, 0.012, 8, 32),
    new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.3, metalness: 0.5 })
  );
  touchRing.rotation.x = Math.PI / 2;
  touchRing.position.set(-0.22, 0.12, 0);
  touchGroup.add(touchRing);

  // vertical LED stack to the right of the pad
  const touchLeds = [];
  const ledLights = [];
  for (let i = 0; i < 3; i++) {
    const led = new THREE.Mesh(
      new RoundedBoxGeometry(0.08, 0.05, 0.14, 2, 0.02),
      new THREE.MeshStandardMaterial({
        color: 0x8a929a,
        emissive: 0x000000,
        emissiveIntensity: 0,
        roughness: 0.35,
        metalness: 0.1,
      })
    );
    // top → bottom = layer 0,1,2
    led.position.set(0.22, 0.1, (i - 1) * 0.2);
    touchGroup.add(led);
    touchLeds.push(led);

    const pl = new THREE.PointLight(0x5a9cff, 0, 0.85);
    pl.position.copy(led.position);
    pl.position.y = 0.18;
    touchGroup.add(pl);
    ledLights.push(pl);
  }

  // invisible hit volume covering pad + leds
  const touchHit = new THREE.Mesh(
    new THREE.BoxGeometry(0.95, 0.45, 0.85),
    new THREE.MeshBasicMaterial({ visible: false })
  );
  touchHit.position.set(0, 0.08, 0);
  touchGroup.add(touchHit);

  // Top-left (swapped with Dial)
  touchGroup.position.set(originX + 0.08, 0.28, originZ);
  touch.userData = { type: 'touch', baseY: 0.06 };
  touchHit.userData = { type: 'touch' };
  touchGroup.userData = { type: 'touch', leds: touchLeds, cap: touch, lights: ledLights };
  scene.add(touchGroup);
  interactives.push(touch, touchHit);

  // agent keys
  const agentSlots = [
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1],
  ];
  agentSlots.forEach(([col, row], i) => {
    const m = keycapMesh({ frost: true });
    m.position.set(originX + gap * col, 0.42, originZ + gap * row);
    m.userData = { ...m.userData, type: 'agent', index: i };
    placeAgentGlow(m);
    scene.add(m);
    agents[i] = m;
    interactives.push(m);
  });

  // command keys
  const cmdSlots = [
    ['fast', 0, 2, false],
    ['approve', 1, 2, false],
    ['decline', 2, 2, false],
    ['fork', 3, 2, false],
    ['mic', 1, 3, true],
    ['send', 3, 3, false],
  ];
  // mic centered between col 1-2
  cmdSlots.forEach(([name, col, row, wide]) => {
    const m = keycapMesh({ wide, frost: false, iconId: name === 'send' ? 'send' : name === 'mic' ? 'mic' : name === 'fast' ? 'lightning' : name === 'approve' ? 'check' : name === 'decline' ? 'times' : 'fork' });
    const x = wide ? originX + gap * 1.5 : originX + gap * col;
    m.position.set(x, 0.42, originZ + gap * row);
    m.userData = { ...m.userData, type: 'cmd', cmd: name, baseY: 0.42 };
    scene.add(m);
    cmds[name] = m;
    interactives.push(m);
  });

  // edge label — text only, no backing plate / shadow blob
  function makeLabel(text, x, z) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 64;
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.font = '28px "SF Pro Text", Avenir, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(40,45,55,0.45)';
    ctx.fillText(text, 256, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.premultiplyAlpha = false;
    const mat = new THREE.SpriteMaterial({
      map: tex,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(2.2, 0.28, 1);
    spr.position.set(x, 0.35, z);
    scene.add(spr);
    return spr;
  }
  makeLabel('Agent Micro', 0, 2.35);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pressed = null;
  let dialDragging = false;
  let dialLastAngle = 0;
  let joyDragging = false;
  let joyTx = 0;
  let joyTz = 0;
  let joyCx = 0;
  let joyCz = 0;
  let raf = 0;

  function applyJoyPose(x, z) {
    // light, snappy tilt — more throw, less drag feel
    const max = 0.2;
    const nx = x / max;
    const nz = z / max;
    joyStick.position.x = x * 0.55;
    joyStick.position.z = z * 0.55 - 0.012; // slight bias matching rest lean
    joyStick.rotation.z = JOY_REST_TILT_Z - nx * 0.62;
    joyStick.rotation.x = JOY_REST_TILT_X + nz * 0.62;
  }

  applyJoyPose(0, 0);

  /** Snap stick to center (e.g. when app loses focus to Codex / other windows). */
  function resetJoy() {
    joyDragging = false;
    joyTx = 0;
    joyTz = 0;
    joyCx = 0;
    joyCz = 0;
    applyJoyPose(0, 0);
    if (pressed?.userData?.type === 'joy') pressed = null;
  }

  function onFocusLost() {
    // Soft recenter only — pad is re-focused after Codex shortcuts so keep usable
    joyTx = 0;
    joyTz = 0;
    if (!joyDragging) {
      joyCx = 0;
      joyCz = 0;
      applyJoyPose(0, 0);
    }
    joyDragging = false;
    dialDragging = false;
    if (pressed?.userData?.type === 'cmd' && pressed.userData.cmd === 'mic') {
      handlers.onCmdRelease?.('mic');
    }
    if (pressed) {
      pressVisual(pressed, false);
      pressed = null;
    }
  }

  window.addEventListener('blur', onFocusLost);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) onFocusLost();
  });

  function ndc(e) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
  }

  function pick(e) {
    ndc(e);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(interactives, true);
    if (!hits.length) return null;
    const resolved = [];
    for (const hit of hits) {
      let obj = hit.object;
      while (obj && !obj.userData?.type) obj = obj.parent;
      if (obj?.userData?.type && !resolved.includes(obj)) resolved.push(obj);
    }
    // Prefer stick/dial/touch over keycaps — keys sit higher and steal edge hits
    const control = resolved.find((o) =>
      o.userData.type === 'joy' || o.userData.type === 'dial' || o.userData.type === 'touch'
    );
    return control || resolved[0] || null;
  }

  const _dialScreen = new THREE.Vector3();
  function pointerAngle(e) {
    // project actual dial world position → screen
    _dialScreen.set(0, 0.35, 0);
    dialGroup.localToWorld(_dialScreen);
    _dialScreen.project(camera);
    const rect = renderer.domElement.getBoundingClientRect();
    const cx = rect.left + ((_dialScreen.x + 1) / 2) * rect.width;
    const cy = rect.top + ((-_dialScreen.y + 1) / 2) * rect.height;
    return (Math.atan2(e.clientX - cx, cy - e.clientY) * 180) / Math.PI;
  }

  function shortestDelta(from, to) {
    let d = to - from;
    d = ((d + 180) % 360) - 180;
    if (d < -180) d += 360;
    return d;
  }

  function pressVisual(obj, down) {
    if (!obj) return;
    if (obj.userData.type === 'agent' || obj.userData.type === 'cmd') {
      obj.position.y = down ? 0.28 : 0.42;
    }
    if (obj.userData.type === 'touch') {
      const cap = touchGroup.userData.cap || touch;
      const base = cap.userData.baseY ?? 0.06;
      cap.position.y = down ? base - 0.04 : base;
    }
  }

  function setTouchLayer(layer) {
    touchLeds.forEach((led, i) => {
      const on = i === layer;
      led.material.emissive.setHex(on ? 0x5a9cff : 0x000000);
      led.material.emissiveIntensity = on ? 1.4 : 0;
      led.material.color.setHex(on ? 0xa8d0ff : 0x8a929a);
      if (ledLights[i]) ledLights[i].intensity = on ? 0.7 : 0;
    });
  }
  setTouchLayer(0);

  function soundIdFor(obj) {
    const t = obj?.userData?.type;
    if (t === 'agent') return `agent:${obj.userData.index}`;
    if (t === 'cmd') return `cmd:${obj.userData.cmd}`;
    return t || 'key';
  }

  function soundKindFor(obj) {
    const t = obj?.userData?.type;
    if (t === 'cmd') return obj.userData.cmd || 'cmd';
    if (t === 'agent') return 'agent';
    if (t === 'touch') return 'touch';
    if (t === 'dial') return 'dial';
    if (t === 'joy') return 'joy';
    return 'cmd';
  }

  renderer.domElement.addEventListener('pointerdown', (e) => {
    const obj = pick(e);
    if (!obj) return;
    if (obj.userData?.disabled) return;
    pressed = obj;
    renderer.domElement.setPointerCapture(e.pointerId);

    if (obj.userData.type === 'dial') {
      dialDragging = true;
      dialLastAngle = pointerAngle(e);
      playKeyDown('dial', 'dial');
      handlers.onDialStart?.();
      e.preventDefault();
      return;
    }
    if (obj.userData.type === 'joy') {
      joyDragging = true;
      playKeyDown('joy', 'joy');
      e.preventDefault();
      return;
    }
    pressVisual(obj, true);
    playKeyDown(soundKindFor(obj), soundIdFor(obj));
    // Mic: press-to-talk starts on down
    if (obj.userData.type === 'cmd' && obj.userData.cmd === 'mic') {
      handlers.onCmdPress?.('mic');
    }
  });

  renderer.domElement.addEventListener('pointermove', (e) => {
    if (dialDragging) {
      const a = pointerAngle(e);
      // cw > 0 = clockwise on screen; rotation.y decreases for clockwise (top-down Y-up)
      const cw = shortestDelta(dialLastAngle, a);
      dialLastAngle = a;
      dialKnob.rotation.y -= (cw * Math.PI) / 180;
      if (Math.abs(cw) > 2) playDialTick(cw);
      handlers.onDialDelta?.(cw);
      e.preventDefault();
      return;
    }
    if (joyDragging) {
      const rect = renderer.domElement.getBoundingClientRect();
      _dialScreen.set(0, 0.35, 0);
      joyGroup.localToWorld(_dialScreen);
      _dialScreen.project(camera);
      const cx = rect.left + ((_dialScreen.x + 1) / 2) * rect.width;
      const cy = rect.top + ((-_dialScreen.y + 1) / 2) * rect.height;
      // smaller divisor = more throw per pixel (lighter feel)
      let dx = (e.clientX - cx) / 36;
      let dy = (e.clientY - cy) / 36;
      const len = Math.hypot(dx, dy) || 1;
      const max = 0.2;
      if (len > max) {
        dx = (dx / len) * max;
        dy = (dy / len) * max;
      }
      joyTx = dx;
      joyTz = dy;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.07) {
        const dir =
          Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
        playJoyTick(dir);
        handlers.onJoy?.(dir);
      }
      e.preventDefault();
      return;
    }
  });

  renderer.domElement.addEventListener('pointerup', (e) => {
    if (dialDragging) {
      playKeyUp('dial', 'dial');
      dialDragging = false;
      pressed = null;
      return;
    }
    if (joyDragging || pressed?.userData?.type === 'joy') {
      playKeyUp('joy', 'joy');
      joyDragging = false;
      joyTx = 0;
      joyTz = 0;
      pressed = null;
      return;
    }
    if (!pressed) return;
    const downObj = pressed;
    pressVisual(downObj, false);
    playKeyUp(soundKindFor(downObj), soundIdFor(downObj));
    // Activate based on where the press started — not where it ended
    // (dragging off a key onto an agent must not fire that agent)
    const obj = downObj;
    const t = obj.userData?.type;
    if (t === 'agent') handlers.onAgent?.(obj.userData.index);
    if (t === 'cmd') {
      const cmd = obj.userData.cmd ?? downObj.userData.cmd;
      if (downObj.userData?.disabled || obj.userData?.disabled) {
        /* ignore disabled keys */
      } else if (cmd === 'mic') handlers.onCmdRelease?.('mic');
      else handlers.onCmd?.(cmd);
    }
    if (t === 'touch') handlers.onTouch?.();
    pressed = null;
  });

  renderer.domElement.addEventListener('pointercancel', () => {
    if (pressed?.userData?.type === 'cmd' && pressed.userData.cmd === 'mic') {
      handlers.onCmdRelease?.('mic');
    }
    if (pressed) pressVisual(pressed, false);
    pressed = null;
    dialDragging = false;
    joyDragging = false;
    joyTx = 0;
    joyTz = 0;
  });

  renderer.domElement.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const obj = pick(e);
    if (obj?.userData?.type === 'cmd') handlers.onIconPick?.(obj.userData.cmd);
  });

  renderer.domElement.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      // scroll up → clockwise → higher
      const cw = e.deltaY > 0 ? -12 : 12;
      dialKnob.rotation.y -= (cw * Math.PI) / 180;
      handlers.onDialDelta?.(cw);
    },
    { passive: false }
  );

  function animate() {
    raf = requestAnimationFrame(animate);
    // Keep glow size locked — selection is color/opacity only
    agents.forEach((a) => {
      if (a.userData.glow) a.userData.glow.scale.set(1, 1, 1);
    });
    // Soft breathing on the outer shell when a clear key is selected
    if (chassis.userData.glowPulse && !chassisRecording) {
      const pulse = 0.22 + (Math.sin(performance.now() * 0.0028) * 0.5 + 0.5) * 0.12;
      chassis.material.emissiveIntensity = pulse;
    }
    // snappy follow + quick spring return
    const ease = joyDragging ? 0.58 : 0.42;
    joyCx += (joyTx - joyCx) * ease;
    joyCz += (joyTz - joyCz) * ease;
    if (Math.abs(joyCx) < 0.0008) joyCx = 0;
    if (Math.abs(joyCz) < 0.0008) joyCz = 0;
    applyJoyPose(joyCx, joyCz);
    renderer.render(scene, camera);
  }
  animate();

  function resize() {
    const ww = container.clientWidth;
    const hh = container.clientHeight;
    camera.aspect = ww / hh;
    camera.updateProjectionMatrix();
    renderer.setSize(ww, hh);
  }
  window.addEventListener('resize', resize);

  return {
    setAgent(i, { status = 'idle', selected = false } = {}) {
      const a = agents[i];
      if (!a) return;
      a.userData.selected = selected;
      a.userData.status = status;
      const color = STATUS_COLOR[status] ?? STATUS_COLOR.idle;
      const off = status === 'off';
      // Disc = status color (default slightly soft; selected = richer)
      // Light bloom = status + white mix
      const base = new THREE.Color(off ? STATUS_COLOR.idle : color);
      const disc = base.clone();
      if (selected && !off) disc.offsetHSL(0, 0.2, -0.06);
      else if (!off) disc.lerp(new THREE.Color(0xffffff), 0.14);
      if (a.userData.glow) {
        a.userData.glow.material.color.copy(disc);
        a.userData.glow.material.opacity = off ? 0.72 : selected ? 1 : 0.82;
        a.userData.glow.visible = true;
        placeAgentGlow(a);
      }
      if (a.userData.light) {
        const lightCol = base.clone();
        if (selected && !off) lightCol.lerp(new THREE.Color(0xffffff), 0.35);
        else lightCol.lerp(new THREE.Color(0xffffff), 0.12);
        a.userData.light.color.copy(lightCol);
        a.userData.light.intensity = off
          ? 0.55
          : selected
            ? 4.0
            : status === 'thinking'
              ? 2.0
              : 1.35;
        a.userData.light.distance = selected && !off ? 2.35 : 2.0;
      }
      // selection reads via glow/halo/light only — scaling made the last
      // clicked key look stuck in a pressed/enlarged state
      a.scale.setScalar(1);
      syncChassisGlow();
    },
    setKeyIcon(cmd, iconId) {
      const m = cmds[cmd];
      if (!m?.userData.iconMesh) return;
      const tex = makeIconTexture(iconId);
      m.userData.iconMesh.material.map?.dispose();
      m.userData.iconMesh.material.map = tex;
      m.userData.iconMesh.material.needsUpdate = true;
      const s = iconPlaneSize(iconId, !!m.userData.iconWide);
      m.userData.iconMesh.geometry?.dispose?.();
      m.userData.iconMesh.geometry = new THREE.PlaneGeometry(s, s);
    },
    setCmdActive(cmd, on) {
      const m = cmds[cmd];
      if (!m) return;
      m.material.emissive = new THREE.Color(on ? 0x224466 : 0x000000);
      m.material.emissiveIntensity = on ? 0.15 : 0;
    },
    /** Gray out / ignore a command key (e.g. fork when 6/6). */
    setCmdEnabled(cmd, enabled) {
      const m = cmds[cmd];
      if (!m) return;
      const on = !!enabled;
      m.userData.disabled = !on;
      if (m.userData._baseColor == null) {
        m.userData._baseColor = m.material.color.getHex();
      }
      m.material.color.setHex(on ? m.userData._baseColor : 0xb0aea8);
      m.material.opacity = on ? 1 : 0.45;
      m.material.transparent = !on;
      m.material.needsUpdate = true;
      if (m.userData.iconMesh?.material) {
        m.userData.iconMesh.material.opacity = on ? 1 : 0.28;
        m.userData.iconMesh.material.transparent = true;
        m.userData.iconMesh.material.needsUpdate = true;
      }
    },
    setRecording(on) {
      chassisRecording = !!on;
      syncChassisGlow();
    },
    setLayer(layer) {
      setTouchLayer(((layer % 3) + 3) % 3);
    },
    /**
     * Hotkey feedback: press motion + 청축 sound (same as pointer).
     * @param {string} target - cmd id ('fast'|'approve'|…) or 'touch'
     * @param {{ holdMs?: number, sticky?: boolean, phase?: 'down'|'up'|'pulse' }} [opts]
     */
    simulatePress(target, opts = {}) {
      const phase = opts.phase || 'pulse';
      const holdMs = opts.holdMs ?? 100;
      let obj = null;
      if (target === 'touch') obj = touchGroup;
      else if (typeof target === 'string' && target.startsWith('agent:')) {
        const i = Number(target.slice(6));
        obj = agents[i] || null;
      } else obj = cmds[target] || null;
      if (!obj || obj.userData?.disabled) return false;

      const kind = soundKindFor(obj);
      const id = soundIdFor(obj);

      if (phase === 'down' || phase === 'pulse') {
        pressVisual(obj, true);
        playKeyDown(kind, id);
      }
      if (phase === 'up') {
        pressVisual(obj, false);
        if (!opts.silent) playKeyUp(kind, id);
        return true;
      }
      if (phase === 'pulse' && !opts.sticky) {
        setTimeout(() => {
          pressVisual(obj, false);
          playKeyUp(kind, id);
        }, holdMs);
      }
      return true;
    },
    /** Silent unpress (e.g. mic recording ended) */
    releasePress(target) {
      return this.simulatePress(target, { phase: 'up', silent: true });
    },
    /** ⌘+arrow: tilt stick + sound, then spring back */
    nudgeJoy(dir = 'up', holdMs = 120) {
      const throwAmt = 0.16;
      const map = {
        up: { x: 0, z: -throwAmt },
        down: { x: 0, z: throwAmt },
        left: { x: -throwAmt, z: 0 },
        right: { x: throwAmt, z: 0 },
      };
      const t = map[dir] || map.up;
      joyTx = t.x;
      joyTz = t.z;
      playJoyTick(dir);
      setTimeout(() => {
        joyTx = 0;
        joyTz = 0;
      }, holdMs);
      return true;
    },
    resetJoy,
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('blur', onFocusLost);
      renderer.dispose();
      container.innerHTML = '';
    },
    dom: renderer.domElement,
  };
}

void LAYOUT;
