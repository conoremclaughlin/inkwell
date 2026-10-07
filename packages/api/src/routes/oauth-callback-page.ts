/** OAuth result pages contain only fixed copy; no provider errors or account data. */
export type OAuthCallbackResult = 'connected' | 'denied' | 'invalid' | 'expired' | 'failed';

const MESSAGES: Record<OAuthCallbackResult, string> = {
  connected: 'Your account is connected. You can close this window.',
  denied: 'The authorization server declined the connection. Please try again.',
  invalid: 'Invalid OAuth callback. Start a new connection from the dashboard.',
  expired: 'The connection request expired. Please try again.',
  failed: 'Could not connect the account. Please try again.',
};

/** For a connection started in the Inkling app: the same results, in its words. */
const APP_MESSAGES: Record<OAuthCallbackResult, string> = {
  connected: 'Your Google account is connected. Go back to Inkling to see it.',
  denied: 'Google didn’t connect the account. Go back to Inkling to try again.',
  invalid: 'This link isn’t a connection Inkling started. Go back to Inkling to try again.',
  expired: 'This connection took too long. Go back to Inkling to try again.',
  failed: 'The account couldn’t be connected. Go back to Inkling to try again.',
};

/**
 * The app's way back: a fixed address in the app's own scheme. It only brings
 * the app back. The app doesn't route it, so it shows the screen it was on, or
 * its first screen after a cold launch, not necessarily Connectors. It carries
 * nothing, and the app reads the connection from the server, so this link is
 * only a way back, never evidence of anything.
 */
export const APP_RETURN_URL = 'inkling://connectors';

export function renderOAuthCallbackPage(
  result: OAuthCallbackResult,
  { app = false }: { app?: boolean } = {}
): string {
  const success = result === 'connected';
  const message = (app ? APP_MESSAGES : MESSAGES)[result];
  const action = app
    ? `<p><a href="${APP_RETURN_URL}" style="font-size: 1.2rem">Back to Inkling</a></p>`
    : '<button onclick="window.close()">Close Window</button>';
  return `<!DOCTYPE html>
<html><head><title>${success ? 'Connected' : 'Connection Failed'}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body { font-family: system-ui; text-align: center; padding: 4rem 1.5rem; }</style>
</head><body>
<h1>${success ? 'Account Connected!' : 'Connection Failed'}</h1>
<p>${message}</p>
${action}
<script>
  if (window.opener) {
    window.opener.postMessage({ type: 'oauth-callback', success: ${success} }, '*');
  }
</script>
</body></html>`;
}
