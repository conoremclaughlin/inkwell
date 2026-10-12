/**
 * Opt-in acceptance driver, NOT production configuration. It observes real
 * native children and decorates only their launch configuration. Provider
 * output is never replaced, and normal login stays in the provider's HOME.
 */
import { syncBuiltinESMExports } from 'node:module';
import { expect, vi } from 'vitest';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { ClaudeAdapter, CodexAdapter } from '@inklabs/shared/providers';

type Json = Record<string, unknown>;
export interface ParallelLivePlan {
  providerHome: string;
  claudeBinary: string;
  codexBinary: string;
  /** Reviewed, value-free configuration overrides; never credential values. */
  codexConfig: string[];
}
export interface ParallelLiveDriver {
  enabled: boolean;
  providerHome: string;
  install(input: { root: string; serverUrl: string }): Promise<void>;
  binary(name: 'claude' | 'codex'): string;
  launches(sessionId: string): Json[];
  clear(sessionId: string): void;
  prompt(fixture: Json): string;
  finish(input: {
    root: string;
    cleaned: boolean;
    calls: Json[];
    ledgers: Map<string, string>;
  }): Promise<void>;
}

export function parallelLiveDriver(plan: ParallelLivePlan, enabled: boolean): ParallelLiveDriver {
  const records: Json[] = [];
  const offsets = new Map<string, number>();
  const violations: string[] = [];
  const probes: Json[] = [];
  const binaries = { claude: plan.claudeBinary, codex: plan.codexBinary };
  const ownPath = (root: string, file: string) => {
    const rel = relative(root, file);
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  };
  return {
    enabled,
    providerHome: plan.providerHome,
    binary(name) {
      if (violations.length) throw new Error('Live provider configuration was not accepted');
      return binaries[name];
    },
    async install({ root, serverUrl }) {
      if (!enabled || process.env.INK_LIVE_TESTS !== '1' || process.env.INK_PARALLEL_LIVE !== '1')
        throw new Error('Live acceptance was not explicitly enabled');
      if (!isAbsolute(plan.providerHome) || ownPath(root, plan.providerHome))
        throw new Error('Provider HOME must be the explicitly selected normal login home');
      for (const name of ['claude', 'codex'] as const) {
        binaries[name] = await realpath(binaries[name]);
        if (!isAbsolute(binaries[name]) || binaries[name].endsWith('.js'))
          throw new Error('Use the native executable, not a JS launcher');
      }
      // Do not turn arbitrary passthrough into an auth/command injection API.
      if (
        !plan.codexConfig.every((value) =>
          /^(?:mcp_servers\.[A-Za-z0-9_-]+\.enabled=false|plugins\."[A-Za-z0-9_@.-]+"\.enabled=false|features\.(?:hooks|apps|shell_snapshot)=false)$/.test(
            value
          )
        )
      )
        throw new Error('Unexpected acceptance configuration override');
      const settings = join(root, 'claude-settings.json');
      await writeFile(
        settings,
        JSON.stringify({
          disableAllHooks: true,
          enabledPlugins: {
            'cc-plugin-agents-md@builtin': false,
            'cc-plugin-plugin-authoring@builtin': false,
          },
          autoMemoryEnabled: false,
        }),
        { mode: 0o600 }
      );
      const claudePrepare = ClaudeAdapter.prototype.prepare;
      vi.spyOn(ClaudeAdapter.prototype, 'prepare').mockImplementation(async function (
        this: ClaudeAdapter,
        config,
        host
      ) {
        const prepared = await claudePrepare.call(this, config, host);
        try {
          const i = prepared.args.indexOf('--mcp-config');
          if (
            !prepared.args.includes('--strict-mcp-config') ||
            i < 0 ||
            !ownPath(root, prepared.args[i + 1]!)
          )
            throw new Error('Unexpected Claude MCP scope');
          const mcp = JSON.parse(await readFile(prepared.args[i + 1]!, 'utf8')) as Json;
          expect(mcp.mcpServers).toEqual({});
          expect(prepared.args[prepared.args.indexOf('--tools') + 1]).toBe('');
          // Safe mode retains login; unlike bare mode it does not suppress it.
          // Managed security policy is not disabled by these settings.
          prepared.args.push(
            '--safe-mode',
            '--setting-sources',
            '',
            '--settings',
            settings,
            '--disable-slash-commands',
            '--no-chrome',
            '--max-turns',
            '1'
          );
          return prepared;
        } catch (error) {
          await prepared.cleanup();
          throw error;
        }
      });
      const codexPrepare = CodexAdapter.prototype.prepare;
      vi.spyOn(CodexAdapter.prototype, 'prepare').mockImplementation(function (
        this: CodexAdapter,
        config,
        host
      ) {
        // These go through the REAL adapter's effective-config check and launch
        // together. The inkwell entry is disabled: local Ink executes its calls.
        const overrides = [
          ...plan.codexConfig,
          `mcp_servers.inkwell.url=${JSON.stringify(`${serverUrl}/mcp`)}`,
          'mcp_servers.inkwell.enabled=false',
          'mcp_servers.inkwell.http_headers={}',
        ].flatMap((value) => ['-c', value]);
        return codexPrepare.call(
          this,
          {
            ...config,
            passthroughArgs: [...config.passthroughArgs, ...overrides],
          },
          host
        );
      });
      const execFile = childProcess.execFile;
      vi.spyOn(childProcess, 'execFile').mockImplementation(((
        binary: string,
        args: string[],
        options: childProcess.ExecFileOptionsWithStringEncoding,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (binary !== binaries.codex || args[0] !== 'mcp' || args[1] !== 'list')
          return execFile(binary, args, options, callback);
        return execFile(binary, args, options, (error, stdout, stderr) => {
          if (error) return callback(error, stdout, stderr);
          try {
            const servers: unknown = JSON.parse(stdout);
            if (
              !Array.isArray(servers) ||
              servers.some((server) => !server || server.enabled !== false)
            )
              throw new Error('Effective Codex MCP inventory was not wholly disabled');
            probes.push({
              cwd: String(options.cwd),
              servers: servers.map((server) => ({ name: String(server.name), enabled: false })),
            });
            callback(null, stdout, stderr); // original adapter still judges the real answer
          } catch {
            violations.push('Effective Codex MCP inventory was not accepted');
            callback(new Error('Live acceptance refused effective MCP configuration'), '', '');
          }
        });
      }) as typeof childProcess.execFile);
      const spawn = childProcess.spawn;
      vi.spyOn(childProcess, 'spawn').mockImplementation(((
        binary: string,
        args: string[],
        options: childProcess.SpawnOptions
      ) => {
        const name = (Object.keys(binaries) as Array<keyof typeof binaries>).find(
          (key) => binaries[key] === binary
        );
        if (!name) return spawn(binary, args, options);
        const env = options.env ?? {};
        // Credential-free mcp-list probes are not inference or overlap evidence.
        if (!env.INK_ACCESS_TOKEN) return spawn(binary, args, options);
        const cwd = String(options.cwd);
        if (
          !ownPath(root, cwd) ||
          env.HOME !== plan.providerHome ||
          env.SUPABASE_SECRET_KEY ||
          env.JWT_SECRET ||
          env.ANTHROPIC_API_KEY ||
          env.OPENAI_API_KEY
        )
          throw new Error('Unexpected live provider authority or cwd');
        const token = JSON.parse(
          Buffer.from(env.INK_ACCESS_TOKEN.split('.')[1]!, 'base64url').toString()
        ) as Json;
        const context = JSON.parse(Buffer.from(env.INK_CONTEXT!, 'base64url').toString()) as Json;
        const child = spawn(binary, args, options);
        const record: Json = {
          pid: child.pid,
          provider: name,
          cwd,
          sessionId: token.sessionId,
          sbSlug: token.sbSlug,
          studioId: context.studioId,
          context,
          token: { sub: token.sub, sessionId: token.sessionId, sbSlug: token.sbSlug },
          credentialFingerprint: createHash('sha256').update(env.INK_ACCESS_TOKEN).digest('hex'),
          mcpConfig: args.includes('--mcp-config') ? args[args.indexOf('--mcp-config') + 1] : null,
          nativeTools: args.includes('--tools') ? args[args.indexOf('--tools') + 1] : null,
          leakedServerCredential: false,
          observedBinary: binary,
        };
        child.once('spawn', () => {
          record.startedAt = Date.now(); // real native executable exec succeeded
          records.push(record);
        });
        child.once('exit', () => {
          record.endedAt = Date.now();
        });
        // Inspect only Claude's initialization metadata, never rewrite its stream.
        let pending = '';
        child.stdout?.on('data', (chunk: Buffer) => {
          if (name !== 'claude' || record.initChecked) return;
          pending += chunk.toString();
          if (pending.length > 1_048_576) {
            violations.push('initialization metadata exceeded bound');
            return;
          }
          const lines = pending.split('\n');
          pending = lines.pop()!;
          for (const line of lines) {
            let event: Json;
            try {
              event = JSON.parse(line) as Json;
            } catch {
              continue;
            }
            if (event.type !== 'system' || event.subtype !== 'init') continue;
            record.initChecked = true;
            record.init = Object.fromEntries(
              ['tools', 'plugins', 'mcp_servers'].map((key) => [
                key,
                Array.isArray(event[key]) ? (event[key] as unknown[]).length : null,
              ])
            );
            if (
              ![event.tools ?? [], event.plugins ?? [], event.mcp_servers ?? []].every(
                (value) => Array.isArray(value) && value.length === 0
              )
            )
              violations.push('Claude initialized unexpected tools/plugins/MCP');
          }
        });
        return child;
      }) as typeof childProcess.spawn);
      syncBuiltinESMExports();
    },
    launches(id) {
      if (violations.length) throw new Error(violations.join('; '));
      return records.slice(offsets.get(id) ?? 0).filter((record) => record.sessionId === id);
    },
    clear(id) {
      offsets.set(id, records.length);
    },
    prompt(fixture) {
      const tool = (name: string, args: Json) =>
        '\n```ink-tool\n' + JSON.stringify({ tool: name, args }) + '\n```';
      const calls =
        tool('remember', { sbSlug: fixture.sbSlug, content: fixture.marker, salience: 'low' }) +
        (fixture.failTool ? tool('remember', { sbSlug: fixture.sbSlug, content: 17 }) : '') +
        (fixture.threadKey || fixture.tryBash ? tool('bash', { command: 'true' }) : '') +
        tool('send_to_inbox', {
          senderSlug: fixture.sbSlug,
          recipientSlug: fixture.threadKey ? fixture.sbSlug : 'sink',
          ...(fixture.threadKey ? { threadKey: fixture.threadKey } : {}),
          content: fixture.marker,
          trigger: false,
        });
      return `Synthetic acceptance. Use only Ink-local tool fences, never native tools. First emit exactly these fences, without prose: ${calls}\nThe invalid content:17 (when present) is deliberate validation evidence; do not repair or retry it. After their results, reply with exactly ${fixture.marker}, followed by this completion fence: ${tool('signal_status', { status: 'completed' })}. No further calls. This instruction applies anew to this user turn, even when earlier turns did similar work.`;
    },
    async finish({ root, cleaned, calls, ledgers }) {
      await writeFile(
        join(root, 'acceptance-evidence.json'),
        JSON.stringify(
          {
            cleaned,
            probes,
            records,
            calls,
            ledgers: Object.fromEntries(ledgers),
            violations,
            limits: { turnMs: 120000, providerRoundsPerTurn: 4, caseMs: 180000, suiteMs: 900000 },
            substitutes: [
              'inert coding sentinel',
              'fixture agent gateway',
              'acceptance-only provider configuration',
            ],
          },
          null,
          2
        ),
        { mode: 0o600 }
      );
      if (violations.length) throw new Error(violations.join('; '));
    },
  };
}
