/**
 * Bill Split Function Tests
 */

import { describe, it, expect } from 'vitest';
import {
  parseReceipt,
  addItem,
  calculateSplit,
  splitEvenly,
  assignItem,
  formatSummary,
  formatQuickSummary,
  type BillItem,
  type Assignments,
} from './index';

describe('parseReceipt', () => {
  it('should parse simple receipt text', () => {
    const text = `
      Burger $14.50
      Fries $5.00
      Beer x2 $16.00
    `;

    const result = parseReceipt({ text });

    expect(result.items).toHaveLength(3);
    expect(result.items[0].name).toBe('Burger');
    expect(result.items[0].price).toBe(14.5);
    expect(result.items[1].name).toBe('Fries');
    expect(result.items[1].price).toBe(5.0);
    expect(result.items[2].name).toBe('Beer');
    expect(result.items[2].price).toBe(16.0);
    expect(result.items[2].quantity).toBe(2);
  });

  it('should extract totals from receipt', () => {
    const text = `
      Burger $14.50
      Fries $5.00
      Subtotal: $19.50
      Tax: $1.56
      Total: $21.06
    `;

    const result = parseReceipt({ text });

    expect(result.subtotal).toBe(19.5);
    expect(result.tax).toBe(1.56);
    expect(result.total).toBe(21.06);
  });

  it('should skip non-item lines', () => {
    const text = `
      Thank you for dining with us!
      Order #12345
      01/26/2026

      Burger $14.50

      Subtotal: $14.50
      Visa ****1234
    `;

    const result = parseReceipt({ text });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].name).toBe('Burger');
  });

  it('should handle image descriptions', () => {
    const imageDescription = `
      I see a receipt showing:
      - Margherita Pizza: $18.00
      - Caesar Salad: $12.00
      - Sparkling Water: $4.00
      The subtotal is $34.00 with tax of $2.72
    `;

    const result = parseReceipt({ imageDescription });

    expect(result.items.length).toBeGreaterThan(0);
    expect(result.tax).toBe(2.72);
  });
});

describe('addItem', () => {
  it('should create an item with ID', () => {
    const item = addItem('Burger', 14.5);

    expect(item.id).toBeDefined();
    expect(item.name).toBe('Burger');
    expect(item.price).toBe(14.5);
    expect(item.quantity).toBe(1);
  });

  it('should support quantity', () => {
    const item = addItem('Beer', 8.0, 2);

    expect(item.quantity).toBe(2);
  });
});

describe('calculateSplit', () => {
  const items: BillItem[] = [
    { id: 'item-1', name: 'Burger', price: 15.0, quantity: 1 },
    { id: 'item-2', name: 'Salad', price: 12.0, quantity: 1 },
    { id: 'item-3', name: 'Fries', price: 6.0, quantity: 1 },
  ];

  it('should calculate split for individual items', () => {
    const assignments: Assignments = {
      'item-1': ['John'],
      'item-2': ['Sarah'],
      'item-3': ['Mike'],
    };

    const result = calculateSplit({ items, assignments });

    expect(result.totals['John']).toBe(15.0);
    expect(result.totals['Sarah']).toBe(12.0);
    expect(result.totals['Mike']).toBe(6.0);
    expect(result.summary.subtotal).toBe(33.0);
  });

  it('should accept item names as assignment keys', () => {
    // AI might use item names instead of IDs
    const assignments: Assignments = {
      Burger: ['John'],
      salad: ['Sarah'], // lowercase should work
      Fries: ['Mike'],
    };

    const result = calculateSplit({ items, assignments });

    expect(result.totals['John']).toBe(15.0);
    expect(result.totals['Sarah']).toBe(12.0);
    expect(result.totals['Mike']).toBe(6.0);
  });

  it('should throw clear error for object keys', () => {
    const assignments = {
      '[object Object]': ['John'],
    };

    expect(() => calculateSplit({ items, assignments })).toThrow(
      /item objects were used as keys instead of item IDs/
    );
  });

  it('should split shared items evenly', () => {
    const assignments: Assignments = {
      'item-1': ['John'],
      'item-2': ['Sarah'],
      'item-3': ['John', 'Sarah', 'Mike'], // Shared 3 ways
    };

    const result = calculateSplit({ items, assignments });

    // Fries split 3 ways: $6 / 3 = $2 each
    expect(result.totals['John']).toBe(17.0); // Burger + Fries share
    expect(result.totals['Sarah']).toBe(14.0); // Salad + Fries share
    expect(result.totals['Mike']).toBe(2.0); // Fries share only
  });

  it('should split tax proportionally', () => {
    const assignments: Assignments = {
      'item-1': ['John'], // $15
      'item-2': ['Sarah'], // $12
    };

    const result = calculateSplit({
      items: items.slice(0, 2), // Just burger and salad
      assignments,
      tax: 2.7, // $2.70 tax
    });

    // John: 15/27 * 2.7 = 1.50, Sarah: 12/27 * 2.7 = 1.20
    expect(result.totals['John']).toBe(16.5);
    expect(result.totals['Sarah']).toBe(13.2);
    expect(result.summary.grandTotal).toBe(29.7);
  });

  it('should split tax evenly when requested', () => {
    const assignments: Assignments = {
      'item-1': ['John'],
      'item-2': ['Sarah'],
    };

    const result = calculateSplit({
      items: items.slice(0, 2),
      assignments,
      tax: 2.0,
      splitTaxTipEvenly: true,
    });

    // Each gets $1 of tax
    expect(result.totals['John']).toBe(16.0);
    expect(result.totals['Sarah']).toBe(13.0);
  });

  it('should calculate tip from percentage', () => {
    const assignments: Assignments = {
      'item-1': ['John'],
    };

    const result = calculateSplit({
      items: [items[0]], // Just burger $15
      assignments,
      tipPercent: 20, // 20% tip
    });

    expect(result.summary.tip).toBe(3.0); // 20% of $15
    expect(result.totals['John']).toBe(18.0);
  });

  it('should track unassigned items', () => {
    const assignments: Assignments = {
      'item-1': ['John'],
      // item-2 and item-3 unassigned
    };

    const result = calculateSplit({ items, assignments });

    expect(result.unassignedItems).toHaveLength(2);
    expect(result.unassignedItems[0].name).toBe('Salad');
    expect(result.unassignedItems[1].name).toBe('Fries');
  });

  it('should handle rounding correctly', () => {
    const trickyItems: BillItem[] = [{ id: 'item-1', name: 'Item', price: 10.0, quantity: 1 }];

    const assignments: Assignments = {
      'item-1': ['A', 'B', 'C'], // Split 3 ways: $3.33 each
    };

    const result = calculateSplit({
      items: trickyItems,
      assignments,
      tax: 0.01, // Tiny tax to trigger rounding
    });

    // Total should still equal input
    const sumOfTotals = Object.values(result.totals).reduce((a, b) => a + b, 0);
    expect(sumOfTotals).toBeCloseTo(10.01, 2);
  });
});

