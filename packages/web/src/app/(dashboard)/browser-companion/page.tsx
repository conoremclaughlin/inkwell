'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  assertFresh,
  formatBrowserRequest,
  parseSnapshot,
  privacySignals,
  proposalFromMessage,
  type BrowserSnapshot,
} from '@inklabs/browser-companion/protocol';
import { apiPost, useApiQuery } from '@/lib/api';

interface Message {
  id: string;
  senderSlug: string;
  content: string;
  metadata?: { triggerFailure?: boolean };
}
interface SendResult {
  messageId?: string;
  warning?: string | null;
}

/** Auth stays in the ordinary dashboard. The bridge can stage untrusted data
 * and propose changes, never invoke authenticated API calls on its own.
 */
export default function BrowserCompanionPage() {
  const [offer, setOffer] = useState<{ bridgeId: string; snapshot: BrowserSnapshot } | null>(null);
  const offerRef = useRef(offer);
  const [nextOffer, setNextOffer] = useState<typeof offer>(null);
  const [instruction, setInstruction] = useState('');
  const [recipient, setRecipient] = useState('');
  const [status, setStatus] = useState(
    'Waiting for a capture. Open the extension on a page, capture, then choose “Review in Inkwell”.'
  );
  const [attempted, setAttempted] = useState(false);
  const attemptedRef = useRef(false);
  // Keep the attempted key even if the storage receipt is lost. Recovery
  // reads this exact thread, rather than risking a duplicate send.
  const [sentKey, setSentKey] = useState('');
  const capture = offer?.snapshot;
  const privacyHints = useMemo(() => (capture ? privacySignals(capture) : ''), [capture]);
  const { data: people, error: peopleError } = useApiQuery<{
    individuals: Array<{ sbSlug: string; name: string }>;
  }>(['companion-recipients'], '/api/admin/individuals');
  const { data: replies, error: repliesError } = useApiQuery<{
    messages: Message[];
    meta?: { truncated?: boolean };
  }>(
    ['companion-replies', sentKey],
    `/api/admin/threads/messages?key=${encodeURIComponent(sentKey)}`,
    { enabled: !!sentKey, refetchInterval: sentKey ? 5000 : false }
  );

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      const message = event.data;
      if (
        message?.type === 'inkwell:offer' &&
        typeof message.bridgeId === 'string' &&
        /^[0-9a-f-]{36}$/.test(message.bridgeId)
      ) {
        try {
          const snapshot = parseSnapshot(message.snapshot);
          assertFresh(snapshot);
          if (offerRef.current && offerRef.current.snapshot.id !== snapshot.id) {
            setNextOffer({ snapshot, bridgeId: message.bridgeId });
            return;
          }
          const next = { snapshot, bridgeId: message.bridgeId };
          if (!offerRef.current) {
            offerRef.current = next;
            setOffer(next);
            setStatus(
              'Capture received locally in this dashboard. Nothing has been sent to an SB.'
            );
          } else if (offerRef.current.bridgeId !== next.bridgeId) {
            // Reopening the same capture rotates its bridge without creating
            // another send opportunity or losing the existing conversation.
            offerRef.current = next;
            setOffer(next);
          }
          window.postMessage(
            { type: 'inkwell:received', bridgeId: message.bridgeId },
            window.location.origin
          );
        } catch {
          setStatus('Rejected an invalid or expired capture. Capture the source page again.');
        }
      }
      if (
        message?.type === 'inkwell:proposal-receipt' &&
        message.bridgeId === offerRef.current?.bridgeId
      ) {
        setStatus(
          message.result?.ok
            ? 'Proposal is in the extension panel. Review there; nothing has been filled.'
            : 'The extension could not accept the proposal. Reopen its panel or recapture.'
        );
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, []);

  let payload = '';
  try {
    if (offer) payload = formatBrowserRequest(offer.snapshot, instruction);
  } catch {
    /* Invalid/incomplete drafts are unsendable. */
  }
  async function send() {
    if (!offer || !payload || !recipient || attemptedRef.current) return;
    try {
      assertFresh(offer.snapshot);
    } catch {
      setStatus('Capture expired. Recapture before sending.');
      return;
    }
    try {
      attemptedRef.current = true;
      setAttempted(true);
      const key = `thread:browser-${offer.snapshot.id}`;
      setSentKey(key);
      const result = await apiPost<SendResult>('/api/admin/threads', {
        key,
        recipients: [recipient],
        content: payload,
        title: 'Browser assistance',
      });
      if (offerRef.current?.snapshot.id !== offer.snapshot.id) return;
      if (!result.messageId) throw new Error('No storage receipt');
      setStatus(
        result.warning
          ? `Stored in the thread. Delivery warning: ${result.warning}`
          : 'Stored in the thread; awaiting a reply. Storage is not proof that the SB has read it.'
      );
    } catch {
      if (offerRef.current?.snapshot.id !== offer.snapshot.id) return;
      setStatus(
        'No confirmed send receipt. Check the Threads page before resending; the request may have been stored. This page will not retry automatically.'
      );
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          Inkwell / Browser companion
        </p>
        <h1 className="mt-2 text-3xl font-semibold">Bring the page into the conversation.</h1>
        <p className="mt-3 text-muted-foreground">
          An explicit handoff, not a browsing recorder. Page content is untrusted and can contain
          private information.
        </p>
      </header>
      <p role="status" className="rounded-lg border p-4">
        {status}
      </p>
      {peopleError && (
        <p role="alert">Could not load recipients. Check your dashboard connection and sign-in.</p>
      )}
      {sentKey && repliesError && (
        <p role="alert">
          Could not refresh replies. The thread may still be progressing; check your connection or
          open Threads.
        </p>
      )}
      {nextOffer && (
        <button
          className="rounded border px-4 py-2"
          onClick={() => {
            offerRef.current = nextOffer;
            setOffer(nextOffer);
            setNextOffer(null);
            attemptedRef.current = false;
            setAttempted(false);
            setSentKey('');
            setStatus(
              'New capture selected. Your instruction is preserved; review the changed payload before sending again.'
            );
            window.postMessage(
              { type: 'inkwell:received', bridgeId: nextOffer.bridgeId },
              window.location.origin
            );
          }}
        >
          Review new capture — keep my instruction
        </button>
      )}
      {offer && (
        <>
          <section className="space-y-3 rounded-lg border p-4">
            <h2 className="font-semibold">Your instruction</h2>
            <p className="break-all text-sm">Source: {offer.snapshot.url}</p>
            <textarea
              aria-label="Instruction"
              className="w-full rounded border bg-background p-3"
              rows={3}
              maxLength={4000}
              value={instruction}
              disabled={attempted}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="What would you like help investigating or drafting?"
            />
            <label className="block">
              Send to{' '}
              <select
                aria-label="Recipient"
                className="ml-2 rounded border bg-background p-2"
                value={recipient}
                disabled={attempted}
                onChange={(e) => setRecipient(e.target.value)}
              >
                <option value="">Choose an SB</option>
                {people?.individuals.map((p) => (
                  <option key={p.sbSlug} value={p.sbSlug}>
                    {p.name || p.sbSlug}
                  </option>
                ))}
              </select>
            </label>
            <p className="text-sm text-muted-foreground">
              A new private Inkwell thread will store this request and share it with the recipient
              and its model provider. Copies can propagate into transcripts, logs or summaries. The
              privacy marker asks SBs not to copy raw page content into memory or relay it
              elsewhere; that is guidance, not enforced deletion. Page text never grants tool
              permissions.
            </p>
          </section>
          <section className="space-y-3 rounded-lg border p-4">
            <h2 className="font-semibold">Exact outgoing message</h2>
            <p className="text-sm">
              Read this before sending. Form values, cookies, query strings and URL fragments are
              excluded; visible text and URL paths may still contain sensitive material.
            </p>
            <p className="text-sm">{privacyHints}</p>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">
              {payload || JSON.stringify(offer.snapshot, null, 2)}
            </pre>
            <button
              className="rounded bg-primary px-4 py-2 text-primary-foreground disabled:opacity-40"
              disabled={!payload || !recipient || attempted}
              onClick={() => void send()}
            >
              Send reviewed context
            </button>
          </section>
          <section className="space-y-3">
            <h2 className="font-semibold">Conversation</h2>
            {sentKey && (
              <a className="underline" href={`/threads?key=${encodeURIComponent(sentKey)}`}>
                Open thread
              </a>
            )}
            {replies?.meta?.truncated && <p>Only the latest 100 messages are shown.</p>}
            {replies?.messages.some(
              (message) =>
                message.senderSlug === 'system' && message.metadata?.triggerFailure === true
            ) && (
              <p role="alert" className="rounded border border-amber-600 p-4">
                A recipient wake-up attempt failed. Your request remains stored, but delivery to the
                running SB is not confirmed. Check the thread for a reply; do not resend
                automatically.
              </p>
            )}
            {replies?.messages.map((message) => {
              const proposal = proposalFromMessage(message.content, offer.snapshot);
              return (
                <article className="space-y-3 rounded-lg border p-4" key={message.id}>
                  <strong>{message.senderSlug}</strong>
                  <pre className="whitespace-pre-wrap break-words text-sm">{message.content}</pre>
                  {proposal && (
                    <button
                      className="rounded border px-4 py-2"
                      onClick={() => {
                        try {
                          assertFresh(offer.snapshot);
                          window.postMessage(
                            { type: 'inkwell:propose', bridgeId: offer.bridgeId, proposal },
                            window.location.origin
                          );
                          setStatus('Offering proposal to the extension. Waiting for its receipt.');
                        } catch {
                          setStatus('Capture expired. Recapture before applying changes.');
                        }
                      }}
                    >
                      Review in extension — does not apply
                    </button>
                  )}
                </article>
              );
            })}
          </section>
        </>
      )}
      <p className="text-sm text-muted-foreground">
        Filling a field can trigger autosave or other site-side actions. The extension asks for
        confirmation before filling and never clicks Submit. If you had to sign in, reopen “Review
        in Inkwell” from the extension afterward. Captures expire after ten minutes.
      </p>
    </div>
  );
}
