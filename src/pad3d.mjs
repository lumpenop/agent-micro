import * as THREE from './vendor/three.mjs';
import { RoundedBoxGeometry } from './vendor/geometries/RoundedBoxGeometry.mjs';
import { RoomEnvironment } from './vendor/RoomEnvironment.mjs';
import { KEYCAP_ICONS, iconSvgBody } from './icons.mjs';

const STATUS_COLOR = {
  idle: 0x9fb0c8,
  thinking: 0x4aa3ff,
  complete: 0x3ecf7a,
  input: 0xf0c24b,
  error: 0xef4d4d,
  off: 0x000000,
};

const LAYOUT = [
  ['dial', 'agent:0', 'agent:1', 'joy'],
  ['agent:2', 'agent:3', 'agent:4', 'agent:5'],
  ['cmd:fast', 'cmd:approve', 'cmd:decline', 'cmd:fork'],
  ['touch', 'cmd:mic', null, 'cmd:send'], // mic spans 2 via special case
];

function makeIconTexture(iconId) {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, size, size);

  // soft dish shading
  const g = ctx.createRadialGradient(size * 0.5, size * 0.38, size * 0.05, size * 0.5, size * 0.5, size * 0.55);
  g.addColorStop(0, 'rgba(255,255,255,0.0)');
  g.addColorStop(1, 'rgba(0,0,0,0.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const body = iconSvgBody(iconId, `tex-${iconId}`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" color="#141414">${body}</svg>`;
  const img = new Image();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;

  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  img.onload = () => {
    ctx.clearRect(0, 0, size, size);
    const pad = size * 0.2;
    ctx.drawImage(img, pad, pad, size - pad * 2, size - pad * 2);
    tex.needsUpdate = true;
  };
  img.src = url;
  return tex;
}

let _capTopTex = null;
let _capTopFrostTex = null;
function capTopTexture(frost = false) {
  // offset radial gradient → domed, shaded key top
  const cached = frost ? _capTopFrostTex : _capTopTex;
  if (cached) return cached;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(104, 92, 16, 128, 128, 165);
  if (frost) {
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.6, '#f2f6fa');
    g.addColorStop(0.88, '#dde5ec');
    g.addColorStop(1, '#c9d3dc');
  } else {
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.55, '#f6f3ec');
    g.addColorStop(0.85, '#e2ded3');
    g.addColorStop(1, '#ccc7ba');
  }
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 256, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  if (frost) _capTopFrostTex = tex;
  else _capTopTex = tex;
  return tex;
}

let _glowTex = null;
function glowTexture() {
  // larger bright core, short falloff → readable disc through clear frost
  if (_glowTex) return _glowTex;
  const size = 128;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 2, size / 2, size / 2, size * 0.48);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.45, 'rgba(255,255,255,0.95)');
  g.addColorStop(0.72, 'rgba(255,255,255,0.45)');
  g.addColorStop(0.9, 'rgba(255,255,255,0.08)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  _glowTex = new THREE.CanvasTexture(c);
  _glowTex.colorSpace = THREE.SRGBColorSpace;
  return _glowTex;
}

