'use client';

import { Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { parseBrowserRecoveryTarget } from '@inklabs/browser-companion/protocol';
import {
  threadMessagesPath,
  type ThreadMessagesResponse,
} from '@inklabs/shared/stories/threads-api';
import { useWorkspaceApiQuery } from '@/lib/api';

export default function BrowserRecoveryPage() {
  return (
    <Suspense>
      <RecoveryTarget />
    </Suspense>
  );
}

function RecoveryTarget() {
  const params = useSearchParams();
  const target = parseBrowserRecoveryTarget(new URLSearchParams(params.toString()));
  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <header className="space-y-3">
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          Inkwell / Browser companion
        </p>
        <h1 className="text-3xl font-semibold">Check the original conversation.</h1>
        <p className="text-muted-foreground">
          A read-only delivery check. This page does not resend your request, change your dashboard
          workspace, or grant access to a browser page.
        </p>
      </header>
      {target ? (
        <RecoveryMessages key={JSON.stringify(target)} target={target} />
      ) : (
        <p role="alert" className="rounded-lg border p-4">
          This recovery link needs one valid workspace and thread key. Return to the original send
          for its recovery link; no conversation has been read.
        </p>
      )}
    </div>
  );
}

function RecoveryMessages({ target }: { target: { key: string; workspaceId: string | null } }) {
  const result = useWorkspaceApiQuery<ThreadMessagesResponse>(
    ['thread-messages', target.key],
    threadMessagesPath(target.key),
    target.workspaceId,
    { refetchInterval: 5_000 }
  );
  const confirmed = result.data?.thread?.threadKey === target.key;
  return (
    <>
      <section className="space-y-2 rounded-lg border p-4 text-sm">
        <p className="break-all">
          <strong>Original workspace:</strong> {target.workspaceId ?? 'Default personal workspace'}
        </p>
        <p className="break-all">
          <strong>Thread:</strong> {target.key}
        </p>
        <p className="text-muted-foreground">
          Finding a conversation is not confirmation that a particular request was stored,
          delivered, or read. There is no automatic retry.
        </p>
      </section>
      {result.error && (
        <p role="alert" className="rounded-lg border p-4">
          Could not refresh this conversation. Its delivery status is unconfirmed.
          {confirmed && ' Last confirmed messages remain below.'} We will check again.
        </p>
      )}
      {result.isPending && !result.error && <p role="status">Checking the original workspace…</p>}
      {!result.error && !result.isPending && !confirmed && (
        <p role="status">
          {result.data?.thread
            ? 'The response did not match this thread. No messages are shown; we will check again.'
            : 'No conversation was found yet. This is not proof that the send failed; an in-flight request may still arrive. We will check again.'}
        </p>
      )}
      {confirmed && (
        <section className="space-y-4" aria-label="Original conversation">
          <h2 className="text-xl font-semibold">{result.data!.thread!.title || 'Conversation'}</h2>
          {result.data?.meta?.truncated && (
            <p className="text-sm text-muted-foreground">
              Only the latest messages are shown. An older request may be outside this page.
            </p>
          )}
          {result.data!.messages.map((message) => (
            <article key={message.id} className="space-y-2 rounded-lg border p-4">
              <strong>
                {message.senderName ||
                  message.senderSlug ||
                  (message.isOwn ? 'You' : 'Participant')}
              </strong>
              <p className="whitespace-pre-wrap break-words text-sm">{message.content}</p>
            </article>
          ))}
        </section>
      )}
    </>
  );
}
