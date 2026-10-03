# Browser and simulator tools in studios

Every studio session can drive a headless browser through the Playwright MCP server, and take iOS simulator screenshots with `xcrun simctl`. This page says what each backend gets, what the defaults guard against, how a studio made before them catches up, and how the whole thing is meant to be checked end to end.

## Playwright

**The default launch is `npx @playwright/mcp --headless --isolated`.**

- `--headless`: no browser window on anyone's screen.
- `--isolated`: the profile lives in memory and is discarded when the server exits. Logins, cookies and autofill do not carry from one session to the next, and sessions running at once do not share a profile. Without it, @playwright/mcp 0.0.70 keeps one profile on disk and refuses a second concurrent launch ("Browser is already in use … use --isolated").

The reason for the default: a session that drives someone's everyday browser, or opens windows on their screen, interferes with whatever they are doing in it. And on 2026-10-01 a page snapshot taken in an everyday, logged-in profile exposed the values of filled password fields.

**Where it is pinned.** `pinIsolatedPlaywright` (`packages/shared/src/studio/playwright-mcp.ts`) appends the two flags to a Playwright entry that lacks them. It runs wherever a launch config is produced:

| Producer                                                           | Used by                                             |
| ------------------------------------------------------------------ | --------------------------------------------------- |
| the bundled `playwright-mcp` skill (the template)                  | `ink skills sync`, `ink init`                       |
| `injectSessionHeaders` (shared)                                    | server-spawned Claude and ink sessions              |
| `buildMergedMcpConfig` (CLI)                                       | `ink claude`, `ink -a <sb>`                         |
| `readLaunchMcpServers` (shared)                                    | server-spawned Gemini sessions, `ink gemini`        |
| `syncMcpConfig` (shared)                                           | `.codex/config.toml` and `.gemini/settings.json`    |
| the studio completion routine, on a `.mcp.json` it has just copied | `ink init`, `ink studio create`, `create_studio`, … |

A studio's own `.mcp.json` is never rewritten, and neither is the main worktree's. A launch through any of the paths above is pinned regardless; only a bare `claude` started by hand in an older studio, or in the main worktree, still reads `--headless` alone.

**Pointing it at a real browser is an explicit opt-in.** An entry that names a browser or profile of someone's own is left exactly as written. That means any of:

- `--extension`, `--user-data-dir`, `--cdp-endpoint` or `--endpoint`;
- the `PLAYWRIGHT_MCP_EXTENSION`, `PLAYWRIGHT_MCP_USER_DATA_DIR` or `PLAYWRIGHT_MCP_CDP_ENDPOINT` environment variables, when set to something the server acts on;
- a Chrome-family or Dia profile path.

So is an entry that names a configuration file (`--config` or `PLAYWRIGHT_MCP_CONFIG`), since the file can choose all of that itself and we don't read it. That choice belongs to the person whose browser it is, made in their own `.mcp.json`. Adding `--isolated` to such an entry wouldn't work anyway: the server refuses a profile directory in isolated mode, wherever the directory was set.

Nothing we generate makes that choice: `playwright-mcp.test.ts` (shared) and `playwright-mcp.producers.test.ts` (CLI) fail if any producer's output gains one.

**What the server ignores is no choice at all.** Values follow @playwright/mcp 0.0.70's parsers, measured through its own config resolver:

- `PLAYWRIGHT_MCP_EXTENSION` attaches only when it is `true` or `1` exactly; `false`, `0`, `TRUE` and empty do not.
- A profile directory, endpoint or config path counts only when it is non-empty after trimming.
- An entry carrying one of the ignored values is pinned like any other.
- An entry whose environment sets `PLAYWRIGHT_MCP_HEADLESS` or `PLAYWRIGHT_MCP_ISOLATED` (to `true`, `1`, `false` or `0`) keeps that setting: the matching flag isn't added, because a flag would override it.

## iOS simulator

There is no simulator MCP server. `xcrun simctl` covers booting a device, installing an app, opening a URL and taking a screenshot. It does not tap or type.

```bash
xcrun simctl list devices available
xcrun simctl bootstatus "iPhone 17" -b               # boot if needed, and wait until it is ready
xcrun simctl install booted path/to/App.app
xcrun simctl openurl booted "https://example.com"    # or the app's dev-server URL
xcrun simctl io booted screenshot --type=jpeg ~/.ink/files/<sb>-screenshots/<name>.jpg
xcrun simctl shutdown booted                          # when you are done
```

- `simctl` boots the device without opening the Simulator app. Don't run `open -a Simulator`: that puts a window on the screen.
- Both studio profiles allow `Bash(*)`, so a Claude session runs these without a prompt.
- Taps and typing need an interaction tool. The simulator MCP servers available wrap `idb`, which does not work with the Xcode installed here as of October 2026. Adding one is a new dependency and a separate decision.

## Android emulator (reserved)

Not set up: Android isn't tested yet. When it is, this is the place for it: the emulator and `adb` through the shell, which `Bash(*)` already allows in both studio profiles, run without a window, with screenshots saved under the SB's screenshots directory. An Android MCP server would be a new dependency, decided like the iOS one.

