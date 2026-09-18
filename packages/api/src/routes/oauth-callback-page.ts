/** OAuth result pages contain only fixed copy; no provider errors or account data. */
export type OAuthCallbackResult = 'connected' | 'denied' | 'invalid' | 'expired' | 'failed';

const MESSAGES: Record<OAuthCallbackResult, string> = {
  connected: 'Your account is connected. You can close this window.',
  denied: 'The authorization server declined the connection. Please try again.',
  invalid: 'Invalid OAuth callback. Start a new connection from the dashboard.',
  expired: 'The connection request expired. Please try again.',
  failed: 'Could not connect the account. Please try again.',
};

export function renderOAuthCallbackPage(result: OAuthCallbackResult): string {
  const success = result === 'connected';
  return `<!DOCTYPE html>
<html><head><title>${success ? 'Connected' : 'Connection Failed'}</title>
<style>body { font-family: system-ui; text-align: center; padding: 4rem; }</style>
</head><body>
<h1>${success ? 'Account Connected!' : 'Connection Failed'}</h1>
<p>${MESSAGES[result]}</p>
<button onclick="window.close()">Close Window</button>
<script>
  if (window.opener) {
    window.opener.postMessage({ type: 'oauth-callback', success: ${success} }, '*');
  }
</script>
</body></html>`;
}
