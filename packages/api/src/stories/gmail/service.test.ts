import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'path';
import { homedir } from 'os';

const {
  mockAttachmentGet,
  mockMessagesGet,
  mockMessagesSend,
  mockDraftsCreate,
  mockGetProfile,
  mockMkdir,
  mockWriteFile,
  MockOAuth2,
} = vi.hoisted(() => {
  class _MockOAuth2 {
    setCredentials = vi.fn();
  }
  return {
    mockAttachmentGet: vi.fn(),
    mockMessagesGet: vi.fn(),
    mockMessagesSend: vi.fn(),
    mockDraftsCreate: vi.fn(),
    mockGetProfile: vi.fn(),
    mockMkdir: vi.fn().mockResolvedValue(undefined),
    mockWriteFile: vi.fn().mockResolvedValue(undefined),
    MockOAuth2: _MockOAuth2,
  };
});

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: MockOAuth2 },
    gmail: vi.fn().mockReturnValue({
      users: {
        getProfile: mockGetProfile,
        messages: {
          attachments: { get: mockAttachmentGet },
          get: mockMessagesGet,
          send: mockMessagesSend,
        },
        drafts: { create: mockDraftsCreate },
      },
    }),
  },
}));

vi.mock('../../services/oauth', () => ({
  getOAuthService: vi.fn().mockReturnValue({
    getValidAccessToken: vi.fn().mockResolvedValue('mock-token'),
  }),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    mkdir: (...args: unknown[]) => mockMkdir(...args),
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
  };
});

import { GmailService } from './service';

const expectedDir = join(homedir(), '.ink', 'files', 'gmail');

/** Headers of a real message: a bare To address plus a named Cc. */
const ORIGINAL_HEADERS = [
  { name: 'From', value: 'Sneha Shrestha <sneha@clarus-health.com>' },
  { name: 'To', value: 'conoremclaughlin@gmail.com' },
  { name: 'Cc', value: 'Front Desk <desk@clarus-health.com>' },
  { name: 'Subject', value: 'Appointment Thursday' },
  { name: 'Message-ID', value: '<abc123@mail.gmail.com>' },
];

/** Route messages.get: the original under test, else a generic sent message. */
function routeMessagesGet(headers = ORIGINAL_HEADERS) {
  return vi.fn(async ({ id }: { id: string }) => {
    if (id === 'orig-1') {
      return { data: { id: 'orig-1', threadId: 'thread-1', payload: { headers } } };
    }
    return {
      data: {
        id: 'sent-1',
        threadId: 'thread-1',
        labelIds: ['SENT'],
        payload: { headers: [{ name: 'Subject', value: 'sent' }] },
      },
    };
  });
}

/** The RFC 5322 message the service handed to Gmail, decoded. */
function sentRaw(): string {
  const raw = mockMessagesSend.mock.calls[0][0].requestBody.raw;
  return Buffer.from(raw, 'base64url').toString('utf8');
}

/** Value of a header in a decoded message (headers end at the blank line). */
function headerOf(message: string, name: string): string | undefined {
  const head = message.split('\r\n\r\n')[0];
  return head
    .split('\r\n')
    .find((l) => l.startsWith(`${name}: `))
    ?.slice(name.length + 2);
}

