/**
 * `ink google` — desktop Google credentials.
 *
 *   google login     Sign in with a Desktop OAuth client; store the refresh token
 *   google status    Show stored logins (--check asks Google if they still work)
 *   google logout    Delete a stored login
 *
 * The files land in ~/.ink/google/ and the API server reads them as the
 * `desktop` credential source next to the dashboard's cloud connection.
 */

import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { exec } from 'child_process';
import { missingGoogleScopes } from '@inklabs/shared';
import {
  checkDesktopCredential,
  desktopCredentialsDir,
  listDesktopCredentials,
  loadDesktopOAuthClient,
  removeDesktopCredential,
  runDesktopGoogleLogin,
  writeDesktopCredential,
} from '../lib/google-desktop-login.js';

function openBrowser(url: string): void {
  // macOS — extend for Linux/Windows later (mirrors `ink auth login`).
  exec(`open "${url}"`);
}

const SEVEN_DAY_NOTE =
  'If the OAuth client belongs to a Google Cloud project whose consent screen is still in ' +
  '"Testing", Google expires this login after 7 days. Publish the app (Audience → Publish app → ' +
  'Confirm; no verification needed) and log in once more to make it permanent.';

export async function loginCommand(options: { client?: string; browser: boolean }): Promise<void> {
  const dir = desktopCredentialsDir();
  // A missing or wrong client file is the FIRST thing a new user hits; it
  // must read as instructions, not a stack trace.
  let loaded: ReturnType<typeof loadDesktopOAuthClient>;
  try {
    loaded = loadDesktopOAuthClient(dir, options.client);
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
    return;
  }
  if (loaded.imported) console.log(chalk.dim(`Saved OAuth client to ${loaded.path}`));

  const spinner = ora(
    options.browser ? 'Opening browser for Google sign-in...' : 'Waiting for sign-in...'
  ).start();
  try {
    const { credential, requestedScopes } = await runDesktopGoogleLogin({
      client: loaded.client,
      browser: options.browser,
      deps: {
        openUrl: openBrowser,
        print: (line) => {
          spinner.stop();
          console.log(line);
          spinner.start();
        },
      },
    });
    spinner.text = 'Saving credential...';
    const path = writeDesktopCredential(dir, credential);
    spinner.succeed(`Signed in as ${chalk.bold(credential.email)}`);
    console.log(chalk.dim(`Saved ${path}`));

    const missing = missingGoogleScopes(credential.scopes, requestedScopes);
    if (missing.length > 0) {
      console.log(chalk.yellow('\nSome requested permissions were not granted:'));
      for (const scope of missing) console.log(chalk.yellow(`  - ${scope}`));
      console.log(
        chalk.yellow('Integrations needing them will fail until you log in again and allow them.')
      );
    }

    console.log('');
    console.log(
      `The Inkwell server will use this login for the account ${credential.email} ` +
        `(GOOGLE_CREDENTIAL_SOURCES, default cloud,desktop). No restart needed.`
    );
    console.log(chalk.dim(`\n${SEVEN_DAY_NOTE}`));
  } catch (err) {
    spinner.fail(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

export async function statusCommand(options: { check?: boolean }): Promise<void> {
  const dir = desktopCredentialsDir();
  const { credentials, malformed } = listDesktopCredentials(dir);
  console.log(chalk.dim(`Desktop Google credentials in ${dir}`));
  if (credentials.length === 0 && malformed.length === 0) {
    console.log('  (none — run `ink google login`)');
    return;
  }
  for (const stored of credentials) {
    const { credential } = stored;
    const obtained = credential.obtained_at
      ? new Date(credential.obtained_at).toLocaleString()
      : stored.modifiedAt.toLocaleString();
    console.log(`\n  ${chalk.bold(credential.email)}`);
    console.log(`    obtained: ${obtained}`);
    console.log(`    scopes:   ${credential.scopes.length}`);
    const missing = missingGoogleScopes(credential.scopes);
    if (missing.length > 0) {
      console.log(
        chalk.yellow(
          `    missing:  ${missing.length} required scope(s) — log in again to grant them`
        )
      );
    }
    if (options.check) {
      const verdict = await checkDesktopCredential(credential);
      if (verdict.ok) {
        console.log(chalk.green('    check:    refresh works'));
      } else {
        console.log(chalk.red(`    check:    refused — ${verdict.error}`));
        if (
          verdict.error.includes('invalid_grant') ||
          verdict.error.toLowerCase().includes('expired')
        ) {
          console.log(chalk.dim(`    ${SEVEN_DAY_NOTE}`));
        }
      }
    }
  }
  for (const bad of malformed) {
    console.log(chalk.yellow(`\n  ${bad.path}: ignored — ${bad.reason}`));
  }
}

export function logoutCommand(email: string): void {
  const dir = desktopCredentialsDir();
  if (removeDesktopCredential(dir, email)) {
    console.log(`Removed the stored login for ${email}.`);
    console.log(chalk.dim('To also revoke it at Google: https://myaccount.google.com/permissions'));
  } else {
    console.log(`No stored login for ${email} in ${dir}.`);
    process.exitCode = 1;
  }
}

export function registerGoogleCommands(program: Command): void {
  const google = program
    .command('google')
    .description('Desktop Google credentials for Gmail, Calendar, Drive, Docs and Sheets');

  google
    .command('login')
    .description(
      'Sign in with a Desktop OAuth client and store the refresh token under ~/.ink/google'
    )
    .option(
      '--client <path>',
      'Downloaded client_secret_*.json (copied to ~/.ink/google/client.json)'
    )
    .option('--no-browser', 'Print the sign-in URL instead of opening a browser')
    .action(loginCommand);

  google
    .command('status')
    .description('Show stored desktop logins')
    .option('--check', 'Ask Google whether each stored login still refreshes')
    .action(statusCommand);

  google
    .command('logout <email>')
    .description('Delete the stored login for an account')
    .action(logoutCommand);
}
