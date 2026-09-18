# SessionService Refactor Plan

## Overview

Refactor from stateful `SessionHost` singleton to stateless `SessionService` that resolves all context from the database per-request. This enables:

- Multi-user support (thousands of users)
- Horizontal scaling (stateless servers)
- Clean separation of concerns
- Consistent session management across all trigger types

## Current Architecture (SessionHost)

```
┌─────────────────────────────────────────┐
│            SessionHost                   │
│  (Stateful singleton per process)        │
├─────────────────────────────────────────┤
│  - this.sbSlug (hardcoded)             │
│  - this.backendManager (long-lived)     │
│  - this.contextCache (in-memory)        │
│  - this.currentSessionId                │
│  - this.agentOwnerUserId                │
└─────────────────────────────────────────┘
```

**Problems:**

- Single agent per process
- In-memory state doesn't scale
- Can't serve multiple users
- Tight coupling between session and process lifecycle

## Target Architecture (SessionService)

```
┌─────────────────────────────────────────────────────────────────┐
│                       SessionService                             │
│                    (Stateless service)                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  handleMessage(request: SessionRequest): Promise<SessionResult>  │
│                                                                  │
│  Where SessionRequest contains:                                  │
│    - userId: string (from auth)                                  │
│    - sbSlug: string (which SB to invoke)                       │
│    - channel: string (telegram, agent, api, etc.)               │
│    - conversationId: string                                      │
│    - content: string                                             │
│    - metadata?: { ... }                                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Per-Request Flow                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Resolve Session Context                                      │
│     ├─ Query sessions table for (userId, sbSlug)               │
│     ├─ Query agent_identities for agent config                  │
│     ├─ Query users for timezone, contacts                       │
│     └─ Determine: resume existing or create new                 │
│                                                                  │
│  2. Build Agent Context                                          │
│     ├─ Load identity (from agent_identities.soul, .heartbeat)   │
│     ├─ Load recent memories (filtered by sbSlug)               │
│     ├─ Load active projects/focus                               │
│     └─ Build temporal context (time in user's timezone)         │
│                                                                  │
│  3. Spawn Claude Code Process                                    │
│     ├─ --resume <claude_session_id> if exists                   │
│     ├─ --session-id <new-uuid> if new session                   │
│     ├─ --append-system-prompt (identity override)               │
│     ├─ --print (non-interactive)                                │
│     └─ --output-format stream-json                              │
│                                                                  │
│  4. Process Message                                              │
│     ├─ Send formatted message with injected context             │
│     ├─ Stream response, parse tool calls                        │
│     ├─ Persist activity to activity_stream                      │
│     └─ Handle send_response for channel routing                 │
│                                                                  │
│  5. Update Session State                                         │
│     ├─ Persist claude_session_id if newly captured              │
│     ├─ Update token counts from usage stats                     │
│     ├─ Trigger compaction if threshold reached                  │
│     └─ Mark session completed if task agent finished            │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Key Interfaces

```typescript
// ─── Request/Response Types ───

interface SessionRequest {
  // Auth context (required)
  userId: string;
  sbSlug: string;

  // Message context
  channel: ChannelType;
  conversationId: string;
  sender: { id: string; name: string };
  content: string;

  // Optional metadata
  metadata?: {
    replyToMessageId?: string;
    chatType?: 'direct' | 'group' | 'supergroup';
    media?: MediaAttachment[];
    triggerType?: 'message' | 'heartbeat' | 'agent' | 'api';
  };
}

interface SessionResult {
  success: boolean;
  sessionId: string; // PCP session ID
  claudeSessionId: string; // Claude Code session ID

  // Response routing (if send_response was called)
  responses?: Array<{
    channel: string;
    conversationId: string;
    content: string;
  }>;

  // Usage stats
  usage?: {
    contextTokens: number;
    inputTokens: number;
    outputTokens: number;
  };

  // Errors
  error?: string;
}

// ─── Session Types ───

type SessionType = 'primary' | 'task';

interface Session {
  id: string;
  userId: string;
  sbSlug: string;
  claudeSessionId: string | null;

  type: SessionType;
  status: 'active' | 'paused' | 'completed';

  // For task sessions
  taskDescription?: string;
  parentSessionId?: string;

  // Token tracking for compaction
  contextTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;

  // Timestamps
  startedAt: Date;
  lastActivityAt: Date;
  endedAt: Date | null;
}

// ─── Service Interface ───