describe('GmailService.replyToEmail', () => {
  let service: GmailService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessagesGet.mockImplementation(routeMessagesGet());
    mockMessagesSend.mockResolvedValue({ data: { id: 'sent-1' } });
    mockGetProfile.mockResolvedValue({ data: { emailAddress: 'conoremclaughlin@gmail.com' } });
    service = new GmailService();
  });

  it('builds a valid Cc when replying all to a bare-address recipient', async () => {
    // Regression for the live failure: the old parser split the bare To
    // address into name "conoremclaughlin@gmail.co" + email "m", and "m"
    // landed in the Cc header, so Gmail returned "Invalid Cc header".
    await service.replyToEmail('user-1', {
      messageId: 'orig-1',
      body: 'Sounds good.',
      replyAll: true,
    });

    const cc = headerOf(sentRaw(), 'Cc');
    expect(cc).toBe('desk@clarus-health.com');
    expect(cc).not.toContain('m,');
    expect(cc?.split(', ')).not.toContain('m');
  });

  it('addresses the reply to the original sender', async () => {
    await service.replyToEmail('user-1', { messageId: 'orig-1', body: 'ok' });
    expect(headerOf(sentRaw(), 'To')).toBe('sneha@clarus-health.com');
  });

  it('excludes the user from their own replyAll Cc', async () => {
    await service.replyToEmail('user-1', {
      messageId: 'orig-1',
      body: 'ok',
      replyAll: true,
    });
    expect(headerOf(sentRaw(), 'Cc')).not.toContain('conoremclaughlin@gmail.com');
  });

  it('omits Cc entirely when not replying all', async () => {
    await service.replyToEmail('user-1', { messageId: 'orig-1', body: 'ok' });
    expect(headerOf(sentRaw(), 'Cc')).toBeUndefined();
  });

  it('honors Reply-To over From', async () => {
    mockMessagesGet.mockImplementation(
      routeMessagesGet([...ORIGINAL_HEADERS, { name: 'Reply-To', value: 'billing@clarus.com' }])
    );

    await service.replyToEmail('user-1', { messageId: 'orig-1', body: 'ok' });
    expect(headerOf(sentRaw(), 'To')).toBe('billing@clarus.com');
  });

  // Reply-To is an address-LIST (RFC 5322 §3.6.2), not a single mailbox.
  // Parsed as one mailbox, the bare form yields a comma-bearing string that
  // fails validation and kills the reply outright; the display-name form
  // silently keeps only the last address and drops an intended recipient.
  it('replies to every address in a bare multi-address Reply-To', async () => {
    mockMessagesGet.mockImplementation(
      routeMessagesGet([
        ...ORIGINAL_HEADERS,
        { name: 'Reply-To', value: 'a@example.com, b@example.com' },
      ])
    );

    await service.replyToEmail('user-1', { messageId: 'orig-1', body: 'ok' });
    expect(headerOf(sentRaw(), 'To')).toBe('a@example.com, b@example.com');
  });

  it('replies to every address in a display-name multi-address Reply-To', async () => {
    mockMessagesGet.mockImplementation(
      routeMessagesGet([
        ...ORIGINAL_HEADERS,
        { name: 'Reply-To', value: 'A <a@example.com>, B <b@example.com>' },
      ])
    );

    await service.replyToEmail('user-1', { messageId: 'orig-1', body: 'ok' });
    expect(headerOf(sentRaw(), 'To')).toBe('a@example.com, b@example.com');
  });

  it('does not Cc a Reply-To destination that also appears in the original To', async () => {
    mockMessagesGet.mockImplementation(
      routeMessagesGet([
        { name: 'From', value: 'noreply@x.com' },
        { name: 'Reply-To', value: 'a@example.com, b@example.com' },
        { name: 'To', value: 'B@example.com, other@z.com' },
        { name: 'Subject', value: 'Hi' },
      ])
    );

    await service.replyToEmail('user-1', {
      messageId: 'orig-1',
      body: 'ok',
      replyAll: true,
    });
    expect(headerOf(sentRaw(), 'To')).toBe('a@example.com, b@example.com');
    expect(headerOf(sentRaw(), 'Cc')).toBe('other@z.com');
  });

  it('deduplicates addresses repeated within Reply-To itself', async () => {
    mockMessagesGet.mockImplementation(
      routeMessagesGet([
        ...ORIGINAL_HEADERS,
        { name: 'Reply-To', value: 'a@example.com, A@EXAMPLE.COM' },
      ])
    );

    await service.replyToEmail('user-1', { messageId: 'orig-1', body: 'ok' });
    expect(headerOf(sentRaw(), 'To')).toBe('a@example.com');
  });

  it('falls back to the routable subset when Reply-To carries junk', async () => {
    mockMessagesGet.mockImplementation(
      routeMessagesGet([
        ...ORIGINAL_HEADERS,
        { name: 'Reply-To', value: 'not-an-address, good@example.com' },
      ])
    );

    await service.replyToEmail('user-1', { messageId: 'orig-1', body: 'ok' });
    expect(headerOf(sentRaw(), 'To')).toBe('good@example.com');
  });

  // RFC group syntax is legal inbound. Split naively it leaves a trailing
  // `;` glued to the last member, which the old denylist validator accepted
  // and emitted as a malformed `To:` — the same shape as the original
  // "Invalid Cc header" failure, one round later.
  it('replies to the members of a grouped Reply-To', async () => {
    mockMessagesGet.mockImplementation(
      routeMessagesGet([
        ...ORIGINAL_HEADERS,
        { name: 'Reply-To', value: 'Team: a@example.com, b@example.com;' },
      ])
    );

    await service.replyToEmail('user-1', { messageId: 'orig-1', body: 'ok' });
    expect(headerOf(sentRaw(), 'To')).toBe('a@example.com, b@example.com');
  });

  it('Ccs the members of a grouped To on replyAll', async () => {
    mockMessagesGet.mockImplementation(
      routeMessagesGet([
        { name: 'From', value: 'sender@x.com' },
        { name: 'To', value: 'Team: a@example.com, b@example.com;' },
        { name: 'Subject', value: 'Hi' },
      ])
    );

    await service.replyToEmail('user-1', {
      messageId: 'orig-1',
      body: 'ok',
      replyAll: true,
    });
    expect(headerOf(sentRaw(), 'Cc')).toBe('a@example.com, b@example.com');
  });

  it('drops unroutable entries from the original recipients', async () => {
    mockMessagesGet.mockImplementation(
      routeMessagesGet([
        { name: 'From', value: 'sender@x.com' },
        { name: 'To', value: 'undisclosed-recipients:;' },
        { name: 'Cc', value: 'real@y.com, not-an-address' },
        { name: 'Subject', value: 'Hi' },
      ])
    );

    await service.replyToEmail('user-1', {
      messageId: 'orig-1',
      body: 'ok',
      replyAll: true,
    });
    expect(headerOf(sentRaw(), 'Cc')).toBe('real@y.com');
  });

  it('keeps a comma-containing quoted display name as one recipient', async () => {
    mockMessagesGet.mockImplementation(
      routeMessagesGet([
        { name: 'From', value: 'sender@x.com' },
        { name: 'To', value: '"Shrestha, Sneha" <sneha@y.com>, bob@z.com' },
        { name: 'Subject', value: 'Hi' },
      ])
    );

    await service.replyToEmail('user-1', {
      messageId: 'orig-1',
      body: 'ok',
      replyAll: true,
    });
    expect(headerOf(sentRaw(), 'Cc')).toBe('sneha@y.com, bob@z.com');
  });

  it('deduplicates a recipient listed in both To and Cc', async () => {
    mockMessagesGet.mockImplementation(
      routeMessagesGet([
        { name: 'From', value: 'sender@x.com' },
        { name: 'To', value: 'dup@y.com' },
        { name: 'Cc', value: 'DUP@y.com, other@z.com' },
        { name: 'Subject', value: 'Hi' },
      ])
    );

    await service.replyToEmail('user-1', {
      messageId: 'orig-1',
      body: 'ok',
      replyAll: true,
    });
    expect(headerOf(sentRaw(), 'Cc')).toBe('dup@y.com, other@z.com');
  });

  it('prefixes the subject with Re: only once', async () => {
    mockMessagesGet.mockImplementation(
      routeMessagesGet([
        { name: 'From', value: 'sender@x.com' },
        { name: 'Subject', value: 'RE: Appointment' },
      ])
    );

    await service.replyToEmail('user-1', { messageId: 'orig-1', body: 'ok' });
    expect(headerOf(sentRaw(), 'Subject')).toBe('RE: Appointment');
  });

  it('refuses to reply when the sender address is unusable', async () => {
    mockMessagesGet.mockImplementation(
      routeMessagesGet([{ name: 'From', value: 'Mailer Daemon' }])
    );

    await expect(
      service.replyToEmail('user-1', { messageId: 'orig-1', body: 'ok' })
    ).rejects.toThrow(/no usable sender address/);
    expect(mockMessagesSend).not.toHaveBeenCalled();
  });

  it('does not let a hostile original subject inject a header', async () => {
    mockMessagesGet.mockImplementation(
      routeMessagesGet([
        { name: 'From', value: 'attacker@evil.com' },
        { name: 'Subject', value: 'Hi\r\nBcc: exfil@evil.com' },
      ])
    );

    await service.replyToEmail('user-1', { messageId: 'orig-1', body: 'ok' });

    const message = sentRaw();
    expect(headerOf(message, 'Bcc')).toBeUndefined();
    expect(message.split('\r\n\r\n')[0]).not.toMatch(/^Bcc:/m);
    expect(headerOf(message, 'Subject')).toBe('Re: Hi Bcc: exfil@evil.com');
  });

  // References/In-Reply-To are lifted straight out of received mail and are
  // only CRLF-stripped — never encoded-word wrapped — so their bytes reach
  // the wire as-is. A length-based line check counts UTF-16 units and
  // undercounts CJK by 3x, waving through a line well over the octet limit.
  it('refuses to send when an inbound References header overflows the line limit', async () => {
    mockMessagesGet.mockImplementation(
      routeMessagesGet([
        ...ORIGINAL_HEADERS,
        { name: 'References', value: `<${'長'.repeat(400)}@evil.com>` },
      ])
    );

    await expect(
      service.replyToEmail('user-1', { messageId: 'orig-1', body: 'ok' })
    ).rejects.toThrow(/998-octet limit/);
    expect(mockMessagesSend).not.toHaveBeenCalled();
  });

  it('sends when a non-ASCII References header fits in octets', async () => {
    mockMessagesGet.mockImplementation(
      routeMessagesGet([
        ...ORIGINAL_HEADERS,
        { name: 'References', value: `<${'長'.repeat(100)}@ok.com>` },
      ])
    );

    await service.replyToEmail('user-1', { messageId: 'orig-1', body: 'ok' });

    const headerBlock = sentRaw().split('\r\n\r\n')[0];
    for (const line of headerBlock.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(998);
    }
    expect(mockMessagesSend).toHaveBeenCalled();
  });

  it('still sends when the profile lookup for self-exclusion fails', async () => {
    mockGetProfile.mockRejectedValue(new Error('insufficient scope'));

    await service.replyToEmail('user-1', {
      messageId: 'orig-1',
      body: 'ok',
      replyAll: true,
    });
    expect(mockMessagesSend).toHaveBeenCalled();
  });
});

