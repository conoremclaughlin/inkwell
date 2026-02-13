import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { MessageSquare, Users, UsersRound, Key } from 'lucide-react';
import Link from 'next/link';

const stats = [
  {
    name: 'WhatsApp',
    description: 'Manage WhatsApp connection',
    href: '/whatsapp',
    icon: MessageSquare,
  },
  {
    name: 'Trusted Users',
    description: 'Add or remove trusted users',
    href: '/trusted-users',
    icon: Users,
  },
  {
    name: 'Groups',
    description: 'View and manage authorized groups',
    href: '/groups',
    icon: UsersRound,
  },
  {
    name: 'Challenge Codes',
    description: 'Generate group authorization codes',
    href: '/challenge-codes',
    icon: Key,
  },
];

export default function DashboardPage() {
  return (
    <div>
      <h1 className="text-3xl font-bold text-gray-900">Dashboard</h1>
      <p className="mt-2 text-gray-600">
        Welcome to the PCP Admin Dashboard. Manage your WhatsApp connection, trusted users, and
        groups.
      </p>

      <div className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((item) => (
          <Link key={item.name} href={item.href}>
            <Card className="hover:shadow-lg transition-shadow cursor-pointer">
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">{item.name}</CardTitle>
                <item.icon className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <CardDescription>{item.description}</CardDescription>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
