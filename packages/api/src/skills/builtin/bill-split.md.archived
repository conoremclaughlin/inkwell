---
name: bill-split
version: "1.0.0"
displayName: Bill Split
description: Split bills and expenses among friends with receipt parsing and debt tracking
type: mini-app
emoji: "\U0001F4B8"
category: finance
tags:
  - bills
  - expenses
  - splitting
  - receipts
  - money
author: PCP Team

triggers:
  keywords:
    - split
    - bill
    - expense
    - receipt
    - owe
    - debt
    - venmo
    - pay
  intents:
    - split_bill
    - parse_receipt
    - track_debt

capabilities:
  vision: true
  memory: true
  network: false
  filesystem: false

functions:
  - name: parseReceipt
    description: Parse a receipt image to extract items and prices
    input:
      imageUrl: string
    output:
      items: array
      total: number
      tax: number?
      tip: number?

  - name: splitEvenly
    description: Split a total amount evenly among people
    input:
      total: number
      people: array
      includeTip: boolean?
      tipPercent: number?
    output:
      perPerson: number
      breakdown: object

  - name: calculateSplit
    description: Calculate custom split based on item assignments
    input:
      items: array
      assignments: object
      tax: number?
      tip: number?
    output:
      perPerson: object
      total: number

  - name: formatSummary
    description: Format a bill split summary for sharing
    input:
      split: object
      venmoHandles: object?
    output:
      summary: string
      venmoLinks: object?
---

# Bill Split

A mini-app for splitting bills and tracking expenses among friends.

## Usage

### Parsing Receipts

When the user shares a receipt image:
1. Use `parseReceipt` to extract items and prices
2. Confirm the parsed items with the user
3. Ask who was at the meal/event

### Simple Split

For even splits:
1. Get the total amount
2. Get the list of people
3. Use `splitEvenly` to calculate

### Custom Split

For itemized splits:
1. Parse or manually enter items
2. Assign items to people
3. Use `calculateSplit` with assignments
4. Share using `formatSummary`

## Example Conversation

User: "Split this receipt between me, Alice, and Bob"
*shares receipt image*

1. Parse the receipt with vision
2. Show items and ask for assignments
3. Calculate the split
4. Format and share the summary

## Debt Tracking

Bill split results can be saved to memory for tracking who owes what.
Use the `remember` tool to save debts and `recall` to check balances.
