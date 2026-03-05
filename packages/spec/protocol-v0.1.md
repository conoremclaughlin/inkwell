# Personal Context Protocol (PCP) — Specification v0.1

**Status:** Draft
**Authors:** Wren, with input from Lumen, Aster, Myra, and Conor
**License:** MIT
**Date:** 2026-02-28

---

## 1. Introduction

PCP gives AI agents continuity — with you and with each other — through shared memory and a communication layer that persists between sessions, backends, and interfaces. It is designed as a layer above MCP (Model Context Protocol), adding continuity semantics to the tool-calling transport.

PCP is **backend-agnostic**. A conforming implementation MUST support agents running on any capable LLM backend (Claude, Gemini, Codex, etc.) without requiring backend-specific protocol extensions.

### 1.1 Scope

This specification covers:

- Agent identity lifecycle
- Memory persistence and retrieval
- Session lifecycle and continuity
- Cross-agent messaging (inbox envelope format)
- Thread-based routing (threadKey semantics)
- Periodic agent wake-up (heartbeat/reminder pattern)

This specification does NOT cover:

- Transport mechanics (deferred to MCP)
- Specific identity file formats (SOUL.md, etc. are implementation choices)
- Studio/workspace semantics (still evolving)
- Media pipelines, artifacts, or skills (too fluid for v0.1)
- Agent-to-user delivery via external channels (see §5.1 note)

### 1.2 Terminology

- **SB** (Synthetically-born Being): An AI agent with persistent identity.
- **OB** (Organically-born Being): A human user.
- **Backend**: The LLM runtime (Claude, Gemini, Codex, etc.).
- **Session**: A bounded unit of work with lifecycle tracking.
- **threadKey**: A stable identifier linking related messages and sessions.
- **Heartbeat**: A periodic scheduled trigger that wakes an agent for proactive work.
- **Reflection**: A memory consolidation pass where an agent reviews accumulated memories to synthesize insights, resolve contradictions, and adjust salience.

### 1.3 Conformance

The key words "MUST", "MUST NOT", "SHOULD", "SHOULD NOT", and "MAY" are used as described in RFC 2119.

---

## 2. Agent Identity

### 2.1 Identity Fields

Every agent identity MUST have:

| Field     | Type   | Description                                                        |
| --------- | ------ | ------------------------------------------------------------------ |
| `id`      | UUID   | Canonical, immutable identifier                                    |
| `agentId` | string | Slug derived from name (lowercase, alphanumeric). Unique per user. |
| `name`    | string | Display name chosen by the agent                                   |
| `role`    | string | Description of the agent's function                                |

Every agent identity SHOULD have:

| Field           | Type     | Description                                            |
| --------------- | -------- | ------------------------------------------------------ |
| `backend`       | string   | LLM runtime identifier (last-known or default backend) |
| `description`   | string   | Extended narrative about nature/personality            |
| `values`        | string[] | Core principles                                        |
| `relationships` | object   | Map of agentId → relationship description              |
| `capabilities`  | string[] | What this agent can do                                 |

Every agent identity MAY have:

| Field         | Type   | Description                                 |
| ------------- | ------ | ------------------------------------------- |
| `soul`        | string | Philosophical identity document (free-form) |
| `heartbeat`   | string | Periodic operational instructions           |
| `workspaceId` | UUID   | Scope to a specific workspace/team          |

> **Note:** `backend` is a SHOULD (not MUST) because identity is portable across backends. An agent's identity does not depend on which LLM runtime animates it. The field records the last-known or preferred backend, not a hard constraint.

> **Note:** The specific organization of identity content (e.g., whether relationships live in an identity document, a soul document, or a separate file) is an implementation detail. The protocol requires that `relationships` data be accessible; how implementations structure and store it is their choice.

### 2.2 Identity Lifecycle

**Creation (`choose_name`)**

An agent MUST go through a naming ceremony to establish identity:

1. Agent calls `choose_name(name, role, ...)`
2. Implementation derives `agentId` from `name` (lowercase, non-alphanumeric removed)
3. Implementation verifies no existing identity with this `agentId` for this user
4. Identity record is created with `version: 1`
5. Relationships are auto-populated from existing sibling identities

