/**
 * Channel adapter for processing inbound messages
 * Bridges channel messages to our personal context system
 */

import type { DataComposer } from '../data/composer';
import { resolveUser } from '../services/user-resolver';
import { logger } from '../utils/logger';
import { extractContext, hasExtractableContent } from './extractor';
import type {
  InboundMessage,
  ProcessingResult,
  ChannelConfig,
  ChannelPlatform,
  ExtractedContext,
} from './types';
import type { Platform } from '../types/shared';

export class ChannelAdapter {
  private dataComposer: DataComposer;
  private config: ChannelConfig;

  constructor(dataComposer: DataComposer, config?: Partial<ChannelConfig>) {
    this.dataComposer = dataComposer;
    this.config = {
      enabledPlatforms: config?.enabledPlatforms ?? ['telegram', 'whatsapp', 'discord', 'slack'],
      autoExtract: {
        links: config?.autoExtract?.links ?? true,
        notes: config?.autoExtract?.notes ?? false,
        tasks: config?.autoExtract?.tasks ?? false,
        reminders: config?.autoExtract?.reminders ?? false,
      },
      commandPrefix: config?.commandPrefix ?? '/',
      sendConfirmations: config?.sendConfirmations ?? true,
    };
  }

  /**
   * Check if a platform is enabled
   */
  isPlatformEnabled(platform: ChannelPlatform): boolean {
    return this.config.enabledPlatforms.includes(platform);
  }

  /**
   * Process an inbound message
   */
  async processMessage(message: InboundMessage): Promise<ProcessingResult> {
    const result: ProcessingResult = {
      success: false,
      saved: {
        links: 0,
        notes: 0,
        tasks: 0,
        reminders: 0,
      },
      errors: [],
    };

    // Check if platform is enabled
    if (!this.isPlatformEnabled(message.platform)) {
      result.errors?.push(`Platform ${message.platform} is not enabled`);
      return result;
    }

    // Check if message has extractable content
    if (!hasExtractableContent(message, this.config)) {
      result.success = true; // Not an error, just nothing to extract
      return result;
    }

    // Resolve the user
    const userIdentifier = this.buildUserIdentifier(message);
    const resolvedUser = await resolveUser(userIdentifier, this.dataComposer);

    if (!resolvedUser) {
      // If user doesn't exist, try to create them
      const newUser = await this.createUserFromMessage(message);
      if (!newUser) {
        result.errors?.push('Could not resolve or create user');
        return result;
      }
      result.userId = newUser.id;
    } else {
      result.userId = resolvedUser.user.id;
    }

    // Extract context from the message
    const context = extractContext(message, this.config);

    // Process extracted content
    try {
      // Save links
      for (const link of context.links) {
        try {
          await this.dataComposer.repositories.links.create({
            user_id: result.userId!,
            url: link.url,
            title: link.title,
            description: link.description || link.context,
            tags: [],
            source: this.mapPlatformToApi(message.platform),
            metadata: {
              extractedFrom: 'channel',
              conversationId: message.conversationId,
              messageId: message.messageId,
            },
          });
          result.saved.links++;
        } catch (err) {
          logger.error(`Failed to save link: ${err}`);
          result.errors?.push(`Failed to save link: ${link.url}`);
        }
      }

      // Save notes
      for (const note of context.notes) {
        try {
          await this.dataComposer.repositories.notes.create({
            user_id: result.userId!,
            title: note.title,
            content: note.content,
            tags: note.tags || [],
            is_private: true,
            metadata: {
              extractedFrom: 'channel',
              platform: message.platform,
              conversationId: message.conversationId,
            },
          });
          result.saved.notes++;
        } catch (err) {
          logger.error(`Failed to save note: ${err}`);
          result.errors?.push('Failed to save note');
        }
      }

      // Save tasks
      for (const task of context.tasks) {
        try {
          await this.dataComposer.repositories.tasks.create({
            user_id: result.userId!,
            title: task.title,
            description: task.description,
            status: 'pending',
            priority: (task.priority || 'medium') as 'low' | 'medium' | 'high' | 'critical',
            tags: [],
            created_by: `channel:${message.platform}`,
          });
          result.saved.tasks++;
        } catch (err) {
          logger.error(`Failed to save task: ${err}`);
          result.errors?.push('Failed to save task');
        }
      }

      // Save reminders
      for (const reminder of context.reminders) {
        try {
          const platform = this.mapPlatformToApi(message.platform);
          const recurrence = reminder.recurrence
            ? {
                frequency: reminder.recurrence.frequency,
                interval: reminder.recurrence.interval ?? 1,
              }
            : undefined;
          await this.dataComposer.repositories.reminders.create({
            user_id: result.userId!,
            message: reminder.message,
            reminder_time: new Date(reminder.time),
            status: 'pending',
            channel: platform,
            recurrence,
            metadata: {
              extractedFrom: 'channel',
              conversationId: message.conversationId,
            },
          });
          result.saved.reminders++;
        } catch (err) {
          logger.error(`Failed to save reminder: ${err}`);
          result.errors?.push('Failed to save reminder');
        }
      }

      result.success = true;

      // Build response message if confirmations are enabled
      if (this.config.sendConfirmations) {
        result.response = this.buildConfirmationMessage(result, context);
      }
    } catch (err) {
      logger.error(`Error processing message: ${err}`);
      result.errors?.push(`Processing error: ${err}`);
    }

    return result;
  }

