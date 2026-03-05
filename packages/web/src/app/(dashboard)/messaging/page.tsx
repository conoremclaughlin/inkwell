'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Users, UsersRound, Key, ArrowRight, Route, Link2 } from 'lucide-react';
import Link from 'next/link';
import { useApiQuery } from '@/lib/api';

interface TrustedUsersResponse {
  users: Array<{ id: string }>;
}

interface GroupsResponse {
  groups: Array<{ id: string }>;
}

interface ChallengeCodesResponse {
  codes: Array<{ id: string; usedAt: string | null; expiresAt: string }>;
}

const cards = [
  {
    name: 'Trusted Users',
    description: 'Manage users who can interact with your SBs via DMs.',
    href: '/messaging/trusted-users',
    icon: Users,
    queryKey: 'trusted-users' as const,
  },
  {
    name: 'Groups',
    description: 'View and manage authorized group chats.',
    href: '/messaging/groups',
    icon: UsersRound,
    queryKey: 'groups' as const,
  },
  {
    name: 'Challenge Codes',
    description: 'Generate codes to authorize new groups.',
    href: '/messaging/challenge-codes',
    icon: Key,
    queryKey: 'challenge-codes' as const,
  },
];

const relatedLinks = [
  {
    name: 'Routing',
    description: 'Control which SB handles messages on each platform and channel.',
    href: '/routing',
    icon: Route,
  },
  {
    name: 'Connections',
    description: 'Connect WhatsApp, Telegram, Discord, and other messaging platforms.',
    href: '/connected-accounts',
    icon: Link2,
  },
];

export default function MessagingPage() {
  const { data: trustedUsersData } = useApiQuery<TrustedUsersResponse>(
    ['trusted-users'],
    '/api/admin/trusted-users'
  );
  const { data: groupsData } = useApiQuery<GroupsResponse>(['groups'], '/api/admin/groups');
  const { data: codesData } = useApiQuery<ChallengeCodesResponse>(
    ['challenge-codes'],
    '/api/admin/challenge-codes'
  );

  const counts: Record<string, number | null> = {
    'trusted-users': trustedUsersData?.users?.length ?? null,
    groups: groupsData?.groups?.length ?? null,
    'challenge-codes':
      codesData?.codes?.filter((c) => !c.usedAt && new Date(c.expiresAt) > new Date())?.length ??
      null,
  };

  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900">Messaging</h1>
      <p className="mt-2 text-gray-600">
        Manage who can reach your SBs through messaging platforms.
      </p>

      <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => {
          const count = counts[card.queryKey];
          return (
            <Link key={card.name} href={card.href}>
              <Card className="hover:shadow-lg transition-shadow cursor-pointer h-full">
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">{card.name}</CardTitle>
                  <card.icon className="h-5 w-5 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  {count !== null && <div className="text-2xl font-bold mb-1">{count}</div>}
                  <CardDescription>{card.description}</CardDescription>
                  <div className="mt-3 flex items-center text-sm text-blue-600">
                    Manage
                    <ArrowRight className="ml-1 h-4 w-4" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>

      {/* Related pages */}
      <div className="mt-10">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-gray-400">Related</h2>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {relatedLinks.map((link) => (
            <Link key={link.name} href={link.href}>
              <Card className="hover:shadow-md transition-shadow cursor-pointer h-full border-dashed">
                <CardContent className="flex items-start gap-3 pt-5">
                  <link.icon className="h-5 w-5 shrink-0 text-gray-400 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-gray-900">{link.name}</p>
                    <p className="mt-0.5 text-sm text-gray-500">{link.description}</p>
                  </div>
                  <ArrowRight className="ml-auto h-4 w-4 shrink-0 text-gray-300 mt-0.5" />
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
