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
  };
}

function shortSha(value?: string | null): string {
  if (!value) return 'unknown';
  return value.slice(0, 8);
}

/**
 * "3 API commits of 28 total", or a count-free phrase when the number is
 * unknown. `behindOriginApi` can only be true off a known count, so the null
 * branch is defensive — but it must never render "0", which reads as the
 * opposite of what the flag is saying.
 */
function behindPhrase(apiCount?: number | null, totalCount?: number | null): string {
  if (typeof apiCount !== 'number') return 'commits touching the API';
  const plural = apiCount === 1 ? 'commit' : 'commits';
  const total = typeof totalCount === 'number' ? ` of ${totalCount} total` : '';
  return `${apiCount} API ${plural}${total}`;
}

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="text-sm">
          <p className="font-semibold">{title}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

export function SystemStatusBanner() {
  const { data } = useApiQuery<HealthResponse>(['system-health'], '/api/system/health', {
    refetchInterval: 60_000,
    retry: 1,
  });

  const build = data?.build;

  // Two independent questions with two different remedies, so both are asked
  // and both can render. `updateAvailable` means the tree moved under the
  // running process — a restart picks it up. `behindOriginApi` means the
  // CHECKOUT itself trails its upstream, and a restart alone rebuilds the same
  // commit; that one needs a pull first. Gating this banner on the first alone
  // is why a merged fix could sit undeployed with the dashboard perfectly calm.
  const movedOnDisk = build?.updateAvailable === true;
  const behindUpstream = build?.behindOriginApi === true;
  if (!build || (!movedOnDisk && !behindUpstream)) {
    return null;
  }

  const managerLabel = build.processManager === 'pm2' ? 'PM2' : 'direct';

  return (
    <>
      {movedOnDisk && (
        <Notice title="New code is available — restart required">
          <p className="mt-0.5">
            Running commit <code>{shortSha(build.startupGitSha)}</code>, latest local commit{' '}
            <code>{shortSha(build.currentGitSha)}</code>. This server is running in{' '}
            <strong>{managerLabel}</strong> mode.
          </p>
          <p className="mt-1">
            Recommended: run <code>yarn prod:refresh</code>, then restart the running server
            process.
          </p>
        </Notice>
      )}

      {behindUpstream && (
        <Notice
          title={`This checkout is behind ${build.upstreamRef || 'origin'} — merged code is not running`}
        >
          <p className="mt-0.5">
            Missing at least {behindPhrase(build.apiBehindOriginCount, build.behindOriginCount)}.
            Running commit <code>{shortSha(build.startupGitSha)}</code>.
          </p>
          <p className="mt-1">
            <code>yarn prod:refresh</code> rebuilds the same commit — pull first, then refresh and
            restart.
          </p>
          <p className="mt-1 opacity-75">
            Count is as of the last fetch and its age is not knowable locally, so read it as a lower
            bound.
          </p>
        </Notice>
      )}
    </>
  );
}