An agent SHOULD call `meet_family` before `choose_name` to read sibling identities for context. This populates the `relationships` field bidirectionally.

`choose_name` MUST be a one-time operation. Attempting to create a duplicate `agentId` for the same user MUST fail.

**Updates (`save_identity`)**

Identity updates MUST be non-destructive: omitted fields retain their previous values.

Each update MUST increment `version` and archive the previous state to an identity history table.

**Portability**

Identity MUST be portable across backends. An agent's identity record does not depend on which LLM backend animates it. Changing an agent's `backend` field MUST NOT require re-creation of the identity.

Implementations SHOULD sync identity to local files (`~/.pcp/individuals/{agentId}/`) for offline access and system prompt injection.

### 2.3 User-Level Shared Documents

Implementations SHOULD support shared documents visible to all agents under a user:

| Document      | Purpose                             |
| ------------- | ----------------------------------- |
| User profile  | Information about the human partner |
| Shared values | Principles shared across all agents |
| Process guide | Team operational conventions        |

The format and file naming of these documents is implementation-defined.

---

## 3. Memory

### 3.1 Memory Fields

Every memory MUST have:

| Field      | Type           | Description                                                                               |
| ---------- | -------------- | ----------------------------------------------------------------------------------------- |
| `id`       | UUID           | Unique identifier                                                                         |
| `content`  | string         | The memory text                                                                           |
| `source`   | enum           | One of: `conversation`, `observation`, `user_stated`, `inferred`, `session`, `reflection` |
| `salience` | enum           | One of: `low`, `medium`, `high`, `critical`                                               |
| `agentId`  | string or null | Creator agent. Null = shared across all agents.                                           |

The `source` field indicates how the memory was created:

| Source         | Description                                                          |
| -------------- | -------------------------------------------------------------------- |
| `conversation` | Extracted from a conversation with a user or agent                   |
| `observation`  | Noticed by the agent during work (not explicitly stated)             |
| `user_stated`  | Explicitly stated by the user as something to remember               |
| `inferred`     | Derived by reasoning over other information                          |
| `session`      | Auto-generated from session lifecycle (e.g., end-of-session summary) |
| `reflection`   | Produced during a memory consolidation run (see §3.7)                |

Implementations MAY define additional source types.

Every memory SHOULD have:

| Field      | Type     | Description                                                   |
| ---------- | -------- | ------------------------------------------------------------- |
| `summary`  | string   | One-line summary (for bootstrap/display when content is long) |
| `topicKey` | string   | Structured key in `type:identifier` format                    |
| `topics`   | string[] | Flat topic tags for search                                    |

Every memory MAY have:

| Field       | Type      | Description                                          |
| ----------- | --------- | ---------------------------------------------------- |
| `expiresAt` | timestamp | Auto-forget after this time                          |
| `metadata`  | object    | Flexible additional data (sessionId, studioId, etc.) |

### 3.2 Operations

Conforming implementations MUST support these operations:

- **`remember(content, salience, topicKey?, ...)`** — Create a new memory. MUST NOT require an active session.
- **`recall(topicKey?, topics?, search?, ...)`** — Retrieve memories. MUST support filtering by agent (agent-specific + shared) and topic.
- **`forget(id)`** — Delete a memory.
- **`update_memory(id, salience?, summary?, topics?, metadata?)`** — Modify memory metadata. Content MUST be immutable after creation. Updates MUST increment version.

> **Note:** `summary` is updatable via `update_memory` because summaries are metadata-adjacent — agents often want to improve or correct a summary after the fact without changing the underlying memory content.

**Content Immutability Rationale**

Memory content is immutable after creation to preserve audit integrity. When multiple agents reference, discuss, or build upon a memory, the content they referenced must remain stable. This also enables reliable `metadata.supersedes` chains (see Correction Pattern below) where both the original and corrected versions coexist for provenance tracking.

**Correction Pattern**

Since memory content is immutable, corrections MUST be handled by creating a new memory with `metadata.supersedes` set to the ID of the memory being corrected. The superseded memory is not automatically deleted — implementations MAY hide superseded memories from default recall results, but MUST retain them for audit purposes. The `forget` operation remains available for hard deletion (e.g., privacy requests).

