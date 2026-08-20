import { describe, it, expect } from 'vitest';
import {
  buildRawMessage,
  encodeHeaderWord,
  guessMimeType,
  headerLine,
  isValidAddress,
  parseAddress,
  parseAddressList,
  sanitizeHeaderValue,
  splitAddressList,
} from './mime';

/** Decode what buildRawMessage hands to the Gmail `raw` field. */
function decodeRaw(raw: string): string {
  return Buffer.from(raw, 'base64url').toString('utf8');
}

describe('parseAddress', () => {
  it('parses a bare address without corrupting it', () => {
    // Regression: the previous regex let its optional display-name group
    // backtrack into the addr-spec, yielding name "…gmail.co" + email "m".
    expect(parseAddress('conoremclaughlin@gmail.com')).toEqual({
      email: 'conoremclaughlin@gmail.com',
    });
  });

  it('parses name + angle-bracketed address', () => {
    expect(parseAddress('Sneha Shrestha <sneha@clarus-health.com>')).toEqual({
      name: 'Sneha Shrestha',
      email: 'sneha@clarus-health.com',
    });
  });

  it('parses a quoted display name', () => {
    expect(parseAddress('"Shrestha, Sneha" <s@x.com>')).toEqual({
      name: 'Shrestha, Sneha',
      email: 's@x.com',
    });
  });

  it('parses an angle-bracketed address with no display name', () => {
    expect(parseAddress('<bob@x.com>')).toEqual({ email: 'bob@x.com' });
  });

  it('unescapes escaped characters in a quoted display name', () => {
    expect(parseAddress('"Bob \\"The Builder\\"" <bob@x.com>')).toEqual({
      name: 'Bob "The Builder"',
      email: 'bob@x.com',
    });
  });

  it('handles a display name that itself contains an @', () => {
    expect(parseAddress('bob@x.com <bob@x.com>')).toEqual({
      name: 'bob@x.com',
      email: 'bob@x.com',
    });
  });

  it('returns an empty address for empty input', () => {
    expect(parseAddress('   ')).toEqual({ email: '' });
  });
});

describe('splitAddressList', () => {
  it('splits a simple list', () => {
    expect(splitAddressList('a@x.com, b@y.com')).toEqual(['a@x.com', 'b@y.com']);
  });

  it('does not split inside a quoted display name', () => {
    // Regression: a naive .split(',') turned one recipient into two broken ones.
    expect(splitAddressList('"Shrestha, Sneha" <s@x.com>, bob@y.com')).toEqual([
      '"Shrestha, Sneha" <s@x.com>',
      'bob@y.com',
    ]);
  });

  it('does not split inside angle brackets', () => {
    expect(splitAddressList('Bob <bob@x.com>, "A, B" <ab@y.com>, c@z.com')).toHaveLength(3);
  });

  it('drops empty entries from trailing separators', () => {
    expect(splitAddressList('a@x.com,,  ,b@y.com,')).toEqual(['a@x.com', 'b@y.com']);
  });

  it('handles an escaped quote inside a quoted name', () => {
    expect(splitAddressList('"A \\" B" <ab@y.com>, c@z.com')).toEqual([
      '"A \\" B" <ab@y.com>',
      'c@z.com',
    ]);
  });
});

describe('parseAddressList', () => {
  it('parses a mixed header the way Gmail emits it', () => {
    expect(parseAddressList('conor@gmail.com, Sneha Shrestha <sneha@clarus-health.com>')).toEqual([
      { email: 'conor@gmail.com' },
      { name: 'Sneha Shrestha', email: 'sneha@clarus-health.com' },
    ]);
  });

  it('returns an empty list for a missing header', () => {
    expect(parseAddressList('')).toEqual([]);
  });
});

describe('isValidAddress', () => {
  it.each(['a@b.com', 'first.last+tag@sub.example.co.uk', 'x_y@z.io'])('accepts %s', (addr) => {
    expect(isValidAddress(addr)).toBe(true);
  });

  it.each([
    'm', // the fragment the old parser produced
    '',
    'no-at-sign.com',
    'a@b', // no TLD
    'a@@b.com',
    'a b@c.com',
    'a@b.com, c@d.com', // a whole list is not one address
    'a@b.com\r\nBcc: evil@x.com',
    '<a@b.com>',
    // Residue from RFC group syntax. The denylist version of this function
    // accepted every one of these: the excluded set never named them.
    'b@example.com;',
    'Team: a@example.com',
    'a@example.com:',
    'a@exa mple.com',
    'a@example..com',
    'a@-example.com',
    'a@example.com-',
    '(comment)a@example.com',
    'a@[192.168.0.1]',
  ])('rejects %j', (addr) => {
    expect(isValidAddress(addr)).toBe(false);
  });
});

