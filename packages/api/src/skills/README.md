# PCP Skills System

Skills extend your AI assistant's capabilities. There are three types:

| Type         | Description                      | Example                          |
| ------------ | -------------------------------- | -------------------------------- |
| **mini-app** | Code-based skills with functions | Bill splitting, expense tracking |
| **cli**      | Wrappers for CLI tools           | GitHub CLI, AWS CLI              |
| **guide**    | Behavioral guides for situations | Group chat etiquette             |

## Format Compatibility

PCP skills use the [AgentSkills format](https://docs.openclaw.ai/tools/skills) — an open standard adopted by Claude Code, Cursor, VS Code, Gemini, and others. Skills installed via [ClawHub](https://clawhub.com) are compatible with PCP's loader.

## Skill Locations

Skills are loaded from a 4-tier precedence cascade (lowest → highest). When names collide, higher tiers win:

1. **Built-in**: `packages/api/src/skills/builtin/`
   - Ships with PCP
   - Updated via PCP releases

2. **Extra dirs**: configurable paths (default: `~/.openclaw/skills`)
   - ClawHub interop — `clawdhub install playwright-mcp` just works
   - Configured in `~/.pcp/config.json` (see below)

3. **Managed**: `~/.pcp/skills/`
   - Your custom skills
   - Downloaded skills from registries

4. **Workspace**: `<cwd>/.pcp/skills/`
   - Per-worktree / per-SB skills
   - Highest precedence — overrides everything

> **Note:** The MCP `list_skills` endpoint covers tiers 1–3 (builtin, extra dirs, managed). Workspace skills (tier 4) require knowing the agent's working directory, which the PCP server doesn't have. Instead, workspace skills are picked up by the session start hooks running inside the agent's process and injected into the `{{SKILLS_BLOCK}}`.

### Configuring Extra Directories

Add `skills.extraDirs` to `~/.pcp/config.json`:

```json
{
  "skills": {
    "extraDirs": ["~/.openclaw/skills"]
  }
}
```

This lets ClawHub-installed skills (and any other AgentSkills-compatible sources) be automatically available to PCP.

## Installing Skills

### Manual Installation

1. Create the skills directory if it doesn't exist:

   ```bash
   mkdir -p ~/.pcp/skills
   ```

2. Add a skill as either:
   - A single `SKILL.md` file with YAML frontmatter
   - A directory with `manifest.yaml` and optional `SKILL.md`

### From GitHub

```bash
# Clone a skill repository
cd ~/.pcp/skills
git clone https://github.com/user/skill-name

# Or download a single file
curl -o ~/.pcp/skills/my-skill.md https://raw.githubusercontent.com/user/repo/main/SKILL.md
```

### From URL / Registry (curl)

If a registry (PCP Hub, community index, or docs page) gives you a direct skill file URL:

```bash
mkdir -p ~/.pcp/skills
curl -fsSL "https://example.com/skills/my-skill/SKILL.md" -o ~/.pcp/skills/my-skill.md
```

If the skill is a directory package, place it under:

```text
~/.pcp/skills/<skill-name>/
```

### From ClawHub

If [ClawHub](https://clawhub.com) is installed, skills install directly into `~/.openclaw/skills/` and are automatically available to PCP (via `extraDirs`):

```bash
clawdhub install playwright-mcp
clawdhub install playwright-scraper-skill
```

### Future: SB CLI (coming soon)

```bash
# Install from registry
sb skill install bill-split

# List installed skills
sb skill list

# Update all skills
sb skill update
```

## Creating a Skill

### Single-File Skill (SKILL.md)

The simplest format - a markdown file with YAML frontmatter:

```markdown
---
name: my-skill
version: '1.0.0'
displayName: My Skill
description: What this skill does
type: guide # or mini-app, cli
emoji: '🎯'
category: productivity
tags:
  - example
  - demo

triggers:
  keywords:
    - activate
    - trigger words
---

# My Skill

Instructions for the AI on how to use this skill.

## When to Use

Describe when this skill should be activated.

## How to Use

Step-by-step guidance for the AI.
```

### Directory-Based Skill

For more complex skills with multiple files:

```
~/.pcp/skills/my-skill/
├── manifest.yaml     # Skill metadata (required)
├── SKILL.md          # Instructions for AI (optional)
├── run.js            # Bundled scripts (optional)
├── functions.ts      # Code for mini-apps (optional)
└── README.md         # Human documentation (optional)
```

### The `{baseDir}` Placeholder

Skills can reference `{baseDir}` in their SKILL.md content to resolve paths relative to their own directory. This is useful for bundled scripts:

```markdown
To run the automation:
`cd {baseDir} && node run.js /tmp/my-script.js`
```

At load time, `{baseDir}` is replaced with the skill's actual filesystem path (e.g., `~/.pcp/skills/my-skill`).

## Skill Types

### Mini-App

Code-based skills that provide functions:

```yaml
---
name: expense-tracker
type: mini-app
functions:
  - name: addExpense
    description: Add a new expense
    input:
      amount: number
      category: string
      description: string?
    output:
      id: string
      success: boolean
---
```

### CLI Tool

Wrappers for external command-line tools:

```yaml
---
name: github-cli
type: cli
requirements:
  bins:
    - gh
  config:
    - ~/.config/gh/hosts.yml
install:
  - kind: brew
    formula: gh
cli:
  bin: gh
  commands:
    - name: pr list
      description: List pull requests
---
```

### Guide

Behavioral instructions for specific situations:

```yaml
---
name: meeting-notes
type: guide
guide:
  contexts:
    - any
  priority: 5
---
# Meeting Notes Guide

How to take effective meeting notes...
```

## Requirements & Eligibility

Skills can specify requirements that are checked at load time:

```yaml
requirements:
  # Required binaries (all must exist)
  bins:
    - node
    - npm

  # Alternative binaries (at least one)
  anyBins:
    - yarn
    - pnpm
    - npm

  # Required environment variables
  env:
    - OPENAI_API_KEY

  # Required config files
  config:
    - ~/.config/app/config.json

  # Supported operating systems
  os:
    - macos
    - linux
```

## Install Specifications

For CLI skills, provide installation instructions:

```yaml
install:
  - kind: brew
    formula: gh
    bins:
      - gh

  - kind: npm
    package: typescript
    global: true

  - kind: manual
    url: https://example.com/install
    instructions: 'Download and run the installer'
```

Supported install kinds:

- `brew` - Homebrew (macOS/Linux)
- `npm` - Node.js packages
- `pip` - Python packages
- `go` - Go packages
- `cargo` - Rust packages
- `manual` - Manual installation with instructions

## Cloud Skills Registry

PCP supports cloud-based skill storage and distribution:

### Architecture

```
┌─────────────────────┐         ┌──────────────────────┐
│      skills         │         │  skill_installations │
│   (Registry/Hub)    │◄────────│   (User References)  │
├─────────────────────┤    FK   ├──────────────────────┤
│ All available       │         │ Which skills each    │
│ skills (official +  │         │ user has "installed" │
│ community)          │         │ (references, not     │
│                     │         │  copies)             │
└─────────────────────┘         └──────────────────────┘
          │
          ▼
┌─────────────────────┐
│   skill_versions    │
│  (Version History)  │
├─────────────────────┤
│ Enables rollback    │
│ and version pinning │
└─────────────────────┘
```

### Key Tables

- **`skills`** - Central registry of all available skills
- **`skill_versions`** - Version history for each skill
- **`skill_installations`** - User's installed skill references

### Loading Order

Default source priority is deterministic (lowest → highest precedence):

1. **Built-in** — shipped with PCP
2. **Cloud installations** — user's installed skills from registry
3. **Extra dirs** — ClawHub and other configured sources
4. **Managed** (`~/.pcp/skills/`) — user-installed local skills
5. **Workspace** (`<cwd>/.pcp/skills/`) — per-worktree overrides

Later sources override earlier ones when names collide.

### User Installation Flow

```typescript
// Browse the registry
const { skills } = await cloudService.browseRegistry({ category: 'finance' });

// Install a skill (creates reference, not copy)
await cloudService.installSkill({
  skillId: 'uuid-of-bill-split',
  userId: 'user-uuid',
});

// On bootstrap, get all user's skills
const allSkills = await cloudService.loadUserSkills(userId);
// Returns merged local + cloud skills
```

### Version Pinning

Users can pin to specific versions:

```typescript
// Pin to version 1.2.3
await cloudService.pinSkillVersion(installationId, userId, '1.2.3');

// Follow latest (default)
await cloudService.pinSkillVersion(installationId, userId, null);
```

### Publishing Skills

```typescript
await cloudService.publishSkill({
  name: 'my-skill',
  displayName: 'My Skill',
  description: 'What it does',
  type: 'guide',
  version: '1.0.0',
  content: '# My Skill\n\nInstructions...',
  manifest: { triggers: { keywords: ['my skill'] } },
  authorUserId: 'uuid',
  isPublic: true,
});
```

### Migration

Apply the skills registry migration:

```bash
# Via Supabase CLI
supabase db push

# Or via MCP tool
mcp__supabase__apply_migration
```

## Future (v2)

- **Public/private visibility** — Cloud registry already has `is_public`. Surface in local config for per-SB access control (public-facing SBs get different skills than private ones).
- **`sb skills install`** — CLI command to fetch from cloud registry or ClawHub
- **Backend skill injection** — Inject skill content into `sb`-wrapped sessions (Claude Code, Codex, Gemini)
- **PCP Hub**: Curated, verified official skills
- **Community**: User-submitted public skills
- **Organization**: Private team skill collections
