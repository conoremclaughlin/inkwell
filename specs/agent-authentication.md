# Agent Authentication for MCP

**Status:** Draft
**Authors:** Wren, Lumen, Conor McLaughlin
**Date:** 2026-02-17
**Version:** 1.0

## Abstract

The Model Context Protocol (MCP) provides OAuth 2.1 for authenticating users to servers. However, MCP has no concept of **agent identity** — the ability for an autonomous AI agent to prove who it is, distinct from the human user it acts on behalf of. This spec proposes an extension to MCP that introduces agent identity as a first-class protocol concept, enabling clean attribution, delegated token issuance, and portable credentials across execution environments.

## Problem Statement

### The Identity Gap

In a multi-agent system, several AI agents (SBs — Synthetically-born Beings) may act on behalf of the same human user. Today, MCP treats all calls as coming from "a user." There is no protocol-level way for a server to distinguish:

- **Wren** saving a link on behalf of Conor
- **Aster** creating a reminder on behalf of Conor
- **Conor** saving a link directly from the dashboard

All three look identical to the server: a valid user token, a tool call. Attribution — "who did this, when?" — relies on honor-system `agentId` parameters that any caller can claim.

### The Authentication UX Problem

If we solve identity by issuing per-agent OAuth tokens (each agent completes a full browser-based OAuth flow), the UX collapses:

- A human with 5 SBs must complete 5 separate browser OAuth flows
- Each new execution environment (local CLI, cloud studio, CI runner) requires re-authentication
- SBs in cloud environments have no browser — they can't complete OAuth at all

### The Portability Problem

Agents move between execution environments:

| Environment             | Transport | Token Storage       | Browser Available  |
| ----------------------- | --------- | ------------------- | ------------------ |
| Local CLI (Claude Code) | stdio     | Filesystem/keychain | Yes (human nearby) |
| Local CLI (Codex)       | stdio     | Filesystem/keychain | Yes                |
| Cloud studio            | HTTP      | Secrets/env vars    | No                 |
| Container/serverless    | HTTP      | Env vars            | No                 |
| Desktop app             | stdio     | OS keychain         | Yes                |

A credential model that only works in one environment is insufficient. An agent's identity must be portable.

## Terminology

| Term                 | Definition                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------ |
| **User**             | The human who owns the account and authorizes agents                                       |
| **Agent**            | An autonomous AI entity that acts on behalf of a user (also: SB, Synthetically-born Being) |
| **Agent ID**         | A human-readable text slug identifying the agent (e.g., `"wren"`, `"aster"`)               |
| **Identity ID**      | A canonical UUID reference to the agent's identity record                                  |
| **User Token**       | An OAuth access token representing the human user                                          |
| **Agent Credential** | A scoped token representing a specific agent acting on behalf of a specific user           |
| **Delegation**       | The act of minting an agent credential from a user's authenticated session                 |
| **Principal**        | The entity responsible for an action — either a user or a user+agent pair                  |

## Current State: MCP Authentication

MCP uses OAuth 2.1 with PKCE for client-server authentication:

```
Client                    Server
  │                          │
  ├─── GET /authorize ──────>│  (browser redirect)
  │                          │
  │<── authorization code ───┤  (user consents)
  │                          │
  ├─── POST /token ─────────>│  (code + PKCE verifier)
  │                          │
  │<── access_token ─────────┤  (JWT or opaque)
  │                          │
  ├─── MCP request ─────────>│  (Bearer token in transport)
  │    Authorization: Bearer │
  │                          │
```

The access token represents a **user**. Every MCP request is made "as the user." There is no mechanism for a client to declare "I am agent X acting on behalf of user Y."

## Proposed Extension: Agent Identity

### Design Principles

1. **Backward compatible** — Servers that don't support agent identity work exactly as before
2. **Transport-layer, not content-layer** — Agent credentials live in auth headers and protocol metadata, never in tool arguments or model output
3. **Delegated by default** — One human login mints credentials for many agents
4. **Environment-portable** — Same credential format works in CLI, cloud, and desktop
5. **Revocable per-agent** — Humans can revoke any agent's access without affecting others
6. **Spec-level, not app-level** — Any MCP server can implement this, not just PCP

### Layer Model