  /**
   * Map channel platform to API platform type
   */
  private mapPlatformToApi(platform: ChannelPlatform): Platform {
    // All our platforms are valid Platform types
    return platform as Platform;
  }

  /**
   * Build user identifier from message sender info
   */
  private buildUserIdentifier(message: InboundMessage) {
    const platformIdMap: Record<ChannelPlatform, string> = {
      telegram: 'telegram',
      whatsapp: 'whatsapp',
      discord: 'discord',
      slack: 'slack',
      signal: 'signal',
      imessage: 'imessage',
    };

    return {
      platform: platformIdMap[message.platform] as 'telegram' | 'whatsapp' | 'discord',
      platformId: message.sender.id,
      phone: message.sender.phone,
      email: undefined,
      userId: undefined,
    };
  }

  /**
   * Create a new user from message sender info
   */
  private async createUserFromMessage(message: InboundMessage) {
    const userData: Record<string, unknown> = {
      username: message.sender.username,
      first_name: message.sender.name?.split(' ')[0],
      last_name: message.sender.name?.split(' ').slice(1).join(' ') || null,
      preferences: {},
    };

    // Set platform-specific ID
    switch (message.platform) {
      case 'telegram':
        if (message.sender.id) {
          userData.telegram_id = parseInt(message.sender.id, 10);
        }
        break;
      case 'whatsapp':
        userData.whatsapp_id = message.sender.id;
        break;
      case 'discord':
        userData.discord_id = message.sender.id;
        break;
    }

    if (message.sender.phone) {
      userData.phone_number = message.sender.phone;
    }

    try {
      const user = await this.dataComposer.repositories.users.create(userData as any);
      logger.info(`Created new user from ${message.platform}: ${user.id}`);
      return user;
    } catch (err) {
      logger.error(`Failed to create user: ${err}`);
      return null;
    }
  }

  /**
   * Build a confirmation message for the user
   */
  private buildConfirmationMessage(
    result: ProcessingResult,
    _context: ExtractedContext
  ): string | undefined {
    const parts: string[] = [];

    if (result.saved.links > 0) {
      parts.push(`Saved ${result.saved.links} link${result.saved.links > 1 ? 's' : ''}`);
    }

    if (result.saved.notes > 0) {
      parts.push(`Saved ${result.saved.notes} note${result.saved.notes > 1 ? 's' : ''}`);
    }

    if (result.saved.tasks > 0) {
      parts.push(`Created ${result.saved.tasks} task${result.saved.tasks > 1 ? 's' : ''}`);
    }

    if (result.saved.reminders > 0) {
      parts.push(`Set ${result.saved.reminders} reminder${result.saved.reminders > 1 ? 's' : ''}`);
    }

    if (parts.length === 0) {
      return undefined;
    }

    return parts.join(', ') + '.';
  }
}

/**
 * Create a channel adapter instance
 */
export function createChannelAdapter(
  dataComposer: DataComposer,
  config?: Partial<ChannelConfig>
): ChannelAdapter {
  return new ChannelAdapter(dataComposer, config);
}
