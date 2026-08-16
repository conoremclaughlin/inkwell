# @inklabs/desktop

Inkwell desktop app — a **thin Electron shell** over the locally running web dashboard.

It mirrors the inkread desktop setup (`inkread/packages/desktop`) so the ecosystem shares one pattern via ink-boilerplate.

## Architecture

The app does **not** bundle the web app. It opens a window pointed at the local Next.js server (default `http://127.0.0.1:3002`, i.e. `INK_PORT_BASE + 1`; the API stays on 3001). Everything you see is the same dashboard you'd see in a browser — the desktop app just adds native chrome:

- **Window** titled "Inkwell" with the standard macOS menu (Edit/Copy/Paste bindings work in the webview). Session cookies persist across launches (`partition: 'persist:inkwell'`), so you stay signed in like a native app.
- **Server-not-running fallback**: if the dashboard isn't reachable, the window shows a bundled static page (`ui/index.html`) — never a blank white window. The shell polls the server every 1.5s and navigates to the dashboard the moment it's up.
- **System tray** with: Show/Hide Inkwell, Open Sessions, Open Missions, and Quit. Closing the window hides it to the tray (macOS convention); clicking the dock icon brings it back.
- **External links** open in the system browser; navigation stays inside the app.

All logic lives in `main.cjs` (~200 lines); the fallback page is purely informational and uses no IPC.

## Configuration

Resolution order for the server URL:

1. `APP_URL` env var (full URL, wins outright)
2. `~/.ink/desktop.json` config file
3. `INK_PORT_BASE` env var + 1 (default base 3001 → web on 3002)

Optional config file at `~/.ink/desktop.json`:

```json
{
  "host": "localhost",
  "port": 4002
}
```

Both fields are optional — defaults are `127.0.0.1:3002`. If you run the dashboard on a different port base (e.g. `INK_PORT_BASE=4001` → web on 4002), set `"port": 4002`. Invalid JSON falls back to defaults.

## Development

From the repo root:

```bash
yarn desktop:dev     # electron . — opens the shell window (start `yarn dev` separately for the servers)
```

The desktop app never starts the servers for you. Run `yarn dev` (or the prod server) as usual; the shell connects automatically.

## App icon

The tray icon is loaded from `assets/icon-source.png` — a placeholder geometric ink-drop drawn programmatically (no logo asset existed in `packages/web` at the time). To regenerate:

```bash
yarn workspace @inklabs/desktop icon:generate
```

When a real brand asset lands, replace `assets/icon-source.png` (1024×1024 PNG with transparency).

## Future work (out of v1 scope)

- Packaging/distribution (electron-builder → Inkwell.app + .dmg) with a proper icon set
- macOS dock badge (e.g. unread inbox count) and richer tray tooltip/status
- Disconnect watchdog: return to the fallback page if the server goes down mid-session
- Deep links (`inkwell://session/...`), native notifications
- `hiddenInset` title bar once the dashboard grows a draggable header region
- Windows/Linux polish (scaffold is cross-platform but only macOS is exercised)
