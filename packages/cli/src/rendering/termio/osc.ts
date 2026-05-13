/**
 * OSC (Operating System Command) — hyperlink support only.
 * Simplified from Claude Code fork's osc.ts (clipboard, notifications removed).
 */

import { BEL, ESC, ESC_TYPE, SEP } from './ansi.js';

export const OSC_PREFIX = ESC + String.fromCharCode(ESC_TYPE.OSC);
export const ST = ESC + '\\';

export function osc(...parts: (string | number)[]): string {
  return `${OSC_PREFIX}${parts.join(SEP)}${BEL}`;
}

export const OSC = {
  HYPERLINK: 8,
} as const;

export function link(url: string, params?: Record<string, string>): string {
  if (!url) return LINK_END;
  const p = { id: osc8Id(url), ...params };
  const paramStr = Object.entries(p)
    .map(([k, v]) => `${k}=${v}`)
    .join(':');
  return osc(OSC.HYPERLINK, paramStr, url);
}

function osc8Id(url: string): string {
  let h = 0;
  for (let i = 0; i < url.length; i++) h = ((h << 5) - h + url.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export const LINK_END = osc(OSC.HYPERLINK, '', '');
