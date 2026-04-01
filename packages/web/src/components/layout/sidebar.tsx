'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { LucideIcon } from 'lucide-react';
import {
  LogOut,
  Home,
  Bot,
  Bell,
  Link2,
  FileText,
  Puzzle,
  Plus,
  UserPlus,
  Building2,
  ChevronDown,
  Check,
  Settings,
  Activity,
  Route,
  MessageSquare,
  ListTodo,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRouter } from 'next/navigation';
import { useApiPost, useApiPostDynamic, useApiQuery, useQueryClient } from '@/lib/api/hooks';
import { getSelectedWorkspaceId, setSelectedWorkspaceId } from '@/lib/workspace-selection';
import { useEffect, useMemo, useRef, useState } from 'react';
import { signOut } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

interface NavItem {
  name: string;
  href: string;
  icon: LucideIcon;
}

interface NavGroup {
  label?: string;
  items: NavItem[];
}

const mainNav: NavGroup[] = [
  {
    items: [{ name: 'Dashboard', href: '/', icon: Home }],
  },
  {
    label: 'Team',
    items: [
      { name: 'Individuals', href: '/individuals', icon: Bot },
      { name: 'Tasks', href: '/tasks', icon: ListTodo },
      { name: 'Documents', href: '/artifacts', icon: FileText },
      { name: 'Messaging', href: '/messaging', icon: MessageSquare },
      { name: 'Skills', href: '/skills', icon: Puzzle },
    ],
  },
  {
    label: 'Platform',
    items: [
      { name: 'Reminders', href: '/reminders', icon: Bell },
      { name: 'Connections', href: '/connected-accounts', icon: Link2 },
      { name: 'Routing', href: '/routing', icon: Route },
      { name: 'Sessions', href: '/sessions', icon: Activity },
    ],
  },
];

interface WorkspaceOption {
  id: string;
  name: string;
  slug: string;
  type: 'personal' | 'team';
  role?: 'owner' | 'admin' | 'member' | 'viewer';
}

interface WorkspaceListResponse {
  currentWorkspaceId: string;
  currentWorkspaceRole: 'owner' | 'admin' | 'member' | 'viewer' | 'trusted';
  workspaces: WorkspaceOption[];
}

interface WorkspaceMembersResponse {
  canManage: boolean;
  members: Array<{
    id: string;
    userId: string;
    role: 'owner' | 'admin' | 'member' | 'viewer';
    user: {
      id: string;
      email: string | null;
      firstName: string | null;
      username: string | null;
      lastLoginAt: string | null;
    } | null;
  }>;
}

interface AuthMeResponse {
  authenticated: boolean;
  user?: {
    id: string;
    email: string | null;
  };
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [selectedWorkspaceId, setSelectedWorkspaceState] = useState<string | null>(null);
  const [workspaceManagerOpen, setWorkspaceManagerOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState('');
  const [newWorkspaceType, setNewWorkspaceType] = useState<'personal' | 'team'>('team');
  const [newWorkspaceDescription, setNewWorkspaceDescription] = useState('');
  const [inviteWorkspaceId, setInviteWorkspaceId] = useState<string>('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<'owner' | 'admin' | 'member' | 'viewer'>('member');
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceSuccess, setWorkspaceSuccess] = useState<string | null>(null);
  const [isMounted, setIsMounted] = useState(false);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);

  const { data: workspaceData, isLoading: workspacesLoading } = useApiQuery<WorkspaceListResponse>(
    ['workspaces'],
    '/api/admin/workspaces',
    {
      retry: 1,
    }
  );

  const { data: authMeData } = useApiQuery<AuthMeResponse>(['auth-me'], '/api/auth/me', {
    retry: false,
  });

  const resolvedWorkspaceId = useMemo(() => {
    if (selectedWorkspaceId) return selectedWorkspaceId;
    return workspaceData?.currentWorkspaceId ?? '';
  }, [selectedWorkspaceId, workspaceData?.currentWorkspaceId]);

