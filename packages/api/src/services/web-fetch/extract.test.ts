import { describe, expect, it } from 'vitest';
import {
  decodeBody,
  decodeEntities,
  extractContent,
  htmlToReadable,
  isTextMediaType,
  mediaTypeOf,
} from './extract';

const md = (html: string) => htmlToReadable(html, 'markdown').text;
const plain = (html: string) => htmlToReadable(html, 'text').text;

describe('htmlToReadable drops what a reader would not see', () => {
  it.each([
    ['the hidden attribute', '<p hidden>SECRET</p>'],
    ['aria-hidden', '<div aria-hidden="true">SECRET</div>'],
    ['a hidden class', '<span class="nav sr-only">SECRET</span>'],
    ['display:none', '<div style="color:red; display: none">SECRET</div>'],
    ['opacity 0', '<div style="opacity:0">SECRET</div>'],
    ['font-size 0', '<div style="font-size:0px">SECRET</div>'],
    ['offscreen positioning', '<div style="position:absolute;left:-9999px">SECRET</div>'],
    ['a hidden input', '<input type="hidden" value="SECRET">'],
    ['template', '<template><p>SECRET</p></template>'],
    ['svg, title and all', '<svg><title>SECRET</title><text>SECRET</text></svg>'],
    ['script', '<script>var a = "SECRET";</script>'],
    ['style', '<style>.a::after { content: "SECRET" }</style>'],
    ['noscript', '<noscript>SECRET</noscript>'],
    ['iframe', '<iframe>SECRET</iframe>'],
    ['a comment', '<!-- SECRET -->'],
  ])('drops %s', (_label, hidden) => {
    const text = md(`<body><p>before</p>${hidden}<p>after</p></body>`);
    expect(text).not.toContain('SECRET');
    expect(text).toContain('before');
    expect(text).toContain('after');
  });

  it('keeps what follows a hidden element, nested tags and all', () => {
    expect(md('<div hidden><div><span>gone</span></div></div><p>kept</p>')).toBe('kept');
  });

  it('never reads markup inside a script, so a "</div>" there ends nothing', () => {
    const text = md(
      '<div hidden><script>document.write("</div>")</script>STILL HIDDEN</div><p>shown</p>'
    );
    expect(text).toBe('shown');
  });

  it('does not take data-hidden or hiddenfoo for the hidden attribute', () => {
    expect(md('<p data-hidden="x">one</p><p hiddenfoo>two</p>')).toBe('one\n\ntwo');
  });
});

describe('htmlToReadable keeps structure', () => {
  it('marks headings, links and list items in markdown', () => {
    const html =
      '<h1>Title</h1><p>See <a href="https://example.com/a?b=1&amp;c=2">the docs</a>.</p>' +
      '<ul><li>one</li><li>two</li></ul>';
    expect(md(html)).toBe(
      '# Title\n\nSee [the docs](https://example.com/a?b=1&c=2).\n\n- one\n- two'
    );
  });

  it('gives the plain text in text mode', () => {
    const html =
      '<h2>Title</h2><p>See <a href="https://example.com/">the docs</a>.</p><ul><li>one</li></ul>';
    expect(plain(html)).toBe('Title\n\nSee the docs.\n\none');
  });

  it('uses the href when a link has no text', () => {
    expect(md('<a href="https://example.com/x"><img src="i.png"></a>')).toBe(
      'https://example.com/x'
    );
  });

  it('collapses source whitespace, newlines included, as a browser does', () => {
    expect(md('<p>one\n    two\t\tthree</p>\n\n\n<p>four</p>')).toBe('one two three\n\nfour');
    expect(md('<ul>\n  <li>\n    item\n  </li>\n</ul>')).toBe('- item');
  });

  it('fences a pre block in markdown and keeps its indentation', () => {
    const html = '<p>Code:</p><pre>def f():\n    return 1</pre><p>done</p>';
    expect(md(html)).toBe('Code:\n\n```\ndef f():\n    return 1\n```\n\ndone');
    expect(plain(html)).toBe('Code:\n\ndef f():\nreturn 1\n\ndone');
  });

  it('reads the title, entities decoded, and keeps it out of the text', () => {
    const result = htmlToReadable(
      '<html><head><title> A &amp; B </title></head><body>body</body></html>',
      'markdown'
    );
    expect(result.title).toBe('A & B');
    expect(result.text).toBe('body');
  });

  it('keeps a bare "<" that starts no tag', () => {
    expect(md('<p>a < b and c > d</p>')).toBe('a < b and c > d');
  });

  it('strips invisible characters', () => {
    expect(md('<p>pay\u{200B}load\u{E0041}</p>')).toBe('payload');
  });
});