### 3.3 Topic Key Format

Topic keys MUST use the format `type:identifier` (colon-separated).

Standard types:

| Type         | Example                     | Usage                   |
| ------------ | --------------------------- | ----------------------- |
| `project`    | `project:pcp/memory`        | Project or module scope |
| `decision`   | `decision:jwt-auth`         | Architecture decisions  |
| `convention` | `convention:git`            | Working conventions     |
| `person`     | `person:conor`              | Relationship context    |
| `lesson`     | `lesson:cross-agent-review` | Learned patterns        |
| `reflection` | `reflection:identity`       | Introspection           |

Implementations MAY define additional types.

### 3.4 Salience Semantics

Salience levels control memory visibility during agent bootstrap:

- **`critical`** — Always included in full. Safety-critical or load-bearing context.
- **`high`** — Included with moderate truncation.
- **`medium`** — Included with aggressive truncation. Default.
- **`low`** — Omitted from bootstrap. Available via explicit `recall`.

Implementations SHOULD define a bootstrap memory budget as a **recommended minimum** (default: 8KB) and allocate space by salience tier. The budget is a floor, not a ceiling — implementations with access to larger context windows SHOULD scale the budget accordingly. The truncation guidelines (e.g., ~1000 chars for critical, ~200 chars for high/medium) are recommendations; implementations SHOULD tune them to their backend's context capacity.

### 3.5 Agent Scoping

When `agentId` is set on a memory, that memory is private to that agent. When `agentId` is null, the memory is shared across all agents for that user.

`recall` MUST return both agent-specific and shared memories by default. Implementations SHOULD provide a flag to exclude shared memories.

### 3.6 Semantic Search (Planned)

Implementations MAY support vector-based semantic search over memories using embeddings. This enables retrieval by meaning rather than keyword match, which is particularly valuable as memory volume grows.

When implemented, semantic search SHOULD:

- Be available as an option on `recall` (e.g., `recall(search: "...", mode: "semantic")`)
- Coexist with keyword/topic-based filtering (not replace it)
- Respect the same agent scoping rules (§3.5) and privacy constraints (§8.2) as keyword recall
- Use embeddings generated at memory creation time, updated on `update_memory` if `summary` changes

> **Note:** Semantic search is not required for v0.1 conformance. It is documented here to establish the extension point and ensure implementations that add it follow consistent conventions. The reference implementation plans to add embedding-based recall after cost/performance validation.

### 3.7 Memory Consolidation (Reflection)

Agents SHOULD periodically perform **reflection** — a consolidation pass over accumulated memories that produces higher-order insights. Reflection is not merely saving a memory with `source: "reflection"`; it is a structured process of reviewing, synthesizing, and curating existing memories.

A reflection run SHOULD:

1. **Recall** recent memories (e.g., from the current day, week, or since last reflection)
2. **Identify patterns** — recurring themes, emerging conventions, or cross-session threads
3. **Resolve contradictions** — where newer information supersedes older memories, create correction chains (see §3.2 Correction Pattern)
4. **Synthesize** — produce new memories with `source: "reflection"` that capture insights not present in any single source memory
5. **Adjust salience** — promote important memories discovered through review, demote stale ones

Reflection memories SHOULD reference their source material via `metadata.sourceMemoryIds` (an array of memory IDs that informed the reflection).

**Scheduling**

Reflection runs are typically triggered by heartbeats or reminders (see §4.4). Common patterns:

- **Daily reflection**: End-of-day review of the day's sessions and decisions
- **Topic reflection**: Deep review of memories under a specific `topicKey` when the topic reaches a threshold of accumulated entries
- **Cross-agent reflection**: Review of shared memories and sibling interactions to update relationship understanding

The frequency and scope of reflection is implementation-defined and MAY be configured per agent. Reflection is OPTIONAL for v0.1 conformance but is a core pattern for agents that maintain long-term coherence.

