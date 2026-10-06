#!/usr/bin/env node
/**
 * Generates the reaction emoji catalog from pinned Unicode and CLDR files
 * (design ink://designs/reaction-emoji-catalog §1, task 873dfd66).
 *
 * Nothing is fetched. The inputs are local copies, each checked against the
 * SHA-256 pinned below before anything is read from it, and the run fails
 * rather than guessing:
 *
 *   - emoji-test.txt's parsed status counts must equal the counts the file
 *     declares about itself;
 *   - every minimally-qualified or unqualified sequence must have exactly one
 *     fully-qualified form once VS16 is ignored (a collision fails);
 *   - every fully-qualified sequence must have a CLDR name (a missing name
 *     fails: newer emoji are never dropped, and nothing else is passed off as
 *     a CLDR name);
 *   - every skin-tone variant must follow an untoned base in its subgroup.
 *
 * It writes two checked-in files, kept apart so a client can load search
 * lazily while validation stays small:
 *
 *   packages/shared/src/stories/reacting/validation.generated.ts
 *   packages/shared/src/stories/reaction-picking/search.generated.ts
 *
 * It also writes the parity manifest the Inkling app's copy is held to: each
 * copied module's SHA-256 and a digest over them. Run it after prettier has
 * formatted the hand-written modules, and after any edit to one of them.
 *
 * Usage:
 *   node scripts/generate-emoji-catalog.mjs --inputs <dir>          write both data files
 *   node scripts/generate-emoji-catalog.mjs --manifest              write the manifest
 *   add --check to either: compare instead of writing, exit 1 on drift
 *
 * <dir> holds the pinned files at the relative paths named in PINS.
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PINS = {
  unicode: {
    version: '18.0',
    file: 'unicode-18.0.0/emoji-test.txt',
    url: 'https://www.unicode.org/Public/18.0.0/emoji/emoji-test.txt',
    sha256: '8f3735cda1f92a779d78af67cf86066bb1f07143dc22f2ac29394d9bc57ab21a',
  },
  cldr: {
    // The only CLDR data naming all of Unicode 18.0 is release 49, which is
    // still a beta: release 48 lacks 19 of 18.0's emoji. Re-pin to the final
    // release when it is published; the header records the pre-release.
    release: '49-beta2',
    prerelease: true,
    annotations: {
      file: 'cldr-release-49-beta2/annotations/en.xml',
      url: 'https://raw.githubusercontent.com/unicode-org/cldr/release-49-beta2/common/annotations/en.xml',
      sha256: '514bc93ac647211d0f422f63978d1eeec6aa759d0cd8c3e8c5da6cf5a536784b',
    },
    derived: {
      file: 'cldr-release-49-beta2/annotationsDerived/en.xml',
      url: 'https://raw.githubusercontent.com/unicode-org/cldr/release-49-beta2/common/annotationsDerived/en.xml',
      sha256: 'a4a6c1a4c341d94179cb116623c5f44c47400a5bc55da483423ef7430ecf622e',
    },
  },
};

export const CATALOG_VERSION = `unicode-${PINS.unicode.version}+cldr-${PINS.cldr.release}`;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORIES = 'packages/shared/src/stories';
export const OUTPUTS = {
  validation: `${STORIES}/reacting/validation.generated.ts`,
  search: `${STORIES}/reaction-picking/search.generated.ts`,
  manifest: `${STORIES}/reaction-picking/parity-manifest.generated.ts`,
};

/**
 * Every module the Inkling app copies byte for byte, by path under stories/.
 * They import only one another, so the copy needs nothing else.
 */
export const PARITY_FILES = [
  'reacting/index.ts',
  'reacting/normalize.ts',
  'reacting/validation.generated.ts',
  'reaction-picking/index.ts',
  'reaction-picking/parity-vectors.ts',
  'reaction-picking/search-aliases.ts',
  'reaction-picking/search.generated.ts',
  'reaction-picking/search.ts',
];
export const PARITY_MANIFEST_VERSION = 1;

