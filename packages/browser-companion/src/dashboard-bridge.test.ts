// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectDashboard } from './dashboard-bridge';
import type { BrowserSnapshot } from './protocol';

const snapshot: BrowserSnapshot = {
  version: 1,
  id: '00000000-0000-4000-8000-000000000001',
  capturedAt: Date.now(),
  url: 'https://fixture.test/form',
  title: 'Synthetic',
  mode: 'page',
  text: 'Private fixture',
  truncated: false,
  fields: [],
};
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('serialized dashboard bridge destination revalidation', () => {
  it('exposes no snapshot if the tab navigated between lookup and injection', () => {
    const post = vi.spyOn(window, 'postMessage');
    expect(
      connectDashboard(snapshot, 'fixture-bridge', 'https://different.test/browser-companion')
    ).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });
  it('offers only at the checked document URL and expires its listener', () => {
    vi.useFakeTimers();
    const post = vi.spyOn(window, 'postMessage');
    expect(connectDashboard(snapshot, 'fixture-bridge', location.href)).toBe(true);
    expect(post).toHaveBeenCalledWith(
      { type: 'inkwell:offer', bridgeId: 'fixture-bridge', snapshot },
      location.origin
    );
    vi.advanceTimersByTime(600_001);
    const count = post.mock.calls.length;
    vi.advanceTimersByTime(2000);
    expect(post).toHaveBeenCalledTimes(count);
  });
});