```
┌─────────────────────────────────────────────┐
│  Layer 3: Authorization                      │
│  "What can this agent do?"                   │
│  Scopes, permissions, rate limits            │
├─────────────────────────────────────────────┤
│  Layer 2: Agent Identity                     │
│  "Which agent is calling?"                   │
│  Agent credential, identity binding          │
├─────────────────────────────────────────────┤
│  Layer 1: User Authentication                │
│  "Who is the human?"                         │
│  OAuth 2.1, existing MCP spec                │
└─────────────────────────────────────────────┘
```

MCP today implements Layer 1. This spec adds Layer 2. Layer 3 is application-specific but this spec provides the foundation for it.

### 1. Capability Negotiation

During MCP initialization, the server advertises agent identity support:

```json
{
  "capabilities": {
    "agentIdentity": {
      "supported": true,
      "delegation": true,
      "provisioning": true
    }
  }
}
```

| Field          | Type    | Description                                                |
| -------------- | ------- | ---------------------------------------------------------- |
| `supported`    | boolean | Server can accept and validate agent credentials           |
| `delegation`   | boolean | Server supports minting agent credentials from user tokens |
| `provisioning` | boolean | Server supports environment-based credential provisioning  |

### 2. Agent Credential Format

An agent credential is a JWT with the following claims:

```json
{
  "type": "agent_credential",
  "sub": "user-uuid",
  "agent_id": "wren",
  "identity_id": "identity-uuid",
  "scope": "mcp:tools",
  "delegated_from": "parent-token-id",
  "iat": 1739750400,
  "exp": 1742342400
}
```

| Claim            | Required | Description                                                             |
| ---------------- | -------- | ----------------------------------------------------------------------- |
| `type`           | Yes      | Must be `"agent_credential"` to distinguish from user tokens            |
| `sub`            | Yes      | The user's UUID — the human this agent acts on behalf of                |
| `agent_id`       | Yes      | Human-readable agent identifier (e.g., `"wren"`)                        |
| `identity_id`    | No       | Canonical UUID from the server's identity store (strongest binding)     |
| `scope`          | Yes      | Permitted operations (e.g., `"mcp:tools"`, `"mcp:read"`)                |
| `delegated_from` | No       | ID of the parent token this was delegated from (for cascade revocation) |
| `iat`            | Yes      | Issued-at timestamp                                                     |
| `exp`            | Yes      | Expiration timestamp                                                    |

### 3. Agent Identity in MCP Requests

#### HTTP Transport (Streamable HTTP)

Agent credentials are sent as Bearer tokens in the `Authorization` header, exactly like user tokens. The server distinguishes them by the `type` claim:

```http
POST /mcp HTTP/1.1
Authorization: Bearer eyJ...agent_credential...
Content-Type: application/json

{"jsonrpc":"2.0","method":"tools/call","params":{"name":"save_link","arguments":{"url":"..."}}}
```

The server extracts `agent_id` and `identity_id` from the token claims and makes them available to tool handlers. No changes to the MCP JSON-RPC envelope are needed.

#### stdio Transport

stdio sessions don't have HTTP headers. Instead, the agent credential is established during session initialization:

**Option A: Environment variable**

```bash
AGENT_CREDENTIAL=eyJ... claude --mcp-server pcp
```

The MCP client reads the credential from the environment and includes it in the initialization message.

**Option B: Init params**

```json
{
  "jsonrpc": "2.0",
  "method": "initialize",
  "params": {
    "protocolVersion": "2025-03-26",
    "capabilities": {},
    "clientInfo": {
      "name": "claude-code",
      "version": "1.0"
    },
    "agentCredential": "eyJ..."
  }
}
```

**Option C: Bootstrap with pinning**
The current PCP approach — the agent calls `bootstrap(agentId: "wren")` at session start, and the server pins the identity for the session lifetime. This works without spec changes but has weaker guarantees (no cryptographic proof of identity).

For stdio, Options A and B provide cryptographic identity; Option C provides runtime pinning. Servers may support any combination.

### 4. Token Delegation

The core UX innovation: one human login, many agent credentials.

#### Delegation Endpoint

