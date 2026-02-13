/**
 * Message content extractor
 * Extracts links, notes, tasks, and reminders from message content
 */

import type {
  InboundMessage,
  ExtractedContext,
  ExtractedLink,
  ExtractedNote,
  ExtractedTask,
  ExtractedReminder,
  ChannelConfig,
} from './types';

// URL regex that captures most common URL patterns
const URL_REGEX =
  /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_+.~#?&/=]*)/gi;

// Time parsing patterns for reminders
const TIME_PATTERNS = {
  // "in X minutes/hours/days"
  relative: /in\s+(\d+)\s+(minute|hour|day|week|month)s?/i,
  // "at HH:MM" or "at H:MM AM/PM"
  atTime: /at\s+(\d{1,2}):(\d{2})(?:\s*(am|pm))?/i,
  // "tomorrow", "next week", etc.
  named:
    /(tomorrow|tonight|next\s+(?:week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday))/i,
};

/**
 * Extract all context from an inbound message
 */
export function extractContext(message: InboundMessage, config: ChannelConfig): ExtractedContext {
  const text = message.rawBody || message.body || '';
  const trimmed = text.trim();

  // Check if this is a command
  const commandResult = parseCommand(trimmed, config.commandPrefix);

  const context: ExtractedContext = {
    links: [],
    notes: [],
    tasks: [],
    reminders: [],
    isCommand: commandResult.isCommand,
    command: commandResult.command,
    commandArgs: commandResult.args,
  };

  // Handle explicit commands
  if (commandResult.isCommand) {
    switch (commandResult.command) {
      case 'save':
        // Save command - extract links from args or use forwarded content
        context.links = extractLinks(commandResult.args || trimmed);
        break;
      case 'note':
        // Note command - save the args as a note
        if (commandResult.args) {
          context.notes.push(parseNote(commandResult.args));
        }
        break;
      case 'task':
        // Task command - parse as a task
        if (commandResult.args) {
          context.tasks.push(parseTask(commandResult.args));
        }
        break;
      case 'remind':
        // Remind command - parse reminder with time
        if (commandResult.args) {
          const reminder = parseReminder(commandResult.args);
          if (reminder) {
            context.reminders.push(reminder);
          }
        }
        break;
    }
    return context;
  }

  // Auto-extract based on config
  if (config.autoExtract.links) {
    context.links = extractLinks(text);
  }

  return context;
}

/**
 * Parse a command from message text
 */
function parseCommand(
  text: string,
  prefix: string
): { isCommand: boolean; command?: string; args?: string } {
  if (!text.startsWith(prefix)) {
    return { isCommand: false };
  }

  // Remove prefix and get first word as command
  const withoutPrefix = text.slice(prefix.length);
  const spaceIndex = withoutPrefix.indexOf(' ');

  if (spaceIndex === -1) {
    return {
      isCommand: true,
      command: withoutPrefix.toLowerCase(),
      args: undefined,
    };
  }

  return {
    isCommand: true,
    command: withoutPrefix.slice(0, spaceIndex).toLowerCase(),
    args: withoutPrefix.slice(spaceIndex + 1).trim(),
  };
}

/**
 * Extract all URLs from text
 */
export function extractLinks(text: string): ExtractedLink[] {
  const matches = text.match(URL_REGEX);
  if (!matches) {
    return [];
  }

  // Deduplicate URLs
  const uniqueUrls = [...new Set(matches)];

  return uniqueUrls.map((url) => {
    // Try to extract surrounding context (text near the URL)
    const urlIndex = text.indexOf(url);
    const contextStart = Math.max(0, urlIndex - 50);
    const contextEnd = Math.min(text.length, urlIndex + url.length + 50);
    const context = text.slice(contextStart, contextEnd).trim();

    return {
      url,
      context: context !== url ? context : undefined,
    };
  });
}

/**
 * Parse note content
 */
