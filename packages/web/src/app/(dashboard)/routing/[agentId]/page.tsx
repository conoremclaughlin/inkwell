'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, Bell, Save, Trash2, Plus } from 'lucide-react';
import { apiDelete, apiPatch, useApiPost, useApiQuery, useQueryClient } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';

interface AgentRoute {
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

interface AgentReminder {
  id: string;
  title: string;
  description: string | null;
  deliveryChannel: string;
  deliveryTarget: string | null;
  cronExpression: string | null;
  nextRunAt: string | null;
  lastRunAt: string | null;
  status: 'active' | 'paused' | 'completed' | 'cancelled' | 'failed';
  runCount: number;
  maxRuns: number | null;
  identityId: string | null;
}

interface AgentRoutingResponse {
  heartbeatProcessingEnabled: boolean;
  agent: {
    id: string;
    agentId: string;
    name: string;
    role: string;
    description: string | null;
    backend: string | null;
    updatedAt: string;
  };
  routes: AgentRoute[];
  reminders: AgentReminder[];
}

interface RouteFormState {
  platform: string;
  platformAccountId: string;
  chatId: string;
  isActive: boolean;
}

const PLATFORM_OPTIONS = ['telegram', 'whatsapp', 'discord', 'slack', 'email'];

function formatPlatform(value: string): string {
  if (!value) return 'Unknown';
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatTime(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString();
}

function initialFormFromRoute(route: AgentRoute): RouteFormState {
  return {
    platform: route.platform,
    platformAccountId: route.platformAccountId || '',
    chatId: route.chatId || '',
    isActive: route.isActive,
  };
}

export default function AgentRoutingPage() {
  const params = useParams<{ agentId: string }>();
  const agentId = decodeURIComponent(params?.agentId || '');
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useApiQuery<AgentRoutingResponse>(
    ['routing-agent', agentId],
    `/api/admin/routing/agents/${encodeURIComponent(agentId)}`,
    {
      enabled: !!agentId,
    }
  );

  const [newRoute, setNewRoute] = useState<RouteFormState>({
    platform: 'telegram',
    platformAccountId: '',
    chatId: '',
    isActive: true,
  });
  const [editingRouteId, setEditingRouteId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<RouteFormState>({
    platform: 'telegram',
    platformAccountId: '',
    chatId: '',
    isActive: true,
  });

  useEffect(() => {
    if (!editingRouteId || !data?.routes) return;
    const selectedRoute = data.routes.find((route) => route.id === editingRouteId);
    if (!selectedRoute) return;
    setEditForm(initialFormFromRoute(selectedRoute));
  }, [editingRouteId, data?.routes]);

  const createRouteMutation = useApiPost<{ route: AgentRoute }, Record<string, unknown>>(
    '/api/admin/routing/routes',
    {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ['routing'] });
        queryClient.invalidateQueries({ queryKey: ['routing-agent', agentId] });
        setNewRoute({
          platform: 'telegram',
          platformAccountId: '',
          chatId: '',
          isActive: true,
        });
      },
    }
  );

  const updateRouteMutation = useMutation({
    mutationFn: ({ routeId, payload }: { routeId: string; payload: Record<string, unknown> }) =>
      apiPatch(`/api/admin/routing/routes/${routeId}`, payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routing'] });
      queryClient.invalidateQueries({ queryKey: ['routing-agent', agentId] });
    },
  });

