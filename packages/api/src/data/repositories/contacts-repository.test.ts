/**
 * Contacts Repository Tests
 *
 * Tests for contact management and name resolution.
 */

import { describe, it, expect } from 'vitest';
import {
  calculateSimilarity,
  levenshteinDistance,
} from './contacts-repository';

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
    expect(calculateSimilarity('Conor', 'Conor')).toBe(1);
  });

  it('should return 1 for case-insensitive matches', () => {
    expect(calculateSimilarity('CONOR', 'conor')).toBe(1);
    expect(calculateSimilarity('Co Con', 'co con')).toBe(1);
  });

  it('should return high similarity for close names', () => {
    const similarity = calculateSimilarity('Co', 'Co Con');
    expect(similarity).toBeGreaterThan(0.3);
    expect(similarity).toBeLessThan(0.7);
  });

  it('should return low similarity for different names', () => {
    const similarity = calculateSimilarity('Conor', 'Ruoshan');
    expect(similarity).toBeLessThan(0.3);
  });

  it('should handle empty strings', () => {
    expect(calculateSimilarity('', '')).toBe(1);
    expect(calculateSimilarity('hello', '')).toBe(0);
  });

  it('should trim whitespace', () => {
    expect(calculateSimilarity('  Conor  ', 'Conor')).toBe(1);
  });
});

describe('name resolution scenarios', () => {
  // These are integration-style tests that would run against a real DB
  // For now, we test the logic units

  describe('alias matching', () => {
    it('should identify Co as similar to Co Con', () => {
      const similarity = calculateSimilarity('Co', 'Co Con');
      // "Co" is a prefix of "Co Con", so should have some similarity
      expect(similarity).toBeGreaterThan(0.3);
    });

    it('should identify Ruoshan variations', () => {
      expect(calculateSimilarity('Ruoshan', 'ruoshan')).toBe(1);
      expect(calculateSimilarity('Ruoshan', 'RS')).toBeLessThan(0.3);
    });

    it('should identify Conor Grey as distinct from Conor', () => {
      const similarity = calculateSimilarity('Conor Grey', 'Conor');
      expect(similarity).toBeGreaterThan(0.4);
      expect(similarity).toBeLessThan(0.8);
    });
  });

  describe('fuzzy matching thresholds', () => {
    const threshold = 0.7;

    it('should match above threshold', () => {
      // Very similar names
      expect(calculateSimilarity('Connor', 'Conor')).toBeGreaterThan(threshold);
      expect(calculateSimilarity('Ruosahn', 'Ruoshan')).toBeGreaterThan(threshold);
    });

    it('should not match below threshold', () => {
      // Different names
      expect(calculateSimilarity('Conor', 'Bob')).toBeLessThan(threshold);
      expect(calculateSimilarity('Ruoshan', 'Alice')).toBeLessThan(threshold);
    });

    it('should handle common typos', () => {
      expect(calculateSimilarity('COnor', 'Conor')).toBeGreaterThan(threshold);
      expect(calculateSimilarity('Roshan', 'Ruoshan')).toBeGreaterThan(0.6);
    });
  });
});

describe('bill-split name scenarios', () => {
  // Real scenarios from the bill-split mini-app

  it('should distinguish Co (first name) from Conor (different person)', () => {
    // Co and Conor should NOT be considered the same
    const similarity = calculateSimilarity('Co', 'Conor');
    // They share some characters but are short enough to be distinct
    expect(similarity).toBeLessThan(0.7);
  });

  it('should match Co to Co Con (same person)', () => {
    // "Co" is a nickname for "Co Con"
    // In practice, we'd rely on the alias array, but similarity helps suggest
    const similarity = calculateSimilarity('Co', 'Co Con');
    expect(similarity).toBeGreaterThan(0.3);
  });

  it('should keep Ruoshan distinct from Conor', () => {
    const similarity = calculateSimilarity('Ruoshan', 'Conor');
    expect(similarity).toBeLessThan(0.3);
  });

  it('should keep Conor Grey distinct from Conor', () => {
    const similarity = calculateSimilarity('Conor Grey', 'Conor');
    // Partial match but not the same person
    expect(similarity).toBeLessThan(0.8);
    expect(similarity).toBeGreaterThan(0.4);
  });
});
