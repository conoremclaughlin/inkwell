/**
 * Auth Command
 *
 * OAuth 2.0 PKCE login against the PCP MCP server.
 *
 * Commands:
 *   auth login    Authenticate via browser
 *   auth status   Show current auth state
 *   auth logout   Clear stored tokens
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import http from 'http';
import crypto from 'crypto';
import { exec } from 'child_process';
import {
  generatePkce,
  loadAuth,
  saveAuth,
  clearAuth,
  decodeJwtPayload,
  isTokenExpired,
  getValidAccessToken,
  saveDelegatedAuth,
  updateConfigEmail,
  CLIENT_ID,
} from '../auth/tokens.js';
import {
  getBackendAuthStatus,
  runBackendInteractiveLogin,
  type BackendAuthBackend,
} from '../lib/backend-auth.js';

// ============================================================================
// Helpers
// ============================================================================

function getPcpServerUrl(): string {
  return process.env.PCP_SERVER_URL || 'http://localhost:3001';
}

function openBrowser(url: string): void {
  // macOS — extend for Linux/Windows later
  exec(`open "${url}"`);
}

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const SUCCESS_HTML = `<!DOCTYPE html>
<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#fafafa">
  <h2 style="color:#16a34a">Authentication successful</h2>
  <p style="color:#555">You can close this tab and return to the terminal.</p>
</body></html>`;

const ERROR_HTML = (msg: string) => `<!DOCTYPE html>
<html><body style="font-family:system-ui;text-align:center;padding:60px;background:#fafafa">
  <h2 style="color:#dc2626">Authentication failed</h2>
  <p style="color:#555">${msg}</p>
</body></html>`;

// ============================================================================
// Login
// ============================================================================

interface CallbackResult {
  code: string;
  state: string;
}

function startCallbackServer(
  expectedState: string
): Promise<{ result: Promise<CallbackResult>; port: number; close: () => void }> {
  return new Promise((resolveServer) => {
    let resolveResult: (value: CallbackResult) => void;
    let rejectResult: (reason: Error) => void;

    const result = new Promise<CallbackResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://127.0.0.1`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const error = url.searchParams.get('error');

      if (error) {
        const desc = url.searchParams.get('error_description') || error;
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML(desc));
        clearTimeout(timeout);
        rejectResult(new Error(desc));
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML('Missing code or state parameter'));
        clearTimeout(timeout);
        rejectResult(new Error('Missing code or state in callback'));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML('State mismatch — possible CSRF. Try again.'));
        clearTimeout(timeout);
        rejectResult(new Error('State mismatch'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(SUCCESS_HTML);
      clearTimeout(timeout);
      resolveResult({ code, state });
    });

    const timeout = setTimeout(() => {
      rejectResult(new Error('Login timed out'));
      server.close();
    }, LOGIN_TIMEOUT_MS);

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveServer({
        result,
        port,
        close: () => {
          clearTimeout(timeout);
          server.close();
        },
      });
    });
  });
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
  error?: string;
  error_description?: string;
}

async function exchangeCode(
  serverUrl: string,
  code: string,
  codeVerifier: string
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    client_id: CLIENT_ID,
  });

  const response = await fetch(`${serverUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = (await response.json()) as TokenResponse;

  if (!response.ok || data.error) {
    throw new Error(data.error_description || data.error || 'Token exchange failed');
  }

  return data;
}

async function loginCommand(options: { browser: boolean }): Promise<void> {
  const serverUrl = getPcpServerUrl();

  // Check if already logged in
  const existing = loadAuth();
  if (existing && !isTokenExpired(existing)) {
    const payload = decodeJwtPayload(existing.access_token);
    console.log(chalk.dim(`Already logged in as ${payload?.email || 'unknown'}.`));
    console.log(chalk.dim('Run `sb auth logout` first to switch accounts.'));
    return;
  }

  const { codeVerifier, codeChallenge } = generatePkce();
  const state = crypto.randomBytes(16).toString('hex');

  // Start local callback server
  const { result, port, close } = await startCallbackServer(state);

  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authorizeUrl = new URL(`${serverUrl}/authorize`);
  authorizeUrl.searchParams.set('client_id', CLIENT_ID);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('state', state);
  authorizeUrl.searchParams.set('response_type', 'code');

  if (options.browser) {
    openBrowser(authorizeUrl.toString());
    console.log(chalk.dim('Opening browser for login...'));
  } else {
    console.log('\nOpen this URL in your browser to log in:\n');
    console.log(chalk.cyan(authorizeUrl.toString()));
    console.log('');
  }

  const spinner = ora('Waiting for browser login...').start();

  try {
    const { code } = await result;
    spinner.text = 'Exchanging tokens...';

    const tokens = await exchangeCode(serverUrl, code, codeVerifier);

    saveAuth({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      scope: tokens.scope,
      issued_at: Date.now(),
    });

    // Extract email from JWT and update config
    const payload = decodeJwtPayload(tokens.access_token);
    if (payload?.email) {
      updateConfigEmail(payload.email, payload.sub);
    }

    spinner.succeed(chalk.green(`Logged in as ${payload?.email || 'unknown'}`));
  } catch (err) {
    spinner.fail(chalk.red(err instanceof Error ? err.message : 'Login failed'));
    process.exitCode = 1;
  } finally {
    close();
  }
}

// ============================================================================
// Status
// ============================================================================

async function statusCommand(): Promise<void> {
  const auth = loadAuth();

  if (!auth) {
    console.log(chalk.yellow('Not logged in.'));
    console.log(chalk.dim('Run: sb auth login'));
    return;
  }

  const payload = decodeJwtPayload(auth.access_token);
  const expired = isTokenExpired(auth, 0);

  console.log('');
  if (payload?.email) {
    console.log(`  ${chalk.bold('Email:')}    ${payload.email}`);
  }
  if (payload?.sub) {
    console.log(`  ${chalk.bold('User ID:')}  ${chalk.dim(payload.sub)}`);
  }

  if (expired) {
    console.log(`  ${chalk.bold('Token:')}   ${chalk.yellow('expired')}`);
    console.log(
      chalk.dim('\n  Token will refresh automatically on next sb launch, or run: sb auth login')
    );
  } else {
    const expiresAtMs = auth.issued_at + auth.expires_in * 1000;
    const daysLeft = Math.floor((expiresAtMs - Date.now()) / (1000 * 60 * 60 * 24));
    console.log(
      `  ${chalk.bold('Token:')}   ${chalk.green('valid')} ${chalk.dim(`(expires in ${daysLeft}d)`)}`
    );
  }
  console.log('');
}

// ============================================================================
// Logout
// ============================================================================

async function logoutCommand(): Promise<void> {
  const auth = loadAuth();
  if (!auth) {
    console.log(chalk.dim('Not logged in.'));
    return;
  }

  clearAuth();
  console.log(chalk.green('Logged out. Tokens cleared.'));
}

async function delegateCommand(options: { agent: string }): Promise<void> {
  const serverUrl = getPcpServerUrl();
  const agentId = options.agent?.trim().toLowerCase();
  if (!agentId) {
    console.log(chalk.red('Missing --agent <agentId>'));
    process.exitCode = 1;
    return;
  }

  const baseToken = await getValidAccessToken(serverUrl);
  if (!baseToken) {
    console.log(chalk.yellow('Not authenticated. Run: sb auth login'));
    process.exitCode = 1;
    return;
  }

  const response = await fetch(`${serverUrl}/token/delegate`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${baseToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ agentId }),
  });

  if (!response.ok) {
    const text = await response.text();
    console.log(chalk.red(`Delegation failed (${response.status}): ${text}`));
    process.exitCode = 1;
    return;
  }

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
    delegated_agent_id?: string;
    identity_id?: string;
  };

  if (!payload.access_token || typeof payload.expires_in !== 'number') {
    console.log(chalk.red('Delegation response missing access token payload.'));
    process.exitCode = 1;
    return;
  }

  saveDelegatedAuth(agentId, {
    access_token: payload.access_token,
    expires_in: payload.expires_in,
    issued_at: Date.now(),
    scope: payload.scope,
    agent_id: payload.delegated_agent_id || agentId,
    identity_id: payload.identity_id,
  });

  const expiresAt = new Date(Date.now() + payload.expires_in * 1000);
  console.log(
    chalk.green(
      `Delegated token saved for ${agentId} (expires ${expiresAt.toLocaleString('en-US')}).`
    )
  );
}

const AUTH_BACKENDS: BackendAuthBackend[] = ['claude', 'codex', 'gemini'];

function parseBackendName(value?: string): BackendAuthBackend | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'claude' || normalized === 'codex' || normalized === 'gemini') {
    return normalized;
  }
  return null;
}

async function backendStatusCommand(options: { backend?: string }): Promise<void> {
  const selected = parseBackendName(options.backend);
  if (options.backend && !selected) {
    console.log(chalk.red(`Unknown backend: ${options.backend}`));
    console.log(chalk.dim('Valid: claude, codex, gemini'));
    process.exitCode = 1;
    return;
  }

  const targets = selected ? [selected] : AUTH_BACKENDS;
  console.log(chalk.bold('\nBackend Auth Status\n'));
  for (const backend of targets) {
    const status = await getBackendAuthStatus(backend);
    const state = status.authenticated
      ? chalk.green('authenticated')
      : chalk.yellow('unauthenticated');
    console.log(`  ${chalk.bold(backend)}: ${state} ${chalk.dim(`(${status.detail})`)}`);
    console.log(chalk.dim(`    source: ${status.credentialSource}`));
    if (!status.authenticated && status.loginCommand) {
      console.log(chalk.dim(`    login:  ${status.loginCommand}`));
    }
  }
  console.log('');
}

async function backendLoginCommand(options: { backend: string }): Promise<void> {
  const backend = parseBackendName(options.backend);
  if (!backend) {
    console.log(chalk.red(`Unknown backend: ${options.backend}`));
    console.log(chalk.dim('Valid: claude, codex, gemini'));
    process.exitCode = 1;
    return;
  }

  const before = await getBackendAuthStatus(backend);
  if (before.authenticated) {
    console.log(chalk.green(`${backend} already authenticated (${before.detail})`));
    return;
  }

  if (!before.canInteractiveLogin || !before.loginCommand) {
    console.log(chalk.yellow(`${backend} login must be completed in backend CLI.`));
    console.log(chalk.dim(`Status: ${before.detail}`));
    if (backend === 'gemini') {
      console.log(
        chalk.dim('Run `gemini` and complete authentication, then re-run this status check.')
      );
    }
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log(chalk.yellow('backend login requires interactive TTY.'));
    console.log(chalk.dim(`Run interactively: ${before.loginCommand}`));
    process.exitCode = 1;
    return;
  }

  console.log(chalk.dim(`Launching: ${before.loginCommand}`));
  const exitCode = await runBackendInteractiveLogin(backend);
  if (exitCode !== 0) {
    console.log(chalk.red(`${before.loginCommand} exited with ${exitCode}`));
    process.exitCode = exitCode;
    return;
  }
  const after = await getBackendAuthStatus(backend);
  if (!after.authenticated) {
    console.log(chalk.red(`${backend} still unauthenticated (${after.detail})`));
    process.exitCode = 1;
    return;
  }
  console.log(chalk.green(`${backend} authenticated (${after.detail})`));
}

// ============================================================================
// Register
// ============================================================================

export function registerAuthCommands(program: Command): void {
  const auth = program.command('auth').description('Manage PCP authentication');

  auth
    .command('login')
    .description('Log in to PCP via browser')
    .option('--no-browser', 'Print login URL instead of opening browser')
    .action(loginCommand);

  auth.command('status').description('Show current authentication status').action(statusCommand);

  auth.command('logout').description('Clear stored authentication tokens').action(logoutCommand);

  auth
    .command('delegate')
    .description('Mint and store an SB-scoped delegated MCP token')
    .requiredOption('-a, --agent <agentId>', 'SB agentId (e.g. wren, lumen, aster)')
    .action(delegateCommand);

  const backend = auth
    .command('backend')
    .description('Manage backend CLI authentication status/login');

  backend
    .command('status')
    .description('Show backend CLI auth status')
    .option('-b, --backend <name>', 'Backend (claude, codex, gemini)')
    .action(backendStatusCommand);

  backend
    .command('login')
    .description('Run backend CLI login flow (interactive when supported)')
    .requiredOption('-b, --backend <name>', 'Backend (claude, codex, gemini)')
    .action(backendLoginCommand);
}