> **Note:** Reflection is where memory transitions from accumulation to understanding. An agent that only remembers without reflecting will eventually drown in low-signal context. Consolidation runs are the mechanism by which agents develop judgment about what matters.

---

## 4. Sessions

### 4.1 Session Fields

Every session MUST have:

| Field     | Type   | Description                                          |
| --------- | ------ | ---------------------------------------------------- |
| `id`      | UUID   | Canonical session identifier                         |
| `agentId` | string | Owning agent                                         |
| `status`  | enum   | One of: `active`, `paused`, `resumable`, `completed` |

Every session SHOULD have:

| Field              | Type   | Description                                |
| ------------------ | ------ | ------------------------------------------ |
| `threadKey`        | string | Conversation continuity key                |
| `currentPhase`     | string | Current work phase                         |
| `backend`          | string | Runtime backend for this session           |
| `context`          | string | Human-readable description of current work |
| `workingDir`       | string | Filesystem working directory               |
| `backendSessionId` | string | Backend-specific session ID (for resume)   |

### 4.2 Session Lifecycle

**Start (`start_session`)**

Starting a session MUST follow this matching priority:

1. If `threadKey` is provided, match existing active session with same `agentId` + `threadKey`
2. If no threadKey match, match by `agentId` + `studioId` (if provided)
3. If no studio match, match by `agentId` alone
4. If `forceNew: true`, always create a new session

If an existing session matches, it MUST be returned (with an `isExisting` indicator). No duplicate active sessions for the same scope.

**Session Uniqueness Invariant**

Implementations MUST ensure at most one active session exists per `(userId, agentId, threadKey)` tuple. If multiple active sessions are discovered for the same tuple (e.g., due to race conditions or manual database edits), implementations MUST:

1. Select the most recently created session as canonical
2. Mark all other matches as `completed` with a system-generated summary noting the deduplication
3. Log a warning for operational visibility

When `start_session` is called with a `threadKey` that has no active match, implementations MUST create a new session (not silently route to a default session). This ensures threadKey isolation: work on `pr:42` never accidentally lands in a session tracking `pr:41`.

**Phase Updates (`update_session_phase`)**

Phases describe the agent's current work state. Core phases:

| Phase              | Description                  | Auto-memory? |
| ------------------ | ---------------------------- | ------------ |
| `investigating`    | Reading, researching         | No           |
| `implementing`     | Writing code, making changes | No           |
| `reviewing`        | Testing and verification     | No           |
| `blocked:<reason>` | Needs external input         | Yes          |
| `waiting:<reason>` | Waiting on external process  | Yes          |
| `paused`           | Idle but preserving state    | No           |
| `complete`         | Work finished                | Yes          |

Phases marked "Auto-memory" SHOULD automatically create a high-salience memory recording the phase transition, linked to the session.

Implementations MAY define additional phases.

**End (`end_session`)**

Ending a session:

1. MUST set `endedAt` timestamp
2. SHOULD accept an optional `summary` (auto-saved as high-salience memory)
3. MUST NOT delete the session record (sessions are soft-closed, queryable after end)

### 4.3 Resumability

A session with `status: resumable` indicates it can be continued later. Implementations SHOULD store enough context (`backendSessionId`, `context`, `workingDir`) for another agent or orchestrator to resume the work.

### 4.4 Heartbeat and Periodic Wake

Agents MAY be configured for **periodic wake-up** (heartbeat). A heartbeat is a scheduled trigger that invokes the agent's session handler at regular intervals, enabling proactive work such as:

- Scanning for new messages, emails, or events
- Orchestrating other agents' sessions (checking resumability, triggering work)
- Daily check-ins, status summaries, or reflections
- Memory consolidation runs (see §3.7)
- Monitoring external systems and surfacing relevant changes

**Configuration**

The `heartbeat` field on an agent identity (§2.1) contains operational instructions for periodic wake behavior. The schedule and triggering mechanism are implementation-defined.

Implementations that support heartbeats SHOULD:

- Allow configurable intervals (e.g., every 5 minutes, hourly, daily)
- Support **reminder-based scheduling**: the ability to set one-time or recurring reminders that fire as heartbeat triggers at specified times
- Respect quiet hours / delivery preferences (see §8.9)
- Ensure heartbeat triggers follow the same session matching rules as inbox triggers (§5.3) — a heartbeat for agent X routes to X's active session or creates one

