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
const { parseEmojiTest, parseAnnotations, buildCatalog } = generator as {
  parseEmojiTest: (text: string) => unknown[];
  parseAnnotations: (xml: string) => Annotations;
  buildCatalog: (
    entries: unknown[],
    annotations: Annotations,
    derived: Annotations
  ) => {
    rows: Array<{ hex: string; name: string; keywords: string[]; toneOf: number }>;
    minimallyQualified: Array<[string, number]>;
    unqualified: Array<[string, number]>;
  };
};

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

  it('fails on a skin-tone variant with no untoned base in its subgroup', () => {
    const stray = EMOJI_TEST.replace(
      '1F44D                                                  ; fully-qualified     # 👍 E0.6 thumbs up\n',
      ''
    ).replace('# fully-qualified : 3', '# fully-qualified : 2');
    expect(() => build(stray)).toThrow(
      /skin-tone variant with no base in its subgroup: 1F44D 1F3FB/
    );
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
