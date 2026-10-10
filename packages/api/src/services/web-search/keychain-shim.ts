import { isAbsolute } from 'node:path';
import { WebSearchError } from './errors.js';

const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * The pinned CLI invokes `security` through PATH. Only that native helper gets
 * the OS home; Claude keeps its disposable home/config. This is not an OS
 * sandbox. Refresh writes deliberately reach the user's existing login item.
 *
 * The executable seam is only for inert subprocess tests. Production callers
 * omit it; neither MCP input nor environment chooses it.
 */
export function keychainShim(
  nodeExecutable: string,
  osHome: string,
  account: string,
  script: string,
  marker: string,
  securityExecutable = '/usr/bin/security'
): { launcher: string; program: string } {
  if (
    [nodeExecutable, osHome, script, marker, securityExecutable].some(
      (value) => !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)
    ) ||
    !account ||
    account.length > 200 ||
    /[^a-zA-Z0-9._-]/.test(account)
  )
    throw new WebSearchError('missing_configuration');
  return {
    launcher: `#!/bin/sh\nexec ${shellQuote(nodeExecutable)} ${shellQuote(script)} "$@"\n`,
    program:
      `// Owned per-run credential helper. Never log argv/stdin/errors.
'use strict';
const { spawn } = require('node:child_process');
const { writeFile } = require('node:fs/promises');
const home = ${JSON.stringify(osHome)};
const account = ${JSON.stringify(account)};
const native = ${JSON.stringify(securityExecutable)};
const marker = ${JSON.stringify(marker)};
` +
      String.raw`
const service = 'Claude Code-credentials';
const argv = process.argv.slice(2);
const hex = value => typeof value === 'string' && value.length > 0 && value.length % 2 === 0 && !/[^0-9a-fA-F]/.test(value);
async function main() {
  await writeFile(marker, '', { mode: 0o600 });
  if (process.env.HOME === home) throw Error();
  let input;
  if (argv.length === 1 && argv[0] === '-i') {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 4032) throw Error();
      chunks.push(chunk);
    }
    input = Buffer.concat(chunks);
    const text = input.toString('utf8');
    const prefix = 'add-generic-password -U -a "' + account + '" -s "' + service + '" -X "';
    const suffix = '"\n';
    if (!text.startsWith(prefix) || !text.endsWith(suffix) || !hex(text.slice(prefix.length, -suffix.length))) throw Error();
  } else {
    const read = argv.length === 6 && argv[0] === 'find-generic-password' && argv[1] === '-a' && argv[2] === account && argv[3] === '-w' && argv[4] === '-s' && argv[5] === service;
    const write = argv.length === 8 && argv[0] === 'add-generic-password' && argv[1] === '-U' && argv[2] === '-a' && argv[3] === account && argv[4] === '-s' && argv[5] === service && argv[6] === '-X' && hex(argv[7]);
    if (!read && !write) throw Error();
  }
  await writeFile(marker + '-forwarded', '', { mode: 0o600 });
  const child = spawn(native, argv, {
    env: { ...process.env, HOME: home },
    stdio: [input === undefined ? 'inherit' : 'pipe', 'inherit', 'inherit'],
  });
  child.on('error', () => { process.exitCode = 64; });
  child.on('close', code => { process.exitCode = code === 0 ? 0 : 64; });
  if (input !== undefined) {
    child.stdin.on('error', () => { /* Native helper refusal is reported by close. */ });
    child.stdin.end(input);
  }
}
main().catch(() => { process.exitCode = 64; });
`,
  };
}
