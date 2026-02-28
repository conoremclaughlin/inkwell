'use client';

import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import clsx from 'clsx';
import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useApiQuery } from '@/lib/api';
import { normalizeDocMarkdown } from '@/lib/markdown/normalize-doc';
import {
  Activity,
  ArrowRight,
  Brain,
  History,
  Inbox,
  Shield,
  Sparkles,
  User,
  Workflow,
  Zap,
} from 'lucide-react';

interface UserIdentity {
  id: string;
  userId: string;
  userProfile?: string;
  sharedValues?: string;
  process?: string;
  // Deprecated aliases kept for compatibility during migration
  userProfileMd?: string;
  sharedValuesMd?: string;
  processMd?: string;
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

interface Session {
  id: string;
  agentId: string;
  status: string;
  currentPhase: string | null;
  context: string | null;
  summary: string | null;
  updatedAt: string;
}

interface SessionsResponse {
  sessions: Session[];
}

interface IndividualsResponse {
  individuals: Identity[];
}

function stripMarkdown(text: string): string {
  if (!text) return '';
  text = text.replace(/^#+\s+/gm, '');
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  text = text.replace(/^>\s+/gm, '');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return text.trim();
}

function SharedDocPreview({
  icon,
  title,
  subtitle,
  content,
}: {
  icon: ReactNode;
  title: string;
  subtitle: string;
  content?: string;
}) {
  const hasContent = Boolean(content?.trim());

  return (
    <div className="rounded-xl border bg-white/80 p-4">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-gray-700">
        {icon}
        <span>{title}</span>
      </div>
      <p className="mb-3 text-xs uppercase tracking-wide text-gray-400">{subtitle}</p>
      {hasContent ? (
        <div className="prose prose-sm max-w-none line-clamp-4 text-gray-600">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{content || ''}</ReactMarkdown>
        </div>
      ) : (
        <p className="text-sm italic text-gray-400">No document yet.</p>
      )}
    </div>
  );
}

function SharedContextCard({ userIdentity }: { userIdentity: UserIdentity }) {
  const userProfile = userIdentity.userProfile ?? userIdentity.userProfileMd;
  const sharedValues = userIdentity.sharedValues ?? userIdentity.sharedValuesMd;
  const process = userIdentity.process ?? userIdentity.processMd;
  const hasAnyDocument = Boolean(
    userProfile || sharedValues || process
  );

  if (!hasAnyDocument) return null;

  return (
    <Card className="overflow-hidden border-indigo-200 bg-gradient-to-br from-indigo-50 via-white to-blue-50">
      <CardHeader className="border-b border-indigo-100 bg-white/60">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-xl text-gray-900">
              <Shield className="h-5 w-5 text-indigo-600" />
              Shared context
            </CardTitle>
            <CardDescription className="mt-1 text-sm text-gray-600">
              The common foundation across all SBs: who you are, what we value, and how we work.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="bg-indigo-100 text-indigo-700">
              v{userIdentity.version}
            </Badge>
            <Button variant="outline" size="sm" asChild>
              <Link href="/individuals/shared/versions">
                <History className="mr-1 h-4 w-4" />
                Version history
              </Link>
            </Button>
            <Button size="sm" asChild>
              <Link href="/individuals/shared">
                Open shared docs
                <ArrowRight className="ml-1 h-4 w-4" />
              </Link>
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 p-4 md:grid-cols-3">
        <SharedDocPreview
          icon={<User className="h-4 w-4 text-blue-600" />}
          title="About you"
          subtitle="User profile"
          content={normalizeDocMarkdown(userProfile)}
        />
        <SharedDocPreview
          icon={<Sparkles className="h-4 w-4 text-amber-600" />}
          title="Shared values"
          subtitle="Core principles"
          content={normalizeDocMarkdown(sharedValues)}
        />
        <SharedDocPreview
          icon={<Workflow className="h-4 w-4 text-emerald-600" />}
          title="Team process"
          subtitle="Operating rhythm"
          content={normalizeDocMarkdown(process)}
        />
      </CardContent>
    </Card>
  );
}

function AgentSummaryCard({
  identity,
  activeSession,
}: {
  identity: Identity;
  activeSession?: Session;
}) {
  const isActive = activeSession && activeSession.status === 'active';
  const isPaused = activeSession && activeSession.status === 'paused';

  const constitutionContent = identity.soul ? stripMarkdown(identity.soul) : null;
  const descriptionContent = identity.description || 'No description provided.';
  const primaryContent = constitutionContent || descriptionContent;

  const currentFocus = activeSession?.context || activeSession?.summary;

  return (
    <Card className="group overflow-hidden border-l-4 border-l-transparent transition-all duration-200 hover:border-l-purple-500 hover:shadow-md">
      <div className="flex h-full flex-col md:flex-row">
        <div className="shrink-0 border-r border-gray-100 bg-gray-50/50 p-5 md:w-64">
          <div className="mb-4 flex items-start justify-between">
            <div className={clsx('rounded-full p-2.5', isActive ? 'bg-green-100' : 'bg-purple-100')}>
              {isActive ? (
                <Activity className="h-5 w-5 text-green-600" />
              ) : (
                <Sparkles className="h-5 w-5 text-purple-600" />
              )}
            </div>
            <div className="flex gap-1">
              {identity.hasHeartbeat && (
                <div title="Has operational guide" className="rounded-md bg-blue-50 p-1.5 text-blue-500">
                  <Zap className="h-3.5 w-3.5 fill-current" />
                </div>
              )}
              <Badge variant="outline" className="font-mono text-[10px] text-gray-500">
                {identity.agentId}
              </Badge>
            </div>
          </div>

          <h3 className="mb-1 text-xl font-bold text-gray-900">{identity.name}</h3>
          <p className="text-sm font-medium leading-tight text-gray-600">{identity.role}</p>

          <div className="mt-4 border-t border-gray-200/60 pt-4">
            {isActive && (
              <Badge className="w-full justify-center border-green-200 bg-green-100 py-1 text-green-700 hover:bg-green-200">
                Active
              </Badge>
            )}
            {isPaused && (
              <Badge variant="outline" className="w-full justify-center border-amber-200 bg-amber-50 py-1 text-amber-700">
                Paused
              </Badge>
            )}
            {!isActive && !isPaused && (
              <Badge variant="secondary" className="w-full justify-center bg-gray-100 py-1 font-normal text-gray-500">
                Idle
              </Badge>
            )}
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col p-5">
          <div className="flex-1">
            <div className="mb-2 flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-purple-500" />
              <span className="text-xs font-bold uppercase tracking-wider text-gray-400">
                {identity.hasSoul ? 'Constitution' : 'Overview'}
              </span>
            </div>
            <p className="mb-4 line-clamp-3 text-sm leading-relaxed text-gray-700">{primaryContent}</p>

            {currentFocus && (
              <div className="rounded-md border border-yellow-100 bg-yellow-50/50 p-3">
                <div className="mb-1.5 flex items-center gap-2">
                  <Activity className="h-3.5 w-3.5 text-yellow-600" />
                  <span className="text-[10px] font-bold uppercase tracking-wider text-yellow-700">
                    Current focus
                  </span>
                </div>
                <p className="line-clamp-2 text-xs text-gray-600">{currentFocus}</p>
              </div>
            )}
          </div>

          <div className="mt-4 flex flex-wrap gap-2 border-t border-gray-100 pt-4">
            {identity.capabilities?.slice(0, 4).map((cap, i) => (
              <Badge
                key={i}
                variant="secondary"
                className="border border-gray-200 bg-gray-50 text-[10px] font-normal text-gray-600"
              >
                {cap}
              </Badge>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 flex-row gap-2 border-t border-gray-100 bg-gray-50/30 p-4 md:w-48 md:flex-col md:border-l md:border-t-0">
          <Button
            variant="outline"
            size="sm"
            className="flex-1 justify-start gap-2 border-gray-200 bg-white hover:bg-purple-50 hover:text-purple-700"
            asChild
          >
            <Link href={`/individuals/${identity.agentId}`}>
              <User className="h-4 w-4" />
              Profile
            </Link>
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="flex-1 justify-start gap-2 border-gray-200 bg-white hover:bg-blue-50 hover:text-blue-700"
            asChild
          >
            <Link href={`/individuals/${identity.agentId}/inbox`}>
              <Inbox className="h-4 w-4" />
              Inbox
            </Link>
          </Button>

          <Button
            variant="outline"
            size="sm"
            className="flex-1 justify-start gap-2 border-gray-200 bg-white hover:bg-amber-50 hover:text-amber-700"
            asChild
          >
            <Link href={`/individuals/${identity.agentId}/memories`}>
              <Brain className="h-4 w-4" />
              Memories
            </Link>
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function IndividualsPage() {
  const { data: userIdentityData, isLoading: userIdentityLoading } = useApiQuery<UserIdentityResponse>(
    ['user-identity'],
    '/api/admin/user-identity'
  );

  const {
    data: individualsData,
    isLoading: individualsLoading,
    error: individualsError,
  } = useApiQuery<IndividualsResponse>(['individuals'], '/api/admin/individuals');

  const { data: sessionsData, isLoading: sessionsLoading } = useApiQuery<SessionsResponse>(
    ['sessions'],
    '/api/admin/sessions'
  );

  const userIdentity = userIdentityData?.userIdentity;
  const individuals = individualsData?.individuals ?? [];
  const sessions = sessionsData?.sessions ?? [];

  const isLoading = individualsLoading || sessionsLoading;

  const agentSessions = new Map<string, Session>();
  sessions.forEach((session) => {
    const existing = agentSessions.get(session.agentId);
    if (!existing || new Date(session.updatedAt) > new Date(existing.updatedAt)) {
      agentSessions.set(session.agentId, session);
    }
  });

  return (
    <div className="mx-auto max-w-6xl pb-12">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Individuals</h1>
        <p className="mt-2 text-gray-600">
          Command center for SB identities, shared context, and active collaboration.
        </p>
      </div>

      {individualsError && (
        <div className="mt-4 rounded-md bg-red-50 p-4 text-red-800">{individualsError.message}</div>
      )}

      <div className="space-y-10">
        <section>
          {userIdentityLoading ? (
            <div className="h-40 animate-pulse rounded-lg border border-gray-200 bg-gray-50/50" />
          ) : userIdentity ? (
            <SharedContextCard userIdentity={userIdentity} />
          ) : null}
        </section>

        <section>
          <div className="mb-6 flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-xl font-semibold text-gray-800">
              <Sparkles className="h-5 w-5 text-purple-500" />
              AI beings
              <Badge variant="secondary" className="ml-2 bg-gray-100 text-gray-600">
                {individuals.length}
              </Badge>
            </h2>
          </div>

          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="flex h-48 animate-pulse rounded-lg border border-gray-200 bg-white">
                  <div className="w-64 border-r border-gray-100 bg-gray-50" />
                  <div className="flex-1 space-y-4 p-6">
                    <div className="h-4 w-3/4 rounded bg-gray-100" />
                    <div className="h-4 w-1/2 rounded bg-gray-100" />
                  </div>
                </div>
              ))}
            </div>
          ) : individuals.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-gray-500">
                <p>No individuals found.</p>
                <p className="mt-2 text-sm">
                  Use the <code>save_identity</code> tool to create one.
                </p>
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-6">
              {individuals.map((individual) => (
                <AgentSummaryCard
                  key={individual.id}
                  identity={individual}
                  activeSession={agentSessions.get(individual.agentId)}
                />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
