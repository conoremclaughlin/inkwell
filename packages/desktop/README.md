# @inklabs/desktop

Inkwell desktop app — a **thin Tauri v2 native shell** over the locally running web dashboard.

## Architecture

The app does **not** bundle the web app. It opens a native window pointed at the local Next.js server (default `http://localhost:3002`, i.e. `INK_PORT_BASE + 1`; the API stays on 3001). Everything you see is the same dashboard you'd see in a browser — the desktop app just adds native chrome:

- **Window** titled "Inkwell" with the standard macOS menu (Edit/Copy/Paste bindings work in the webview).
- **Server-not-running fallback**: on launch the window shows a bundled static page (`ui/index.html`) — never a blank white window. A background thread in the Rust shell polls the server's TCP port every 1.5s and navigates the webview to the dashboard the moment it's reachable.
- **System tray** with: Show/Hide Inkwell, Open Sessions, Open Automations (navigates the webview to `/sessions` / `/automations`), and Quit. Closing the window hides it to the tray (macOS convention); clicking the dock icon brings it back.

All logic lives Rust-side (`src-tauri/src/lib.rs`); the bundled page is purely informational and uses no IPC.

## Configuration

Optional config file at `~/.ink/desktop.json`:

```json
{
  "host": "localhost",
  "port": 3002
}
```

Both fields are optional — defaults are `localhost:3002`. If you run the dashboard on a different port base (e.g. `INK_PORT_BASE=4001` → web on 4002), set `"port": 4002`. Invalid JSON falls back to defaults (with a warning on stderr).

## Prerequisites

- **Rust toolchain** (rustc/cargo ≥ 1.87, matching `rust-version` in `src-tauri/Cargo.toml`): `brew install rust` or [rustup](https://rustup.rs)
- **Xcode Command Line Tools** (macOS): `xcode-select --install`
- Node + Yarn (already required by the monorepo) — `@tauri-apps/cli` is a devDependency here.

## Development

From the repo root:

```bash
yarn desktop:dev     # tauri dev — opens the shell window (start `yarn dev` separately for the servers)
yarn desktop:build   # tauri build — produces Inkwell.app + .dmg under src-tauri/target/release/bundle/
```

The desktop app never starts the servers for you. Run `yarn dev` (or the prod server) as usual; the shell connects automatically.

## App icon

`src-tauri/icons/` is generated from `assets/icon-source.png` — a placeholder geometric ink-drop drawn programmatically (no logo asset existed in `packages/web` at the time). To regenerate:

```bash
yarn workspace @inklabs/desktop icon:generate
```

When a real brand asset lands, replace `assets/icon-source.png` (1024×1024 PNG with transparency) and rerun `tauri icon assets/icon-source.png --output src-tauri/icons`.

## Future work (out of v1 scope)

- macOS dock badge (e.g. unread inbox count) and richer tray tooltip/status
- Disconnect watchdog: return to the fallback page if the server goes down mid-session
- Deep links (`inkwell://session/...`), native notifications
- Windows/Linux polish (scaffold is cross-platform but only macOS is exercised)
