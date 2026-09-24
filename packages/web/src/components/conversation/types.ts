/**
 * A conversation, as every chat surface renders it — thread messages today,
 * a live runtime transcript later. Nothing here knows where a message came
 * from or how it arrived (polled, pushed, streamed): each source maps its own
 * payload into these shapes, and the components render only these.
 */

export type AuthorKind = 'sb' | 'user' | 'system';

export interface ConversationAuthor {
  kind: AuthorKind;
  /**
   * Stable handle for grouping consecutive messages and picking an avatar
   * colour: an SB's slug, a person's id (or 'user' while the server cannot
   * name one), 'system'.
   */
  id: string;
  /** Display name. The viewer's own messages read "You". */
  name: string;
  /** The viewer wrote it. */
  isOwn: boolean;
}

export interface ConversationMessage {
  id: string;
  author: ConversationAuthor;
  /** Markdown. */
  body: string;
  /** ISO timestamp. */
  createdAt: string;
  /**
   * What kind of message this is, when that is worth showing: 'task_request',
   * 'notification', 'session_resume'. Plain messages leave it unset.
   * Events ("thread closed") are `author.kind === 'system'`.
   */
  label?: string;
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  /** The body is still arriving; the row shows a caret and the view keeps pace. */
  streaming?: boolean;
}
