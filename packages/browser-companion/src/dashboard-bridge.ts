import type { BrowserSnapshot } from './protocol';

/** Serialized by chrome.scripting: deliberately self-contained.
 * Only the approved snapshot goes to this origin. Page messages can propose,
 * NEVER capture another page, read credentials, send inkmail, or apply a fill.
 */
export function connectDashboard(
  snapshot: BrowserSnapshot,
  bridgeId: string,
  expectedUrl: string
): boolean {
  // tabs.get and executeScript are not atomic. Check again inside the actual
  // destination document before exposing any snapshot to its page scripts.
  if (location.href !== expectedUrl) return false;
  const host = globalThis as typeof globalThis & { __inkwellBridgeCleanup?: () => void };
  host.__inkwellBridgeCleanup?.();
  const origin = location.origin;
  let active = true;
  const receipt = (result: unknown) => {
    if (active && location.href === expectedUrl)
      window.postMessage({ type: 'inkwell:proposal-receipt', bridgeId, result }, origin);
  };
  let offered = false;
  const offer = () => {
    if (!offered && location.href === expectedUrl)
      window.postMessage({ type: 'inkwell:offer', bridgeId, snapshot }, origin);
  };
  const handler = (event: MessageEvent) => {
    if (
      location.href !== expectedUrl ||
      event.source !== window ||
      event.origin !== origin ||
      event.data?.bridgeId !== bridgeId
    )
      return;
    if (event.data.type === 'inkwell:received') offered = true;
    if (event.data.type === 'inkwell:propose') {
      void chrome.runtime
        .sendMessage({ type: 'bridge:proposal', bridgeId, proposal: event.data.proposal })
        .then(receipt)
        .catch(() => receipt({ ok: false, error: 'Extension unavailable. Reopen its panel.' }));
    }
  };
  window.addEventListener('message', handler);
  const interval = setInterval(offer, 1000);
  const timeout = setTimeout(() => cleanup(), 10 * 60 * 1000);
  function cleanup() {
    active = false;
    clearInterval(interval);
    clearTimeout(timeout);
    window.removeEventListener('message', handler);
  }
  host.__inkwellBridgeCleanup = cleanup;
  offer();
  return true;
}