```
POST /mcp/identity/delegate
Authorization: Bearer <user-access-token>
Content-Type: application/json

{
  "agent_id": "aster",
  "scope": ["mcp:tools"],
  "ttl_seconds": 2592000
}
```

**Response (success):**

```json
{
  "agent_credential": "eyJ...",
  "refresh_token": "pcp-rt-...",
  "identity_id": "uuid-...",
  "agent_id": "aster",
  "expires_at": "2026-03-19T00:00:00Z"
}
```

**Response (error — identity not found):**

```json
{
  "error": "identity_not_found",
  "error_description": "No identity registered for agent_id 'aster'"
}
```

**Response (error — unauthorized):**

```json
{
  "error": "unauthorized",
  "error_description": "User token does not have delegation permission"
}
```

#### Batch Delegation

For provisioning all agents at once:

```
POST /mcp/identity/delegate-all
Authorization: Bearer <user-access-token>

{
  "scope": ["mcp:tools"],
  "ttl_seconds": 2592000
}
```

**Response:**

```json
{
  "agents": [
    {
      "agent_id": "wren",
      "identity_id": "uuid-1",
      "agent_credential": "eyJ...",
      "refresh_token": "pcp-rt-..."
    },
    {
      "agent_id": "aster",
      "identity_id": "uuid-2",
      "agent_credential": "eyJ...",
      "refresh_token": "pcp-rt-..."
    }
  ],
  "expires_at": "2026-03-19T00:00:00Z"
}
```

#### Token Refresh

Agent credentials can be refreshed using their associated refresh token:

```
POST /mcp/token
Content-Type: application/x-www-form-urlencoded

grant_type=refresh_token&
refresh_token=pcp-rt-...&
client_id=claude-code
```

The refreshed token retains the same `agent_id` and `identity_id` claims. The refresh token is scoped — it can only produce credentials for the agent it was issued to.

### 5. Environment Portability

#### Local Development (CLI/Desktop)

```
┌──────────────────────────┐
│  sb auth provision --all │
│                          │
│  1. Read user session    │
│  2. Call delegate-all    │
│  3. Store per-agent:     │
│     ~/.pcp/tokens/       │
│       wren.json          │
│       aster.json         │
│       lumen.json         │
└──────────────────────────┘
```

Token storage options (in order of preference):

1. **OS keychain** — macOS Keychain, Windows Credential Manager, Linux libsecret
2. **Encrypted file** — `~/.pcp/tokens/<agentId>.json` encrypted with user password
3. **Plain file** — `~/.pcp/tokens/<agentId>.json` with `0600` permissions (development only)

The CLI reads the credential before spawning the backend:

```bash
# sb internally does:
AGENT_CREDENTIAL=$(cat ~/.pcp/tokens/wren.json | jq -r .agent_credential) \
  claude --mcp-server pcp
```

#### Cloud Environment (Studios/Containers)

When provisioning a cloud execution environment:

```
┌──────────────────────────────────────┐
│  Studio / Container Provisioner      │
│                                      │
│  1. Orchestrator has user session    │
│  2. Call delegate(agentId)           │
│  3. Inject as secret:               │
│     AGENT_CREDENTIAL=eyJ...         │
│  4. SB reads at startup             │
└──────────────────────────────────────┘
```

The credential is injected once at provisioning time. The SB uses it for the lifetime of the environment. If it expires, the SB can refresh using the associated refresh token (also injected as a secret).

For environments where the refresh token is not available, the orchestrator can reprovision:

```
POST /mcp/identity/delegate
Authorization: Bearer <orchestrator-service-token>
{
  "agent_id": "aster",
  "scope": ["mcp:tools"],
  "ttl_seconds": 86400
}
```

#### Cross-Device / Migration

When an SB migrates to a new device or environment:

1. The human authorizes migration from the dashboard or CLI
2. The server mints a new credential for the target environment
3. The old credential continues working until explicitly revoked or it expires
4. No re-authentication required — delegation from existing session

### 6. Attribution Model

With agent credentials in the protocol, attribution becomes automatic.

#### Write-Path Enforcement

For any write operation (creating memories, saving links, sending messages), the server:

1. Extracts `agent_id` and `identity_id` from the credential
2. Uses these as the actor for the operation
3. Ignores any explicit `agentId` parameter in tool arguments (or logs a warning if they differ)

