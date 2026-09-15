// @vitest-environment jsdom
import { createRequire } from 'node:module';

import { afterEach, describe, expect, it } from 'vitest';

import { Link } from '@mantine/tiptap';
import { Editor } from '@tiptap/core';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';

/**
 * `tiptap-schema.test.ts` covers schema construction, which is what works under
 * the suite's default `environment: 'node'`. It is not enough: a schema builds
 * fine when two copies of prosemirror-model are loaded, and the commands that
 * wrap nodes still fail — `Fragment.from` rejects a node built by the other
 * copy with "Can not convert <> to a Fragment". That is a lockfile-shaped bug,
 * so it only shows up against a real Editor with real commands.
 *
 * `RichTextEditor.BulletList` and `RichTextEditor.OrderedList` are live controls
 * in editor.tsx's toolbar, so `toggleBulletList` / `toggleOrderedList` are what
 * a user actually clicks. This file drives them under jsdom.
 *
 * Found by Lumen reviewing PR #633: moving the @tiptap family to 3.31.3 pulled
 * prosemirror-model ^1.25.11 alongside the existing ^1.25.4 resolution, and
 * yarn kept both. Both commands threw. The fix is a lockfile dedupe, and this
 * file fails without it.
 */
const CommonExtensions = [
  StarterKit.configure({ codeBlock: false, code: false }),
  Underline,
  Markdown as any,
  Link,
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
];

let editor: Editor | null = null;

function mountEditor(content: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  editor = new Editor({ element, extensions: CommonExtensions, content });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
  document.body.innerHTML = '';
});

describe('tiptap diff-viewer list commands', () => {
  it.each([
    ['toggleBulletList', 'bulletList'],
    ['toggleOrderedList', 'orderedList'],
  ] as const)('%s wraps the paragraph in a %s', (command, nodeType) => {
    const instance = mountEditor('<p>hello world</p>');

    instance.commands.setTextSelection(4);

    expect(instance.commands[command]()).toBe(true);

    const doc = instance.getJSON();
    expect(doc.content?.[0].type).toBe(nodeType);
    expect(doc.content?.[0].content?.[0].type).toBe('listItem');
  });

  it('toggles a list back off, leaving a bare paragraph', () => {
    const instance = mountEditor('<p>hello world</p>');

    instance.commands.setTextSelection(4);
    instance.commands.toggleBulletList();
    expect(instance.commands.toggleBulletList()).toBe(true);

    expect(instance.getJSON().content?.[0].type).toBe('paragraph');
  });

  it('installs exactly one copy of prosemirror-model', () => {
    // The commands above are the symptom; this is the cause, named directly so
    // a reintroduced duplicate is legible without decoding a Fragment error.
    // Resolution is what the error is about, so resolve rather than import:
    // @tiptap/core and prosemirror-schema-list take the hoisted copy while a
    // second one nests under @tiptap/pm, and the list commands span both.
    const require = createRequire(import.meta.url);
    const consumers = [
      '@tiptap/core',
      '@tiptap/pm/model',
      '@tiptap/starter-kit',
      'prosemirror-schema-list',
      'prosemirror-commands',
      'prosemirror-transform',
      'prosemirror-view',
    ];

    const copies = new Set(
      consumers.map((consumer) =>
        createRequire(require.resolve(consumer)).resolve('prosemirror-model')
      )
    );

    expect([...copies]).toHaveLength(1);
  });
});
