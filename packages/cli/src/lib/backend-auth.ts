import { spawn } from 'child_process';
import chalk from 'chalk';
import { createInterface } from 'readline/promises';
import { stdin as input, stdout as output } from 'process';
import { sbDebugLog } from './sb-debug.js';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readFileSync } from 'fs';
import { buildCleanEnv } from '@inklabs/shared';

export type BackendAuthBackend = 'claude' | 'codex' | 'gemini';

export type BackendAuthStatus = {
  backend: BackendAuthBackend;
  authenticated: boolean;
  detail: string;
  loginCommand: string | null;
  loginArgs: string[];
  canInteractiveLogin: boolean;
  credentialSource: string;
};

type CommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

const AUTH_CHECK_TIMEOUT_MS = 5000;

async function runCommand(
  binary: string,
  args: string[],
  timeoutMs = AUTH_CHECK_TIMEOUT_MS
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const child = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildCleanEnv(),
    });

    let stdout = '';
    let stderr = '';
    let done = false;
    let timedOut = false;

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });

    const finish = (exitCode: number) => {
      if (done) return;
      done = true;
      resolve({
        exitCode,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        timedOut,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      finish(124);
    }, timeoutMs);
    timer.unref();

    child.on('error', (error) => {
      clearTimeout(timer);
      stderr = `${stderr}\n${String(error)}`.trim();
      finish(1);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish(code ?? 1);
    });
  });
}

export function parseClaudeAuthStatusOutput(output: string): {
  authenticated: boolean;
  detail: string;
} {
  try {
    const parsed = JSON.parse(output) as { loggedIn?: unknown; authMethod?: unknown };
    if (parsed.loggedIn === true) {
      return {
        authenticated: true,
        detail:
          typeof parsed.authMethod === 'string' && parsed.authMethod.trim()
            ? `logged in (${parsed.authMethod})`
            : 'logged in',
      };
    }
    return { authenticated: false, detail: 'not logged in' };
  } catch {
    if (/logged\s*in/i.test(output)) {
      return { authenticated: true, detail: 'logged in' };
    }
    return { authenticated: false, detail: output || 'unable to parse auth status' };
  }
}

export function parseCodexLoginStatusOutput(output: string): {
  authenticated: boolean;
  detail: string;
} {
  const lines = output
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  const notLoggedLine = lines.find((line) => /not\s+logged\s+in/i.test(line));
  if (notLoggedLine) {
    return {
      authenticated: false,
      detail: notLoggedLine,
    };
  }
  const loggedLine = lines.find((line) => /logged in/i.test(line));
  if (loggedLine) {
    return { authenticated: true, detail: loggedLine };
  }
  return {
    authenticated: false,
    detail: lines[0] || 'not logged in',
  };
}

function readGeminiAuthFile(): { authenticated: boolean; detail: string } {
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
    return { authenticated: true, detail: 'using API key from environment' };
  }
  const credsPath = join(homedir(), '.gemini', 'oauth_creds.json');
  if (!existsSync(credsPath)) {
    return { authenticated: false, detail: 'oauth creds not found (~/.gemini/oauth_creds.json)' };
  }
  try {
    const raw = JSON.parse(readFileSync(credsPath, 'utf8')) as {
      access_token?: unknown;
      refresh_token?: unknown;
    };
    // Gemini CLI handles token refresh internally — an expired access_token
    // is fine as long as a refresh_token exists. Only fail if there are no
    // credentials at all.
    if (typeof raw.refresh_token === 'string' && raw.refresh_token.trim()) {
      return { authenticated: true, detail: 'oauth creds available' };
    }
    if (typeof raw.access_token === 'string' && raw.access_token.trim()) {
      return { authenticated: true, detail: 'oauth creds available' };
    }
    return { authenticated: false, detail: 'oauth creds missing tokens' };
  } catch {
    return { authenticated: false, detail: 'oauth creds unreadable' };
  }
}

