// Bounded config-only protocol peer. Writes only its explicit temp evidence file.
const fs = require('node:fs');
const readline = require('node:readline');
const [path, mode] = process.argv.slice(2);
fs.writeFileSync(path, JSON.stringify({ pid: process.pid, bridge: process.env.INK_CODEX_INKMAIL }) + '\n');
const timeout = setTimeout(() => process.exit(0), 15000);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  fs.appendFileSync(path, JSON.stringify({ method: request.method, params: request.params }) + '\n');
  if (request.id === undefined) return;
  if (mode === 'exit') process.exit(1);
  if (mode === 'error') {
    process.stdout.write(JSON.stringify({ id: request.id, error: { message: 'SYNTHETIC_PRIVATE_VALUE' } }) + '\n');
    return;
  }
  if (mode === 'hang') return;
  if (mode === 'collision') {
    process.stdout.write(JSON.stringify({ id: request.id, method: 'fixture/request', params: {} }) + '\n');
  }
  const result = request.method === 'config/read'
    ? { config: { features: { hooks: true } }, layers: [{ name: { type: 'sessionFlags' }, config: { hooks: {} } }] }
    : request.method === 'hooks/list' ? { data: [{ hooks: [], errors: [] }] } : {};
  process.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
});
process.stdin.on('end', () => { clearTimeout(timeout); process.exit(0); });
