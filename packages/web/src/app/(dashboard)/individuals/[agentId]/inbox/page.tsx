'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ArrowLeft,
  ChevronRight,
  ChevronLeft,
  Inbox,
  Mail,
  MessageSquare,
  AlertCircle,
  User,
  X,
} from 'lucide-react';
import { useApiQuery } from '@/lib/api';
import clsx from 'clsx';

interface InboxMessage {
  id: string;
  subject: string | null;
  content: string;
  messageType: string;
  priority: string;
  status: string;
  senderAgentId: string | null;
  threadKey: string | null;
  relatedSessionId: string | null;
  relatedArtifactUri: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  readAt: string | null;
  acknowledgedAt: string | null;
  expiresAt: string | null;
}

interface ThreadGroup {
  threadKey: string;
  messageCount: number;
  unreadCount: number;
  latestMessage: InboxMessage;
  participants: string[];
  firstMessageAt: string;
  lastMessageAt: string;
  messages: InboxMessage[];
}

interface InboxResponse {
  agentId: string;
  stats: {
    totalMessages: number;
    unreadCount: number;
    threadCount: number;
    flatCount: number;
  };
  threads: ThreadGroup[];
  flatMessages: InboxMessage[];
  pagination: {
    limit: number;
    offset: number;
    totalThreads: number;
    hasMore: boolean;
  };
}

