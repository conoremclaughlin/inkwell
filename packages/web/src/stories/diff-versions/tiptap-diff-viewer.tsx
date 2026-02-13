'use client';

import React, { useEffect, useState } from 'react';
import TipTapEditor from './editor';
import { Link } from '@mantine/tiptap';
import { generateJSON } from '@tiptap/core';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { DIFF_DELETE, DIFF_EQUAL, DIFF_INSERT, diff_match_patch } from 'diff-match-patch';
import markdownit from 'markdown-it';
import { Markdown } from 'tiptap-markdown';

import { DiffAddition, DiffDeletion, DiffUnchanged } from './marks';

/**
 * TiptapDiffViewer - A component to visualize text differences using Tiptap
 *
 * @param {Object} props Component props
 * @param {string} props.originalText Original text before changes
 * @param {string} props.modifiedText Modified text after changes
 */

interface TiptapContent {
  type?: string;
  attrs?: Record<string, any>;
  content?: TiptapContent[];
  marks?: {
    type: string;
    attrs?: Record<string, any>;
  }[];
  text?: string;
}

const md = markdownit('commonmark');
const dmp = new diff_match_patch();

const CommonExtensions = [
  StarterKit.configure({
    codeBlock: false,
    code: false,
  }),
  Underline,
  Markdown as any,
  Link,
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
];

interface TiptapNode {
  type: string;
  content?: TiptapNode[];
  text?: string;
  marks?: { type: string }[];
  attrs?: Record<string, any>;
}

type DiffType = 'unchanged' | 'added' | 'removed';

function diffTiptapDocs(a: TiptapNode[], b: TiptapNode[]): TiptapNode[] {
  const maxLen = Math.max(a.length, b.length);
  const result: TiptapNode[] = [];

  for (let i = 0; i < maxLen; i++) {
    const nodeA = a[i];
    const nodeB = b[i];

    if (!nodeA && nodeB) {
      result.push(wrapWithDiffMark(nodeB, 'added'));
      continue;
    }

    if (nodeA && !nodeB) {
      result.push(wrapWithDiffMark(nodeA, 'removed'));
      continue;
    }

    if (nodeA.type !== nodeB.type) {
      result.push(wrapWithDiffMark(nodeA, 'removed'));
      result.push(wrapWithDiffMark(nodeB, 'added'));
      continue;
    }

    if (nodeA.type === 'text' && nodeB.type === 'text') {
      result.push(...diffTextContent(nodeA.text || '', nodeB.text || '', nodeA.marks, nodeB.marks));
      continue;
    }

    const childrenDiff = diffTiptapDocs(nodeA.content || [], nodeB.content || []);
    const isUnchanged =
      childrenDiff.length === (nodeA.content || []).length &&
      childrenDiff.every(
        (child, idx) => JSON.stringify(child) === JSON.stringify((nodeA.content || [])[idx])
      );

    if (isUnchanged) {
      result.push(nodeA);
    } else {
      result.push({ ...nodeB, content: childrenDiff });
    }
  }

  return result;
}

function wrapWithDiffMark(node: TiptapNode, diffType: DiffType): TiptapNode {
  if (node.type === 'text') {
    return {
      ...node,
      marks: [{ type: diffType === 'added' ? 'diffAddition' : 'diffDeletion' }],
    };
  }

  const content = (node.content || []).map((child) => wrapWithDiffMark(child, diffType));
  return {
    ...node,
    content,
  };
}

function generateDiffedDocFromTiptapDocs(
  originalDoc: TiptapNode[],
  modifiedDoc: TiptapNode[]
): { type: 'doc'; content: TiptapNode[] } {
  const content = diffTiptapDocs(originalDoc, modifiedDoc);
  return {
    type: 'doc',
    content,
  };
}

function parseMarkdownToTiptapDoc(markdown: string, extensions: any[]): any {
  const html = md.render(markdown);
  return generateJSON(html, extensions);
}

function diffTextContent(
  textA: string,
  textB: string,
  marksA?: TiptapNode['marks'],
  marksB?: TiptapNode['marks']
): TiptapNode[] {
  const diffs = dmp.diff_main(textA, textB);
  dmp.diff_cleanupSemantic(diffs);

  return diffs.map(([op, text]) => {
    const base: TiptapNode = {
      type: 'text',
      text,
      marks: [],
    };

    if (op === DIFF_EQUAL) {
      base.marks = mergeMarks(marksA, marksB);
    }

    if (op === DIFF_DELETE) {
      base.marks = [...(marksA || []), { type: 'diffDeletion' }];
    }

    if (op === DIFF_INSERT) {
      base.marks = [...(marksB || []), { type: 'diffAddition' }];
    }

    return base;
  });
}

function mergeMarks(a?: TiptapNode['marks'], b?: TiptapNode['marks']) {
  const unique: Record<string, boolean> = {};
  const merged = [...(a || []), ...(b || [])].filter((mark) => {
    if (unique[mark.type]) return false;
    unique[mark.type] = true;
    return true;
  });
  return merged;
}

const TiptapDiffViewer = ({ originalText = '', modifiedText = '' }) => {
  const [tiptapJson, setTiptapJson] = useState<string | TiptapContent>();

  useEffect(() => {
    if (originalText !== undefined && modifiedText !== undefined) {
      const originalDoc = parseMarkdownToTiptapDoc(originalText, CommonExtensions);
      const modifiedDoc = parseMarkdownToTiptapDoc(modifiedText, CommonExtensions);
      const data = generateDiffedDocFromTiptapDocs(originalDoc.content, modifiedDoc.content);

      setTiptapJson(data);
    }
  }, [originalText, modifiedText]);

  const extensionsForDiffViewer = [...CommonExtensions, DiffAddition, DiffDeletion, DiffUnchanged];

  const editor = useEditor({
    extensions: extensionsForDiffViewer,
    content: '',
    editable: false,
    immediatelyRender: false,
  });

  useEffect(() => {
    if (editor && tiptapJson) {
      editor.commands.setContent(tiptapJson);
    }
  }, [editor, tiptapJson]);

  return <TipTapEditor editor={editor} isEditing={false} hideToolbar={true} />;
};

export default TiptapDiffViewer;
