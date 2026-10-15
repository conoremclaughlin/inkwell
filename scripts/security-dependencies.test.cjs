// Exercise the packages reached by their actual consumers, not an unrelated
// hoisted copy. These are pure, bounded checks: no shell, sockets, credentials,
// server imports, or resource-exhaustion payloads.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const rootRequire = createRequire(path.join(root, 'package.json'));
const apiRequire = createRequire(path.join(root, 'packages/api/package.json'));
const mobileRequire = createRequire(path.join(root, 'packages/mobile/package.json'));
const webRequire = createRequire(path.join(root, 'packages/web/package.json'));

// GHSA-pqg4-j6r4-53mv. Only inspect quote()'s refusal; never execute its output.
for (const [consumer, requireFrom] of [
  ['concurrently', rootRequire],
  ['react-devtools-core', mobileRequire],
]) {
  test(`${consumer}: shell-quote rejects line terminators after comments`, () => {
    const consumerRequire = createRequire(requireFrom.resolve(consumer));
    const { quote } = consumerRequire('shell-quote');
    for (const newline of ['\n', '\r', '\u2028', '\u2029']) {
      assert.throws(
        () => quote(['echo', { comment: 'fixture' }, `before${newline}after`]),
        TypeError
      );
    }
    assert.equal(quote(['echo', 'two words']), "echo 'two words'");
  });
}

// GHSA-jqcg-44mw-7w3h. Documentation addresses only; no request is sent.
test('Express: mapped IPv6 trust does not trust arbitrary IPv4 clients', () => {
  const expressRequire = createRequire(apiRequire.resolve('express'));
  const proxyaddr = expressRequire('proxy-addr');
  assert.equal(proxyaddr.compile('::ffff:10.0.0.0/8')('192.0.2.1'), false);
  assert.equal(proxyaddr.compile('::/1')('192.0.2.1'), false);
  const intendedTrust = proxyaddr.compile('::ffff:10.0.0.0/104');
  assert.equal(intendedTrust('10.1.2.3'), true);
  assert.equal(intendedTrust('192.0.2.1'), false);
});

// GHSA-p8wg-vrv2-v86f. Test property lookup, not a code-execution payload.
test('ts-jest: Handlebars denies constructor lookup on function prototypes', () => {
  const tsJestRequire = createRequire(mobileRequire.resolve('ts-jest'));
  const handlebars = tsJestRequire('handlebars');
  const template = handlebars.compile('{{lookup target "constructor"}}');
  assert.equal(template({ target: Function.prototype }, { allowProtoMethodsByDefault: true }), '');
  assert.equal(handlebars.compile('Hello {{name}}')({ name: 'fixture' }), 'Hello fixture');
});

test('MCP client and server retain an in-memory tool round trip', { timeout: 5000 }, async () => {
  const { Client } = apiRequire('@modelcontextprotocol/client');
  const { McpServer, InMemoryTransport } = apiRequire('@modelcontextprotocol/server');
  const { z } = apiRequire('zod');
  const server = new McpServer({ name: 'fixture-server', version: '1.0.0' });
  const client = new Client({ name: 'fixture-client', version: '1.0.0' });
  server.registerTool(
    'echo',
    { inputSchema: z.object({ text: z.string() }).strict() },
    async ({ text }) => ({ content: [{ type: 'text', text }] })
  );
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ['echo']
    );
    assert.deepEqual(
      (await client.callTool({ name: 'echo', arguments: { text: 'fixture' } })).content,
      [{ type: 'text', text: 'fixture' }]
    );
    assert.equal(
      (await client.callTool({ name: 'echo', arguments: { unexpected: true } })).isError,
      true
    );
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

test('Next.js resolves sharp with a working native image pipeline', async () => {
  const nextRequire = createRequire(webRequire.resolve('next'));
  const sharp = nextRequire('sharp');
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } })
    .png()
    .toBuffer();
  const metadata = await sharp(png).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 2);
  assert.equal(metadata.height, 2);
});

test('Baileys resolves music-metadata with a working bounded WAV parser', async () => {
  const baileysRequire = createRequire(apiRequire.resolve('@whiskeysockets/baileys'));
  const { parseBuffer } = await import(
    pathToFileURL(baileysRequire.resolve('music-metadata')).href
  );
  // One mono 16-bit PCM sample. This is valid media, not a DoS fixture.
  const wav = Buffer.alloc(46);
  wav.write('RIFF');
  wav.writeUInt32LE(38, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24);
  wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(2, 40);
  const { format } = await parseBuffer(wav, { mimeType: 'audio/wav', size: wav.length });
  assert.equal(format.sampleRate, 8000);
  assert.equal(format.numberOfChannels, 1);
});
