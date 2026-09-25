import { memo, useMemo, type ReactNode } from 'react';
import { Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  parseMarkdown,
  tableColumnChars,
  type MarkdownBlock,
  type MarkdownInline,
} from '@inklabs/shared/stories/thread-viewing';
import { colors, spacing, type } from '../ui/theme';

/**
 * A message body's markdown, drawn with native views. The parsing is shared
 * (@inklabs/shared's thread-viewing story, the same rules any non-browser
 * client uses); this file only decides how each piece looks on a phone.
 *
 * `tone="muted"` is for system events: the same structure, quieter.
 */

type Tone = 'default' | 'muted';

/** Table columns: roughly a body glyph's width, and the bounds a column stays within. */
const TABLE_CHAR_WIDTH = 8;
const TABLE_CELL_PADDING = spacing.sm;
const TABLE_COLUMN_MIN = 72;
const TABLE_COLUMN_MAX = 240;

/**
 * One width per column, the same in every row. Left to themselves, cells
 * size to their own text row by row, and a long cell in one row pushed the
 * next column away from its heading (Lumen, #679). A cell longer than its
 * column wraps.
 */
function columnWidths(block: Extract<MarkdownBlock, { kind: 'table' }>): number[] {
  return tableColumnChars(block).map((chars) =>
    Math.min(
      TABLE_COLUMN_MAX,
      Math.max(TABLE_COLUMN_MIN, chars * TABLE_CHAR_WIDTH + 2 * TABLE_CELL_PADDING)
    )
  );
}

