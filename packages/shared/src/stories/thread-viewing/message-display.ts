/**
 * How one message presents itself, whatever draws it.
 *
 * Folding: past either limit a body starts folded and the reader opens what
 * they want, so one pasted log does not push the rest of the conversation
 * off the screen. A message still streaming never folds, so the reader can
 * watch it arrive.
 */

/** Bodies longer than this many characters start folded. */
export const FOLD_CHARS = 1_600;
/** Bodies with more lines than this start folded. */
export const FOLD_LINES = 28;

export function shouldFold(body: string): boolean {
  if (body.length > FOLD_CHARS) return true;
  let lines = 1;
  for (const ch of body) if (ch === '\n' && ++lines > FOLD_LINES) return true;
  return false;
}

const MESSAGE_LABELS: Readonly<Record<string, string>> = {
  task_request: 'task request',
  notification: 'notification',
  session_resume: 'resume',
  permission_grant: 'permission',
};

/** A message's type as its header names it: 'task_request' → 'task request'. */
export function messageLabel(label: string): string {
  return MESSAGE_LABELS[label] ?? label.replace(/_/g, ' ');
}
