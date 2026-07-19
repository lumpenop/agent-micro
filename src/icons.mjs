/**
 * Icon catalog for Agent Micro
 * - Generic UI: Lucide Static (ISC)
 * - Optional AI brands (off by default — users can add their own in the picker)
 * - Custom icons: user-uploaded SVG/PNG stored as data URLs
 */
import { LUCIDE_ICONS } from './lucide-icons.mjs';
import { LOBE_BRAND_ICONS } from './lobe-brand-icons.mjs';

export const KEYCAP_ICONS = {
  ...LUCIDE_ICONS,
  ...LOBE_BRAND_ICONS,
};

/** Built-in key defaults — Lucide only (no brand marks) */
export const DEFAULT_KEY_ICONS = {
  fast: 'lightning',
  approve: 'check',
  decline: 'times',
  fork: 'fork',
  mic: 'mic',
  send: 'terminal',
};

/**
 * Brand marks shown in the built-in picker.
 * Empty by default — personal marks go through custom upload.
 */
export const PICKER_BRAND_IDS = [];

/** Picker order: allowed brands, then Lucide generics */
export const ICON_ORDER = [
  ...PICKER_BRAND_IDS.filter((id) => id in LOBE_BRAND_ICONS),
  ...Object.keys(LUCIDE_ICONS),
];

/** @type {Record<string, { id: string, label: string, dataUrl: string }>} */
let customIcons = {};

export function getCustomIcons() {
  return Object.values(customIcons);
}

export function getCustomIcon(id) {
  return customIcons[id] || null;
}

export function setCustomIcons(list) {
  customIcons = {};
  for (const item of list || []) {
    if (!item?.id || !item?.dataUrl) continue;
    customIcons[item.id] = {
      id: String(item.id),
      label: String(item.label || 'Custom').slice(0, 32),
      dataUrl: String(item.dataUrl),
    };
  }
}

export function upsertCustomIcon(def) {
  if (!def?.id || !def?.dataUrl) return null;
  const entry = {
    id: String(def.id),
    label: String(def.label || 'Custom').slice(0, 32),
    dataUrl: String(def.dataUrl),
  };
  customIcons[entry.id] = entry;
  return entry;
}

export function removeCustomIcon(id) {
  if (!customIcons[id]) return false;
  delete customIcons[id];
  return true;
}

export function isCustomIcon(id) {
  return !!customIcons[id];
}

export function isPickerIcon(id) {
  return ICON_ORDER.includes(id) || !!customIcons[id];
}

/** Built-ins then customs — for rendering the picker grid */
export function pickerIconIds() {
  return [...ICON_ORDER, ...Object.keys(customIcons)];
}

export function resolveIconDef(id) {
  return KEYCAP_ICONS[id] || customIcons[id] || null;
}

export function iconSvgBody(id, maskId = 'icon-mask') {
  const def = KEYCAP_ICONS[id];
  if (!def?.svg) return '';
  return def.svg.replaceAll('__MASK__', maskId);
}

function isStrokeIcon(def) {
  return typeof def?.svg === 'string' && def.svg.includes('stroke="currentColor"');
}

/** Inline markup for picker / guide (SVG or uploaded image) */
export function iconMarkup(id) {
  const custom = customIcons[id];
  if (custom?.dataUrl) {
    const safe = custom.dataUrl.replace(/"/g, '');
    return `<img class="icon-svg icon-img" src="${safe}" width="24" height="24" alt="" draggable="false" />`;
  }
  const def = KEYCAP_ICONS[id];
  if (!def) return '';
  const maskId = `m-${id}-${Math.random().toString(36).slice(2, 8)}`;
  const body = iconSvgBody(id, maskId);
  const stroke = isStrokeIcon(def);
  const evenodd = !!def.evenodd;
  const cls = ['icon-svg', stroke ? 'icon-stroke' : 'icon-fill', evenodd ? 'icon-evenodd' : '']
    .filter(Boolean)
    .join(' ');
  const fill = stroke ? 'none' : 'currentColor';
  const rule = evenodd ? 'evenodd' : 'nonzero';
  return `<svg class="${cls}" viewBox="0 0 24 24" width="24" height="24" fill="${fill}" fill-rule="${rule}" aria-hidden="true">${body}</svg>`;
}

/** Full SVG document string for canvas / texture rasterization (built-ins only) */
export function iconSvgDocument(id, { size = 256, color = '#141414' } = {}) {
  const def = KEYCAP_ICONS[id];
  if (!def?.svg) return '';
  const body = iconSvgBody(id, `tex-${id}`);
  const stroke = isStrokeIcon(def);
  const evenodd = !!def.evenodd;
  const fill = stroke ? 'none' : color;
  const rule = evenodd ? 'evenodd' : 'nonzero';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" fill-rule="${rule}" color="${color}">${body}</svg>`;
}

/** URL / data-URL usable by Image() for keycap textures */
export function iconImageUrl(id, { size = 256, color = '#141414' } = {}) {
  const custom = customIcons[id];
  if (custom?.dataUrl) return custom.dataUrl;
  const svg = iconSvgDocument(id, { size, color });
  if (!svg) return '';
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
