'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Route,
  Plus,
  BellRing,
  AlertTriangle,
  ChevronRight,
  Globe,
  MessageCircle,
  Send,
  Hash,
  Mail,
  GitBranch,
} from 'lucide-react';
import { apiPatch, useApiPost, useApiQuery, useQueryClient } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import clsx from 'clsx';
import { getAgentGradient } from '@/lib/utils';

// ─── Types ───

interface RoutingIdentity {
  id: string;
  agentId: string;
  name: string;
  role: string;
  backend: string | null;
}

interface RoutingRoute {
  id: string;
  identityId: string;
  agentId: string | null;
  agentName: string | null;
  agentRole: string | null;
  backend: string | null;
  platform: string;
  platformAccountId: string | null;
  chatId: string | null;
  studioHint: string | null;
  isActive: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  activeReminderCount: number;
  nextReminderAt: string | null;
}

interface RoutingResponse {
  heartbeatProcessingEnabled: boolean;
  summary: {
    totalRoutes: number;
    activeRoutes: number;
    agentsWithRoutes: number;
    platformsCovered: number;
    unassignedReminderCount: number;
  };
  identities: RoutingIdentity[];
  routes: RoutingRoute[];
}

interface CreateRouteInput {
  identityId: string;
  platform: string;
  platformAccountId?: string | null;
  chatId?: string | null;
  isActive?: boolean;
}

interface SBGroup {
  agentId: string;
  agentName: string;
  agentRole: string | null;
  identityId: string;
  routes: RoutingRoute[];
  totalReminders: number;
  activeRoutes: number;
}

// ─── Constants ───

const PLATFORM_OPTIONS = ['telegram', 'whatsapp', 'discord', 'slack', 'email'];

const PLATFORM_CONFIG: Record<
  string,
  { label: string; color: string; bgColor: string; icon: typeof Send }
> = {
  telegram: {
    label: 'Telegram',
    color: 'text-sky-700',
    bgColor: 'bg-sky-50 border-sky-200',
    icon: Send,
  },
  whatsapp: {
    label: 'WhatsApp',
    color: 'text-emerald-700',
    bgColor: 'bg-emerald-50 border-emerald-200',
    icon: MessageCircle,
  },
  discord: {
    label: 'Discord',
    color: 'text-indigo-700',
    bgColor: 'bg-indigo-50 border-indigo-200',
    icon: Hash,
  },
  slack: {
    label: 'Slack',
    color: 'text-purple-700',
    bgColor: 'bg-purple-50 border-purple-200',
    icon: MessageCircle,
  },
  email: {
    label: 'Email',
    color: 'text-amber-700',
    bgColor: 'bg-amber-50 border-amber-200',
    icon: Mail,
  },
};

// ─── Helpers ───

function formatPlatform(value: string): string {
  return PLATFORM_CONFIG[value]?.label || value.charAt(0).toUpperCase() + value.slice(1);
}

function formatScopeLabel(platformAccountId: string | null, chatId: string | null): string {
  if (platformAccountId && chatId) return `${platformAccountId} / ${chatId}`;
  if (platformAccountId) return `${platformAccountId} (all chats)`;
  if (chatId) return `All accounts / ${chatId}`;
  return 'All traffic';
}

function getInitial(name: string): string {
  return name.charAt(0).toUpperCase();
}

// ─── Component ───

