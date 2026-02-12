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

export function Sidebar() {
  const pathname = usePathname();

  return (
    <div className="flex h-full w-64 flex-col bg-gray-900">
      <div className="flex h-16 shrink-0 items-center px-6">
        <span className="text-xl font-bold text-white">PCP Admin</span>
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
