import { describe, expect, it } from 'vitest';

import { Link } from '@mantine/tiptap';
import { getSchema } from '@tiptap/core';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';

/**
 * The version-diff pages (artifact and identity history) render Tiptap, but the
 * editor itself needs a DOM and the web suite runs under `environment: 'node'`.
 * Schema construction is the part that works headlessly, and it is the part that
 * breaks when @tiptap/core, @tiptap/pm and the extension packages drift apart —
 * so it is what we pin here.
 *
 * Note on what actually discriminates: StarterKit already bundles the bold,
 * italic, strike, underline and link marks, so asserting those is a contract on
 * the toolbar's schema, not coverage of the explicit Underline/Link imports.
 * The `textAlign` attribute is the assertion that fails without its extension
 * (paragraph carries no attrs under StarterKit alone), and `check()` is what
 * rejects a document the schema does not admit.
 */
const CommonExtensions = [
  StarterKit.configure({ codeBlock: false, code: false }),
  Underline,
  Markdown as any,
  Link,
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
];

describe('tiptap diff-viewer schema', () => {
  it('builds a schema carrying the marks the toolbar drives', () => {
    const schema = getSchema(CommonExtensions);

    expect(Object.keys(schema.nodes)).toEqual(
      expect.arrayContaining(['doc', 'paragraph', 'heading', 'text', 'bulletList', 'orderedList'])
    );
    expect(Object.keys(schema.marks)).toEqual(
      expect.arrayContaining(['bold', 'italic', 'strike', 'underline', 'link'])
    );
  });

  it('wires the textAlign attribute onto heading and paragraph', () => {
    const schema = getSchema(CommonExtensions);

    expect(Object.keys(schema.nodes.paragraph.spec.attrs ?? {})).toContain('textAlign');
    expect(Object.keys(schema.nodes.heading.spec.attrs ?? {})).toContain('textAlign');
  });

  it('round-trips a document through the ProseMirror model', () => {
    const schema = getSchema(CommonExtensions);
    const doc = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2, textAlign: 'center' },
          content: [{ type: 'text', text: 'Title' }],
        },
        {
          type: 'paragraph',
          attrs: { textAlign: null },
          content: [
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'under', marks: [{ type: 'underline' }] },
          ],
        },
      ],
    };

    const node = schema.nodeFromJSON(doc);
    node.check();

    expect(node.toJSON()).toEqual(doc);
  });

  it('rejects a document the schema does not admit', () => {
    const schema = getSchema(CommonExtensions);

    expect(() =>
      schema.nodeFromJSON({ type: 'doc', content: [{ type: 'text', text: 'bare text' }] }).check()
    ).toThrow();
  });
});
