import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalCoordinator,
  concurrencyForAdapter,
  type ApprovalTicket,
} from './approval-coordinator.js';

function ticket(tool: string, extra: Partial<ApprovalTicket> = {}): ApprovalTicket {
  return {
    tool,
    args: {},
    reason: 'because',
    origin: { origin: 'parent' },
    ...extra,
  };
}

/** A prompt whose resolution the test controls, one deferred per call. */
function controllablePrompt() {
  const calls: Array<{
    ticket: ApprovalTicket;
    queuedNow: () => number;
    resolve: (v: boolean) => void;
    reject: (e: unknown) => void;
  }> = [];
  const prompt = (t: ApprovalTicket, ctx: { queuedNow: () => number }) =>
    new Promise<boolean>((resolve, reject) => {
      calls.push({ ticket: t, queuedNow: ctx.queuedNow, resolve, reject });
    });
  return { prompt, calls };
}

/** Let queued microtasks drain so the pump reaches a steady state. */
const settle = () => new Promise<void>((r) => setTimeout(r, 0));

describe('ApprovalCoordinator', () => {
  describe('serial adapters (single input slot)', () => {
    it('runs one prompt at a time and preserves FIFO order', async () => {
      const { prompt, calls } = controllablePrompt();
      const coordinator = new ApprovalCoordinator({ concurrency: 1, prompt });

      const a = coordinator.request(ticket('read'));
      const b = coordinator.request(ticket('grep'));
      const c = coordinator.request(ticket('find'));
      await settle();

      // Only the first is prompting — the other two are still queued, which is
      // the whole point: a second concurrent Ink prompt orphans the first.
      expect(calls).toHaveLength(1);
      expect(calls[0].ticket.tool).toBe('read');
      expect(coordinator.queueDepth).toBe(2);

      calls[0].resolve(true);
      await expect(a).resolves.toEqual({ approved: true, reason: 'granted' });
      await settle();

      expect(calls).toHaveLength(2);
      expect(calls[1].ticket.tool).toBe('grep');
      calls[1].resolve(false);
      await expect(b).resolves.toEqual({ approved: false, reason: 'denied' });
      await settle();

      expect(calls[2].ticket.tool).toBe('find');
      calls[2].resolve(true);
      await expect(c).resolves.toEqual({ approved: true, reason: 'granted' });
    });

    it('reports the live waiting count, including arrivals after the prompt opened', async () => {
      const { prompt, calls } = controllablePrompt();
      const depths: number[] = [];
      const coordinator = new ApprovalCoordinator({
        concurrency: 1,
        prompt,
        onQueueDepth: (d) => depths.push(d),
      });

      void coordinator.request(ticket('read'));
      await settle();

      // The first request is prompting with nobody behind it...
      expect(calls[0].queuedNow()).toBe(0);

      void coordinator.request(ticket('grep'));
      void coordinator.request(ticket('find'));

      // ...and the same prompt now sees the two that arrived while it waited.
      // A depth captured at prompt-start would still say 0 here.
      expect(calls[0].queuedNow()).toBe(2);
      expect(depths.at(-1)).toBe(2);
    });

    it('does not let a thrown prompt poison the queue tail', async () => {
      const { prompt, calls } = controllablePrompt();
      const coordinator = new ApprovalCoordinator({ concurrency: 1, prompt });

      const a = coordinator.request(ticket('read'));
      const b = coordinator.request(ticket('grep'));
      await settle();

      calls[0].reject(new Error('renderer exploded'));
      const outcomeA = await a;
      expect(outcomeA.approved).toBe(false);
      expect(outcomeA.reason).toBe('error');
      await settle();

      // The slot came back — the second ticket is prompting, not stranded.
      expect(calls).toHaveLength(2);
      calls[1].resolve(true);
      await expect(b).resolves.toEqual({ approved: true, reason: 'granted' });
    });
  });

  describe('correlated adapters (JSONL / 2FA)', () => {
    it('runs every request concurrently', async () => {
      const { prompt, calls } = controllablePrompt();
      const coordinator = new ApprovalCoordinator({
        concurrency: concurrencyForAdapter('correlated'),
        prompt,
      });

      const results = Promise.all([
        coordinator.request(ticket('read')),
        coordinator.request(ticket('grep')),
        coordinator.request(ticket('find')),
      ]);
      await settle();

      expect(calls).toHaveLength(3);
      expect(coordinator.queueDepth).toBe(0);

      // Respond out of order — id correlation, not arrival order, decides.
      calls[2].resolve(true);
      calls[0].resolve(false);
      calls[1].resolve(true);

      await expect(results).resolves.toEqual([
        { approved: false, reason: 'denied' },
        { approved: true, reason: 'granted' },
        { approved: true, reason: 'granted' },
      ]);
    });
  });

  describe('re-checking authority at the front of the queue', () => {
    it("skips the prompt when a sibling's decision already allowed the tool", async () => {
      const { prompt, calls } = controllablePrompt();
      const allowed = new Set<string>();
      const coordinator = new ApprovalCoordinator({
        concurrency: 1,
        prompt,
        recheck: (t) => (allowed.has(t.tool) ? 'allow' : 'prompt'),
      });

      const a = coordinator.request(ticket('read'));
      const b = coordinator.request(ticket('read'));
      await settle();

      expect(calls).toHaveLength(1);
      // Clone A answers "session" — policy now covers clone B's queued request.
      allowed.add('read');
      calls[0].resolve(true);

      await expect(a).resolves.toEqual({ approved: true, reason: 'granted' });
      await expect(b).resolves.toEqual({ approved: true, reason: 'policy-allow' });
      // B was never asked.
      expect(calls).toHaveLength(1);
    });

    it("skips the prompt when a sibling's decision already denied the tool", async () => {
      const { prompt, calls } = controllablePrompt();
      const denied = new Set<string>();
      const coordinator = new ApprovalCoordinator({
        concurrency: 1,
        prompt,
        recheck: (t) => (denied.has(t.tool) ? 'deny' : 'prompt'),
      });

      const a = coordinator.request(ticket('bash'));
      const b = coordinator.request(ticket('bash'));
      await settle();

      denied.add('bash');
      calls[0].resolve(false);

      await expect(a).resolves.toEqual({ approved: false, reason: 'denied' });
      await expect(b).resolves.toEqual({ approved: false, reason: 'policy-deny' });
      expect(calls).toHaveLength(1);
    });

    it('re-checks only at the front, not at enqueue time', async () => {
      const recheck = vi.fn(() => 'prompt' as const);
      const { prompt, calls } = controllablePrompt();
      const coordinator = new ApprovalCoordinator({ concurrency: 1, prompt, recheck });

      void coordinator.request(ticket('read'));
      void coordinator.request(ticket('grep'));
      await settle();

      // The queued ticket has not been evaluated yet — its answer may change.
      expect(recheck).toHaveBeenCalledTimes(1);
      calls[0].resolve(true);
      await settle();
      expect(recheck).toHaveBeenCalledTimes(2);
    });
  });

  describe('cancellation', () => {
    it('settles an already-aborted request without prompting', async () => {
      const { prompt, calls } = controllablePrompt();
      const coordinator = new ApprovalCoordinator({ concurrency: 1, prompt });

      const controller = new AbortController();
      controller.abort();

      await expect(
        coordinator.request(ticket('read', { signal: controller.signal }))
      ).resolves.toEqual({ approved: false, reason: 'aborted' });
      expect(calls).toHaveLength(0);
    });

    it('removes a queued request when its signal fires, without stalling the queue', async () => {
      const { prompt, calls } = controllablePrompt();
      const coordinator = new ApprovalCoordinator({ concurrency: 1, prompt });

      const controller = new AbortController();
      const a = coordinator.request(ticket('read'));
      const cancelled = coordinator.request(ticket('grep', { signal: controller.signal }));
      const c = coordinator.request(ticket('find'));
      await settle();

      controller.abort();
      await expect(cancelled).resolves.toEqual({ approved: false, reason: 'aborted' });
      expect(coordinator.queueDepth).toBe(1);

      calls[0].resolve(true);
      await expect(a).resolves.toEqual({ approved: true, reason: 'granted' });
      await settle();

      // The tail advanced straight past the dead ticket.
      expect(calls).toHaveLength(2);
      expect(calls[1].ticket.tool).toBe('find');
      calls[1].resolve(true);
      await expect(c).resolves.toEqual({ approved: true, reason: 'granted' });
    });

    it('settles an in-flight prompt as aborted when the signal fires', async () => {
      // The real Ink adapter rejects its input wait on abort; this stands in.
      const coordinator = new ApprovalCoordinator({
        concurrency: 1,
        prompt: (t) =>
          new Promise<boolean>((_resolve, reject) => {
            t.signal?.addEventListener('abort', () => {
              const err = new Error('Input aborted');
              err.name = 'InkInputAborted';
              reject(err);
            });
          }),
      });

      const controller = new AbortController();
      const pending = coordinator.request(ticket('read', { signal: controller.signal }));
      await settle();

      controller.abort();
      // Aborted, not 'error' — a cancelled turn is not a failure.
      await expect(pending).resolves.toEqual({ approved: false, reason: 'aborted' });
    });

    it('drains everything on dispose', async () => {
      const { prompt } = controllablePrompt();
      const coordinator = new ApprovalCoordinator({ concurrency: 1, prompt });

      const a = coordinator.request(ticket('read'));
      const b = coordinator.request(ticket('grep'));
      await settle();

      coordinator.dispose();
      await expect(b).resolves.toEqual({ approved: false, reason: 'aborted' });
      expect(coordinator.queueDepth).toBe(0);

      // A request arriving after dispose is refused rather than queued forever.
      await expect(coordinator.request(ticket('find'))).resolves.toEqual({
        approved: false,
        reason: 'aborted',
      });
      void a;
    });
  });

  describe('origin metadata', () => {
    it('carries clone identity through to the prompt', async () => {
      const { prompt, calls } = controllablePrompt();
      const coordinator = new ApprovalCoordinator({ concurrency: 1, prompt });

      void coordinator.request(
        ticket('read', {
          origin: { origin: 'clone', cloneId: 'c-1', cloneLabel: 'audit auth paths' },
        })
      );
      await settle();

      expect(calls[0].ticket.origin).toEqual({
        origin: 'clone',
        cloneId: 'c-1',
        cloneLabel: 'audit auth paths',
      });
    });
  });

  it('maps adapter kinds to their sustainable concurrency', () => {
    expect(concurrencyForAdapter('interactive')).toBe(1);
    expect(concurrencyForAdapter('correlated')).toBe(Number.POSITIVE_INFINITY);
  });
});
