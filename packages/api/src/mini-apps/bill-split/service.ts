/**
 * Bill Split Service
 *
 * Handles transactional operations for bill splitting:
 * - Recording debts with atomic balance updates
 * - Contact resolution for name normalization
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '../../data/supabase/types.js';
import {
  ContactsRepository,
  type ResolveNameResult,
} from '../../data/repositories/contacts-repository.js';
import { logger } from '../../utils/logger.js';

export interface RecordDebtOptions {
  userId: string;
  from: string;
  to: string;
  amount: number;
  description?: string;
  recordedAt?: string;
  tags?: string[];
  resolveNames?: boolean;
}

export interface RecordDebtResult {
  success: boolean;
  debtId?: string;
  balanceId?: string;
  from: string;
  to: string;
  amount: number;
  previousBalance: number;
  newBalance: number;
  nameResolution?: {
    from: ResolveNameResult;
    to: ResolveNameResult;
  };
  error?: string;
}

export interface SettleUpOptions {
  userId: string;
  from: string;
  to: string;
  amount?: number; // If not provided, settles entire balance
  description?: string;
}

export interface SettleUpResult {
  success: boolean;
  paymentId?: string;
  previousBalance: number;
  newBalance: number;
  amountSettled: number;
  error?: string;
}

const APP_NAME = 'bill-split';

export class BillSplitService {
  private supabase: SupabaseClient<Database>;
  private contactsRepo: ContactsRepository;

  constructor(supabase: SupabaseClient<Database>) {
    this.supabase = supabase;
    this.contactsRepo = new ContactsRepository(supabase);
  }

  /**
   * Record a debt with atomic balance update.
   *
   * This performs both operations in sequence with error handling.
   * Note: Supabase JS client doesn't support true transactions,
   * so we use careful ordering and rollback on failure.
   */
  async recordDebt(options: RecordDebtOptions): Promise<RecordDebtResult> {
    const {
      userId,
      from,
      to,
      amount,
      description,
      recordedAt,
      tags,
      resolveNames = true,
    } = options;

    // Validate inputs
    if (amount <= 0) {
      return {
        success: false,
        from,
        to,
        amount,
        previousBalance: 0,
        newBalance: 0,
        error: 'Amount must be positive',
      };
    }

    if (from === to) {
      return {
        success: false,
        from,
        to,
        amount,
        previousBalance: 0,
        newBalance: 0,
        error: 'Cannot owe yourself',
      };
    }

    let resolvedFrom = from;
    let resolvedTo = to;
    let nameResolution: RecordDebtResult['nameResolution'];

    // Resolve names if requested
    if (resolveNames) {
      const [fromResult, toResult] = await Promise.all([
        this.contactsRepo.resolveName(userId, from),
        this.contactsRepo.resolveName(userId, to),
      ]);

      nameResolution = { from: fromResult, to: toResult };

      // Use canonical names if resolved
      if (fromResult.resolved && fromResult.canonicalName) {
        resolvedFrom = fromResult.canonicalName;
      }
      if (toResult.resolved && toResult.canonicalName) {
        resolvedTo = toResult.canonicalName;
      }
    }

    const balanceKey = `${resolvedFrom}:${resolvedTo}`;

    try {
      // Step 1: Insert debt record
      const { data: debtRecord, error: debtError } = await this.supabase
        .from('mini_app_records')
        .insert({
          user_id: userId,
          app_name: APP_NAME,
          type: 'debt',
          data: {
            from: resolvedFrom,
            to: resolvedTo,
            description,
          } as Json,
          amount,
          text: `${resolvedFrom} owes ${resolvedTo}`,
          tags: tags || [],
          recorded_at: recordedAt,
          metadata: {} as Json,
        })
        .select()
        .single();

      if (debtError) {
        throw new Error(`Failed to insert debt: ${debtError.message}`);
      }

      // Step 2: Get or create balance record
      const { data: existingBalance } = await this.supabase
        .from('mini_app_records')
        .select('*')
        .eq('user_id', userId)
        .eq('app_name', APP_NAME)
        .eq('type', 'balance')
        .eq('text', balanceKey)
        .single();

      const previousBalance = existingBalance?.amount || 0;
      const newBalance = previousBalance + amount;

      let balanceId: string;

      if (existingBalance) {
        // Update existing balance
        const transactions =
          (existingBalance.data as { transactions?: unknown[] })?.transactions || [];
        transactions.push({
          delta: amount,
          description,
          recordedAt: recordedAt || new Date().toISOString(),
          balanceAfter: newBalance,
          debtId: debtRecord.id,
        });

        const { data: updatedBalance, error: updateError } = await this.supabase
          .from('mini_app_records')
          .update({
            amount: newBalance,
            data: { key: balanceKey, from: resolvedFrom, to: resolvedTo, transactions } as Json,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingBalance.id)
          .select()
          .single();

        if (updateError) {
          // Rollback: delete the debt record
          await this.supabase.from('mini_app_records').delete().eq('id', debtRecord.id);
          throw new Error(`Failed to update balance: ${updateError.message}`);
        }

        balanceId = updatedBalance.id;
      } else {
        // Create new balance record
        const { data: newBalanceRecord, error: createError } = await this.supabase
          .from('mini_app_records')
          .insert({
            user_id: userId,
            app_name: APP_NAME,
            type: 'balance',
            data: {
              key: balanceKey,
              from: resolvedFrom,
              to: resolvedTo,
              transactions: [
                {
                  delta: amount,
                  description,
                  recordedAt: recordedAt || new Date().toISOString(),
                  balanceAfter: newBalance,
                  debtId: debtRecord.id,
                },
              ],
            } as Json,
            amount: newBalance,
            text: balanceKey,
            tags: tags || [],
            recorded_at: recordedAt,
            metadata: {} as Json,
          })
          .select()
          .single();

        if (createError) {
          // Rollback: delete the debt record
          await this.supabase.from('mini_app_records').delete().eq('id', debtRecord.id);
          throw new Error(`Failed to create balance: ${createError.message}`);
        }

        balanceId = newBalanceRecord.id;
      }

      return {
        success: true,
        debtId: debtRecord.id,
        balanceId,
        from: resolvedFrom,
        to: resolvedTo,
        amount,
        previousBalance,
        newBalance,
        nameResolution,
      };
    } catch (error) {
      logger.error('Error recording debt:', error);
      return {
        success: false,
        from: resolvedFrom,
        to: resolvedTo,
        amount,
        previousBalance: 0,
        newBalance: 0,
        nameResolution,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Settle up (record a payment) with atomic balance update.
   *
   * A payment is recorded as a negative debt.
   */
  async settleUp(options: SettleUpOptions): Promise<SettleUpResult> {
    const { userId, from, to, amount, description = 'Payment' } = options;

    // Get current balance
    const balanceKey = `${from}:${to}`;
    const { data: existingBalance } = await this.supabase
      .from('mini_app_records')
      .select('*')
      .eq('user_id', userId)
      .eq('app_name', APP_NAME)
      .eq('type', 'balance')
      .eq('text', balanceKey)
      .single();

    const previousBalance = existingBalance?.amount || 0;

    if (previousBalance <= 0) {
      return {
        success: false,
        previousBalance,
        newBalance: previousBalance,
        amountSettled: 0,
        error: 'No outstanding balance to settle',
      };
    }

    // Determine amount to settle
    const amountToSettle =
      amount !== undefined ? Math.min(amount, previousBalance) : previousBalance;
    const newBalance = previousBalance - amountToSettle;

    try {
      // Step 1: Record payment as negative debt
      const { data: paymentRecord, error: paymentError } = await this.supabase
        .from('mini_app_records')
        .insert({
          user_id: userId,
          app_name: APP_NAME,
          type: 'debt',
          data: {
            from,
            to,
            description,
            isPayment: true,
          } as Json,
          amount: -amountToSettle, // Negative to indicate payment
          text: `${from} paid ${to}`,
          tags: ['payment'],
          metadata: {} as Json,
        })
        .select()
        .single();

      if (paymentError) {
        throw new Error(`Failed to record payment: ${paymentError.message}`);
      }

      // Step 2: Update balance
      if (existingBalance) {
        const transactions =
          (existingBalance.data as { transactions?: unknown[] })?.transactions || [];
        transactions.push({
          delta: -amountToSettle,
          description,
          recordedAt: new Date().toISOString(),
          balanceAfter: newBalance,
          debtId: paymentRecord.id,
          isPayment: true,
        });

        const { error: updateError } = await this.supabase
          .from('mini_app_records')
          .update({
            amount: newBalance,
            data: { ...(existingBalance.data as object), transactions } as Json,
            updated_at: new Date().toISOString(),
          })
          .eq('id', existingBalance.id);

        if (updateError) {
          // Rollback: delete the payment record
          await this.supabase.from('mini_app_records').delete().eq('id', paymentRecord.id);
          throw new Error(`Failed to update balance: ${updateError.message}`);
        }
      }

      return {
        success: true,
        paymentId: paymentRecord.id,
        previousBalance,
        newBalance,
        amountSettled: amountToSettle,
      };
    } catch (error) {
      logger.error('Error settling up:', error);
      return {
        success: false,
        previousBalance,
        newBalance: previousBalance,
        amountSettled: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get all balances for a user
   */
  async getBalances(userId: string): Promise<
    Array<{
      key: string;
      from: string;
      to: string;
      amount: number;
      transactionCount: number;
    }>
  > {
    const { data, error } = await this.supabase
      .from('mini_app_records')
      .select('*')
      .eq('user_id', userId)
      .eq('app_name', APP_NAME)
      .eq('type', 'balance')
      .order('amount', { ascending: false });

    if (error) {
      logger.error('Error fetching balances:', error);
      return [];
    }

    return (data || []).map((record) => {
      const recordData = record.data as {
        key?: string;
        from?: string;
        to?: string;
        transactions?: unknown[];
      };
      return {
        key: recordData.key || record.text || '',
        from: recordData.from || '',
        to: recordData.to || '',
        amount: record.amount || 0,
        transactionCount: (recordData.transactions || []).length,
      };
    });
  }

  /**
   * Recalculate a balance from debt records (for data integrity checks)
   */
  async recalculateBalance(userId: string, from: string, to: string): Promise<number> {
    const { data, error } = await this.supabase
      .from('mini_app_records')
      .select('amount')
      .eq('user_id', userId)
      .eq('app_name', APP_NAME)
      .eq('type', 'debt')
      .eq('data->>from', from)
      .eq('data->>to', to);

    if (error) {
      logger.error('Error recalculating balance:', error);
      return 0;
    }

    return (data || []).reduce((sum, record) => sum + (record.amount || 0), 0);
  }
}
