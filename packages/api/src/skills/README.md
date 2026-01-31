# PCP Skills System

Skills extend your AI assistant's capabilities. There are three types:

| Type | Description | Example |
|------|-------------|---------|
| **mini-app** | Code-based skills with functions | Bill splitting, expense tracking |
| **cli** | Wrappers for CLI tools | GitHub CLI, AWS CLI |
| **guide** | Behavioral guides for situations | Group chat etiquette |

## Skill Locations

Skills are loaded from two locations:

1. **Built-in skills**: `packages/api/src/skills/builtin/`
   - Ships with PCP
   - Updated via PCP releases

2. **User skills**: `~/.pcp/skills/`
   - Your custom skills
   - Downloaded skills from registries

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

### Future: PCP CLI (coming soon)

```bash
# Install from registry
pcp skill install bill-split

# List installed skills
pcp skill list

# Update all skills
pcp skill update
```

## Creating a Skill

### Single-File Skill (SKILL.md)

The simplest format - a markdown file with YAML frontmatter:

```markdown
---
name: my-skill
version: "1.0.0"
displayName: My Skill
description: What this skill does
type: guide  # or mini-app, cli
emoji: "🎯"
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
├── functions.ts      # Code for mini-apps (optional)
└── README.md         # Human documentation (optional)
```

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
    instructions: "Download and run the installer"
```

Supported install kinds:
- `brew` - Homebrew (macOS/Linux)
- `npm` - Node.js packages
- `pip` - Python packages
- `go` - Go packages
- `cargo` - Rust packages
- `manual` - Manual installation with instructions

## Skill Registries (Future)

We're planning official skill registries:

- **PCP Hub**: Curated, verified skills
- **Community**: User-submitted skills
- **Organization**: Private team skills

Stay tuned for updates!