describe('splitAddressList — RFC 5322 groups', () => {
  it('flattens a group into its member mailboxes', () => {
    expect(splitAddressList('Team: a@example.com, b@example.com;')).toEqual([
      'a@example.com',
      'b@example.com',
    ]);
  });

  it('yields nothing for an empty group', () => {
    expect(splitAddressList('undisclosed-recipients:;')).toEqual([]);
  });

  it('handles a group alongside a plain mailbox', () => {
    expect(splitAddressList('Team: a@example.com;, plain@example.com')).toEqual([
      'a@example.com',
      'plain@example.com',
    ]);
  });

  it('keeps a colon inside a quoted display name', () => {
    expect(splitAddressList('"Smith: John" <j@example.com>')).toEqual([
      '"Smith: John" <j@example.com>',
    ]);
  });

  it('leaves ordinary lists untouched', () => {
    expect(splitAddressList('a@example.com, B <b@example.com>')).toEqual([
      'a@example.com',
      'B <b@example.com>',
    ]);
  });
});

describe('sanitizeHeaderValue', () => {
  it('strips CR/LF so a value cannot inject a header', () => {
    expect(sanitizeHeaderValue('Hello\r\nBcc: evil@x.com')).toBe('Hello Bcc: evil@x.com');
  });

  it('collapses a bare LF', () => {
    expect(sanitizeHeaderValue('a\nb')).toBe('a b');
  });

  it('leaves clean values untouched', () => {
    expect(sanitizeHeaderValue('Insurance card')).toBe('Insurance card');
  });
});

describe('encodeHeaderWord', () => {
  it('passes ASCII through unchanged', () => {
    expect(encodeHeaderWord('Simple subject')).toBe('Simple subject');
  });

  it('RFC 2047 encodes non-ASCII', () => {
    expect(encodeHeaderWord('Café')).toBe(`=?UTF-8?B?${Buffer.from('Café').toString('base64')}?=`);
  });

  it('keeps every encoded word within the 75-char limit', () => {
    const encoded = encodeHeaderWord('é'.repeat(200));
    for (const word of encoded.split(' ')) {
      expect(word.length).toBeLessThanOrEqual(75);
    }
  });

  it('never splits a multi-byte character across encoded words', () => {
    const value = '🎉'.repeat(40); // 4 bytes each
    const decoded = encodeHeaderWord(value)
      .split(' ')
      .map((w) => Buffer.from(w.replace(/^=\?UTF-8\?B\?/, '').replace(/\?=$/, ''), 'base64'))
      .map((b) => b.toString('utf8'))
      .join('');
    expect(decoded).toBe(value);
  });
});

describe('headerLine', () => {
  it('sanitizes before encoding, so injection cannot survive', () => {
    const line = headerLine('Subject', 'Re: hi\r\nBcc: evil@x.com');
    expect(line.split('\r\n')).toHaveLength(1);
    expect(line).toBe('Subject: Re: hi Bcc: evil@x.com');
  });
});

describe('guessMimeType', () => {
  it.each([
    ['card.pdf', 'application/pdf'],
    ['photo.JPG', 'image/jpeg'],
    ['scan.png', 'image/png'],
    ['notes.txt', 'text/plain'],
    ['mystery.xyz', 'application/octet-stream'],
    ['noext', 'application/octet-stream'],
  ])('maps %s', (name, expected) => {
    expect(guessMimeType(name)).toBe(expected);
  });
});