interface ISessionService {
  /**
   * Handle an incoming message for a user+agent pair.
   * Resolves session, spawns Claude, processes message, updates state.
   */
  handleMessage(request: SessionRequest): Promise<SessionResult>;

  /**
   * Get or create a session for a user+agent pair.
   * Primary SBs get infinite sessions; task agents get finite ones.
   */
  getOrCreateSession(
    userId: string,
    sbSlug: string,
    options?: { type?: SessionType; taskDescription?: string }
  ): Promise<Session>;

  /**
   * Trigger compaction for a session approaching context limit.
   * Sends compaction prompt, waits for agent to persist context,
   * then rotates to fresh Claude session.
   */
  triggerCompaction(sessionId: string): Promise<void>;

  /**
   * End a session (for task agents or explicit termination).
   * Persists final summary, marks session completed.
   */
  endSession(sessionId: string, summary?: string): Promise<void>;

  /**
   * List active sessions for a user.
   */
  listSessions(
    userId: string,
    options?: {
      sbSlug?: string;
      status?: Session['status'];
      type?: SessionType;
    }
  ): Promise<Session[]>;
}
```

## Database Schema Updates

### sessions table (existing, needs updates)

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'primary';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS task_description TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS parent_session_id UUID REFERENCES sessions(id);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS context_tokens INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_input_tokens INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS total_output_tokens INTEGER DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ DEFAULT NOW();

-- Index for efficient lookups
CREATE INDEX IF NOT EXISTS idx_sessions_user_agent_active
  ON sessions(user_id, agent_id)
  WHERE ended_at IS NULL;
```

### Deprecate agent_sessions table

The `agent_sessions` table appears to be legacy. After migration:

- Migrate any needed data to `sessions`
- Drop the table

## Migration Path

### Phase 1: SessionService alongside SessionHost

1. Create `src/services/sessions/` directory
2. Implement `SessionService` with same interface
3. Add feature flag to switch between them
4. Run both in parallel, compare behavior

### Phase 2: Migrate Callers

1. Update heartbeat to use SessionService
2. Update ChannelGateway message handler
3. Update agent trigger handlers
4. Update any HTTP API endpoints

### Phase 3: Remove SessionHost

1. Remove SessionHost class
2. Remove in-memory caching
3. Clean up unused code

### Phase 4: Optimize

1. Add connection pooling for Claude Code processes
2. Add caching layer (Redis) for hot session data
3. Add metrics and monitoring

## File Structure

```
src/services/sessions/
├── index.ts                 # Public exports
├── session-service.ts       # Main service implementation
├── session-repository.ts    # Database operations
├── context-builder.ts       # Build injected context for agent
├── claude-runner.ts         # Spawn/manage Claude Code process
├── response-router.ts       # Route send_response to channels
├── compaction-handler.ts    # Handle context window rotation
├── types.ts                 # Shared types
└── __tests__/
    ├── session-service.test.ts
    ├── context-builder.test.ts
    └── claude-runner.test.ts
```

## Open Questions

1. **Process pooling**: Should we pool Claude Code processes for performance, or spawn fresh each time for isolation?

2. **Concurrent messages**: What happens if two messages arrive for the same session simultaneously? Queue? Reject? Merge?

3. **Long-running responses**: If Claude takes 2+ minutes to respond, how do we handle timeouts and recovery?

4. **Compaction during message**: What if compaction threshold is reached mid-message? Complete message first, then compact?

5. **Cross-agent communication**: When Wren sends to Myra's inbox, does Myra's session wake immediately or on next heartbeat?

## Next Steps

1. [x] Create `src/services/sessions/` directory structure
2. [x] Define types in `types.ts`
3. [x] Implement `SessionRepository` for database operations
4. [x] Implement `ContextBuilder` for agent context
5. [x] Implement `ClaudeRunner` for process management
6. [x] Implement `SessionService` orchestrating the above
7. [x] ~~Add feature flag and parallel running~~ (skipped - direct migration)
8. [ ] Write tests
9. [x] Migrate callers (src/server.ts now uses SessionService)
10. [ ] Remove old SessionHost (kept for reference, deprecated)

## Migration Status: COMPLETE (2026-02-04)

The PCP server (`src/server.ts`) now uses SessionService for:

- Stateless message handling (queries DB per-request)
- Horizontal scaling ready (no in-memory state)
- Response routing through ChannelGateway
- Heartbeat reminders via SessionService.handleMessage()

Old SessionHost is deprecated but kept for reference.
