import * as THREE from './vendor/three.mjs';
import { RoundedBoxGeometry } from './vendor/geometries/RoundedBoxGeometry.mjs';
import { RoomEnvironment } from './vendor/RoomEnvironment.mjs';
import { iconSvgDocument } from './icons.mjs';
import { playKeyDown, playKeyUp, playDialTick, playJoyTick } from './key-sounds.mjs';

const STATUS_COLOR = {
  idle: 0x7eb0e8,
  thinking: 0x2b9dff,
  complete: 0x2edf72,
  input: 0xffc53d,
  error: 0xff4545,
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
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;

  const svg = iconSvgDocument(iconId, { size, color: '#141414' });
  if (!svg) return tex;
  const img = new Image();
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  img.onload = () => {
    ctx.clearRect(0, 0, size, size);
    const pad = size * 0.18;
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
    g.addColorStop(0.55, '#e8f2fc');
    g.addColorStop(0.85, '#c5daf0');
    g.addColorStop(1, '#a8c6e4');
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
      color: 0xc4daf2,
      roughness: 0.16,
      metalness: 0.02,
      transparent: true,
      opacity: 0.24,
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
          color: 0x6f9bc0,
          roughness: 0.38,
          transparent: true,
          opacity: 0.26,
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
          opacity: 0.12,
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
        opacity: 0.16,
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

    const light = new THREE.PointLight(0x4aa3ff, 0, 1.85);
    light.position.y = 0.05;
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
  dialGroup.position.set(originX - 0.02, 0.28, originZ);
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
    joyStick.position.z = z * 0.55;
    joyStick.rotation.z = -nx * 0.62;
    joyStick.rotation.x = nz * 0.62;
  }

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
    }
  });

  renderer.domElement.addEventListener('pointerup', (e) => {
    if (dialDragging) {
      playKeyUp('dial', 'dial');
      dialDragging = false;
      pressed = null;
      return;
    }
    if (joyDragging) {
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
    const obj = pick(e) || downObj;
    const t = obj.userData?.type || downObj.userData?.type;
    if (t === 'agent') handlers.onAgent?.(obj.userData.index ?? downObj.userData.index);
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
    // Keep selection glow size; no breathing animation
    agents.forEach((a) => {
      if (a.userData.glow) {
        a.userData.glow.scale.setScalar(a.userData.selected ? 1.22 : 1);
      }
    });
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
      const color = STATUS_COLOR[status] ?? STATUS_COLOR.idle;
      const off = status === 'off';
      const lit = new THREE.Color(color);
      if (selected && !off) lit.lerp(new THREE.Color(0xffffff), 0.48);
      if (a.userData.glow) {
        a.userData.glow.material.color.copy(lit);
        a.userData.glow.material.opacity = off ? 0 : selected ? 1 : 0.72;
        a.userData.glow.visible = !off;
        a.userData.glow.scale.setScalar(selected && !off ? 1.22 : 1);
      }
      if (a.userData.light) {
        a.userData.light.color.copy(lit);
        a.userData.light.intensity = off
          ? 0
          : selected
            ? 5.4
            : status === 'thinking'
              ? 1.45
              : 0.7;
        a.userData.light.distance = selected && !off ? 2.35 : 1.85;
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
      chassis.material.emissive = new THREE.Color(on ? 0x1ecf9a : 0x000000);
      chassis.material.emissiveIntensity = on ? 0.12 : 0;
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