  const deleteRouteMutation = useMutation({
    mutationFn: (routeId: string) => apiDelete(`/api/admin/routing/routes/${routeId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['routing'] });
      queryClient.invalidateQueries({ queryKey: ['routing-agent', agentId] });
      setEditingRouteId(null);
    },
  });

  const mutationError =
    createRouteMutation.error?.message ||
    updateRouteMutation.error?.message ||
    deleteRouteMutation.error?.message;

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <div>
          <Button variant="ghost" size="sm" asChild className="mb-2 px-0">
            <Link href="/routing">
              <ArrowLeft className="mr-2 h-4 w-4" />
              Back to routing
            </Link>
          </Button>
          <h1 className="text-3xl font-bold text-gray-900">
            {data?.agent?.name || agentId} routing
          </h1>
          <p className="mt-2 text-gray-600">
            {data?.agent?.role || 'Configure channel route scope and routing behavior for this SB.'}
          </p>
        </div>
        {data?.agent?.backend && (
          <Badge variant="secondary" className="text-sm">
            {data.agent.backend}
          </Badge>
        )}
      </div>

      {data && !data.heartbeatProcessingEnabled && (
        <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Heartbeat/reminder processing is disabled on this server instance. Routing edits still
          persist, but reminder execution won’t run here.
        </div>
      )}

      {(error || mutationError) && (
        <div className="mt-4 rounded-md bg-red-50 p-4 text-red-800">
          {error?.message || mutationError}
        </div>
      )}

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Add route for {data?.agent?.name || agentId}</CardTitle>
          <CardDescription>
            Start broad (platform only) then narrow to account/chat when needed.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!data?.agent?.id) return;
              createRouteMutation.mutate({
                identityId: data.agent.id,
                platform: newRoute.platform,
                platformAccountId: newRoute.platformAccountId || null,
                chatId: newRoute.chatId || null,
                isActive: newRoute.isActive,
              });
            }}
          >
            <div className="grid gap-4 md:grid-cols-3">
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
                >
                  {PLATFORM_OPTIONS.map((platform) => (
                    <option key={platform} value={platform}>
                      {formatPlatform(platform)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Platform account</label>
                <Input
                  placeholder="myra_help_bot or +14155551234"
                  value={newRoute.platformAccountId}
                  onChange={(event) =>
                    setNewRoute((previous) => ({
                      ...previous,
                      platformAccountId: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium">Chat ID</label>
                <Input
                  placeholder="chat/thread identifier"
                  value={newRoute.chatId}
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
                  checked={newRoute.isActive}
                  onChange={(event) =>
                    setNewRoute((previous) => ({
                      ...previous,
                      isActive: event.target.checked,
                    }))
                  }
                />
                Route active
              </label>
              <Button type="submit" disabled={createRouteMutation.isPending}>
                <Plus className="mr-2 h-4 w-4" />
                {createRouteMutation.isPending ? 'Creating...' : 'Add route'}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Routes</CardTitle>
          <CardDescription>Edit or disable route scopes for this SB.</CardDescription>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-gray-500">Loading...</p>
          ) : !data || data.routes.length === 0 ? (
            <p className="text-gray-500">No routes configured for this SB yet.</p>
          ) : (
            <div className="space-y-4">
              {data.routes.map((route) => {
                const isEditing = editingRouteId === route.id;
                return (
                  <div key={route.id} className="rounded-lg border p-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline">{formatPlatform(route.platform)}</Badge>
                        <Badge
                          className={
                            route.isActive
                              ? 'bg-green-100 text-green-700 hover:bg-green-100'
                              : 'bg-gray-100 text-gray-600 hover:bg-gray-100'
                          }
                        >
                          {route.isActive ? 'Active' : 'Inactive'}
                        </Badge>
                      </div>
                      <div className="text-xs text-gray-500">
                        Updated {new Date(route.updatedAt).toLocaleString()}
                      </div>
                    </div>

                    <div className="mt-3 grid gap-3 md:grid-cols-2 text-sm">
                      <div>
                        <div className="text-gray-500">Account</div>
                        <div className="font-mono text-xs">{route.platformAccountId || 'Any account'}</div>
                      </div>
                      <div>
                        <div className="text-gray-500">Chat</div>
                        <div className="font-mono text-xs">{route.chatId || 'Any chat'}</div>
                      </div>
                    </div>

                    {isEditing ? (
                      <form
                        className="mt-4 space-y-3 rounded-md border bg-gray-50 p-3"
                        onSubmit={(event) => {
                          event.preventDefault();
                          updateRouteMutation.mutate({
                            routeId: route.id,
                            payload: {
                              platform: editForm.platform,
                              platformAccountId: editForm.platformAccountId || null,
                              chatId: editForm.chatId || null,
                              isActive: editForm.isActive,
                            },
                          });
                          setEditingRouteId(null);
                        }}
                      >
                        <div className="grid gap-3 md:grid-cols-3">
                          <select
                            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                            value={editForm.platform}
                            onChange={(event) =>
                              setEditForm((previous) => ({
                                ...previous,
                                platform: event.target.value,
                              }))
                            }
                          >
                            {PLATFORM_OPTIONS.map((platform) => (
                              <option key={platform} value={platform}>
                                {formatPlatform(platform)}
                              </option>
                            ))}
                          </select>
                          <Input
                            placeholder="Platform account"
                            value={editForm.platformAccountId}
                            onChange={(event) =>
                              setEditForm((previous) => ({
                                ...previous,
                                platformAccountId: event.target.value,
                              }))
                            }
                          />
                          <Input
                            placeholder="Chat ID"
                            value={editForm.chatId}
                            onChange={(event) =>
                              setEditForm((previous) => ({
                                ...previous,
                                chatId: event.target.value,
                              }))
                            }
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <label className="flex items-center gap-2 text-sm">
                            <input
                              type="checkbox"
                              checked={editForm.isActive}
                              onChange={(event) =>
                                setEditForm((previous) => ({
                                  ...previous,
                                  isActive: event.target.checked,
                                }))
                              }
                            />
                            Active
                          </label>
                          <div className="flex items-center gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              onClick={() => setEditingRouteId(null)}
                            >
                              Cancel
                            </Button>
                            <Button type="submit" size="sm" disabled={updateRouteMutation.isPending}>
                              <Save className="mr-2 h-4 w-4" />
                              Save
                            </Button>
                          </div>
                        </div>
                      </form>
                    ) : (
                      <div className="mt-4 flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setEditForm(initialFormFromRoute(route));
                            setEditingRouteId(route.id);
                          }}
                        >
                          Edit
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            updateRouteMutation.mutate({
                              routeId: route.id,
                              payload: { isActive: !route.isActive },
                            })
                          }
                          disabled={updateRouteMutation.isPending}
                        >
                          {route.isActive ? 'Disable' : 'Enable'}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            if (!confirm('Delete this route? This cannot be undone.')) return;
                            deleteRouteMutation.mutate(route.id);
                          }}
                          disabled={deleteRouteMutation.isPending}
                        >
                          <Trash2 className="h-4 w-4 text-red-500" />
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Scheduled reminders for this SB</CardTitle>
          <CardDescription>Identity-bound reminders that will route to this agent.</CardDescription>
        </CardHeader>
        <CardContent>
          {!data || data.reminders.length === 0 ? (
            <p className="text-sm text-gray-500">No reminders assigned to this SB.</p>
          ) : (
            <div className="space-y-3">
              {data.reminders.map((reminder) => (
                <div key={reminder.id} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="font-medium text-gray-900">{reminder.title}</div>
                      <div className="text-xs text-gray-500 mt-1">
                        {formatPlatform(reminder.deliveryChannel)}
                        {reminder.deliveryTarget ? ` → ${reminder.deliveryTarget}` : ''}
                      </div>
                    </div>
                    <Badge variant="outline">{reminder.status}</Badge>
                  </div>
                  <div className="mt-2 grid gap-2 md:grid-cols-2 text-xs text-gray-600">
                    <div className="flex items-center gap-1">
                      <Bell className="h-3 w-3" />
                      Next: {formatTime(reminder.nextRunAt)}
                    </div>
                    <div>Runs: {reminder.runCount}</div>
                    {reminder.cronExpression && <div>Cron: {reminder.cronExpression}</div>}
                    {reminder.lastRunAt && <div>Last: {formatTime(reminder.lastRunAt)}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