describe('GmailService.sendEmail', () => {
  let service: GmailService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockMessagesGet.mockImplementation(routeMessagesGet());
    mockMessagesSend.mockResolvedValue({ data: { id: 'sent-1' } });
    service = new GmailService();
  });

  it('sends a plain single-part message with no attachments', async () => {
    await service.sendEmail('user-1', {
      to: ['clinic@example.com'],
      subject: 'Insurance card',
      body: 'Attached.',
    });

    const message = sentRaw();
    expect(headerOf(message, 'To')).toBe('clinic@example.com');
    expect(message).not.toContain('multipart/mixed');
  });

  it('rejects an invalid recipient before contacting Gmail', async () => {
    await expect(
      service.sendEmail('user-1', { to: ['m'], subject: 'x', body: 'y' })
    ).rejects.toThrow(/Invalid To address/);
    expect(mockMessagesSend).not.toHaveBeenCalled();
  });

  it('rejects a CRLF-bearing recipient', async () => {
    await expect(
      service.sendEmail('user-1', {
        to: ['ok@x.com\r\nBcc: evil@y.com'],
        subject: 'x',
        body: 'y',
      })
    ).rejects.toThrow(/Invalid To address/);
  });

  it('does not let a caller-supplied subject inject a header', async () => {
    await service.sendEmail('user-1', {
      to: ['a@b.com'],
      subject: 'Hi\r\nBcc: evil@x.com',
      body: 'y',
    });
    expect(headerOf(sentRaw(), 'Bcc')).toBeUndefined();
  });

  it('adds threading headers when replying', async () => {
    await service.sendEmail('user-1', {
      to: ['a@b.com'],
      subject: 'Re: x',
      body: 'y',
      replyToMessageId: 'orig-1',
    });

    const message = sentRaw();
    expect(headerOf(message, 'In-Reply-To')).toBe('<abc123@mail.gmail.com>');
    expect(headerOf(message, 'References')).toBe('<abc123@mail.gmail.com>');
  });
});

