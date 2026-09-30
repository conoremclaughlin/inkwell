// Harmless standalone protocol fixture. No model/tools/network/auth. Writes
// only the explicit temp-directory pid file supplied by its test parent.
const fs = require('node:fs');
const readline = require('node:readline');
const pidPath = process.argv[2];
if (pidPath) fs.writeFileSync(pidPath, String(process.pid));
// Finite self-exit also cleans the helper-disabled negative control.
setTimeout(() => process.exit(0), 10000);
const send = (v) => process.stdout.write(JSON.stringify(v) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'fixture/exit') process.exit(0);
  if (request.method === 'fixture/approval') {
    send({
      id: 77,
      method: 'item/commandExecution/requestApproval',
      params: { threadId: 'fixture-thread' },
    });
  }
  if (request.id === 77 && !request.method) {
    send({ method: 'fixture/approvalResult', params: request.result });
    return;
  }
  if (request.id !== undefined)
    send({
      id: request.id,
      result:
        request.method === 'thread/start' || request.method === 'thread/resume'
          ? {
              thread: {
                id: request.params?.ephemeral ? 'fixture-title' : 'fixture-thread',
                ephemeral: request.params?.ephemeral ?? false,
              },
              received: request.params,
            }
          : { received: request.params },
    });
});
