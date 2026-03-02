import chalk from 'chalk';
import { stdout as output } from 'process';

const WAITING_VERB_ROTATE_MS = 30_000;
const WAITING_FRAME_INTERVAL_MS = 850;
const WAITING_VERBS = [
  'Cooking',
  'Contextifying',
  'Baking',
  'Aligning chakras',
  'Summoning tokens',
  'Consulting digital spirits',
  'Polishing response atoms',
];
const WAITING_FRAMES = ['✦', '✶', '✷', '✹'];

// ─── Layout primitives ────────────────────────────────────────────

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

/** Full-width dimmed horizontal rule. */
export function separator(width?: number): string {
  const w = width || process.stdout.columns || 80;
  return chalk.dim('─'.repeat(w));
}

/** Full-width dotted dimmed line (lighter visual break). */
export function dottedSeparator(width?: number): string {
  const w = width || process.stdout.columns || 80;
  return chalk.dim('┄'.repeat(w));
}

/** Left-aligned text with right-aligned metadata. */
export function rightAlign(left: string, right: string, width?: number): string {
  const w = width || process.stdout.columns || 80;
  const leftLen = stripAnsi(left).length;
  const rightLen = stripAnsi(right).length;
  const gap = Math.max(1, w - leftLen - rightLen);
  return `${left}${' '.repeat(gap)}${right}`;
}

/** Bottom info bar: dimmed items joined by centered dot. */
export function infoBar(items: string[]): string {
  return chalk.dim(items.filter(Boolean).join('  ·  '));
}

/** Unified message renderer with role-based prefix + right-aligned time. */
export function renderMessageLine(
  role: 'user' | 'assistant' | 'inbox' | 'activity' | 'system' | 'grant',
  content: string,
  options: {
    label?: string;
    timezone?: string;
    ts?: string;
    trailingMeta?: string;
  } = {}
): string {
  const clock = options.ts ? formatClock(options.ts, options.timezone) : formatNow(options.timezone);
  const meta = options.trailingMeta ? `  ·  ${options.trailingMeta}` : '';
  const timeStr = chalk.dim(`${clock}${meta}`);

  let prefix: string;
  let colorFn: (s: string) => string;
  switch (role) {
    case 'user':
      prefix = options.label || 'you';
      colorFn = chalk.green;
      break;
    case 'assistant':
      prefix = options.label || 'assistant';
      colorFn = chalk.white;
      break;
    case 'inbox':
      prefix = options.label || 'inbox';
      colorFn = chalk.cyan;
      break;
    case 'activity':
      prefix = options.label || 'activity';
      colorFn = chalk.magenta;
      break;
    case 'grant':
      prefix = options.label || 'granted';
      colorFn = chalk.greenBright;
      break;
    default:
      prefix = options.label || 'system';
      colorFn = chalk.dim;
      break;
  }

  const labelStr = chalk.bold(colorFn(prefix));
  const text = colorFn(content);
  const left = `  ${labelStr}  ${text}`;
  return rightAlign(left, timeStr);
}

/** Collapsed old inbox placeholder line. */
export function renderCollapsedInbox(count: number): string {
  const label = ` ${count} older inbox message${count === 1 ? '' : 's'} (>5d) collapsed `;
  const w = process.stdout.columns || 80;
  const side = Math.max(2, Math.floor((w - label.length) / 2));
  return chalk.dim(`${'┄'.repeat(side)}${label}${'┄'.repeat(side)}`);
}

/** Check if a timestamp is older than 5 days. */
export function isOlderThan5Days(createdAt?: string): boolean {
  if (!createdAt) return false;
  const ms = Date.parse(createdAt);
  if (Number.isNaN(ms)) return false;
  return Date.now() - ms > 5 * 24 * 60 * 60 * 1000;
}

/** Check if a timestamp is older than 24 hours. */
export function isOlderThan24Hours(createdAt?: string): boolean {
  if (!createdAt) return false;
  const ms = Date.parse(createdAt);
  if (Number.isNaN(ms)) return false;
  return Date.now() - ms > 24 * 60 * 60 * 1000;
}

/**
 * Format a timestamp for display — clock time for today, date+time for older.
 * Always uses absolute time (not relative) so it stays meaningful in scrollback.
 *
 * Examples:
 *   "1:29 AM", "11:45 PM", "Feb 25, 8:30 PM"
 */
export function formatHumanTime(value?: string, timezone?: string): string {
  if (!value) return formatNow(timezone);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return formatNow(timezone);

  const date = new Date(ms);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  try {
    if (sameDay) {
      return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: timezone });
    }
    // Older — show short date + time
    return date.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone,
    });
  } catch {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
}