const LICENSE = `UNICODE LICENSE V3

COPYRIGHT AND PERMISSION NOTICE

Copyright © 1991-2026 Unicode, Inc.

NOTICE TO USER: Carefully read the following legal agreement. BY
DOWNLOADING, INSTALLING, COPYING OR OTHERWISE USING DATA FILES, AND/OR
SOFTWARE, YOU UNEQUIVOCALLY ACCEPT, AND AGREE TO BE BOUND BY, ALL OF THE
TERMS AND CONDITIONS OF THIS AGREEMENT. IF YOU DO NOT AGREE, DO NOT
DOWNLOAD, INSTALL, COPY, DISTRIBUTE OR USE THE DATA FILES OR SOFTWARE.

Permission is hereby granted, free of charge, to any person obtaining a
copy of data files and any associated documentation (the "Data Files") or
software and any associated documentation (the "Software") to deal in the
Data Files or Software without restriction, including without limitation
the rights to use, copy, modify, merge, publish, distribute, and/or sell
copies of the Data Files or Software, and to permit persons to whom the
Data Files or Software are furnished to do so, provided that either (a)
this copyright and permission notice appear with all copies of the Data
Files or Software, or (b) this copyright and permission notice appear in
associated Documentation.

THE DATA FILES AND SOFTWARE ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY
KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT OF
THIRD PARTY RIGHTS.

IN NO EVENT SHALL THE COPYRIGHT HOLDER OR HOLDERS INCLUDED IN THIS NOTICE
BE LIABLE FOR ANY CLAIM, OR ANY SPECIAL INDIRECT OR CONSEQUENTIAL DAMAGES,
OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS,
WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION,
ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THE DATA
FILES OR SOFTWARE.

Except as contained in this notice, the name of a copyright holder shall
not be used in advertising or otherwise to promote the sale, use or other
dealings in these Data Files or Software without prior written
authorization of the copyright holder.`;

const VS16 = '\u{FE0F}';
const TONE = /[\u{1F3FB}-\u{1F3FF}]/u;
const STATUSES = ['fully-qualified', 'minimally-qualified', 'unqualified', 'component'];

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

