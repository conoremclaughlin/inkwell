/**
 * Calculate Split
 *
 * Deterministic calculation of how much each person owes.
 * Handles shared items, proportional tax/tip, and rounding.
 */

import type {
  BillItem,
  Assignments,
  CalculateSplitInput,
  SplitResult,
  PersonBreakdown,
} from './types';

/**
 * Round to 2 decimal places (currency)
 */
function roundCurrency(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Calculate the split for all assigned items
 */
export function calculateSplit(input: CalculateSplitInput): SplitResult {
  const {
    items,
    assignments: rawAssignments,
    tax = 0,
    tip,
    tipPercent,
    splitTaxTipEvenly = false,
  } = input;

  // Validate and normalize assignments
  // Handle case where AI might pass objects as keys or use item names instead of IDs
  const assignments: Assignments = {};
  for (const [key, people] of Object.entries(rawAssignments)) {
    // If key is "[object Object]", the AI passed an object instead of string ID
    if (key === '[object Object]') {
      throw new Error(
        'Invalid assignment: item objects were used as keys instead of item IDs. ' +
          'Use item.id (e.g., "item-1") as the key, not the item object itself.'
      );
    }

    // Validate people is an array of strings
    if (!Array.isArray(people)) {
      throw new Error(`Assignment for "${key}" must be an array of person names`);
    }

    // Try to match by ID first, then by name
    const matchedItem = items.find(
      (item) => item.id === key || item.name.toLowerCase() === key.toLowerCase()
    );

    if (matchedItem) {
      assignments[matchedItem.id] = people.map(String);
    } else {
      // Keep the key as-is and hope it matches
      assignments[key] = people.map(String);
    }
  }

  // Calculate actual tip amount
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const actualTip = tip ?? (tipPercent ? roundCurrency(subtotal * (tipPercent / 100)) : 0);
  const grandTotal = roundCurrency(subtotal + tax + actualTip);

  // Find all people involved
  const allPeople = new Set<string>();
  for (const people of Object.values(assignments)) {
    for (const person of people) {
      allPeople.add(person);
    }
  }

  // Track unassigned items
  const assignedItemIds = new Set(Object.keys(assignments));
  const unassignedItems = items.filter((item) => !assignedItemIds.has(item.id));

  // Initialize breakdown for each person
  const breakdown: { [name: string]: PersonBreakdown } = {};
  for (const person of allPeople) {
    breakdown[person] = {
      items: [],
      itemsSubtotal: 0,
      taxShare: 0,
      tipShare: 0,
      total: 0,
    };
  }

  // Assign items to people
  for (const item of items) {
    const itemAssignees = assignments[item.id];
    if (!itemAssignees || itemAssignees.length === 0) continue;

    const itemTotal = item.price * item.quantity;
    const shareCount = itemAssignees.length;
    const shareAmount = roundCurrency(itemTotal / shareCount);

    for (const person of itemAssignees) {
      breakdown[person].items.push({
        name: item.name + (item.quantity > 1 ? ` x${item.quantity}` : ''),
        price: shareAmount,
        shared: shareCount > 1,
        shareCount: shareCount > 1 ? shareCount : undefined,
      });
      breakdown[person].itemsSubtotal = roundCurrency(
        breakdown[person].itemsSubtotal + shareAmount
      );
    }
  }

  // Calculate tax and tip shares
  const peopleArray = Array.from(allPeople);
  const peopleCount = peopleArray.length;

  if (splitTaxTipEvenly && peopleCount > 0) {
    // Split tax and tip evenly
    const taxPerPerson = roundCurrency(tax / peopleCount);
    const tipPerPerson = roundCurrency(actualTip / peopleCount);

    for (const person of peopleArray) {
      breakdown[person].taxShare = taxPerPerson;
      breakdown[person].tipShare = tipPerPerson;
    }
  } else {
    // Split tax and tip proportionally based on what each person ordered
    const totalItemsAssigned = Object.values(breakdown).reduce(
      (sum, b) => sum + b.itemsSubtotal,
      0
    );

    if (totalItemsAssigned > 0) {
      for (const person of peopleArray) {
        const proportion = breakdown[person].itemsSubtotal / totalItemsAssigned;
        breakdown[person].taxShare = roundCurrency(tax * proportion);
        breakdown[person].tipShare = roundCurrency(actualTip * proportion);
      }
    }
  }

  // Calculate totals and handle rounding errors
  const totals: { [name: string]: number } = {};
  let runningTotal = 0;

  for (const person of peopleArray) {
    const personTotal = roundCurrency(
      breakdown[person].itemsSubtotal + breakdown[person].taxShare + breakdown[person].tipShare
    );
    breakdown[person].total = personTotal;
    totals[person] = personTotal;
    runningTotal += personTotal;
  }

  // Adjust for rounding errors (add/subtract from the highest payer)
  const roundingError = roundCurrency(grandTotal - runningTotal);
  if (roundingError !== 0 && peopleCount > 0) {
    // Find person with highest total
    const highestPayer = peopleArray.reduce((a, b) => (totals[a] > totals[b] ? a : b));
    totals[highestPayer] = roundCurrency(totals[highestPayer] + roundingError);
    breakdown[highestPayer].total = totals[highestPayer];
  }

  return {
    breakdown,
    totals,
    unassignedItems,
    summary: {
      subtotal: roundCurrency(subtotal),
      tax: roundCurrency(tax),
      tip: roundCurrency(actualTip),
      grandTotal,
    },
  };
}

/**
 * Quick split evenly among N people (no item tracking)
 */
export function splitEvenly(
  total: number,
  peopleCount: number,
  peopleNames?: string[]
): { [name: string]: number } {
  const perPerson = roundCurrency(total / peopleCount);
  const remainder = roundCurrency(total - perPerson * peopleCount);

  const names = peopleNames || Array.from({ length: peopleCount }, (_, i) => `Person ${i + 1}`);
  const result: { [name: string]: number } = {};

  for (let i = 0; i < names.length; i++) {
    // Give the remainder to the first person
    result[names[i]] = i === 0 ? roundCurrency(perPerson + remainder) : perPerson;
  }

  return result;
}

/**
 * Assign an item to people
 */
export function assignItem(
  assignments: Assignments,
  itemId: string,
  people: string[]
): Assignments {
  return {
    ...assignments,
    [itemId]: people,
  };
}

/**
 * Unassign an item
 */
export function unassignItem(assignments: Assignments, itemId: string): Assignments {
  const { [itemId]: _, ...rest } = assignments;
  return rest;
}

/**
 * Assign all unassigned items to everyone (split evenly)
 */
export function assignRemainingToAll(
  items: BillItem[],
  assignments: Assignments,
  allPeople: string[]
): Assignments {
  const result = { ...assignments };

  for (const item of items) {
    if (!result[item.id]) {
      result[item.id] = [...allPeople];
    }
  }

  return result;
}
