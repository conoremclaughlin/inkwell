'use client';

import { AlertTriangle } from 'lucide-react';
import { useApiQuery } from '@/lib/api';

interface HealthResponse {
  build?: {
    updateAvailable?: boolean;
    requiresRestart?: boolean;
    startupGitSha?: string | null;
    currentGitSha?: string | null;
    processManager?: 'pm2' | 'direct' | string;
  };
}

function shortSha(value?: string | null): string {
  if (!value) return 'unknown';
  return value.slice(0, 8);
}

export function SystemStatusBanner() {
  const { data } = useApiQuery<HealthResponse>(['system-health'], '/api/system/health', {
    refetchInterval: 60_000,
    retry: 1,
  });

  const build = data?.build;
  if (!build?.updateAvailable) {
    return null;
  }

  const managerLabel = build.processManager === 'pm2' ? 'PM2' : 'direct';

  return (
    <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900">
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="text-sm">
          <p className="font-semibold">New code is available — restart required</p>
          <p className="mt-0.5">
            Running commit <code>{shortSha(build.startupGitSha)}</code>, latest local commit{' '}
            <code>{shortSha(build.currentGitSha)}</code>. This server is running in{' '}
            <strong>{managerLabel}</strong> mode.
          </p>
          <p className="mt-1">
            Recommended: run <code>yarn prod:refresh</code>, then restart the running server
            process.
          </p>
        </div>
      </div>
    </div>
  );
}