  const workspaces = workspaceData?.workspaces || [];
  const selectedWorkspace =
    workspaces.find((workspace) => workspace.id === resolvedWorkspaceId) || null;
  const userEmail = authMeData?.user?.email ?? '';
  const userInitial = userEmail ? userEmail.charAt(0).toUpperCase() : '';
  const workspaceName = selectedWorkspace?.name ?? '';
  const workspaceTriggerLabel = workspaceName || '\u00A0';
  const workspaceTitleLabel = workspaceName ? `${workspaceName} Workspace` : '\u00A0';
  const selectedWorkspaceRole =
    selectedWorkspace?.role ||
    (workspaceData?.currentWorkspaceRole && workspaceData.currentWorkspaceRole !== 'trusted'
      ? workspaceData.currentWorkspaceRole
      : '');
  const inviteTargetWorkspaceId = inviteWorkspaceId || resolvedWorkspaceId;
  const workspaceMembersPath = inviteTargetWorkspaceId
    ? `/api/admin/workspaces/${inviteTargetWorkspaceId}/members`
    : '/api/admin/workspaces/none/members';

  const { data: workspaceMembersData, isLoading: workspaceMembersLoading } =
    useApiQuery<WorkspaceMembersResponse>(
      ['workspace-members', inviteTargetWorkspaceId],
      workspaceMembersPath,
      {
        enabled: workspaceManagerOpen && Boolean(inviteTargetWorkspaceId),
        retry: 1,
      }
    );

  const createWorkspaceMutation = useApiPost<
    { workspace: WorkspaceOption },
    { name: string; type: 'personal' | 'team'; description?: string }
  >('/api/admin/workspaces', {
    onSuccess: (data) => {
      const createdWorkspaceId = data.workspace.id;
      setSelectedWorkspaceId(createdWorkspaceId);
      setSelectedWorkspaceState(createdWorkspaceId);
      setInviteWorkspaceId(createdWorkspaceId);
      setNewWorkspaceName('');
      setNewWorkspaceDescription('');
      setWorkspaceError(null);
      setWorkspaceSuccess(`Created workspace "${data.workspace.name}".`);
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      queryClient.invalidateQueries({ queryKey: ['workspace-members', createdWorkspaceId] });
      router.refresh();
    },
    onError: (error) => {
      setWorkspaceSuccess(null);
      setWorkspaceError(error.message || 'Failed to create workspace');
    },
  });

  const inviteWorkspaceMemberMutation = useApiPostDynamic<
    { member: { id: string } },
    { workspaceId: string; email: string; role: 'owner' | 'admin' | 'member' | 'viewer' }
  >(
    (input) => `/api/admin/workspaces/${input.workspaceId}/members`,
    (input) => ({
      email: input.email,
      role: input.role,
    }),
    {
      onSuccess: (_, variables) => {
        setInviteEmail('');
        setWorkspaceError(null);
        setWorkspaceSuccess('Collaborator invited successfully.');
        queryClient.invalidateQueries({ queryKey: ['workspace-members', variables.workspaceId] });
      },
      onError: (error) => {
        setWorkspaceSuccess(null);
        setWorkspaceError(error.message || 'Failed to invite collaborator');
      },
    }
  );

  useEffect(() => {
    setIsMounted(true);
  }, []);

  useEffect(() => {
    const locallySelected = getSelectedWorkspaceId();
    if (locallySelected) {
      setSelectedWorkspaceState(locallySelected);
      return;
    }

    if (workspaceData?.currentWorkspaceId) {
      setSelectedWorkspaceId(workspaceData.currentWorkspaceId);
      setSelectedWorkspaceState(workspaceData.currentWorkspaceId);
    }
  }, [workspaceData?.currentWorkspaceId]);