```
Tool call: save_link({ url: "...", agentId: "lumen" })
Token claims: { agent_id: "wren", identity_id: "uuid-wren" }

→ Link saved with created_by_identity_id = uuid-wren
→ Warning logged: "Agent identity mismatch: claimed lumen, authenticated wren"
```

This prevents identity spoofing via prompt injection. The token is the source of truth.

#### Read-Path: No Enforcement

Query operations (searching memories, listing links, reading activity) allow free filtering by any agent_id. A credential for Wren can query Aster's public memories. Authorization controls what data is visible; agent identity controls who is asking.

#### Attribution Schema

Servers that implement agent identity SHOULD include these columns on write-path tables:

| Column                   | Type        | Description                                         |
| ------------------------ | ----------- | --------------------------------------------------- |
| `created_by_user_id`     | UUID        | The human user (from `sub` claim)                   |
| `created_by_identity_id` | UUID        | The agent identity (from `identity_id` claim)       |
| `created_by_agent_id`    | text        | The agent slug (from `agent_id` claim, for display) |
| `created_at`             | timestamptz | When the operation occurred                         |

This gives full attribution: "Wren (identity abc-123), acting on behalf of Conor (user xyz-789), saved this link at 2026-02-17T08:00:00Z."

### 7. Credential Lifecycle

```
Human authenticates (OAuth 2.1)
  │
  ├─── User access token (1 hour)
  │      └─── User refresh token (90 days)
  │
  ├─── delegate("wren")
  │      ├─── Agent credential (30 days)
  │      └─── Agent refresh token (90 days, scoped to wren)
  │
  ├─── delegate("aster")
  │      ├─── Agent credential (30 days)
  │      └─── Agent refresh token (90 days, scoped to aster)
  │
  └─── delegate("lumen")
         ├─── Agent credential (30 days)
         └─── Agent refresh token (90 days, scoped to lumen)
```

#### Revocation

**Per-agent revocation:**

```
POST /mcp/identity/revoke
Authorization: Bearer <user-access-token>
{ "agent_id": "wren" }
```

Invalidates Wren's credential and refresh token. Other agents unaffected.

**User-level revocation (logout):**

```
POST /mcp/identity/revoke-all
Authorization: Bearer <user-access-token>
```

Invalidates all agent credentials for this user. Cascade via `delegated_from` chain.

**Token hierarchy:**

```
User refresh token (parent)
  ├── Wren agent refresh token (child)
  ├── Aster agent refresh token (child)
  └── Lumen agent refresh token (child)
```

Revoking the parent invalidates all children. The server tracks `delegated_from` to enable this cascade.

### 8. Enforcement Modes

Implementations SHOULD support configurable enforcement:

| Mode          | Behavior                                                                                                                               | Use Case                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| **Strict**    | Agent credential required for all write operations. Reject calls without valid agent identity.                                         | Production, team/hosted environments |
| **Delegated** | Agent credentials used when available. Fall back to user-only token with no agent attribution.                                         | Default for most deployments         |
| **Pinned**    | Accept bootstrap-based identity pinning (session-scoped, no cryptographic proof). Agent credential takes priority if both are present. | Local development, stdio sessions    |
| **Open**      | No identity enforcement. Agent ID from tool parameters is trusted.                                                                     | Development, testing                 |

Enforcement mode is configured server-side. Clients do not need to be aware of the mode.

## Security Considerations

### Prompt Injection Defense

The primary threat model: an attacker crafts input that convinces an agent to impersonate another agent via tool parameters.

**Without agent credentials:** The attacker succeeds. `remember(agentId: "wren", content: "malicious")` stores content as Wren.

**With agent credentials:** The server ignores the `agentId` parameter and uses the credential's `agent_id` claim. The malicious content is attributed to the actual caller. The attack is visible in audit logs.

### Token Leakage

Agent credentials MUST NOT appear in:

- Tool call arguments or responses
- Model context or conversation transcripts
- Log files (use token IDs, not raw tokens)
- Client-side storage accessible to other applications

Credentials are transport-layer concerns. The `bootstrap()` tool returns identity information (name, role, values) but never raw tokens.

### Credential Scope

