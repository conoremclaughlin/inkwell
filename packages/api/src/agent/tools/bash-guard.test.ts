import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  analyzeCommand,
  ProcessRegistry,
  extractBackgroundPids,
  guardBashCommand,
  getProcessRegistry,
  resetProcessRegistry,
} from './bash-guard';

vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('Bash Guard', () => {
  describe('analyzeCommand', () => {
    describe('fork bombs', () => {
      it('blocks classic fork bomb', () => {
        const result = analyzeCommand(':(){ :|:& };:');
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain('fork bomb');
      });

      it('blocks named fork bomb', () => {
        const result = analyzeCommand('bomb(){ bomb|bomb& };bomb');
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain('fork bomb');
      });

      it('blocks fork bomb with spaces', () => {
        const result = analyzeCommand('x(){ x | x & };x');
        expect(result.blocked).toBe(true);
      });

      it('allows function definitions that are not fork bombs', () => {
        const result = analyzeCommand('greet(){ echo "hello"; }');
        expect(result.blocked).toBe(false);
      });
    });

    describe('recursive root delete', () => {
      it('blocks rm -rf /', () => {
        expect(analyzeCommand('rm -rf /').blocked).toBe(true);
        expect(analyzeCommand('rm -rf /').reason).toContain('recursive delete');
      });

      it('blocks rm -r -f /', () => {
        expect(analyzeCommand('rm -r -f /').blocked).toBe(true);
      });

      it('blocks rm --recursive /', () => {
        expect(analyzeCommand('rm --recursive /').blocked).toBe(true);
      });

      it('blocks rm -rf /*', () => {
        expect(analyzeCommand('rm -rf /*').blocked).toBe(true);
      });

      it('blocks sudo rm -rf /', () => {
        expect(analyzeCommand('sudo rm -rf /').blocked).toBe(true);
      });

      it('blocks rm -rf / after semicolon', () => {
        expect(analyzeCommand('echo hi; rm -rf /').blocked).toBe(true);
      });

      it('allows rm -rf /tmp/foo', () => {
        expect(analyzeCommand('rm -rf /tmp/foo').blocked).toBe(false);
      });

      it('allows rm without recursive flag', () => {
        expect(analyzeCommand('rm /tmp/file.txt').blocked).toBe(false);
      });

      it('allows rm -r on non-root paths', () => {
        expect(analyzeCommand('rm -r ./build').blocked).toBe(false);
      });
    });

    describe('dangerous patterns', () => {
      it('blocks mkfs', () => {
        expect(analyzeCommand('mkfs.ext4 /dev/sda1').blocked).toBe(true);
        expect(analyzeCommand('mkfs /dev/sda').blocked).toBe(true);
      });

      it('blocks dd to block devices', () => {
        expect(analyzeCommand('dd if=/dev/zero of=/dev/sda').blocked).toBe(true);
        expect(analyzeCommand('dd if=/dev/zero of=/dev/nvme0n1').blocked).toBe(true);
      });

      it('allows dd to regular files', () => {
        expect(analyzeCommand('dd if=/dev/zero of=/tmp/image.iso bs=1M count=100').blocked).toBe(
          false
        );
      });

      it('blocks shutdown', () => {
        expect(analyzeCommand('shutdown -h now').blocked).toBe(true);
        expect(analyzeCommand('shutdown').blocked).toBe(true);
      });

      it('blocks reboot', () => {
        expect(analyzeCommand('reboot').blocked).toBe(true);
      });

      it('blocks poweroff', () => {
        expect(analyzeCommand('poweroff').blocked).toBe(true);
      });

      it('blocks init 0 and init 6', () => {
        expect(analyzeCommand('init 0').blocked).toBe(true);
        expect(analyzeCommand('init 6').blocked).toBe(true);
      });

      it('allows init with other arguments', () => {
        expect(analyzeCommand('init 3').blocked).toBe(false);
      });

      it('blocks nsenter', () => {
        expect(analyzeCommand('nsenter --target 1 --mount').blocked).toBe(true);
      });
    });

    describe('kill commands', () => {
      it('detects kill as a kill command', () => {
        const result = analyzeCommand('kill 1234');
        expect(result.isKillCommand).toBe(true);
        expect(result.killPidTargets).toEqual([1234]);
      });

      it('extracts multiple PID targets', () => {
        const result = analyzeCommand('kill -9 1234 5678');
        expect(result.killPidTargets).toEqual([1234, 5678]);
      });

      it('blocks kill -1 (all processes)', () => {
        const result = analyzeCommand('kill -1');
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain('all processes');
      });

      it('blocks kill targeting PID 1', () => {
        const result = analyzeCommand('kill 1');
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain('PID 1');
      });

      it('blocks kill -9 1', () => {
        const result = analyzeCommand('kill -9 1');
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain('PID 1');
      });

      it('does not block kill of high PIDs', () => {
        const result = analyzeCommand('kill -9 12345');
        expect(result.blocked).toBe(false);
        expect(result.isKillCommand).toBe(true);
        expect(result.killPidTargets).toEqual([12345]);
      });

      it('handles kill after -- separator', () => {
        const result = analyzeCommand('kill -- 4567');
        expect(result.killPidTargets).toEqual([4567]);
      });

      it('blocks pkill (name-based, cannot verify ownership)', () => {
        const result = analyzeCommand('pkill -f node');
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain('pkill/killall');
      });

      it('blocks killall (name-based, cannot verify ownership)', () => {
        const result = analyzeCommand('killall node');
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain('pkill/killall');
      });

      it('handles multiple kill commands in one line', () => {
        const result = analyzeCommand('kill 100; kill 200');
        expect(result.killPidTargets).toContain(100);
        expect(result.killPidTargets).toContain(200);
      });

      it('blocks kill 0 (current process group)', () => {
        const result = analyzeCommand('kill 0');
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain('process group');
      });

      it('blocks kill with negative PID (process group target)', () => {
        const result = analyzeCommand('kill -- -1234');
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain('process group');
      });

      it('blocks kill $PPID (unresolvable variable target)', () => {
        const result = analyzeCommand('kill $PPID');
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain('variable/dynamic');
      });

      it('blocks kill $(cat /tmp/pid) (unresolvable command substitution)', () => {
        const result = analyzeCommand('kill $(cat /tmp/pid)');
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain('variable/dynamic');
      });

      it('blocks kill with backtick substitution', () => {
        const result = analyzeCommand('kill `pgrep node`');
        expect(result.blocked).toBe(true);
        expect(result.reason).toContain('variable/dynamic');
      });
    });

    describe('safe commands', () => {
      it('allows echo', () => {
        expect(analyzeCommand('echo hello').blocked).toBe(false);
        expect(analyzeCommand('echo hello').isKillCommand).toBe(false);
      });

      it('allows ls', () => {
        expect(analyzeCommand('ls -la').blocked).toBe(false);
      });

      it('allows cat', () => {
        expect(analyzeCommand('cat /etc/hostname').blocked).toBe(false);
      });

      it('allows git commands', () => {
        expect(analyzeCommand('git status').blocked).toBe(false);
        expect(analyzeCommand('git commit -m "fix"').blocked).toBe(false);
      });

      it('allows npm/yarn', () => {
        expect(analyzeCommand('npm install').blocked).toBe(false);
        expect(analyzeCommand('yarn build').blocked).toBe(false);
      });

      it('allows piped commands', () => {
        expect(analyzeCommand('ps aux | grep node').blocked).toBe(false);
      });

      it('allows compound commands', () => {
        expect(analyzeCommand('cd /tmp && ls -la').blocked).toBe(false);
      });
    });
  });

  describe('ProcessRegistry', () => {
    let registry: ProcessRegistry;

    beforeEach(() => {
      registry = new ProcessRegistry();
    });

    it('registers and retrieves PIDs', () => {
      registry.register('wren', 1234, 'sleep 100');
      expect(registry.has(1234)).toBe(true);
      expect(registry.isOwned('wren', 1234)).toBe(true);
      expect(registry.getOwner(1234)).toBe('wren');
    });

    it('tracks PIDs per agent', () => {
      registry.register('wren', 100, 'sleep 100');
      registry.register('wren', 200, 'node server.js');
      registry.register('lumen', 300, 'python main.py');

      expect(registry.getAgentPids('wren')).toEqual([100, 200]);
      expect(registry.getAgentPids('lumen')).toEqual([300]);
    });

    it('rejects ownership checks for wrong agent', () => {
      registry.register('wren', 1234, 'sleep 100');
      expect(registry.isOwned('lumen', 1234)).toBe(false);
    });

    it('removes entries', () => {
      registry.register('wren', 1234, 'sleep 100');
      registry.remove(1234);
      expect(registry.has(1234)).toBe(false);
      expect(registry.size).toBe(0);
    });

    it('clears all entries', () => {
      registry.register('wren', 100, 'a');
      registry.register('lumen', 200, 'b');
      registry.clear();
      expect(registry.size).toBe(0);
    });

    it('removes dead processes on cleanup', () => {
      // PID 99999999 almost certainly doesn't exist
      registry.register('wren', 99999999, 'ghost');
      expect(registry.size).toBe(1);
      registry.cleanup();
      expect(registry.size).toBe(0);
    });

    it('keeps alive processes on cleanup', () => {
      // Current process is alive
      registry.register('wren', process.pid, 'self');
      registry.cleanup();
      expect(registry.has(process.pid)).toBe(true);
    });

    it('removes expired entries on cleanup', () => {
      const shortTtl = new ProcessRegistry(1); // 1ms TTL
      shortTtl.register('wren', process.pid, 'self');

      // Wait for TTL to expire
      const start = Date.now();
      while (Date.now() - start < 5) {
        /* spin */
      }

      shortTtl.cleanup();
      expect(shortTtl.size).toBe(0);
    });
  });

  describe('extractBackgroundPids', () => {
    it('extracts PID from bash background output', () => {
      expect(extractBackgroundPids('[1] 12345')).toEqual([12345]);
    });

    it('extracts multiple PIDs', () => {
      const output = '[1] 12345\n[2] 67890';
      expect(extractBackgroundPids(output)).toEqual([12345, 67890]);
    });

    it('handles PIDs mixed with other output', () => {
      const output = 'Starting server...\n[1] 54321\nListening on port 3000';
      expect(extractBackgroundPids(output)).toEqual([54321]);
    });

    it('returns empty for no background PIDs', () => {
      expect(extractBackgroundPids('hello world')).toEqual([]);
      expect(extractBackgroundPids('')).toEqual([]);
    });

    it('handles job completion messages', () => {
      const output = '[1] 12345\n[1]+ Done sleep 1';
      expect(extractBackgroundPids(output)).toEqual([12345]);
    });
  });

  describe('guardBashCommand', () => {
    beforeEach(() => {
      resetProcessRegistry();
    });

    afterEach(() => {
      resetProcessRegistry();
    });

    describe('dangerous command blocking', () => {
      it('blocks fork bombs', () => {
        const result = guardBashCommand(':(){ :|:& };:', { agentId: 'wren' });
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('fork bomb');
      });

      it('blocks rm -rf /', () => {
        const result = guardBashCommand('rm -rf /', { agentId: 'wren' });
        expect(result.allowed).toBe(false);
      });

      it('allows safe commands', () => {
        const result = guardBashCommand('echo hello', { agentId: 'wren' });
        expect(result.allowed).toBe(true);
      });

      it('can be disabled', () => {
        const result = guardBashCommand(':(){ :|:& };:', {
          agentId: 'wren',
          blockDangerousCommands: false,
        });
        expect(result.allowed).toBe(true);
      });
    });

    describe('kill scope enforcement', () => {
      it('blocks kill targeting unregistered PIDs', () => {
        const result = guardBashCommand('kill 1234', { agentId: 'wren' });
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('not owned by this agent');
      });

      it('allows kill targeting own PIDs', () => {
        const registry = getProcessRegistry();
        registry.register('wren', 1234, 'sleep 100');

        const result = guardBashCommand('kill 1234', { agentId: 'wren' });
        expect(result.allowed).toBe(true);
      });

      it('blocks kill targeting another agent PIDs', () => {
        const registry = getProcessRegistry();
        registry.register('lumen', 1234, 'sleep 100');

        const result = guardBashCommand('kill 1234', { agentId: 'wren' });
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('1234');
      });

      it('allows kill with mixed PIDs when all are owned', () => {
        const registry = getProcessRegistry();
        registry.register('wren', 100, 'a');
        registry.register('wren', 200, 'b');

        const result = guardBashCommand('kill 100 200', { agentId: 'wren' });
        expect(result.allowed).toBe(true);
      });

      it('blocks when any target PID is not owned', () => {
        const registry = getProcessRegistry();
        registry.register('wren', 100, 'a');

        const result = guardBashCommand('kill 100 200', { agentId: 'wren' });
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('200');
      });

      it('blocks pkill (name-based, fail-closed)', () => {
        const result = guardBashCommand('pkill -f "old-server"', { agentId: 'wren' });
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('pkill/killall');
      });

      it('blocks kill with variable expansion', () => {
        const result = guardBashCommand('kill $PPID', { agentId: 'wren' });
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('variable/dynamic');
      });

      it('blocks kill 0 (process group)', () => {
        const result = guardBashCommand('kill 0', { agentId: 'wren' });
        expect(result.allowed).toBe(false);
        expect(result.reason).toContain('process group');
      });

      it('can be disabled', () => {
        const result = guardBashCommand('kill 1234', {
          agentId: 'wren',
          enforceKillScope: false,
        });
        expect(result.allowed).toBe(true);
      });
    });
  });
});
