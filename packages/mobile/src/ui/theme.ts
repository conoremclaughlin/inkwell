/**
 * Inkwell's mobile design tokens.
 *
 * Kept as a plain object rather than shared with web: the dashboard consumes
 * shadcn CSS variables through Tailwind, and the two platforms style
 * differently even where the palette rhymes. The family is the same deep
 * navy-ink ground the dashboard's dark mode uses, with one indigo accent.
 */
export const colors = {
  // Grounds, darkest to lightest.
  ink: '#0b0e14',
  well: '#10141d',
  surface: '#161b27',
  surfaceRaised: '#1c2231',
  surfaceOverlay: '#232a3d',

  borderSubtle: '#1f2637',
  borderDefault: '#2b3450',

  textPrimary: '#e8eaf0',
  textSecondary: '#9aa3b8',
  textMuted: '#5f6880',

  accent: '#6c7ff2',
  accentBright: '#8b9bff',
  accentDim: '#2a3260',

  positive: '#4ade80',
  warning: '#fbbf24',
  negative: '#f87171',

  // Agent identity hues, stable per slug so a thread reads at a glance.
  agentHues: ['#8b9bff', '#4ade80', '#fbbf24', '#f472b6', '#38bdf8', '#fb923c', '#a78bfa'],
} as const;

/** Stable color for an agent slug — same slug, same hue, every screen. */
export function agentColor(agentId: string | null | undefined): string {
  if (!agentId) return colors.textMuted;
  let hash = 0;
  for (let i = 0; i < agentId.length; i += 1) {
    hash = (hash * 31 + agentId.charCodeAt(i)) >>> 0;
  }
  return colors.agentHues[hash % colors.agentHues.length];
}

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const type = {
  title: { fontSize: 17, fontWeight: '600' as const },
  body: { fontSize: 15, fontWeight: '400' as const },
  caption: { fontSize: 12, fontWeight: '400' as const },
  label: { fontSize: 11, fontWeight: '600' as const },
  mono: { fontSize: 13, fontFamily: 'Menlo' },
} as const;
