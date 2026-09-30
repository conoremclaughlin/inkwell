'use client';

import { AlertTriangle } from 'lucide-react';
import { useApiQuery } from '@/lib/api';

interface HealthResponse {
  build?: {
    updateAvailable?: boolean;
    requiresRestart?: boolean;
    startupGitSha?: string | null;
    currentGitSha?: string | null;
    upstreamRef?: string | null;
    behindOriginApi?: boolean;
    apiBehindOriginCount?: number | null;
    behindOriginCount?: number | null;
    processManager?: 'pm2' | 'direct' | string;
    runMode?: 'prod' | 'dev' | string;
  };
}

function shortSha(value?: string | null): string {
  if (!value) return 'unknown';
  return value.slice(0, 8);
}

/**
 * "3 API commits of 28 total", or a count-free phrase when the number is
 * unknown. `behindOriginApi` can only be true off a known count, so the null
 * branch is defensive, but it must never render "0", which reads as the
 * opposite of what the flag is saying.
 */
function behindPhrase(apiCount?: number | null, totalCount?: number | null): string {
  if (typeof apiCount !== 'number') return 'commits touching the API';
  const plural = apiCount === 1 ? 'commit' : 'commits';
  const total = typeof totalCount === 'number' ? ` of ${totalCount} total` : '';
  return `${apiCount} API ${plural}${total}`;
}

/**
 * A short note in the navigation when a prod server is not running the
 * checkout's code. It used to be a banner above every page, which pushed the
 * page down past the bottom of the viewport; on 2026-09-30 it hid the end of
 * the Threads view (Conor). So it is one line here, with the detail on hover.
 *
 * It asks two questions, because their remedies differ. `updateAvailable`
 * means the tree moved under the running process, and a restart picks it up.
 * `behindOriginApi` means the checkout itself trails its upstream, so a
 * restart alone rebuilds the same commit and it needs a pull first. On
 * 2026-09-18 a server sat 6 API commits behind while the old banner, which
 * asked only the first question, showed nothing.
 *
 * Only for `runMode: 'prod'`. A dev server reloads its own code as it
 * changes, so neither question is worth a note there, and an API too old to
 * report its mode is treated the same way.
 */
export function SystemStatusNote() {
  const { data } = useApiQuery<HealthResponse>(['system-health'], '/api/system/health', {
    refetchInterval: 60_000,
    retry: 1,
  });

  const build = data?.build;
  if (!build || build.runMode !== 'prod') return null;

  const movedOnDisk = build.updateAvailable === true;
  const behindUpstream = build.behindOriginApi === true;
  if (!movedOnDisk && !behindUpstream) return null;

  const upstream = build.upstreamRef || 'origin';
  const headline = behindUpstream ? `Behind ${upstream}` : 'Restart needed';
  const action = behindUpstream
    ? 'Pull, then yarn prod:refresh'
    : 'yarn prod:refresh, then restart';
  const details = [
    `Running ${shortSha(build.startupGitSha)}.`,
    behindUpstream
      ? `Missing at least ${behindPhrase(build.apiBehindOriginCount, build.behindOriginCount)} as of the last fetch. A rebuild alone rebuilds the same commit: pull first, then yarn prod:refresh and restart.`
      : null,
    movedOnDisk
      ? `The checkout moved to ${shortSha(build.currentGitSha)} since the server started: yarn prod:refresh, then restart.`
      : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      role="status"
      title={details}
      className="mb-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-snug text-amber-300"
    >
      <p className="flex items-center gap-1.5 font-medium">
        <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden />
        {headline}
        {behindUpstream && movedOnDisk ? ' · restart needed' : ''}
      </p>
      <p className="mt-0.5 text-amber-300/80">{action}</p>
      <span className="sr-only">{details}</span>
    </div>
  );
}
