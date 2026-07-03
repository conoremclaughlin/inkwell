'use client';

import { useState } from 'react';
import { Shield, Eye, Fingerprint, Users, Zap, ChevronDown } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import clsx from 'clsx';

// ─── Policy Data (mirrors packages/cli/src/repl/tool-policy.ts + tool-profiles.ts) ───

interface ToolGroup {
  id: string;
  label: string;
  description: string;
  tools: string[];
  color: string;
  bgColor: string;
  borderColor: string;
}

interface Profile {
  id: string;
  label: string;
  description: string;
  icon: typeof Shield;
  accent: string;
  accentBg: string;
  accentBorder: string;
  accentRing: string;
  mode: 'backend' | 'privileged';
  allow: string[];
  prompt: string[];
  deny: string[];
}

const TOOL_GROUPS: ToolGroup[] = [
  {
    id: 'group:ink-safe',
    label: 'Safe',
    description: 'Read-only Inkwell tools — always auto-allowed',
    tools: [
      'bootstrap',
      'get_inbox',
      'list_sessions',
      'get_session',
      'get_activity',
      'recall',
      'list_artifacts',
      'get_artifact',
      'list_tasks',
      'list_projects',
      'list_reminders',
      'list_workspaces',
      'list_studios',
      'get_workspace',
      'get_studio',
      'get_timezone',
    ],
    color: 'text-slate-600',
    bgColor: 'bg-slate-50',
    borderColor: 'border-slate-200',
  },
  {
    id: 'group:ink-memory',
    label: 'Memory',
    description: 'Long-term memory operations',
    tools: ['remember', 'recall', 'forget', 'update_memory', 'restore_memory'],
    color: 'text-violet-700',
    bgColor: 'bg-violet-50',
    borderColor: 'border-violet-200',
  },
  {
    id: 'group:ink-session',
    label: 'Session',
    description: 'Session lifecycle management',
    tools: ['start_session', 'update_session_state', 'get_session', 'list_sessions', 'end_session'],
    color: 'text-blue-700',
    bgColor: 'bg-blue-50',
    borderColor: 'border-blue-200',
  },
  {
    id: 'group:ink-comms',
    label: 'Comms',
    description: 'Cross-agent messaging and triggers',
    tools: ['send_to_inbox', 'trigger_agent', 'send_response'],
    color: 'text-amber-700',
    bgColor: 'bg-amber-50',
    borderColor: 'border-amber-200',
  },
  {
    id: 'group:read',
    label: 'Read',
    description: 'Read-only filesystem access',
    tools: ['read', 'grep', 'find', 'ls'],
    color: 'text-emerald-700',
    bgColor: 'bg-emerald-50',
    borderColor: 'border-emerald-200',
  },
  {
    id: 'group:write',
    label: 'Write',
    description: 'Filesystem mutations and shell access',
    tools: ['edit', 'write', 'bash'],
    color: 'text-rose-700',
    bgColor: 'bg-rose-50',
    borderColor: 'border-rose-200',
  },
];

const PROFILES: Profile[] = [
  {
    id: 'minimal',
    label: 'Minimal',
    description: 'Read-only. Safe tools + file reads. No writes, no comms.',
    icon: Eye,
    accent: 'text-slate-600',
    accentBg: 'bg-slate-50',
    accentBorder: 'border-slate-300',
    accentRing: 'ring-slate-200',
    mode: 'backend',
    allow: ['group:ink-safe', 'group:read'],
    prompt: [],
    deny: ['group:ink-comms', 'group:write'],
  },
  {
    id: 'safe',
    label: 'Safe',
    description: 'Memory and sessions allowed. Comms and file writes require approval.',
    icon: Shield,
    accent: 'text-blue-600',
    accentBg: 'bg-blue-50',
    accentBorder: 'border-blue-300',
    accentRing: 'ring-blue-200',
    mode: 'backend',
    allow: ['group:ink-safe', 'group:ink-memory', 'group:ink-session', 'group:read'],
    prompt: ['group:ink-comms', 'group:write'],
    deny: [],
  },
  {
    id: 'collaborative',
    label: 'Collaborative',
    description: 'All tools allowed including file read/write. No approval prompts.',
    icon: Users,
    accent: 'text-emerald-600',
    accentBg: 'bg-emerald-50',
    accentBorder: 'border-emerald-300',
    accentRing: 'ring-emerald-200',
    mode: 'backend',
    allow: [
      'group:ink-safe',
      'group:ink-memory',
      'group:ink-session',
      'group:ink-comms',
      'group:read',
      'group:write',
    ],
    prompt: [],
    deny: [],
  },
  {
    id: 'full',
    label: 'Full',
    description: 'Privileged mode. All tools allowed, no restrictions.',
    icon: Zap,
    accent: 'text-amber-600',
    accentBg: 'bg-amber-50',
    accentBorder: 'border-amber-300',
    accentRing: 'ring-amber-200',
    mode: 'privileged',
    allow: [
      'group:ink-safe',
      'group:ink-memory',
      'group:ink-session',
      'group:ink-comms',
      'group:read',
      'group:write',
    ],
    prompt: [],
    deny: [],
  },
];