const hexOf = (seq) =>
  [...seq].map((c) => c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
const seqOf = (hex) =>
  hex
    .split(' ')
    .map((h) => String.fromCodePoint(parseInt(h, 16)))
    .join('');
const withoutVs16 = (seq) => seq.split(VS16).join('');

/**
 * Every data line of emoji-test.txt, in file order, with its group and
 * subgroup. Fails unless the parsed status counts equal the counts the file
 * declares in its "Status Counts" section.
 */
export function parseEmojiTest(text) {
  const entries = [];
  const declared = {};
  let group = null;
  let subgroup = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    let m;
    if ((m = /^# group: (.+)$/.exec(line))) group = m[1];
    else if ((m = /^# subgroup: (.+)$/.exec(line))) subgroup = m[1];
    else if (
      (m = /^# (fully-qualified|minimally-qualified|unqualified|component) : (\d+)$/.exec(line))
    )
      declared[m[1]] = Number(m[2]);
    else if (
      (m =
        /^([0-9A-F]{4,6}(?: [0-9A-F]{4,6})*)\s*;\s*(fully-qualified|minimally-qualified|unqualified|component)\s*#\s*\S+\s+E\d+\.\d+\s+(.+)$/.exec(
          line
        ))
    ) {
      if (!group || !subgroup)
        throw new Error(`emoji-test.txt: a sequence before any group: ${m[1]}`);
      entries.push({ hex: m[1], seq: seqOf(m[1]), status: m[2], label: m[3], group, subgroup });
    } else if (/^[0-9A-F]/.test(line)) {
      throw new Error(`emoji-test.txt: unparsed data line: ${line}`);
    }
  }
  for (const status of STATUSES) {
    const parsed = entries.filter((e) => e.status === status).length;
    if (declared[status] === undefined)
      throw new Error(`emoji-test.txt: no declared count for ${status}`);
    if (parsed !== declared[status])
      throw new Error(
        `emoji-test.txt: parsed ${parsed} ${status}, the file declares ${declared[status]}`
      );
  }
  return entries;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function unescapeXml(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, name) => {
    if (name.startsWith('#x')) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
    if (name in ENTITIES) return ENTITIES[name];
    throw new Error(`annotations: unknown entity ${whole}`);
  });
}

/** CLDR annotations: `type="tts"` lines are names, the rest are "|"-separated keywords. */
export function parseAnnotations(xml) {
  const names = new Map();
  const keywords = new Map();
  const pattern = /<annotation cp="([^"]+)"( type="tts")?>([^<]*)<\/annotation>/g;
  let m;
  while ((m = pattern.exec(xml))) {
    const cp = unescapeXml(m[1]);
    const text = unescapeXml(m[3]).trim();
    if (m[2]) names.set(cp, text);
    else
      keywords.set(
        cp,
        text
          .split('|')
          .map((k) => k.trim())
          .filter(Boolean)
      );
  }
  return { names, keywords };
}

function lookup(map, seq) {
  return map.get(seq) ?? map.get(withoutVs16(seq));
}

/**
 * The catalog: fully-qualified sequences in file order with names, keywords,
 * group, subgroup and tone base; the qualification aliases; the counts.
 * `annotations` and `derived` are parseAnnotations results; the plain file
 * wins where both name a sequence.
 */
export function buildCatalog(entries, annotations, derived) {
  const fullyQualified = entries.filter((e) => e.status === 'fully-qualified');
  const indexByStripped = new Map();
  fullyQualified.forEach((e, i) => {
    const key = withoutVs16(e.seq);
    if (indexByStripped.has(key))
      throw new Error(
        `alias collision: ${e.hex} and ${fullyQualified[indexByStripped.get(key)].hex}`
      );
    indexByStripped.set(key, i);
  });

  const aliases = { 'minimally-qualified': [], unqualified: [] };
  for (const e of entries) {
    if (!(e.status in aliases)) continue;
    const target = indexByStripped.get(withoutVs16(e.seq));
    if (target === undefined) throw new Error(`no fully-qualified form for ${e.status} ${e.hex}`);
    aliases[e.status].push([e.hex, target]);
  }

  const names = new Map([...derived.names, ...annotations.names]);
  const keywords = new Map([...derived.keywords, ...annotations.keywords]);
  const missing = fullyQualified.filter((e) => !lookup(names, e.seq));
  if (missing.length > 0) {
    const sample = missing
      .slice(0, 5)
      .map((e) => `${e.hex} (${e.label})`)
      .join(', ');
    throw new Error(`${missing.length} fully-qualified sequences have no CLDR name: ${sample}`);
  }

  const groups = [...new Set(fullyQualified.map((e) => e.group))];
  const subgroups = [...new Set(fullyQualified.map((e) => e.subgroup))];
  let base = -1;
  const rows = fullyQualified.map((e, i) => {
    const toned = TONE.test(e.seq);
    if (!toned) base = i;
    else if (base < 0 || fullyQualified[base].subgroup !== e.subgroup)
      throw new Error(`skin-tone variant with no base in its subgroup: ${e.hex}`);
    return {
      hex: e.hex,
      name: lookup(names, e.seq),
      keywords: toned ? [] : (lookup(keywords, e.seq) ?? []),
      group: groups.indexOf(e.group),
      subgroup: subgroups.indexOf(e.subgroup),
      toneOf: toned ? base : -1,
    };
  });

  return {
    rows,
    groups,
    subgroups,
    minimallyQualified: aliases['minimally-qualified'],
    unqualified: aliases.unqualified,
    components: entries.filter((e) => e.status === 'component').map((e) => e.hex),
  };
}

function header(what) {
  return [
    `// GENERATED by scripts/generate-emoji-catalog.mjs: ${what}. Do not edit; regenerate.`,
    `// Design: ink://designs/reaction-emoji-catalog. Sources (pinned by SHA-256):`,
    `//   ${PINS.unicode.url}`,
    `//     ${PINS.unicode.sha256}`,
    `//   ${PINS.cldr.annotations.url}`,
    `//     ${PINS.cldr.annotations.sha256}`,
    `//   ${PINS.cldr.derived.url}`,
    `//     ${PINS.cldr.derived.sha256}`,
    `/*`,
    ...LICENSE.split('\n').map((l) => (l ? ` * ${l}` : ' *')),
    ` */`,
    '',
  ].join('\n');
}

const str = (s) => JSON.stringify(s);

export function renderValidation(catalog) {
  const lines = [
    header('the sequences a reaction may be added with'),
    `/** The catalog this data came from: Unicode version, then CLDR release. */`,
    `export const EMOJI_CATALOG_VERSION = ${str(CATALOG_VERSION)};`,
    '',
    `/** True while the CLDR pin is a pre-release; the header names the tag. */`,
    `export const EMOJI_CATALOG_PRERELEASE = ${PINS.cldr.prerelease};`,
    '',
    `/** Standalone components, which are never a reaction: counted, not listed for use. */`,
    `export const EMOJI_COMPONENT_COUNT = ${catalog.components.length};`,
    '',
    `/**`,
    ` * Every fully-qualified sequence, in emoji-test.txt order, as space-separated`,
    ` * hex code points. An index into this list identifies an emoji everywhere.`,
    ` */`,
    `export const FULLY_QUALIFIED_HEX: readonly string[] = [`,
    ...catalog.rows.map((r) => `  ${str(r.hex)},`),
    `];`,
    '',
    `/** Each minimally-qualified sequence and the index of its fully-qualified form. */`,
    `export const MINIMALLY_QUALIFIED_HEX: ReadonlyArray<readonly [string, number]> = [`,
    ...catalog.minimallyQualified.map(([hex, i]) => `  [${str(hex)}, ${i}],`),
    `];`,
    '',
    `/** Each unqualified sequence and the index of its fully-qualified form. */`,
    `export const UNQUALIFIED_HEX: ReadonlyArray<readonly [string, number]> = [`,
    ...catalog.unqualified.map(([hex, i]) => `  [${str(hex)}, ${i}],`),
    `];`,
    '',
  ];
  return lines.join('\n');
}

export function renderSearch(catalog) {
  const lines = [
    header('names, keywords and groups for the picker'),
    `/** Must equal EMOJI_CATALOG_VERSION in the reacting story's validation data. */`,
    `export const EMOJI_SEARCH_CATALOG_VERSION = ${str(CATALOG_VERSION)};`,
    '',
    `/** Unicode group names, indexed by a row's group. */`,
    `export const EMOJI_GROUPS: readonly string[] = [`,
    ...catalog.groups.map((g) => `  ${str(g)},`),
    `];`,
    '',
    `/** Unicode subgroup names, indexed by a row's subgroup. */`,
    `export const EMOJI_SUBGROUPS: readonly string[] = [`,
    ...catalog.subgroups.map((g) => `  ${str(g)},`),
    `];`,
    '',
    `/**`,
    ` * One row per FULLY_QUALIFIED_HEX index, in the same order:`,
    ` * [CLDR name, CLDR keywords joined by "|", group, subgroup, tone base].`,
    ` * The tone base is the index of the untoned emoji a skin-tone variant belongs`,
    ` * to, or -1 for an emoji that is not a variant. Variants carry no keywords:`,
    ` * search finds the base, and the skin-tone control lists its variants.`,
    ` */`,
    `export const EMOJI_SEARCH_ROWS: ReadonlyArray<readonly [string, string, number, number, number]> = [`,
    ...catalog.rows.map(
      (r) =>
        `  [${str(r.name)}, ${str(r.keywords.join('|'))}, ${r.group}, ${r.subgroup}, ${r.toneOf}],`
    ),
    `];`,
    '',
  ];
  return lines.join('\n');
}

/** SHA-256 over "<path>\t<sha256>\n" for each file, sorted by path. */
export function parityDigest(files) {
  const lines = [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([file, sha]) => `${file}\t${sha}\n`)
    .join('');
  return sha256(Buffer.from(lines, 'utf8'));
}

export function renderManifest(files) {
  return [
    `// GENERATED by scripts/generate-emoji-catalog.mjs --manifest. Do not edit; regenerate.`,
    `// Design: ink://designs/reaction-emoji-catalog §1. The Inkling app copies each`,
    `// file below byte for byte; both repos check these hashes and the digest.`,
    '',
    `export const EMOJI_PARITY_MANIFEST_VERSION = ${PARITY_MANIFEST_VERSION};`,
    '',
    `/** Each copied module, by path under stories/, with its SHA-256. */`,
    `export const EMOJI_PARITY_FILES: ReadonlyArray<readonly [string, string]> = [`,
    ...files.map(([file, sha]) => `  [${str(file)}, ${str(sha)}],`),
    `];`,
    '',
    `/** SHA-256 over "<path>\\t<sha256>\\n" for each file above, sorted by path. */`,
    `export const EMOJI_PARITY_DIGEST = ${str(parityDigest(files))};`,
    '',
  ].join('\n');
}

async function writeOrCheck(rel, text, check) {
  const file = path.join(REPO_ROOT, rel);
  if (check) {
    const current = await readFile(file, 'utf8').catch(() => null);
    if (current === text) return 0;
    console.error(`drift: ${rel}`);
    return 1;
  }
  await writeFile(file, text);
  console.log(`wrote ${rel} (${Buffer.byteLength(text)} bytes)`);
  return 0;
}

/** The manifest of the copied modules as they are now: run after prettier. */
async function manifest(check) {
  const files = [];
  for (const rel of PARITY_FILES) {
    files.push([rel, sha256(await readFile(path.join(REPO_ROOT, STORIES, rel)))]);
  }
  const drift = await writeOrCheck(OUTPUTS.manifest, renderManifest(files), check);
  console.log(`parity digest ${parityDigest(files)}`);
  return drift;
}

async function readPinned(dir, pin) {
  const bytes = await readFile(path.join(dir, pin.file));
  const actual = sha256(bytes);
  if (actual !== pin.sha256)
    throw new Error(`${pin.file}: SHA-256 ${actual}, pinned ${pin.sha256}`);
  return bytes.toString('utf8');
}

async function main(argv) {
  const check = argv.includes('--check');
  if (argv.includes('--manifest')) return manifest(check);
  const at = argv.indexOf('--inputs');
  if (at < 0 || !argv[at + 1])
    throw new Error('usage: generate-emoji-catalog.mjs (--inputs <dir> | --manifest) [--check]');
  const dir = path.resolve(argv[at + 1]);
  const entries = parseEmojiTest(await readPinned(dir, PINS.unicode));
  const annotations = parseAnnotations(await readPinned(dir, PINS.cldr.annotations));
  const derived = parseAnnotations(await readPinned(dir, PINS.cldr.derived));
  const catalog = buildCatalog(entries, annotations, derived);
  let drift = 0;
  drift += await writeOrCheck(OUTPUTS.validation, renderValidation(catalog), check);
  drift += await writeOrCheck(OUTPUTS.search, renderSearch(catalog), check);
  const bases = catalog.rows.filter((r) => r.toneOf < 0).length;
  console.log(
    `${CATALOG_VERSION}: ${catalog.rows.length} fully-qualified (${bases} bases), ` +
      `${catalog.minimallyQualified.length} minimally-qualified, ${catalog.unqualified.length} unqualified, ` +
      `${catalog.components.length} components`
  );
  return drift === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(2);
    }
  );
}