function parseNote(text: string): ExtractedNote {
  // Check for tags (hashtags)
  const tagMatches = text.match(/#[\w-]+/g);
  const tags = tagMatches ? tagMatches.map((t) => t.slice(1)) : [];

  // Remove tags from content
  let content = text;
  for (const tag of tagMatches || []) {
    content = content.replace(tag, '').trim();
  }

  // Check for title (first line if it's short and followed by newline)
  const lines = content.split('\n');
  let title: string | undefined;

  if (lines.length > 1 && lines[0].length < 100) {
    title = lines[0].trim();
    content = lines.slice(1).join('\n').trim();
  }

  return {
    content: content || text,
    title,
    tags: tags.length > 0 ? tags : undefined,
  };
}

/**
 * Parse task from text
 */
function parseTask(text: string): ExtractedTask {
  let title = text;
  let priority: 'low' | 'medium' | 'high' | undefined;
  let dueDate: string | undefined;

  // Check for priority markers
  if (text.includes('!high') || text.includes('!urgent')) {
    priority = 'high';
    title = title.replace(/!high|!urgent/gi, '').trim();
  } else if (text.includes('!medium')) {
    priority = 'medium';
    title = title.replace(/!medium/gi, '').trim();
  } else if (text.includes('!low')) {
    priority = 'low';
    title = title.replace(/!low/gi, '').trim();
  }

  // Check for due date patterns
  const relativeMatch = text.match(TIME_PATTERNS.relative);
  if (relativeMatch) {
    dueDate = calculateRelativeTime(
      parseInt(relativeMatch[1]),
      relativeMatch[2] as 'minute' | 'hour' | 'day' | 'week' | 'month'
    );
    title = title.replace(relativeMatch[0], '').trim();
  }

  const namedMatch = text.match(TIME_PATTERNS.named);
  if (namedMatch && !dueDate) {
    dueDate = parseNamedTime(namedMatch[1]);
    title = title.replace(namedMatch[0], '').trim();
  }

  return {
    title: title.trim(),
    dueDate,
    priority,
  };
}

/**
 * Parse reminder from text
 */
function parseReminder(text: string): ExtractedReminder | null {
  let time: string | null = null;
  let message = text;

  // Try relative time pattern
  const relativeMatch = text.match(TIME_PATTERNS.relative);
  if (relativeMatch) {
    time = calculateRelativeTime(
      parseInt(relativeMatch[1]),
      relativeMatch[2] as 'minute' | 'hour' | 'day' | 'week' | 'month'
    );
    message = message.replace(relativeMatch[0], '').trim();
  }

  // Try "at time" pattern
  if (!time) {
    const atMatch = text.match(TIME_PATTERNS.atTime);
    if (atMatch) {
      time = parseAtTime(atMatch[1], atMatch[2], atMatch[3]);
      message = message.replace(atMatch[0], '').trim();
    }
  }

  // Try named time pattern
  if (!time) {
    const namedMatch = text.match(TIME_PATTERNS.named);
    if (namedMatch) {
      time = parseNamedTime(namedMatch[1]) || null;
      message = message.replace(namedMatch[0], '').trim();
    }
  }

  // If we couldn't parse a time, return null
  if (!time) {
    return null;
  }

  // Clean up common words
  message = message
    .replace(/^to\s+/i, '')
    .replace(/^me\s+/i, '')
    .replace(/^about\s+/i, '')
    .trim();

  return {
    message: message || 'Reminder',
    time,
  };
}

/**
 * Calculate a datetime from relative time
 */
function calculateRelativeTime(
  amount: number,
  unit: 'minute' | 'hour' | 'day' | 'week' | 'month'
): string {
  const now = new Date();
  const multipliers: Record<string, number> = {
    minute: 60 * 1000,
    hour: 60 * 60 * 1000,
    day: 24 * 60 * 60 * 1000,
    week: 7 * 24 * 60 * 60 * 1000,
    month: 30 * 24 * 60 * 60 * 1000,
  };

  const future = new Date(now.getTime() + amount * multipliers[unit]);
  return future.toISOString();
}

/**
 * Parse "at HH:MM" time
 */
function parseAtTime(hours: string, minutes: string, ampm?: string): string {
  const now = new Date();
  let h = parseInt(hours);
  const m = parseInt(minutes);

  if (ampm) {
    if (ampm.toLowerCase() === 'pm' && h < 12) h += 12;
    if (ampm.toLowerCase() === 'am' && h === 12) h = 0;
  }

  const target = new Date(now);
  target.setHours(h, m, 0, 0);

  // If the time has passed today, set it for tomorrow
  if (target <= now) {
    target.setDate(target.getDate() + 1);
  }

  return target.toISOString();
}

/**
 * Parse named time like "tomorrow", "next week"
 */
function parseNamedTime(named: string): string | undefined {
  const now = new Date();
  const lower = named.toLowerCase().trim();

  if (lower === 'tomorrow') {
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0); // Default to 9 AM
    return tomorrow.toISOString();
  }

  if (lower === 'tonight') {
    const tonight = new Date(now);
    tonight.setHours(20, 0, 0, 0); // 8 PM
    if (tonight <= now) {
      tonight.setDate(tonight.getDate() + 1);
    }
    return tonight.toISOString();
  }

  if (lower === 'next week') {
    const nextWeek = new Date(now);
    nextWeek.setDate(nextWeek.getDate() + 7);
    nextWeek.setHours(9, 0, 0, 0);
    return nextWeek.toISOString();
  }

  if (lower === 'next month') {
    const nextMonth = new Date(now);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    nextMonth.setHours(9, 0, 0, 0);
    return nextMonth.toISOString();
  }

  // Day names
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const nextDayMatch = lower.match(/next\s+(\w+)/);
  if (nextDayMatch) {
    const dayIndex = dayNames.indexOf(nextDayMatch[1].toLowerCase());
    if (dayIndex !== -1) {
      const target = new Date(now);
      const currentDay = target.getDay();
      let daysUntil = dayIndex - currentDay;
      if (daysUntil <= 0) daysUntil += 7;
      target.setDate(target.getDate() + daysUntil);
      target.setHours(9, 0, 0, 0);
      return target.toISOString();
    }
  }

  return undefined;
}

/**
 * Check if a message contains any extractable content
 */
export function hasExtractableContent(message: InboundMessage, config: ChannelConfig): boolean {
  const text = message.rawBody || message.body || '';

  // Check for commands
  if (text.startsWith(config.commandPrefix)) {
    return true;
  }

  // Check for URLs if auto-extract is enabled
  if (config.autoExtract.links && URL_REGEX.test(text)) {
    return true;
  }

  return false;
}
