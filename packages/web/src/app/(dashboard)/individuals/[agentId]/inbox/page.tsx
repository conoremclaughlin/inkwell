'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import {
  ArrowLeft,
  ChevronRight,
  ChevronLeft,
  Inbox,
  Info,
  Mail,
  MessageSquare,
  AlertCircle,
  User,
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
  senderIdentityId: string | null;
  recipientAgentId: string;
  recipientIdentityId: string | null;
  threadKey: string | null;
  recipientSessionId: string | null;
  relatedArtifactUri: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  readAt: string | null;
  acknowledgedAt: string | null;
  expiresAt: string | null;
}

interface ThreadGroup {
  threadKey: string;
  counterpart: string;
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

function MessageItem({
  message,
  compact,
  inboxAgentId,
  onShowRouting,
}: {
  message: InboxMessage;
  compact?: boolean;
  inboxAgentId: string;
  onShowRouting?: (message: InboxMessage) => void;
}) {
  const sender = message.senderAgentId || 'unknown';
  const isAgent = !!message.senderAgentId;
  const isSent = message.senderAgentId === inboxAgentId;

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
            {isSent && (
              <span className="text-xs text-gray-400">&rarr; {message.recipientAgentId}</span>
            )}
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
            {message.recipientSessionId && (
              <Link
                href={`/sessions/${message.recipientSessionId}`}
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

      {/* Routing info button (hover) */}
      {onShowRouting && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onShowRouting(message);
          }}
          className="shrink-0 self-center rounded p-1 text-gray-300 opacity-0 transition-opacity hover:bg-gray-100 hover:text-gray-500 group-hover:opacity-100"
          title="Routing details"
        >
          <Info className="h-3.5 w-3.5" />
        </button>
      )}

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
      {/* Counterpart avatar */}
      <div
        className={clsx(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white text-xs font-semibold',
          agentColor(thread.counterpart)
        )}
        title={thread.counterpart}
      >
        {thread.counterpart.slice(0, 2).toUpperCase()}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="font-mono text-xs shrink-0">
            {thread.threadKey}
          </Badge>
          <span className="text-xs text-gray-400">&middot;</span>
          <span className="text-xs font-medium text-gray-700">{thread.counterpart}</span>
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
// ThreadMessages — chat message list rendered inside the Sheet
// ---------------------------------------------------------------------------

function ThreadMessages({
  thread,
  messages,
  agentId,
  onShowRouting,
}: {
  thread?: ThreadGroup;
  messages?: InboxMessage[];
  agentId: string;
  onShowRouting: (message: InboxMessage) => void;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when thread changes
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  }, [thread?.threadKey, messages?.[0]?.id]);

  const displayMessages = thread?.messages || messages || [];

