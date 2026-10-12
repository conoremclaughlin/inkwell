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
  install(input: { root: string; serverUrl: string; onViolation(): void }): Promise<void>;
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
    async install({ root, serverUrl, onViolation }) {
      const refuse = (reason: string) => {
        violations.push(reason);
        // The owning suite closes intake and aborts its own controllers now,
        // not at the next assertion poll or the end of a 120-second turn.
        onViolation();
      };
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
            // Optional analytics, not the separately managed security plugin.
            'cc-plugin-telemetry@builtin': false,
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
          // Acceptance-only master switch for both shell implementations.
          // unified_exec=false alone falls back to one-shot execution (0.160).
          'features.shell_tool=false',
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
            // Same credential-free environment and ordered configuration as
            // mcp-list and the eventual launch; never read credential material.
            execFile(
              binary,
              ['features', 'list', ...args.slice(3)],
              options,
              (featureError, listing) => {
                const shell = /^shell_tool[ \t]+[^\r\n]+[ \t]+(true|false)\r?$/m.exec(listing)?.[1];
                const unified = /^unified_exec[ \t]+[^\r\n]+[ \t]+(true|false)\r?$/m.exec(
                  listing
                )?.[1];
                if (featureError || shell !== 'false' || !unified) {
                  refuse('Effective Codex shell feature inventory was not accepted');
                  callback(
                    new Error('Live acceptance refused effective shell configuration'),
                    '',
                    ''
                  );
                  return;
                }
                probes.push({
                  cwd: String(options.cwd),
                  servers: servers.map((server) => ({ name: String(server.name), enabled: false })),
                  features: { shell_tool: false, unified_exec: unified === 'true' },
                });
                callback(null, stdout, stderr); // real adapter still judges the MCP answer
              }
            );
          } catch {
            refuse('Effective Codex MCP inventory was not accepted');
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
        let codexSandbox: string | null = null;
        if (name === 'codex') {
          const modes = args.flatMap((arg, i) =>
            arg === '--sandbox' || arg === '-s'
              ? [args[i + 1]]
              : arg.startsWith('--sandbox=')
                ? [arg.slice('--sandbox='.length)]
                : []
          );
          const config = args.flatMap((arg, i) =>
            arg === '-c' || arg === '--config' ? [args[i + 1]] : []
          );
          if (
            modes.length !== 1 ||
            modes[0] !== 'read-only' ||
            args.some((arg) =>
              ['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto'].includes(arg)
            ) ||
            !args.includes('--json') ||
            config.filter((value) => value?.startsWith('features.shell_tool=')).at(-1) !==
              'features.shell_tool=false'
          ) {
            refuse('Codex launch did not disable native shell with explicit read-only sandbox');
            throw new Error('Codex acceptance launch configuration refused');
          }
          codexSandbox = modes[0];
        }
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
          initStatus: name === 'claude' ? 'unverified' : 'not-applicable',
          codexSandbox,
          codexRequestedShellConfig: name === 'codex' ? { shell_tool: false } : null,
          nativeToolStatus: name === 'codex' ? 'observing' : 'not-applicable',
        };
        child.once('spawn', () => {
          record.startedAt = Date.now(); // real native executable exec succeeded
          records.push(record);
        });
        child.once('exit', (code, signal) => {
          record.endedAt = Date.now();
          record.exitCode = code;
          record.signal = signal;
        });
        // Inspect provider metadata only; never rewrite either provider's stream.
        let pending = '';
        let observedBytes = 0;
        const stopInspection = () => {
          pending = '';
          child.stdout?.off('data', inspect);
        };
        const invalid = (reason: string) => {
          if (name === 'claude') record.initStatus = 'invalid';
          else record.nativeToolStatus = 'invalid';
          stopInspection();
          refuse(reason);
        };
        const inspectCodex = (line: string) => {
          let event: Json;
          try {
            event = JSON.parse(line) as Json;
          } catch {
            invalid('Codex native event stream was not readable JSON');
            return;
          }
          const item = event?.item as Json | undefined;
          if (
            item &&
            ['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(
              String(item.type)
            )
          ) {
            // Observe started/updated/completed variants alike. This is a tripwire,
            // NOT a pre-execution permission check; an event may arrive afterward.
            record.nativeToolViolation = { eventType: event.type, itemType: item.type };
            invalid('Codex emitted a native tool item during local-tool acceptance');
          }
        };
        const inspect = (chunk: Buffer) => {
          observedBytes += chunk.length;
          if (observedBytes > 1_048_576) {
            invalid('provider observation metadata exceeded bound');
            return;
          }
          pending += chunk.toString();
          const lines = pending.split('\n');
          pending = lines.pop()!;
          for (const line of lines) {
            if (name === 'codex') {
              if (line.trim()) inspectCodex(line);
              if (record.nativeToolStatus === 'invalid') return;
              continue;
            }
            let event: Json;
            try {
              event = JSON.parse(line) as Json;
            } catch {
              continue;
            }
            if (!event || event.type !== 'system' || event.subtype !== 'init') continue;
            record.init = Object.fromEntries(
              ['tools', 'plugins', 'mcp_servers'].map((key) => [
                key,
                Array.isArray(event[key]) ? (event[key] as unknown[]).length : null,
              ])
            );
            if (
              ![event.tools, event.plugins, event.mcp_servers].every(
                (value) => Array.isArray(value) && value.length === 0
              )
            )
              invalid('Claude initialization inventories were missing, malformed or nonempty');
            else {
              record.initStatus = 'verified';
              stopInspection();
            }
            return;
          }
        };
        child.stdout?.on('data', inspect);
        // exit can precede the last stdout chunk. close is the output boundary.
        // A deliberately interrupted child is still unverified, not clean.
        child.once('close', (code, signal) => {
          if (name === 'codex' && record.nativeToolStatus === 'observing') {
            if (code === 0 && signal === null) {
              if (pending.trim()) inspectCodex(pending);
              if (record.nativeToolStatus === 'observing') record.nativeToolStatus = 'complete';
            } else record.nativeToolStatus = 'interrupted';
          }
          stopInspection();
          if (
            name === 'claude' &&
            code === 0 &&
            signal === null &&
            record.initStatus === 'unverified'
          )
            refuse('Claude completed without verified initialization metadata');
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
            acceptanceOnlySettings:
              'Optional builtin telemetry analytics disabled via owned settings; security plugin and managed policy unchanged.',
            knownProviderHomeWrites: [
              'Claude project transcripts and ~/.claude.json',
              'Codex session state under normal HOME',
            ],
            nativeFileWriteBoundary:
              'Explicit read-only CLI sandbox; apply_patch is not disabled. file_change items trip the observer, which is not a pre-effect fence.',
            observationLimits:
              'Native item tripwire is not a pre-execution fence or filesystem isolation; unreported tools are not proven absent.',
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
