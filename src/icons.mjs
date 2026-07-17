/**
 * Icon catalog for Agent Micro
 * - Generic UI: Lucide Static (ISC)
 * - AI brands: Simple Icons (CC0) + Lobe (MIT) only where SI has no mark
 * Curated to API-usable chat/coding agents — no IDE shells, CLIs, image tools.
 */
import { LUCIDE_ICONS } from './lucide-icons.mjs';
import { LOBE_BRAND_ICONS } from './lobe-brand-icons.mjs';

export const KEYCAP_ICONS = {
  ...LUCIDE_ICONS,
  ...LOBE_BRAND_ICONS,
};

/** Codex-dedicated defaults */
export const DEFAULT_KEY_ICONS = {
  fast: 'lightning',
  approve: 'check',
  decline: 'times',
  fork: 'fork',
  mic: 'mic',
  send: 'codex',
};

/**
 * Brand marks shown in the icon picker.
 * Codex-only for v1 — restore full `Object.keys(LOBE_BRAND_ICONS)` later.
 */
export const PICKER_BRAND_IDS = ['codex'];

/** Picker order: allowed brands, then Lucide generics */
export const ICON_ORDER = [
  ...PICKER_BRAND_IDS.filter((id) => id in LOBE_BRAND_ICONS),
  ...Object.keys(LUCIDE_ICONS),
];

export function isPickerIcon(id) {
  return ICON_ORDER.includes(id);
}

export function iconSvgBody(id, maskId = 'icon-mask') {
  const def = KEYCAP_ICONS[id];
  if (!def) return '';
  return def.svg.replaceAll('__MASK__', maskId);
}

function isStrokeIcon(def) {
  return typeof def?.svg === 'string' && def.svg.includes('stroke="currentColor"');
}

/** Inline SVG markup for picker / guide */
export function iconMarkup(id) {
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

/** Full SVG document string for canvas / texture rasterization */
export function iconSvgDocument(id, { size = 256, color = '#141414' } = {}) {
  const def = KEYCAP_ICONS[id];
  if (!def) return '';
  const body = iconSvgBody(id, `tex-${id}`);
  const stroke = isStrokeIcon(def);
  const evenodd = !!def.evenodd;
  const fill = stroke ? 'none' : color;
  const rule = evenodd ? 'evenodd' : 'nonzero';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill}" fill-rule="${rule}" color="${color}">${body}</svg>`;
}
