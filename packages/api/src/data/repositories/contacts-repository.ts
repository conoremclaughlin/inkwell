/**
 * Contacts Repository
 *
 * Handles contact management and name resolution for cross-platform identity.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '../supabase/types.js';

export interface Contact {
  id: string;
  userId: string;
  name: string;
  displayName: string | null;
  aliases: string[];
  email: string | null;
  phone: string | null;
  telegramId: string | null;
  telegramUsername: string | null;
  imessageId: string | null;
  discordId: string | null;
  whatsappId: string | null;
  notes: string | null;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CreateContactOptions {
  userId: string;
  name: string;
  displayName?: string;
  aliases?: string[];
  email?: string;
  phone?: string;
  telegramId?: string;
  telegramUsername?: string;
  imessageId?: string;
  discordId?: string;
  whatsappId?: string;
  notes?: string;
  tags?: string[];
}

export interface ResolveNameResult {
  resolved: boolean;
  contact: Contact | null;
  matchType: 'exact' | 'alias' | 'similar' | 'none';
  similarContacts?: Array<{ contact: Contact; similarity: number }>;
  originalName: string;
  canonicalName: string | null;
}

/**
 * Calculate Levenshtein distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculate similarity score (0-1) between two strings
 */
function calculateSimilarity(a: string, b: string): number {
  const aLower = a.toLowerCase().trim();
  const bLower = b.toLowerCase().trim();

  if (aLower === bLower) return 1;

  const distance = levenshteinDistance(aLower, bLower);
  const maxLength = Math.max(aLower.length, bLower.length);

  if (maxLength === 0) return 1;

  return 1 - distance / maxLength;
}

export class ContactsRepository {
  constructor(private supabase: SupabaseClient<Database>) {}

  /**
   * Create a new contact
   */
  async createContact(options: CreateContactOptions): Promise<Contact> {
    const { data, error } = await this.supabase
      .from('contacts')
      .insert({
        user_id: options.userId,
        name: options.name,
        display_name: options.displayName,
        aliases: options.aliases || [],
        email: options.email,
        phone: options.phone,
        telegram_id: options.telegramId,
        telegram_username: options.telegramUsername,
        imessage_id: options.imessageId,
        discord_id: options.discordId,
        whatsapp_id: options.whatsappId,
        notes: options.notes,
        tags: options.tags || [],
      })
      .select()
      .single();

    if (error) throw error;

    return this.mapContact(data);
  }

  /**
   * Get all contacts for a user
   */
  async getContacts(userId: string): Promise<Contact[]> {
    const { data, error } = await this.supabase
      .from('contacts')
      .select('*')
      .eq('user_id', userId)
      .order('name');

    if (error) throw error;

    return (data || []).map(this.mapContact);
  }

