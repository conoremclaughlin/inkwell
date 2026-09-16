/**
 * Telegram chat id validation.
 *
 * The Bot API only accepts numeric chat ids (negative for groups/channels)
 * or @usernames. Agents in proactive sessions have occasionally guessed
 * symbolic ids ("myra-telegram"), which Telegram rejects with an opaque
 * "Bad Request: chat not found". Failing fast with a recovery hint turns
 * that into a deterministic one-step correction for the calling agent.
 */

const NUMERIC_CHAT_ID_RE = /^-?\d+$/;
// Telegram usernames: 5-32 chars, letters/digits/underscores.
const USERNAME_CHAT_ID_RE = /^@[A-Za-z0-9_]{5,32}$/;

/**
 * Returns an actionable error message when the chat id cannot be a real
 * Telegram chat id, or null when it is plausibly valid.
 *
 * Accepts the `telegram:<chatId>` conversation-id form — every downstream
 * TelegramListener send method strips that prefix itself, so validation must
 * judge the id the listener will actually use, not the wrapper.
 */
export function validateTelegramChatId(chatId: string): string | null {
  const normalized = chatId.startsWith('telegram:') ? chatId.slice('telegram:'.length) : chatId;
  if (NUMERIC_CHAT_ID_RE.test(normalized) || USERNAME_CHAT_ID_RE.test(normalized)) {
    return null;
  }
  return (
    `Invalid Telegram chat id "${chatId}" — Telegram requires a numeric chat id ` +
    `(e.g. "123456789") or an @username. Do not guess symbolic names: look up the ` +
    `real chat id from conversation history (get_conversation_history) or the ` +
    `conversation's platform id, then retry send_response with that id.`
  );
}
