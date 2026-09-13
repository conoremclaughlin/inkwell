import { describe, expect, it } from 'vitest';
import {
  parseLoCoMoPhase,
  parseLoCoMoRepresentation,
  parseLoCoMoSemanticIndex,
  parseLoCoMoTopKs,
  parseOptionalCsv,
  parseOptionalPositiveInt,
} from './benchmark-locomo.config';

describe('LoCoMo benchmark configuration', () => {
  it('requires explicit phase and representation', () => {
    expect(() => parseLoCoMoPhase(undefined)).toThrow('LOCOMO_PHASE is required');
    expect(() => parseLoCoMoRepresentation(undefined)).toThrow('LOCOMO_REPRESENTATION is required');
    expect(parseLoCoMoPhase('recall')).toBe('recall');
    expect(parseLoCoMoRepresentation('turn')).toBe('turn');
  });

  it('defaults only the physical semantic index and names it precisely', () => {
    expect(parseLoCoMoSemanticIndex(undefined)).toBe('memory-chunks');
    expect(parseLoCoMoSemanticIndex('memory-single-vector')).toBe('memory-single-vector');
    expect(() => parseLoCoMoSemanticIndex('hybrid')).toThrow('LOCOMO_SEMANTIC_INDEX');
  });

  it('does not impose hidden sample or question caps', () => {
    expect(parseOptionalCsv(undefined)).toBeNull();
    expect(parseOptionalPositiveInt(undefined)).toBeNull();
    expect(parseOptionalCsv('conv-1, conv-2,conv-1')).toEqual(['conv-1', 'conv-2']);
    expect(parseOptionalPositiveInt('20')).toBe(20);
  });

  it('sorts and deduplicates explicit retrieval cutoffs', () => {
    expect(parseLoCoMoTopKs('10,1,5,5')).toEqual([1, 5, 10]);
    expect(parseLoCoMoTopKs(undefined)).toEqual([1, 3, 5, 10]);
  });
});
