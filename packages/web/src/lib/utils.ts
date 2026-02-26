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