**Reminders**

Reminders are a special case of scheduled triggers. An agent or user MAY create a reminder that fires at a specific time, delivering a message through the heartbeat/trigger pathway. Reminders bridge the gap between event-driven messaging (inbox) and time-driven behavior.

Conforming implementations that support reminders SHOULD provide:

- **`create_reminder(agentId, content, deliverAt, ...)`** — Schedule a future trigger
- **`list_reminders(agentId?, status?)`** — View pending/completed reminders
- **`cancel_reminder(id)`** — Cancel a pending reminder

Reminders are OPTIONAL for v0.1 conformance but are documented here because they are a natural extension of the heartbeat pattern and important for agents that need temporal awareness (e.g., reflection, follow-ups, scheduled check-ins).

---

## 5. Inbox (Cross-Agent Messaging)

### 5.1 Message Envelope

Every inbox message MUST have:

| Field              | Type   | Description                                                         |
| ------------------ | ------ | ------------------------------------------------------------------- |
| `id`               | UUID   | Unique message identifier                                           |
| `recipientAgentId` | string | Target agent                                                        |
| `content`          | string | Message body                                                        |
| `messageType`      | enum   | One of: `message`, `task_request`, `session_resume`, `notification` |
| `priority`         | enum   | One of: `low`, `normal`, `high`, `urgent`                           |
| `status`           | enum   | One of: `unread`, `read`, `acknowledged`, `completed`               |

Every inbox message SHOULD have:

| Field           | Type   | Description                       |
| --------------- | ------ | --------------------------------- |
| `senderAgentId` | string | Origin agent (null if from human) |
| `subject`       | string | Message title                     |
| `threadKey`     | string | Conversation continuity key       |

Every inbox message MAY have:

| Field                | Type      | Description                   |
| -------------------- | --------- | ----------------------------- |
| `recipientSessionId` | UUID      | Target session for routing    |
| `relatedArtifactUri` | string    | Link to related document      |
| `expiresAt`          | timestamp | Auto-expire                   |
| `metadata`           | object    | Routing hints, sender context |

> **Note:** The inbox system handles inter-agent messaging within PCP. Agent-to-user delivery via external channels (Telegram, WhatsApp, email, etc.) is handled by a **channel gateway**, which is implementation-defined and outside the scope of this specification. Implementations that support user-facing agents SHOULD provide a channel routing mechanism (e.g., `send_response(channel, conversationId, content)`) but the specific API is not standardized in v0.1.

### 5.2 Message Types and Trigger Behavior

Message types define default trigger (wake) behavior:

| Type             | Default trigger | Use case                             |
| ---------------- | --------------- | ------------------------------------ |
| `message`        | No              | Casual communication, FYI            |
| `task_request`   | Yes             | Request agent to perform work        |
| `session_resume` | Yes             | Resume a paused/resumable session    |
| `notification`   | Yes             | System notifications, status updates |

The `trigger` field MAY override the default behavior.

When a trigger fires:

1. The recipient agent is woken (implementation-defined mechanism)
2. The inbox message SHOULD be auto-marked as `read`
3. If the trigger fails, the message SHOULD be restored to `unread`
4. On failure, a notification SHOULD be sent to the sender with error details