  return (
    <div className="flex-1 overflow-y-auto px-1 py-3">
      {displayMessages.map((msg, i) => {
        const prevMsg = i > 0 ? displayMessages[i - 1] : null;
        const sameSender = prevMsg?.senderAgentId === msg.senderAgentId;
        return (
          <MessageItem
            key={msg.id}
            message={msg}
            compact={sameSender}
            inboxAgentId={agentId}
            onShowRouting={onShowRouting}
          />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// RoutingField — key/value row for the routing detail sheet
// ---------------------------------------------------------------------------

function RoutingField({
  label,
  value,
  mono,
  href,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  href?: string;
}) {
  const display = value || <span className="text-gray-300">--</span>;
  return (
    <div>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className={clsx('mt-0.5', mono && 'font-mono text-xs', !mono && 'text-sm')}>
        {href ? (
          <Link href={href} className="text-blue-600 hover:text-blue-800 hover:underline">
            {display}
          </Link>
        ) : (
          display
        )}
      </dd>
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

  // Routing detail sheet
  const [routingMessage, setRoutingMessage] = useState<InboxMessage | null>(null);

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

  const threadGroupKey = (t: ThreadGroup) => `${t.threadKey}|${t.counterpart}`;
  const selectedThread = activeThread
    ? threads.find((t) => threadGroupKey(t) === activeThread)
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
          className="cursor-pointer appearance-none rounded-md border border-gray-300 bg-white py-1.5 pl-3 pr-8 text-sm text-gray-700 hover:border-gray-400 bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20fill%3D%22none%22%20stroke%3D%22%236b7280%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22m4%206%204%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-[length:16px] bg-[right_8px_center] bg-no-repeat"
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
          className="cursor-pointer appearance-none rounded-md border border-gray-300 bg-white py-1.5 pl-3 pr-8 text-sm text-gray-700 hover:border-gray-400 bg-[url('data:image/svg+xml;charset=utf-8,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20fill%3D%22none%22%20stroke%3D%22%236b7280%22%20stroke-width%3D%222%22%3E%3Cpath%20d%3D%22m4%206%204%204%204-4%22%2F%3E%3C%2Fsvg%3E')] bg-[length:16px] bg-[right_8px_center] bg-no-repeat"
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
                {threads.map((thread) => {
                  const gk = threadGroupKey(thread);
                  return (
                    <ThreadRow
                      key={gk}
                      thread={thread}
                      isActive={activeThread === gk}
                      onClick={() => {
                        setActiveMessage(null);
                        setActiveThread(activeThread === gk ? null : gk);
                      }}
                    />
                  );
                })}
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
                  <div
                    key={msg.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      setActiveThread(null);
                      setActiveMessage(activeMessage === msg.id ? null : msg.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setActiveThread(null);
                        setActiveMessage(activeMessage === msg.id ? null : msg.id);
                      }
                    }}
                    className={clsx(
                      'w-full text-left rounded-md transition-colors cursor-pointer',
                      activeMessage === msg.id && 'ring-1 ring-blue-200 bg-blue-50/50'
                    )}
                  >
                    <MessageItem
                      message={msg}
                      inboxAgentId={agentId}
                      onShowRouting={setRoutingMessage}
                    />
                  </div>
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

      {/* Slide-out panel */}
      <Sheet
        open={panelOpen}
        onOpenChange={(open) => {
          if (!open) {
            setActiveThread(null);
            setActiveMessage(null);
          }
        }}
      >
        <SheetContent side="right" className="flex flex-col p-0">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-gray-500" />
              {selectedThread
                ? `${selectedThread.threadKey} · ${selectedThread.counterpart}`
                : 'Message'}
            </SheetTitle>
            {selectedThread && (
              <SheetDescription>
                {selectedThread.messageCount} messages &middot; {agentId} &harr;{' '}
                {selectedThread.counterpart}
              </SheetDescription>
            )}
          </SheetHeader>
          {(selectedThread || selectedMessage) && (
            <ThreadMessages
              thread={selectedThread}
              messages={selectedMessage ? [selectedMessage] : undefined}
              agentId={agentId}
              onShowRouting={setRoutingMessage}
            />
          )}
        </SheetContent>
      </Sheet>

      {/* Routing detail sheet */}
      <Sheet open={!!routingMessage} onOpenChange={(open) => !open && setRoutingMessage(null)}>
        <SheetContent side="right" className="p-0">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Info className="h-4 w-4 text-gray-500" />
              Message Routing
            </SheetTitle>
            <SheetDescription>Routing and identity details for debugging.</SheetDescription>
          </SheetHeader>
          {routingMessage && (
            <div className="overflow-y-auto px-6 py-4">
              <dl className="space-y-4 text-sm">
                <RoutingField label="Message ID" value={routingMessage.id} mono />
                <RoutingField label="Status" value={routingMessage.status} />
                <RoutingField label="Type" value={routingMessage.messageType} />
                <RoutingField label="Priority" value={routingMessage.priority} />
                <RoutingField
                  label="Created"
                  value={new Date(routingMessage.createdAt).toLocaleString()}
                />

                <div className="border-t pt-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                    Sender
                  </h3>
                  <div className="space-y-3">
                    <RoutingField label="Agent ID" value={routingMessage.senderAgentId} />
                    <RoutingField
                      label="Identity ID"
                      value={routingMessage.senderIdentityId}
                      mono
                    />
                  </div>
                </div>

                <div className="border-t pt-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                    Recipient
                  </h3>
                  <div className="space-y-3">
                    <RoutingField label="Agent ID" value={routingMessage.recipientAgentId} />
                    <RoutingField
                      label="Identity ID"
                      value={routingMessage.recipientIdentityId}
                      mono
                    />
                  </div>
                </div>

                <div className="border-t pt-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                    Routing
                  </h3>
                  <div className="space-y-3">
                    <RoutingField label="Thread Key" value={routingMessage.threadKey} />
                    <RoutingField
                      label="Recipient Session"
                      value={routingMessage.recipientSessionId}
                      mono
                      href={
                        routingMessage.recipientSessionId
                          ? `/sessions/${routingMessage.recipientSessionId}`
                          : undefined
                      }
                    />
                    <RoutingField
                      label="Artifact URI"
                      value={routingMessage.relatedArtifactUri}
                      mono
                    />
                  </div>
                </div>

                {routingMessage.metadata && Object.keys(routingMessage.metadata).length > 0 && (
                  <div className="border-t pt-4">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                      Metadata
                    </h3>
                    <pre className="rounded-md bg-gray-50 p-3 text-xs text-gray-700 overflow-x-auto">
                      {JSON.stringify(routingMessage.metadata, null, 2)}
                    </pre>
                  </div>
                )}

                <div className="border-t pt-4">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-3">
                    Timestamps
                  </h3>
                  <div className="space-y-3">
                    <RoutingField
                      label="Read"
                      value={
                        routingMessage.readAt
                          ? new Date(routingMessage.readAt).toLocaleString()
                          : null
                      }
                    />
                    <RoutingField
                      label="Acknowledged"
                      value={
                        routingMessage.acknowledgedAt
                          ? new Date(routingMessage.acknowledgedAt).toLocaleString()
                          : null
                      }
                    />
                    <RoutingField
                      label="Expires"
                      value={
                        routingMessage.expiresAt
                          ? new Date(routingMessage.expiresAt).toLocaleString()
                          : null
                      }
                    />
                  </div>
                </div>
              </dl>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
