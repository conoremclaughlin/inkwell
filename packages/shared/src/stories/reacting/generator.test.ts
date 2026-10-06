// The catalog generator's refusals, against doctored inputs. The generator is
// a developer script at the repo root; its pure functions are tested here so
// CI runs them with this package's suite.
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain .mjs script, without type declarations.
import * as generator from '../../../../../scripts/generate-emoji-catalog.mjs';

interface Annotations {
  names: Map<string, string>;
  keywords: Map<string, string[]>;
}
interface Catalog {
  rows: Array<{ hex: string; name: string; keywords: string[]; toneOf: number }>;
  minimallyQualified: Array<[string, number]>;
  unqualified: Array<[string, number]>;
}
const { parseEmojiTest, parseAnnotations, buildCatalog, assertToneFamilies } = generator as {
  parseEmojiTest: (text: string) => unknown[];
  parseAnnotations: (xml: string) => Annotations;
  buildCatalog: (entries: unknown[], annotations: Annotations, derived: Annotations) => Catalog;
  assertToneFamilies: (catalog: Catalog) => void;
};

/** One fully-qualified emoji-test entry, built directly for the mapping tests. */
const entry = (hex: string, label: string, subgroup: string) => ({
  hex,
  seq: hex
    .split(' ')
    .map((h) => String.fromCodePoint(parseInt(h, 16)))
    .join(''),
  status: 'fully-qualified',
  label,
  group: 'People & Body',
  subgroup,
});
const namesOf = (entries: Array<{ seq: string; label: string }>): Annotations => ({
  names: new Map(entries.map((e) => [e.seq, e.label])),
  keywords: new Map(),
});
const none: Annotations = { names: new Map(), keywords: new Map() };

const COUNTS = (fq: number, mq: number, uq: number, c: number) => `
# Status Counts
# fully-qualified : ${fq}
# minimally-qualified : ${mq}
# unqualified : ${uq}
# component : ${c}
`;

const EMOJI_TEST = `# group: Smileys & Emotion
# subgroup: emotion
2764 FE0F                                              ; fully-qualified     # ❤️ E0.6 red heart
2764                                                   ; unqualified         # ❤ E0.6 red heart
# group: People & Body
# subgroup: hand-fingers-closed
1F44D                                                  ; fully-qualified     # 👍 E0.6 thumbs up
1F44D 1F3FB                                            ; fully-qualified     # 👍🏻 E1.0 thumbs up: light skin tone
# group: Component
# subgroup: skin-tone
1F3FB                                                  ; component           # 🏻 E1.0 light skin tone
${COUNTS(3, 0, 1, 1)}`;

const xml = (lines: string[]) => `<ldml><annotations>\n${lines.join('\n')}\n</annotations></ldml>`;
const ANNOTATIONS = xml([
  '<annotation cp="❤">emotion | heart | love &amp; red</annotation>',
  '<annotation cp="❤" type="tts">red heart</annotation>',
  '<annotation cp="👍">+1 | thumb | up</annotation>',
  '<annotation cp="👍" type="tts">thumbs up</annotation>',
]);
const DERIVED = xml([
  '<annotation cp="👍🏻">+1 | thumb | up | light skin tone</annotation>',
  '<annotation cp="👍🏻" type="tts">thumbs up: light skin tone</annotation>',
]);

const build = (emojiTest = EMOJI_TEST, annotations = ANNOTATIONS, derived = DERIVED) =>
  buildCatalog(parseEmojiTest(emojiTest), parseAnnotations(annotations), parseAnnotations(derived));

