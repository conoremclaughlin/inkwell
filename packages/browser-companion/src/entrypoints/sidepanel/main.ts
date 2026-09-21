import './style.css';
import { dashboardOrigin, dashboardPermission, privacySignals } from '../../protocol';
import { panelRequest, type CompanionState } from '../../state';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let state: CompanionState = {};
let busy = false;
const status = (text: string) => {
  element('status').textContent = text;
};

async function refresh() {
  state = await panelRequest<CompanionState>({ type: 'state' });
  element('capture').hidden = !state.snapshot;
  element('preview').textContent = state.snapshot ? JSON.stringify(state.snapshot, null, 2) : '';
  element('privacy').textContent = state.snapshot ? privacySignals(state.snapshot) : '';
  if (state.dashboardOrigin) element<HTMLInputElement>('origin').value = state.dashboardOrigin;
  element('confirmation').hidden = !state.proposal;
  const changes = element('changes');
  changes.replaceChildren();
  for (const change of state.proposal?.changes || []) {
    const row = document.createElement('div');
    row.className = 'change';
    const heading = document.createElement('strong');
    heading.textContent =
      state.snapshot?.fields.find((f) => f.id === change.fieldId)?.label || change.fieldId;
    const value = document.createElement('pre');
    value.textContent = change.value;
    row.append(heading, value);
    changes.append(row);
  }
}

async function run(action: () => Promise<unknown>) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach((button) => {
    button.disabled = true;
  });
  try {
    const result = await action();
    status(typeof result === 'string' ? result : 'Done.');
  } catch (error) {
    status(error instanceof Error ? error.message : 'Operation failed.');
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach((button) => {
      button.disabled = false;
    });
    await refresh().catch(() => status('Extension unavailable. Reopen the panel.'));
  }
}
element('selection').onclick = () =>
  void run(() => panelRequest({ type: 'capture', mode: 'selection' }));
element('page').onclick = () =>
  void run(() => {
    if (!element<HTMLInputElement>('whole-page-consent').checked)
      throw new Error(
        'Confirm that you want a whole-page capture, or select a shorter excerpt instead.'
      );
    element<HTMLInputElement>('whole-page-consent').checked = false;
    return panelRequest({ type: 'capture', mode: 'page' });
  });
element('share').onclick = () => {
  if (busy) return;
  // permissions.request must be called directly in the user gesture.
  let origin: string;
  try {
    origin = dashboardOrigin(element<HTMLInputElement>('origin').value);
  } catch (error) {
    status((error as Error).message);
    return;
  }
  const snapshotId = state.snapshot?.id;
  const permission = chrome.permissions.request({ origins: [dashboardPermission(origin)] });
  void run(async () => {
    status('Waiting for dashboard permission. Check the browser permission prompt.');
    if (!(await permission)) throw new Error('Dashboard access was not granted. Nothing shared.');
    return panelRequest({ type: 'share', origin, snapshotId });
  });
};
element('import').onclick = () =>
  void run(() =>
    panelRequest({
      type: 'proposal',
      snapshotId: state.snapshot?.id,
      proposal: JSON.parse(element<HTMLTextAreaElement>('proposal-json').value),
    })
  );
element('apply').onclick = () => {
  const proposal = state.proposal;
  const snapshotId = state.snapshot?.id;
  void run(async () => {
    const result = await panelRequest<{ applied: number }>({ type: 'apply', snapshotId, proposal });
    return `Applied ${result.applied} field(s). Inspect the page; submitting remains your decision.`;
  });
};
element('clear').onclick = () =>
  void run(async () => {
    await panelRequest({ type: 'clear' });
    element<HTMLTextAreaElement>('proposal-json').value = '';
    return 'Capture forgotten in the extension. Previously shared thread messages remain in Inkwell.';
  });
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'session' && !busy) void refresh();
});
void refresh().catch(() => status('Click the extension icon on your source page to begin.'));