function inline(nodes: MarkdownInline[], prefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${prefix}${index}`;
    switch (node.kind) {
      case 'text':
        return node.text;
      case 'break':
        return '\n';
      case 'strong':
        return (
          <Text key={key} style={styles.strong}>
            {inline(node.children, `${key}.`)}
          </Text>
        );
      case 'em':
        return (
          <Text key={key} style={styles.em}>
            {inline(node.children, `${key}.`)}
          </Text>
        );
      case 'del':
        return (
          <Text key={key} style={styles.del}>
            {inline(node.children, `${key}.`)}
          </Text>
        );
      case 'code':
        return (
          <Text key={key} style={styles.codespan}>
            {node.text}
          </Text>
        );
      case 'link':
        return (
          <Text
            key={key}
            style={styles.link}
            onPress={() => void Linking.openURL(node.href)}
            accessibilityRole="link"
          >
            {inline(node.children, `${key}.`)}
          </Text>
        );
    }
  });
}

function listMarker(
  block: Extract<MarkdownBlock, { kind: 'list' }>,
  index: number,
  checked: boolean | null
): string {
  if (checked !== null) return checked ? '☑' : '☐';
  return block.ordered ? `${block.start + index}.` : '•';
}

function Blocks({ blocks, tone, prefix }: { blocks: MarkdownBlock[]; tone: Tone; prefix: string }) {
  const textStyle = tone === 'muted' ? styles.mutedText : styles.text;
  return (
    <>
      {blocks.map((block, index) => {
        const key = `${prefix}${index}`;
        const spaced = index > 0 ? styles.spaced : null;
        switch (block.kind) {
          case 'paragraph':
            return (
              <Text key={key} style={[textStyle, spaced]} selectable>
                {inline(block.inline, `${key}.`)}
              </Text>
            );
          case 'heading':
            return (
              <Text
                key={key}
                style={[textStyle, block.depth <= 2 ? styles.headingLarge : styles.heading, spaced]}
                accessibilityRole="header"
                selectable
              >
                {inline(block.inline, `${key}.`)}
              </Text>
            );
          case 'code':
            return (
              <View key={key} style={[styles.codeBlock, spaced]}>
                {block.lang ? <Text style={styles.codeLang}>{block.lang}</Text> : null}
                <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                  <Text style={styles.codeText} selectable>
                    {block.text}
                  </Text>
                </ScrollView>
              </View>
            );
          case 'quote':
            return (
              <View key={key} style={[styles.quote, spaced]}>
                <Blocks blocks={block.blocks} tone="muted" prefix={`${key}.`} />
              </View>
            );
          case 'list':
            return (
              <View key={key} style={spaced}>
                {block.items.map((item, itemIndex) => (
                  <View key={`${key}.${itemIndex}`} style={styles.listItem}>
                    <Text style={[textStyle, styles.listMarker]}>
                      {listMarker(block, itemIndex, item.checked)}
                    </Text>
                    <View style={styles.listBody}>
                      <Blocks blocks={item.blocks} tone={tone} prefix={`${key}.${itemIndex}.`} />
                    </View>
                  </View>
                ))}
              </View>
            );
          case 'rule':
            return <View key={key} style={[styles.rule, spaced]} />;
          case 'table': {
            const widths = columnWidths(block);
            return (
              <ScrollView
                key={key}
                horizontal
                style={spaced}
                showsHorizontalScrollIndicator={false}
              >
                <View style={styles.table}>
                  {[block.header, ...block.rows].map((row, rowIndex) => (
                    <View
                      key={`${key}.${rowIndex}`}
                      style={[styles.tableRow, rowIndex === 0 && styles.tableHeaderRow]}
                    >
                      {row.map((cell, cellIndex) => (
                        <Text
                          key={cellIndex}
                          style={[
                            textStyle,
                            styles.tableCell,
                            {
                              width: widths[cellIndex],
                              minWidth: widths[cellIndex],
                              maxWidth: widths[cellIndex],
                            },
                            rowIndex === 0 && styles.strong,
                            { textAlign: block.align[cellIndex] ?? 'left' },
                          ]}
                          selectable
                        >
                          {inline(cell, `${key}.${rowIndex}.${cellIndex}.`)}
                        </Text>
                      ))}
                    </View>
                  ))}
                </View>
              </ScrollView>
            );
          }
        }
      })}
    </>
  );
}

/** Blocks that need the full width of the screen rather than their text's. */
export function hasWideBlocks(blocks: MarkdownBlock[]): boolean {
  return blocks.some(
    (block) =>
      block.kind === 'table' ||
      block.kind === 'code' ||
      (block.kind === 'quote' && hasWideBlocks(block.blocks)) ||
      (block.kind === 'list' && block.items.some((item) => hasWideBlocks(item.blocks)))
  );
}

/**
 * `blocks` when the caller has already parsed the body (a message bubble
 * does, to decide its width); otherwise the body is parsed here.
 */
export const MarkdownView = memo(function MarkdownView({
  body,
  blocks,
  tone = 'default',
}: {
  body: string;
  blocks?: MarkdownBlock[];
  tone?: Tone;
}) {
  const parsed = useMemo(() => blocks ?? parseMarkdown(body), [blocks, body]);
  return <Blocks blocks={parsed} tone={tone} prefix="" />;
});

const styles = StyleSheet.create({
  text: { ...type.body, color: colors.textPrimary, lineHeight: 21 },
  mutedText: { ...type.caption, color: colors.textSecondary, lineHeight: 17 },
  spaced: { marginTop: spacing.sm },
  strong: { fontWeight: '700' },
  em: { fontStyle: 'italic' },
  del: { textDecorationLine: 'line-through' },
  codespan: {
    ...type.mono,
    fontSize: 13,
    color: colors.accentBright,
    backgroundColor: colors.surfaceOverlay,
  },
  link: { color: colors.accentBright, textDecorationLine: 'underline' },
  heading: { fontSize: 15, fontWeight: '700' },
  headingLarge: { fontSize: 17, fontWeight: '700' },
  codeBlock: {
    backgroundColor: colors.ink,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  codeLang: { ...type.label, color: colors.textMuted, marginBottom: 4 },
  codeText: { ...type.mono, color: colors.textPrimary, lineHeight: 18 },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: colors.borderDefault,
    paddingLeft: spacing.md,
  },
  listItem: { flexDirection: 'row', marginTop: 2 },
  listMarker: { width: 22, color: colors.textSecondary },
  // Shrink, never flex: a chat bubble sizes to its content, and a flexing
  // child of a content-sized row resolves to zero width.
  listBody: { flexShrink: 1 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.borderDefault },
  table: {
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.borderDefault,
    borderRadius: 6,
  },
  tableRow: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
  tableHeaderRow: { borderTopWidth: 0, backgroundColor: colors.surfaceRaised },
  tableCell: { paddingHorizontal: TABLE_CELL_PADDING, paddingVertical: 6 },
});
