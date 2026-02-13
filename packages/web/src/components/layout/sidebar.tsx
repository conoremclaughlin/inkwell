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
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRouter } from 'next/navigation';
import { useApiQuery, useQueryClient } from '@/lib/api/hooks';
import { getSelectedWorkspaceId, setSelectedWorkspaceId } from '@/lib/workspace-selection';
import { useEffect, useMemo, useState } from 'react';
import { signOut } from '@/lib/auth/actions';

const navigation = [
  { name: 'Dashboard', href: '/', icon: Home },
  { name: 'Chat', href: '/chat', icon: MessageSquare },
  { name: 'Trusted Users', href: '/trusted-users', icon: Users },
  { name: 'Groups', href: '/groups', icon: UsersRound },
  { name: 'Challenge Codes', href: '/challenge-codes', icon: Key },
  { name: 'Individuals', href: '/individuals', icon: Bot },
  { name: 'Artifacts', href: '/artifacts', icon: FileText },
  { name: 'Reminders', href: '/reminders', icon: Bell },
  { name: 'Connections', href: '/connected-accounts', icon: Link2 },
  { name: 'Skills', href: '/skills', icon: Puzzle },
];

interface WorkspaceOption {
  id: string;
  name: string;
  slug: string;
  type: 'personal' | 'team';
}

interface WorkspaceListResponse {
  currentWorkspaceId: string;
  workspaces: WorkspaceOption[];
}

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [selectedWorkspaceId, setSelectedWorkspaceState] = useState<string | null>(null);

  const { data: workspaceData, isLoading: workspacesLoading } = useApiQuery<WorkspaceListResponse>(
    ['workspace-containers'],
    '/api/admin/workspaces',
    {
      retry: 1,
    }
  );

  const workspaces = workspaceData?.workspaces || [];

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

  const resolvedWorkspaceId = useMemo(() => {
    if (selectedWorkspaceId) return selectedWorkspaceId;
    return workspaceData?.currentWorkspaceId ?? '';
  }, [selectedWorkspaceId, workspaceData?.currentWorkspaceId]);

  const handleWorkspaceChange = (workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId);
    setSelectedWorkspaceState(workspaceId);
    // Force all data queries to refetch with the new workspace header.
    queryClient.invalidateQueries();
    router.refresh();
  };

  return (
    <div className="flex h-full w-64 flex-col bg-gray-900">
      <div className="flex h-16 shrink-0 items-center px-6">
        <span className="text-xl font-bold text-white">PCP Admin</span>
      </div>
      <div className="px-4 pb-3">
        <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-gray-400">
          Workspace
        </label>
        <select
          value={resolvedWorkspaceId}
          onChange={(e) => handleWorkspaceChange(e.target.value)}
          disabled={workspacesLoading || workspaces.length === 0}
          className="w-full rounded-md border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-100 focus:border-gray-500 focus:outline-none"
        >
          {workspaces.length === 0 && <option value="">No workspaces</option>}
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name} ({workspace.type})
            </option>
          ))}
        </select>
      </div>
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
