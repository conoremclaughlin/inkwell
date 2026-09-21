import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { PageSession } from '../page-session';

export default defineUnlistedScript(() => {
  // This property belongs to the extension's isolated world, not page JS.
  const host = globalThis as typeof globalThis & { __inkwellPageSession?: PageSession };
  if (host.__inkwellPageSession) return;
  const session = new PageSession();
  host.__inkwellPageSession = session;
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    try {
      if (message?.type === 'page:capture' && ['selection', 'page'].includes(message.mode)) {
        respond({ ok: true, value: session.capture(message.mode) });
      } else if (message?.type === 'page:apply') {
        respond({ ok: true, value: session.apply(message.proposal) });
      }
    } catch (error) {
      respond({
        ok: false,
        error: error instanceof Error ? error.message : 'Page operation failed.',
      });
    }
  });
});
