import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { readIdentityJson, resolveAgentId } from '../backends/identity.js';
import { PcpClient } from '../lib/pcp-client.js';
import { runBackendTurn } from '../repl/backend-runner.js';
import { ContextLedger, estimateTokens } from '../repl/context-ledger.js';
import { parseSlashCommand } from '../repl/slash.js';
import { ToolMode, ToolPolicyState } from '../repl/tool-policy.js';
import { discoverSkills, loadSkillInstruction, type SkillInstruction } from '../repl/skills.js';
import { applyToolApprovalChoice, parseToolApprovalInput } from '../repl/tool-approval.js';

type ChatOptions = {
  agent?: string;
  backend?: string;
  model?: string;
  threadKey?: string;
  maxContextTokens?: string;
  pollSeconds?: string;
  tools?: string;
  verbose?: boolean;
};

interface InboxMessage {
  id: string;
  content: string;
  from?: string;
  subject?: string;
  threadKey?: string;
}

interface ChatRuntime {
  backend: string;
  model?: string;
  verbose: boolean;
  toolMode: ToolMode;
  threadKey?: string;
  sessionId?: string;
  maxContextTokens: number;
  pollSeconds: number;
  showSessionsWatch: boolean;
  transcriptPath: string;
  activeSkills: SkillInstruction[];
}

interface SessionSummary {
  id: string;
  agentId?: string;
  status?: string;
  currentPhase?: string;
  threadKey?: string;
  startedAt?: string;
}

function ensureRuntimeTranscriptPath(sessionId?: string): string {
  const dir = join(process.cwd(), '.pcp', 'runtime', 'repl');
  mkdirSync(dir, { recursive: true });
  const safeSession = sessionId || 'local';
  return join(dir, `${safeSession}-${Date.now()}.jsonl`);
}

function appendTranscript(path: string, event: Record<string, unknown>): void {
  appendFileSync(path, JSON.stringify({ ts: new Date().toISOString(), ...event }) + '\n');
}

function extractSessionId(result: Record<string, unknown> | null | undefined): string | undefined {
  if (!result) return undefined;
  const direct = result.sessionId;
  if (typeof direct === 'string') return direct;

  const session = result.session as Record<string, unknown> | undefined;
  if (session && typeof session.id === 'string') return session.id;

  const data = result.data as Record<string, unknown> | undefined;
  const dataSession = data?.session as Record<string, unknown> | undefined;
  if (dataSession && typeof dataSession.id === 'string') return dataSession.id;

  return undefined;
}

function extractInboxMessages(result: Record<string, unknown> | null | undefined): InboxMessage[] {
  if (!result) return [];
  const candidate =
    (Array.isArray(result.messages) ? result.messages : undefined) ||
    (Array.isArray(result.inbox) ? result.inbox : undefined) ||
    [];

  return candidate
    .map((entry): InboxMessage | undefined => {
      const msg = entry as Record<string, unknown>;
      const id = msg.id;
      if (typeof id !== 'string') return undefined;
      return {
        id,
        content: String(msg.content || ''),
        from: msg.senderAgentId ? String(msg.senderAgentId) : msg.from ? String(msg.from) : undefined,
        subject: msg.subject ? String(msg.subject) : undefined,
        threadKey: msg.threadKey ? String(msg.threadKey) : undefined,
      } satisfies InboxMessage;
    })
    .filter((m): m is InboxMessage => Boolean(m));
}

function extractSessionSummaries(result: Record<string, unknown> | null | undefined): SessionSummary[] {
  if (!result) return [];
  const candidate =
    (Array.isArray(result.sessions) ? result.sessions : undefined) ||
    (Array.isArray(result.data) ? result.data : undefined) ||
    [];

  return candidate
    .map((entry): SessionSummary | undefined => {
      const row = entry as Record<string, unknown>;
      const id = row.id;
      if (typeof id !== 'string') return undefined;
      return {
        id,
        agentId: typeof row.agentId === 'string' ? row.agentId : undefined,
        status: typeof row.status === 'string' ? row.status : undefined,
        currentPhase: typeof row.currentPhase === 'string' ? row.currentPhase : undefined,
        threadKey: typeof row.threadKey === 'string' ? row.threadKey : undefined,
        startedAt: typeof row.startedAt === 'string' ? row.startedAt : undefined,
      };
    })
    .filter((session): session is SessionSummary => Boolean(session));
}

