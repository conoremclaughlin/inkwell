/**
 * Contacts Repository Tests
 *
 * Tests for contact management and name resolution.
 */

import { describe, it, expect } from 'vitest';
import { calculateSimilarity, levenshteinDistance } from './contacts-repository';

describe('levenshteinDistance', () => {
  it('should return 0 for identical strings', () => {
    expect(levenshteinDistance('hello', 'hello')).toBe(0);
  });

  it('should return length of one string when other is empty', () => {
    expect(levenshteinDistance('hello', '')).toBe(5);
    expect(levenshteinDistance('', 'world')).toBe(5);
  });

  it('should return correct distance for single character changes', () => {
    expect(levenshteinDistance('cat', 'bat')).toBe(1);
    expect(levenshteinDistance('cat', 'car')).toBe(1);
    expect(levenshteinDistance('cat', 'cats')).toBe(1);
  });

  it('should return correct distance for multiple changes', () => {
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
    expect(levenshteinDistance('saturday', 'sunday')).toBe(3);
  });
});

describe('calculateSimilarity', () => {
  it('should return 1 for identical strings', () => {
    expect(calculateSimilarity('Alex', 'Alex')).toBe(1);
  });

  it('should return 1 for case-insensitive matches', () => {
    expect(calculateSimilarity('ALEX', 'alex')).toBe(1);
    expect(calculateSimilarity('Jo Kim', 'jo kim')).toBe(1);
  });

  it('should return high similarity for close names', () => {
    const similarity = calculateSimilarity('Jo', 'Jo Kim');
    expect(similarity).toBeGreaterThan(0.3);
    expect(similarity).toBeLessThan(0.7);
  });

  it('should return low similarity for different names', () => {
    const similarity = calculateSimilarity('Alex', 'Morgan');
    expect(similarity).toBeLessThan(0.3);
  });

  it('should handle empty strings', () => {
    expect(calculateSimilarity('', '')).toBe(1);
    expect(calculateSimilarity('hello', '')).toBe(0);
  });

  it('should trim whitespace', () => {
    expect(calculateSimilarity('  Alex  ', 'Alex')).toBe(1);
  });
});

describe('name resolution scenarios', () => {
  // These are integration-style tests that would run against a real DB
  // For now, we test the logic units

  describe('alias matching', () => {
    it('should identify Jo as similar to Jo Kim', () => {
      const similarity = calculateSimilarity('Jo', 'Jo Kim');
      // "Jo" is a prefix of "Jo Kim", so should have some similarity
      expect(similarity).toBeGreaterThan(0.3);
    });

    it('should identify Morgan variations', () => {
      expect(calculateSimilarity('Morgan', 'morgan')).toBe(1);
      expect(calculateSimilarity('Morgan', 'MG')).toBeLessThan(0.4);
    });

    it('should identify Alex Grey as distinct from Alex', () => {
      const similarity = calculateSimilarity('Alex Grey', 'Alex');
      expect(similarity).toBeGreaterThan(0.4);
      expect(similarity).toBeLessThan(0.8);
    });
  });

  describe('fuzzy matching thresholds', () => {
    const threshold = 0.7;

    it('should match above threshold', () => {
      // Very similar names (typo variants)
      expect(calculateSimilarity('Alec', 'Alex')).toBeGreaterThan(threshold);
      expect(calculateSimilarity('Morgam', 'Morgan')).toBeGreaterThan(threshold);
    });

    it('should not match below threshold', () => {
      // Different names
      expect(calculateSimilarity('Alex', 'Bob')).toBeLessThan(threshold);
      expect(calculateSimilarity('Morgan', 'Alice')).toBeLessThan(threshold);
    });

    it('should handle common typos', () => {
      expect(calculateSimilarity('ALex', 'Alex')).toBeGreaterThan(threshold);
      expect(calculateSimilarity('Morga', 'Morgan')).toBeGreaterThan(0.6);
    });
  });
});

describe('bill-split name scenarios', () => {
  // Real scenarios from the bill-split mini-app

  it('should distinguish Jo (first name) from Alex (different person)', () => {
    // Jo and Alex should NOT be considered the same
    const similarity = calculateSimilarity('Jo', 'Alex');
    // They share some characters but are short enough to be distinct
    expect(similarity).toBeLessThan(0.7);
  });

  it('should match Jo to Jo Kim (same person)', () => {
    // "Jo" is a nickname for "Jo Kim"
    // In practice, we'd rely on the alias array, but similarity helps suggest
    const similarity = calculateSimilarity('Jo', 'Jo Kim');
    expect(similarity).toBeGreaterThan(0.3);
  });

  it('should keep Morgan distinct from Alex', () => {
    const similarity = calculateSimilarity('Morgan', 'Alex');
    expect(similarity).toBeLessThan(0.3);
  });

  it('should keep Alex Grey distinct from Alex', () => {
    const similarity = calculateSimilarity('Alex Grey', 'Alex');
    // Partial match but not the same person
    expect(similarity).toBeLessThan(0.8);
    expect(similarity).toBeGreaterThan(0.4);
  });
});
