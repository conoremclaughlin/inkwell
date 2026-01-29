/**
 * Mini-App Records MCP Tools
 *
 * Generic storage for mini-app data with typed indexed fields.
 * Enables "Airtable-like" flexible data storage with efficient querying.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DataComposer } from '../../data/composer';
import { resolveUser, userIdentifierFields } from '../../services/user-resolver';
import { logger } from '../../utils/logger';
import { simplifyDebts, calculatePersonSummary, type Debt } from './debt-utils';
import type { Json } from '../../data/supabase/types';

const saveRecordSchema = {
  ...userIdentifierFields,
  appName: z.string().describe('Mini-app name (e.g., "bill-split", "expense-tracker")'),
  type: z.string().describe('Record type (e.g., "split", "expense", "contact")'),
  data: z.record(z.unknown()).describe('Structured data to store'),
  amount: z.number().optional().describe('Monetary value for indexing'),
  recordedAt: z.string().optional().describe('When this occurred (ISO date)'),
  text: z.string().optional().describe('Searchable text content'),
  tags: z.array(z.string()).optional().describe('Tags for categorization'),
  relatedRecordId: z.string().uuid().optional().describe('ID of related record'),
  metadata: z.record(z.unknown()).optional().describe('Additional metadata'),
};

const queryRecordsSchema = {
  ...userIdentifierFields,
  appName: z.string().optional().describe('Filter by mini-app name'),
  type: z.string().optional().describe('Filter by record type'),
  tags: z.array(z.string()).optional().describe('Filter by tags (any match)'),
  minAmount: z.number().optional().describe('Minimum amount filter'),
  maxAmount: z.number().optional().describe('Maximum amount filter'),
  startDate: z.string().optional().describe('Start date filter (ISO format)'),
  endDate: z.string().optional().describe('End date filter (ISO format)'),
  search: z.string().optional().describe('Full-text search in text'),
  limit: z.number().min(1).max(100).optional().describe('Max results (default: 20)'),
  offset: z.number().min(0).optional().describe('Pagination offset'),
};

const updateBalanceSchema = {
  ...userIdentifierFields,
  appName: z.string().describe('Mini-app name'),
  key: z.string().describe('Unique key for this balance (e.g., person name, account ID)'),
  delta: z.number().describe('Amount to add (positive) or subtract (negative)'),
  description: z.string().optional().describe('Description of this transaction'),
  tags: z.array(z.string()).optional().describe('Tags for categorization'),
  recordedAt: z.string().optional().describe('When this occurred (ISO date, defaults to now)'),
};

const getRecordSchema = {
  ...userIdentifierFields,
  recordId: z.string().uuid().describe('Record ID to retrieve'),
};

const recordDebtSchema = {
  ...userIdentifierFields,
  appName: z.string().describe('Mini-app name (e.g., "bill-split")'),
  from: z.string().describe('Person who owes (debtor)'),
  to: z.string().describe('Person who is owed (creditor)'),
  amount: z.number().describe('Amount owed (positive number)'),
  description: z.string().optional().describe('What this debt is for'),
  recordedAt: z.string().optional().describe('When this occurred (ISO date)'),
  tags: z.array(z.string()).optional().describe('Tags (e.g., group name)'),
};

const getDebtsSchema = {
  ...userIdentifierFields,
  appName: z.string().describe('Mini-app name'),
  person: z.string().optional().describe('Filter to debts involving this person'),
  tags: z.array(z.string()).optional().describe('Filter by tags (e.g., group name)'),
  simplify: z.boolean().optional().describe('Simplify/consolidate debts (default: true)'),
};

const deleteRecordSchema = {
  ...userIdentifierFields,
  recordId: z.string().uuid().describe('Record ID to delete'),
};

export function registerMiniAppRecordTools(server: McpServer, dataComposer: DataComposer): void {
  const supabase = dataComposer.getClient();

  // Save a mini-app record
  server.registerTool(
    'save_mini_app_record',
    {
      description: 'Save structured data for a mini-app. Use indexed fields (amount, dateValue, tags) for efficient querying.\n\nUser can be identified by ONE of: userId, email, phone, or platform + platformId',
      inputSchema: saveRecordSchema,
    },
    async (args) => {
      try {
        const resolved = await resolveUser(args as Parameters<typeof resolveUser>[0], dataComposer);
        if (!resolved) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'User not found' }) }],
            isError: true,
          };
        }

        const { appName, type, data, amount, recordedAt, text, tags, relatedRecordId, metadata } = args as {
          appName: string;
          type: string;
          data: Record<string, unknown>;
          amount?: number;
          recordedAt?: string;
          text?: string;
          tags?: string[];
          relatedRecordId?: string;
          metadata?: Record<string, unknown>;
        };

        const { data: record, error } = await supabase
          .from('mini_app_records')
          .insert({
            user_id: resolved.user.id,
            app_name: appName,
            type,
            data: data as Json,
            amount,
            recorded_at: recordedAt,
            text,
            tags,
            related_record_id: relatedRecordId,
            metadata: (metadata || {}) as Json,
          })
          .select()
          .single();

        if (error) throw error;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              record: {
                id: record.id,
                appName: record.app_name,
                type: record.type,
                createdAt: record.created_at,
              },
            }),
          }],
        };
      } catch (error) {
        logger.error('Error saving mini-app record:', error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    }
  );

  // Query mini-app records
  server.registerTool(
    'query_mini_app_records',
    {
      description: 'Query mini-app records with filters. Supports filtering by app, type, tags, amount range, date range, and full-text search.\n\nUser can be identified by ONE of: userId, email, phone, or platform + platformId',
      inputSchema: queryRecordsSchema,
    },
    async (args) => {
      try {
        const resolved = await resolveUser(args as Parameters<typeof resolveUser>[0], dataComposer);
        if (!resolved) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'User not found' }) }],
            isError: true,
          };
        }

        const { appName, type, tags, minAmount, maxAmount, startDate, endDate, search, limit = 20, offset = 0 } = args as {
          appName?: string;
          type?: string;
          tags?: string[];
          minAmount?: number;
          maxAmount?: number;
          startDate?: string;
          endDate?: string;
          search?: string;
          limit?: number;
          offset?: number;
        };

        let query = supabase
          .from('mini_app_records')
          .select('*')
          .eq('user_id', resolved.user.id)
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1);

        if (appName) query = query.eq('app_name', appName);
        if (type) query = query.eq('type', type);
        if (tags && tags.length > 0) query = query.overlaps('tags', tags);
        if (minAmount !== undefined) query = query.gte('amount', minAmount);
        if (maxAmount !== undefined) query = query.lte('amount', maxAmount);
        if (startDate) query = query.gte('recorded_at', startDate);
        if (endDate) query = query.lte('recorded_at', endDate);
        if (search) query = query.textSearch('text', search);

        const { data: records, error } = await query;

        if (error) throw error;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              count: records?.length || 0,
              records: records?.map((r) => ({
                id: r.id,
                appName: r.app_name,
                type: r.type,
                data: r.data,
                amount: r.amount,
                recordedAt: r.recorded_at,
                tags: r.tags,
                createdAt: r.created_at,
              })),
            }),
          }],
        };
      } catch (error) {
        logger.error('Error querying mini-app records:', error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    }
  );

  // Get a specific record
  server.registerTool(
    'get_mini_app_record',
    {
      description: 'Get a specific mini-app record by ID.\n\nUser can be identified by ONE of: userId, email, phone, or platform + platformId',
      inputSchema: getRecordSchema,
    },
    async (args) => {
      try {
        const resolved = await resolveUser(args as Parameters<typeof resolveUser>[0], dataComposer);
        if (!resolved) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'User not found' }) }],
            isError: true,
          };
        }

        const { recordId } = args as { recordId: string };

        const { data: record, error } = await supabase
          .from('mini_app_records')
          .select('*')
          .eq('id', recordId)
          .eq('user_id', resolved.user.id)
          .single();

        if (error) throw error;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              record: {
                id: record.id,
                appName: record.app_name,
                type: record.type,
                data: record.data,
                amount: record.amount,
                recordedAt: record.recorded_at,
                text: record.text,
                tags: record.tags,
                metadata: record.metadata,
                createdAt: record.created_at,
                updatedAt: record.updated_at,
              },
            }),
          }],
        };
      } catch (error) {
        logger.error('Error getting mini-app record:', error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    }
  );

  // Delete a record
  server.registerTool(
    'delete_mini_app_record',
    {
      description: 'Delete a mini-app record.\n\nUser can be identified by ONE of: userId, email, phone, or platform + platformId',
      inputSchema: deleteRecordSchema,
    },
    async (args) => {
      try {
        const resolved = await resolveUser(args as Parameters<typeof resolveUser>[0], dataComposer);
        if (!resolved) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'User not found' }) }],
            isError: true,
          };
        }

        const { recordId } = args as { recordId: string };

        const { error } = await supabase
          .from('mini_app_records')
          .delete()
          .eq('id', recordId)
          .eq('user_id', resolved.user.id);

        if (error) throw error;

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: true, deleted: recordId }) }],
        };
      } catch (error) {
        logger.error('Error deleting mini-app record:', error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    }
  );

  // Update balance (atomic increment/decrement with transaction history)
  server.registerTool(
    'update_mini_app_balance',
    {
      description: 'Update a running balance by key (e.g., person name, account). Atomically adds/subtracts delta and records the transaction. Creates balance if it doesn\'t exist.\n\nUser can be identified by ONE of: userId, email, phone, or platform + platformId',
      inputSchema: updateBalanceSchema,
    },
    async (args) => {
      try {
        const resolved = await resolveUser(args as Parameters<typeof resolveUser>[0], dataComposer);
        if (!resolved) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'User not found' }) }],
            isError: true,
          };
        }

        const { appName, key, delta, description, tags, recordedAt } = args as {
          appName: string;
          key: string;
          delta: number;
          description?: string;
          tags?: string[];
          recordedAt?: string;
        };

        // Look for existing balance record
        const { data: existing } = await supabase
          .from('mini_app_records')
          .select('*')
          .eq('user_id', resolved.user.id)
          .eq('app_name', appName)
          .eq('type', 'balance')
          .eq('data->>key', key)
          .single();

        let newBalance: number;
        let balanceRecord;

        if (existing) {
          // Update existing balance
          newBalance = (existing.amount || 0) + delta;
          const transactions = (existing.data as { transactions?: unknown[] })?.transactions || [];
          transactions.push({
            delta,
            description,
            recordedAt: recordedAt || new Date().toISOString(),
            balanceAfter: newBalance,
          });

          const { data: updated, error } = await supabase
            .from('mini_app_records')
            .update({
              amount: newBalance,
              data: { key, transactions } as Json,
              updated_at: new Date().toISOString(),
            })
            .eq('id', existing.id)
            .select()
            .single();

          if (error) throw error;
          balanceRecord = updated;
        } else {
          // Create new balance record
          newBalance = delta;
          const { data: created, error } = await supabase
            .from('mini_app_records')
            .insert({
              user_id: resolved.user.id,
              app_name: appName,
              type: 'balance',
              data: {
                key,
                transactions: [{
                  delta,
                  description,
                  recordedAt: recordedAt || new Date().toISOString(),
                  balanceAfter: newBalance,
                }],
              },
              amount: newBalance,
              text: key,
              tags: tags || [],
              recorded_at: recordedAt,
              metadata: {},
            })
            .select()
            .single();

          if (error) throw error;
          balanceRecord = created;
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              balance: {
                id: balanceRecord.id,
                appName: balanceRecord.app_name,
                key,
                previousBalance: existing ? (existing.amount || 0) : 0,
                delta,
                newBalance,
                transactionCount: ((balanceRecord.data as { transactions?: unknown[] })?.transactions || []).length,
              },
            }),
          }],
        };
      } catch (error) {
        logger.error('Error updating balance:', error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    }
  );

  // Get balance by key
  server.registerTool(
    'get_mini_app_balance',
    {
      description: 'Get the current balance for a key. Returns balance amount and transaction history.\n\nUser can be identified by ONE of: userId, email, phone, or platform + platformId',
      inputSchema: {
        ...userIdentifierFields,
        appName: z.string().describe('Mini-app name'),
        key: z.string().describe('Balance key to look up'),
      },
    },
    async (args) => {
      try {
        const resolved = await resolveUser(args as Parameters<typeof resolveUser>[0], dataComposer);
        if (!resolved) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'User not found' }) }],
            isError: true,
          };
        }

        const { appName, key } = args as { appName: string; key: string };

        const { data: record, error } = await supabase
          .from('mini_app_records')
          .select('*')
          .eq('user_id', resolved.user.id)
          .eq('app_name', appName)
          .eq('type', 'balance')
          .eq('data->>key', key)
          .single();

        if (error && error.code !== 'PGRST116') throw error; // PGRST116 = not found

        if (!record) {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: true,
                found: false,
                balance: { key, amount: 0, transactions: [] },
              }),
            }],
          };
        }

        const data = record.data as { key: string; transactions?: Array<{ delta: number; description?: string; recordedAt: string; balanceAfter: number }> };

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              found: true,
              balance: {
                id: record.id,
                key: data.key,
                amount: record.amount,
                transactions: data.transactions || [],
                tags: record.tags,
                createdAt: record.created_at,
                updatedAt: record.updated_at,
              },
            }),
          }],
        };
      } catch (error) {
        logger.error('Error getting balance:', error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    }
  );

  // List all balances for an app
  server.registerTool(
    'list_mini_app_balances',
    {
      description: 'List all balances for a mini-app. Useful for seeing who owes what.\n\nUser can be identified by ONE of: userId, email, phone, or platform + platformId',
      inputSchema: {
        ...userIdentifierFields,
        appName: z.string().describe('Mini-app name'),
        tags: z.array(z.string()).optional().describe('Filter by tags'),
      },
    },
    async (args) => {
      try {
        const resolved = await resolveUser(args as Parameters<typeof resolveUser>[0], dataComposer);
        if (!resolved) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'User not found' }) }],
            isError: true,
          };
        }

        const { appName, tags } = args as { appName: string; tags?: string[] };

        let query = supabase
          .from('mini_app_records')
          .select('*')
          .eq('user_id', resolved.user.id)
          .eq('app_name', appName)
          .eq('type', 'balance')
          .order('amount', { ascending: false });

        if (tags && tags.length > 0) {
          query = query.overlaps('tags', tags);
        }

        const { data: records, error } = await query;

        if (error) throw error;

        const balances = (records || []).map((r) => {
          const data = r.data as { key: string; transactions?: unknown[] };
          return {
            id: r.id,
            key: data.key,
            amount: r.amount,
            transactionCount: (data.transactions || []).length,
            tags: r.tags,
          };
        });

        // Calculate summary
        const total = balances.reduce((sum, b) => sum + (b.amount || 0), 0);
        const positive = balances.filter((b) => (b.amount || 0) > 0);
        const negative = balances.filter((b) => (b.amount || 0) < 0);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              count: balances.length,
              summary: {
                total,
                positiveCount: positive.length,
                negativeCount: negative.length,
              },
              balances,
            }),
          }],
        };
      } catch (error) {
        logger.error('Error listing balances:', error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    }
  );

  // Record a debt (who owes whom)
  server.registerTool(
    'record_mini_app_debt',
    {
      description: 'Record that one person owes another. Use this for group bill splits to track who owes whom.\n\nUser can be identified by ONE of: userId, email, phone, or platform + platformId',
      inputSchema: recordDebtSchema,
    },
    async (args) => {
      try {
        const resolved = await resolveUser(args as Parameters<typeof resolveUser>[0], dataComposer);
        if (!resolved) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'User not found' }) }],
            isError: true,
          };
        }

        const { appName, from, to, amount, description, recordedAt, tags } = args as {
          appName: string;
          from: string;
          to: string;
          amount: number;
          description?: string;
          recordedAt?: string;
          tags?: string[];
        };

        if (amount <= 0) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Amount must be positive' }) }],
            isError: true,
          };
        }

        if (from === to) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Cannot owe yourself' }) }],
            isError: true,
          };
        }

        const { data: record, error } = await supabase
          .from('mini_app_records')
          .insert({
            user_id: resolved.user.id,
            app_name: appName,
            type: 'debt',
            data: { from, to, description, settled: false },
            amount,
            text: `${from} owes ${to}`,
            tags: tags || [],
            recorded_at: recordedAt,
            metadata: {},
          })
          .select()
          .single();

        if (error) throw error;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              debt: {
                id: record.id,
                from,
                to,
                amount,
                description,
                createdAt: record.created_at,
              },
            }),
          }],
        };
      } catch (error) {
        logger.error('Error recording debt:', error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    }
  );

  // Get all debts with optional simplification
  server.registerTool(
    'get_mini_app_debts',
    {
      description: 'Get all debts showing who owes whom. Can filter by person or tags, and optionally simplify/consolidate debts.\n\nUser can be identified by ONE of: userId, email, phone, or platform + platformId',
      inputSchema: getDebtsSchema,
    },
    async (args) => {
      try {
        const resolved = await resolveUser(args as Parameters<typeof resolveUser>[0], dataComposer);
        if (!resolved) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'User not found' }) }],
            isError: true,
          };
        }

        const { appName, person, tags, simplify = true } = args as {
          appName: string;
          person?: string;
          tags?: string[];
          simplify?: boolean;
        };

        let query = supabase
          .from('mini_app_records')
          .select('*')
          .eq('user_id', resolved.user.id)
          .eq('app_name', appName)
          .eq('type', 'debt')
          .eq('data->>settled', 'false')
          .order('created_at', { ascending: false });

        if (tags && tags.length > 0) {
          query = query.overlaps('tags', tags);
        }

        const { data: records, error } = await query;

        if (error) throw error;

        // Map records to Debt objects
        const debts: Debt[] = (records || []).map((r) => {
          const data = r.data as { from: string; to: string; description?: string; settled: boolean };
          return {
            from: data.from,
            to: data.to,
            amount: r.amount || 0,
            description: data.description,
          };
        });

        // Build full debt objects with extra fields for response
        let fullDebts = (records || []).map((r) => {
          const data = r.data as { from: string; to: string; description?: string; settled: boolean };
          return {
            id: r.id,
            from: data.from,
            to: data.to,
            amount: r.amount || 0,
            description: data.description,
            tags: r.tags,
            createdAt: r.created_at,
          };
        });

        // Filter by person if specified
        const debtsToSimplify = person
          ? debts.filter((d) => d.from === person || d.to === person)
          : debts;

        if (person) {
          fullDebts = fullDebts.filter((d) => d.from === person || d.to === person);
        }

        // Use utility functions for simplification and summary
        const simplified = simplify && debtsToSimplify.length > 0
          ? simplifyDebts(debtsToSimplify)
          : [];

        const personSummary = person
          ? calculatePersonSummary(debtsToSimplify, person)
          : undefined;

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              count: fullDebts.length,
              debts: simplify ? undefined : fullDebts,
              simplified: simplify ? simplified : undefined,
              personSummary,
            }),
          }],
        };
      } catch (error) {
        logger.error('Error getting debts:', error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    }
  );

  // Settle a debt
  server.registerTool(
    'settle_mini_app_debt',
    {
      description: 'Mark a debt as settled/paid. Can settle by debt ID or by specifying the parties.\n\nUser can be identified by ONE of: userId, email, phone, or platform + platformId',
      inputSchema: {
        ...userIdentifierFields,
        appName: z.string().describe('Mini-app name'),
        debtId: z.string().uuid().optional().describe('Specific debt ID to settle'),
        from: z.string().optional().describe('Debtor name (used with "to" to find debt)'),
        to: z.string().optional().describe('Creditor name (used with "from" to find debt)'),
        amount: z.number().optional().describe('Specific amount to settle (partial settlement)'),
        settleAll: z.boolean().optional().describe('Settle all debts between from/to'),
      },
    },
    async (args) => {
      try {
        const resolved = await resolveUser(args as Parameters<typeof resolveUser>[0], dataComposer);
        if (!resolved) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'User not found' }) }],
            isError: true,
          };
        }

        const { appName, debtId, from, to, settleAll } = args as {
          appName: string;
          debtId?: string;
          from?: string;
          to?: string;
          amount?: number;
          settleAll?: boolean;
        };

        if (!debtId && (!from || !to)) {
          return {
            content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: 'Provide either debtId or both from and to' }) }],
            isError: true,
          };
        }

        let settledCount = 0;
        let settledAmount = 0;

        if (debtId) {
          // Settle specific debt
          const { data: debt, error: fetchError } = await supabase
            .from('mini_app_records')
            .select('*')
            .eq('id', debtId)
            .eq('user_id', resolved.user.id)
            .single();

          if (fetchError) throw fetchError;

          const { error } = await supabase
            .from('mini_app_records')
            .update({
              data: { ...(debt.data as object), settled: true, settledAt: new Date().toISOString() },
              updated_at: new Date().toISOString(),
            })
            .eq('id', debtId);

          if (error) throw error;
          settledCount = 1;
          settledAmount = debt.amount || 0;
        } else if (from && to) {
          // Settle debts between two people
          let query = supabase
            .from('mini_app_records')
            .select('*')
            .eq('user_id', resolved.user.id)
            .eq('app_name', appName)
            .eq('type', 'debt')
            .eq('data->>settled', 'false')
            .eq('data->>from', from)
            .eq('data->>to', to);

          if (!settleAll) {
            query = query.limit(1);
          }

          const { data: debts, error: fetchError } = await query;

          if (fetchError) throw fetchError;

          for (const debt of debts || []) {
            const { error } = await supabase
              .from('mini_app_records')
              .update({
                data: { ...(debt.data as object), settled: true, settledAt: new Date().toISOString() },
                updated_at: new Date().toISOString(),
              })
              .eq('id', debt.id);

            if (!error) {
              settledCount++;
              settledAmount += debt.amount || 0;
            }
          }
        }

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: true,
              settledCount,
              settledAmount: Math.round(settledAmount * 100) / 100,
            }),
          }],
        };
      } catch (error) {
        logger.error('Error settling debt:', error);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ success: false, error: String(error) }) }],
          isError: true,
        };
      }
    }
  );

  logger.info('Mini-app record tools registered');
}
