const MESSAGE_TTL_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
const MAX_MESSAGES_PER_CHAT = 100;
const MAX_CHATS = 256;

/**
 * In-memory context only. Quiet chats expire without further traffic; chat and
 * message counts are bounded even when many distinct chats arrive within the TTL.
 */
export class EphemeralMessageCache<T extends { chatId: string; timestamp: Date }> {
  private readonly chats = new Map<string, T[]>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;
  private acceptingMessages = true;

  start(): void {
    this.acceptingMessages = true;
  }

  stop(): void {
    this.acceptingMessages = false;
    this.chats.clear();
    this.stopTimerIfEmpty();
  }

  add(message: T): void {
    const now = Date.now();
    if (!this.acceptingMessages || !this.isFresh(message, now)) return;

    const messages = this.pruneChat(message.chatId, now);
    if (!this.chats.has(message.chatId) && this.chats.size >= MAX_CHATS) {
      this.sweep(now);
      if (this.chats.size >= MAX_CHATS) {
        const oldest = this.chats.keys().next().value;
        if (oldest !== undefined) this.chats.delete(oldest);
      }
    }
    messages.push(message);
    if (messages.length > MAX_MESSAGES_PER_CHAT) messages.shift();
    this.touch(message.chatId, messages);

    if (!this.sweepTimer) {
      this.sweepTimer = setInterval(() => this.sweep(Date.now()), SWEEP_INTERVAL_MS);
      this.sweepTimer.unref();
    }
  }

  getRecent(chatId: string, limit = 50): T[] {
    const messages = this.pruneChat(chatId, Date.now());
    if (messages.length) this.touch(chatId, messages);
    this.stopTimerIfEmpty();
    return messages.slice(-limit);
  }

  delete(chatId: string): void {
    this.chats.delete(chatId);
    this.stopTimerIfEmpty();
  }

  getStats(): { chatCount: number; totalMessages: number } {
    let totalMessages = 0;
    for (const messages of this.chats.values()) totalMessages += messages.length;
    return { chatCount: this.chats.size, totalMessages };
  }

  private isFresh(message: T, now: number): boolean {
    return now - message.timestamp.getTime() < MESSAGE_TTL_MS;
  }

  private touch(chatId: string, messages: T[]): void {
    // Map insertion order is the LRU order, updated on both reads and writes.
    this.chats.delete(chatId);
    this.chats.set(chatId, messages);
  }

  private pruneChat(chatId: string, now: number): T[] {
    const messages = this.chats.get(chatId);
    if (!messages) return [];
    const fresh = messages.filter((message) => this.isFresh(message, now));
    if (fresh.length) this.chats.set(chatId, fresh);
    else this.chats.delete(chatId);
    return fresh;
  }

  private sweep(now: number): void {
    for (const chatId of this.chats.keys()) this.pruneChat(chatId, now);
    this.stopTimerIfEmpty();
  }

  private stopTimerIfEmpty(): void {
    if (this.chats.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
  }
}