const GROUP_MAP = new Map(TOOL_GROUPS.map((g) => [g.id, g]));

// ─── Helpers ───

function getGroupsForList(groupIds: string[]): ToolGroup[] {
  return groupIds.map((id) => GROUP_MAP.get(id)).filter(Boolean) as ToolGroup[];
}

function getPermissionLevel(
  profile: Profile,
  groupId: string
): 'safe' | 'allow' | 'prompt' | 'deny' | 'default' {
  if (groupId === 'group:ink-safe') return 'safe';
  if (profile.deny.includes(groupId)) return 'deny';
  if (profile.prompt.includes(groupId)) return 'prompt';
  if (profile.allow.includes(groupId)) return 'allow';
  return 'default';
}

// ─── Sub-components ───

function ToolChip({
  name,
  variant,
}: {
  name: string;
  variant: 'allow' | 'prompt' | 'deny' | 'safe' | 'default';
}) {
  const styles = {
    safe: 'bg-slate-100 text-slate-600 border-slate-200',
    allow: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    prompt: 'bg-amber-50 text-amber-700 border-amber-200',
    deny: 'bg-red-50 text-red-600 border-red-200',
    default: 'bg-gray-50 text-gray-500 border-gray-200',
  };

  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-md border px-1.5 py-0.5 text-[11px] font-mono font-medium',
        styles[variant]
      )}
    >
      {name}
    </span>
  );
}

