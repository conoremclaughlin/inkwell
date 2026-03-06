# ROLE.md

A ROLE.md file scopes how an agent operates within a specific studio. It is optional — without one, the agent falls back to its general identity and capabilities. Use it to set a clear primary focus without removing capabilities unnecessarily.

---

## Built-in templates

Three ready-to-use role templates ship with `sb studio create --template <name>`:

| Template   | Focus                                         |
| ---------- | --------------------------------------------- |
| `reviewer` | Code review, quality, security, correctness   |
| `builder`  | Feature development, bug fixes, shipping code |
| `product`  | User value, specs, prioritization             |

The canonical source for these templates is `packages/templates/studio-roles/`. Edit them there — the CLI build copies them into the distributed binary.

---

## Writing your own ROLE.md

- **Set a primary focus**, not a restriction. Describe what this studio is _for_, not what the agent is _forbidden_ from doing.
- **Coding is always available.** If the role involves implementation (fix, prototype, demonstrate), say so explicitly. Restricting coding entirely is almost never the right call.
- **Keep it short.** A ROLE.md should orient the agent quickly, not replace its identity. 20–40 lines is enough.
- **Use plain language.** The agent reads this at session start. Jargon or complex conditionals slow things down.

Custom templates can be placed in `~/.pcp/studio-templates/<name>/ROLE.md` and referenced by name with `--template <name>`.
