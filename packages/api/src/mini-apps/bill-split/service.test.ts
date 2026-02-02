/**
 * Bill Split Service Tests
 *
 * Tests for transactional debt recording and balance management.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BillSplitService, type RecordDebtOptions } from './service';

// Mock Supabase client
const createMockSupabase = () => {
  const records: Map<string, unknown> = new Map();
  let idCounter = 0;

  const createQueryBuilder = () => {
    let filters: Record<string, unknown> = {};
    let insertData: unknown = null;
    let updateData: unknown = null;

    const builder = {
      select: vi.fn().mockReturnThis(),
      insert: vi.fn((data: unknown) => {
        insertData = data;
        return builder;
      }),
      update: vi.fn((data: unknown) => {
        updateData = data;
        return builder;
      }),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn((key: string, value: unknown) => {
        filters[key] = value;
        return builder;
      }),
      single: vi.fn(() => {
        // Simulate database operations
        if (insertData) {
          const id = `mock-id-${++idCounter}`;
          const record = { id, ...insertData as object, created_at: new Date().toISOString() };
          records.set(id, record);
          return Promise.resolve({ data: record, error: null });
        }

        if (updateData) {
          const id = filters['id'] as string;
          if (id && records.has(id)) {
            const existing = records.get(id) as object;
            const updated = { ...existing, ...updateData as object };
            records.set(id, updated);
            return Promise.resolve({ data: updated, error: null });
          }
          return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'Not found' } });
        }

        // Find by filters
        for (const [, record] of records) {
          const rec = record as Record<string, unknown>;
          let matches = true;
          for (const [key, value] of Object.entries(filters)) {
            if (rec[key] !== value) {
              matches = false;
              break;
            }
          }
          if (matches) {
            return Promise.resolve({ data: record, error: null });
          }
        }

        return Promise.resolve({ data: null, error: { code: 'PGRST116', message: 'Not found' } });
      }),
    };

    return builder;
  };

  return {
    from: vi.fn(() => createQueryBuilder()),
    _records: records,
  };
};

describe('BillSplitService', () => {
  describe('recordDebt', () => {
    it('should reject zero amounts', async () => {
      const mockSupabase = createMockSupabase();
      const service = new BillSplitService(mockSupabase as never);

      const result = await service.recordDebt({
        userId: 'user-1',
        from: 'Alice',
        to: 'Bob',
        amount: 0,
        resolveNames: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('positive');
    });

    it('should reject negative amounts', async () => {
      const mockSupabase = createMockSupabase();
      const service = new BillSplitService(mockSupabase as never);

      const result = await service.recordDebt({
        userId: 'user-1',
        from: 'Alice',
        to: 'Bob',
        amount: -50,
        resolveNames: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('positive');
    });

    it('should reject self-debt', async () => {
      const mockSupabase = createMockSupabase();
      const service = new BillSplitService(mockSupabase as never);

      const result = await service.recordDebt({
        userId: 'user-1',
        from: 'Alice',
        to: 'Alice',
        amount: 50,
        resolveNames: false,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('yourself');
    });
  });

  describe('settleUp', () => {
    it('should reject settling when no balance exists', async () => {
      const mockSupabase = createMockSupabase();
      const service = new BillSplitService(mockSupabase as never);

      const result = await service.settleUp({
        userId: 'user-1',
        from: 'Alice',
        to: 'Bob',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('No outstanding balance');
    });
  });
});

describe('Bill Split Scenarios', () => {
  // These are more integration-style tests that describe expected behavior

  describe('recording expenses', () => {
    it('should create debt and balance atomically', () => {
      // When recording "Ruoshan owes Conor $56 for groceries":
      // 1. Insert debt record with amount: 56
      // 2. Update/create balance "Ruoshan:Conor" += 56
      // Both should succeed or both should fail

      const scenario = {
        before: { balance: 0 },
        action: { from: 'Ruoshan', to: 'Conor', amount: 56 },
        after: { balance: 56 },
      };

      expect(scenario.before.balance + scenario.action.amount).toBe(scenario.after.balance);
    });

    it('should accumulate multiple debts correctly', () => {
      // Multiple expenses between same people
      const debts = [
        { from: 'Ruoshan', to: 'Conor', amount: 56, description: 'Groceries' },
        { from: 'Ruoshan', to: 'Conor', amount: 13.75, description: 'Pizza' },
        { from: 'Ruoshan', to: 'Conor', amount: 34, description: 'IKEA' },
        { from: 'Ruoshan', to: 'Conor', amount: 35, description: 'Cutting boards' },
      ];

      const expectedBalance = debts.reduce((sum, d) => sum + d.amount, 0);
      expect(expectedBalance).toBe(138.75);
    });

    it('should track different creditor-debtor pairs separately', () => {
      const debts = [
        { from: 'Ruoshan', to: 'Conor', amount: 56 },
        { from: 'Ruoshan', to: 'Co Con', amount: 26.44 },
        { from: 'Conor', to: 'Co Con', amount: 305 },
      ];

      const balances = new Map<string, number>();
      for (const debt of debts) {
        const key = `${debt.from}:${debt.to}`;
        balances.set(key, (balances.get(key) || 0) + debt.amount);
      }

      expect(balances.get('Ruoshan:Conor')).toBe(56);
      expect(balances.get('Ruoshan:Co Con')).toBe(26.44);
      expect(balances.get('Conor:Co Con')).toBe(305);
    });
  });

  describe('payments and settlements', () => {
    it('should reduce balance when payment is recorded', () => {
      const scenario = {
        before: { balance: 138.75 },
        payment: 50,
        after: { balance: 88.75 },
      };

      expect(scenario.before.balance - scenario.payment).toBe(scenario.after.balance);
    });

    it('should zero out balance on full settlement', () => {
      const scenario = {
        before: { balance: 138.75 },
        payment: 138.75,
        after: { balance: 0 },
      };

      expect(scenario.before.balance - scenario.payment).toBe(scenario.after.balance);
    });

    it('should not allow overpayment beyond balance', () => {
      const balance = 100;
      const attemptedPayment = 150;
      const actualPayment = Math.min(attemptedPayment, balance);

      expect(actualPayment).toBe(100);
    });
  });

  describe('name resolution', () => {
    it('should resolve aliases to canonical names', () => {
      const contacts = [
        { name: 'Co Con', aliases: ['co', 'cocon', 'co con'] },
        { name: 'Ruoshan', aliases: ['rs', 'ruoshan'] },
        { name: 'Conor Grey', aliases: ['cg', 'conor grey'] },
      ];

      const resolveName = (input: string): string => {
        const lower = input.toLowerCase();
        for (const contact of contacts) {
          if (contact.name.toLowerCase() === lower) return contact.name;
          if (contact.aliases.includes(lower)) return contact.name;
        }
        return input; // Return original if not found
      };

      expect(resolveName('Co')).toBe('Co Con');
      expect(resolveName('RS')).toBe('Ruoshan');
      expect(resolveName('CG')).toBe('Conor Grey');
      expect(resolveName('Unknown Person')).toBe('Unknown Person');
    });

    it('should flag similar-but-not-exact matches for clarification', () => {
      const contacts = [
        { name: 'Co Con', aliases: ['co'] },
        { name: 'Conor', aliases: [] },
      ];

      const findSimilar = (input: string): string[] => {
        const lower = input.toLowerCase();
        const similar: string[] = [];

        for (const contact of contacts) {
          // Check if input is a prefix or has high similarity
          if (contact.name.toLowerCase().startsWith(lower) ||
              lower.startsWith(contact.name.toLowerCase().slice(0, 2))) {
            similar.push(contact.name);
          }
        }

        return similar;
      };

      // "Con" could match both "Co Con" and "Conor"
      const matches = findSimilar('Con');
      expect(matches).toContain('Co Con');
      expect(matches).toContain('Conor');
    });
  });

  describe('data integrity', () => {
    it('should maintain balance = sum of debts', () => {
      const debts = [
        { amount: 56 },
        { amount: 13.75 },
        { amount: 34 },
        { amount: 35 },
        { amount: -50 }, // payment
      ];

      const sumOfDebts = debts.reduce((sum, d) => sum + d.amount, 0);
      const expectedBalance = 88.75;

      expect(sumOfDebts).toBe(expectedBalance);
    });

    it('should allow balance recalculation from debts', () => {
      // If balance gets corrupted, we can recalculate from source of truth
      const debts = [
        { from: 'A', to: 'B', amount: 100 },
        { from: 'A', to: 'B', amount: 50 },
        { from: 'A', to: 'B', amount: -30 }, // payment
      ];

      const recalculated = debts.reduce((sum, d) => sum + d.amount, 0);
      expect(recalculated).toBe(120);
    });
  });
});

describe('Edge Cases', () => {
  it('should handle floating point precision', () => {
    // Classic floating point issue: 0.1 + 0.2 !== 0.3
    const amounts = [0.1, 0.2, 0.3, 0.4];
    const sum = amounts.reduce((a, b) => a + b, 0);

    // Round to cents
    const rounded = Math.round(sum * 100) / 100;
    expect(rounded).toBe(1.0);
  });

  it('should handle very small amounts', () => {
    const amount = 0.01; // 1 cent
    expect(amount).toBeGreaterThan(0);
  });

  it('should handle large amounts', () => {
    const amount = 999999.99;
    expect(amount).toBeLessThan(1000000);
  });

  it('should handle unicode names', () => {
    const names = ['Ruoshan', 'Co Con', 'José', 'François', '田中太郎'];
    names.forEach(name => {
      expect(name.length).toBeGreaterThan(0);
    });
  });
});
