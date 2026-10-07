/**
 * A reaction is never approval (ink://specs/inkling-reactions): no gate
 * verdict, permission grant, plan, send or purchase may read one as
 * consent. This holds the code that touches reactions to the places that
 * display or write them, so a new reader anywhere, a gate or permission
 * path included, fails here and has to be argued for in review.
 *
 *   A. The non-test source files that mention reactions are exactly these.
 *   B. Inside the shared registries (admin routes, thread tools, the MCP
 *      registration, the generated types) every such line sits in a unit
 *      that displays or writes reactions, and nowhere else in the file.
 *   C. The gate-verdict and permission modules, found by what they contain,
 *      mention no reaction at all.
 */

import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const REPO = path.resolve(__dirname, '../../../../..');
/** Server and agent-side code. The web and mobile apps only draw reactions. */
const ROOTS = [
  'packages/api/src',
  'packages/shared/src',
  'packages/cli/src',
  'packages/channel-plugin',
  'packages/openclaw-plugin',
];
const SOURCE = /\.(ts|tsx|js|mjs|cjs)$/;
const TEST = /\.(test|spec)\.(ts|tsx|js|mjs)$/;
// The table, the module, the summaries, and the tool (react_to_message).
const MENTIONS_REACTIONS = /reaction|react_?to_?message/i;
/** What a gate-verdict or permission path is made of. */
const GATE_OR_PERMISSION =
  /record_gate_verdict|task_gate_events|user_permissions|approval_requests|permission_grant/;

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(REPO, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(rel)));
    else if (SOURCE.test(entry.name) && !TEST.test(entry.name)) out.push(rel);
  }
  return out;
}

/** Comments read nothing; only code lines count. */
function isCode(line: string): boolean {
  const t = line.trim();
  return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
}

/** Line ranges of `import ... from '...';` statements. */
function importLines(lines: string[]): Set<number> {
  const inside = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (!/^import\b/.test(lines[i])) continue;
    let j = i;
    while (j < lines.length && !/;\s*$/.test(lines[j])) j++;
    for (let k = i; k <= j; k++) inside.add(k);
    i = j;
  }
  return inside;
}

/** How a registry file names the unit a line sits in. */
type UnitOf = (lines: string[], index: number) => string | null;

const nearestAbove =
  (pattern: RegExp): UnitOf =>
  (lines, index) => {
    for (let i = index; i >= 0; i--) {
      const match = lines[i].match(pattern);
      if (match) return match[1];
    }
    return null;
  };