describe('generate-emoji-catalog', () => {
  it('builds rows, aliases and tone bases from well-formed inputs', () => {
    const catalog = build();
    expect(catalog.rows.map((r) => [r.hex, r.name, r.toneOf])).toEqual([
      ['2764 FE0F', 'red heart', -1],
      ['1F44D', 'thumbs up', -1],
      ['1F44D 1F3FB', 'thumbs up: light skin tone', 1],
    ]);
    expect(catalog.rows[0].keywords).toEqual(['emotion', 'heart', 'love & red']);
    expect(catalog.rows[2].keywords).toEqual([]);
    expect(catalog.unqualified).toEqual([['2764', 0]]);
  });

  it('fails when the parsed counts differ from the counts the file declares', () => {
    const wrong = EMOJI_TEST.replace('# fully-qualified : 3', '# fully-qualified : 4');
    expect(() => parseEmojiTest(wrong)).toThrow(/parsed 3 fully-qualified, the file declares 4/);
  });

  it('fails on a data line it cannot parse', () => {
    const wrong = EMOJI_TEST.replace('1F44D 1F3FB ', '1F44D 1F3FB ;;');
    expect(() => parseEmojiTest(wrong)).toThrow(/unparsed data line/);
  });

  it('fails when a fully-qualified emoji has no CLDR name, rather than dropping it', () => {
    const noName = DERIVED.replace(
      '<annotation cp="👍🏻" type="tts">thumbs up: light skin tone</annotation>',
      ''
    );
    expect(() => build(EMOJI_TEST, ANNOTATIONS, noName)).toThrow(
      /1 fully-qualified sequences have no CLDR name: 1F44D 1F3FB/
    );
  });

  it('fails on an alias with two fully-qualified forms', () => {
    const collision = EMOJI_TEST.replace(
      '2764                                                   ; unqualified',
      '2764 FE0F FE0F                                         ; fully-qualified     # ❤️ E0.6 red heart again\n2764                                                   ; unqualified'
    ).replace('# fully-qualified : 3', '# fully-qualified : 4');
    expect(() => build(collision)).toThrow(/alias collision: 2764 FE0F FE0F and 2764 FE0F/);
  });

  it('fails on an alias with no fully-qualified form', () => {
    const orphan = EMOJI_TEST.replace(
      '2764 FE0F                                              ; fully-qualified     # ❤️ E0.6 red heart\n',
      ''
    ).replace('# fully-qualified : 3', '# fully-qualified : 2');
    expect(() => build(orphan)).toThrow(/no fully-qualified form for unqualified 2764/);
  });

  it('fails on a skin-tone variant with no untoned base, whatever row precedes it', () => {
    const stray = EMOJI_TEST.replace(
      '1F44D                                                  ; fully-qualified     # 👍 E0.6 thumbs up\n',
      ''
    ).replace('# fully-qualified : 3', '# fully-qualified : 2');
    expect(() => build(stray)).toThrow(/skin-tone variant with no base: 1F44D 1F3FB/);
  });

  it('maps a skin-tone variant by structure, then by name, never by position', () => {
    // Unicode lists a family's mixed tones after its last member.
    const people = entry('1F46F', 'people with bunny ears', 'family');
    const women = entry('1F46F 200D 2640 FE0F', 'women with bunny ears', 'family');
    const mixed = entry(
      '1F9D1 1F3FB 200D 1F430 200D 1F9D1 1F3FC',
      'people with bunny ears: light skin tone, medium-light skin tone',
      'family'
    );
    const single = entry(
      '1F46F 1F3FB 200D 2640 FE0F',
      'women with bunny ears: light skin tone',
      'family'
    );
    const catalog = buildCatalog(
      [people, women, mixed, single],
      namesOf([people, women, mixed, single]),
      none
    );
    expect(catalog.rows.map((r) => r.toneOf)).toEqual([-1, -1, 0, 1]);
  });

  it('prefers structure to the name, so a hair style keeps its own variants', () => {
    const man = entry('1F468', 'man', 'person');
    const red = entry('1F468 200D 1F9B0', 'man: red hair', 'person');
    const toned = entry('1F468 1F3FB 200D 1F9B0', 'man: light skin tone, red hair', 'person');
    const catalog = buildCatalog([man, red, toned], namesOf([man, red, toned]), none);
    expect(catalog.rows[2].toneOf).toBe(1);
  });

  it('fails on a variant whose base is in another subgroup', () => {
    const up = entry('1F44D', 'thumbs up', 'hand-fingers-closed');
    const toned = entry('1F44D 1F3FB', 'thumbs up: light skin tone', 'hand-fingers-open');
    expect(() => buildCatalog([up, toned], namesOf([up, toned]), none)).toThrow(
      /skin-tone variant outside its base's subgroup: 1F44D 1F3FB -> 1F44D/
    );
  });

  it('fails on two variants of one base with the same tones', () => {
    const people = entry('1F46F', 'people with bunny ears', 'family');
    const a = entry('1F46F 1F3FB', 'people with bunny ears: light skin tone', 'family');
    const b = entry(
      '1F9D1 1F3FB 200D 1F430 200D 1F9D1',
      'people with bunny ears: light skin tone',
      'family'
    );
    expect(() => buildCatalog([people, a, b], namesOf([people, a, b]), none)).toThrow(
      /two skin-tone variants of 1F46F have the same tones/
    );
  });

  it('refuses a generation whose bases do not have 5 or 25 variants each', () => {
    const up = entry('1F44D', 'thumbs up', 'hand');
    const tones = ['1F3FB', '1F3FC', '1F3FD', '1F3FE', '1F3FF'];
    const five = tones.map((t) => entry(`1F44D ${t}`, `thumbs up: tone ${t}`, 'hand'));
    expect(() =>
      assertToneFamilies(buildCatalog([up, ...five], namesOf([up, ...five]), none))
    ).not.toThrow();
    const one = five.slice(0, 1);
    expect(() =>
      assertToneFamilies(buildCatalog([up, ...one], namesOf([up, ...one]), none))
    ).toThrow(/not 5 or 25 variants: 1F44D has 1/);
  });

  it('decodes XML entities and refuses one it does not know', () => {
    expect(parseAnnotations(ANNOTATIONS).keywords.get('❤')).toEqual([
      'emotion',
      'heart',
      'love & red',
    ]);
    expect(() => parseAnnotations(xml(['<annotation cp="❤">a &bogus; b</annotation>']))).toThrow(
      /unknown entity &bogus;/
    );
  });
});
