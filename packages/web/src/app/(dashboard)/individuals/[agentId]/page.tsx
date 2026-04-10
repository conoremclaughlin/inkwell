'use client';

import { useState } from 'react';
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
  Settings,
  Share2,
  Sparkles,
  User,
  Zap,
  Save,
  Loader2,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useApiQuery, useApiPatch, useQueryClient } from '@/lib/api';
import { normalizeDocMarkdown } from '@/lib/markdown/normalize-doc';
interface RuntimeConfig {
  toolProfile?: string;
  toolRouting?: string;
  maxTurns?: number;
  passiveRecall?: {
    enabled?: boolean;
    cooldownTurns?: number;
    budgetCeiling?: number;
    maxInjectPerTurn?: number;
  };
}

interface Identity {
  id: string;
  agentId: string;
  name: string;
  role: string;
  backend?: string | null;
  description?: string;
  values?: string[];
  relationships?: Record<string, string>;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
  runtimeConfig?: RuntimeConfig | null;
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

// ─── Runtime Settings Panel ─────────────────────────────────────

const BACKENDS = [
  { value: '', label: 'Not set' },
  { value: 'claude', label: 'Claude (Anthropic)' },
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex (OpenAI)' },
  { value: 'gemini', label: 'Gemini (Google)' },
];

const TOOL_PROFILES = [
  { value: '', label: 'Not set (use CLI default)' },
  { value: 'minimal', label: 'Minimal — Read-only, no writes or comms' },
  { value: 'safe', label: 'Safe — Memory + session allowed, comms prompted' },
  { value: 'collaborative', label: 'Collaborative — Full collaboration, no prompts' },
  { value: 'full', label: 'Full — Privileged, all tools, no restrictions' },
];

const TOOL_ROUTING = [
  { value: '', label: 'Not set (use CLI default)' },
  { value: 'local', label: 'Local — Ink tools via ink-tool blocks' },
  { value: 'backend', label: 'Backend — Native MCP tool calling' },
];

function RuntimeSettingsPanel({ agentId, identity }: { agentId: string; identity: Identity }) {
  const queryClient = useQueryClient();
  const rc = identity.runtimeConfig || {};

  const [backend, setBackend] = useState(identity.backend || '');
  const [toolProfile, setToolProfile] = useState(rc.toolProfile || '');
  const [toolRouting, setToolRouting] = useState(rc.toolRouting || '');
  const [maxTurns, setMaxTurns] = useState(String(rc.maxTurns || ''));
  const [recallEnabled, setRecallEnabled] = useState(rc.passiveRecall?.enabled !== false);
  const [recallCooldown, setRecallCooldown] = useState(String(rc.passiveRecall?.cooldownTurns ?? '3'));
  const [recallCeiling, setRecallCeiling] = useState(String(rc.passiveRecall?.budgetCeiling ?? '0.8'));
  const [recallMaxInject, setRecallMaxInject] = useState(String(rc.passiveRecall?.maxInjectPerTurn ?? '2'));

  const saveSettings = useApiPatch<
    { success: boolean },
    { id: string; body: Record<string, unknown> }
  >(
    ({ id }) => `/api/admin/identities/${id}/settings`,
    ({ body }) => body,
    { onSuccess: () => queryClient.invalidateQueries({ queryKey: ['individuals'] }) }
  );

  const handleSave = () => {
    saveSettings.mutate({
      id: agentId,
      body: {
        backend: backend || null,
        toolProfile: toolProfile || null,
        toolRouting: toolRouting || null,
        maxTurns: maxTurns ? parseInt(maxTurns, 10) : null,
        passiveRecall: {
          enabled: recallEnabled,
          cooldownTurns: parseInt(recallCooldown, 10) || 3,
          budgetCeiling: parseFloat(recallCeiling) || 0.8,
          maxInjectPerTurn: parseInt(recallMaxInject, 10) || 2,
        },
      },
    });
  };

  const selectClass =
    'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-300 bg-white';
  const inputClass =
    'w-full rounded-lg border border-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-gray-300';
  const labelClass = 'block text-sm font-medium text-gray-700 mb-1';

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5 text-gray-500" />
            Runtime Settings
          </CardTitle>
          <CardDescription>
            Configure default backend, tool permissions, and passive recall for{' '}
            <span className="font-semibold">{identity.name}</span>. These are stored defaults
            used by triggers and heartbeats. Use the CLI reference below to apply them manually.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Backend */}
          <div>
            <label className={labelClass}>Default Backend</label>
            <select value={backend} onChange={(e) => setBackend(e.target.value)} className={selectClass}>
              {BACKENDS.map((b) => (
                <option key={b.value} value={b.value}>{b.label}</option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-400">Which AI provider runs this agent by default.</p>
          </div>

          <div className="grid gap-6 md:grid-cols-2">
            {/* Tool Profile */}
            <div>
              <label className={labelClass}>Tool Profile</label>
              <select value={toolProfile} onChange={(e) => setToolProfile(e.target.value)} className={selectClass}>
                {TOOL_PROFILES.map((p) => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-400">Which Ink tools are allowed without prompting.</p>
            </div>

            {/* Tool Routing */}
            <div>
              <label className={labelClass}>Tool Routing</label>
              <select value={toolRouting} onChange={(e) => setToolRouting(e.target.value)} className={selectClass}>
                {TOOL_ROUTING.map((r) => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
              <p className="mt-1 text-xs text-gray-400">How Ink tool calls are routed.</p>
            </div>
          </div>

          {/* Max Turns */}
          <div className="max-w-xs">
            <label className={labelClass}>Max Turns (automated sessions)</label>
            <input
              type="number"
              min="1"
              max="20"
              placeholder="3"
              value={maxTurns}
              onChange={(e) => setMaxTurns(e.target.value)}
              className={inputClass}
            />
            <p className="mt-1 text-xs text-gray-400">How many conversational turns in --message mode.</p>
          </div>

          {/* Passive Recall */}
          <div>
            <label className={labelClass}>Passive Recall</label>
            <div className="mt-2 space-y-3 rounded-lg border border-gray-100 p-4 bg-gray-50/50">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={recallEnabled}
                  onChange={(e) => setRecallEnabled(e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span className="text-sm text-gray-700">Enable passive memory recall</span>
              </label>

              {recallEnabled && (
                <div className="grid gap-4 md:grid-cols-3 pt-2">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Cooldown (turns)</label>
                    <input
                      type="number"
                      min="0"
                      max="20"
                      value={recallCooldown}
                      onChange={(e) => setRecallCooldown(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Budget ceiling</label>
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={recallCeiling}
                      onChange={(e) => setRecallCeiling(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Max inject/turn</label>
                    <input
                      type="number"
                      min="1"
                      max="10"
                      value={recallMaxInject}
                      onChange={(e) => setRecallMaxInject(e.target.value)}
                      className={inputClass}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Save */}
          <div className="flex items-center gap-3 pt-2">
            <Button onClick={handleSave} disabled={saveSettings.isPending}>
              {saveSettings.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
              ) : (
                <Save className="h-4 w-4 mr-2" />
              )}
              Save Settings
            </Button>
            {saveSettings.isSuccess && (
              <span className="text-sm text-green-600">Settings saved.</span>
            )}
            {saveSettings.isError && (
              <span className="text-sm text-red-600">Failed to save: {saveSettings.error?.message}</span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* CLI Quick Reference */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm text-gray-500">CLI Quick Reference</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="bg-gray-900 text-gray-100 p-3 rounded-md text-xs font-mono overflow-x-auto">
{`# Run ${identity.name} with these settings
ink chat --agent ${agentId}${backend ? ` --backend ${backend}` : ''}${toolProfile ? ` --profile ${toolProfile}` : ''}${toolRouting ? ` --tool-routing ${toolRouting}` : ''}${maxTurns ? ` --max-turns ${maxTurns}` : ''}

# Heartbeat mode
ink chat --agent ${agentId}${backend ? ` --backend ${backend}` : ''} --profile ${toolProfile || 'collaborative'} --max-turns ${maxTurns || '3'} --message "Heartbeat check"`}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
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
        <TabsList className="grid w-full grid-cols-5 lg:w-[750px]">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="soul" disabled={!identity.hasSoul}>
            Constitution
          </TabsTrigger>
          <TabsTrigger value="heartbeat" disabled={!identity.hasHeartbeat}>
            Operating guide
          </TabsTrigger>
          <TabsTrigger value="runtime">
            <Settings className="h-3.5 w-3.5 mr-1" />
            Runtime
          </TabsTrigger>
          <TabsTrigger value="raw">Advanced</TabsTrigger>
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

        {/* Runtime Settings Tab */}
        <TabsContent value="runtime" className="mt-6">
          <RuntimeSettingsPanel agentId={agentId} identity={identity} />
        </TabsContent>

        {/* Raw Identity Tab */}
        <TabsContent value="raw" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <FileText className="h-5 w-5 text-gray-500" />
                Advanced
              </CardTitle>
              <CardDescription>Raw identity data used by the system.</CardDescription>
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
