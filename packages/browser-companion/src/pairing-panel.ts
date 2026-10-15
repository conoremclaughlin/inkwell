import { dashboardOrigin, dashboardPermission } from './protocol';
import { panelRequest } from './state';
import type { PairingView } from './pairing';

/** Worker replies are redacted; no credential is rendered or forwarded by this UI.
 * Disconnect bypasses the busy action. */
export function mountPairingPanel() {
  const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  let current: PairingView = { phase: 'unpaired' };
  let busy = false;
  let revision = 0;
  let stopped = 0;
  function render() {
    el<HTMLButtonElement>('pair-open').disabled =
      busy ||
      !!current.storageUnavailable ||
      !['unpaired', 'ready', 'disconnected'].includes(current.phase) ||
      (current.phase === 'disconnected' &&
        current.revocation !== 'confirmed' &&
        current.cleanup !== 'missing-receipt');
    el<HTMLButtonElement>('pair-claim').disabled =
      busy || !!current.storageUnavailable || current.phase !== 'ready';
    el<HTMLInputElement>('pair-code').disabled =
      busy || !!current.storageUnavailable || current.phase !== 'ready';
    el<HTMLButtonElement>('pair-disconnect').disabled = !busy && current.phase === 'unpaired';
    el<HTMLButtonElement>('pair-retry').disabled = busy || current.cleanup !== 'revocation';
    el('pair-retry').hidden = current.cleanup !== 'revocation';
    const pending =
      current.cleanup === 'awaiting-receipt'
        ? 'Disconnected locally. Waiting for the claim to finish; a late receipt will trigger revocation. No new pairing can start while this request is pending.'
        : current.cleanup === 'missing-receipt'
          ? 'Disconnected locally. The pairing receipt is missing, so remote revocation cannot be confirmed.' +
            (current.storageUnavailable ? '' : ' You can start a new pairing.') +
            ' Any previous server grant must expire; starting again does not revoke it.'
          : current.cleanup === 'revocation'
            ? 'Disconnected locally. Remote revocation is not confirmed. Retry remote revocation to finish disconnecting.'
            : 'Disconnected locally. Remote revocation is not confirmed. Check pairing status before starting again.';
    const messages: Record<PairingView['phase'], string> = {
      unpaired: 'Not paired. Start in Inkwell, then enter the code here.',
      ready: 'Waiting for your approval in Inkwell. No page access is granted.',
      claiming: 'Waiting for a pairing receipt. You can disconnect now.',
      unknown:
        'Pairing outcome unknown. Do not try the code again. Disconnect before starting a new pairing. Without the missing receipt, any previous server grant cannot be revoked here and must expire.',
      paired:
        'Pairing receipt received. Hosted chat is not enabled in this checkpoint; no page authority was granted.',
      disconnected:
        current.revocation === 'confirmed'
          ? current.storageUnavailable
            ? 'Disconnected. No revocation is pending.'
            : 'Disconnected. You can start a new pairing.'
          : pending,
    };
    el('pair-status').textContent =
      messages[current.phase] +
      (current.storageUnavailable
        ? ' Session storage is unavailable. New pairing is disabled. Local state may be stale after an extension restart.'
        : '');
    el('pair-origin').textContent = current.origin ? `Pairing destination: ${current.origin}` : '';
  }
  async function refresh() {
    const version = ++revision;
    try {
      const next = await panelRequest<PairingView>({ type: 'pair:status' });
      if (version !== revision) return;
      current = next;
      render();
    } catch {
      el('pair-status').textContent = 'Pairing unavailable. No connection is confirmed.';
    }
  }
  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    busy = true;
    const generation = stopped;
    render();
    let failure: string | undefined;
    try {
      await action();
    } catch (error) {
      failure = error instanceof Error ? error.message : 'Pairing unavailable.';
    } finally {
      busy = false;
      await refresh();
      if (failure && generation === stopped) el('pair-status').textContent = failure;
      renderButtons();
    }
  }
  // Keep a failed operation's explanation while updating button state.
  function renderButtons() {
    const message = el('pair-status').textContent;
    render();
    el('pair-status').textContent = message;
  }
  el('pair-open').onclick = () => {
    if (busy) return;
    let origin: string;
    try {
      origin = dashboardOrigin(el<HTMLInputElement>('origin').value);
    } catch {
      el('pair-status').textContent = 'Enter a valid HTTPS dashboard origin, or a local web port.';
      return;
    }
    // Host permission is requested directly from the click, not after a worker round trip.
    const permission = chrome.permissions.request({ origins: [dashboardPermission(origin)] });
    const generation = stopped;
    void run(async () => {
      if (!(await permission)) throw new Error('Dashboard access was not granted.');
      if (generation !== stopped) return;
      await panelRequest({ type: 'pair:prepare', origin });
    });
  };
  el('pair-claim').onclick = () => {
    const code = el<HTMLInputElement>('pair-code').value;
    el<HTMLInputElement>('pair-code').value = '';
    void run(() => panelRequest({ type: 'pair:claim', code }));
  };
  el('pair-disconnect').onclick = () => {
    ++stopped;
    ++revision;
    el<HTMLInputElement>('pair-code').value = '';
    el('pair-status').textContent = 'Stopping pairing locally…';
    // Deliberately not run(): it must bypass a pending permission/claim wait.
    void panelRequest({ type: 'pair:disconnect' }).then(refresh, () => {
      el('pair-status').textContent =
        'Disconnect was not confirmed. Try Disconnect again. Closing this panel does not revoke a server grant.';
    });
  };
  el('pair-retry').onclick = () => void run(() => panelRequest({ type: 'pair:retry-revocation' }));
  chrome.storage.onChanged.addListener((_changes, area) => {
    if (area === 'session') void refresh();
  });
  render();
  void refresh();
}