export async function getBackendAuthStatus(
  backend: BackendAuthBackend
): Promise<BackendAuthStatus> {
  switch (backend) {
    case 'claude': {
      const result = await runCommand('claude', ['auth', 'status']);
      if (result.timedOut) {
        return {
          backend,
          authenticated: false,
          detail: 'auth status check timed out',
          loginCommand: 'claude auth login',
          loginArgs: ['auth', 'login'],
          canInteractiveLogin: true,
          credentialSource:
            'Claude CLI auth store (keychain and/or ~/.claude/.credentials.json) via `claude auth status`',
        };
      }
      const parsed = parseClaudeAuthStatusOutput(result.stdout || result.stderr);
      return {
        backend,
        authenticated: result.exitCode === 0 && parsed.authenticated,
        detail: parsed.detail,
        loginCommand: 'claude auth login',
        loginArgs: ['auth', 'login'],
        canInteractiveLogin: true,
        credentialSource:
          'Claude CLI auth store (keychain and/or ~/.claude/.credentials.json) via `claude auth status`',
      };
    }
    case 'codex': {
      const result = await runCommand('codex', ['login', 'status']);
      if (result.timedOut) {
        return {
          backend,
          authenticated: false,
          detail: 'login status check timed out',
          loginCommand: 'codex login',
          loginArgs: ['login'],
          canInteractiveLogin: true,
          credentialSource: '~/.codex/auth.json and/or keychain via `codex login status`',
        };
      }
      const parsed = parseCodexLoginStatusOutput(result.stdout || result.stderr);
      return {
        backend,
        authenticated: result.exitCode === 0 && parsed.authenticated,
        detail: parsed.detail,
        loginCommand: 'codex login',
        loginArgs: ['login'],
        canInteractiveLogin: true,
        credentialSource: '~/.codex/auth.json and/or keychain via `codex login status`',
      };
    }
    case 'gemini': {
      const parsed = readGeminiAuthFile();
      return {
        backend,
        authenticated: parsed.authenticated,
        detail: parsed.detail,
        loginCommand: null,
        loginArgs: [],
        canInteractiveLogin: false,
        credentialSource: '~/.gemini/oauth_creds.json or GEMINI_API_KEY/GOOGLE_API_KEY',
      };
    }
    default: {
      return {
        backend,
        authenticated: true,
        detail: 'auth check not required',
        loginCommand: null,
        loginArgs: [],
        canInteractiveLogin: false,
        credentialSource: 'n/a',
      };
    }
  }
}

export async function runBackendInteractiveLogin(backend: BackendAuthBackend): Promise<number> {
  const status = await getBackendAuthStatus(backend);
  if (!status.loginArgs.length) return 1;

  return await new Promise((resolve) => {
    const child = spawn(backend, status.loginArgs, {
      stdio: 'inherit',
      env: process.env,
    });
    child.on('error', () => resolve(1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

export function isBackendAuthBackend(value: string): value is BackendAuthBackend {
  return value === 'claude' || value === 'codex' || value === 'gemini';
}

/**
 * Make sure a runtime's provider is logged in before we spend a session on it.
 *
 * Shared by `ink chat` and `ink awaken`. Awakening especially: nothing is worse
 * than composing a being's first words and then dying on an auth prompt the
 * user could have cleared in ten seconds.
 *
 * Offers to run the provider's own login when we can (TTY, interactive), falls
 * back to printing the command otherwise, and rechecks afterwards rather than
 * assuming the login worked.
 */
export async function ensureBackendAuthReady(
  backend: string,
  mode: { nonInteractive: boolean; hasMessage: boolean; verbose: boolean },
  debugScope = 'chat'
): Promise<void> {
  if (process.env.SB_SKIP_BACKEND_AUTH_CHECK === '1' || process.env.VITEST) {
    return;
  }
  if (!isBackendAuthBackend(backend)) return;

  const status = await getBackendAuthStatus(backend);
  sbDebugLog(debugScope, 'backend_auth_status', {
    backend,
    authenticated: status.authenticated,
    detail: status.detail,
    canInteractiveLogin: status.canInteractiveLogin,
    loginCommand: status.loginCommand || null,
    mode,
  });
  if (status.authenticated) {
    if (mode.verbose) {
      console.log(chalk.dim(`Backend auth: ${backend} (${status.detail})`));
    }
    return;
  }

  const guidance = `Backend ${backend} is not authenticated (${status.detail}).`;
  const loginHint =
    status.loginCommand ||
    (backend === 'gemini' ? 'Start `gemini` once and complete login in the Gemini CLI' : null);

  if (mode.nonInteractive || mode.hasMessage) {
    sbDebugLog(debugScope, 'backend_auth_required_non_interactive', {
      backend,
      detail: status.detail,
      loginCommand: loginHint || null,
      mode,
    });
    throw new Error(
      `${guidance}${loginHint ? `\nRun: ${loginHint}` : '\nAuthenticate backend CLI and retry.'}`
    );
  }

  console.log(chalk.yellow(`⚠ ${guidance}`));
  if (!status.canInteractiveLogin || !status.loginCommand) {
    if (loginHint) console.log(chalk.dim(`  Run: ${loginHint}`));
    return;
  }
  if (!input.isTTY || !output.isTTY) {
    console.log(chalk.dim(`  Run: ${status.loginCommand}`));
    return;
  }

  const prompt = createInterface({ input, output });
  try {
    const answer = (
      await prompt.question(chalk.cyan(`Run ${status.loginCommand} now? [Y/n] `))
    ).trim();
    if (answer && !['y', 'yes'].includes(answer.toLowerCase())) {
      console.log(chalk.dim(`  Skipping login. Run manually: ${status.loginCommand}`));
      return;
    }
  } finally {
    prompt.close();
  }

  const exitCode = await runBackendInteractiveLogin(backend);
  if (exitCode !== 0) {
    throw new Error(
      `Backend ${backend} login exited with code ${exitCode}. Run \`${status.loginCommand}\` and retry.`
    );
  }
  const recheck = await getBackendAuthStatus(backend);
  if (!recheck.authenticated) {
    throw new Error(
      `Backend ${backend} still appears unauthenticated (${recheck.detail}). Run \`${status.loginCommand}\` and retry.`
    );
  }
  console.log(chalk.green(`✓ Backend ${backend} authenticated (${recheck.detail})`));
}