function keycapMesh({ wide = false, frost = false, iconId = null } = {}) {
  const w = wide ? 1.95 : 0.92;
  const h = 0.52;
  const d = 0.92;
  const geo = new RoundedBoxGeometry(w, h, d, 5, 0.16);
  let mat;

  if (frost) {
    mat = new THREE.MeshPhysicalMaterial({
      color: 0xd8e4f0,
      roughness: 0.16,
      metalness: 0.02,
      transparent: true,
      opacity: 0.38,
      clearcoat: 0.65,
      clearcoatRoughness: 0.2,
      transmission: 0,
      depthWrite: true,
    });
  } else {
    mat = new THREE.MeshStandardMaterial({
      color: 0xfffef8,
      roughness: 0.42,
      metalness: 0.04,
    });
  }

  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  mesh.receiveShadow = true;

  // darker skirt so keys read against the plate
  const skirt = new THREE.Mesh(
    new RoundedBoxGeometry(w * 0.98, h * 0.55, d * 0.98, 4, 0.12),
    frost
      ? new THREE.MeshPhysicalMaterial({
          color: 0x8ca4ba,
          roughness: 0.38,
          transparent: true,
          opacity: 0.38,
        })
      : new THREE.MeshStandardMaterial({
          color: 0xc2bdb1,
          roughness: 0.62,
          metalness: 0.06,
        })
  );
  skirt.position.y = -h * 0.12;
  mesh.add(skirt);

  // concave dish — must stay inside the cap top or keys read as circles
  const dish = new THREE.Mesh(
    new THREE.SphereGeometry(0.38, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.42),
    frost
      ? new THREE.MeshPhysicalMaterial({
          color: 0xffffff,
          roughness: 0.12,
          transparent: true,
          opacity: 0.22,
          side: THREE.BackSide,
        })
      : new THREE.MeshStandardMaterial({
          color: 0xf0ebe3,
          roughness: 0.5,
          side: THREE.BackSide,
        })
  );
  dish.rotation.x = Math.PI;
  dish.position.y = h * 0.42;
  dish.scale.set(wide ? 2.0 : 1, 0.22, 1);
  mesh.add(dish);

  const topGeo = new RoundedBoxGeometry(w * 0.86, 0.04, d * 0.86, 3, 0.1);
  const topMat = frost
    ? new THREE.MeshPhysicalMaterial({
        map: capTopTexture(true),
        roughness: 0.14,
        transparent: true,
        opacity: 0.32,
        clearcoat: 0.5,
      })
    : new THREE.MeshStandardMaterial({
        map: capTopTexture(false),
        roughness: 0.32,
      });
  const top = new THREE.Mesh(topGeo, topMat);
  top.position.y = h * 0.48;
  mesh.add(top);

  // soft contact shadow under each key (kept inside the footprint)
  const contact = new THREE.Mesh(
    new THREE.CircleGeometry(0.44, 28),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    })
  );
  if (wide) contact.scale.x = 2.05;
  contact.rotation.x = -Math.PI / 2;
  contact.position.y = -h * 0.52;
  mesh.add(contact);

  if (!frost && iconId) {
    const tex = makeIconTexture(iconId);
    const iconMat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      depthWrite: false,
    });
    const iconMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(wide ? 0.55 : 0.42, 0.42),
      iconMat
    );
    iconMesh.rotation.x = -Math.PI / 2;
    iconMesh.position.y = h * 0.52;
    mesh.add(iconMesh);
    mesh.userData.iconMesh = iconMesh;
  }

  if (frost) {
    // status LED — larger, sharper disc through clearer frost
    const glow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.58, 0.58),
      new THREE.MeshBasicMaterial({
        map: glowTexture(),
        color: 0xf2f2f0,
        transparent: true,
        opacity: 0.7,
        toneMapped: false,
        depthTest: false,
        depthWrite: false,
      })
    );
    glow.rotation.x = -Math.PI / 2;
    glow.position.y = h * 0.3;
    glow.renderOrder = 5;
    mesh.add(glow);
    mesh.userData.glow = glow;

    const light = new THREE.PointLight(0x4aa3ff, 0, 1.4);
    light.position.y = 0.0;
    mesh.add(light);
    mesh.userData.light = light;
  }

  mesh.userData.restY = 0;
  mesh.userData.pressY = -0.1;
  return mesh;
}

