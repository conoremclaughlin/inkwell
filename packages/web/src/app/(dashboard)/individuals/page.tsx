'use client';

import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { History, Brain, Sparkles, FileText, User, Heart, Zap, Inbox } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApiQuery } from '@/lib/api';

interface UserIdentity {
  id: string;
  userId: string;
  userProfileMd?: string;
  sharedValuesMd?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface UserIdentityResponse {
  userIdentity: UserIdentity | null;
}

interface Identity {
  id: string;
  agentId: string;
  name: string;
  role: string;
  description?: string;
  values?: string[];
  relationships?: Record<string, string>;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
  heartbeat?: string;
  soul?: string;
  hasSoul: boolean;
  hasHeartbeat: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface IndividualsResponse {
  individuals: Identity[];
}

/**
 * Generate IDENTITY.md content from identity data
 */
function generateIdentityMarkdown(identity: Identity): string {
  const lines: string[] = [];

  lines.push(`# IDENTITY.md - ${identity.name}`);
  lines.push('');
  lines.push('## Who I Am');
  lines.push('');
  lines.push(`- **Name:** ${identity.name}`);
  lines.push(`- **Role:** ${identity.role}`);
  lines.push('');

  if (identity.description) {
    lines.push('## Nature');
    lines.push('');
    lines.push(identity.description);
    lines.push('');
  }

  if (identity.values && identity.values.length > 0) {
    lines.push('## Values');
    lines.push('');
    for (const value of identity.values) {
      lines.push(`- ${value}`);
    }
    lines.push('');
  }

  if (identity.capabilities && identity.capabilities.length > 0) {
    lines.push('## Capabilities');
    lines.push('');
    for (const cap of identity.capabilities) {
      lines.push(`- ${cap}`);
    }
    lines.push('');
  }

  if (identity.relationships && Object.keys(identity.relationships).length > 0) {
    lines.push('## Relationships');
    lines.push('');
    for (const [agent, desc] of Object.entries(identity.relationships)) {
      lines.push(`- **${agent}:** ${desc}`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  const updated = new Date(identity.updatedAt).toISOString().split('T')[0];
  lines.push(`*Updated: ${updated} (v${identity.version})*`);

  return lines.join('\n');
}

function UserIdentityCard({ userIdentity }: { userIdentity: UserIdentity }) {
  const hasUserProfile = !!userIdentity.userProfileMd;
  const hasValues = !!userIdentity.sharedValuesMd;

  if (!hasUserProfile && !hasValues) {
    return (
      <Card className="mb-6 border-dashed">
        <CardContent className="py-8">
          <p className="text-center text-gray-500">
            No user identity files yet. Use the <code>save_user_identity</code> MCP tool to create
            USER.md and VALUES.md.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="mb-6 border-blue-200 bg-blue-50/30">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <User className="h-5 w-5" />
              User Identity
              <Badge variant="outline" className="font-mono text-xs">
                Shared
              </Badge>
            </CardTitle>
            <CardDescription className="mt-1">
              USER.md and VALUES.md - inherited by all SBs
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">v{userIdentity.version}</Badge>
            <Button variant="outline" size="sm" asChild>
              <Link href="/individuals/user-identity/versions">
                <History className="mr-1 h-4 w-4" />
                Versions
              </Link>
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {hasUserProfile && (
            <div className="rounded-lg border border-gray-200 bg-gray-50/30">
              <div className="flex items-center gap-2 px-4 py-2 border-b bg-white/50 rounded-t-lg">
                <User className="h-4 w-4 text-gray-600" />
                <span className="font-mono text-sm font-medium">USER.md</span>
              </div>
              <div className="p-4 prose prose-sm max-w-none dark:prose-invert prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2 prose-ul:my-2 prose-li:my-0">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {userIdentity.userProfileMd || ''}
                </ReactMarkdown>
              </div>
            </div>
          )}
          {hasValues && (
            <div className="rounded-lg border border-gray-200 bg-gray-50/30">
              <div className="flex items-center gap-2 px-4 py-2 border-b bg-white/50 rounded-t-lg">
                <Heart className="h-4 w-4 text-gray-600" />
                <span className="font-mono text-sm font-medium">VALUES.md</span>
              </div>
              <div className="p-4 prose prose-sm max-w-none dark:prose-invert prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2 prose-ul:my-2 prose-li:my-0">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {userIdentity.sharedValuesMd || ''}
                </ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function IdentityCard({ identity }: { identity: Identity }) {
  const identityMarkdown = generateIdentityMarkdown(identity);

  return (
    <Card className="mb-6">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              {identity.name}
              <Badge variant="outline" className="font-mono text-xs">
                {identity.agentId}
              </Badge>
              {identity.hasSoul && (
                <Badge variant="secondary" className="text-xs">
                  <Sparkles className="mr-1 h-3 w-3" />
                  Soul
                </Badge>
              )}
              {identity.hasHeartbeat && (
                <Badge variant="secondary" className="text-xs">
                  <Zap className="mr-1 h-3 w-3" />
                  Heartbeat
                </Badge>
              )}
            </CardTitle>
            <CardDescription className="mt-1">{identity.role}</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">v{identity.version}</Badge>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/individuals/${identity.agentId}/inbox`}>
                <Inbox className="mr-1 h-4 w-4" />
                Inbox
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/individuals/${identity.agentId}/memories`}>
                <Brain className="mr-1 h-4 w-4" />
                Memories
              </Link>
            </Button>
            <Button variant="outline" size="sm" asChild>
              <Link href={`/individuals/${identity.agentId}/versions`}>
                <History className="mr-1 h-4 w-4" />
                Versions
              </Link>
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-6">
          {/* IDENTITY.md */}
          <div className="rounded-lg border border-gray-200 bg-gray-50/30">
            <div className="flex items-center gap-2 px-4 py-2 border-b bg-white/50 rounded-t-lg">
              <FileText className="h-4 w-4 text-gray-600" />
              <span className="font-mono text-sm font-medium">IDENTITY.md</span>
            </div>
            <div className="p-4 prose prose-sm max-w-none dark:prose-invert prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2 prose-ul:my-2 prose-li:my-0">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{identityMarkdown}</ReactMarkdown>
            </div>
          </div>

          {/* SOUL.md */}
          <div className="rounded-lg border border-gray-200 bg-gray-50/30">
            <div className="flex items-center gap-2 px-4 py-2 border-b bg-white/50 rounded-t-lg">
              <Sparkles className="h-4 w-4 text-amber-500" />
              <span className="font-mono text-sm font-medium">SOUL.md</span>
            </div>
            <div className="p-4 prose prose-sm max-w-none dark:prose-invert prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2 prose-ul:my-2 prose-li:my-0">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {identity.soul || '*No soul content yet.*'}
              </ReactMarkdown>
            </div>
          </div>

          {/* HEARTBEAT.md */}
          <div className="rounded-lg border border-gray-200 bg-gray-50/30">
            <div className="flex items-center gap-2 px-4 py-2 border-b bg-white/50 rounded-t-lg">
              <Zap className="h-4 w-4 text-blue-500" />
              <span className="font-mono text-sm font-medium">HEARTBEAT.md</span>
            </div>
            <div className="p-4 prose prose-sm max-w-none dark:prose-invert prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2 prose-ul:my-2 prose-li:my-0">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {identity.heartbeat || '*No heartbeat content yet.*'}
              </ReactMarkdown>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function IndividualsPage() {
  // Fetch user identity (USER.md, VALUES.md)
  const { data: userIdentityData, isLoading: userIdentityLoading } =
    useApiQuery<UserIdentityResponse>(['user-identity'], '/api/admin/user-identity');

  // Fetch individuals
  const { data, isLoading, error } = useApiQuery<IndividualsResponse>(
    ['individuals'],
    '/api/admin/individuals'
  );

  const userIdentity = userIdentityData?.userIdentity;
  const individuals = data?.individuals ?? [];

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Individuals</h1>
          <p className="mt-2 text-gray-600">
            Identity files for you (USER.md, VALUES.md) and your AI beings (Wren, Myra, Benson).
          </p>
        </div>
      </div>

      {error && <div className="mt-4 rounded-md bg-red-50 p-4 text-red-800">{error.message}</div>}

      <div className="mt-6">
        {/* User Identity Section */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-gray-700 mb-4 flex items-center gap-2">
            <User className="h-5 w-5" />
            Your Identity (Shared)
          </h2>
          {userIdentityLoading ? (
            <Card className="border-blue-200 bg-blue-50/30">
              <CardContent className="py-8">
                <p className="text-center text-gray-500">Loading user identity...</p>
              </CardContent>
            </Card>
          ) : userIdentity ? (
            <UserIdentityCard userIdentity={userIdentity} />
          ) : (
            <Card className="mb-6 border-dashed border-blue-200">
              <CardContent className="py-8">
                <p className="text-center text-gray-500">
                  No user identity files yet. Use the <code>save_user_identity</code> MCP tool to
                  create USER.md and VALUES.md.
                </p>
              </CardContent>
            </Card>
          )}
        </div>

        {/* AI Beings Section */}
        <div>
          <h2 className="text-lg font-semibold text-gray-700 mb-4 flex items-center gap-2">
            <Sparkles className="h-5 w-5" />
            AI Beings
          </h2>
          {isLoading ? (
            <Card>
              <CardContent className="py-8">
                <p className="text-center text-gray-500">Loading individuals...</p>
              </CardContent>
            </Card>
          ) : individuals.length === 0 ? (
            <Card>
              <CardContent className="py-8">
                <p className="text-center text-gray-500">
                  No individuals found. Use the <code>save_identity</code> MCP tool to create one.
                </p>
              </CardContent>
            </Card>
          ) : (
            individuals.map((individual) => (
              <IdentityCard key={individual.id} identity={individual} />
            ))
          )}
        </div>
      </div>
    </div>
  );
}