describe('splitEvenly', () => {
  it('should split total evenly', () => {
    const result = splitEvenly(30, 3, ['John', 'Sarah', 'Mike']);

    expect(result['John']).toBe(10);
    expect(result['Sarah']).toBe(10);
    expect(result['Mike']).toBe(10);
  });

  it('should handle uneven splits', () => {
    const result = splitEvenly(10, 3, ['A', 'B', 'C']);

    // 10 / 3 = 3.33, with $0.01 remainder
    const total = Object.values(result).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(10, 2);
  });

  it('should generate names if not provided', () => {
    const result = splitEvenly(20, 2);

    expect(Object.keys(result)).toContain('Person 1');
    expect(Object.keys(result)).toContain('Person 2');
  });
});

describe('assignItem', () => {
  it('should add assignment', () => {
    const assignments: Assignments = {};
    const updated = assignItem(assignments, 'item-1', ['John', 'Sarah']);

    expect(updated['item-1']).toEqual(['John', 'Sarah']);
  });

  it('should replace existing assignment', () => {
    const assignments: Assignments = { 'item-1': ['John'] };
    const updated = assignItem(assignments, 'item-1', ['Sarah']);

    expect(updated['item-1']).toEqual(['Sarah']);
  });
});

describe('formatSummary', () => {
  it('should format split results', () => {
    const result = calculateSplit({
      items: [
        { id: 'item-1', name: 'Burger', price: 15.0, quantity: 1 },
        { id: 'item-2', name: 'Salad', price: 12.0, quantity: 1 },
      ],
      assignments: {
        'item-1': ['John'],
        'item-2': ['Sarah'],
      },
      tax: 2.16,
    });

    const summary = formatSummary({ result });

    expect(summary).toContain("Here's the split:");
    expect(summary).toContain('John');
    expect(summary).toContain('Sarah');
    expect(summary).toContain('Burger');
    expect(summary).toContain('Salad');
    expect(summary).toContain('$');
  });

  it('should indicate shared items', () => {
    const result = calculateSplit({
      items: [{ id: 'item-1', name: 'Appetizer', price: 12.0, quantity: 1 }],
      assignments: { 'item-1': ['John', 'Sarah'] },
    });

    const summary = formatSummary({ result });

    expect(summary).toContain('split');
  });
});

describe('formatQuickSummary', () => {
  it('should format totals only', () => {
    const totals = { John: 15.0, Sarah: 12.0 };
    const summary = formatQuickSummary(totals);

    expect(summary).toContain('Quick split');
    expect(summary).toContain('John: $15.00');
    expect(summary).toContain('Sarah: $12.00');
    expect(summary).toContain('Total: $27.00');
  });
});