export function createPad3D(container, handlers = {}) {
  const scene = new THREE.Scene();
  scene.background = null;

  const w = Math.max(container.clientWidth || 0, 360);
  const h = Math.max(container.clientHeight || 0, 360);

  // Near top-down with a touch more tilt so side skirts + shadows read
  const camera = new THREE.PerspectiveCamera(28, w / h, 0.1, 100);
  camera.position.set(0, 11.8, 2.35);
  camera.lookAt(0, 0, 0);

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  });
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

  // lights — stronger key + rim so caps cast readable shade on the plate
  const amb = new THREE.AmbientLight(0xffffff, 0.32);
  scene.add(amb);
  const key = new THREE.DirectionalLight(0xfff4e8, 1.45);
  key.position.set(4.2, 9.5, 3.2);
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
  key.shadow.radius = 2.5;
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xc8d6ea, 0.35);
  fill.position.set(-5, 4, -3);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xffffff, 0.28);
  rim.position.set(-1, 6, 6);
  scene.add(rim);
  const hemi = new THREE.HemisphereLight(0xf5f7fa, 0x6a7380, 0.4);
  scene.add(hemi);

  // chassis — cooler mid-tone shell (keys stay brighter on top)
  const chassis = new THREE.Mesh(
    new RoundedBoxGeometry(5.05, 0.55, 5.05, 6, 0.45),
    new THREE.MeshPhysicalMaterial({
      color: 0xb8c4d0,
      roughness: 0.38,
      metalness: 0.12,
      transparent: true,
      opacity: 0.94,
      clearcoat: 0.55,
      clearcoatRoughness: 0.28,
    })
  );
  chassis.position.y = -0.15;
  chassis.receiveShadow = true;
  chassis.castShadow = true;
  scene.add(chassis);

  // inset plate — darker well so cream/frost caps pop
  const plate = new THREE.Mesh(
    new RoundedBoxGeometry(4.45, 0.14, 4.45, 5, 0.28),
    new THREE.MeshStandardMaterial({
      color: 0x5a6570,
      roughness: 0.72,
      metalness: 0.18,
    })
  );
  plate.position.y = 0.1;
  plate.receiveShadow = true;
  scene.add(plate);

  // soft vignette rim inside the well
  const wellRim = new THREE.Mesh(
    new RoundedBoxGeometry(4.52, 0.06, 4.52, 5, 0.3),
    new THREE.MeshStandardMaterial({
      color: 0x3e4750,
      roughness: 0.8,
      metalness: 0.1,
    })
  );
  wellRim.position.y = 0.04;
  wellRim.receiveShadow = true;
  scene.add(wellRim);

  // screws
  for (const [x, z] of [
    [-2.15, -2.15],
    [2.15, -2.15],
    [-2.15, 2.15],
    [2.15, 2.15],
  ]) {
    const screw = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 0.06, 16),
      new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.8, roughness: 0.35 })
    );
    screw.position.set(x, 0.2, z);
    scene.add(screw);
  }

  const interactives = [];
  const agents = [];
  const cmds = {};
  const gap = 1.05;
  const originX = -1.575;
  const originZ = -1.575;

  // dial — dark socket + white knurled knob so the circle reads instantly
  const dialGroup = new THREE.Group();
  const dialBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.5, 0.52, 0.12, 48),
    new THREE.MeshStandardMaterial({ color: 0x2e353c, roughness: 0.6, metalness: 0.3 })
  );
  // shadow well under the knob emphasizes the round silhouette
  const dialWell = new THREE.Mesh(
    new THREE.CircleGeometry(0.5, 48),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
    })
  );
  dialWell.rotation.x = -Math.PI / 2;
  dialWell.position.y = 0.07;
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
    new THREE.CylinderGeometry(0.42, 0.44, 0.34, 64),
    [dialSideMat, dialTopMat, dialSideMat]
  );
  dialKnob.position.y = 0.22;
  dialKnob.castShadow = true;

  const mark = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, 0.05, 0.22),
    new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.4 })
  );
  mark.position.set(0, 0.18, -0.21);
  dialKnob.add(mark);

  // thin groove near the rim — subtle circular cue, stays smooth
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.37, 0.012, 8, 64),
    new THREE.MeshStandardMaterial({ color: 0xc4c0b6, roughness: 0.5 })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = 0.175;
  dialKnob.add(ring);

  dialGroup.add(dialBase, dialKnob);
  dialGroup.position.set(originX, 0.28, originZ);
  dialGroup.userData = { type: 'dial', knob: dialKnob };
  dialBase.userData = { type: 'dial' };
  dialKnob.userData = { type: 'dial' };
  scene.add(dialGroup);
  interactives.push(dialBase, dialKnob);

  // joystick — gate ring + rubber boot + shaft + concave cap
  const joyGroup = new THREE.Group();
  // contact shadow under the base so the round socket reads on the plate
  const joyWell = new THREE.Mesh(
    new THREE.CircleGeometry(0.54, 48),
    new THREE.MeshBasicMaterial({
      color: 0x000000,
      transparent: true,
      opacity: 0.48,
      depthWrite: false,
    })
  );
  joyWell.rotation.x = -Math.PI / 2;
  joyWell.position.y = 0.02;
  joyGroup.add(joyWell);

  const joyBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.46, 0.48, 0.12, 48),
    new THREE.MeshStandardMaterial({ color: 0x1a1f24, roughness: 0.7, metalness: 0.2 })
  );
  const joyGate = new THREE.Mesh(
    new THREE.TorusGeometry(0.4, 0.03, 10, 48),
    new THREE.MeshStandardMaterial({ color: 0x4a525a, roughness: 0.45, metalness: 0.3 })
  );
  joyGate.rotation.x = Math.PI / 2;
  joyGate.position.y = 0.07;

  const joyStick = new THREE.Group();
  const joyBoot = new THREE.Mesh(
    new THREE.SphereGeometry(0.2, 28, 20),
    new THREE.MeshStandardMaterial({ color: 0x14181c, roughness: 0.85 })
  );
  joyBoot.scale.set(1, 0.55, 1);
  joyBoot.position.y = 0.08;
  const joyShaft = new THREE.Mesh(
    new THREE.CylinderGeometry(0.075, 0.095, 0.3, 24),
    new THREE.MeshStandardMaterial({ color: 0x2c3238, roughness: 0.4, metalness: 0.35 })
  );
  joyShaft.position.y = 0.24;
  joyShaft.castShadow = true;
  const joyCap = new THREE.Mesh(
    new THREE.SphereGeometry(0.19, 32, 24),
    new THREE.MeshStandardMaterial({ color: 0x394048, roughness: 0.55, metalness: 0.1 })
  );
  joyCap.scale.set(1, 0.72, 1);
  joyCap.position.y = 0.42;
  joyCap.castShadow = true;
  // concave thumb dimple
  const joyDimple = new THREE.Mesh(
    new THREE.SphereGeometry(0.13, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.45),
    new THREE.MeshStandardMaterial({ color: 0x272d33, roughness: 0.65, side: THREE.BackSide })
  );
  joyDimple.rotation.x = Math.PI;
  joyDimple.scale.set(1, 0.4, 1);
  joyDimple.position.y = 0.52;
  joyStick.add(joyBoot, joyShaft, joyCap, joyDimple);
  joyGroup.add(joyBase, joyGate, joyStick);
  joyGroup.position.set(originX + gap * 3, 0.28, originZ);
  joyGroup.userData = { type: 'joy', stick: joyStick };
  joyBase.userData = { type: 'joy' };
  joyStick.userData = { type: 'joy' };
  scene.add(joyGroup);
  interactives.push(joyBase, joyStick);

  // touch pad (bottom-left) + 3 layer LEDs beside it (like the real Micro)
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

  touchGroup.position.set(originX + 0.08, 0.28, originZ + gap * 3);
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
    const m = keycapMesh({ wide, frost: false, iconId: name === 'send' ? 'codex' : name === 'mic' ? 'mic' : name === 'fast' ? 'lightning' : name === 'approve' ? 'check' : name === 'decline' ? 'times' : 'fork' });
    const x = wide ? originX + gap * 1.5 : originX + gap * col;
    m.position.set(x, 0.42, originZ + gap * row);
    m.userData = { ...m.userData, type: 'cmd', cmd: name, baseY: 0.42 };
    scene.add(m);
    cmds[name] = m;
    interactives.push(m);
  });

  // edge labels via sprites
  function makeLabel(text, x, z, rotY) {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 64;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'rgba(40,45,55,0.45)';
    ctx.font = '28px "SF Pro Text", Avenir, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 256, 32);
    const tex = new THREE.CanvasTexture(c);
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
    const spr = new THREE.Sprite(mat);
    spr.scale.set(2.2, 0.28, 1);
    spr.position.set(x, 0.35, z);
    // sprites face camera; for edge feel place them
    scene.add(spr);
    return spr;
  }
  makeLabel("Let's build", 0, 2.35, 0);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let pressed = null;
  let dialDragging = false;
  let dialLastAngle = 0;
  let joyDragging = false;
  let raf = 0;

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
    let obj = hits[0].object;
    while (obj && !obj.userData?.type) obj = obj.parent;
    return obj;
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

  renderer.domElement.addEventListener('pointerdown', (e) => {
    const obj = pick(e);
    if (!obj) return;
    pressed = obj;
    renderer.domElement.setPointerCapture(e.pointerId);

    if (obj.userData.type === 'dial') {
      dialDragging = true;
      dialLastAngle = pointerAngle(e);
      handlers.onDialStart?.();
      e.preventDefault();
      return;
    }
    if (obj.userData.type === 'joy') {
      joyDragging = true;
      return;
    }
    pressVisual(obj, true);
  });

  renderer.domElement.addEventListener('pointermove', (e) => {
    if (dialDragging) {
      const a = pointerAngle(e);
      // cw > 0 = clockwise on screen; rotation.y decreases for clockwise (top-down Y-up)
      const cw = shortestDelta(dialLastAngle, a);
      dialLastAngle = a;
      dialKnob.rotation.y -= (cw * Math.PI) / 180;
      handlers.onDialDelta?.(cw);
      return;
    }
    if (joyDragging) {
      const rect = renderer.domElement.getBoundingClientRect();
      // joy is top-right in top-down view
      _dialScreen.set(0, 0.35, 0);
      joyGroup.localToWorld(_dialScreen);
      _dialScreen.project(camera);
      const cx = rect.left + ((_dialScreen.x + 1) / 2) * rect.width;
      const cy = rect.top + ((-_dialScreen.y + 1) / 2) * rect.height;
      let dx = (e.clientX - cx) / 50;
      let dy = (e.clientY - cy) / 50;
      const len = Math.hypot(dx, dy) || 1;
      const max = 0.18;
      if (len > max) {
        dx = (dx / len) * max;
        dy = (dy / len) * max;
      }
      joyStick.position.x = dx;
      joyStick.position.z = dy;
      joyStick.rotation.z = -dx * 1.4;
      joyStick.rotation.x = dy * 1.4;
      const dist = Math.hypot(dx, dy);
      if (dist > 0.12) {
        const dir =
          Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
        handlers.onJoy?.(dir);
      }
    }
  });

  renderer.domElement.addEventListener('pointerup', (e) => {
    if (dialDragging) {
      dialDragging = false;
      pressed = null;
      return;
    }
    if (joyDragging) {
      joyDragging = false;
      joyStick.position.x = 0;
      joyStick.position.z = 0;
      joyStick.rotation.x = 0;
      joyStick.rotation.z = 0;
      pressed = null;
      return;
    }
    if (!pressed) return;
    const downObj = pressed;
    pressVisual(downObj, false);
    const obj = pick(e) || downObj;
    const t = obj.userData?.type || downObj.userData?.type;
    if (t === 'agent') handlers.onAgent?.(obj.userData.index ?? downObj.userData.index);
    if (t === 'cmd') handlers.onCmd?.(obj.userData.cmd ?? downObj.userData.cmd);
    if (t === 'touch') handlers.onTouch?.();
    pressed = null;
  });

  renderer.domElement.addEventListener('pointercancel', () => {
    if (pressed) pressVisual(pressed, false);
    pressed = null;
    dialDragging = false;
    joyDragging = false;
    joyStick.position.x = 0;
    joyStick.position.z = 0;
    joyStick.rotation.x = 0;
    joyStick.rotation.z = 0;
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

  let pulseT = 0;
  function animate() {
    raf = requestAnimationFrame(animate);
    pulseT += 0.05;
    agents.forEach((a) => {
      if (!a.userData.glow) return;
      // only the selected agent breathes; all others stay fixed
      if (!a.userData.selected) {
        a.userData.glow.scale.setScalar(1);
        return;
      }
      const s = 1 + Math.sin(pulseT) * 0.12;
      a.userData.glow.scale.setScalar(s);
    });
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
      const color = STATUS_COLOR[status] ?? STATUS_COLOR.idle;
      const off = status === 'off';
      if (a.userData.glow) {
        a.userData.glow.material.color.setHex(color);
        a.userData.glow.material.opacity = off ? 0 : selected ? 0.9 : 0.65;
        a.userData.glow.visible = !off;
      }
      if (a.userData.light) {
        a.userData.light.color.setHex(color);
        a.userData.light.intensity = off ? 0 : selected ? 2.0 : status === 'thinking' ? 1.3 : 0.5;
      }
      // selection reads via glow/halo/light only — scaling made the last
      // clicked key look stuck in a pressed/enlarged state
      a.scale.setScalar(1);
    },
    setKeyIcon(cmd, iconId) {
      const m = cmds[cmd];
      if (!m?.userData.iconMesh) return;
      const tex = makeIconTexture(iconId);
      m.userData.iconMesh.material.map?.dispose();
      m.userData.iconMesh.material.map = tex;
      m.userData.iconMesh.material.needsUpdate = true;
    },
    setCmdActive(cmd, on) {
      const m = cmds[cmd];
      if (!m) return;
      m.material.emissive = new THREE.Color(on ? 0x224466 : 0x000000);
      m.material.emissiveIntensity = on ? 0.15 : 0;
    },
    setRecording(on) {
      chassis.material.emissive = new THREE.Color(on ? 0x1ecf9a : 0x000000);
      chassis.material.emissiveIntensity = on ? 0.12 : 0;
    },
    setLayer(layer) {
      setTouchLayer(((layer % 3) + 3) % 3);
    },
    dispose() {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      renderer.dispose();
      container.innerHTML = '';
    },
    dom: renderer.domElement,
  };
}

void KEYCAP_ICONS;
void LAYOUT;
