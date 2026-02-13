/**
 * Parse Receipt
 *
 * Extracts items and prices from receipt text or image descriptions.
 * Uses pattern matching for common receipt formats.
 */

import type { BillItem, ParsedReceipt } from './types';

// Common price patterns
const PRICE_PATTERNS = [
  // $12.50, $12, 12.50
  /\$?\s*(\d+(?:\.\d{2})?)/,
  // 12.50 USD
  /(\d+(?:\.\d{2})?)\s*(?:USD|usd)/,
];

// Quantity patterns
const QUANTITY_PATTERNS = [
  // x2, x 2, × 2
  /[x×]\s*(\d+)/i,
  // 2x, 2 x
  /(\d+)\s*[x×]/i,
  // qty: 2, qty 2
  /qty[:\s]*(\d+)/i,
];

interface ParsedLine {
  name: string;
  price: number;
  quantity: number;
}

/**
 * Parse a single line from a receipt
 */
function parseLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 3) return null;

  // Skip common non-item lines
  const skipPatterns = [
    /^(subtotal|sub-total|sub total)/i,
    /^(total|grand total)/i,
    /^(tax|sales tax|vat)/i,
    /^(tip|gratuity|service)/i,
    /^(cash|credit|debit|visa|mastercard|amex)/i,
    /^(thank you|thanks)/i,
    /^(receipt|order|check)/i,
    /^\d{1,2}[\/\-]\d{1,2}/, // Dates
    /^\d{10,}/, // Long numbers (phone, card numbers)
  ];

  for (const pattern of skipPatterns) {
    if (pattern.test(trimmed)) return null;
  }

  // Extract quantity first (before price, to handle "Beer x2 $16")
  let quantity = 1;
  let lineWithoutQty = trimmed;

  for (const pattern of QUANTITY_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      quantity = parseInt(match[1], 10);
      lineWithoutQty = trimmed.replace(pattern, '').trim();
      break;
    }
  }

  // Extract price
  let price: number | null = null;
  let lineWithoutPrice = lineWithoutQty;

  for (const pattern of PRICE_PATTERNS) {
    const match = lineWithoutQty.match(pattern);
    if (match) {
      price = parseFloat(match[1]);
      // Remove price from line to get item name
      lineWithoutPrice = lineWithoutQty.replace(pattern, '').trim();
      break;
    }
  }

  if (price === null || price <= 0) return null;

  // Clean up the item name
  let name = lineWithoutPrice
    .replace(/[^\w\s\-'&]/g, ' ') // Remove special chars except common ones
    .replace(/\s+/g, ' ') // Normalize whitespace
    .trim();

  // Skip if name is too short or looks like a number
  if (name.length < 2 || /^\d+$/.test(name)) return null;

  // Capitalize first letter of each word
  name = name.replace(/\b\w/g, (c) => c.toUpperCase());

  return { name, price, quantity };
}

/**
 * Extract subtotal, tax, tip, total from text
 */
function extractTotals(text: string): {
  subtotal?: number;
  tax?: number;
  tip?: number;
  total?: number;
} {
  const result: { subtotal?: number; tax?: number; tip?: number; total?: number } = {};
  const lowerText = text.toLowerCase();

  // Look for patterns like "subtotal is $34.00" or "Subtotal: $34.00" or "tax of $2.72"
  const patterns = [
    { key: 'subtotal' as const, pattern: /sub\s*-?\s*total[^\d$]*\$?\s*(\d+(?:\.\d{2})?)/gi },
    { key: 'tax' as const, pattern: /(?:tax|sales\s*tax|vat)[^\d$]*\$?\s*(\d+(?:\.\d{2})?)/gi },
    { key: 'tip' as const, pattern: /(?:tip|gratuity|service)[^\d$]*\$?\s*(\d+(?:\.\d{2})?)/gi },
    { key: 'total' as const, pattern: /(?:^|\s)total[^\d$]*\$?\s*(\d+(?:\.\d{2})?)/gim },
  ];

  for (const { key, pattern } of patterns) {
    const match = pattern.exec(lowerText);
    if (match && !result[key]) {
      result[key] = parseFloat(match[1]);
    }
  }

  return result;
}

/**
 * Generate a unique ID for an item
 */
function generateId(): string {
  return `item-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Parse receipt text or image description into structured data
 */
export function parseReceipt(input: { text?: string; imageDescription?: string }): ParsedReceipt {
  const text = input.text || input.imageDescription || '';
  const lines = text.split('\n');
  const items: BillItem[] = [];

  for (const line of lines) {
    const parsed = parseLine(line);
    if (parsed) {
      items.push({
        id: generateId(),
        name: parsed.name,
        price: parsed.price,
        quantity: parsed.quantity,
      });
    }
  }

  const totals = extractTotals(text);

  // If we have items but no subtotal, calculate it
  if (items.length > 0 && !totals.subtotal) {
    totals.subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  }

  return {
    items,
    ...totals,
  };
}

/**
 * Add an item manually
 */
export function addItem(name: string, price: number, quantity = 1): BillItem {
  return {
    id: generateId(),
    name,
    price,
    quantity,
  };
}

/**
 * Update an existing item
 */
export function updateItem(
  items: BillItem[],
  itemId: string,
  updates: Partial<Omit<BillItem, 'id'>>
): BillItem[] {
  return items.map((item) => (item.id === itemId ? { ...item, ...updates } : item));
}

/**
 * Remove an item
 */
export function removeItem(items: BillItem[], itemId: string): BillItem[] {
  return items.filter((item) => item.id !== itemId);
}
