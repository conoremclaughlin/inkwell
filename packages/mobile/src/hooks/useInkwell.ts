/**
 * Query hooks over the admin API. Polling intervals are the product decision
 * here: the thread you are LOOKING AT refreshes fast enough to feel live
 * (7s), the lists amble along at 20s, and everything refetches on focus so
 * returning to the app never shows stale data for long.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { apiFetch } from '../lib/api';
import { getWorkspaceId, setWorkspaceId } from '../lib/storage';
import type {
  IndividualsResponse,
  ReplyResponse,
  StartThreadInput,
  StartThreadResponse,
  SessionConversationResponse,
  SessionLogsResponse,
  SessionsResponse,
  ThreadMessagesResponse,
  ThreadsResponse,
  WorkspacesResponse,
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

export function useSessions(includeCompleted = false) {
  return useQuery({
    queryKey: ['sessions', { includeCompleted }],
    queryFn: () =>
      apiFetch<SessionsResponse>(
        includeCompleted ? '/api/admin/sessions?includeCompleted=true' : '/api/admin/sessions'
      ),
    // History changes when a session ends, not second to second.
    refetchInterval: includeCompleted ? FLEET_POLL_MS * 3 : FLEET_POLL_MS,
  });
}

const SESSION_DETAIL_POLL_MS = 10_000;

/**
 * Raw transcript events for one session. Polled while the session is alive
 * (the transcript grows), left alone once it has ended. `retry: false`
 * because a 404 here is the signal to fall back to /logs, not to keep asking.
 */
export function useSessionConversation(sessionId: string) {
  return useQuery({
    queryKey: ['session-conversation', sessionId],
    queryFn: () =>
      apiFetch<SessionConversationResponse>(`/api/admin/sessions/${sessionId}/conversation`),
    retry: false,
    refetchInterval: (query) => {
      const lifecycle = query.state.data?.session.lifecycle;
      return lifecycle === 'running' || lifecycle === 'idle' || lifecycle === 'compacting'
        ? SESSION_DETAIL_POLL_MS
        : false;
    },
  });
}

/** Merged logs — the fallback when no transcript is available for a session. */
export function useSessionLogs(sessionId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['session-logs', sessionId],
    queryFn: () =>
      apiFetch<SessionLogsResponse>(
        `/api/admin/sessions/${sessionId}/logs?limit=200&offset=0&includeLocal=true`
      ),
    enabled,
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

export function useWorkspaces() {
  return useQuery({
    queryKey: ['workspaces'],
    queryFn: () => apiFetch<WorkspacesResponse>('/api/admin/workspaces'),
    staleTime: 60_000,
  });
}

/**
 * Switching workspace changes the answer to every other query, so everything
 * except the workspace list is RESET — back to its initial state, with active
 * observers refetching — rather than merely invalidated: an invalidated query
 * keeps showing the old workspace's data until the refetch lands, which reads
 * as "the switch didn't work". Not removed, either: evicting a query that a
 * mounted screen still observes leaves that observer fetching forever
 * (TanStack Query's documented caveat, and a spinner that never stopped in
 * the simulator).
 */
export function useSwitchWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (workspaceId: string | null) => {
      if (workspaceId === getWorkspaceId()) return;
      await setWorkspaceId(workspaceId);
    },
    onSuccess: () => void resetQueriesForWorkspaceSwitch(queryClient),
  });
}

/** Exported for the test that mounts a real observer across a switch. */
export async function resetQueriesForWorkspaceSwitch(queryClient: QueryClient): Promise<void> {
  await Promise.all([
    queryClient.resetQueries({ predicate: (q) => q.queryKey[0] !== 'workspaces' }),
    queryClient.invalidateQueries({ queryKey: ['workspaces'] }),
  ]);
}

/** The SBs in the selected workspace — the Chat tab's roster. */
export function useIndividuals() {
  return useQuery({
    queryKey: ['individuals'],
    queryFn: () => apiFetch<IndividualsResponse>('/api/admin/individuals'),
    staleTime: 60_000,
  });
}

/**
 * Start a thread (or continue one that exists under the key) with explicit
 * participants. Used for the first message of a DM and for New thread.
 */
export function useStartThread() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: StartThreadInput) =>
      apiFetch<StartThreadResponse>('/api/admin/threads', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ['thread', result.threadKey] });
      void queryClient.invalidateQueries({ queryKey: ['threads'] });
    },
  });
}
