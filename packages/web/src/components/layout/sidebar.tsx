'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Users,
  UsersRound,
  Key,
  LogOut,
  Home,
  Bot,
  Bell,
  Link2,
  FileText,
  Puzzle,
  MessageSquare,
  Plus,
  UserPlus,
  Building2,
  ChevronDown,
  Check,
  Settings,
  Activity,
  Route,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRouter } from 'next/navigation';
import { useApiPost, useApiPostDynamic, useApiQuery, useQueryClient } from '@/lib/api/hooks';
import { getSelectedWorkspaceId, setSelectedWorkspaceId } from '@/lib/workspace-selection';
import { useEffect, useMemo, useRef, useState } from 'react';
import { signOut } from '@/lib/auth/actions';
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

const navigation = [
  { name: 'Dashboard', href: '/', icon: Home },
  { name: 'Chat', href: '/chat', icon: MessageSquare },
  { name: 'Sessions', href: '/sessions', icon: Activity },
  { name: 'Trusted Users', href: '/trusted-users', icon: Users },
  { name: 'Groups', href: '/groups', icon: UsersRound },
  { name: 'Challenge Codes', href: '/challenge-codes', icon: Key },
  { name: 'Individuals', href: '/individuals', icon: Bot },
  { name: 'Artifacts', href: '/artifacts', icon: FileText },
  { name: 'Reminders', href: '/reminders', icon: Bell },
  { name: 'Routing', href: '/routing', icon: Route },
  { name: 'Connections', href: '/connected-accounts', icon: Link2 },
  { name: 'Skills', href: '/skills', icon: Puzzle },
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
      queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      queryClient.invalidateQueries({ queryKey: ['workspace-members', createdWorkspaceId] });
      router.refresh();
    },
    onError: (error) => {
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
        queryClient.invalidateQueries({ queryKey: ['workspace-members', variables.workspaceId] });
      },
      onError: (error) => {
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
      setWorkspaceError('Workspace name is required');
      return;
    }

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
      setWorkspaceError('Valid collaborator email is required');
      return;
    }

    if (!inviteTargetWorkspaceId) {
      setWorkspaceError('Select a workspace before inviting');
      return;
    }

    setWorkspaceError(null);
    inviteWorkspaceMemberMutation.mutate({
      workspaceId: inviteTargetWorkspaceId,
      email: trimmedInviteEmail,
      role: inviteRole,
    });
  };

  return (
    <div className="flex h-full w-64 flex-col bg-gray-900">
      <div className="relative border-b border-gray-800 px-4 py-3" ref={accountMenuRef}>
        <span className="text-lg font-bold text-white">PCP Admin</span>
        <button
          onClick={() => setAccountMenuOpen((open) => !open)}
          className="mt-3 flex w-full items-center justify-between rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-gray-100 hover:bg-gray-700"
        >
          <span className="flex min-w-0 items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded bg-gray-600 text-xs font-semibold">
              {userInitial}
            </span>
            <span className="truncate text-sm font-medium">{workspaceTriggerLabel}</span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0" />
        </button>

        {accountMenuOpen && (
          <div className="absolute left-4 right-4 top-full z-30 mt-2 rounded-xl border border-gray-200 bg-white p-3 shadow-2xl">
            <div className="rounded-md border border-gray-200 bg-gray-50 p-2">
              <p className="truncate text-sm font-semibold text-gray-900">{workspaceTitleLabel}</p>
              <p className="mt-1 truncate text-xs text-gray-500">{userEmail || '\u00A0'}</p>
              <p className="truncate text-xs text-gray-500">
                {selectedWorkspaceRole ? `Role: ${selectedWorkspaceRole}` : '\u00A0'}
              </p>
            </div>

            <div className="mt-3 space-y-1 rounded-md border border-gray-200 bg-gray-50 p-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                Workspaces
              </p>
              {workspacesLoading && <p className="text-xs text-gray-500">Loading workspaces...</p>}
              {!workspacesLoading && workspaces.length === 0 && (
                <p className="text-xs text-gray-500">No workspaces yet</p>
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
                    className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm text-gray-700 hover:bg-gray-100"
                  >
                    <span className="truncate">
                      {workspace.name}{' '}
                      <span className="text-xs text-gray-500">({workspace.role || 'member'})</span>
                    </span>
                    {isSelected && <Check className="h-4 w-4 text-gray-700" />}
                  </button>
                );
              })}
            </div>

            <div className="mt-3 grid grid-cols-2 gap-2">
              <button
                onClick={() => {
                  setWorkspaceManagerOpen(true);
                  setAccountMenuOpen(false);
                }}
                className="rounded border border-gray-300 px-2 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                <span className="inline-flex items-center gap-1">
                  <Building2 className="h-4 w-4" />
                  Manage
                </span>
              </button>
              <button
                disabled
                className="flex items-center justify-center gap-1 rounded border border-gray-200 px-2 py-2 text-sm font-medium text-gray-400"
              >
                <Settings className="h-4 w-4" />
                Settings
              </button>
            </div>

            <button
              onClick={() => signOut()}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded bg-gray-900 px-3 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              <LogOut className="h-4 w-4" />
              Log out
            </button>
          </div>
        )}
      </div>
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
          </DialogContent>
        </Dialog>
      )}
      <nav className="flex flex-1 flex-col">
        <ul className="flex flex-1 flex-col gap-y-1 px-3">
          {navigation.map((item) => {
            const isActive = pathname === item.href;
            return (
              <li key={item.name}>
                <Link
                  href={item.href}
                  className={cn(
                    'group flex gap-x-3 rounded-md p-3 text-sm font-semibold leading-6',
                    isActive
                      ? 'bg-gray-800 text-white'
                      : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                  )}
                >
                  <item.icon className="h-6 w-6 shrink-0" />
                  {item.name}
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="px-3 pb-4">
          <button
            onClick={() => signOut()}
            className="group flex w-full gap-x-3 rounded-md p-3 text-sm font-semibold leading-6 text-gray-400 hover:bg-gray-800 hover:text-white"
          >
            <LogOut className="h-6 w-6 shrink-0" />
            Sign out
          </button>
        </div>
      </nav>
    </div>
  );
}