/** server.registerTool(\n  'name', — the name sits on the line after the call. */
const registeredTool: UnitOf = (lines, index) => {
  for (let i = index; i >= 0; i--) {
    if (/server\.registerTool\(\s*$/.test(lines[i])) {
      return lines[i + 1]?.match(/^\s*'([a-z_]+)',/)?.[1] ?? null;
    }
  }
  return null;
};

interface Registry {
  unitOf: UnitOf;
  allowed: string[];
}

/** Every code line mentioning reactions that sits outside an allowed unit or an import. */
function strayReactionLines(source: string, registry: Registry): string[] {
  const lines = source.split('\n');
  const imports = importLines(lines);
  const stray: string[] = [];
  lines.forEach((line, index) => {
    if (!MENTIONS_REACTIONS.test(line) || !isCode(line) || imports.has(index)) return;
    const unit = registry.unitOf(lines, index);
    if (unit === null || !registry.allowed.includes(unit)) {
      stray.push(`${index + 1}: [${unit ?? 'module scope'}] ${line.trim()}`);
    }
  });
  return stray;
}

const REGISTRIES: Record<string, Registry> = {
  'packages/api/src/routes/admin.ts': {
    unitOf: nearestAbove(/^router\.(?:get|post|put|patch|delete)\('([^']+)'/),
    // Display (with `mine`) and the person's own write.
    allowed: ['/threads/messages', '/threads/reactions'],
  },
  'packages/api/src/mcp/tools/thread-handlers.ts': {
    unitOf: nearestAbove(/^(?:export )?(?:async )?(?:function|const) (\w+)/),
    allowed: [
      'handleGetThreadMessages',
      'handleReactToMessage',
      'reactToMessageSchema',
      'threadToolDefinitions',
    ],
  },
  'packages/api/src/mcp/tools/index.ts': {
    unitOf: registeredTool,
    allowed: ['react_to_message'],
  },
  'packages/api/src/data/supabase/types.ts': {
    unitOf: nearestAbove(/^ {6}(\w+): \{$/),
    allowed: ['thread_message_reactions'],
  },
};

/** Files that are about reactions and nothing else. */
const REACTION_MODULES = [
  'packages/api/src/services/threads/thread-reactions.ts',
  'packages/api/src/test/fake-reactions-db.ts',
];

/**
 * The wire shape and the display model the chat surfaces draw from: types,
 * the route path, the wire-to-view mapping and the chip helpers. None of
 * them decides anything.
 */
const SHARED_DISPLAY = [
  'packages/shared/src/stories/thread-viewing/authors.ts',
  'packages/shared/src/stories/thread-viewing/conversation.ts',
  'packages/shared/src/stories/thread-viewing/index.ts',
  'packages/shared/src/stories/thread-viewing/reactions.ts',
  'packages/shared/src/stories/threads-api/paths.ts',
  'packages/shared/src/stories/threads-api/wire.ts',
];

/**
 * The emoji catalog (task 873dfd66): the exact lookup that says which emoji a
 * reaction may be added with, and the parity manifest, whose code names the
 * reaction-picking files the Inkling app copies. Pinned data and a lookup;
 * neither reads a stored reaction or decides anything from one.
 */
const EMOJI_CATALOG = [
  'packages/shared/src/stories/reacting/normalize.ts',
  'packages/shared/src/stories/reaction-picking/parity-manifest.generated.ts',
];

describe('reactions are never approval', () => {
  it('A: only the files that display or write reactions mention them', async () => {
    const files = (await Promise.all(ROOTS.map(sourceFiles))).flat();
    // The scan must have reached the code it guards.
    expect(files).toContain('packages/api/src/services/permissions.ts');
    const mentioning: string[] = [];
    for (const file of files) {
      const lines = (await readFile(path.join(REPO, file), 'utf8')).split('\n');
      if (lines.some((line) => MENTIONS_REACTIONS.test(line) && isCode(line))) {
        mentioning.push(file);
      }
    }
    expect(mentioning.sort()).toEqual(
      [...REACTION_MODULES, ...SHARED_DISPLAY, ...EMOJI_CATALOG, ...Object.keys(REGISTRIES)].sort()
    );
  });

  it.each(Object.entries(REGISTRIES))(
    'B: %s touches reactions only where it displays or writes them',
    async (file, registry) => {
      const source = await readFile(path.join(REPO, file), 'utf8');
      // The file does mention them, so this check read something.
      expect(source.split('\n').some((l) => MENTIONS_REACTIONS.test(l) && isCode(l))).toBe(true);
      expect(strayReactionLines(source, registry)).toEqual([]);
    }
  );

  it('C: no gate-verdict or permission module mentions reactions', async () => {
    const files = (await Promise.all(ROOTS.map(sourceFiles))).flat();
    const registries = new Set(Object.keys(REGISTRIES));
    const gateModules: string[] = [];
    for (const file of files) {
      if (registries.has(file)) continue;
      const source = await readFile(path.join(REPO, file), 'utf8');
      if (GATE_OR_PERMISSION.test(source)) gateModules.push(file);
    }
    // The paths the spec names are in the set this checks.
    expect(gateModules).toEqual(
      expect.arrayContaining([
        'packages/api/src/services/permissions.ts',
        'packages/api/src/services/graph-executor.service.ts',
        'packages/api/src/mcp/tools/task-handlers.ts',
        'packages/api/src/channels/approval-interceptor.ts',
      ])
    );
    for (const file of gateModules) {
      const lines = (await readFile(path.join(REPO, file), 'utf8')).split('\n');
      const mentions = lines.some((line) => MENTIONS_REACTIONS.test(line) && isCode(line));
      expect({ file, mentions }).toEqual({ file, mentions: false });
    }
  });

  it('the line check finds a reaction read placed in a gate route, a gate tool, or module scope', () => {
    const admin = REGISTRIES['packages/api/src/routes/admin.ts'];
    const synthetic = [
      "import { loadReactions } from '../services/threads/thread-reactions';",
      'const shared = 1;',
      "router.post('/tasks/gate', async (req, res) => {",
      '  const reactions = await loadReactions(client, [id], null);',
      '});',
      "router.get('/threads/messages', async (req, res) => {",
      '  const reactions = await loadReactions(client, ids, viewer);',
      '});',
    ].join('\n');
    expect(strayReactionLines(synthetic, admin)).toEqual([
      '4: [/tasks/gate] const reactions = await loadReactions(client, [id], null);',
    ]);
    expect(strayReactionLines('const reactionCount = 1;', admin)).toEqual([
      '1: [module scope] const reactionCount = 1;',
    ]);
    const index = REGISTRIES['packages/api/src/mcp/tools/index.ts'];
    const tools = [
      '  server.registerTool(',
      "    'record_gate_verdict',",
      '    async () => readReactions(),',
    ].join('\n');
    expect(strayReactionLines(tools, index)).toEqual([
      '3: [record_gate_verdict] async () => readReactions(),',
    ]);
  });
});
