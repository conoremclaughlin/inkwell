/**
 * End-to-end wiring for outbound attachments.
 *
 * Only the LOCATION of the media root is swapped (to a temp dir, so the
 * suite never writes into the operator's real ~/.ink/files). Everything
 * else is the production path: sendEmail → prepareAttachments →
 * resolveOutboundAttachments → readContainedFile → real filesystem →
 * buildRawMessage → the raw handed to the Gmail client. A test that stubbed
 * the resolver would go green on wiring that never actually attaches.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const { mediaRootRef, mockMessagesGet, mockMessagesSend, mockDraftsCreate, MockOAuth2 } =
  vi.hoisted(() => {
    class _MockOAuth2 {
      setCredentials = vi.fn();
    }
    return {
      mediaRootRef: { current: '' },
      mockMessagesGet: vi.fn(),
      mockMessagesSend: vi.fn(),
      mockDraftsCreate: vi.fn(),
      MockOAuth2: _MockOAuth2,
    };
  });

vi.mock('googleapis', () => ({
  google: {
    auth: { OAuth2: MockOAuth2 },
    gmail: vi.fn().mockReturnValue({
      users: {
        getProfile: vi.fn().mockResolvedValue({ data: { emailAddress: 'me@example.com' } }),
        messages: { get: mockMessagesGet, send: mockMessagesSend },
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

// Relocate the containment root only; the check itself stays real.
vi.mock('../../channels/agent-media', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, defaultMediaRoot: () => mediaRootRef.current };
});

import { GmailService } from './service';

let base: string;
let root: string;
let service: GmailService;

const sentMessageStub = {
  data: {
    id: 'sent-1',
    threadId: 't-1',
    labelIds: ['SENT'],
    payload: { headers: [{ name: 'Subject', value: 'sent' }] },
  },
};

beforeEach(async () => {
  vi.clearAllMocks();
  base = await mkdtemp(join(tmpdir(), 'gmail-svc-attach-'));
  root = join(base, 'files');
  await mkdir(root, { recursive: true });
  mediaRootRef.current = root;

  mockMessagesGet.mockResolvedValue(sentMessageStub);
  mockMessagesSend.mockResolvedValue({ data: { id: 'sent-1' } });
  mockDraftsCreate.mockResolvedValue({ data: { id: 'draft-1', message: { id: 'sent-1' } } });
  service = new GmailService();
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

function sentRaw(): string {
  return Buffer.from(mockMessagesSend.mock.calls[0][0].requestBody.raw, 'base64url').toString(
    'utf8'
  );
}

describe('sendEmail with attachments', () => {
  it('carries the file bytes into a multipart message', async () => {
    const file = join(root, 'insurance-front.jpg');
    await writeFile(file, 'FRONTOFCARD');

    await service.sendEmail('user-1', {
      to: ['clinic@example.com'],
      subject: 'Insurance card',
      body: 'Photos attached.',
      attachments: [{ path: file }],
    });

    const message = sentRaw();
    expect(message).toContain('Content-Type: multipart/mixed;');
    expect(message).toContain('Content-Type: image/jpeg; name="insurance-front.jpg"');
    expect(message).toContain('Content-Disposition: attachment; filename="insurance-front.jpg"');
    expect(message).toContain(Buffer.from('FRONTOFCARD').toString('base64'));
  });

  it('attaches several files in one message', async () => {
    await writeFile(join(root, 'front.jpg'), 'FRONT');
    await writeFile(join(root, 'back.jpg'), 'BACK');

    await service.sendEmail('user-1', {
      to: ['clinic@example.com'],
      subject: 'Card',
      body: 'Both sides.',
      attachments: [{ path: join(root, 'front.jpg') }, { path: join(root, 'back.jpg') }],
    });

    const message = sentRaw();
    expect(message).toContain(Buffer.from('FRONT').toString('base64'));
    expect(message).toContain(Buffer.from('BACK').toString('base64'));
    const boundary = message.match(/boundary="([^"]+)"/)![1];
    expect(message.split(`--${boundary}\r\n`)).toHaveLength(4); // body + 2 files
  });

  it('uses the filename override the caller supplied', async () => {
    await writeFile(join(root, '1755712345_scan.pdf'), 'PDF');

    await service.sendEmail('user-1', {
      to: ['a@b.com'],
      subject: 'x',
      body: 'y',
      attachments: [{ path: join(root, '1755712345_scan.pdf'), filename: 'Insurance Card.pdf' }],
    });

    expect(sentRaw()).toContain('Content-Disposition: attachment; filename="Insurance Card.pdf"');
  });

  it('sends nothing when an attachment escapes the media root', async () => {
    const secret = join(base, 'id_rsa');
    await writeFile(secret, 'PRIVATE KEY');

    await expect(
      service.sendEmail('user-1', {
        to: ['a@b.com'],
        subject: 'x',
        body: 'y',
        attachments: [{ path: secret }],
      })
    ).rejects.toThrow(/outside the shared media directory/);

    // The critical assertion: it fails BEFORE the message goes out, rather
    // than mailing a message that silently lacks its attachments.
    expect(mockMessagesSend).not.toHaveBeenCalled();
  });

  it('sends nothing when a symlink escapes the media root', async () => {
    const secret = join(base, '.env.local');
    await writeFile(secret, 'SUPABASE_SECRET_KEY=sb_secret_xxx');
    await symlink(secret, join(root, 'notes.txt'));

    await expect(
      service.sendEmail('user-1', {
        to: ['a@b.com'],
        subject: 'x',
        body: 'y',
        attachments: [{ path: join(root, 'notes.txt') }],
      })
    ).rejects.toThrow(/outside the shared media directory/);
    expect(mockMessagesSend).not.toHaveBeenCalled();
  });

  it('stays single-part when the attachments array is empty', async () => {
    await service.sendEmail('user-1', {
      to: ['a@b.com'],
      subject: 'x',
      body: 'y',
      attachments: [],
    });
    expect(sentRaw()).not.toContain('multipart/mixed');
  });
});

describe('replyToEmail with attachments', () => {
  it('forwards attachments through the reply path', async () => {
    const file = join(root, 'receipt.pdf');
    await writeFile(file, 'RECEIPT');

    mockMessagesGet.mockImplementation(async ({ id }: { id: string }) =>
      id === 'orig-1'
        ? {
            data: {
              id: 'orig-1',
              threadId: 't-1',
              payload: {
                headers: [
                  { name: 'From', value: 'clinic@example.com' },
                  { name: 'Subject', value: 'Your visit' },
                ],
              },
            },
          }
        : sentMessageStub
    );

    await service.replyToEmail('user-1', {
      messageId: 'orig-1',
      body: 'Here it is.',
      attachments: [{ path: file }],
    });

    const message = sentRaw();
    expect(message).toContain('Content-Disposition: attachment; filename="receipt.pdf"');
    expect(message).toContain(Buffer.from('RECEIPT').toString('base64'));
  });
});

describe('createDraft with attachments', () => {
  it('carries attachments into the draft', async () => {
    const file = join(root, 'agenda.pdf');
    await writeFile(file, 'AGENDA');

    await service.createDraft('user-1', {
      to: ['a@b.com'],
      subject: 'Agenda',
      body: 'See attached.',
      attachments: [{ path: file }],
    });

    const raw = mockDraftsCreate.mock.calls[0][0].requestBody.message.raw;
    const message = Buffer.from(raw, 'base64url').toString('utf8');
    expect(message).toContain('Content-Disposition: attachment; filename="agenda.pdf"');
    expect(message).toContain(Buffer.from('AGENDA').toString('base64'));
  });

  it('creates no draft when an attachment is rejected', async () => {
    await expect(
      service.createDraft('user-1', {
        to: ['a@b.com'],
        subject: 'x',
        body: 'y',
        attachments: [{ path: join(root, 'missing.pdf') }],
      })
    ).rejects.toThrow(/could not be resolved/);
    expect(mockDraftsCreate).not.toHaveBeenCalled();
  });
});
