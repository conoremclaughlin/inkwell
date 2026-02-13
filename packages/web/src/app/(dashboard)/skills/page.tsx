'use client';

import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Puzzle,
  Terminal,
  FileText,
  CheckCircle,
  AlertCircle,
  XCircle,
  RefreshCw,
  Search,
  Folder,
  Code,
  BookOpen,
  Wrench,
  Filter,
  Download,
  Github,
  FolderPlus,
  ExternalLink,
  Copy,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useApiQuery, apiPost } from '@/lib/api';
import { useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { useState } from 'react';

type SkillType = 'mini-app' | 'cli' | 'guide';
type SkillStatus = 'available' | 'installed' | 'needs-setup' | 'disabled';

interface EligibilityResult {
  eligible: boolean;
  missingBins?: string[];
  missingEnv?: string[];
  missingConfig?: string[];
  unsupportedOs?: boolean;
  message?: string;
}

interface SkillSummary {
  name: string;
  displayName: string;
  description: string;
  type: SkillType;
  emoji?: string;
  category?: string;
  tags?: string[];
  version: string;
  status: SkillStatus;
  triggers?: string[];
  functionCount?: number;
  capabilities?: {
    vision?: boolean;
    memory?: boolean;
    network?: boolean;
    filesystem?: boolean;
    shell?: boolean;
  };
  eligibility: EligibilityResult;
}

interface SkillsListResponse {
  skills: SkillSummary[];
  categories: string[];
  totalCount: number;
}

const typeConfig: Record<
  SkillType,
  { label: string; icon: React.ReactNode; color: string; bgColor: string }
> = {
  'mini-app': {
    label: 'Mini App',
    icon: <Code className="h-4 w-4" />,
    color: 'text-purple-600',
    bgColor: 'bg-purple-100',
  },
  cli: {
    label: 'CLI Tool',
    icon: <Terminal className="h-4 w-4" />,
    color: 'text-blue-600',
    bgColor: 'bg-blue-100',
  },
  guide: {
    label: 'Guide',
    icon: <BookOpen className="h-4 w-4" />,
    color: 'text-green-600',
    bgColor: 'bg-green-100',
  },
};

const statusConfig: Record<
  SkillStatus,
  { label: string; icon: typeof CheckCircle; color: string; bgColor: string }
> = {
  available: {
    label: 'Available',
    icon: CheckCircle,
    color: 'text-green-600',
    bgColor: 'bg-green-100',
  },
  installed: {
    label: 'Installed',
    icon: CheckCircle,
    color: 'text-blue-600',
    bgColor: 'bg-blue-100',
  },
  'needs-setup': {
    label: 'Needs Setup',
    icon: AlertCircle,
    color: 'text-yellow-600',
    bgColor: 'bg-yellow-100',
  },
  disabled: {
    label: 'Disabled',
    icon: XCircle,
    color: 'text-gray-600',
    bgColor: 'bg-gray-100',
  },
};

function CapabilityBadge({ name, enabled }: { name: string; enabled?: boolean }) {
  if (!enabled) return null;
  return (
    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-gray-100 text-gray-600">
      {name}
    </span>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="p-1 rounded hover:bg-gray-700 transition-colors"
      title="Copy to clipboard"
    >
      {copied ? (
        <CheckCircle className="h-4 w-4 text-green-400" />
      ) : (
        <Copy className="h-4 w-4 text-gray-400" />
      )}
    </button>
  );
}

function CodeBlock({ children }: { children: string }) {
  return (
    <div className="relative bg-gray-900 rounded-lg p-3 font-mono text-sm text-gray-100 overflow-x-auto">
      <div className="absolute top-2 right-2">
        <CopyButton text={children} />
      </div>
      <pre className="pr-8">{children}</pre>
    </div>
  );
}

export default function SkillsPage() {
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<SkillType | 'all'>('all');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showAddSkills, setShowAddSkills] = useState(false);

  const { data, isLoading, error, refetch } = useApiQuery<SkillsListResponse>(
    ['skills', typeFilter, searchQuery],
    `/api/admin/skills${buildQueryString({ type: typeFilter === 'all' ? undefined : typeFilter, search: searchQuery || undefined })}`
  );

  const skills = data?.skills ?? [];
  const categories = data?.categories ?? [];
  const totalCount = data?.totalCount ?? 0;

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await apiPost('/api/admin/skills/refresh', {});
      await refetch();
    } finally {
      setIsRefreshing(false);
    }
  };

  // Group skills by category
  const skillsByCategory = skills.reduce(
    (acc, skill) => {
      const category = skill.category || 'Uncategorized';
      if (!acc[category]) acc[category] = [];
      acc[category].push(skill);
      return acc;
    },
    {} as Record<string, SkillSummary[]>
  );

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Skills & Mini Apps</h1>
          <p className="mt-2 text-gray-600">
            Extend your assistant's capabilities with skills, tools, and guides
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/skills/registry">
            <Button variant="default">
              <Download className="mr-2 h-4 w-4" />
              Browse Registry
            </Button>
          </Link>
          <Button variant="outline" onClick={handleRefresh} disabled={isRefreshing}>
            <RefreshCw className={clsx('mr-2 h-4 w-4', isRefreshing && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {error && <div className="mt-4 rounded-md bg-red-50 p-4 text-red-800">{error.message}</div>}

      {/* Filters */}
      <Card className="mt-6">
        <CardContent className="p-4">
          <div className="flex flex-col sm:flex-row gap-4">
            {/* Search */}
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
              <Input
                placeholder="Search skills..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>

            {/* Type Filter */}
            <div className="flex items-center gap-2">
              <Filter className="h-4 w-4 text-gray-400" />
              <div className="flex gap-1">
                <Button
                  variant={typeFilter === 'all' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setTypeFilter('all')}
                >
                  All
                </Button>
                {Object.entries(typeConfig).map(([type, config]) => (
                  <Button
                    key={type}
                    variant={typeFilter === type ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setTypeFilter(type as SkillType)}
                    className="gap-1"
                  >
                    {config.icon}
                    {config.label}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-6">
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-purple-100 text-purple-600">
              <Puzzle className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{totalCount}</p>
              <p className="text-sm text-gray-500">Total Skills</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-green-100 text-green-600">
              <CheckCircle className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {skills.filter((s) => s.eligibility.eligible).length}
              </p>
              <p className="text-sm text-gray-500">Ready to Use</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-yellow-100 text-yellow-600">
              <Wrench className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">
                {skills.filter((s) => !s.eligibility.eligible).length}
              </p>
              <p className="text-sm text-gray-500">Need Setup</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4 flex items-center gap-3">
            <div className="p-2 rounded-lg bg-blue-100 text-blue-600">
              <Folder className="h-5 w-5" />
            </div>
            <div>
              <p className="text-2xl font-bold">{categories.length}</p>
              <p className="text-sm text-gray-500">Categories</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Skills List */}
      {isLoading ? (
        <Card className="mt-6">
          <CardContent className="p-8 text-center text-gray-500">Loading skills...</CardContent>
        </Card>
      ) : skills.length === 0 ? (
        <Card className="mt-6">
          <CardContent className="p-8 text-center">
            <Puzzle className="h-12 w-12 mx-auto text-gray-300 mb-3" />
            <p className="text-gray-500 font-medium">No skills found</p>
            <p className="text-sm text-gray-400 mt-1 mb-4">
              Get started by adding skills to{' '}
              <code className="bg-gray-100 px-1 rounded">~/.pcp/skills/</code>
            </p>
            <div className="flex justify-center gap-3">
              <Button variant="outline" size="sm" onClick={() => setShowAddSkills(true)}>
                <FolderPlus className="mr-2 h-4 w-4" />
                Learn How
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="mt-6 space-y-6">
          {Object.entries(skillsByCategory).map(([category, categorySkills]) => (
            <Card key={category}>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Folder className="h-4 w-4 text-gray-400" />
                  {category}
                </CardTitle>
                <CardDescription>
                  {categorySkills.length} skill{categorySkills.length !== 1 ? 's' : ''}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {categorySkills.map((skill) => {
                    const typeCfg = typeConfig[skill.type];
                    const statusCfg = statusConfig[skill.status];
                    const StatusIcon = statusCfg.icon;

                    return (
                      <div
                        key={skill.name}
                        className={clsx(
                          'rounded-lg border p-4 transition-colors',
                          skill.eligibility.eligible
                            ? 'border-gray-200 hover:border-gray-300'
                            : 'border-yellow-200 bg-yellow-50/30'
                        )}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex items-start gap-3">
                            <div className={clsx('p-2 rounded-lg', typeCfg.bgColor, typeCfg.color)}>
                              {skill.emoji ? (
                                <span className="text-lg">{skill.emoji}</span>
                              ) : (
                                typeCfg.icon
                              )}
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <h3 className="font-medium text-gray-900">{skill.displayName}</h3>
                                <Badge className={clsx('text-xs', typeCfg.bgColor, typeCfg.color)}>
                                  {typeCfg.icon}
                                  <span className="ml-1">{typeCfg.label}</span>
                                </Badge>
                                <Badge
                                  className={clsx('text-xs', statusCfg.bgColor, statusCfg.color)}
                                >
                                  <StatusIcon className="h-3 w-3 mr-1" />
                                  {statusCfg.label}
                                </Badge>
                              </div>
                              <p className="text-sm text-gray-600 mt-1">{skill.description}</p>

                              {/* Triggers */}
                              {skill.triggers && skill.triggers.length > 0 && (
                                <div className="flex flex-wrap gap-1 mt-2">
                                  {skill.triggers.slice(0, 5).map((trigger) => (
                                    <span
                                      key={trigger}
                                      className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-blue-50 text-blue-600"
                                    >
                                      {trigger}
                                    </span>
                                  ))}
                                  {skill.triggers.length > 5 && (
                                    <span className="text-xs text-gray-400">
                                      +{skill.triggers.length - 5} more
                                    </span>
                                  )}
                                </div>
                              )}

                              {/* Capabilities */}
                              {skill.capabilities && (
                                <div className="flex gap-1 mt-2">
                                  <CapabilityBadge
                                    name="Vision"
                                    enabled={skill.capabilities.vision}
                                  />
                                  <CapabilityBadge
                                    name="Memory"
                                    enabled={skill.capabilities.memory}
                                  />
                                  <CapabilityBadge
                                    name="Network"
                                    enabled={skill.capabilities.network}
                                  />
                                  <CapabilityBadge
                                    name="Files"
                                    enabled={skill.capabilities.filesystem}
                                  />
                                  <CapabilityBadge
                                    name="Shell"
                                    enabled={skill.capabilities.shell}
                                  />
                                </div>
                              )}

                              {/* Function count for mini-apps */}
                              {skill.type === 'mini-app' && skill.functionCount !== undefined && (
                                <p className="text-xs text-gray-400 mt-2">
                                  {skill.functionCount} function
                                  {skill.functionCount !== 1 ? 's' : ''}
                                </p>
                              )}

                              {/* Eligibility issues */}
                              {!skill.eligibility.eligible && skill.eligibility.message && (
                                <div className="mt-2 flex items-start gap-1 text-sm text-yellow-700">
                                  <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                                  <span>{skill.eligibility.message}</span>
                                </div>
                              )}
                            </div>
                          </div>
                          <div className="text-right">
                            <span className="text-xs text-gray-400">v{skill.version}</span>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* How to Add Skills */}
      <Card className="mt-6">
        <CardHeader className="cursor-pointer" onClick={() => setShowAddSkills(!showAddSkills)}>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FolderPlus className="h-5 w-5 text-gray-400" />
              <CardTitle className="text-lg">How to Add Skills</CardTitle>
            </div>
            {showAddSkills ? (
              <ChevronUp className="h-5 w-5 text-gray-400" />
            ) : (
              <ChevronDown className="h-5 w-5 text-gray-400" />
            )}
          </div>
          <CardDescription>
            Learn how to install skills from registries or create your own
          </CardDescription>
        </CardHeader>
        {showAddSkills && (
          <CardContent className="space-y-6">
            {/* Skill Locations */}
            <div>
              <h4 className="font-medium text-gray-900 mb-2">Skill Locations</h4>
              <p className="text-sm text-gray-600 mb-3">
                Skills are automatically loaded from these directories:
              </p>
              <div className="space-y-2">
                <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
                  <Folder className="h-5 w-5 text-blue-500 shrink-0 mt-0.5" />
                  <div>
                    <code className="text-sm font-mono text-gray-800">~/.pcp/skills/</code>
                    <p className="text-xs text-gray-500 mt-1">Your custom and downloaded skills</p>
                  </div>
                </div>
                <div className="flex items-start gap-3 p-3 bg-gray-50 rounded-lg">
                  <Folder className="h-5 w-5 text-purple-500 shrink-0 mt-0.5" />
                  <div>
                    <code className="text-sm font-mono text-gray-800">Built-in skills</code>
                    <p className="text-xs text-gray-500 mt-1">
                      Ships with PCP, updated via releases
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Installation Methods */}
            <div>
              <h4 className="font-medium text-gray-900 mb-2">Installation Methods</h4>
              <div className="grid md:grid-cols-2 gap-4">
                {/* From GitHub */}
                <div className="border rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Github className="h-5 w-5" />
                    <span className="font-medium">From GitHub</span>
                  </div>
                  <p className="text-sm text-gray-600 mb-3">Clone a skill repository directly:</p>
                  <CodeBlock>{`cd ~/.pcp/skills
git clone https://github.com/user/skill-name`}</CodeBlock>
                </div>

                {/* Single File */}
                <div className="border rounded-lg p-4">
                  <div className="flex items-center gap-2 mb-3">
                    <Download className="h-5 w-5" />
                    <span className="font-medium">Single File</span>
                  </div>
                  <p className="text-sm text-gray-600 mb-3">Download a SKILL.md file directly:</p>
                  <CodeBlock>{`curl -o ~/.pcp/skills/my-skill.md \\
  https://example.com/SKILL.md`}</CodeBlock>
                </div>
              </div>
            </div>

            {/* Create Your Own */}
            <div>
              <h4 className="font-medium text-gray-900 mb-2">Create Your Own</h4>
              <p className="text-sm text-gray-600 mb-3">
                Skills are markdown files with YAML frontmatter. Here's a minimal example:
              </p>
              <CodeBlock>{`# ~/.pcp/skills/my-skill.md
---
name: my-skill
version: "1.0.0"
displayName: My Custom Skill
description: What this skill does
type: guide
category: custom
triggers:
  keywords:
    - my skill
    - activate
---

# My Custom Skill

Instructions for the AI assistant...`}</CodeBlock>
            </div>

            {/* Skill Types */}
            <div>
              <h4 className="font-medium text-gray-900 mb-2">Skill Types</h4>
              <div className="grid md:grid-cols-3 gap-3">
                <div className="flex items-start gap-2 p-3 bg-purple-50 rounded-lg">
                  <Code className="h-5 w-5 text-purple-600 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-medium text-purple-900">Mini App</span>
                    <p className="text-xs text-purple-700 mt-1">
                      Code-based skills with functions (bill splitting, calculations)
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2 p-3 bg-blue-50 rounded-lg">
                  <Terminal className="h-5 w-5 text-blue-600 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-medium text-blue-900">CLI Tool</span>
                    <p className="text-xs text-blue-700 mt-1">
                      Wrappers for command-line tools (gh, aws, docker)
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-2 p-3 bg-green-50 rounded-lg">
                  <BookOpen className="h-5 w-5 text-green-600 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-medium text-green-900">Guide</span>
                    <p className="text-xs text-green-700 mt-1">
                      Behavioral instructions (group chat etiquette, meeting notes)
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* After Adding */}
            <div className="flex items-center gap-2 p-3 bg-blue-50 rounded-lg">
              <RefreshCw className="h-5 w-5 text-blue-600 shrink-0" />
              <p className="text-sm text-blue-800">
                After adding skills, click <strong>Refresh</strong> above to reload the skill list.
              </p>
            </div>
          </CardContent>
        )}
      </Card>
    </div>
  );
}

function buildQueryString(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined);
  if (entries.length === 0) return '';
  return '?' + entries.map(([k, v]) => `${k}=${encodeURIComponent(v!)}`).join('&');
}
