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
const compact = (text) => text.replace(/\s+/g, ' ');

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
  assert.ok(server.startsWith('# FSL Ink Labs Extended 1.0\n'));
  assert.match(server, /extension of the Functional Source License, Version 1\.1/);
  assert.match(server, /not the unmodified FSL-1\.1-MIT license/);
  assert.match(server, /with additional Ink Labs provisions/);
  assert.match(server, /LicenseRef-FSL-Ink-Labs-Extended-1\.0/);
  assert.match(
    server,
    /A Permitted Purpose is any purpose other than a Competing Use or a Restricted\nCommercial Use/
  );
  assert.match(server, /### Additional Provisions \(Ink Labs Extension\)/);
  assert.match(compact(root), /FSL Ink Labs Extended 1\.0/);
  assert.match(read('docs/licensing.md'), /LicenseRef-FSL-Ink-Labs-Extended-1\.0/);
});

test('root and API metadata point to scoped license texts', () => {
  assert.equal(JSON.parse(read('package.json')).license, 'SEE LICENSE IN LICENSE');
  assert.equal(manifest('packages/api').license, 'SEE LICENSE IN LICENSE');
  assert.match(root, /packages\/api/);
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

test('the operative and root scope name the API, dashboard and first-party database files', () => {
  const scope = server.slice(
    server.indexOf('### The Software\n'),
    server.indexOf('### License Grant\n')
  );
  for (const path of ['packages/api', 'packages/web', 'supabase/']) {
    assert.ok(scope.includes(path), `operative scope: ${path}`);
    assert.ok(root.includes(path), `root scope: ${path}`);
  }
  assert.match(compact(scope), /first-party/);
  assert.match(
    compact(scope),
    /does not include the Supabase platform, third-party components, or users' stored data/
  );
});

for (const path of ['packages/web', 'supabase']) {
  test(`${path} carries the complete, identical server license`, () => {
    assert.equal(read(`${path}/LICENSE`), server);
  });
}

test('dashboard metadata and scope documentation agree with the expanded license', () => {
  assert.equal(manifest('packages/web').license, 'SEE LICENSE IN LICENSE');
  const docs = read('docs/licensing.md');
  for (const path of ['packages/api', 'packages/web', 'supabase/']) {
    const row = docs
      .split('\n')
      .find((line) => line.startsWith('|') && line.includes(`\`${path}\``));
    assert.ok(row?.includes('FSL Ink Labs Extended 1.0'), `scope table: ${path}`);
  }
  const readmeLicense = read('README.md').split('## License\n')[1];
  for (const path of ['packages/api', 'packages/web', 'supabase/']) {
    assert.ok(readmeLicense.includes(`\`${path}\``), `README scope: ${path}`);
  }
  assert.match(readmeLicense, /FSL Ink Labs Extended 1\.0/);
  assert.match(
    compact(docs),
    /Earlier MIT grants for the dashboard and database files remain available/
  );
});

test('the community invitation requests permission rather than granting an exemption', () => {
  const docs = compact(read('docs/licensing.md'));
  assert.match(
    docs,
    /Community-run projects, including donation- or sponsor-supported deployments/
  );
  assert.match(docs, /contact the Licensor to request written permission/);
  assert.match(docs, /This invitation does not itself authorize a use outside the license grant/);
});

test('the commercial-use wording matches the reviewed simplified boundary', () => {
  const start = '### Permitted Purpose\n';
  const end = '### Patents\n';
  assert.equal(server.split(start).length, 2);
  assert.equal(server.split(end).length, 2);
  const terms = server.slice(server.indexOf(start), server.indexOf(end));
  // The 281118e8 block with only the extension heading renamed and the redundant
  // closing clarification in infrastructure boundary 4 removed.
  assert.equal(
    createHash('sha256').update(terms).digest('hex'),
    'aca54617dce11e0418638793f22de8c753a08dc092be8a9e656a9aa8c215ea6b'
  );
});

test('the explainer omits the standalone independent-client paragraph', () => {
  const docs = read('docs/licensing.md');
  assert.doesNotMatch(docs, /Independent paid clients need separate analysis/);
  assert.doesNotMatch(docs, /client seller who neither uses nor distributes the server/);
});

test('the infrastructure boundary is concise and the managed-service restriction remains', () => {
  const boundaries = server.slice(
    server.indexOf('#### Boundaries and permitted activities\n'),
    server.indexOf('#### Other licenses and earlier grants\n')
  );
  assert.equal(
    compact(boundaries.slice(boundaries.indexOf('4. '), boundaries.indexOf('5. '))).trim(),
    '4. Supplying general-purpose computing, storage, or network resources on which a customer installs and operates their own permitted deployment.'
  );
  assert.match(
    compact(server),
    /Selling, reselling, or providing hosting, managed operation, or access to the Software for another party as part of a Commercial Offering/
  );
});