## What each backend gets

| Backend | Playwright server                                                       | Permission to use it                                                                                                                                                                                                                       | `xcrun simctl`                                                         |
| ------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| Claude  | the studio's `.mcp.json`, pinned at launch                              | `mcp__playwright__*` in both studio profiles                                                                                                                                                                                               | `Bash(*)` in both studio profiles                                      |
| Codex   | the studio's `.codex/config.toml`, pinned when it is generated          | no per-tool rules. The runner passes `--dangerously-bypass-approvals-and-sandbox` only where `sandbox_bypass` is on for the SB or studio, and `-a never` otherwise; its own comment says MCP calls are refused then (not re-measured here) | runs under Codex's sandbox unless `sandbox_bypass` is on; not measured |
| Gemini  | the runner's settings file, built from `.mcp.json` and pinned at launch | `--yolo` approves every tool; there is no deny                                                                                                                                                                                             | approved by `--yolo`                                                   |

Known gaps:

- **Codex, existing studios.** `.codex/config.toml` is regenerated only by `ink init` or `ink mcp sync`, and the session service repairs a studio only when its checklist finds something missing. A studio whose Codex file was written before the pin keeps `--headless` alone until one of those runs. Overriding the entry at launch with `-c` is not done: a partial `mcp_servers.playwright` table makes Codex refuse the whole config.
- **Codex and Gemini have no deny rules**, so neither has the profiles' backstops.

## A studio made before the profiles: `ink permissions sync`

A studio's settings file is generated once. A permissions object found there afterwards is kept as authored, so a studio made before a rule joined its profile never gains it. `ink permissions sync [path]` adds the rules its profile has and the file lacks:

```bash
ink permissions sync               # this studio: report what it would add
ink permissions sync --apply       # write it
ink permissions sync <path> --json # another studio, as JSON
```

- The profile and its owner come from the studio's row, or from `--profile` and `--owner`. Never from the checkout.
- Rules are appended after the file's own, in profile order. Nothing is removed or reordered, and every other setting is kept.
- A profile deny is not added when it would refuse something the file allows by name (an authored `Bash(yarn install)` keeps `Bash(yarn install*)` out).
  - Bash rules are read in every spelling: the legacy `X:*` is the same rule as `X *`, and a sole trailing ` *` also matches the bare command. So `Bash(git push)` and `Bash(git push:*)` both keep `Bash(git push *)` out.
  - A broad allow such as `Bash(*)`, `Bash(git *)` or `mcp__github__*` names nothing in particular, so the backstops are added beside it. So is a deny narrower than a prefix grant: `Bash(git push:*)` still gets `Bash(git push *--force*)`.
- A profile allow is not added when the file denies or asks about that exact rule.
- The report lists everything kept out.
- Skipping a deny while adding `Bash(*)` still widens the studio beyond the named grant. Read the dry run before `--apply`.
- One consequence of reading allows by name: an allow left behind by a "don't ask again" click counts as named. A one-off `Bash(git -C <root> add <files>)` keeps the reviewer profile's `Bash(git -C * add *)` out of that file. Reviewer launches still deliver every deny.
- It leaves alone a file holding exactly the profile, a permissions object with no rules (what `ink permissions reset` writes on purpose), and a studio with no permissions object or no settings file, which `ink init` fills. It refuses the main worktree, a file it cannot read, and a symlinked `.claude` directory or settings file.

For the Codex and Gemini files of an older studio, `ink mcp sync` in that studio regenerates both from its `.mcp.json`, pinned.

## Acceptance probe (prepared, not yet run)

The end-to-end check is a triggered turn in a fresh builder studio that takes a headless Playwright screenshot and a simulator screenshot without a prompt, then the same for Codex. Each needs real model calls, so it runs inside the one approved probe session planned for studio permissions phase B, not separately.

1. Create a fresh builder studio for each SB: `ink studio create probe-tools --agent wren`, and the same for `lumen` (Codex). Record each studio's `sandbox_bypass`.
2. Boot a simulator first, outside the turn: `xcrun simctl bootstatus "iPhone 17" -b`.
3. Trigger one turn per studio with `send_to_inbox(recipientSlug, recipientStudioId, threadKey: "thread:studio-tools-probe")` and this request: "Navigate Playwright to https://example.com, take a screenshot, and save it as `~/.ink/files/<sb>-screenshots/probe-playwright.jpg`. Then run `xcrun simctl io booted screenshot --type=jpeg ~/.ink/files/<sb>-screenshots/probe-simctl.jpg`. Report each tool call's result verbatim. Don't ask for approval."
4. While the turn runs, capture:
   - the Claude session's MCP config, `$TMPDIR/sb-mcp/mcp-server-*.json`: the playwright args carry `--headless --isolated`.
   - `ps -Ao pid,command | grep -i 'chrom'`: the browser runs headless, with no `--user-data-dir` under `~/Library/Application Support`.
5. Pass: both files exist, both tool calls succeeded, and the session's tool log shows no permission refusal or approval request. For Codex, record whether it passed only with `sandbox_bypass` on.
6. Clean up: `xcrun simctl shutdown booted`, close both studios.
