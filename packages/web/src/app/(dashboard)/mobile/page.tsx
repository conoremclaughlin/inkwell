'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Loader2, QrCode, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react';
import { useApiPost } from '@/lib/api';

interface PairResponse {
  code: string;
  expiresAt: string;
  expiresInSeconds: number;
  urls: string[];
  /** True when any advertised URL is plain http — development only. */
  insecureTransport: boolean;
  development: boolean;
  qrDataUrl: string;
}

function formatCountdown(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Pair a phone with this account. The server mints a single-use code and
 * renders the QR itself; this page only shows it, counts it down, and offers
 * a fresh one when it lapses. Nothing here is secret beyond the code, and
 * the code stops working the moment a phone claims it or ten minutes pass.
 */
export default function MobilePage() {
  const pair = useApiPost<PairResponse>('/api/admin/auth/mobile-pair');
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null);

  useEffect(() => {
    const expiresAt = pair.data?.expiresAt;
    if (!expiresAt) return;
    const tick = () =>
      setSecondsLeft(Math.max(0, Math.round((new Date(expiresAt).getTime() - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [pair.data?.expiresAt]);

  const expired = secondsLeft === 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Mobile</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Follow threads, watch the fleet, and reply from your phone.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <QrCode className="h-4 w-4" />
              Pair your phone
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
              <li>Open the Inkwell app on your phone.</li>
              <li>
                Tap <span className="font-medium text-foreground">Scan a pairing code</span>.
              </li>
              <li>Point it at the code below. The app finds this server on its own.</li>
            </ol>

            {!pair.data ? (
              <Button onClick={() => pair.mutate()} disabled={pair.isPending}>
                {pair.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <QrCode className="mr-2 h-4 w-4" />
                )}
                Show pairing code
              </Button>
            ) : (
              <div className="flex flex-col items-start gap-5 sm:flex-row">
                <div className="relative shrink-0">
                  {/* eslint-disable-next-line @next/next/no-img-element -- server-rendered data URL */}
                  <img
                    src={pair.data.qrDataUrl}
                    alt="Pairing QR code"
                    width={256}
                    height={256}
                    className={`h-64 w-64 rounded-lg bg-white p-2 ${expired ? 'opacity-20' : ''}`}
                  />
                  {expired ? (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Button size="sm" onClick={() => pair.mutate()} disabled={pair.isPending}>
                        <RefreshCw className="mr-2 h-3.5 w-3.5" />
                        New code
                      </Button>
                    </div>
                  ) : null}
                </div>
                <div className="space-y-3 text-sm">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      Can&apos;t scan? Type this in the app
                    </div>
                    <div className="mt-1 font-mono text-2xl tracking-[0.2em]">{pair.data.code}</div>
                  </div>
                  <div className="text-muted-foreground">
                    {expired ? (
                      'This code has expired.'
                    ) : secondsLeft != null ? (
                      <>
                        Expires in{' '}
                        <span className="font-mono text-foreground">
                          {formatCountdown(secondsLeft)}
                        </span>
                        . Single use.
                      </>
                    ) : null}
                  </div>
                  {pair.data.urls.length > 0 ? (
                    <div>
                      <div className="text-xs uppercase tracking-wide text-muted-foreground">
                        The app will try
                      </div>
                      <ul className="mt-1 space-y-0.5 font-mono text-xs text-muted-foreground">
                        {pair.data.urls.map((url) => (
                          <li key={url}>{url}</li>
                        ))}
                      </ul>
                      {pair.data.insecureTransport ? (
                        <p className="mt-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
                          <strong>Development only.</strong> These are plain-HTTP LAN addresses: the
                          pairing token crosses your network in cleartext. Pair only on a network
                          you trust. A production server advertises HTTPS only.
                        </p>
                      ) : null}
                      <p className="mt-2 text-xs text-muted-foreground">
                        Typed codes use the server the app already points at (Settings on the
                        phone). A phone on another network needs a public HTTPS URL — set{' '}
                        <code>MCP_BASE_URL</code> on the server.
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-amber-600">
                      {pair.data.development
                        ? 'No reachable address to advertise — the phone will need the server URL typed in its Settings.'
                        : 'No HTTPS address to advertise — a production server only pairs over TLS. Set MCP_BASE_URL to your https URL.'}
                    </p>
                  )}
                  {!expired ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => pair.mutate()}
                      disabled={pair.isPending}
                    >
                      <RefreshCw className="mr-2 h-3.5 w-3.5" />
                      New code
                    </Button>
                  ) : null}
                </div>
              </div>
            )}

            {pair.error ? (
              <p className="text-sm text-destructive">
                {pair.error.message || 'Could not create a pairing code'}
              </p>
            ) : null}
          </CardContent>
        </Card>

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="h-4 w-4" />
                What pairing grants
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                The phone receives the same sign-in the dashboard uses, valid for 90 days and
                refreshed automatically while the app is in use.
              </p>
              <p>
                Signing out on the phone revokes its token. A pairing code works exactly once and
                dies after ten minutes whether or not it was used.
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Smartphone className="h-4 w-4" />
                Getting the app
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              <p>
                The app lives in <code>packages/mobile</code>. While it is an experiment, run it
                with Expo from the repo:
              </p>
              <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                {'cd packages/mobile\nnpx expo start'}
              </pre>
              <p>Then open it in the iOS simulator, or in Expo Go on a phone on the same Wi‑Fi.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
