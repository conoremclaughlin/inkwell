// Opt-in native configuration regression: no credentials, model turns, or real
// services. All writes and Git operations stay inside a fresh temporary repo.
// Build CLI first, then: node scripts/probe-codex-worktree-hooks.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { probeCodexMailHooks } from '../packages/cli/dist/lib/codex-mail/hook-probe.js';
import { prepareCodexMailLaunch } from '../packages/cli/dist/lib/codex-mail/preflight.js';
import { codexMailHooks, codexMailHookArgs, modernCodexMailHooks } from '../packages/cli/dist/lib/codex-mail/hooks.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ink-worktree-hooks-'));
const home = path.join(root, 'home'), main = path.join(root, 'main'), work = path.join(root, 'work');
fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
const env = { PATH: process.env.PATH, HOME: home, CODEX_HOME: path.join(home, '.codex'), TMPDIR: root, GIT_CONFIG_NOSYSTEM: '1' };
const git = (...args) => execFileSync('git', args, { env, cwd: root, stdio: 'pipe' });
git('init', main);
const message = path.join(root, 'commit.txt');
fs.writeFileSync(message, 'test: synthetic worktree hook fixture\n');
git('-C', main, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '--allow-empty', '-F', message);
git('-C', main, 'worktree', 'add', '--detach', work, 'HEAD');
for (const dir of [main, work]) fs.mkdirSync(path.join(dir, '.codex'));
const legacy = '# ink-managed:hooks:start\n[hooks]\nsession_start = "ink hooks on-session-start --backend codex"\nsession_end = "ink hooks on-stop --backend codex"\nuser_prompt = "ink hooks on-prompt --backend codex"\n# ink-managed:hooks:end\n';
const mainConfig = path.join(main, '.codex/config.toml'), workConfig = path.join(work, '.codex/config.toml');
const shellQuote = (s) => "'" + s.replaceAll("'", "'\\''") + "'";
const hooks = codexMailHooks();
const prefix = hooks[0].command.split(' hooks on-session-start')[0];
const marker = path.join(root, 'unexpected-execution');
const markerScript = path.join(root, 'marker.cjs');
fs.writeFileSync(markerScript, `require('node:fs').appendFileSync(process.argv[2], 'executed\\n');`);
const userConfig = path.join(home, '.codex/config.toml');
fs.writeFileSync(userConfig, `model_provider="fixture"\nmodel="fixture-model"\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[model_providers.fixture]\nname="No model calls"\nbase_url="http://127.0.0.1:1/v1"\nwire_api="responses"\nrequires_openai_auth=false\n[projects.${JSON.stringify(fs.realpathSync(main))}]\ntrust_level="trusted"\n[projects.${JSON.stringify(fs.realpathSync(work))}]\ntrust_level="trusted"\n[mcp_servers.fixture]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify([markerScript, marker])}\n[[hooks.PreToolUse]]\n[[hooks.PreToolUse.hooks]]\ntype="command"\ncommand=${JSON.stringify([process.execPath, markerScript, marker].map(shellQuote).join(' '))}\n`);
fs.writeFileSync(mainConfig, legacy);
fs.writeFileSync(workConfig, modernCodexMailHooks(legacy, prefix).content);
const input = { binary: 'codex', cwd: work, env, args: ['-c', 'model="fixture-override"'] };
const results = [];
const report = (check, extra = {}) => { const row = { check, ...extra }; results.push(row); console.log(JSON.stringify(row)); };
try {
  const baseline = await probeCodexMailHooks({ ...input, serverArgs: ['app-server', '--enable', 'hooks', '--listen', 'stdio://'] });
  assert.equal(baseline.hooks.data[0].hooks.length, 1, 'baseline must see only unrelated user hook, not studio hooks');
  const before = [fs.readFileSync(mainConfig, 'utf8'), fs.readFileSync(workConfig, 'utf8'), fs.readFileSync(userConfig, 'utf8')];
  const start = performance.now();
  const launch = await prepareCodexMailLaunch(input);
  const latencyMs = Math.round(performance.now() - start);
  const effective = await probeCodexMailHooks({ ...input, serverArgs: launch.serverArgs });
  const ink = effective.hooks.data[0].hooks.filter((h) => h.source === 'sessionFlags');
  assert.equal(ink.length, 3);
  assert.ok(ink.every((h) => h.enabled && h.trustStatus === 'untrusted' && !h.isManaged));
  assert.ok(effective.hooks.data[0].hooks.some((h) => h.eventName === 'preToolUse'), 'unrelated hook lost');
  assert.deepEqual([fs.readFileSync(mainConfig, 'utf8'), fs.readFileSync(workConfig, 'utf8'), fs.readFileSync(userConfig, 'utf8')], before);
  assert.ok(!fs.existsSync(marker), 'config-only probe executed an MCP server or hook');
  report('linked_worktree_session_hooks', { latencyMs, hookCount: ink.length, requiresNativeTrust: true, unchangedConfigs: true, noMcpOrHookExecution: true });
  await assert.rejects(prepareCodexMailLaunch({ ...input, args: ['--disable', 'hooks'] }), /disabled by configuration/);
  await assert.rejects(prepareCodexMailLaunch({ ...input, args: ['-c', 'hooks.Stop=[{ hooks=[{ type="command", command="echo custom" }] }]'] }), /custom session hook/);
  report('explicit_overrides_preserved');
  fs.writeFileSync(mainConfig, modernCodexMailHooks(legacy, prefix).content);
  const reused = await prepareCodexMailLaunch(input);
  assert.ok(!reused.serverArgs.some((arg) => arg.startsWith('hooks.')), 'duplicated existing modern source');
  const reusedEffective = await probeCodexMailHooks({ ...input, serverArgs: reused.serverArgs });
  assert.equal(reusedEffective.hooks.data[0].hooks.length, 4);
  report('existing_exact_guarded_hooks_reused');
  fs.writeFileSync(mainConfig, modernCodexMailHooks(legacy, "'node-other' '/fixture/other/cli.js'").content);
  const conflicting = fs.readFileSync(mainConfig, 'utf8');
  await assert.rejects(prepareCodexMailLaunch(input), /conflicting or duplicate/);
  assert.equal(fs.readFileSync(mainConfig, 'utf8'), conflicting);
  report('different_build_source_refused');
  // Markers are not native semantics. An orphan marker must not send users into
  // a destructive/redundant installer: session-only setup needs no file repair.
  fs.writeFileSync(mainConfig, legacy.replace('# ink-managed:hooks:start\n', ''));
  fs.writeFileSync(workConfig, 'fixture="unrelated project config"\n');
  assert.equal((await prepareCodexMailLaunch(input)).expectedHooks.length, 3);
  report('missing_markers_need_no_rewrite');
  // Synthetic trust-store regression: native /hooks uses these same key/hash
  // records. No real trust is touched; the full TUI probe separately proves
  // human approval and same-build resume in its disposable CODEX_HOME.
  const trustBase = fs.readFileSync(userConfig, 'utf8');
  const aArgs = ['app-server', '--enable', 'hooks', '--listen', 'stdio://', ...codexMailHookArgs(hooks)];
  const bHooks = hooks.map((h) => ({ ...h, command: 'echo fixture-build-b ' + h.command }));
  const bArgs = ['app-server', '--enable', 'hooks', '--listen', 'stdio://', ...codexMailHookArgs(bHooks)];
  const inspect = async (serverArgs) => (await probeCodexMailHooks({ ...input, serverArgs })).hooks.data[0].hooks.filter((h) => h.source === 'sessionFlags');
  const trust = (rows) => fs.writeFileSync(userConfig, trustBase + rows.map((h) => `\n[hooks.state.${JSON.stringify(h.key)}]\ntrusted_hash=${JSON.stringify(h.currentHash)}\n`).join(''));
  const a = await inspect(aArgs); trust(a);
  assert.ok((await inspect(aArgs)).every((h) => h.trustStatus === 'trusted'));
  const b = await inspect(bArgs);
  assert.ok(b.every((h) => h.trustStatus === 'untrusted' || h.trustStatus === 'modified'));
  assert.deepEqual(b.map((h) => h.key), a.map((h) => h.key));
  trust(b);
  assert.ok((await inspect(bArgs)).every((h) => h.trustStatus === 'trusted'));
  assert.ok((await inspect(aArgs)).every((h) => h.trustStatus !== 'trusted'));
  report('session_trust_slots_shared_between_builds', { returningToBuildANeedsReview: true });

  assert.ok(!fs.existsSync(marker));
} finally {
  fs.writeFileSync(path.join(root, 'results.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ evidence: root }));
}
