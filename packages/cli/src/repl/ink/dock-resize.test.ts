import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Individual dock sub-components must NOT register their own resize listeners.
 * The Dock wrapper owns the single resize listener that bumps a counter,
 * forcing React to re-render all children with the updated stdout.columns.
 *
 * Without this, Ink's resize handler recalculates Yoga layout but does NOT
 * trigger React reconciliation — text content (separator width) stays stale.
 */

const DOCK_COMPONENTS = ['StatusBar.tsx', 'Separator.tsx', 'InfoBar.tsx'];

const ANTI_PATTERNS = [
  { pattern: /stdout\??\.\s*on\s*\(\s*['"]resize['"]/, label: 'manual resize listener' },
  { pattern: /stdout\??\.\s*off\s*\(\s*['"]resize['"]/, label: 'manual resize cleanup' },
  { pattern: /setCols\s*\(/, label: 'setCols state updater (use direct read instead)' },
  {
    pattern: /useState\s*\(\s*stdout\??\.\s*columns/,
    label: 'useState for columns (use direct read)',
  },
];

describe('dock components: no manual resize listeners', () => {
  for (const file of DOCK_COMPONENTS) {
    describe(file, () => {
      const source = readFileSync(resolve(__dirname, file), 'utf-8');

      for (const { pattern, label } of ANTI_PATTERNS) {
        it(`should not contain ${label}`, () => {
          expect(source).not.toMatch(pattern);
        });
      }

      it('should read stdout.columns directly (not from state)', () => {
        expect(source).toMatch(/const cols\s*=\s*stdout\??\.\s*columns/);
      });
    });
  }
});

describe('Dock: owns the single resize listener', () => {
  const source = readFileSync(resolve(__dirname, 'Dock.tsx'), 'utf-8');

  it('should have a resize listener', () => {
    expect(source).toMatch(/stdout\??\.\s*on\s*\(\s*['"]resize['"]/);
  });

  it('should use setResizeCounter to trigger re-render', () => {
    expect(source).toMatch(/setResizeCounter/);
  });
});

describe('ChatApp: uses Dock, no remountKey on Static', () => {
  const source = readFileSync(resolve(__dirname, 'ChatApp.tsx'), 'utf-8');

  it('should use the Dock component', () => {
    expect(source).toMatch(/<Dock\b/);
  });

  it('should not use key={remountKey} on Static', () => {
    expect(source).not.toMatch(/Static\s+key\s*=\s*\{remountKey\}/);
  });

  it('should not have a remountKey state variable', () => {
    expect(source).not.toMatch(/remountKey/);
  });
});

describe('MissionApp: no remountKey on Static', () => {
  const source = readFileSync(resolve(__dirname, 'MissionApp.tsx'), 'utf-8');

  it('should not use key={remountKey} on Static', () => {
    expect(source).not.toMatch(/Static\s+key\s*=\s*\{remountKey\}/);
  });

  it('should read stdout.columns directly (not from state)', () => {
    expect(source).toMatch(/const cols\s*=\s*stdout\??\.\s*columns/);
  });

  it('should not have a manual resize listener', () => {
    expect(source).not.toMatch(/stdout\??\.\s*on\s*\(\s*['"]resize['"]/);
  });
});
