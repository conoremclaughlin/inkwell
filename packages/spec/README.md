# PCP Protocol Specification

This package contains the formal specification for the Personal Context Protocol (PCP).

## Current Version

- **[v0.1](./protocol-v0.1.md)** — Draft specification covering identity, memory, sessions, inbox, threadKey semantics, heartbeat/reminders, bootstrap, and security.

## What is PCP?

PCP defines conventions for giving AI agents persistent identity, memory, and context across sessions and backends. It sits above [MCP](https://modelcontextprotocol.io/) (Model Context Protocol), adding continuity semantics to the tool-calling transport.

PCP is **backend-agnostic** — agents running on any capable LLM (Claude, Gemini, Codex, etc.) can participate as first-class citizens.

## License

MIT — matching MCP's license for zero-friction implementation.
