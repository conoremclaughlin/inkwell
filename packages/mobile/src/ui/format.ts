/**
 * Display formatting, kept pure so it can be tested without a React Native
 * runtime. Times arrive from the server as UTC ISO strings; everything here
 * renders in the DEVICE's local timezone, which is the user's timezone by
 * definition on a phone.
 */

/** "now", "4m", "2h", "3d", then a short date — the glanceable list form. */
export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diffMs = nowMs - then;
  if (diffMs < 60_000) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "6:13 PM" for today, "Fri 6:13 PM" this week, else "Jan 30, 6:13 PM". */
export function messageTime(iso: string, nowMs: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const date = new Date(then);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const ageMs = nowMs - then;
  const sameDay = new Date(nowMs).toDateString() === date.toDateString();
  if (sameDay) return time;
  if (ageMs < 7 * 24 * 3600_000) {
    return `${date.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  }
  return `${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${time}`;
}

/**
 * Display name for a message sender, and whether it is the viewer's own.
 * The server names every author (spec inkmail-thread-scope §3) and says
 * which person is the viewer — `isOwn` is compared there against the Inkwell
 * user, which is not the id this app holds from its auth provider. Only an
 * own message reads "You" and sits on the right; another person's message
 * carries their name and sits with the agents'.
 */
export function senderName(message: {
  senderKind?: 'sb' | 'user' | 'system' | string | null;
  senderSlug?: string | null;
  senderName?: string | null;
  isOwn?: boolean | null;
}): { name: string; isOwn: boolean } {
  if (message.isOwn) return { name: 'You', isOwn: true };
  if (message.senderName) return { name: message.senderName, isOwn: false };
  // Older payloads name nobody: fall back to what the kind says.
  if (message.senderKind === 'user') return { name: 'a workspace member', isOwn: false };
  if (message.senderKind === 'system') return { name: 'system', isOwn: false };
  return { name: message.senderSlug ?? 'system', isOwn: false };
}

/** "runtime:idle" → "idle"; "active:implementing" → "implementing". */
export function shortPhase(phase: string | null | undefined): string | null {
  if (!phase) return null;
  const idx = phase.indexOf(':');
  return idx >= 0 ? phase.slice(idx + 1) : phase;
}

/**
 * One line for a tool call: the tool's name plus the argument a reader would
 * want — the file, the command, the query. Falls back to the first string
 * argument, and to the bare name when the input has nothing readable.
 */
export function toolCallLabel(name: string, input: unknown, max = 80): string {
  if (!input || typeof input !== 'object') return name;
  const args = input as Record<string, unknown>;
  const preferred = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'description'];
  let detail: string | undefined;
  for (const key of preferred) {
    if (typeof args[key] === 'string' && (args[key] as string).trim()) {
      detail = args[key] as string;
      break;
    }
  }
  if (detail === undefined) {
    detail = Object.values(args).find((v): v is string => typeof v === 'string' && v.trim() !== '');
  }
  if (detail === undefined) return name;
  const compact = detail.replace(/\s+/g, ' ').trim();
  const clipped = compact.length > max ? `${compact.slice(0, max - 1)}…` : compact;
  return `${name} ${clipped}`;
}

/** "3m 20s" between two instants; "—" when the end is unknown. */
export function durationLabel(startIso: string | null, endIso: string | null): string {
  if (!startIso || !endIso) return '—';
  const ms = Date.parse(endIso) - Date.parse(startIso);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}
