// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.hoisted(() => vi.fn());
vi.mock('./state', () => ({ panelRequest: request }));
const changed = vi.fn();
const permission = vi.fn();
const originInput = () => document.getElementById('origin') as HTMLInputElement;
beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = `<input id="origin" value="http://localhost:3002">
    <div id="status"></div><section id="capture"></section><pre id="preview"></pre>
    <p id="privacy"></p><section id="confirmation"></section><div id="changes"></div>
    <input id="whole-page-consent" type="checkbox"><textarea id="proposal-json"></textarea>
    <button id="selection"></button><button id="page"></button><button id="share"></button>
    <button id="import"></button><button id="apply"></button><button id="clear"></button>`;
  request.mockReset().mockResolvedValue({ dashboardOrigin: 'http://localhost:4102' });
  changed.mockReset();
  permission.mockReset().mockResolvedValue(true);
  vi.stubGlobal('chrome', {
    storage: { onChanged: { addListener: changed } },
    permissions: { request: permission },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});
describe('sidepanel asynchronous refresh', () => {
  it('restores a saved origin while pristine, but never overwrites a user edit', async () => {
    await import('./entrypoints/sidepanel/main');
    await vi.waitFor(() => expect(originInput().value).toBe('http://localhost:4102'));
    originInput().value = 'http://localhost:49322';
    originInput().dispatchEvent(new Event('input'));
    expect(changed).toHaveBeenCalledTimes(1);
    changed.mock.calls[0]![0]({}, 'session');
    await Promise.resolve();
    expect(originInput().value).toBe('http://localhost:49322');
    document.getElementById('share')!.click();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        type: 'share',
        origin: 'http://localhost:49322',
        snapshotId: undefined,
      })
    );
  });
  it('keeps actions disabled until the final refresh finishes', async () => {
    await import('./entrypoints/sidepanel/main');
    await vi.waitFor(() => expect(originInput().value).toBe('http://localhost:4102'));
    let finish!: (value: unknown) => void;
    request.mockImplementation((m: { type: string }) =>
      m.type === 'state'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({})
    );
    const button = document.getElementById('selection') as HTMLButtonElement;
    button.click();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(button.disabled).toBe(true);
    finish({ dashboardOrigin: 'http://localhost:4102' });
    await vi.waitFor(() => expect(button.disabled).toBe(false));
  });
});
