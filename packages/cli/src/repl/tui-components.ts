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
  private dirtyWhilePrompt = false;
  private timezone?: string;
  private statusLine = 'status> waiting for input';
  private hintLine = 'hint> ready';

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

  public clearPromptDock(): void {
    if (!this.live || !this.promptActive) return;
    // Prompt line
    output.write('\r\x1b[2K');
    // Hint line
    output.write('\x1b[1A\r\x1b[2K');
    // Status line
    output.write('\x1b[1A\r\x1b[2K');
    output.write('\r');
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
    const rendered = `status> ${summary} • ${formatNow(this.timezone)}`;
    this.statusLine = rendered;
    if (!this.live) {
      console.log(chalk.dim(rendered));
      return;
    }
    if (this.promptActive && !force) {
      this.dirtyWhilePrompt = true;
      return;
    }
    this.dirtyWhilePrompt = false;
  }

  public renderHint(message: string): void {
    const rendered = `hint> ${message}`;
    this.hintLine = rendered;
    if (!this.live) {
      console.log(chalk.dim(rendered));
      return;
    }
    if (this.promptActive) {
      this.dirtyWhilePrompt = true;
      return;
    }
  }

  public setHint(message: string): void {
    this.hintLine = `hint> ${message}`;
  }

  public buildPromptLabel(promptLabel: string): string {
    if (!this.live) return promptLabel;
    return `\n${chalk.dim(this.statusLine)}\n${chalk.dim(this.hintLine)}\n${promptLabel}`;
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