  useEffect(() => {
    if (!inviteWorkspaceId) {
      const fallbackWorkspaceId = selectedWorkspaceId || workspaceData?.currentWorkspaceId;
      if (fallbackWorkspaceId) {
        setInviteWorkspaceId(fallbackWorkspaceId);
      }
    }
  }, [inviteWorkspaceId, selectedWorkspaceId, workspaceData?.currentWorkspaceId]);

  useEffect(() => {
    if (!accountMenuOpen) return;

    const handleGlobalMouseDown = (event: MouseEvent) => {
      if (!accountMenuRef.current) return;
      const targetNode = event.target as Node | null;
      if (targetNode && !accountMenuRef.current.contains(targetNode)) {
        setAccountMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleGlobalMouseDown);
    return () => {
      document.removeEventListener('mousedown', handleGlobalMouseDown);
    };
  }, [accountMenuOpen]);

  const handleWorkspaceChange = (workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId);
    setSelectedWorkspaceState(workspaceId);
    // Force all data queries to refetch with the new workspace header.
    queryClient.invalidateQueries();
    router.refresh();
  };

  const handleCreateWorkspace = () => {
    const trimmedWorkspaceName = newWorkspaceName.trim();
    if (!trimmedWorkspaceName) {
      setWorkspaceSuccess(null);
      setWorkspaceError('Workspace name is required');
      return;
    }

    setWorkspaceSuccess(null);
    setWorkspaceError(null);
    createWorkspaceMutation.mutate({
      name: trimmedWorkspaceName,
      type: newWorkspaceType,
      description: newWorkspaceDescription.trim() || undefined,
    });
  };

  const handleInviteWorkspaceMember = () => {
    const trimmedInviteEmail = inviteEmail.trim();
    if (!trimmedInviteEmail || !trimmedInviteEmail.includes('@')) {
      setWorkspaceSuccess(null);
      setWorkspaceError('Valid collaborator email is required');
      return;
    }

    if (!inviteTargetWorkspaceId) {
      setWorkspaceSuccess(null);
      setWorkspaceError('Select a workspace before inviting');
      return;
    }

    setWorkspaceSuccess(null);
    setWorkspaceError(null);
    inviteWorkspaceMemberMutation.mutate({
      workspaceId: inviteTargetWorkspaceId,
      email: trimmedInviteEmail,
      role: inviteRole,
    });
  };

  const isLinkActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');

  const renderNavItem = (item: NavItem) => {
    const active = isLinkActive(item.href);
    return (
      <li key={item.name}>
        <Link
          href={item.href}
          className={cn(
            'group relative flex items-center gap-x-3 rounded-lg px-3 py-2 text-[13px] font-medium transition-all duration-150',
            active
              ? 'bg-white/[0.08] text-white'
              : 'text-gray-400 hover:bg-white/[0.04] hover:text-gray-200'
          )}
        >
          {active && (
            <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-blue-400" />
          )}
          <item.icon
            className={cn(
              'h-[18px] w-[18px] shrink-0 transition-colors duration-150',
              active ? 'text-blue-400' : 'text-gray-500 group-hover:text-gray-400'
            )}
            strokeWidth={1.75}
          />
          {item.name}
        </Link>
      </li>
    );
  };

