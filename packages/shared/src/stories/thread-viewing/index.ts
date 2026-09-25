/**
 * The thread-viewing story: one thread, read as a conversation.
 *
 * - conversation: the shapes every chat surface renders (thread messages
 *   today, a live runtime transcript later).
 * - authors: who wrote a thread message, as the viewer sees them.
 * - timeline: day dividers, the new-messages divider, and grouping.
 * - history: the thread's messages kept whole across polls, gaps and older
 *   pages; useThreadHistory runs it.
 * - message-display, time-labels: how one message and its time read.
 * - markdown: a body parsed into a tree any non-DOM renderer can draw.
 *
 * Drawing any of it (DOM, React Native, a terminal) belongs to the client.
 */

export * from './conversation.js';
export * from './authors.js';
export * from './sender-label.js';
export * from './time-labels.js';
export * from './timeline.js';
export * from './history.js';
export * from './message-display.js';
export * from './markdown.js';
export * from './use-thread-history.js';
