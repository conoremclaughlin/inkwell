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
  args: ['@playwright/mcp', '--headless', '--isolated']
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
browser_resize (1440x900+) → browser_navigate → browser_take_screenshot
```

For desktop screenshots, always set the viewport to at least **1440x900** before capturing. This ensures UI elements render at a realistic desktop size and avoids narrow/mobile layouts that misrepresent the actual design.

```
browser_resize({ width: 1440, height: 900 })
browser_navigate({ url: "..." })
browser_take_screenshot({ filename: "page.png" })        # viewport
browser_take_screenshot({ filename: "full.png", fullPage: true })  # full page
```

## Options

Every studio session launches the server `--headless --isolated`: no window on anyone's screen, and a throwaway in-memory profile, so no logins, cookies or autofill carry between sessions and several sessions can run at once. Driving someone's everyday browser interferes with what they are doing in it, and a page snapshot in an everyday, logged-in profile has exposed filled password fields. The session launchers add both flags to a Playwright entry that lacks them.

Pointing the server at a browser or profile of someone's own (`--extension`, `--user-data-dir`, `--cdp-endpoint`, `--endpoint`, or a Chrome or Dia profile path) is an explicit opt-in, made by the person whose browser it is in their own `.mcp.json`. The launchers leave such an entry as written. Don't add one yourself.

Other options:

- `--browser firefox|webkit|chrome|msedge` — browser engine or Chrome channel
- `--viewport-size 1920x1080` — set viewport dimensions
- `--output-dir ./playwright-output` — save artifacts