export function formatNow(timezone?: string): string {
  try {
    return new Date().toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZone: timezone,
    });
  } catch {
    return new Date().toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }
}

function formatClock(value: string, timezone?: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return formatNow(timezone);
  try {
    return new Date(ms).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
      timeZone: timezone,
    });
  } catch {
    return new Date(ms).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }
}

function pickWaitingVerb(tick: number): string {
  if (WAITING_VERBS.length === 0) return 'Working';
  return WAITING_VERBS[tick % WAITING_VERBS.length]!;
}

export class LiveStatusLane {
  private promptActive = false;
  private dockVisible = false;
  private dirtyWhilePrompt = false;
  private turnActive = false;
  private timezone?: string;
  private statusLine = 'waiting for input';
  private hintLine = 'ready';
  private infoItems: string[] = [];

  /** Number of lines the dock occupies (sep + status + sep + prompt + sep + info). */
  private readonly DOCK_LINES = 6;

  public constructor(
    private live: boolean,
    timezone?: string
  ) {
    this.timezone = timezone;
  }

  public setLiveMode(live: boolean): void {
    if (this.live === live) return;
    if (!live) {
      this.clear();
    }
    this.live = live;
  }

  public setTimezone(timezone?: string): void {
    this.timezone = timezone;
  }

  public isLive(): boolean {
    return this.live;
  }

  public isPromptActive(): boolean {
    return this.promptActive;
  }

  public setPromptActive(active: boolean): void {
    this.promptActive = active;
  }

  public setTurnActive(active: boolean): void {
    this.turnActive = active;
  }

  public isTurnActive(): boolean {
    return this.turnActive;
  }

  public shouldRefreshAfterPrompt(): boolean {
    return this.dirtyWhilePrompt;
  }

  public markPromptRefreshed(): void {
    this.dirtyWhilePrompt = false;
  }

  public clear(): void {
    if (!this.live) return;
    output.write('\r\x1b[2K');
  }

  public setInfoItems(items: string[]): void {
    this.infoItems = items;
  }

  public clearPromptDock(): void {
    if (!this.live || !this.dockVisible) return;
    // Clear current line + DOCK_LINES-1 lines above it
    output.write('\r\x1b[2K');
    for (let i = 0; i < this.DOCK_LINES - 1; i++) {
      output.write('\x1b[1A\r\x1b[2K');
    }
    output.write('\r');
    this.dockVisible = false;
  }

  public printLine(line = ''): void {
    if (this.live) {
      if (this.promptActive) {
        this.clearPromptDock();
      } else {
        this.clear();
      }
    }
    console.log(line);
  }

  public renderSummary(summary: string, force = false): void {
    this.statusLine = summary;
    if (!this.live) {
      console.log(chalk.dim(`status> ${summary} • ${formatNow(this.timezone)}`));
      return;
    }
    if (this.promptActive && !force) {
      this.dirtyWhilePrompt = true;
      return;
    }
    this.dirtyWhilePrompt = false;
  }

  public renderHint(message: string): void {
    this.hintLine = message;
    if (!this.live) {
      console.log(chalk.dim(`hint> ${message}`));
      return;
    }
    if (this.promptActive) {
      this.dirtyWhilePrompt = true;
      return;
    }
  }

  public setHint(message: string): void {
    this.hintLine = message;
  }

  /**
   * Clear the dock lines from terminal scrollback AFTER readline has
   * submitted (Enter or Ctrl+C). At that point the cursor sits one line
   * below the dock (readline added a newline), so we clear current line
   * plus DOCK_LINES lines above it.
   */
  public clearDockFromScrollback(): void {
    if (!this.live || !this.dockVisible) return;
    // Cursor is on empty line below the dock (post-Enter/^C newline).
    // Clear that line + DOCK_LINES lines above it.
    output.write('\r\x1b[2K');
    for (let i = 0; i < this.DOCK_LINES; i++) {
      output.write('\x1b[1A\r\x1b[2K');
    }
    output.write('\r');
    this.dockVisible = false;
  }

  public buildPromptLabel(promptLabel: string): string {
    if (!this.live) return promptLabel;
    this.dockVisible = true;
    const w = process.stdout.columns || 80;
    const sep = chalk.dim('─'.repeat(w));
    const statusWithTime = rightAlign(
      chalk.dim(` ${this.statusLine}`),
      chalk.dim(formatNow(this.timezone))
    );
    const info = this.infoItems.length > 0
      ? ` ${infoBar(this.infoItems)}`
      : chalk.dim(` ${this.hintLine}`);
    // Prompt MUST be the last line so readline places the cursor there.
    // Layout: sep | status | sep | info | sep | prompt
    return [
      sep,
      statusWithTime,
      sep,
      info,
      sep,
      ` ${promptLabel}`,
    ].join('\n');
  }
}

