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

export const DEFAULT_KEY_ICONS = {
  fast: 'lightning',
  approve: 'check',
  decline: 'times',
  fork: 'fork',
  mic: 'mic',
  send: 'codex',
};

/** AI agents first, then Lucide generics */
export const ICON_ORDER = [
  ...Object.keys(LOBE_BRAND_ICONS),
  ...Object.keys(LUCIDE_ICONS),
];

export function iconSvgBody(id, maskId = 'icon-mask') {
  const def = KEYCAP_ICONS[id];
  if (!def) return '';
  return def.svg.replaceAll('__MASK__', maskId);
}

export function iconMarkup(id) {
  const def = KEYCAP_ICONS[id];
  if (!def) return '';
  const maskId = `m-${id}-${Math.random().toString(36).slice(2, 8)}`;
  return `<svg viewBox="0 0 24 24" aria-hidden="true">${iconSvgBody(id, maskId)}</svg>`;
}