function GroupCard({
  group,
  variant,
  compact,
}: {
  group: ToolGroup;
  variant: 'allow' | 'prompt' | 'deny' | 'safe' | 'default';
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(!compact);

  return (
    <div
      className={clsx('rounded-lg border p-3', group.bgColor, group.borderColor, 'transition-all')}
    >
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <span className={clsx('text-sm font-semibold', group.color)}>{group.label}</span>
          <span className="text-[11px] text-gray-400">
            {group.tools.length} tool{group.tools.length !== 1 ? 's' : ''}
          </span>
        </div>
        <ChevronDown
          className={clsx(
            'h-3.5 w-3.5 text-gray-400 transition-transform duration-200',
            expanded && 'rotate-180'
          )}
        />
      </button>
      {!expanded && <p className="mt-1 text-[11px] text-gray-500">{group.description}</p>}
      {expanded && (
        <div className="mt-2 flex flex-wrap gap-1">
          {group.tools.map((tool) => (
            <ToolChip key={tool} name={tool} variant={variant} />
          ))}
        </div>
      )}
    </div>
  );
}

function PermissionColumn({
  title,
  subtitle,
  groups,
  variant,
  emptyLabel,
  headerColor,
  headerBg,
  dotColor,
}: {
  title: string;
  subtitle: string;
  groups: ToolGroup[];
  variant: 'allow' | 'prompt' | 'deny' | 'safe';
  emptyLabel: string;
  headerColor: string;
  headerBg: string;
  dotColor: string;
}) {
  return (
    <div className="flex-1 min-w-0">
      <div className={clsx('rounded-t-lg border-b-2 px-4 py-3', headerBg)}>
        <div className="flex items-center gap-2">
          <span className={clsx('h-2 w-2 rounded-full', dotColor)} />
          <h3 className={clsx('text-sm font-semibold', headerColor)}>{title}</h3>
        </div>
        <p className="mt-0.5 text-[11px] text-gray-500">{subtitle}</p>
      </div>
      <div className="space-y-2 p-3">
        {groups.length === 0 ? (
          <p className="py-4 text-center text-xs text-gray-400">{emptyLabel}</p>
        ) : (
          groups.map((group) => <GroupCard key={group.id} group={group} variant={variant} />)
        )}
      </div>
    </div>
  );
}

// ─── Page ───

export default function PolicyPage() {
  const [selectedProfileId, setSelectedProfileId] = useState<string>('safe');
  const [groupsExpanded, setGroupsExpanded] = useState(false);

  const selectedProfile = PROFILES.find((p) => p.id === selectedProfileId) || PROFILES[1];

  const allowedGroups = getGroupsForList(
    selectedProfile.allow.filter((id) => id !== 'group:ink-safe')
  );
  const promptGroups = getGroupsForList(selectedProfile.prompt);
  const denyGroups = getGroupsForList(selectedProfile.deny);

  return (
    <div className="max-w-5xl">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
          <Shield className="h-8 w-8 text-gray-400" strokeWidth={1.5} />
          Tool Policy
        </h1>
        <p className="mt-1 text-gray-500">
          Control which tools agents can use. Profiles set defaults; scopes override per agent or
          studio.
        </p>
      </div>

      {/* Profile Selector */}
      <div className="mt-8">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          Profiles
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {PROFILES.map((profile) => {
            const isSelected = profile.id === selectedProfileId;
            const Icon = profile.icon;
            return (
              <button
                key={profile.id}
                onClick={() => setSelectedProfileId(profile.id)}
                className={clsx(
                  'group relative rounded-xl border-2 p-4 text-left transition-all duration-200',
                  isSelected
                    ? clsx(
                        profile.accentBorder,
                        profile.accentBg,
                        'ring-2',
                        profile.accentRing,
                        'shadow-sm'
                      )
                    : 'border-gray-200 bg-white hover:border-gray-300 hover:shadow-sm'
                )}
              >
                <div className="flex items-center gap-2.5">
                  <div
                    className={clsx(
                      'flex h-8 w-8 items-center justify-center rounded-lg transition-colors',
                      isSelected ? profile.accentBg : 'bg-gray-100'
                    )}
                  >
                    <Icon
                      className={clsx(
                        'h-4 w-4 transition-colors',
                        isSelected ? profile.accent : 'text-gray-400'
                      )}
                      strokeWidth={1.75}
                    />
                  </div>
                  <span
                    className={clsx(
                      'text-sm font-semibold transition-colors',
                      isSelected ? 'text-gray-900' : 'text-gray-600'
                    )}
                  >
                    {profile.label}
                  </span>
                </div>
                <p
                  className={clsx(
                    'mt-2 text-[12px] leading-relaxed transition-colors',
                    isSelected ? 'text-gray-600' : 'text-gray-400'
                  )}
                >
                  {profile.description}
                </p>
                {profile.mode === 'privileged' && (
                  <Badge
                    variant="outline"
                    className={clsx(
                      'mt-2 text-[10px]',
                      isSelected
                        ? 'border-amber-300 bg-amber-100 text-amber-700'
                        : 'border-gray-200 text-gray-400'
                    )}
                  >
                    privileged
                  </Badge>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Permission Matrix */}
      <div className="mt-8">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          {selectedProfile.label} Profile — Permission Breakdown
        </p>
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div className="grid grid-cols-1 divide-y sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <PermissionColumn
                title="Allowed"
                subtitle="Execute without approval"
                groups={allowedGroups}
                variant="allow"
                emptyLabel="No groups allowed"
                headerColor="text-emerald-700"
                headerBg="bg-emerald-50/50"
                dotColor="bg-emerald-500"
              />
              <PermissionColumn
                title="Requires Approval"
                subtitle="2FA prompt before execution"
                groups={promptGroups}
                variant="prompt"
                emptyLabel="No approval required"
                headerColor="text-amber-700"
                headerBg="bg-amber-50/50"
                dotColor="bg-amber-500"
              />
              <PermissionColumn
                title="Denied"
                subtitle="Blocked — cannot execute"
                groups={denyGroups}
                variant="deny"
                emptyLabel="Nothing denied"
                headerColor="text-red-700"
                headerBg="bg-red-50/50"
                dotColor="bg-red-500"
              />
            </div>
          </CardContent>
        </Card>

        {/* Safe tools — always present */}
        <div className="mt-3">
          <Card className="border-slate-200 bg-slate-50/30">
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Fingerprint className="h-4 w-4 text-slate-400" strokeWidth={1.5} />
                  <span className="text-sm font-medium text-slate-600">
                    Safe Tools — Always Auto-Allowed
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {GROUP_MAP.get('group:ink-safe')?.tools.length} tools
                  </span>
                </div>
                <button
                  onClick={() => setGroupsExpanded(!groupsExpanded)}
                  className="text-[11px] text-slate-500 hover:text-slate-700 transition-colors"
                >
                  {groupsExpanded ? 'Collapse' : 'Show tools'}
                </button>
              </div>
              {groupsExpanded && (
                <div className="mt-3 flex flex-wrap gap-1">
                  {GROUP_MAP.get('group:ink-safe')?.tools.map((tool) => (
                    <ToolChip key={tool} name={tool} variant="safe" />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* All Groups Reference */}
      <div className="mt-10">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          All Tool Groups
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TOOL_GROUPS.filter((g) => g.id !== 'group:ink-safe').map((group) => {
            const level = getPermissionLevel(selectedProfile, group.id);
            const levelLabels = {
              safe: { text: 'Auto-allowed', style: 'bg-slate-100 text-slate-600 border-slate-200' },
              allow: {
                text: 'Allowed',
                style: 'bg-emerald-50 text-emerald-700 border-emerald-200',
              },
              prompt: {
                text: 'Approval',
                style: 'bg-amber-50 text-amber-700 border-amber-200',
              },
              deny: { text: 'Denied', style: 'bg-red-50 text-red-600 border-red-200' },
              default: {
                text: 'Default',
                style: 'bg-gray-50 text-gray-500 border-gray-200',
              },
            };
            const levelInfo = levelLabels[level];

            return (
              <Card key={group.id} className={clsx('overflow-hidden', group.borderColor)}>
                <CardContent className="p-0">
                  <div className={clsx('px-4 py-3', group.bgColor)}>
                    <div className="flex items-center justify-between">
                      <span className={clsx('text-sm font-semibold', group.color)}>
                        {group.label}
                      </span>
                      <span
                        className={clsx(
                          'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium',
                          levelInfo.style
                        )}
                      >
                        {levelInfo.text}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-gray-500">{group.description}</p>
                  </div>
                  <div className="px-4 py-3 flex flex-wrap gap-1">
                    {group.tools.map((tool) => (
                      <ToolChip
                        key={tool}
                        name={tool}
                        variant={level === 'default' ? 'allow' : level}
                      />
                    ))}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Scope explanation */}
      <div className="mt-10 mb-8">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
          How It Works
        </p>
        <Card>
          <CardContent className="p-6">
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
              <div>
                <h4 className="text-sm font-semibold text-gray-900">Profiles</h4>
                <p className="mt-1 text-[12px] leading-relaxed text-gray-500">
                  A profile is a preset that assigns tool groups to permission levels. Apply one
                  with{' '}
                  <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px] text-gray-700">
                    /profile safe
                  </code>{' '}
                  inside an ink chat session.
                </p>
              </div>
              <div>
                <h4 className="text-sm font-semibold text-gray-900">Scopes</h4>
                <p className="mt-1 text-[12px] leading-relaxed text-gray-500">
                  Rules cascade through four layers: global → workspace → agent → studio. More
                  specific scopes override broader ones. The most restrictive mode wins.
                </p>
              </div>
              <div>
                <h4 className="text-sm font-semibold text-gray-900">2FA Approval</h4>
                <p className="mt-1 text-[12px] leading-relaxed text-gray-500">
                  Tools in the &ldquo;Requires Approval&rdquo; column pause execution and send an
                  inbox notification. Approve or deny from Telegram, the CLI, or this dashboard.
                </p>
              </div>
              <div>
                <h4 className="text-sm font-semibold text-gray-900">Grants</h4>
                <p className="mt-1 text-[12px] leading-relaxed text-gray-500">
                  One-time or session-scoped overrides. Use{' '}
                  <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px] text-gray-700">
                    /grant bash 3
                  </code>{' '}
                  for 3 uses, or{' '}
                  <code className="rounded bg-gray-100 px-1 py-0.5 text-[11px] text-gray-700">
                    /grant-session edit
                  </code>{' '}
                  for the whole session.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