function summarizeForSessionEnd(ledger: ContextLedger): string {
  const entries = ledger.listEntries().slice(-8);
  const snippets = entries
    .filter((entry) => entry.role === 'assistant' || entry.role === 'user')
    .slice(-4)
    .map((entry) => `${entry.role}: ${entry.content.slice(0, 180).replace(/\s+/g, ' ').trim()}`);
  if (snippets.length === 0) return 'Ended REPL session.';
  return `REPL summary:\n${snippets.map((s) => `- ${s}`).join('\n')}`;
}

function printUsage(ledger: ContextLedger, maxContextTokens: number): void {
  const total = ledger.totalTokens();
  const pct = maxContextTokens > 0 ? Math.min((total / maxContextTokens) * 100, 999) : 0;
  console.log(
    chalk.dim(
      `Context: ~${total.toLocaleString()} tok / ${maxContextTokens.toLocaleString()} (${pct.toFixed(1)}%)`
    )
  );
}

function formatStartedAt(value?: string): string {
  if (!value) return '-';
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return value;
  return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function printSessionsSnapshot(sessions: SessionSummary[]): void {
  if (sessions.length === 0) {
    console.log(chalk.dim('No active sessions found.'));
    return;
  }

  console.log(chalk.bold('\nActive sessions'));
  console.log(chalk.dim('id       agent   status/phase            thread        started'));
  for (const session of sessions) {
    const id = session.id.slice(0, 7).padEnd(7);
    const agent = (session.agentId || '-').slice(0, 6).padEnd(6);
    const status = (session.currentPhase || session.status || '-').slice(0, 22).padEnd(22);
    const thread = (session.threadKey || '-').slice(0, 12).padEnd(12);
    const started = formatStartedAt(session.startedAt);
    console.log(chalk.dim(`${id}  ${agent}  ${status}  ${thread}  ${started}`));
  }
  console.log('');
}

async function promptForToolApproval(
  rl: ReturnType<typeof createInterface>,
  toolPolicy: ToolPolicyState,
  sessionId: string | undefined,
  tool: string,
  reason: string
): Promise<boolean> {
  console.log(chalk.yellow(reason));
  const answer = (
    await rl.question(
      chalk.yellow(
        `Allow ${tool}? [y] once, [s] this session, [a] always allow, [d] deny always, [n] cancel: `
      )
    )
  ).trim();

  const result = applyToolApprovalChoice({
    policy: toolPolicy,
    tool,
    sessionId,
    choice: parseToolApprovalInput(answer),
  });
  if (result.message) {
    const printer = result.approved ? chalk.green : chalk.yellow;
    console.log(printer(result.message));
  }
  return result.approved;
}

function renderActiveSkills(skills: SkillInstruction[]): string {
  if (skills.length === 0) return '';
  return skills
    .map(
      (skill) =>
        `\n[Active skill: ${skill.name} from ${skill.source}]\n${skill.content || '(no skill content loaded)'}`
    )
    .join('\n');
}

function buildPromptEnvelope(
  agentId: string,
  runtime: ChatRuntime,
  ledger: ContextLedger,
  userMessage: string
): string {
  const transcript = ledger.buildPromptTranscript({
    maxTokens: runtime.maxContextTokens,
    includeSources: true,
  });

  return [
    `You are ${agentId}.`,
    'You are running inside sb chat (first-class PCP REPL).',
    'Answer in plain text. Be concise but complete.',
    `Current backend: ${runtime.backend}${runtime.model ? ` (${runtime.model})` : ''}.`,
    `Tool mode: ${runtime.toolMode}.`,
    runtime.toolMode === 'off'
      ? 'Do not call backend-native tools. Provide reasoning and instructions only.'
      : '',
    runtime.toolMode === 'privileged'
      ? 'Backend-native tools are enabled and external actions are allowed when needed.'
      : '',
    runtime.activeSkills.length > 0
      ? `Active skills: ${runtime.activeSkills.map((skill) => skill.name).join(', ')}`
      : '',
    runtime.threadKey ? `Thread key: ${runtime.threadKey}.` : '',
    '',
    'Conversation transcript:',
    transcript || '(empty)',
    runtime.activeSkills.length > 0 ? `\nSkill instructions:${renderActiveSkills(runtime.activeSkills)}` : '',
    '',
    'Latest user message:',
    userMessage,
  ]
    .filter(Boolean)
    .join('\n');
}

async function runChat(options: ChatOptions): Promise<void> {
  const agentId = resolveAgentId(options.agent);
  const pcp = new PcpClient();
  const identity = readIdentityJson(process.cwd());

  const runtime: ChatRuntime = {
    backend: options.backend || 'claude',
    model: options.model,
    verbose: options.verbose ?? false,
    toolMode:
      options.tools === 'off' ? 'off' : options.tools === 'privileged' ? 'privileged' : 'backend',
    threadKey: options.threadKey,
    maxContextTokens: Number.parseInt(options.maxContextTokens || '12000', 10),
    pollSeconds: Number.parseInt(options.pollSeconds || '20', 10),
    showSessionsWatch: false,
    transcriptPath: ensureRuntimeTranscriptPath(),
    activeSkills: [],
  };
  const toolPolicy = new ToolPolicyState(runtime.toolMode);

  const ledger = new ContextLedger();
  const seenInboxIds = new Set<string>();
  let pollTimer: NodeJS.Timeout | null = null;
  let sessionsCache: SessionSummary[] = [];
  let sessionsCacheAt = 0;

  const bootstrapResult = (await pcp
    .callTool('bootstrap', { agentId })
    .catch((error) => ({ error: String(error) }))) as Record<string, unknown>;

  if (bootstrapResult.error) {
    console.log(chalk.yellow(`bootstrap unavailable: ${String(bootstrapResult.error)}`));
  } else {
    const suggestion = (
      bootstrapResult.reflectionStatus as Record<string, unknown> | undefined
    )?.suggestion;
    const timezone = (bootstrapResult.user as Record<string, unknown> | undefined)?.timezone;
    ledger.addEntry(
      'system',
      `Bootstrapped as ${agentId}${timezone ? ` (${String(timezone)})` : ''}${
        suggestion ? `. ${String(suggestion)}` : ''
      }`,
      'bootstrap'
    );
  }

  const startArgs: Record<string, unknown> = { agentId };
  if (runtime.threadKey) startArgs.threadKey = runtime.threadKey;
  if (identity?.workspaceId) {
    startArgs.studioId = identity.workspaceId;
    // Backward compatibility for older server builds.
    startArgs.workspaceId = identity.workspaceId;
  }

  const sessionStartResult = (await pcp
    .callTool('start_session', startArgs)
    .catch((error) => ({ error: String(error) }))) as Record<string, unknown>;
  runtime.sessionId = extractSessionId(sessionStartResult);
  runtime.transcriptPath = ensureRuntimeTranscriptPath(runtime.sessionId);

  appendTranscript(runtime.transcriptPath, {
    type: 'session_start',
    agentId,
    backend: runtime.backend,
    model: runtime.model || null,
    threadKey: runtime.threadKey || null,
    sessionId: runtime.sessionId || null,
    studioId: identity?.workspaceId || null,
  });

  if (runtime.sessionId) {
    await pcp
      .callTool('update_session_phase', {
        agentId,
        sessionId: runtime.sessionId,
        phase: 'investigating',
        status: 'active',
      })
      .catch(() => undefined);
  }

  console.log(chalk.bold('\nSB Chat (experimental)\n'));
  console.log(chalk.dim(`Agent: ${agentId}`));
  console.log(chalk.dim(`Backend: ${runtime.backend}${runtime.model ? ` (${runtime.model})` : ''}`));
  if (runtime.threadKey) console.log(chalk.dim(`Thread: ${runtime.threadKey}`));
  if (runtime.sessionId) console.log(chalk.dim(`Session: ${runtime.sessionId}`));
  console.log(chalk.dim(`Transcript: ${runtime.transcriptPath}`));
  console.log(chalk.dim('Type /help for commands.\n'));

  const refreshSessionsSnapshot = async (force = false): Promise<SessionSummary[]> => {
    const stale = Date.now() - sessionsCacheAt > 15_000;
    if (!force && !stale) return sessionsCache;
    const result = (await pcp
      .callTool('list_sessions', { limit: 20, status: 'active' })
      .catch(() => null)) as Record<string, unknown> | null;
    sessionsCache = extractSessionSummaries(result);
    sessionsCacheAt = Date.now();
    return sessionsCache;
  };

  const pollInbox = async (force = false): Promise<number> => {
    const inboxResult = (await pcp
      .callTool('get_inbox', { agentId, status: 'unread', limit: 10 })
      .catch(() => null)) as Record<string, unknown> | null;
    const messages = extractInboxMessages(inboxResult);
    const fresh = messages.filter((msg) => !seenInboxIds.has(msg.id));
    for (const msg of fresh) {
      seenInboxIds.add(msg.id);
      if (!runtime.threadKey && msg.threadKey) {
        runtime.threadKey = msg.threadKey;
      }
      const from = msg.from || 'unknown';
      const heading = msg.subject ? `${from} — ${msg.subject}` : from;
      const rendered = `📥 ${heading}: ${msg.content}`.trim();
      ledger.addEntry('inbox', rendered, 'pcp-inbox');
      appendTranscript(runtime.transcriptPath, { type: 'inbox', messageId: msg.id, rendered });
      console.log(`\n${chalk.cyan(rendered)}\n`);
    }

    if (force && fresh.length === 0) {
      console.log(chalk.dim('No new inbox messages.'));
    }
    return fresh.length;
  };

  // Prime with current unread queue (without force banner).
  await pollInbox(false);

  pollTimer = setInterval(() => {
    void pollInbox(false);
  }, Math.max(runtime.pollSeconds, 5) * 1000);

  const rl = createInterface({ input, output });
  let keepRunning = true;

  while (keepRunning) {
    if (runtime.showSessionsWatch) {
      const snapshot = await refreshSessionsSnapshot(false);
      printSessionsSnapshot(snapshot);
    }
    printUsage(ledger, runtime.maxContextTokens);
    const raw = (await rl.question(chalk.green(`${agentId}> `))).trim();
    if (!raw) continue;

    const slash = parseSlashCommand(raw);
    if (slash) {
      switch (slash.name) {
        case 'help': {
          console.log(
            [
              '',
              '/help                      Show this help',
              '/quit | /exit              End chat',
              '/inbox                     Poll inbox now',
              '/session                   Show active session info',
              '/backend <name>            Switch backend (claude|codex|gemini)',
              '/model <id>                Set/clear model override',
              '/tools <backend|off|privileged>  Toggle backend-native tools/policy',
              '/grant <tool> [uses]       Grant blocked PCP tool for limited uses',
              '/grant-session <tool>      Allow a tool for this PCP session only',
              '/allow <tool>               Persistently allow PCP tool',
              '/deny <tool>                Persistently deny PCP tool',
              '/policy                     Show tool policy + storage path',
              '/pcp <tool> [jsonArgs]     Call a PCP tool directly',
              '/thread [key]              Show/set active thread key',
              '/sessions [watch|off]      Show active sessions (or stream each turn)',
              '/skills                    List discovered local skills',
              '/skill-allow <pattern>      Persistently allow skill(s) via pattern',
              '/skill-use <name>           Activate a discovered skill for prompts',
              '/skill-clear [name]         Clear active skills (or one skill)',
              '/bookmark [label]          Set context bookmark',
              '/bookmarks                 List bookmarks',
              '/eject <bookmark|last>     Eject context up to bookmark',
              '/context                   Show recent context entries',
              '/usage                     Show context token estimate',
              '',
            ].join('\n')
          );
          break;
        }
        case 'quit':
        case 'exit':
          keepRunning = false;
          break;
        case 'inbox':
          await pollInbox(true);
          break;
        case 'session':
          console.log(
            chalk.dim(
              `session=${runtime.sessionId || 'none'} backend=${runtime.backend} model=${
                runtime.model || '(default)'
              } thread=${runtime.threadKey || '(none)'}`
            )
          );
          break;
        case 'sessions': {
          const mode = slash.args[0];
          if (mode === 'watch') {
            runtime.showSessionsWatch = true;
            console.log(chalk.green('Session watch enabled.'));
          } else if (mode === 'off') {
            runtime.showSessionsWatch = false;
            console.log(chalk.green('Session watch disabled.'));
          } else {
            const snapshot = await refreshSessionsSnapshot(true);
            printSessionsSnapshot(snapshot);
          }
          break;
        }
        case 'backend': {
          const next = slash.args[0];
          if (!next || !['claude', 'codex', 'gemini'].includes(next)) {
            console.log(chalk.yellow('Usage: /backend <claude|codex|gemini>'));
            break;
          }
          runtime.backend = next;
          console.log(chalk.green(`Switched backend to ${next}`));
          break;
        }
        case 'model': {
          const next = slash.args[0];
          runtime.model = next || undefined;
          console.log(chalk.green(`Model override: ${runtime.model || '(backend default)'}`));
          break;
        }
        case 'tools': {
          const next = slash.args[0];
          if (!next) {
            const grants = toolPolicy.listGrants();
            console.log(chalk.dim(`Tool mode: ${runtime.toolMode}`));
            if (grants.length > 0) {
              console.log(chalk.dim(`Grants: ${grants.map((g) => `${g.tool}(${g.uses})`).join(', ')}`));
            }
            const sessionGrants = toolPolicy.listSessionGrants(runtime.sessionId);
            if (sessionGrants.length > 0) {
              console.log(
                chalk.dim(
                  `Session grants: ${sessionGrants.map((g) => `${g.tool}(${g.uses})`).join(', ')}`
                )
              );
            }
            break;
          }
          if (next !== 'backend' && next !== 'off' && next !== 'privileged') {
            console.log(chalk.yellow('Usage: /tools <backend|off|privileged>'));
            break;
          }
          runtime.toolMode = next;
          toolPolicy.setMode(next);
          console.log(chalk.green(`Tool mode set to ${next}`));
          break;
        }
        case 'grant': {
          const tool = slash.args[0];
          if (!tool) {
            console.log(chalk.yellow('Usage: /grant <tool> [uses]'));
            break;
          }
          const uses = Number.parseInt(slash.args[1] || '1', 10);
          toolPolicy.grantTool(tool, Number.isNaN(uses) ? 1 : uses);
          console.log(chalk.green(`Granted ${tool} for ${Number.isNaN(uses) ? 1 : uses} use(s).`));
          break;
        }
        case 'allow': {
          const tool = slash.args[0];
          if (!tool) {
            console.log(chalk.yellow('Usage: /allow <tool>'));
            break;
          }
          toolPolicy.allowTool(tool);
          console.log(chalk.green(`Persistently allowed ${tool}`));
          break;
        }
        case 'grant-session': {
          const tool = slash.args[0];
          if (!tool) {
            console.log(chalk.yellow('Usage: /grant-session <tool>'));
            break;
          }
          if (!runtime.sessionId) {
            console.log(chalk.yellow('No PCP session id available.'));
            break;
          }
          toolPolicy.grantToolForSession(runtime.sessionId, tool);
          console.log(chalk.green(`Granted ${tool} for this PCP session.`));
          break;
        }
        case 'deny': {
          const tool = slash.args[0];
          if (!tool) {
            console.log(chalk.yellow('Usage: /deny <tool>'));
            break;
          }
          toolPolicy.denyTool(tool);
          console.log(chalk.green(`Persistently denied ${tool}`));
          break;
        }
        case 'policy': {
          console.log(chalk.bold('\nTool policy'));
          console.log(chalk.dim(`Path: ${toolPolicy.getPolicyPath()}`));
          console.log(chalk.dim(`Mode: ${toolPolicy.getMode()}`));
          const grants = toolPolicy.listGrants();
          if (grants.length > 0) {
            console.log(chalk.dim(`Grants: ${grants.map((entry) => `${entry.tool}(${entry.uses})`).join(', ')}`));
          }
          const allow = toolPolicy.listAllowTools();
          if (allow.length > 0) console.log(chalk.dim(`Allow: ${allow.join(', ')}`));
          const deny = toolPolicy.listDenyTools();
          if (deny.length > 0) console.log(chalk.dim(`Deny: ${deny.join(', ')}`));
          const prompt = toolPolicy.listPromptTools();
          if (prompt.length > 0) console.log(chalk.dim(`Prompt: ${prompt.join(', ')}`));
          const skills = toolPolicy.listAllowedSkills();
          if (skills.length > 0) console.log(chalk.dim(`Allowed skills: ${skills.join(', ')}`));
          const sessionGrants = toolPolicy.listSessionGrants(runtime.sessionId);
          if (sessionGrants.length > 0) {
            console.log(
              chalk.dim(
                `Session grants: ${sessionGrants.map((entry) => `${entry.tool}(${entry.uses})`).join(', ')}`
              )
            );
          }
          if (runtime.activeSkills.length > 0) {
            console.log(
              chalk.dim(`Active skills: ${runtime.activeSkills.map((skill) => skill.name).join(', ')}`)
            );
          }
          console.log('');
          break;
        }
        case 'pcp': {
          const tool = slash.args[0];
          if (!tool) {
            console.log(chalk.yellow('Usage: /pcp <tool> [jsonArgs]'));
            break;
          }
          let pcpArgs: Record<string, unknown> = {};
          const rawArgs = raw.split(/\s+/).slice(2).join(' ').trim();
          if (rawArgs) {
            try {
              pcpArgs = JSON.parse(rawArgs) as Record<string, unknown>;
            } catch {
              console.log(chalk.yellow('Invalid JSON args. Example: /pcp get_inbox {"agentId":"lumen"}'));
              break;
            }
          }
          const policy = toolPolicy.canCallPcpTool(tool, runtime.sessionId);
          if (!policy.allowed) {
            const approved = await promptForToolApproval(
              rl,
              toolPolicy,
              runtime.sessionId,
              tool,
              policy.reason
            );
            if (!approved) {
              console.log(chalk.yellow(`Skipped ${tool}`));
              break;
            }
          }
          const result = await pcp.callTool(tool, pcpArgs).catch((error) => ({ error: String(error) }));
          const rendered = JSON.stringify(result, null, 2);
          ledger.addEntry('system', `PCP ${tool} -> ${rendered}`, 'pcp');
          appendTranscript(runtime.transcriptPath, { type: 'pcp_tool', tool, args: pcpArgs, result });
          console.log(rendered);
          break;
        }
        case 'skills': {
          const skills = discoverSkills(process.cwd());
          if (skills.length === 0) {
            console.log(chalk.dim('No local skills discovered.'));
            break;
          }
          const visible = skills.filter((skill) => toolPolicy.isSkillAllowed(skill.name));
          const blocked = skills.length - visible.length;
          console.log(chalk.bold(`Discovered skills (${skills.length})`));
          for (const skill of visible.slice(0, 80)) {
            const active = runtime.activeSkills.some((entry) => entry.path === skill.path) ? ' *active*' : '';
            console.log(chalk.dim(`- ${skill.name} [${skill.source}]${active}`));
          }
          if (visible.length > 80) {
            console.log(chalk.dim(`... and ${visible.length - 80} more visible skills`));
          }
          if (blocked > 0) {
            console.log(chalk.yellow(`${blocked} skills hidden by skill policy allowlist`));
          }
          break;
        }
        case 'skill-allow': {
          const skill = slash.args.join(' ').trim();
          if (!skill) {
            console.log(chalk.yellow('Usage: /skill-allow <name>'));
            break;
          }
          toolPolicy.allowSkill(skill);
          console.log(chalk.green(`Allowed skill: ${skill}`));
          break;
        }
        case 'skill-use': {
          const name = slash.args.join(' ').trim();
          if (!name) {
            console.log(chalk.yellow('Usage: /skill-use <name>'));
            break;
          }
          const skills = discoverSkills(process.cwd()).filter((skill) => skill.name === name);
          if (skills.length === 0) {
            console.log(chalk.yellow(`Skill not found: ${name}`));
            break;
          }
          const [skill] = skills;
          if (!toolPolicy.isSkillAllowed(skill.name)) {
            console.log(chalk.yellow(`Skill blocked by allowlist policy: ${skill.name}`));
            break;
          }
          const loaded = loadSkillInstruction(skill);
          runtime.activeSkills = [
            ...runtime.activeSkills.filter((entry) => entry.path !== loaded.path),
            loaded,
          ];
          console.log(chalk.green(`Activated skill ${loaded.name}`));
          break;
        }
        case 'skill-clear': {
          const name = slash.args.join(' ').trim();
          if (!name) {
            runtime.activeSkills = [];
            console.log(chalk.green('Cleared all active skills.'));
            break;
          }
          const before = runtime.activeSkills.length;
          runtime.activeSkills = runtime.activeSkills.filter((skill) => skill.name !== name);
          const removed = before - runtime.activeSkills.length;
          if (removed === 0) {
            console.log(chalk.yellow(`No active skill matched: ${name}`));
          } else {
            console.log(chalk.green(`Cleared ${removed} active skill(s) for ${name}`));
          }
          break;
        }
        case 'thread': {
          const next = slash.args[0];
          if (next) {
            runtime.threadKey = next;
            console.log(chalk.green(`Thread key set to ${next}`));
          } else {
            console.log(chalk.dim(`Thread key: ${runtime.threadKey || '(none)'}`));
          }
          break;
        }
        case 'bookmark': {
          const bookmark = ledger.createBookmark(slash.args.join(' '));
          console.log(chalk.green(`Created bookmark ${bookmark.id} (${bookmark.label})`));
          break;
        }
        case 'bookmarks': {
          const bookmarks = ledger.listBookmarks();
          if (bookmarks.length === 0) {
            console.log(chalk.dim('No bookmarks yet.'));
            break;
          }
          for (const bookmark of bookmarks) {
            console.log(
              chalk.dim(
                `${bookmark.id}  ${bookmark.label}  entry#${bookmark.entryId}  ~${bookmark.approxTokensAtCreation} tok`
              )
            );
          }
          break;
        }
        case 'eject': {
          const ref = slash.args[0] || 'last';
          const result = ledger.ejectToBookmark(ref);
          if (!result) {
            console.log(chalk.yellow(`Bookmark not found: ${ref}`));
            break;
          }
          const removedCount = result.removedEntries.length;
          console.log(
            chalk.green(
              `Ejected ${removedCount} entries (~${result.removedTokens} tok) up to ${result.bookmark.id}`
            )
          );

          const summary = result.removedEntries
            .slice(-6)
            .map((entry) => `${entry.role}: ${entry.content.slice(0, 120).replace(/\s+/g, ' ')}`)
            .join('\n');
          if (summary) {
            await pcp
              .callTool('remember', {
                agentId,
                ...(runtime.sessionId ? { sessionId: runtime.sessionId } : {}),
                content: `Context ejection at ${result.bookmark.id} (${result.bookmark.label}).\n${summary}`,
                topics: 'repl,context-ejection',
                salience: 'medium',
              })
              .catch(() => undefined);
          }
          appendTranscript(runtime.transcriptPath, {
            type: 'context_eject',
            bookmarkId: result.bookmark.id,
            bookmarkLabel: result.bookmark.label,
            removedCount,
            removedTokens: result.removedTokens,
          });
          break;
        }
        case 'context': {
          const entries = ledger.listEntries().slice(-12);
          if (entries.length === 0) {
            console.log(chalk.dim('Context is empty.'));
            break;
          }
          for (const entry of entries) {
            const prefix = `${entry.role}${entry.source ? `/${entry.source}` : ''}`;
            console.log(chalk.dim(`${prefix}: ${entry.content.slice(0, 180)}`));
          }
          break;
        }
        case 'usage':
          printUsage(ledger, runtime.maxContextTokens);
          break;
        default:
          console.log(chalk.yellow(`Unknown command: /${slash.name}`));
      }
      continue;
    }

    ledger.addEntry('user', raw, 'repl');
    appendTranscript(runtime.transcriptPath, { type: 'user', content: raw });

    if (runtime.sessionId) {
      await pcp
        .callTool('update_session_phase', {
          agentId,
          sessionId: runtime.sessionId,
          phase: 'implementing',
          status: 'active',
        })
        .catch(() => undefined);
    }

    const prompt = buildPromptEnvelope(agentId, runtime, ledger, raw);
    const runResult = await runBackendTurn({
      backend: runtime.backend,
      agentId,
      model: runtime.model,
      prompt,
      verbose: runtime.verbose,
      // When tools are off, do not pass through backend tool passthrough flags.
      passthroughArgs: toolPolicy.canUseBackendTools() ? [] : ['--allowedTools', ''],
    });

    let responseText = runResult.stdout.trim();
    if (!responseText && runResult.stderr.trim()) {
      responseText = runResult.stderr.trim();
    }
    if (!responseText) {
      responseText = '(no output)';
    }

    ledger.addEntry('assistant', responseText, runtime.backend);
    appendTranscript(runtime.transcriptPath, {
      type: 'assistant',
      backend: runtime.backend,
      model: runtime.model || null,
      success: runResult.success,
      exitCode: runResult.exitCode,
      durationMs: runResult.durationMs,
      stderr: runResult.stderr || null,
      content: responseText,
      approxTokens: estimateTokens(responseText),
    });

    if (!runResult.success) {
      console.log(chalk.red(`\n[${runtime.backend}] exit=${runResult.exitCode}`));
      if (runResult.stderr) {
        console.log(chalk.dim(runResult.stderr));
      }
    }

    console.log(`\n${chalk.white(responseText)}\n`);
  }

  rl.close();
  if (pollTimer) clearInterval(pollTimer);

  const summary = summarizeForSessionEnd(ledger);
  if (runtime.sessionId) {
    await pcp
      .callTool('end_session', { agentId, sessionId: runtime.sessionId, summary })
      .catch(() => undefined);
  }
  appendTranscript(runtime.transcriptPath, {
    type: 'session_end',
    sessionId: runtime.sessionId || null,
    summary,
  });

  console.log(chalk.dim('\nChat ended.\n'));
}

export function registerChatCommand(program: Command): void {
  const register = (name: string, description: string) =>
    program
      .command(name)
      .description(description)
      .option('-a, --agent <id>', 'Agent identity to use')
      .option('-b, --backend <name>', 'Backend: claude, codex, gemini', 'claude')
      .option('-m, --model <model>', 'Model override for backend')
      .option('--thread-key <key>', 'Thread key for PCP session routing')
      .option('--max-context-tokens <n>', 'Approximate context budget for transcript', '12000')
      .option('--poll-seconds <n>', 'Inbox polling interval seconds', '20')
      .option('--tools <mode>', 'Tool mode: backend|off|privileged', 'backend')
      .option('-v, --verbose', 'Verbose backend passthrough output')
      .action((options: ChatOptions) => runChat(options));

  register('chat', 'Start first-class PCP REPL (experimental)');
  register('alpha', 'Alias for `sb chat` (experimental)');
}