export function renderTimedBlock(
  content: string,
  timezone?: string,
  ts?: string,
  trailingMeta?: string
): string {
  const clock = ts ? formatClock(ts, timezone) : formatNow(timezone);
  const meta = trailingMeta ? ` • ${trailingMeta}` : '';
  return `${content} ${chalk.dim(`• ${clock}${meta}`)}`;
}

function formatClockTime(value: string, timezone?: string): string {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  try {
    return new Date(ms).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: timezone,
    });
  } catch {
    return new Date(ms).toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  }
}

export function renderResumeHistoryLines(
  entries: Array<{ role: 'user' | 'assistant' | 'inbox'; content: string; ts?: string }>,
  timezone?: string,
  labels?: { user?: string; assistant?: string; inbox?: string }
): string[] {
  const userLabel = labels?.user || 'user';
  const assistantLabel = labels?.assistant || 'assistant';
  const inboxLabel = labels?.inbox || 'inbox';
  return entries.map((entry) => {
    const ts = entry.ts ? `${formatClockTime(entry.ts, timezone)} ` : '';
    if (entry.role === 'assistant') {
      return `${chalk.dim('  ⤷')} ${chalk.yellow(`${ts}${assistantLabel}:`)} ${entry.content}`;
    }
    if (entry.role === 'inbox') {
      return `${chalk.dim('  ⤷')} ${chalk.cyan(`${ts}${inboxLabel}:`)} ${entry.content}`;
    }
    return `${chalk.dim('  ⤷')} ${chalk.green(`${ts}${userLabel}:`)} ${entry.content}`;
  });
}

export function startWaitingIndicator(
  backend: string,
  options: {
    statusLane: LiveStatusLane;
    logger?: (line: string) => void;
    renderAbovePrompt?: boolean;
  }
): (doneMessage?: string) => void {
  const startedAt = Date.now();
  const useAnimatedLine = Boolean(options.statusLane.isLive() && process.stdout.isTTY);
  const logger = options.logger || ((line: string) => console.log(line));
  const renderAbovePrompt = Boolean(options.renderAbovePrompt);
  let tick = 0;
  let previousWidth = 0;

  const render = () => {
    const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
    const verbTick = Math.floor((Date.now() - startedAt) / WAITING_VERB_ROTATE_MS);
    const verb = pickWaitingVerb(verbTick);
    const frame = WAITING_FRAMES[tick % WAITING_FRAMES.length] || '✦';
    const dots = '.'.repeat((tick % 3) + 1).padEnd(3, ' ');
    const msg = `${frame} ${verb}${dots} · waiting for ${backend} (${seconds}s)`;

    if (useAnimatedLine) {
      const palette = [chalk.cyan, chalk.magenta, chalk.yellow, chalk.green] as const;
      const tint = palette[tick % palette.length] || chalk.cyan;
      const pad = previousWidth > msg.length ? ' '.repeat(previousWidth - msg.length) : '';
      if (renderAbovePrompt && options.statusLane.isPromptActive()) {
        process.stdout.write('\x1b7');
        process.stdout.write('\x1b[1A');
        process.stdout.write(`\r\x1b[2K${tint(msg)}${pad}`);
        process.stdout.write('\x1b8');
      } else {
        process.stdout.write(`\r\x1b[2K${tint(msg)}${pad}`);
      }
      previousWidth = msg.length;
    } else if (tick === 0 || tick % 2 === 0) {
      logger(chalk.dim(`status> ${frame} ${verb} · waiting for ${backend} (${seconds}s)`));
    }

    tick += 1;
  };

  render();
  const timer = setInterval(render, useAnimatedLine ? WAITING_FRAME_INTERVAL_MS : 1000);

  return (doneMessage?: string) => {
    clearInterval(timer);
    if (useAnimatedLine) {
      const clear = previousWidth > 0 ? ' '.repeat(previousWidth) : '';
      if (renderAbovePrompt && options.statusLane.isPromptActive()) {
        process.stdout.write('\x1b7');
        process.stdout.write('\x1b[1A');
        process.stdout.write(`\r\x1b[2K${clear}\r`);
        process.stdout.write('\x1b8');
      } else {
        process.stdout.write(`\r\x1b[2K${clear}\r`);
      }
    }
    if (doneMessage) {
      logger(chalk.dim(doneMessage));
    }
  };
}