describe('decodeEntities', () => {
  it('decodes once, so an escaped entity stays an entity', () => {
    expect(decodeEntities('&amp;lt;script&amp;gt;')).toBe('&lt;script&gt;');
  });

  it('decodes numeric references, astral ones too, and replaces invalid ones', () => {
    expect(decodeEntities('&#65;&#x42;&#x1F600;')).toBe('AB\u{1F600}');
    expect(decodeEntities('&#0;&#xD800;&#x110000;')).toBe('\u{FFFD}\u{FFFD}\u{FFFD}');
  });

  it('leaves an unknown name alone', () => {
    expect(decodeEntities('&notanentity;')).toBe('&notanentity;');
  });
});

describe('htmlToReadable stays linear on a page built to defeat it', () => {
  const within = (ms: number, run: () => unknown) => {
    const started = performance.now();
    run();
    expect(performance.now() - started).toBeLessThan(ms);
  };

  it('100k hidden opens followed by 100k unmatched closes', () => {
    const html = '<div hidden>'.repeat(100_000) + '</span>'.repeat(100_000);
    within(1_500, () => md(html));
  });

  it('a 1.5 MB run of spaces with no newline after it', () => {
    within(1_500, () => md(`<pre>${' '.repeat(1_500_000)}x</pre>`));
  });

  it('100k links that are never closed', () => {
    within(1_500, () => md('<a href="https://example.com/">x'.repeat(100_000)));
  });

  it('an unterminated quote in the first tag', () => {
    within(1_500, () => md(`<a title="${'x'.repeat(1_500_000)}`));
  });
});

describe('decodeBody', () => {
  it('uses the charset in the header', () => {
    expect(
      decodeBody(Buffer.from([0x63, 0x61, 0x66, 0xe9]), 'text/plain; charset=iso-8859-1')
    ).toBe('café');
  });

  it('finds a charset in a meta tag', () => {
    // 0xE9 is é in ISO-8859-1 and invalid UTF-8, so only the meta tag gets it right.
    const bytes = Buffer.concat([
      Buffer.from('<html><head><meta charset="iso-8859-1"></head><body>caf'),
      Buffer.from([0xe9]),
    ]);
    expect(decodeBody(bytes, 'text/html')).toContain('café');
    expect(decodeBody(bytes, 'text/plain; charset=utf-8')).not.toContain('café');
  });

  it('follows a UTF-16 byte-order mark', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi', 'utf16le')]);
    expect(decodeBody(bytes, 'text/plain')).toBe('hi');
  });

  it('falls back to UTF-8 for a charset it does not know', () => {
    expect(decodeBody(Buffer.from('ok'), 'text/plain; charset=made-up')).toBe('ok');
  });
});

describe('extractContent by media type', () => {
  it('pretty-prints JSON', () => {
    const result = extractContent('{"a":[1,2]}', 'application/json; charset=utf-8', 'markdown');
    expect(result).toEqual({ text: '{\n  "a": [\n    1,\n    2\n  ]\n}', extractor: 'json' });
  });

  it('returns JSON that does not parse as it came', () => {
    expect(extractContent('{nope', 'application/json', 'markdown')).toEqual({
      text: '{nope',
      extractor: 'text',
    });
  });

  it('passes markdown through', () => {
    expect(extractContent('# Hi\n\n- a', 'text/markdown', 'text').extractor).toBe('markdown');
  });

  it('reads HTML', () => {
    expect(extractContent('<p>hi</p>', 'text/html', 'markdown')).toEqual({
      text: 'hi',
      title: undefined,
      extractor: 'html',
    });
  });
});

describe('isTextMediaType', () => {
  it.each([
    'text/html',
    'text/plain',
    'application/json',
    'application/ld+json',
    'image/svg+xml',
    '',
  ])('reads %j', (type) => expect(isTextMediaType(type)).toBe(true));

  it.each(['image/png', 'application/pdf', 'application/octet-stream', 'application/zip'])(
    'does not read %s',
    (type) => expect(isTextMediaType(type)).toBe(false)
  );

  it('takes the media type from a full header', () => {
    expect(mediaTypeOf('Text/HTML; charset=UTF-8')).toBe('text/html');
  });
});