interface IndividualsResponse {
  individuals: { agentId: string; name: string }[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatRelativeTime(date: string): string {
  const now = new Date();
  const target = new Date(date);
  const diffMs = now.getTime() - target.getTime();
  const diffMins = Math.round(diffMs / 60000);
  const diffHours = Math.round(diffMs / 3600000);
  const diffDays = Math.round(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function formatTimestamp(date: string): string {
  const d = new Date(date);
  const today = new Date();
  const isToday = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return isToday
    ? `Today at ${time}`
    : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} at ${time}`;
}

const priorityColors: Record<string, string> = {
  urgent: 'bg-red-100 text-red-700',
  high: 'bg-orange-100 text-orange-700',
  normal: 'bg-gray-100 text-gray-600',
  low: 'bg-gray-50 text-gray-400',
};

const typeColors: Record<string, string> = {
  message: 'bg-slate-100 text-slate-700',
  task_request: 'bg-purple-100 text-purple-700',
  session_resume: 'bg-blue-100 text-blue-700',
  notification: 'bg-amber-100 text-amber-700',
};

const agentColorPalette = [
  'bg-blue-600',
  'bg-green-600',
  'bg-purple-600',
  'bg-orange-600',
  'bg-pink-600',
  'bg-teal-600',
  'bg-indigo-600',
  'bg-rose-600',
];

function agentColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return agentColorPalette[Math.abs(hash) % agentColorPalette.length];
}

// ---------------------------------------------------------------------------
// MessageItem — Discord/Slack-style chat bubble
// ---------------------------------------------------------------------------

function MessageItem({ message, compact }: { message: InboxMessage; compact?: boolean }) {
  const sender = message.senderAgentId || 'unknown';
  const isAgent = !!message.senderAgentId;

  return (
    <div
      className={clsx(
        'group flex gap-3 rounded-md px-3 hover:bg-gray-50/50',
        compact ? 'py-0.5' : 'py-2'
      )}
    >
      {/* Avatar */}
      {!compact ? (
        <div
          className={clsx(
            'flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-white text-xs font-semibold',
            isAgent ? agentColor(sender) : 'bg-gray-400'
          )}
        >
          {isAgent ? sender.slice(0, 2).toUpperCase() : <User className="h-4 w-4" />}
        </div>
      ) : (
        <div className="w-9 shrink-0" />
      )}

      {/* Content */}
      <div className="min-w-0 flex-1">
        {!compact && (
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-sm font-semibold text-gray-900">{sender}</span>
            <span className="text-xs text-gray-400">{formatTimestamp(message.createdAt)}</span>
            {message.messageType !== 'message' && (
              <Badge
                className={clsx(
                  'text-[10px] px-1.5 py-0',
                  typeColors[message.messageType] || typeColors.message
                )}
              >
                {message.messageType.replace('_', ' ')}
              </Badge>
            )}
            {message.priority !== 'normal' && (
              <Badge
                className={clsx(
                  'text-[10px] px-1.5 py-0',
                  priorityColors[message.priority] || priorityColors.normal
                )}
              >
                {message.priority}
              </Badge>
            )}
            {message.relatedSessionId && (
              <Link
                href={`/sessions/${message.relatedSessionId}`}
                className="text-[10px] text-blue-500 hover:text-blue-700 hover:underline"
              >
                session
              </Link>
            )}
            {message.status === 'unread' && <span className="h-2 w-2 rounded-full bg-blue-500" />}
          </div>
        )}
        {message.subject && <p className="text-sm font-medium text-gray-800">{message.subject}</p>}
        <p className="whitespace-pre-wrap break-words text-sm text-gray-700">{message.content}</p>
        {message.relatedArtifactUri && (
          <div className="mt-1 text-xs text-gray-400">
            <span className="font-mono">{message.relatedArtifactUri}</span>
          </div>
        )}
      </div>

      {/* Hover timestamp for compact messages */}
      {compact && (
        <span className="shrink-0 text-[10px] text-gray-300 opacity-0 group-hover:opacity-100 transition-opacity self-center">
          {new Date(message.createdAt).toLocaleTimeString([], {
            hour: 'numeric',
            minute: '2-digit',
          })}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ThreadRow — clickable row in the list (no expand, opens slide-out)
// ---------------------------------------------------------------------------

function ThreadRow({
  thread,
  isActive,
  onClick,
}: {
  thread: ThreadGroup;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors',
        isActive
          ? 'border-blue-300 bg-blue-50/50 ring-1 ring-blue-200'
          : 'border-gray-200 bg-white hover:bg-gray-50/50'
      )}
    >
      {/* Stacked participant avatars */}
      <div className="flex -space-x-2 shrink-0">
        {thread.participants.slice(0, 3).map((p) => (
          <div
            key={p}
            className={clsx(
              'flex h-7 w-7 items-center justify-center rounded-full text-white text-[10px] font-semibold ring-2 ring-white',
              agentColor(p)
            )}
            title={p}
          >
            {p.slice(0, 2).toUpperCase()}
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs shrink-0">
            {thread.threadKey}
          </Badge>
          <span className="text-xs text-gray-500">{thread.messageCount} msgs</span>
          {thread.unreadCount > 0 && (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-blue-500 px-1.5 text-[10px] font-semibold text-white">
              {thread.unreadCount}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-sm text-gray-600 truncate">
          {thread.latestMessage.subject || thread.latestMessage.content}
        </p>
      </div>
      <div className="shrink-0 text-right">
        <span className="text-xs text-gray-400">{formatRelativeTime(thread.lastMessageAt)}</span>
        <ChevronRight className="mt-0.5 ml-auto h-4 w-4 text-gray-300" />
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// ThreadPanel — slide-out from right showing full conversation
// ---------------------------------------------------------------------------

function ThreadPanel({
  thread,
  messages,
  agentId,
  onClose,
}: {
  thread?: ThreadGroup;
  messages?: InboxMessage[];
  agentId: string;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when thread changes
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [thread?.threadKey, messages?.[0]?.id]);

  const displayMessages = thread?.messages || messages || [];
  const title = thread?.threadKey || 'Message';

  return (
    <div
      ref={panelRef}
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-lg flex-col border-l border-gray-200 bg-white shadow-xl animate-in slide-in-from-right duration-200"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-gray-500" />
            <h2 className="text-sm font-semibold text-gray-900 truncate">{title}</h2>
          </div>
          {thread && (
            <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-500">
              <span>{thread.messageCount} messages</span>
              <span>&middot;</span>
              <span>
                {thread.participants.join(', ')} &rarr; {agentId}
              </span>
            </div>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} className="shrink-0">
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-1 py-3">
        {displayMessages.map((msg, i) => {
          const prevMsg = i > 0 ? displayMessages[i - 1] : null;
          const sameSender = prevMsg?.senderAgentId === msg.senderAgentId;
          return <MessageItem key={msg.id} message={msg} compact={sameSender} />;
        })}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// InboxPage
// ---------------------------------------------------------------------------

export default function InboxPage() {
  const params = useParams();
  const agentId = params.agentId as string;

  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const limit = 20;

  // Panel state: either a thread key or a flat message id
  const [activeThread, setActiveThread] = useState<string | null>(null);
  const [activeMessage, setActiveMessage] = useState<string | null>(null);

  const closePanel = useCallback(() => {
    setActiveThread(null);
    setActiveMessage(null);
  }, []);

  // Close panel on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closePanel();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [closePanel]);

  const queryPath = useMemo(() => {
    const qp = new URLSearchParams();
    qp.set('limit', String(limit));
    qp.set('offset', String(offset));
    if (statusFilter !== 'all') qp.set('status', statusFilter);
    if (typeFilter) qp.set('messageType', typeFilter);
    return `/api/admin/individuals/${agentId}/inbox?${qp.toString()}`;
  }, [agentId, statusFilter, typeFilter, offset]);

  const { data, isLoading, error } = useApiQuery<InboxResponse>(
    ['individuals', agentId, 'inbox', statusFilter, typeFilter, offset],
    queryPath,
    { refetchInterval: 15000 }
  );

  const { data: individualsData } = useApiQuery<IndividualsResponse>(
    ['individuals'],
    '/api/admin/individuals'
  );

  const agentName =
    individualsData?.individuals.find((i) => i.agentId === agentId)?.name || agentId;

  const stats = data?.stats;
  const threads = data?.threads || [];
  const flatMessages = data?.flatMessages || [];
  const pagination = data?.pagination;

  const selectedThread = activeThread
    ? threads.find((t) => t.threadKey === activeThread)
    : undefined;
  const selectedMessage = activeMessage
    ? flatMessages.find((m) => m.id === activeMessage)
    : undefined;
  const panelOpen = !!selectedThread || !!selectedMessage;

  return (
    <div>
      <div className="mb-4">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/individuals">
            <ArrowLeft className="mr-1 h-4 w-4" />
            Back to Individuals
          </Link>
        </Button>
      </div>

      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900">
          <Inbox className="mr-2 inline h-8 w-8" />
          {agentName}&apos;s Inbox
        </h1>
        {stats && (
          <div className="mt-2 flex items-center gap-3">
            <Badge variant="outline">{stats.totalMessages} total</Badge>
            {stats.unreadCount > 0 && (
              <Badge className="bg-blue-100 text-blue-700">{stats.unreadCount} unread</Badge>
            )}
            <Badge variant="outline">{stats.threadCount} threads</Badge>
            <Badge variant="outline">{stats.flatCount} direct</Badge>
          </div>
        )}
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 p-4 text-red-700">
          <AlertCircle className="mr-1 inline h-4 w-4" />
          {error.message}
        </div>
      )}

      {/* Filters */}
      <div className="mb-4 flex items-center gap-3">
        <select
          value={statusFilter}
          onChange={(e) => {
            setStatusFilter(e.target.value);
            setOffset(0);
          }}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700"
        >
          <option value="all">All statuses</option>
          <option value="unread">Unread</option>
          <option value="read">Read</option>
          <option value="acknowledged">Acknowledged</option>
          <option value="completed">Completed</option>
        </select>
        <select
          value={typeFilter}
          onChange={(e) => {
            setTypeFilter(e.target.value);
            setOffset(0);
          }}
          className="rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700"
        >
          <option value="">All types</option>
          <option value="message">Message</option>
          <option value="task_request">Task Request</option>
          <option value="session_resume">Session Resume</option>
          <option value="notification">Notification</option>
        </select>
        {(statusFilter !== 'all' || typeFilter) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStatusFilter('all');
              setTypeFilter('');
              setOffset(0);
            }}
          >
            Clear filters
          </Button>
        )}
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-500">Loading inbox...</p>
      ) : threads.length === 0 && flatMessages.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Mail className="mx-auto mb-3 h-12 w-12 text-gray-300" />
            <p className="text-gray-500">No messages found</p>
            <p className="mt-1 text-sm text-gray-400">
              Messages will appear here when other SBs send to {agentName}.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Threaded conversations */}
          {threads.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MessageSquare className="h-5 w-5" />
                  Threads
                </CardTitle>
                <CardDescription>Click a thread to view the full conversation.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {threads.map((thread) => (
                  <ThreadRow
                    key={thread.threadKey}
                    thread={thread}
                    isActive={activeThread === thread.threadKey}
                    onClick={() => {
                      setActiveMessage(null);
                      setActiveThread(activeThread === thread.threadKey ? null : thread.threadKey);
                    }}
                  />
                ))}
              </CardContent>
            </Card>
          )}

          {/* Direct (unthreaded) messages */}
          {flatMessages.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Mail className="h-5 w-5" />
                  Direct Messages
                </CardTitle>
                <CardDescription>
                  Messages without a thread key, routed to {agentName}&apos;s main process.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-1">
                {flatMessages.map((msg) => (
                  <button
                    key={msg.id}
                    onClick={() => {
                      setActiveThread(null);
                      setActiveMessage(activeMessage === msg.id ? null : msg.id);
                    }}
                    className={clsx(
                      'w-full text-left rounded-md transition-colors',
                      activeMessage === msg.id && 'ring-1 ring-blue-200 bg-blue-50/50'
                    )}
                  >
                    <MessageItem message={msg} />
                  </button>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Pagination */}
      {pagination && pagination.totalThreads > limit && (
        <div className="mt-4 flex items-center justify-between border-t border-gray-200 pt-4">
          <p className="text-xs text-gray-500">
            Showing {pagination.offset + 1} -{' '}
            {Math.min(pagination.offset + pagination.limit, pagination.totalThreads)} of{' '}
            {pagination.totalThreads}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.offset === 0}
              onClick={() => setOffset(Math.max(0, pagination.offset - pagination.limit))}
            >
              <ChevronLeft className="mr-1 h-4 w-4" />
              Prev
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!pagination.hasMore}
              onClick={() => setOffset(pagination.offset + pagination.limit)}
            >
              Next
              <ChevronRight className="ml-1 h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Backdrop */}
      {panelOpen && <div className="fixed inset-0 z-30 bg-black/20" onClick={closePanel} />}

      {/* Slide-out panel */}
      {selectedThread && (
        <ThreadPanel thread={selectedThread} agentId={agentId} onClose={closePanel} />
      )}
      {selectedMessage && (
        <ThreadPanel messages={[selectedMessage]} agentId={agentId} onClose={closePanel} />
      )}
    </div>
  );
}