  return (
    <div className="flex h-full w-64 flex-col border-r border-white/[0.06] bg-[#0f1117]">
      {/* Workspace switcher */}
      <div className="relative px-3 pb-2 pt-4" ref={accountMenuRef}>
        <button
          onClick={() => setAccountMenuOpen((open) => !open)}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors duration-150',
            accountMenuOpen ? 'bg-white/[0.08]' : 'hover:bg-white/[0.04]'
          )}
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-blue-500 to-violet-600 text-[11px] font-bold text-white shadow-sm shadow-blue-500/20">
            {userInitial || 'P'}
          </span>
          <span className="min-w-0 flex-1 overflow-hidden text-left">
            <span className="block truncate text-[13px] font-semibold text-gray-100 leading-tight">
              {workspaceTriggerLabel}
            </span>
            {userEmail && (
              <span className="block truncate text-[11px] text-gray-500 leading-tight">
                {userEmail}
              </span>
            )}
          </span>
          <ChevronDown
            className={cn(
              'ml-auto h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform duration-200',
              accountMenuOpen && 'rotate-180'
            )}
          />
        </button>

        {accountMenuOpen && (
          <div className="absolute left-3 right-3 top-full z-30 mt-1 overflow-hidden rounded-xl border border-gray-200 bg-white shadow-2xl shadow-black/20">
            {/* Current workspace info */}
            <div className="border-b border-gray-100 px-3 py-2.5">
              <p className="truncate text-[13px] font-semibold text-gray-900">
                {workspaceTitleLabel}
              </p>
              <p className="mt-0.5 truncate text-[11px] text-gray-500">
                {selectedWorkspaceRole ? `Role: ${selectedWorkspaceRole}` : userEmail || '\u00A0'}
              </p>
            </div>

            {/* Workspace list */}
            <div className="max-h-48 overflow-y-auto px-1.5 py-1.5">
              <p className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
                Workspaces
              </p>
              {workspacesLoading && <p className="px-2 py-1 text-xs text-gray-400">Loading...</p>}
              {!workspacesLoading && workspaces.length === 0 && (
                <p className="px-2 py-1 text-xs text-gray-400">No workspaces yet</p>
              )}
              {workspaces.map((workspace) => {
                const isSelected = workspace.id === resolvedWorkspaceId;
                return (
                  <button
                    key={workspace.id}
                    onClick={() => {
                      handleWorkspaceChange(workspace.id);
                      setAccountMenuOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] transition-colors',
                      isSelected
                        ? 'bg-gray-100 font-medium text-gray-900'
                        : 'text-gray-600 hover:bg-gray-50'
                    )}
                  >
                    <span className="truncate">{workspace.name}</span>
                    {isSelected && <Check className="h-3.5 w-3.5 text-blue-500" />}
                  </button>
                );
              })}
            </div>

            {/* Actions */}
            <div className="border-t border-gray-100 px-1.5 py-1.5">
              <button
                onClick={() => {
                  setWorkspaceManagerOpen(true);
                  setAccountMenuOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-gray-600 hover:bg-gray-50"
              >
                <Building2 className="h-3.5 w-3.5" />
                Manage workspaces
              </button>
              <button
                disabled
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-gray-300"
              >
                <Settings className="h-3.5 w-3.5" />
                Settings
              </button>
            </div>

            {/* Sign out */}
            <div className="border-t border-gray-100 px-1.5 py-1.5">
              <button
                onClick={() => signOut()}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-red-500 hover:bg-red-50"
              >
                <LogOut className="h-3.5 w-3.5" />
                Sign out
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Workspace manager dialog */}
      {isMounted && (
        <Dialog open={workspaceManagerOpen} onOpenChange={setWorkspaceManagerOpen}>
          <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Workspace Studio</DialogTitle>
              <DialogDescription>
                Create workspaces, add collaborators, and organize teams.
              </DialogDescription>
            </DialogHeader>

            <Tabs defaultValue="create" className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="create">
                  <Plus className="mr-1 h-4 w-4" />
                  Create
                </TabsTrigger>
                <TabsTrigger value="invite">
                  <UserPlus className="mr-1 h-4 w-4" />
                  Collaborators
                </TabsTrigger>
              </TabsList>

              <TabsContent value="create" className="space-y-3 pt-2">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-gray-700">Workspace name</label>
                  <Input
                    placeholder="e.g., PCP Team"
                    value={newWorkspaceName}
                    onChange={(event) => setNewWorkspaceName(event.target.value)}
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-700">Type</label>
                    <select
                      value={newWorkspaceType}
                      onChange={(event) =>
                        setNewWorkspaceType(event.target.value as 'personal' | 'team')
                      }
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="team">Team</option>
                      <option value="personal">Personal</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-700">Description</label>
                    <Input
                      placeholder="Optional"
                      value={newWorkspaceDescription}
                      onChange={(event) => setNewWorkspaceDescription(event.target.value)}
                    />
                  </div>
                </div>

                <Button
                  onClick={handleCreateWorkspace}
                  disabled={createWorkspaceMutation.isPending}
                  className="w-full"
                >
                  {createWorkspaceMutation.isPending ? 'Creating...' : 'Create workspace'}
                </Button>
              </TabsContent>

              <TabsContent value="invite" className="space-y-3 pt-2">
                <div className="space-y-1">
                  <label className="text-sm font-medium text-gray-700">Workspace</label>
                  <select
                    value={inviteTargetWorkspaceId}
                    onChange={(event) => setInviteWorkspaceId(event.target.value)}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {workspaces.map((workspace) => (
                      <option key={workspace.id} value={workspace.id}>
                        {workspace.name} ({workspace.role})
                      </option>
                    ))}
                  </select>
                </div>

                <div className="grid grid-cols-3 gap-3">
                  <div className="col-span-2 space-y-1">
                    <label className="text-sm font-medium text-gray-700">Collaborator email</label>
                    <Input
                      placeholder="co@example.com"
                      value={inviteEmail}
                      onChange={(event) => setInviteEmail(event.target.value)}
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-sm font-medium text-gray-700">Role</label>
                    <select
                      value={inviteRole}
                      onChange={(event) =>
                        setInviteRole(event.target.value as 'owner' | 'admin' | 'member' | 'viewer')
                      }
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                    >
                      <option value="member">member</option>
                      <option value="admin">admin</option>
                      <option value="viewer">viewer</option>
                      <option value="owner">owner</option>
                    </select>
                  </div>
                </div>

                <Button
                  onClick={handleInviteWorkspaceMember}
                  disabled={
                    inviteWorkspaceMemberMutation.isPending || !workspaceMembersData?.canManage
                  }
                  className="w-full"
                >
                  {inviteWorkspaceMemberMutation.isPending ? 'Inviting...' : 'Invite collaborator'}
                </Button>

                <div className="rounded-md border p-3">
                  <p className="mb-2 text-sm font-semibold text-gray-700">Current collaborators</p>
                  {workspaceMembersLoading && (
                    <p className="text-sm text-gray-500">Loading collaborators...</p>
                  )}
                  {!workspaceMembersLoading && workspaceMembersData?.members?.length === 0 && (
                    <p className="text-sm text-gray-500">No collaborators yet.</p>
                  )}
                  {!workspaceMembersLoading &&
                    workspaceMembersData?.members?.map((member) => (
                      <div
                        key={member.id}
                        className="flex items-center justify-between border-t py-2 text-sm first:border-t-0"
                      >
                        <div>
                          <p className="font-medium text-gray-900">
                            {member.user?.firstName ||
                              member.user?.username ||
                              member.user?.email ||
                              member.userId}
                          </p>
                          <p className="text-xs text-gray-500">
                            {member.user?.email || member.userId}
                            {member.user?.lastLoginAt ? ' · joined' : ' · invited'}
                          </p>
                        </div>
                        <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-700">
                          {member.role}
                        </span>
                      </div>
                    ))}
                </div>
              </TabsContent>
            </Tabs>

            {workspaceError && (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {workspaceError}
              </p>
            )}
            {workspaceSuccess && (
              <p className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700">
                {workspaceSuccess}
              </p>
            )}
          </DialogContent>
        </Dialog>
      )}

      {/* Navigation */}
      <nav className="flex flex-1 flex-col overflow-y-auto px-3 pt-2">
        <div className="flex flex-1 flex-col gap-y-5">
          {mainNav.map((group, groupIdx) => (
            <div key={groupIdx}>
              {group.label && (
                <p className="mb-1.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-gray-500">
                  {group.label}
                </p>
              )}
              <ul className="space-y-0.5">{group.items.map(renderNavItem)}</ul>
            </div>
          ))}
        </div>
      </nav>
    </div>
  );
}
