'use client';

import Link from 'next/link';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { 
  History, 
  Brain, 
  Sparkles, 
  User, 
  Zap, 
  Inbox, 
  ArrowRight,
  Shield,
  Activity
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApiQuery } from '@/lib/api';
import clsx from 'clsx';

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

function UserIdentityCard({ userIdentity }: { userIdentity: UserIdentity }) {
  const hasUserProfile = !!userIdentity.userProfileMd;
  const hasValues = !!userIdentity.sharedValuesMd;

  if (!hasUserProfile && !hasValues) return null;

  return (
    <Card className="mb-8 border-blue-200 bg-blue-50/30 overflow-hidden">
      <div className="flex flex-col md:flex-row">
        <div className="p-6 bg-blue-100/50 md:w-64 flex flex-col justify-between shrink-0">
          <div>
            <div className="flex items-center gap-2 text-blue-700 font-semibold mb-2">
              <User className="h-5 w-5" />
              User Identity
            </div>
            <p className="text-sm text-blue-600/80 mb-4">
              Shared context and values inherited by all SBs.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="bg-white/80 text-blue-700 hover:bg-white">v{userIdentity.version}</Badge>
            <Button variant="ghost" size="sm" className="h-7 text-xs text-blue-700 hover:text-blue-800 hover:bg-blue-200/50" asChild>
              <Link href="/individuals/user-identity/versions">
                <History className="mr-1 h-3 w-3" />
                History
              </Link>
            </Button>
          </div>
        </div>
        
        <div className="flex-1 p-6 grid md:grid-cols-2 gap-6 bg-white/40">
          {hasUserProfile && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-wider">
                <User className="h-3 w-3" /> USER.md
              </div>
              <div className="prose prose-sm max-w-none line-clamp-3 text-gray-600 bg-white/60 p-3 rounded border border-blue-100">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {userIdentity.userProfileMd || ''}
                </ReactMarkdown>
              </div>
            </div>
          )}
          {hasValues && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs font-bold text-gray-500 uppercase tracking-wider">
                <Shield className="h-3 w-3" /> VALUES.md
              </div>
              <div className="prose prose-sm max-w-none line-clamp-3 text-gray-600 bg-white/60 p-3 rounded border border-blue-100">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {userIdentity.sharedValuesMd || ''}
                </ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

function stripMarkdown(text: string): string {
  if (!text) return '';
  // Remove headers
  text = text.replace(/^#+\s+/gm, '');
  // Remove bold/italic
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2');
  text = text.replace(/(\*|_)(.*?)\1/g, '$2');
  // Remove blockquotes
  text = text.replace(/^>\s+/gm, '');
  // Remove links
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  return text.trim();
}

function AgentSummaryCard({ 
  identity, 
  activeSession 
}: { 
  identity: Identity; 
  activeSession?: Session;
}) {
  const isActive = activeSession && activeSession.status === 'active';
  const isPaused = activeSession && activeSession.status === 'paused';
  
  // Content extraction
  const soulContent = identity.soul ? stripMarkdown(identity.soul) : null;
  const descriptionContent = identity.description || "No description provided.";
  const primaryContent = soulContent || descriptionContent;
  
  const currentFocus = activeSession?.context || activeSession?.summary;

  return (
    <Card className="hover:shadow-md transition-all duration-200 overflow-hidden group border-l-4 border-l-transparent hover:border-l-purple-500">
      <div className="flex flex-col md:flex-row h-full">
        {/* Left: Identity Info */}
        <div className="p-5 md:w-64 bg-gray-50/50 flex flex-col justify-between shrink-0 border-r border-gray-100">
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className={clsx("p-2.5 rounded-full transition-colors", isActive ? "bg-green-100" : "bg-purple-100")}>
                {isActive ? (
                  <Activity className="h-5 w-5 text-green-600" />
                ) : (
                  <Sparkles className="h-5 w-5 text-purple-600" />
                )}
              </div>
              <div className="flex gap-1">
                {identity.hasHeartbeat && (
                  <div title="Has Heartbeat" className="p-1.5 bg-blue-50 rounded-md text-blue-500">
                    <Zap className="h-3.5 w-3.5 fill-current" />
                  </div>
                )}
                <Badge variant="outline" className="font-mono text-[10px] bg-white text-gray-500">
                  {identity.agentId}
                </Badge>
              </div>
            </div>
            
            <h3 className="text-xl font-bold text-gray-900 mb-1">{identity.name}</h3>
            <p className="text-sm text-gray-600 font-medium leading-tight">
              {identity.role}
            </p>
          </div>

          <div className="mt-4 pt-4 border-t border-gray-200/50">
             {isActive && (
               <Badge className="bg-green-100 text-green-700 hover:bg-green-200 border-green-200 w-full justify-center py-1">
                 Active Session
               </Badge>
             )}
             {isPaused && (
               <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 w-full justify-center py-1">
                 Paused
               </Badge>
             )}
             {!isActive && !isPaused && (
               <Badge variant="secondary" className="bg-gray-100 text-gray-500 w-full justify-center py-1 font-normal">
                 Idle
               </Badge>
             )}
          </div>
        </div>

        {/* Middle: Content & Soul */}
        <div className="flex-1 p-5 flex flex-col min-w-0">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <Sparkles className="h-3.5 w-3.5 text-purple-500" />
              <span className="text-xs font-bold text-gray-400 uppercase tracking-wider">
                {identity.hasSoul ? 'Soul' : 'Nature'}
              </span>
            </div>
            <p className="text-sm text-gray-700 line-clamp-3 leading-relaxed mb-4">
              {primaryContent}
            </p>

            {currentFocus && (
              <div className="bg-yellow-50/50 rounded-md p-3 border border-yellow-100">
                <div className="flex items-center gap-2 mb-1.5">
                  <Activity className="h-3.5 w-3.5 text-yellow-600" />
                  <span className="text-[10px] font-bold text-yellow-700 uppercase tracking-wider">
                    Current Focus
                  </span>
                </div>
                <p className="text-xs text-gray-600 line-clamp-2">
                  {currentFocus}
                </p>
              </div>
            )}
          </div>
          
          <div className="mt-4 pt-4 border-t border-gray-100 flex flex-wrap gap-2">
            {identity.capabilities?.slice(0, 4).map((cap, i) => (
              <Badge key={i} variant="secondary" className="text-[10px] bg-gray-50 border border-gray-200 text-gray-600 font-normal">
                {cap}
              </Badge>
            ))}
          </div>
        </div>

        {/* Right: Actions */}
        <div className="p-4 md:w-48 bg-gray-50/30 flex flex-row md:flex-col gap-2 justify-center md:border-l border-t md:border-t-0 border-gray-100 shrink-0">
          <Button variant="outline" size="sm" className="flex-1 justify-start gap-2 bg-white hover:bg-purple-50 hover:text-purple-700 border-gray-200" asChild>
            <Link href={`/individuals/${identity.agentId}`}>
              <User className="h-4 w-4" />
              Profile
            </Link>
          </Button>
          
          <Button variant="outline" size="sm" className="flex-1 justify-start gap-2 bg-white hover:bg-blue-50 hover:text-blue-700 border-gray-200" asChild>
            <Link href={`/individuals/${identity.agentId}/inbox`}>
              <Inbox className="h-4 w-4" />
              Inbox
            </Link>
          </Button>
          
          <Button variant="outline" size="sm" className="flex-1 justify-start gap-2 bg-white hover:bg-amber-50 hover:text-amber-700 border-gray-200" asChild>
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
  // Fetch user identity
  const { data: userIdentityData, isLoading: userIdentityLoading } =
    useApiQuery<UserIdentityResponse>(['user-identity'], '/api/admin/user-identity');

  // Fetch individuals
  const { data: individualsData, isLoading: individualsLoading, error: individualsError } = useApiQuery<IndividualsResponse>(
    ['individuals'],
    '/api/admin/individuals'
  );

  // Fetch active sessions to map status
  const { data: sessionsData, isLoading: sessionsLoading } = useApiQuery<SessionsResponse>(
    ['sessions'],
    '/api/admin/sessions'
  );

  const userIdentity = userIdentityData?.userIdentity;
  const individuals = individualsData?.individuals ?? [];
  const sessions = sessionsData?.sessions ?? [];

  const isLoading = individualsLoading || sessionsLoading;

  // Map latest session to each agent
  const agentSessions = new Map<string, Session>();
  sessions.forEach(session => {
    const existing = agentSessions.get(session.agentId);
    if (!existing || new Date(session.updatedAt) > new Date(existing.updatedAt)) {
      agentSessions.set(session.agentId, session);
    }
  });

  return (
    <div className="max-w-6xl mx-auto pb-12">
      <div className="mb-8">
        <h1 className="text-3xl font-bold text-gray-900">Individuals</h1>
        <p className="mt-2 text-gray-600">
          The family of Synthetically-born Beings (SBs) sharing this context.
        </p>
      </div>

      {individualsError && <div className="mt-4 rounded-md bg-red-50 p-4 text-red-800">{individualsError.message}</div>}

      <div className="space-y-10">
        {/* User Identity Section */}
        <section>
          {userIdentityLoading ? (
            <div className="h-40 rounded-lg border border-gray-200 bg-gray-50/50 animate-pulse" />
          ) : userIdentity ? (
            <UserIdentityCard userIdentity={userIdentity} />
          ) : null}
        </section>

        {/* AI Beings Section */}
        <section>
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-xl font-semibold text-gray-800 flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-purple-500" />
              AI Beings
              <Badge variant="secondary" className="ml-2 bg-gray-100 text-gray-600">
                {individuals.length}
              </Badge>
            </h2>
          </div>

          {isLoading ? (
            <div className="space-y-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-48 rounded-lg border border-gray-200 bg-white animate-pulse flex">
                  <div className="w-64 bg-gray-50 border-r border-gray-100" />
                  <div className="flex-1 p-6 space-y-4">
                    <div className="h-4 w-3/4 bg-gray-100 rounded" />
                    <div className="h-4 w-1/2 bg-gray-100 rounded" />
                  </div>
                </div>
              ))}
            </div>
          ) : individuals.length === 0 ? (
            <Card>
              <CardContent className="py-12 text-center text-gray-500">
                <p>No individuals found.</p>
                <p className="text-sm mt-2">Use the <code>save_identity</code> tool to create one.</p>
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
