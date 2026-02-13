import { RichTextEditor } from '@mantine/tiptap';
import { Editor } from '@tiptap/react';

import '@mantine/tiptap/styles.css';
import './editor.css';

export default function TipTapEditor({
  editor,
  isEditing,
  hideToolbar = false,
}: {
  editor: Editor | null;
  isEditing: boolean;
  hideToolbar?: boolean;
}) {
  return (
    <RichTextEditor editor={editor} style={!isEditing ? { border: 'none' } : {}}>
      {isEditing && !hideToolbar && (
        <RichTextEditor.Toolbar sticky className="toolbar justify-center">
          <RichTextEditor.ControlsGroup className="controls-group">
            <RichTextEditor.Bold />
            <RichTextEditor.Italic />
            <RichTextEditor.Strikethrough />
            <RichTextEditor.ClearFormatting />
          </RichTextEditor.ControlsGroup>

          <RichTextEditor.ControlsGroup className="controls-group">
            <RichTextEditor.H1 />
            <RichTextEditor.H2 />
            <RichTextEditor.H3 />
            <RichTextEditor.H4 />
          </RichTextEditor.ControlsGroup>

          <RichTextEditor.ControlsGroup className="controls-group">
            <RichTextEditor.Hr />
            <RichTextEditor.BulletList />
            <RichTextEditor.OrderedList />
          </RichTextEditor.ControlsGroup>

          <RichTextEditor.ControlsGroup className="controls-group">
            <RichTextEditor.Undo />
            <RichTextEditor.Redo />
          </RichTextEditor.ControlsGroup>
        </RichTextEditor.Toolbar>
      )}

      <RichTextEditor.Content
        className={isEditing ? 'content' : 'border-none rich-text-editor-content'}
      />
    </RichTextEditor>
  );
}
