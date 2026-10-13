import { describe, expect, it, vi } from 'vitest';
import { PROBE_MAX_BUFFER, runProbe } from './probe.js';

/**
 * The probe child is this node, running a one-line script: one process, so a
 * SIGKILL at the timeout leaves nothing behind. No backend binary runs.
 */
const node = process.execPath;
const script = (source: string) => ['-e', source];
const CANARY = 'synthetic-canary-3e9a71';
const env = { SYNTHETIC_PROBE: '1' };

describe('runProbe', () => {
  it('returns stdout when the child succeeds', async () => {
    const result = await runProbe(node, script('process.stdout.write(\'[{"name":"x"}]\')'), {
      env,
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ ok: true, stdout: '[{"name":"x"}]' });
  });

  it('hands the child the env it is given, and nothing from this process', async () => {
    vi.stubEnv('SYNTHETIC_RUNNER_ONLY', 'synthetic-runner-value');
    try {
      const result = await runProbe(
        node,
        script('process.stdout.write(JSON.stringify(Object.keys(process.env)))'),
        { env, timeoutMs: 10_000 }
      );
      // The OS may add its own (macOS sets __CF_USER_TEXT_ENCODING), so this
      // checks what crosses from here, not an exact key list.
      const keys: string[] = result.ok ? JSON.parse(result.stdout) : [];
      expect(keys).toContain('SYNTHETIC_PROBE');
      expect(keys).not.toContain('SYNTHETIC_RUNNER_ONLY');
      expect(keys).not.toContain('PATH');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reports a non-zero exit by code, and nothing the child printed', async () => {
    const result = await runProbe(
      node,
      script(
        `process.stdout.write('${CANARY}'); process.stderr.write('${CANARY}'); process.exit(1)`
      ),
      { env, timeoutMs: 10_000 }
    );
    expect(result).toEqual({ ok: false, failure: { kind: 'exit', exitCode: 1 } });
    expect(JSON.stringify(result)).not.toContain(CANARY);
  });

  it('kills a child that outlives its budget, and reports a timeout', async () => {
    const started = Date.now();
    const result = await runProbe(node, script('setInterval(() => {}, 1000)'), {
      env,
      timeoutMs: 300,
    });
    expect(result).toEqual({ ok: false, failure: { kind: 'timeout' } });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('ends on abort, and reports it', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await runProbe(node, script('setInterval(() => {}, 1000)'), {
      env,
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ ok: false, failure: { kind: 'aborted' } });
  });

  it('refuses output past its buffer as overflow', async () => {
    const result = await runProbe(
      node,
      script(`process.stdout.write('x'.repeat(${PROBE_MAX_BUFFER + 1}))`),
      { env, timeoutMs: 10_000 }
    );
    expect(result).toEqual({ ok: false, failure: { kind: 'overflow' } });
  });

  it('reports a child ended by a signal it did not get from the probe', async () => {
    const result = await runProbe(
      node,
      script("process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000)"),
      { env, timeoutMs: 10_000 }
    );
    expect(result).toEqual({ ok: false, failure: { kind: 'signal', signal: 'SIGTERM' } });
  });

  it('reports a binary that cannot start by its errno code', async () => {
    const result = await runProbe('/synthetic/no-such-binary', [], { env, timeoutMs: 10_000 });
    expect(result).toEqual({ ok: false, failure: { kind: 'spawn', code: 'ENOENT' } });
  });

  it('starts nothing with no time left, or an abort already signalled', async () => {
    // A binary that cannot start: had either run, the result would be spawn.
    const aborted = new AbortController();
    aborted.abort();
    expect(await runProbe('/synthetic/no-such-binary', [], { env, timeoutMs: 0 })).toEqual({
      ok: false,
      failure: { kind: 'no-time' },
    });
    expect(
      await runProbe('/synthetic/no-such-binary', [], {
        env,
        signal: aborted.signal,
        timeoutMs: 10_000,
      })
    ).toEqual({ ok: false, failure: { kind: 'aborted' } });
  });
});
