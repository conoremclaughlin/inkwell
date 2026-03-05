import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Deterministic gradient color for SB avatars.
 * Always key on agentId (the stable handle) for consistency across pages.
 */
const SB_GRADIENTS = [
  'from-rose-500 to-pink-600',
  'from-sky-500 to-blue-600',
  'from-emerald-500 to-teal-600',
  'from-amber-500 to-orange-600',
  'from-violet-500 to-purple-600',
  'from-cyan-500 to-teal-600',
  'from-indigo-500 to-blue-600',
  'from-fuchsia-500 to-pink-600',
];

export function getAgentGradient(agentId: string): string {
  let hash = 0;
  for (let i = 0; i < agentId.length; i++) {
    hash = agentId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return SB_GRADIENTS[Math.abs(hash) % SB_GRADIENTS.length];
}

/**
 * Parse studio slug from worktree folder convention: "<repo>--<slug>".
 * Uses the first "--" because the slug itself may include "--".
 */
export function deriveStudioSlugFromWorktreePath(worktreePath: string | null): string | null {
  if (!worktreePath) return null;
  const folder = worktreePath.split('/').pop() || '';
  const separatorIdx = folder.indexOf('--');
  if (separatorIdx === -1) return null;
  return folder.slice(separatorIdx + 2) || null;
}

/**
 * Derive repo display name from repoRoot with worktree fallback.
 * Fallback also supports repo names containing "--" via lastIndexOf.
 */
export function deriveRepoName(
  repoRoot: string | null,
  worktreePath?: string | null
): string | null {
  if (repoRoot) {
    const normalized = repoRoot.replace(/\/+$/, '');
    const parts = normalized.split('/');
    return parts[parts.length - 1] || normalized;
  }

  const folder = worktreePath?.split('/').pop() || '';
  const separatorIdx = folder.lastIndexOf('--');
  if (separatorIdx === -1) return null;
  return folder.slice(0, separatorIdx) || null;
}