export default function RoutingPage() {
  const queryClient = useQueryClient();
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newRoute, setNewRoute] = useState<CreateRouteInput>({
    identityId: '',
    platform: 'telegram',
    platformAccountId: '',
    chatId: '',
    isActive: true,
  });

  const { data, isLoading, error } = useApiQuery<RoutingResponse>(
    ['routing'],
    '/api/admin/routing'
  );

  const createRouteMutation = useApiPost<{ route: RoutingRoute }, CreateRouteInput>(
    '/api/admin/routing/routes',
    {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['routing'] });
        setShowCreateForm(false);
        setNewRoute({
          identityId: '',
          platform: 'telegram',
          platformAccountId: '',
          chatId: '',
          isActive: true,
        });
      },
    }
  );

  const toggleRouteMutation = useMutation({
    mutationFn: ({ routeId, isActive }: { routeId: string; isActive: boolean }) =>
      apiPatch(`/api/admin/routing/routes/${routeId}`, { isActive }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['routing'] }),
  });

  const routes = data?.routes || [];
  const identities = data?.identities || [];
  const summary = data?.summary || {
    totalRoutes: 0,
    activeRoutes: 0,
    agentsWithRoutes: 0,
    platformsCovered: 0,
    unassignedReminderCount: 0,
  };

  // Group routes by SB
  const sbGroups = useMemo<SBGroup[]>(() => {
    const groups = new Map<string, SBGroup>();
    for (const route of routes) {
      const key = route.agentId || route.identityId;
      if (!groups.has(key)) {
        groups.set(key, {
          agentId: route.agentId || 'unknown',
          agentName: route.agentName || route.agentId || 'Unknown agent',
          agentRole: route.agentRole || null,
          identityId: route.identityId,
          routes: [],
          totalReminders: 0,
          activeRoutes: 0,
        });
      }
      const group = groups.get(key)!;
      group.routes.push(route);
      group.totalReminders += route.activeReminderCount;
      if (route.isActive) group.activeRoutes++;
    }
    return [...groups.values()].sort((a, b) => a.agentName.localeCompare(b.agentName));
  }, [routes]);

  const mutationError = createRouteMutation.error?.message || toggleRouteMutation.error?.message;

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Routing</h1>
          <p className="mt-1 text-gray-500">
            Control where channel traffic and reminders are routed across SBs.
          </p>
        </div>
        <Button onClick={() => setShowCreateForm((v) => !v)} size="sm" className="shrink-0">
          <Plus className="mr-2 h-4 w-4" />
          Add Route
        </Button>
      </div>

      {/* Heartbeat warning */}
      {data && !data.heartbeatProcessingEnabled && (
        <Card className="mt-6 border-amber-200 bg-amber-50/70">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
            <div className="text-sm text-amber-900">
              Heartbeat/reminder processing is disabled on this server instance ({' '}
              <code className="bg-amber-100 px-1 py-0.5 rounded text-xs">
                ENABLE_HEARTBEATS=false
              </code>{' '}
              or related flags). This is ideal for secondary dev servers.
            </div>
          </CardContent>
        </Card>
      )}

      {(error || mutationError) && (
        <div className="mt-4 rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-800">
          {error?.message || mutationError}
        </div>
      )}

      {/* Stats — compact row */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Total routes', value: summary.totalRoutes, color: 'text-gray-900' },
          { label: 'Active', value: summary.activeRoutes, color: 'text-green-700' },
          { label: 'SBs', value: summary.agentsWithRoutes, color: 'text-gray-900' },
          { label: 'Platforms', value: summary.platformsCovered, color: 'text-gray-900' },
        ].map((stat) => (
          <div key={stat.label} className="rounded-lg border bg-white p-3">
            <div className="text-xs text-gray-500">{stat.label}</div>
            <div className={clsx('text-2xl font-semibold', stat.color)}>{stat.value}</div>
          </div>
        ))}
      </div>

      {/* Create form */}
      {showCreateForm && (
        <Card className="mt-6">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">Create route</CardTitle>
            <CardDescription>
              Assign a platform (and optionally a specific account or chat) to an SB.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                createRouteMutation.mutate({
                  identityId: newRoute.identityId,
                  platform: newRoute.platform,
                  platformAccountId: newRoute.platformAccountId || null,
                  chatId: newRoute.chatId || null,
                  isActive: newRoute.isActive ?? true,
                });
              }}
            >
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-gray-700">SB</label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                    value={newRoute.identityId}
                    onChange={(e) => setNewRoute((p) => ({ ...p, identityId: e.target.value }))}
                    required
                  >
                    <option value="">Select an SB...</option>
                    {identities.map((identity) => (
                      <option key={identity.id} value={identity.id}>
                        {identity.name} ({identity.agentId})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-gray-700">Platform</label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
                    value={newRoute.platform}
                    onChange={(e) => setNewRoute((p) => ({ ...p, platform: e.target.value }))}
                    required
                  >
                    {PLATFORM_OPTIONS.map((p) => (
                      <option key={p} value={p}>
                        {formatPlatform(p)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-gray-700">
                    Account <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <Input
                    placeholder="myra_help_bot or +14155551234"
                    value={newRoute.platformAccountId || ''}
                    onChange={(e) =>
                      setNewRoute((p) => ({ ...p, platformAccountId: e.target.value }))
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-medium text-gray-700">
                    Chat <span className="text-gray-400 font-normal">(optional)</span>
                  </label>
                  <Input
                    placeholder="group_id / thread_id"
                    value={newRoute.chatId || ''}
                    onChange={(e) => setNewRoute((p) => ({ ...p, chatId: e.target.value }))}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between pt-2">
                <label className="flex items-center gap-2 text-sm text-gray-600">
                  <input
                    type="checkbox"
                    className="rounded"
                    checked={newRoute.isActive ?? true}
                    onChange={(e) => setNewRoute((p) => ({ ...p, isActive: e.target.checked }))}
                  />
                  Active immediately
                </label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setShowCreateForm(false)}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={createRouteMutation.isPending}>
                    {createRouteMutation.isPending ? 'Creating...' : 'Create route'}
                  </Button>
                </div>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      {/* SB Groups */}
      <div className="mt-6 space-y-4">
        {isLoading ? (
          <Card>
            <CardContent className="py-12 text-center text-gray-500">Loading...</CardContent>
          </Card>
        ) : sbGroups.length === 0 ? (
          <Card>
            <CardContent className="py-12 text-center">
              <Route className="h-10 w-10 mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500">No channel routes yet.</p>
              <p className="text-sm text-gray-400 mt-1">
                Add your first route above to start routing traffic to an SB.
              </p>
            </CardContent>
          </Card>
        ) : (
          sbGroups.map((group) => {
            const gradient = getAgentGradient(group.agentId);
            return (
              <Card key={group.agentId} className="overflow-hidden">
                {/* SB Header */}
                <div className="flex items-center gap-4 px-5 py-4 border-b bg-gray-50/50">
                  <div
                    className={clsx(
                      'h-10 w-10 rounded-full bg-gradient-to-br flex items-center justify-center text-white font-semibold text-sm shrink-0',
                      gradient
                    )}
                  >
                    {getInitial(group.agentName)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-gray-900">{group.agentName}</h3>
                      <span className="text-xs text-gray-400">@{group.agentId}</span>
                    </div>
                    {group.agentRole && (
                      <p className="text-sm text-gray-500 truncate">{group.agentRole}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-4 shrink-0">
                    <div className="text-right">
                      <div className="text-xs text-gray-400">Reminders</div>
                      <div className="flex items-center gap-1 justify-end">
                        <BellRing className="h-3.5 w-3.5 text-gray-500" />
                        <span className="font-medium text-gray-700">{group.totalReminders}</span>
                      </div>
                    </div>
                    <Link
                      href={`/routing/${group.agentId}`}
                      className="flex items-center gap-1 text-sm font-medium text-gray-600 hover:text-gray-900 transition-colors"
                    >
                      Manage
                      <ChevronRight className="h-4 w-4" />
                    </Link>
                  </div>
                </div>

                {/* Platform routes */}
                <div className="divide-y">
                  {group.routes.map((route) => {
                    const pConfig = PLATFORM_CONFIG[route.platform];
                    const PlatformIcon = pConfig?.icon || Globe;

                    return (
                      <div
                        key={route.id}
                        className={clsx(
                          'flex items-center gap-4 px-5 py-3 transition-colors',
                          !route.isActive && 'opacity-50'
                        )}
                      >
                        <div className="flex items-center gap-3 flex-1 min-w-0">
                          <div
                            className={clsx(
                              'flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs font-medium',
                              pConfig?.bgColor || 'bg-gray-50 border-gray-200',
                              pConfig?.color || 'text-gray-700'
                            )}
                          >
                            <PlatformIcon className="h-3.5 w-3.5" />
                            {formatPlatform(route.platform)}
                          </div>
                          <span className="text-sm text-gray-500 truncate">
                            {formatScopeLabel(route.platformAccountId, route.chatId)}
                          </span>
                          {route.studioHint && (
                            <span className="flex items-center gap-1 text-[11px] text-gray-400">
                              <GitBranch className="h-3 w-3" />
                              {route.studioHint === 'main' ? 'Main' : route.studioHint}
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <Badge
                            className={clsx(
                              'text-[11px] font-medium border',
                              route.isActive
                                ? 'bg-green-50 text-green-700 border-green-200 hover:bg-green-50'
                                : 'bg-gray-50 text-gray-500 border-gray-200 hover:bg-gray-50'
                            )}
                          >
                            {route.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs text-gray-500 hover:text-gray-900"
                            onClick={() =>
                              toggleRouteMutation.mutate({
                                routeId: route.id,
                                isActive: !route.isActive,
                              })
                            }
                            disabled={toggleRouteMutation.isPending}
                          >
                            {route.isActive ? 'Disable' : 'Enable'}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            );
          })
        )}
      </div>

      {/* Unassigned reminders callout */}
      {summary.unassignedReminderCount > 0 && (
        <div className="mt-4 flex items-center gap-3 rounded-lg border border-amber-200 bg-amber-50/50 px-4 py-3">
          <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
          <p className="text-sm text-amber-800">
            <span className="font-medium">
              {summary.unassignedReminderCount} reminder
              {summary.unassignedReminderCount !== 1 ? 's' : ''}
            </span>{' '}
            not assigned to any SB.{' '}
            <Link href="/reminders" className="underline hover:text-amber-900">
              View reminders
            </Link>
          </p>
        </div>
      )}
    </div>
  );
}
