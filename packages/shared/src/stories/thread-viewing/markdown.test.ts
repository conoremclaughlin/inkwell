import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  parseMarkdown,
  plainTextOf,
  tableColumnChars,
  type MarkdownBlock,
} from './markdown.js';

const text = (t: string) => ({ kind: 'text' as const, text: t });

describe('parseMarkdown', () => {
  it('keeps a single newline as a line break, the way chat is written', () => {
    expect(parseMarkdown('Round 2\nsecond line')).toEqual([
      { kind: 'paragraph', inline: [text('Round 2'), { kind: 'break' }, text('second line')] },
    ]);
  });

  it('reads emphasis, strikethrough and inline code', () => {
    expect(parseMarkdown('**approve** with _one_ ~~two~~ `nit`')).toEqual([
      {
        kind: 'paragraph',
        inline: [
          { kind: 'strong', children: [text('approve')] },
          text(' with '),
          { kind: 'em', children: [text('one')] },
          text(' '),
          { kind: 'del', children: [text('two')] },
          text(' '),
          { kind: 'code', text: 'nit' },
        ],
      },
    ]);
  });

  it('reads headings, fenced code with its language, quotes and rules', () => {
    const blocks = parseMarkdown('## Findings\n\n```ts\nconst x = 1;\n```\n\n> quoted\n\n---');
    expect(blocks).toEqual<MarkdownBlock[]>([
      { kind: 'heading', depth: 2, inline: [text('Findings')] },
      { kind: 'code', lang: 'ts', text: 'const x = 1;' },
      { kind: 'quote', blocks: [{ kind: 'paragraph', inline: [text('quoted')] }] },
      { kind: 'rule' },
    ]);
  });

  it('reads task lists, numbered lists from their start, and nesting', () => {
    const [list] = parseMarkdown('- [x] done\n- [ ] todo\n  3. nested');
    expect(list).toEqual({
      kind: 'list',
      ordered: false,
      start: 1,
      items: [
        { checked: true, blocks: [{ kind: 'paragraph', inline: [text('done')] }] },
        {
          checked: false,
          blocks: [
            { kind: 'paragraph', inline: [text('todo')] },
            {
              kind: 'list',
              ordered: true,
              start: 3,
              items: [{ checked: null, blocks: [{ kind: 'paragraph', inline: [text('nested')] }] }],
            },
          ],
        },
      ],
    });
  });

  it('reads a table with its alignment', () => {
    expect(parseMarkdown('| a | b |\n|---|:-:|\n| 1 | **2** |')).toEqual([
      {
        kind: 'table',
        align: [null, 'center'],
        header: [[text('a')], [text('b')]],
        rows: [[[text('1')], [{ kind: 'strong', children: [text('2')] }]]],
      },
    ]);
  });

  it('keeps http(s) and mailto links, autolinked or written out', () => {
    expect(parseMarkdown('[PR](https://example.com/pr/1) and https://example.org')).toEqual([
      {
        kind: 'paragraph',
        inline: [
          { kind: 'link', href: 'https://example.com/pr/1', children: [text('PR')] },
          text(' and '),
          { kind: 'link', href: 'https://example.org', children: [text('https://example.org')] },
        ],
      },
    ]);
  });

  it('reads any other link target as its label, never as something to open', () => {
    expect(parseMarkdown('[click](javascript:alert(1)) [file](file:///etc/hosts)')).toEqual([
      { kind: 'paragraph', inline: [text('click file')] },
    ]);
  });

  it('keeps inline code literal, entity spellings included (Lumen, #679)', () => {
    expect(parseMarkdown('`&amp; &#x41; &lt;`')).toEqual([
      { kind: 'paragraph', inline: [{ kind: 'code', text: '&amp; &#x41; &lt;' }] },
    ]);
  });

  it('decodes a link target before opening it, as a browser would (Lumen, #679)', () => {
    expect(parseMarkdown('[query](https://example.com/?a=1&amp;b=2)')).toEqual([
      {
        kind: 'paragraph',
        inline: [{ kind: 'link', href: 'https://example.com/?a=1&b=2', children: [text('query')] }],
      },
    ]);
  });

  it('judges an entity-spelled scheme by what it spells, and refuses it', () => {
    expect(parseMarkdown('[a](javascript&#58;alert(1)) [b](&#x6A;avascript:alert(1))')).toEqual([
      { kind: 'paragraph', inline: [text('a b')] },
    ]);
  });

  it('shows raw HTML as the text it is', () => {
    expect(parseMarkdown('a <b>bold</b> claim')).toEqual([
      { kind: 'paragraph', inline: [text('a <b>bold</b> claim')] },
    ]);
  });

  it('shows entities as their characters, and escaped markdown literally', () => {
    expect(parseMarkdown('Tom &amp; Jerry \\*not em\\*')).toEqual([
      { kind: 'paragraph', inline: [text('Tom & Jerry *not em*')] },
    ]);
  });

  it('reads an image as a link to it, labelled by its alt text', () => {
    expect(parseMarkdown('![diagram](https://example.com/d.png)')).toEqual([
      {
        kind: 'paragraph',
        inline: [{ kind: 'link', href: 'https://example.com/d.png', children: [text('diagram')] }],
      },
    ]);
  });

  it('is empty for an empty body', () => {
    expect(parseMarkdown('')).toEqual([]);
    expect(parseMarkdown('\n\n')).toEqual([]);
  });
});

describe('decodeEntities', () => {
  it('decodes named and numeric entities, and leaves unknown ones alone', () => {
    expect(decodeEntities('&lt;a&gt; &#39;q&#39; &#x2014; &bogus; &#0;')).toBe(
      "<a> 'q' — &bogus; &#0;"
    );
  });
});

describe('plainTextOf', () => {
  it('reads a tree back as text, formatting dropped', () => {
    const [paragraph] = parseMarkdown('**Round 2** — see [the PR](https://example.com)\n`ok`');
    expect(paragraph.kind === 'paragraph' && plainTextOf(paragraph.inline)).toBe(
      'Round 2 — see the PR\nok'
    );
  });
});

describe('tableColumnChars', () => {
  it('gives each column its widest cell, header included, the same for every row', () => {
    const [table] = parseMarkdown(
      '| A | Status |\n|---|---|\n| A moderately long first cell | x |'
    );
    expect(table.kind === 'table' && tableColumnChars(table)).toEqual([28, 6]);
  });

  it('measures formatted cells by their text, not their markup', () => {
    const [table] = parseMarkdown('| a |\n|---|\n| **bold** [link](https://example.com) |');
    expect(table.kind === 'table' && tableColumnChars(table)).toEqual(['bold link'.length]);
  });
});
