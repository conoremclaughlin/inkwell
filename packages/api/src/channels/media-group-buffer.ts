/**
 * Media Group Buffer
 *
 * Platform-agnostic utility for aggregating related media messages into a
 * single InboundMessage. When platforms like Telegram send albums (multiple
 * photos/documents), each item arrives as a separate message sharing a group
 * identifier. This buffer collects them and combines into one message after
 * a short timeout.
 *
 * Usage:
 *   const buffer = new MediaGroupBuffer(async (msg) => { ... }, { flushDelayMs: 500 });
 *   buffer.add('group-123', firstPhotoMessage);
 *   buffer.add('group-123', secondPhotoMessage);
 *   // After 500ms, callback fires with a single combined message
 */

import type { InboundMessage, MediaAttachment } from './types';
import { logger } from '../utils/logger';

// ============================================================================
// Types
// ============================================================================

export interface MediaGroupBufferConfig {
  /** Delay before flushing a group (default: 500ms). Telegram sends album items ~100-300ms apart. */
  flushDelayMs?: number;
}

export type MediaGroupFlushCallback = (message: InboundMessage) => Promise<void>;

interface BufferedGroup {
  messages: InboundMessage[];
  timer: NodeJS.Timeout;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_FLUSH_DELAY_MS = 500;

// ============================================================================
// Buffer
// ============================================================================

export class MediaGroupBuffer {
  private groups = new Map<string, BufferedGroup>();
  private callback: MediaGroupFlushCallback;
  private flushDelayMs: number;

  constructor(callback: MediaGroupFlushCallback, config?: MediaGroupBufferConfig) {
    this.callback = callback;
    this.flushDelayMs = config?.flushDelayMs ?? DEFAULT_FLUSH_DELAY_MS;
  }

  /**
   * Add a message to a media group. If the group already has buffered messages,
   * the flush timer is reset. When the timer fires, all messages in the group
   * are combined into a single InboundMessage and passed to the callback.
   */
  add(groupId: string, message: InboundMessage): void {
    const existing = this.groups.get(groupId);

    if (existing) {
      clearTimeout(existing.timer);
      existing.messages.push(message);
      existing.timer = setTimeout(() => this.flush(groupId), this.flushDelayMs);
      logger.debug(`Media group ${groupId}: buffered ${existing.messages.length} items`);
    } else {
      const timer = setTimeout(() => this.flush(groupId), this.flushDelayMs);
      this.groups.set(groupId, { messages: [message], timer });
      logger.debug(`Media group ${groupId}: started buffering`);
    }
  }

  /**
   * Combine all buffered messages in a group into a single InboundMessage
   * and fire the callback.
   */
  private async flush(groupId: string): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group) return;

    this.groups.delete(groupId);
    const { messages } = group;

    if (messages.length === 0) return;
    if (messages.length === 1) {
      // Single message — pass through as-is
      await this.callback(messages[0]);
      return;
    }

    const combined = this.combineMessages(messages);

    logger.info(`Media group ${groupId}: flushed ${messages.length} items`, {
      mediaCount: combined.media?.length ?? 0,
      body: combined.body.substring(0, 80),
    });

    await this.callback(combined);
  }

  /**
   * Combine multiple InboundMessages into a single message.
   * - media: flatMap all media arrays
   * - body: use caption from whichever message has one; otherwise generate descriptive text
   * - timestamp: earliest
   * - mentions: merge (union users, OR botMentioned)
   * - raw: array of all raw objects
   */
  private combineMessages(messages: InboundMessage[]): InboundMessage {
    const first = messages[0];

    // Collect all media
    const allMedia: MediaAttachment[] = messages.flatMap((m) => m.media || []);

    // Find caption — the one message with real text (not placeholder like "[Image attached]")
    const placeholderPattern = /^\[.*attached\]$/;
    const captionMessage = messages.find(
      (m) => m.body && m.body.trim() !== '' && !placeholderPattern.test(m.body.trim())
    );

    let body: string;
    if (captionMessage) {
      body = captionMessage.body;
    } else {
      body = this.generateMediaDescription(allMedia);
    }

    // Earliest timestamp
    const timestamps = messages.map((m) => m.timestamp).filter((t): t is number => t !== undefined);
    const timestamp = timestamps.length > 0 ? Math.min(...timestamps) : first.timestamp;

    // Merge mentions
    const allMentionedUsers = new Set<string>();
    let botMentioned = false;
    for (const msg of messages) {
      if (msg.mentions) {
        for (const user of msg.mentions.users) {
          allMentionedUsers.add(user);
        }
        if (msg.mentions.botMentioned) {
          botMentioned = true;
        }
      }
    }

    // Collect raw objects
    const rawObjects = messages.map((m) => m.raw).filter((r) => r !== undefined);

    return {
      ...first,
      body,
      rawBody: body,
      timestamp,
      media: allMedia.length > 0 ? allMedia : undefined,
      mentions:
        allMentionedUsers.size > 0 || botMentioned
          ? { users: [...allMentionedUsers], botMentioned }
          : first.mentions,
      raw: rawObjects.length > 1 ? rawObjects : first.raw,
    };
  }

  /**
   * Generate a human-readable description of the media attachments.
   * e.g. "[3 images attached]", "[2 files attached]", "[1 image, 1 document attached]"
   */
  private generateMediaDescription(media: MediaAttachment[]): string {
    if (media.length === 0) return '';

    const counts = new Map<string, number>();
    for (const item of media) {
      const label =
        item.type === 'image'
          ? 'image'
          : item.type === 'video'
            ? 'video'
            : item.type === 'audio'
              ? 'audio'
              : 'file';
      counts.set(label, (counts.get(label) || 0) + 1);
    }

    // If all same type, use simple plural
    if (counts.size === 1) {
      const [type, count] = [...counts.entries()][0];
      const plural = count === 1 ? type : `${type}s`;
      return `[${count} ${plural} attached]`;
    }

    // Mixed types: "1 image, 2 files attached"
    const parts = [...counts.entries()].map(([type, count]) => {
      const plural = count === 1 ? type : `${type}s`;
      return `${count} ${plural}`;
    });
    return `[${parts.join(', ')} attached]`;
  }

  /**
   * Clear all pending groups without flushing. Call on shutdown.
   */
  destroy(): void {
    for (const [, group] of this.groups) {
      clearTimeout(group.timer);
    }
    this.groups.clear();
  }

  /**
   * Number of groups currently buffering (for testing/debugging).
   */
  get pendingGroupCount(): number {
    return this.groups.size;
  }
}
