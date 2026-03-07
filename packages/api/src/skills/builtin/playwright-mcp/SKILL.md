---
name: playwright-mcp
description: Browser automation via Playwright MCP server. Navigate websites, interact with elements, extract data, and take screenshots.
type: cli
triggers:
  keywords:
    - playwright
    - browser
    - screenshot
    - scrape
    - webpage
    - DOM
    - web test
    - headless
    - navigate
metadata:
  openclaw:
    emoji: '🎭'
    os: [linux, darwin, win32]
    requires:
      anyBins: [npx, playwright-mcp]
    install:
      - id: npm-playwright-mcp
        kind: npm
        package: '@playwright/mcp'
        bins: [playwright-mcp]
        label: Install Playwright MCP
mcp:
  name: playwright
  command: npx
  args: ['@playwright/mcp', '--headless']
  env: {}
---

# Playwright MCP

Browser automation powered by the [Playwright MCP server](https://www.npmjs.com/package/@playwright/mcp). Gives you full browser control via MCP tools.

## Setup

The MCP server is auto-configured by `sb` when this skill is active. To install Playwright browsers (first time only):

```bash
npx playwright install chromium
```

## Available Tools

Once the MCP server is running, you have these tools:

| Tool                    | What it does                  |
| ----------------------- | ----------------------------- |
| `browser_navigate`      | Open a URL                    |
| `browser_click`         | Click an element              |
| `browser_type`          | Type text into an input       |
| `browser_select_option` | Choose from a dropdown        |
| `browser_get_text`      | Extract text content          |
| `browser_evaluate`      | Run JavaScript on the page    |
| `browser_snapshot`      | Get accessible page structure |
| `browser_press`         | Press a keyboard key          |
| `browser_choose_file`   | Upload a file                 |
| `browser_close`         | Close the browser             |

## Common Patterns

### Navigate and extract data

```
browser_navigate → browser_get_text or browser_evaluate
```

### Fill and submit a form

```
browser_navigate → browser_type (fields) → browser_click (submit) → browser_get_text (result)
```

### Screenshot a page

```
browser_navigate → browser_snapshot
```

## Options

The MCP server defaults to headless Chromium. Override via skill config or passthrough:

- `--browser firefox|webkit` — different browser engine
- `--headless=false` — show the browser window
- `--viewport-size 1920x1080` — set viewport dimensions
- `--save-video 1280x720` — record video
- `--output-dir ./playwright-output` — save artifacts
