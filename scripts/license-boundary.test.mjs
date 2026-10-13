/**
 * Read-only notice and grant checks. These do not interpret legal terms, prove
 * copyright provenance, or audit built tarballs or third-party dependencies.
 * No application modules, configuration, credentials, or services are loaded.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = (path) => JSON.parse(read(`${path}/package.json`));
const server = read('packages/api/LICENSE');
const root = read('LICENSE');
const mit = root.slice(root.indexOf('MIT License\n'));

test('the original server future MIT grant remains byte-for-byte unchanged', () => {
  const marker = '## Grant of Future License\n';
  assert.equal(server.split(marker).length, 2, 'exactly one future grant');
  const future = server.slice(server.indexOf(marker));
  // SHA-256 of the grant at 5742d266, before adding the Inkwell extension.
  // Changing this pin requires deliberate review of the future-license promise.
  assert.equal(
    createHash('sha256').update(future).digest('hex'),
    'fd91fa9de3dde04d8d75a6b24fe431a7ad0aeb6070e4b222b0fc8039b4f3d4d3'
  );
});

test('the extension is identified as modified and connected to the grant', () => {
  assert.match(server, /extension of the Functional Source License, Version 1\.1/);
  assert.match(server, /not the unmodified FSL-1\.1-MIT license/);
  assert.match(server, /LicenseRef-Inkwell-Server-1\.0/);
  assert.match(
    server,
    /A Permitted Purpose is any purpose other than a Competing Use or a Restricted\nCommercial Use/
  );
  assert.match(server, /### Additional Provisions \(Inkwell Extension\)/);
});

test('root and API metadata point to scoped license texts', () => {
  assert.equal(JSON.parse(read('package.json')).license, 'SEE LICENSE IN LICENSE');
  assert.equal(manifest('packages/api').license, 'SEE LICENSE IN LICENSE');
  assert.match(root, /server in packages\/api and its modifications and derivatives/);
  assert.match(root, /governed by packages\/api\/LICENSE/);
});

test('the root MIT grant remains identical to the existing spec grant', () => {
  assert.equal(mit, read('packages/spec/LICENSE'));
});

for (const name of ['shared', 'cli', 'benchmarks']) {
  test(`${name} has a package-local MIT notice`, () => {
    assert.equal(read(`packages/${name}/LICENSE`), mit);
    assert.equal(
      manifest(`packages/${name}`).license,
      name === 'benchmarks' ? 'SEE LICENSE IN LICENSE' : 'MIT'
    );
  });
}

test('the MIT runtime entry points remain exported without an API dependency', () => {
  const shared = manifest('packages/shared');
  for (const entry of ['./runtime', './providers', './node-host']) {
    assert.ok(shared.exports[entry], entry);
  }
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    assert.equal(shared[field]?.['@inklabs/api'], undefined, field);
  }
});
