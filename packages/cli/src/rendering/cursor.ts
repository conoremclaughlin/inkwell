/**
 * Cursor type — point + visibility.
 * Inferred from usage in Claude Code fork's renderer/frame types.
 */

export type Cursor = {
  x: number;
  y: number;
  visible: boolean;
};
