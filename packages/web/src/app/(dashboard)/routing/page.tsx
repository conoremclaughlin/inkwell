'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Route, Plus, BellRing, AlertTriangle } from 'lucide-react';
import { apiPatch, useApiPost, useApiQuery, useQueryClient } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

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

const PLATFORM_OPTIONS = ['telegram', 'whatsapp', 'discord', 'slack', 'email'];

function formatPlatform(value: string): string {
  if (!value) return 'Unknown';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatTimestamp(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

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

  const { data, isLoading, error } = useApiQuery<RoutingResponse>(['routing'], '/api/admin/routing');

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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routing'] });
    },
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

  const mutationError = createRouteMutation.error?.message || toggleRouteMutation.error?.message;

  return (
    <div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Routing</h1>
          <p className="mt-2 text-gray-600">
            Control where channel traffic and reminder execution are routed across SBs.
          </p>
        </div>
        <Button onClick={() => setShowCreateForm((value) => !value)} size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Add Route
        </Button>
      </div>

      {data && !data.heartbeatProcessingEnabled && (
        <Card className="mt-6 border-amber-200 bg-amber-50/70">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertTriangle className="h-5 w-5 text-amber-600 mt-0.5" />
            <div className="text-sm text-amber-900">
              Heartbeat/reminder processing is disabled on this server instance
              ({' '}
              <code className="bg-amber-100 px-1 py-0.5 rounded text-xs">
                ENABLE_HEARTBEAT_SERVICE=false
              </code>{' '}
              or related flags). This is ideal for secondary dev servers.
            </div>
          </CardContent>
        </Card>
      )}

      {(error || mutationError) && (
        <div className="mt-4 rounded-md bg-red-50 p-4 text-red-800">
          {error?.message || mutationError}
        </div>
      )}

      <div className="mt-6 grid gap-4 md:grid-cols-5">
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-gray-500">Total routes</div>
            <div className="text-2xl font-semibold text-gray-900">{summary.totalRoutes}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-gray-500">Active</div>
            <div className="text-2xl font-semibold text-green-700">{summary.activeRoutes}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-gray-500">SBs with routes</div>
            <div className="text-2xl font-semibold text-gray-900">{summary.agentsWithRoutes}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-gray-500">Platforms</div>
            <div className="text-2xl font-semibold text-gray-900">{summary.platformsCovered}</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-xs text-gray-500">Unassigned reminders</div>
            <div className="text-2xl font-semibold text-amber-700">
              {summary.unassignedReminderCount}
            </div>
          </CardContent>
        </Card>
      </div>

      {showCreateForm && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle>Create route</CardTitle>
            <CardDescription>
              Scope by platform, then optionally account + chat for more specific routing.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
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
                <div className="space-y-2">
                  <label className="text-sm font-medium">SB</label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={newRoute.identityId}
                    onChange={(event) =>
                      setNewRoute((previous) => ({
                        ...previous,
                        identityId: event.target.value,
                      }))
                    }
                    required
                  >
                    <option value="">Select an SB</option>
                    {identities.map((identity) => (
                      <option key={identity.id} value={identity.id}>
                        {identity.name} ({identity.agentId})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Platform</label>
                  <select
                    className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                    value={newRoute.platform}
                    onChange={(event) =>
                      setNewRoute((previous) => ({
                        ...previous,
                        platform: event.target.value,
                      }))
                    }
                    required
                  >
                    {PLATFORM_OPTIONS.map((platform) => (
                      <option key={platform} value={platform}>
                        {formatPlatform(platform)}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Platform account (optional)</label>
                  <Input
                    placeholder="myra_help_bot or +14155551234"
                    value={newRoute.platformAccountId || ''}
                    onChange={(event) =>
                      setNewRoute((previous) => ({
                        ...previous,
                        platformAccountId: event.target.value,
                      }))
                    }
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">Chat ID (optional)</label>
                  <Input
                    placeholder="group_id / thread_id"
                    value={newRoute.chatId || ''}
                    onChange={(event) =>
                      setNewRoute((previous) => ({
                        ...previous,
                        chatId: event.target.value,
                      }))
                    }
                  />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={newRoute.isActive ?? true}
                    onChange={(event) =>
                      setNewRoute((previous) => ({
                        ...previous,
                        isActive: event.target.checked,
                      }))
                    }
                  />
                  Route active
                </label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setShowCreateForm(false);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={createRouteMutation.isPending}>
                    {createRouteMutation.isPending ? 'Creating...' : 'Create route'}
                  </Button>
                </div>
              </div>
            </form>
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Route matrix</CardTitle>
          <CardDescription>
            Specificity cascade: platform + account + chat → platform + account → platform default.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-gray-500">Loading...</p>
          ) : routes.length === 0 ? (
            <div className="py-10 text-center text-gray-500">
              <Route className="h-10 w-10 mx-auto text-gray-300 mb-3" />
              No channel routes yet. Add your first route above.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b text-left text-sm text-gray-600">
                    <th className="pb-3 font-medium">SB</th>
                    <th className="pb-3 font-medium">Platform</th>
                    <th className="pb-3 font-medium">Account</th>
                    <th className="pb-3 font-medium">Chat</th>
                    <th className="pb-3 font-medium">Reminders</th>
                    <th className="pb-3 font-medium">Updated</th>
                    <th className="pb-3 font-medium">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {routes.map((route) => (
                    <tr key={route.id} className="border-b align-top">
                      <td className="py-3">
                        <div className="flex flex-col gap-1">
                          <Link
                            href={route.agentId ? `/routing/${route.agentId}` : '/routing'}
                            className="font-semibold text-gray-900 hover:underline"
                          >
                            {route.agentName || route.agentId || 'Unknown agent'}
                          </Link>
                          {route.agentRole && <span className="text-xs text-gray-500">{route.agentRole}</span>}
                        </div>
                      </td>
                      <td className="py-3">
                        <Badge variant="outline">{formatPlatform(route.platform)}</Badge>
                      </td>
                      <td className="py-3 font-mono text-xs text-gray-700">
                        {route.platformAccountId || <span className="text-gray-400">Any account</span>}
                      </td>
                      <td className="py-3 font-mono text-xs text-gray-700">
                        {route.chatId || <span className="text-gray-400">Any chat</span>}
                      </td>
                      <td className="py-3">
                        <div className="flex flex-col gap-1 text-sm">
                          <span className="inline-flex items-center gap-1 text-gray-700">
                            <BellRing className="h-3 w-3" />
                            {route.activeReminderCount}
                          </span>
                          <span className="text-xs text-gray-500">
                            {route.nextReminderAt
                              ? `Next: ${formatTimestamp(route.nextReminderAt)}`
                              : 'No upcoming reminder'}
                          </span>
                        </div>
                      </td>
                      <td className="py-3 text-xs text-gray-500">{formatTimestamp(route.updatedAt)}</td>
                      <td className="py-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            className={
                              route.isActive
                                ? 'bg-green-100 text-green-700 hover:bg-green-100'
                                : 'bg-gray-100 text-gray-600 hover:bg-gray-100'
                            }
                          >
                            {route.isActive ? 'Active' : 'Inactive'}
                          </Badge>
                          <Button
                            variant="outline"
                            size="sm"
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
                          {route.agentId && (
                            <Button variant="ghost" size="sm" asChild>
                              <Link href={`/routing/${route.agentId}`}>Manage</Link>
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