describe('buildRawMessage', () => {
  it('builds a single-part message when there are no attachments', () => {
    const decoded = decodeRaw(
      buildRawMessage({ headers: ['To: a@b.com', 'Subject: Hi'], body: 'Hello there' })
    );

    expect(decoded).toContain('To: a@b.com');
    expect(decoded).toContain('Content-Type: text/plain; charset=utf-8');
    expect(decoded).not.toContain('multipart/mixed');

    const body = decoded.split('\r\n\r\n')[1];
    expect(Buffer.from(body, 'base64').toString('utf8')).toBe('Hello there');
  });

  it('marks HTML bodies with the right content type', () => {
    const decoded = decodeRaw(
      buildRawMessage({ headers: ['To: a@b.com'], body: '<b>hi</b>', isHtml: true })
    );
    expect(decoded).toContain('Content-Type: text/html; charset=utf-8');
  });

  it('round-trips a UTF-8 body', () => {
    const body = 'Voilà — 🎉 café';
    const decoded = decodeRaw(buildRawMessage({ headers: ['To: a@b.com'], body }));
    const encodedBody = decoded.split('\r\n\r\n')[1].replace(/\r\n/g, '');
    expect(Buffer.from(encodedBody, 'base64').toString('utf8')).toBe(body);
  });

  it('wraps base64 body lines to 76 characters', () => {
    const decoded = decodeRaw(
      buildRawMessage({ headers: ['To: a@b.com'], body: 'x'.repeat(5000) })
    );
    for (const line of decoded.split('\r\n')) {
      expect(line.length).toBeLessThanOrEqual(998); // RFC 5322 hard limit
    }
    const bodyLines = decoded.split('\r\n\r\n')[1].split('\r\n');
    expect(bodyLines[0].length).toBe(76);
  });

  it('builds multipart/mixed with a part per attachment', () => {
    const decoded = decodeRaw(
      buildRawMessage({
        headers: ['To: clinic@example.com', 'Subject: Insurance card'],
        body: 'Photos attached.',
        attachments: [
          {
            filename: 'front.jpg',
            mimeType: 'image/jpeg',
            content: Buffer.from('FRONTBYTES'),
          },
          {
            filename: 'back.jpg',
            mimeType: 'image/jpeg',
            content: Buffer.from('BACKBYTES'),
          },
        ],
      })
    );

    const boundaryMatch = decoded.match(/boundary="([^"]+)"/);
    expect(boundaryMatch).not.toBeNull();
    const boundary = boundaryMatch![1];

    expect(decoded).toContain('Content-Type: multipart/mixed;');
    expect(decoded).toContain('Content-Disposition: attachment; filename="front.jpg"');
    expect(decoded).toContain('Content-Disposition: attachment; filename="back.jpg"');
    expect(decoded).toContain('Content-Type: image/jpeg; name="front.jpg"');
    expect(decoded.endsWith(`--${boundary}--`)).toBe(true);

    // Three parts: body + two attachments.
    expect(decoded.split(`--${boundary}\r\n`)).toHaveLength(4);

    expect(decoded).toContain(Buffer.from('FRONTBYTES').toString('base64'));
    expect(decoded).toContain(Buffer.from('BACKBYTES').toString('base64'));
  });

  it('preserves attachment bytes exactly through base64', () => {
    const content = Buffer.from([0x00, 0xff, 0x10, 0x89, 0x50, 0x4e, 0x47]);
    const decoded = decodeRaw(
      buildRawMessage({
        headers: ['To: a@b.com'],
        body: 'x',
        attachments: [{ filename: 'b.bin', mimeType: 'application/octet-stream', content }],
      })
    );
    const lastPart = decoded
      .split('\r\n\r\n')
      .pop()!
      .replace(/\r\n--.*--$/, '');
    expect(Buffer.from(lastPart.replace(/\r\n/g, ''), 'base64')).toEqual(content);
  });

  it('uses RFC 2231 for a non-ASCII filename', () => {
    const decoded = decodeRaw(
      buildRawMessage({
        headers: ['To: a@b.com'],
        body: 'x',
        attachments: [
          { filename: 'reçu.pdf', mimeType: 'application/pdf', content: Buffer.from('x') },
        ],
      })
    );
    expect(decoded).toContain("filename*=UTF-8''re%C3%A7u.pdf");
  });

  // Round-trip, not byte-equality: the property that matters is that a
  // standards parser recovers the name we put in. Asserting on the exact
  // encoded bytes would only confirm the encoder agrees with itself —
  // `encodeURIComponent` passed such an assertion while emitting parameters
  // that Python's email parser rejects as defective.
  describe('filename round-trip', () => {
    /**
     * Decode a Content-Disposition filename parameter back to its name,
     * STRICTLY — rejecting anything a standards parser would reject.
     *
     * The strictness is the whole point. A lenient decoder that just
     * percent-decodes and passes other bytes through accepts the malformed
     * output of `encodeURIComponent` and reports a clean round-trip, which
     * is how this bug survived the first round of tests. Cross-checked
     * against Python 3.12's email parser, which agrees on all eight cases.
     */
    const readFilename = (decoded: string): string => {
      const extended = decoded.match(/filename\*=UTF-8''([^\r\n;]+)/);
      if (extended) {
        const value = extended[1];
        const illegal = value.replace(/%[0-9A-F]{2}/gi, '').match(/[^A-Za-z0-9!#$&+\-.^_`|~]/);
        if (illegal) {
          throw new Error(
            `filename* carries ${JSON.stringify(illegal[0])}, which is not an RFC 5987 attr-char: ${value}`
          );
        }
        return Buffer.from(
          value.replace(/%([0-9A-F]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))),
          'binary'
        ).toString('utf8');
      }
      const quoted = decoded.match(/filename="((?:[^"\\]|\\.)*)"/);
      if (!quoted) throw new Error(`no filename parameter in: ${decoded}`);
      return quoted[1].replace(/\\(.)/g, '$1');
    };

    it.each([
      ['résumé (final).pdf', 'non-ASCII with parentheses — Lumen’s repro'],
      ["it's a (test)*.jpg", 'apostrophe, parens and asterisk'],
      ['a\\b.pdf', 'backslash must be escaped, not deleted'],
      ['quote".pdf', 'double quote must be escaped, not deleted'],
      ['Insurance Card Front.jpg', 'spaces in an override filename'],
      ['普通话.txt', 'entirely non-ASCII'],
      ['reçu.pdf', 'single non-ASCII character'],
      ['plain.txt', 'nothing special'],
    ])('recovers %j (%s)', (filename) => {
      const decoded = decodeRaw(
        buildRawMessage({
          headers: ['To: a@b.com'],
          body: 'x',
          attachments: [
            { filename, mimeType: 'application/octet-stream', content: Buffer.from('x') },
          ],
        })
      );
      expect(readFilename(decoded)).toBe(filename);
    });

    // A wrong-but-plausible name is worse than a missing one: emitting both
    // forms lets the parser choose, and Python picks the degraded fallback.
    it('emits only the extended form for a non-ASCII name', () => {
      const decoded = decodeRaw(
        buildRawMessage({
          headers: ['To: a@b.com'],
          body: 'x',
          attachments: [
            { filename: 'reçu.pdf', mimeType: 'application/pdf', content: Buffer.from('x') },
          ],
        })
      );
      expect(decoded).toContain("filename*=UTF-8''re%C3%A7u.pdf");
      expect(decoded).not.toMatch(/filename="/);
    });

    // RFC 5322 §2.1.1: no line may exceed 998 characters. An unbounded
    // filename percent-expands ~3x and blew straight past it.
    it('keeps every header line under the 998-character hard limit', () => {
      const longAscii = `${'a'.repeat(250)}.pdf`.slice(0, 255);
      const decoded = decodeRaw(
        buildRawMessage({
          headers: ['To: a@b.com', headerLine('Subject', '長'.repeat(300))],
          body: 'x',
          attachments: [
            { filename: longAscii, mimeType: 'application/pdf', content: Buffer.from('x') },
            {
              filename: `${'é'.repeat(120)}.pdf`,
              mimeType: 'application/pdf',
              content: Buffer.from('x'),
            },
          ],
        })
      );
      const tooLong = decoded.split('\r\n').filter((line) => line.length > 998);
      expect(tooLong).toEqual([]);
    });

    it('rejects a filename too long to encode into a header', () => {
      expect(() =>
        buildRawMessage({
          headers: ['To: a@b.com'],
          body: 'x',
          attachments: [
            {
              filename: `${'é'.repeat(400)}.pdf`,
              mimeType: 'application/pdf',
              content: Buffer.from('x'),
            },
          ],
        })
      ).toThrow(/filename is too long/i);
    });

    it('percent-encodes characters encodeURIComponent leaves bare', () => {
      const decoded = decodeRaw(
        buildRawMessage({
          headers: ['To: a@b.com'],
          body: 'x',
          attachments: [
            { filename: "é'()*.pdf", mimeType: 'application/pdf', content: Buffer.from('x') },
          ],
        })
      );
      expect(decoded).toContain("filename*=UTF-8''%C3%A9%27%28%29%2A.pdf");
    });
  });

  it('strips CR/LF from an attachment filename', () => {
    const decoded = decodeRaw(
      buildRawMessage({
        headers: ['To: a@b.com'],
        body: 'x',
        attachments: [
          {
            filename: 'ok.pdf\r\nContent-Type: text/evil',
            mimeType: 'application/pdf',
            content: Buffer.from('x'),
          },
        ],
      })
    );
    expect(decoded).not.toContain('text/evil\r\n');
    expect(decoded).toContain('filename="ok.pdf Content-Type: text/evil"');
  });

  it('generates a distinct boundary per message', () => {
    const build = () =>
      decodeRaw(
        buildRawMessage({
          headers: ['To: a@b.com'],
          body: 'x',
          attachments: [{ filename: 'a.txt', mimeType: 'text/plain', content: Buffer.from('a') }],
        })
      ).match(/boundary="([^"]+)"/)![1];
    expect(build()).not.toBe(build());
  });
});
