'use client';

import Link from 'next/link';
import { useRouter, useParams } from 'next/navigation';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  ArrowLeft,
  Brain,
  FileText,
  History,
  Inbox,
  Share2,
  Sparkles,
  User,
  Zap,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApiQuery } from '@/lib/api';
import { normalizeDocMarkdown } from '@/lib/markdown/normalize-doc';

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

export default function AgentDetailPage() {
  const params = useParams();
  const agentId = params?.agentId as string;
  const router = useRouter();

  // Fetch all individuals (since we don't have a single-get endpoint yet)
  const { data, isLoading, error } = useApiQuery<IndividualsResponse>(
    ['individuals'],
    '/api/admin/individuals'
  );

  if (isLoading) {
    return (
      <div className="p-8 text-center text-gray-500">
        <p>Loading agent details...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 rounded-md bg-red-50 text-red-800">
        Error loading individuals: {error.message}
      </div>
    );
  }

  const identity = data?.individuals.find((i) => i.agentId === agentId);

  if (!identity) {
    return (
      <div className="p-8 text-center">
        <h2 className="text-xl font-bold text-gray-900">Agent Not Found</h2>
        <p className="mt-2 text-gray-600">Could not find an agent with ID "{agentId}".</p>
        <Button className="mt-4" onClick={() => router.push('/individuals')}>
          Back to Individuals
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <Button variant="ghost" size="sm" asChild className="mb-2 -ml-2 text-gray-500">
            <Link href="/individuals">
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back to List
            </Link>
          </Button>
          <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-2">
            {identity.name}
            <Badge variant="outline" className="font-mono text-lg">
              {identity.agentId}
            </Badge>
          </h1>
          <p className="mt-1 text-lg text-gray-600">{identity.role}</p>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/individuals/${agentId}/inbox`}>
              <Inbox className="mr-2 h-4 w-4" />
              Inbox
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/individuals/${agentId}/memories`}>
              <Brain className="mr-2 h-4 w-4" />
              Memories
            </Link>
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href={`/individuals/${agentId}/versions`}>
              <History className="mr-2 h-4 w-4" />v{identity.version} History
            </Link>
          </Button>
        </div>
      </div>

      {/* Main Content Tabs */}
      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="grid w-full grid-cols-4 lg:w-[600px]">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="soul" disabled={!identity.hasSoul}>
            Constitution
          </TabsTrigger>
          <TabsTrigger value="heartbeat" disabled={!identity.hasHeartbeat}>
            Operating guide
          </TabsTrigger>
          <TabsTrigger value="raw">Identity JSON</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="mt-6 space-y-6">
          {/* Description */}
          {identity.description && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <User className="h-5 w-5 text-blue-500" />
                  Nature & Purpose
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-gray-700 leading-relaxed">{identity.description}</p>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-6 md:grid-cols-2">
            {/* Values */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Sparkles className="h-5 w-5 text-amber-500" />
                  Core Values
                </CardTitle>
              </CardHeader>
              <CardContent>
                {identity.values && identity.values.length > 0 ? (
                  <ul className="list-disc list-inside space-y-2 text-gray-700">
                    {identity.values.map((v, i) => (
                      <li key={i}>{v}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-gray-500 italic">No explicit values defined.</p>
                )}
              </CardContent>
            </Card>

            {/* Capabilities */}
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Zap className="h-5 w-5 text-purple-500" />
                  Capabilities
                </CardTitle>
              </CardHeader>
              <CardContent>
                {identity.capabilities && identity.capabilities.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {identity.capabilities.map((c, i) => (
                      <Badge key={i} variant="secondary">
                        {c}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-gray-500 italic">No capabilities listed.</p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Relationships */}
          {identity.relationships && Object.keys(identity.relationships).length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg flex items-center gap-2">
                  <Share2 className="h-5 w-5 text-green-500" />
                  Relationships
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-4 sm:grid-cols-2">
                  {Object.entries(identity.relationships).map(([relAgent, desc]) => (
                    <div
                      key={relAgent}
                      className="p-3 bg-gray-50 rounded-lg border border-gray-100"
                    >
                      <div className="font-semibold text-gray-900 mb-1 capitalize">{relAgent}</div>
                      <div className="text-sm text-gray-600">{desc}</div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* Soul Tab */}
        <TabsContent value="soul" className="mt-6">
          <Card className="border-amber-200 bg-amber-50/10">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-amber-500" />
                Constitution
              </CardTitle>
              <CardDescription>
                Narrative principles and worldview (stored in <code>soul.md</code>).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:mt-4 prose-headings:mb-2 prose-p:my-2">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {normalizeDocMarkdown(identity.soul)}
                </ReactMarkdown>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Heartbeat Tab */}
        <TabsContent value="heartbeat" className="mt-6">
          <Card className="border-blue-200 bg-blue-50/10">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-blue-500" />
                Operating guide
              </CardTitle>
              <CardDescription>
                Operational checklist and wake-up protocols (stored in <code>heartbeat.md</code>).
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="prose prose-sm max-w-none dark:prose-invert">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {normalizeDocMarkdown(identity.heartbeat)}
                </ReactMarkdown>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Raw Identity Tab */}
        <TabsContent value="raw" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-gray-500" />
                Identity JSON
              </CardTitle>
              <CardDescription>Structured identity payload used by API/UI.</CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="bg-gray-900 text-gray-100 p-4 rounded-md overflow-x-auto text-sm font-mono">
                {JSON.stringify(identity, null, 2)}
              </pre>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