describe('GmailService.downloadAttachment', () => {
  let service: GmailService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new GmailService();
  });

  it('should download and save attachment with correct path', async () => {
    const testData = Buffer.from('hello world').toString('base64url');
    mockAttachmentGet.mockResolvedValue({ data: { data: testData, size: 11 } });

    const result = await service.downloadAttachment('user-1', 'msg-1', 'att-1', 'report.pdf');

    expect(result.path).toMatch(/\.ink\/files\/gmail\/\d+_report\.pdf$/);
    expect(result.filename).toBe('report.pdf');
    expect(result.size).toBe(11);
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining('report.pdf'),
      expect.any(Buffer)
    );
  });

  it('should sanitize special characters in filename', async () => {
    const testData = Buffer.from('data').toString('base64url');
    mockAttachmentGet.mockResolvedValue({ data: { data: testData, size: 4 } });

    const result = await service.downloadAttachment(
      'user-1',
      'msg-1',
      'att-1',
      'my file (copy).pdf'
    );

    expect(result.filename).toBe('my_file__copy_.pdf');
    expect(result.path).toContain('my_file__copy_.pdf');
  });

  it('should throw when attachment data is empty', async () => {
    mockAttachmentGet.mockResolvedValue({ data: { data: null } });

    await expect(
      service.downloadAttachment('user-1', 'msg-1', 'att-1', 'empty.pdf')
    ).rejects.toThrow('Attachment data is empty');
  });

  it('should create the gmail directory', async () => {
    const testData = Buffer.from('test').toString('base64url');
    mockAttachmentGet.mockResolvedValue({ data: { data: testData, size: 4 } });

    await service.downloadAttachment('user-1', 'msg-1', 'att-1', 'test.txt');

    expect(mockMkdir).toHaveBeenCalledWith(expectedDir, { recursive: true });
  });

  it('should call Gmail API with correct params', async () => {
    const testData = Buffer.from('test').toString('base64url');
    mockAttachmentGet.mockResolvedValue({ data: { data: testData, size: 4 } });

    await service.downloadAttachment('user-1', 'msg-abc', 'att-xyz', 'file.txt');

    expect(mockAttachmentGet).toHaveBeenCalledWith({
      userId: 'me',
      messageId: 'msg-abc',
      id: 'att-xyz',
    });
  });
});