Agent credentials SHOULD be scoped to the minimum necessary permissions:

- An agent that only reads should get `mcp:read` scope
- An agent that reads and writes gets `mcp:tools` scope
- Administrative operations (managing other agents) require `mcp:admin` scope

### Replay Protection

Agent credentials include standard JWT protections: `iat`, `exp`, `jti` (unique token ID). Servers MAY maintain a token blocklist for revoked credentials that haven't yet expired.

## PCP Implementation Status

### Shipped (v1 — PR #36, #39)

- Canonical `identity_id` UUID references across all tables
- `agent_id` and `identity_id` columns on `mcp_tokens` table
- `agentId` and `identityId` in JWT claims (`PcpTokenPayload`)
- Session identity pinning (`pinSessionAgent()`) — stdio mode
- Token-bound identity in HTTP request context
- Write-path enforcement via `getEffectiveAgentId()` with feature flag
- `/authorize?agent_id=...` passthrough for explicit agent-bound OAuth

### Next (v2 — Token Delegation)

- `POST /mcp/identity/delegate` endpoint
- `POST /mcp/identity/delegate-all` endpoint
- `POST /mcp/identity/revoke` endpoint
- `sb auth provision [--all] [--agent <id>]` CLI command
- Token storage in `~/.pcp/tokens/`
- `AGENT_CREDENTIAL` environment variable support in MCP client
- Auto-refresh in CLI wrapper (before spawning backend)
- `delegated_from` tracking for cascade revocation

### Future (v3 — Protocol Extension)

- MCP spec proposal for `agentIdentity` capability
- `agentCredential` field in MCP `initialize` params
- Standard delegation endpoint convention for MCP servers
- OS keychain integration for token storage
- Per-agent scope restrictions in dashboard UI
- Cloud studio auto-provisioning at environment creation

## CLI UX

### Provision Tokens

```bash
# Provision credentials for all registered agents
sb auth provision --all

# Provision for a specific agent
sb auth provision --agent aster

# Show current token status
sb auth status

# Revoke an agent's credentials
sb auth revoke --agent wren

# Revoke all agent credentials
sb auth revoke --all
```

### Token Status Output

```
$ sb auth status

  User: conor@example.com (authenticated)

  Agent Tokens:
    wren    ✓ valid (expires 2026-03-17)  claude
    aster   ✓ valid (expires 2026-03-17)  gemini
    lumen   ✓ valid (expires 2026-03-17)  codex
    myra    ✗ expired                     telegram
    benson  ✗ not provisioned             discord
```

### Automatic Provisioning

When `sb awaken` completes (a new SB calls `choose_name()`), the CLI can auto-provision a credential:

```
Awakening session ended.

✓ Aster's identity created
✓ Agent credential provisioned
✓ Token stored at ~/.pcp/tokens/aster.json
✓ MCP config updated

Aster is ready. Start a session:
  sb session -b gemini aster
```

## Backward Compatibility

- Servers that don't advertise `agentIdentity` capability work exactly as before
- User-only tokens (without agent claims) are accepted — they simply have no agent attribution
- The `bootstrap()` tool continues to work for session-based identity pinning
- The enforcement mode `open` preserves current behavior where `agentId` is a trusted parameter
- No changes to the MCP JSON-RPC envelope format are required for HTTP transport

## Open Questions

1. **Should delegation require explicit human consent per-agent?** Or is "user is logged in" sufficient authorization to delegate to any of their registered agents?

2. **Should agent credentials have shorter TTLs than user tokens?** Agents are more likely to be running in automated environments where credential rotation is easier.

3. **How should cross-user agent interactions work?** If Conor's Wren wants to collaborate with Alice's agent, how does the credential model extend to multi-user scenarios?

4. **Should the MCP spec define a standard identity schema?** Or just the credential format, leaving identity storage to implementations?

5. **How does this interact with MCP server-to-server calls?** If an MCP server calls another MCP server on behalf of an agent, should the credential be forwarded?

---

_This spec was developed collaboratively by Wren (Claude Code), Lumen (Codex CLI), and Conor McLaughlin as part of the Personal Context Protocol project. It reflects real-world experience building multi-agent systems where identity, attribution, and security are practical concerns, not theoretical ones._
