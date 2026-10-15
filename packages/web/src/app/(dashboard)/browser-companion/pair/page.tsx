'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { parsePairingOffer } from '@inklabs/browser-companion/protocol';
import { apiPost } from '@/lib/api';
import { getSelectedWorkspaceId, subscribeSelectedWorkspace } from '@/lib/workspace-selection';

/** A link can stage a public commitment, never authorize it. Consent stays here. */
export default function BrowserPairingPage() {
  const workspaceId = useSyncExternalStore(
    subscribeSelectedWorkspace,
    getSelectedWorkspaceId,
    () => null
  );
  const [offer, setOffer] = useState<ReturnType<typeof parsePairingOffer>>(null);
  const [consent, setConsent] = useState(false);
  const [attempt, setAttempt] = useState<{ workspaceId: string | null } | null>(null);
  const attempted = useRef(false);
  const [code, setCode] = useState('');
  const [status, setStatus] = useState('Open this page from the installed extension to begin.');
  useEffect(() => {
    const read = () => {
      if (attempted.current) return;
      const next = parsePairingOffer(window.location.hash);
      setOffer(next);
      setConsent(false);
      setStatus(
        next
          ? 'Review this installation, then choose whether to pair it.'
          : 'No valid installation request. Reopen approval from your extension.'
      );
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);
  useEffect(() => {
    setConsent(false);
  }, [workspaceId]);
  async function approve() {
    if (
      !offer ||
      !consent ||
      attempted.current ||
      workspaceId !== getSelectedWorkspaceId() ||
      JSON.stringify(parsePairingOffer(window.location.hash)) !== JSON.stringify(offer)
    )
      return;
    attempted.current = true;
    setAttempt({ workspaceId });
    setStatus('Requesting a pairing code for this workspace…');
    try {
      const result = await apiPost<{
        installationId: string;
        pairingCode: string;
        pairingCodeExpiresAt: string;
      }>('/api/admin/browser-companion/pairing-code', offer, { workspaceId });
      if (
        result.installationId !== offer.installationId ||
        typeof result.pairingCode !== 'string' ||
        !/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{12}$/.test(result.pairingCode.replace(/-/g, '')) ||
        !Number.isFinite(Date.parse(result.pairingCodeExpiresAt)) ||
        Date.parse(result.pairingCodeExpiresAt) <= Date.now()
      )
        throw new Error('Invalid pairing receipt.');
      setCode(result.pairingCode);
      setStatus(
        'Code created. Enter it only in the extension that opened this request. The code expires in ten minutes.'
      );
    } catch {
      setStatus(
        'No confirmed pairing-code receipt. A code may have been created, but this page will not retry automatically. Reopen approval from the extension if you need a new code.'
      );
    }
  }
  const scope = attempt ? attempt.workspaceId : workspaceId;
  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <header>
        <p className="text-xs uppercase tracking-widest text-muted-foreground">
          Inkwell / Browser companion
        </p>
        <h1 className="mt-2 text-3xl font-semibold">Pair this browser.</h1>
        <p className="mt-3 text-muted-foreground">
          A temporary connection to Inkwell, not permission to read or change a page.
        </p>
      </header>
      <div className="space-y-3 rounded-lg border p-5">
        <p className="break-all">
          <strong>Workspace:</strong> {scope ?? 'Account default'}
        </p>
        {attempt && scope !== workspaceId && (
          <p>The sidebar selection changed. This receipt still belongs to the workspace above.</p>
        )}
        {offer && (
          <p className="break-all">
            <strong>Installation:</strong> {offer.installationId}
          </p>
        )}
        <p>
          Only approve a request you opened from your installed extension. Never approve a pairing
          link sent by someone else.
        </p>
        <p>
          Pairing material lasts for this browser session; the server grant expires after twelve
          hours. Pairing does not start a model turn or grant page access.
        </p>
        {!attempt && (
          <>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={consent}
                disabled={!offer}
                onChange={(event) => setConsent(event.target.checked)}
                className="mt-1"
              />
              <span>
                I started this request in my extension and want to pair it with this workspace.
              </span>
            </label>
            <button
              className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
              disabled={!offer || !consent}
              onClick={() => void approve()}
            >
              Create pairing code
            </button>
          </>
        )}
      </div>
      {code && (
        <div className="rounded-lg border p-5">
          <p>Enter in the extension</p>
          <code className="mt-2 block break-all text-2xl tracking-widest">{code}</code>
        </div>
      )}
      <p role="status" className="rounded-lg border p-4">
        {status}
      </p>
      <p className="text-sm text-muted-foreground">
        This checkpoint connects the installation only. Hosted side-panel chat and page admission
        are not enabled yet.
      </p>
    </div>
  );
}
