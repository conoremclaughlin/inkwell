// The lazy boundary (design ink://designs/reaction-emoji-catalog §1): whatever
// imports the reacting story must not load the picker's names and keywords.
// Walks the relative imports from this story's index and checks where they lead.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s+'(\.{1,2}\/[^']+)'/g)) {
      queue.push(path.resolve(path.dirname(file), match[1].replace(/\.js$/, '.ts')));
    }
  }
  return [...seen].map((file) => path.relative(path.dirname(HERE), file));
}

describe('the reacting story', () => {
  it('reaches its validation data and nothing of the picker', () => {
    const files = reachable(path.join(HERE, 'index.ts'));
    expect(files).toContain('reacting/validation.generated.ts');
    expect(files.filter((file) => !file.startsWith('reacting/'))).toEqual([]);
  });
});
