/** Dedicated child guardian. The wrapper alone owns this process's stdin write
 * end. EOF (including wrapper SIGKILL) stops the child we spawned, not a cached
 * PID. Detached from the terminal so SIGHUP cannot strand the owner. No shell. */
import { spawn } from 'node:child_process';

const [binary, ...args] = process.argv.slice(2);
if (!binary) process.exit(2);
const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'inherit'] });
let stopping = false;
let killTimer: NodeJS.Timeout | undefined;
function stop() {
  if (stopping) return;
  stopping = true;
  child.stdin.end();
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 3000);
  }
}
process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
process.stdin.on('end', stop);
process.stdin.on('error', stop);
process.stdout.on('error', stop);
child.stdin.on('error', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('SIGHUP', stop);
child.on('error', () => process.exit(1));
child.on('close', (code) => {
  clearTimeout(killTimer);
  process.exit(stopping ? 0 : (code ?? 1));
});
