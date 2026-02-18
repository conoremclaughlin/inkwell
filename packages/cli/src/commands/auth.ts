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
  updateConfigEmail,
  CLIENT_ID,
} from '../auth/tokens.js';

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
        rejectResult(new Error(desc));
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML('Missing code or state parameter'));
        rejectResult(new Error('Missing code or state in callback'));
        return;
      }

      if (state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(ERROR_HTML('State mismatch — possible CSRF. Try again.'));
        rejectResult(new Error('State mismatch'));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(SUCCESS_HTML);
      resolveResult({ code, state });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolveServer({
        result,
        port,
        close: () => server.close(),
      });
    });

    // Timeout
    setTimeout(() => {
      rejectResult(new Error('Login timed out'));
      server.close();
    }, LOGIN_TIMEOUT_MS);
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
    console.log(chalk.dim('\n  Token will refresh automatically on next sb launch, or run: sb auth login'));
  } else {
    const expiresAtMs = auth.issued_at + auth.expires_in * 1000;
    const daysLeft = Math.floor((expiresAtMs - Date.now()) / (1000 * 60 * 60 * 24));
    console.log(`  ${chalk.bold('Token:')}   ${chalk.green('valid')} ${chalk.dim(`(expires in ${daysLeft}d)`)}`);
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

  auth
    .command('logout')
    .description('Clear stored authentication tokens')
    .action(logoutCommand);
}