  /**
   * Get a contact by ID
   */
  async getContactById(contactId: string): Promise<Contact | null> {
    const { data, error } = await this.supabase
      .from('contacts')
      .select('*')
      .eq('id', contactId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return this.mapContact(data);
  }

  /**
   * Find a contact by exact name match
   */
  async findByName(userId: string, name: string): Promise<Contact | null> {
    const { data, error } = await this.supabase
      .from('contacts')
      .select('*')
      .eq('user_id', userId)
      .eq('name', name)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return this.mapContact(data);
  }

  /**
   * Find a contact by alias
   */
  async findByAlias(userId: string, alias: string): Promise<Contact | null> {
    const aliasLower = alias.toLowerCase();

    const { data, error } = await this.supabase
      .from('contacts')
      .select('*')
      .eq('user_id', userId)
      .contains('aliases', [aliasLower]);

    if (error) throw error;

    if (data && data.length > 0) {
      return this.mapContact(data[0]);
    }

    return null;
  }

  /**
   * Resolve a name to a contact, checking exact match, aliases, and similar names
   *
   * @param userId - User ID to search contacts for
   * @param name - Name to resolve
   * @param similarityThreshold - Minimum similarity score (0-1) to consider a match (default: 0.7)
   */
  async resolveName(
    userId: string,
    name: string,
    similarityThreshold = 0.7
  ): Promise<ResolveNameResult> {
    const nameLower = name.toLowerCase().trim();

    // 1. Check exact name match
    const exactMatch = await this.findByName(userId, name);
    if (exactMatch) {
      return {
        resolved: true,
        contact: exactMatch,
        matchType: 'exact',
        originalName: name,
        canonicalName: exactMatch.name,
      };
    }

    // 2. Check alias match
    const aliasMatch = await this.findByAlias(userId, nameLower);
    if (aliasMatch) {
      return {
        resolved: true,
        contact: aliasMatch,
        matchType: 'alias',
        originalName: name,
        canonicalName: aliasMatch.name,
      };
    }

    // 3. Check for similar names
    const allContacts = await this.getContacts(userId);
    const similarContacts: Array<{ contact: Contact; similarity: number }> = [];

    for (const contact of allContacts) {
      // Check name similarity
      const nameSimilarity = calculateSimilarity(name, contact.name);
      if (nameSimilarity >= similarityThreshold) {
        similarContacts.push({ contact, similarity: nameSimilarity });
        continue;
      }

      // Check alias similarity
      for (const alias of contact.aliases) {
        const aliasSimilarity = calculateSimilarity(name, alias);
        if (aliasSimilarity >= similarityThreshold) {
          similarContacts.push({ contact, similarity: aliasSimilarity });
          break;
        }
      }
    }

    // Sort by similarity descending
    similarContacts.sort((a, b) => b.similarity - a.similarity);

    if (similarContacts.length > 0) {
      return {
        resolved: false,
        contact: null,
        matchType: 'similar',
        similarContacts,
        originalName: name,
        canonicalName: null,
      };
    }

    // 4. No match found
    return {
      resolved: false,
      contact: null,
      matchType: 'none',
      originalName: name,
      canonicalName: null,
    };
  }

  /**
   * Add an alias to a contact
   */
  async addAlias(contactId: string, alias: string): Promise<Contact> {
    const contact = await this.getContactById(contactId);
    if (!contact) {
      throw new Error('Contact not found');
    }

    const aliasLower = alias.toLowerCase();
    if (contact.aliases.includes(aliasLower)) {
      return contact;
    }

    const { data, error } = await this.supabase
      .from('contacts')
      .update({
        aliases: [...contact.aliases, aliasLower],
      })
      .eq('id', contactId)
      .select()
      .single();

    if (error) throw error;

    return this.mapContact(data);
  }

  /**
   * Update a contact
   */
  async updateContact(
    contactId: string,
    updates: Partial<Omit<CreateContactOptions, 'userId'>>
  ): Promise<Contact> {
    const updateData: Record<string, unknown> = {};

    if (updates.name !== undefined) updateData.name = updates.name;
    if (updates.displayName !== undefined) updateData.display_name = updates.displayName;
    if (updates.aliases !== undefined) updateData.aliases = updates.aliases;
    if (updates.email !== undefined) updateData.email = updates.email;
    if (updates.phone !== undefined) updateData.phone = updates.phone;
    if (updates.telegramId !== undefined) updateData.telegram_id = updates.telegramId;
    if (updates.telegramUsername !== undefined)
      updateData.telegram_username = updates.telegramUsername;
    if (updates.imessageId !== undefined) updateData.imessage_id = updates.imessageId;
    if (updates.discordId !== undefined) updateData.discord_id = updates.discordId;
    if (updates.whatsappId !== undefined) updateData.whatsapp_id = updates.whatsappId;
    if (updates.notes !== undefined) updateData.notes = updates.notes;
    if (updates.tags !== undefined) updateData.tags = updates.tags;

    const { data, error } = await this.supabase
      .from('contacts')
      .update(updateData)
      .eq('id', contactId)
      .select()
      .single();

    if (error) throw error;

    return this.mapContact(data);
  }

  /**
   * Delete a contact
   */
  async deleteContact(contactId: string): Promise<void> {
    const { error } = await this.supabase.from('contacts').delete().eq('id', contactId);

    if (error) throw error;
  }

  /**
   * Find or create a contact by platform identity.
   * Used by the gateway to auto-resolve contacts from incoming channel messages.
   * Handles unique constraint races via catch-and-retry.
   */
  async findOrCreateByPlatformId(
    userId: string,
    platform: 'telegram' | 'discord' | 'whatsapp' | 'imessage',
    platformId: string,
    info?: { name?: string; username?: string }
  ): Promise<Contact> {
    // Try to find existing contact first
    const existing = await this.findByPlatformId(userId, platform, platformId);
    if (existing) return existing;

    // Auto-create with platform ID
    const platformColumnMap: Record<string, string> = {
      telegram: 'telegramId',
      discord: 'discordId',
      whatsapp: 'whatsappId',
      imessage: 'imessageId',
    };

    const platformField = platformColumnMap[platform];
    const displayName = info?.name || info?.username || `${platform}:${platformId}`;

    try {
      return await this.createContact({
        userId,
        name: displayName,
        displayName: info?.name,
        [platformField]: platformId,
        ...(platform === 'telegram' && info?.username ? { telegramUsername: info.username } : {}),
        tags: ['auto-created', 'external'],
      });
    } catch (error: unknown) {
      // Unique constraint race — another request created it first.
      // Supabase errors are plain objects with { code, message }, not Error instances.
      const err = error as Record<string, unknown>;
      const msg = err?.message
        ? String(err.message)
        : error instanceof Error
          ? error.message
          : String(error);
      const code = err?.code ? String(err.code) : '';
      if (msg.includes('duplicate') || msg.includes('unique') || code === '23505') {
        const retried = await this.findByPlatformId(userId, platform, platformId);
        if (retried) return retried;
      }
      throw error;
    }
  }

  /**
   * Find or create a synthetic group contact.
   * Groups are contacts with type metadata, keyed by platform + groupId.
   */
  async findOrCreateGroupContact(
    userId: string,
    platform: 'telegram' | 'discord' | 'whatsapp' | 'slack',
    groupId: string,
    info?: { groupName?: string }
  ): Promise<Contact> {
    // Groups are stored with the groupId in the platform's ID column
    // and tagged as 'group' for disambiguation
    const platformForLookup = platform as 'telegram' | 'discord' | 'whatsapp' | 'imessage';
    if (platform === 'slack') {
      // Slack uses discord_id column as a generic "chat platform" slot
      const existing = await this.findByPlatformId(userId, 'discord', groupId);
      if (existing && existing.tags.includes('group')) return existing;
    } else {
      const existing = await this.findByPlatformId(userId, platformForLookup, groupId);
      if (existing && existing.tags.includes('group')) return existing;
    }

    const displayName = info?.groupName || `${platform}-group:${groupId}`;

    const platformColumnMap: Record<string, string> = {
      telegram: 'telegramId',
      discord: 'discordId',
      whatsapp: 'whatsappId',
      slack: 'discordId', // Slack reuses discord column
    };
    const platformField = platformColumnMap[platform];

    try {
      return await this.createContact({
        userId,
        name: displayName,
        displayName: info?.groupName,
        [platformField]: groupId,
        tags: ['auto-created', 'group'],
      });
    } catch (error: unknown) {
      const err = error as Record<string, unknown>;
      const msg = err?.message
        ? String(err.message)
        : error instanceof Error
          ? error.message
          : String(error);
      const code = err?.code ? String(err.code) : '';
      if (msg.includes('duplicate') || msg.includes('unique') || code === '23505') {
        // Race — try lookup again
        if (platform === 'slack') {
          const retried = await this.findByPlatformId(userId, 'discord', groupId);
          if (retried) return retried;
        } else {
          const retried = await this.findByPlatformId(userId, platformForLookup, groupId);
          if (retried) return retried;
        }
      }
      throw error;
    }
  }

  /**
   * Find contact by platform identity
   */
  async findByPlatformId(
    userId: string,
    platform: 'telegram' | 'discord' | 'whatsapp' | 'imessage',
    platformId: string
  ): Promise<Contact | null> {
    const columnMap = {
      telegram: 'telegram_id',
      discord: 'discord_id',
      whatsapp: 'whatsapp_id',
      imessage: 'imessage_id',
    };

    const column = columnMap[platform];

    const { data, error } = await this.supabase
      .from('contacts')
      .select('*')
      .eq('user_id', userId)
      .eq(column, platformId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') return null;
      throw error;
    }

    return this.mapContact(data);
  }

  private mapContact(row: Database['public']['Tables']['contacts']['Row']): Contact {
    return {
      id: row.id,
      userId: row.user_id,
      name: row.name,
      displayName: row.display_name,
      aliases: row.aliases || [],
      email: row.email,
      phone: row.phone,
      telegramId: row.telegram_id,
      telegramUsername: row.telegram_username,
      imessageId: row.imessage_id,
      discordId: row.discord_id,
      whatsappId: row.whatsapp_id,
      notes: row.notes,
      tags: row.tags || [],
      createdAt: row.created_at || new Date().toISOString(),
      updatedAt: row.updated_at || new Date().toISOString(),
    };
  }
}

// Export utility functions for testing
export { calculateSimilarity, levenshteinDistance };
