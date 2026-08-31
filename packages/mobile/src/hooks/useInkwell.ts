/**
 * Query hooks over the admin API. Polling intervals are the product decision
 * here: the thread you are LOOKING AT refreshes fast enough to feel live
 * (7s), the lists amble along at 20s, and everything refetches on focus so
 * returning to the app never shows stale data for long.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import type {
  ReplyResponse,
  SessionsResponse,
  ThreadMessagesResponse,
  ThreadsResponse,
} from '../lib/types';

const THREAD_LIST_POLL_MS = 20_000;
const THREAD_DETAIL_POLL_MS = 7_000;
const FLEET_POLL_MS = 20_000;

export function useThreads() {
  return useQuery({
    queryKey: ['threads'],
    queryFn: () => apiFetch<ThreadsResponse>('/api/admin/threads'),
    refetchInterval: THREAD_LIST_POLL_MS,
  });
}

export function useThreadMessages(threadKey: string) {
  return useQuery({
    queryKey: ['thread', threadKey],
    queryFn: () =>
      apiFetch<ThreadMessagesResponse>(
        `/api/admin/threads/messages?key=${encodeURIComponent(threadKey)}`
      ),
    refetchInterval: THREAD_DETAIL_POLL_MS,
  });
}

export function useSessions() {
  return useQuery({
    queryKey: ['sessions'],
    queryFn: () => apiFetch<SessionsResponse>('/api/admin/sessions'),
    refetchInterval: FLEET_POLL_MS,
  });
}

export function useSendReply(threadKey: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (content: string) =>
      apiFetch<ReplyResponse>('/api/admin/threads/reply', {
        method: 'POST',
        body: JSON.stringify({ key: threadKey, content }),
      }),
    // Refetch rather than optimistic-insert: the server assigns id/timestamp
    // and the trigger outcome, and a 7s-polling screen makes the round-trip
    // invisible in practice.
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['thread', threadKey] });
      void queryClient.invalidateQueries({ queryKey: ['threads'] });
    },
  });
}