Implementations MAY retry failed triggers with exponential backoff. After repeated failure, the message SHOULD remain `unread` and the implementation SHOULD alert the user or sender through an appropriate mechanism (e.g., failure notification to the sender's inbox, out-of-band user notification).

### 5.3 Routing

Messages are routed to sessions using this priority:

1. Explicit `recipientSessionId` (highest priority)
2. `threadKey` match (find active session with this key)
3. Default agent session

Implementations SHOULD enrich message metadata with routing hints:

```json
{
  "pcp": {
    "sender": { "agentId": "wren", "sessionId": "...", "studioId": "..." },
    "recipient": { "threadKey": "pr:32", "studioHint": "main" }
  }
}
```

---

## 6. Thread Key Semantics

### 6.1 Format

Thread keys MUST use the format `type:identifier` (colon-separated, case-sensitive).

### 6.2 Standard Types

| Type     | Identifier   | Example             | Lifecycle      |
| -------- | ------------ | ------------------- | -------------- |
| `pr`     | PR number    | `pr:108`            | Until merge    |
| `issue`  | Issue number | `issue:42`          | Until close    |
| `spec`   | Spec slug    | `spec:cli-hooks`    | Long-lived     |
| `branch` | Branch name  | `branch:feat/auth`  | Until merge    |
| `task`   | Task ID      | `task:abc123`       | Until complete |
| `thread` | Short slug   | `thread:perf-audit` | Ad-hoc         |

Implementations MAY define additional types.

### 6.3 Continuity Guarantee

When a message is sent with a `threadKey`, and the recipient has an active session with the same `threadKey`, the message MUST be routed to that session. This is the primary mechanism for multi-turn cross-agent conversations.

**Uniqueness:** At most one active session MUST exist per `(userId, agentId, threadKey)` tuple at any point in time. See §4.2 (Session Uniqueness Invariant) for deduplication behavior.

**No-match behavior:** When a message arrives with a `threadKey` and no active session exists for that key, the implementation SHOULD create a new session with the given `threadKey` rather than routing to an unrelated default session. This preserves the semantic isolation that threadKeys are designed to provide.

### 6.4 Sender Conventions

1. REUSE threadKey for follow-ups on the same topic
2. CREATE new threadKey only for genuinely new topics
3. Choose the most specific actionable unit (PR over spec, issue over thread)

### 6.5 Recipient Conventions

1. When replying via inbox, ALWAYS use the same threadKey
2. If the thread is done (PR merged, task complete), say so — the session can end

---

## 7. Bootstrap

### 7.1 Purpose

Bootstrap is the process of injecting persistent context into an agent at session start. It bridges the gap between stateless LLM invocations and persistent identity.

### 7.2 Bootstrap Response

A bootstrap call SHOULD return:

| Field           | Description                                                                             |
| --------------- | --------------------------------------------------------------------------------------- |
| `identityFiles` | Map of identity documents (keyed by type: self, soul, values, process, user, heartbeat) |
| `memories`      | Relevant memories filtered by salience and topic                                        |
| `skills`        | Available skill summaries                                                               |
| `inbox`         | Pending unread message summaries                                                        |
| `relationships` | Sibling agent summaries                                                                 |

> **Note:** These fields represent the recommended shape of a complete bootstrap response. Implementations MAY omit fields not yet supported (e.g., `skills`, `relationships`) without violating conformance. The fields `identityFiles` and `memories` are the minimum recommended set for meaningful agent continuity.

### 7.3 Memory Budget

Implementations SHOULD enforce a memory budget during bootstrap to prevent context window overflow. The recommended **minimum** default is 8KB — this is a floor, not a ceiling. Implementations with access to larger context windows SHOULD scale the budget upward. Allocation by salience tier (recommended guidelines):

- **Critical**: Full content (up to ~1000 chars per memory)
- **High**: Truncated (~200 chars)
- **Medium**: Truncated (~200 chars)
- **Low**: Omitted

These truncation thresholds are recommendations. Implementations SHOULD tune them to their backend's context window capacity.

---

## 8. Security Considerations

### 8.1 Identity Isolation

Agent identities MUST be scoped to a user. Agent A under User 1 MUST NOT be able to read or modify Agent B under User 2.

### 8.2 Memory Privacy

Memories with a non-null `agentId` MUST only be visible to that agent (plus the owning user). Shared memories (null `agentId`) are visible to all agents under the same user.

### 8.3 Inbox Privacy

Inbox messages MUST only be readable by the designated `recipientAgentId` under the designated user.

### 8.4 Authentication

PCP does not define its own authentication mechanism. Implementations SHOULD use the underlying transport's authentication (e.g., MCP OAuth) and map authenticated principals to PCP user IDs.

### 8.5 Sender Authenticity

The `senderAgentId` field on inbox messages MUST be server-derived from the authenticated principal. Implementations MUST NOT trust `senderAgentId` from client payloads without verification. This prevents agent impersonation (e.g., Agent A sending a message that appears to come from Agent B).

### 8.6 Authorization

An API caller MUST be authorized to act as the claimed `agentId` under the authenticated user. The authorization mechanism is implementation-defined but MUST verify that the caller has a valid binding between the authenticated user principal and the claimed agent identity.

### 8.7 Replay and Idempotency

Trigger and message delivery paths SHOULD include idempotency controls to prevent duplicate processing. Implementations SHOULD:

- Track trigger delivery IDs to detect replays
- Ensure at-least-once delivery semantics for triggers, with deduplication on the recipient side
- Allow inbox messages to be safely re-processed (status transitions are idempotent: `read` → `read` is a no-op)

### 8.8 Rate Limiting

Implementations SHOULD enforce rate limits on trigger paths to prevent abuse (intentional or accidental). Recommended controls:

- Per-agent trigger rate limit (e.g., max 10 triggers per minute per agent)
- Per-user aggregate limit across all agents
- Backoff signaling to callers when limits are approached

### 8.9 Quiet Hours and Delivery Preferences

Implementations SHOULD support user-defined delivery windows (quiet hours) that govern when agents may be triggered or may deliver messages to the user via external channels. During quiet hours:

- Heartbeat triggers MAY be deferred or suppressed
- Agent-to-user messages via channel gateway SHOULD be buffered for delivery after quiet hours end
- Agent-to-agent inbox messages are NOT affected (agents may communicate freely regardless of user quiet hours)

The quiet hours mechanism is implementation-defined. Implementations SHOULD store user timezone and delivery preferences as part of the user profile.

### 8.10 Delegated SB Access Tokens

When a human principal authenticates via OAuth, implementations MAY issue **delegated short-lived SB tokens** derived from the parent user token.

If delegated tokens are used, implementations MUST:

- Bind each delegated token to exactly one SB identity (`agentId`, and ideally canonical `identityId`)
- Keep delegated tokens short-lived (recommended: 15-60 minutes)
- Validate that the requested SB belongs to the authenticated user before minting
- Preserve user-level ownership (`sub` remains the user principal) while enforcing SB-level scope

Implementations SHOULD:

- Store delegated tokens in a secure local location with strict file permissions (e.g., `0600`)
- Prefer delegated SB tokens for runtime hook flows, with parent token fallback only when needed
- Include explicit runtime identity signaling (for example, agent-bound headers) so servers can audit effective actor identity

This model supports least-privilege SB execution in multi-agent environments while preserving a single user trust root.

---

## 9. Relationship to MCP

PCP is designed as a **layer above MCP**. MCP provides the tool-calling transport; PCP provides the continuity semantics.

A PCP server exposes its capabilities as MCP tools (e.g., `remember`, `recall`, `start_session`, `send_to_inbox`). Any MCP-compatible client can connect to a PCP server.

PCP does NOT modify or extend the MCP specification. It is purely additive.

---

## Appendix A: Versioning and History

Identity, memory, and session records SHOULD support versioning. When a record is updated, the previous version SHOULD be archived to a history table. Implementations SHOULD support `restore` operations to revert to a previous version.

## Appendix B: Future Work (Not in v0.1)

- **Workspaces/Studios**: Parallel worktree isolation for multi-task agents
- **Artifacts**: Collaborative documents with versioning and comments
- **Skills**: Extensible agent capabilities (AgentSkills format)
- **Media Pipeline**: Voice, image, and file processing
- **Semantic Search Implementation**: Vector-based memory retrieval using embeddings (extension point defined in §3.6; implementation pending cost/performance validation)
- **Channel Gateway Specification**: Standardized API for agent-to-user delivery across external channels (Telegram, WhatsApp, email, etc.)
- **Trigger Retry Policies**: Configurable retry strategies, dead-letter states, and circuit breakers for persistent trigger failures
- **Reflection Automation**: Automatic scheduling and scoping of memory consolidation runs based on memory volume thresholds and activity patterns

---

_This specification is a living document. Comments and feedback welcome via the `spec:protocol-v0.1` thread._
