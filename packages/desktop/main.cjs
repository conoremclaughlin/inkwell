/**
 * Inkwell desktop — a thin Electron shell around the local web dashboard.
 *
 * Mirrors the inkread desktop setup (see inkread/packages/desktop) so the
 * ecosystem shares one pattern via ink-boilerplate. The dashboard UI, API,
 * and auth all live in @inklabs/web; this window points at the locally
 * running Next.js server. Session cookies persist across launches, so you
 * stay signed in like a native app.
 *
 * Ported from the previous Tauri shell:
 * - Server-not-running fallback page (ui/index.html) with automatic
 *   reconnect polling — never a blank white window.
 * - System tray: Show/Hide, Open Sessions, Open Missions, Quit. Closing
 *   the window on macOS hides it to the tray (dock icon brings it back).
 * - Port config via ~/.ink/desktop.json ({ "host": ..., "port": ... }).
 */
const { app, BrowserWindow, Menu, Tray, nativeImage, net, shell } = require('electron');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { homedir } = require('node:os');

// ---------------------------------------------------------------------------
// Server URL: APP_URL env → ~/.ink/desktop.json → INK_PORT_BASE + 1 (web port)
// ---------------------------------------------------------------------------
function resolveAppUrl() {
  if (process.env.APP_URL) return process.env.APP_URL;
  let host = '127.0.0.1';
  let port = Number(process.env.INK_PORT_BASE ?? 3001) + 1;
  try {
    const raw = readFileSync(join(homedir(), '.ink', 'desktop.json'), 'utf8');
    const cfg = JSON.parse(raw);
    if (typeof cfg.host === 'string' && cfg.host) host = cfg.host;
    if (Number.isInteger(cfg.port) && cfg.port > 0) port = cfg.port;
  } catch {
    // No config file (or invalid JSON) — defaults are fine.
  }
  return `http://${host}:${port}`;
}

const APP_URL = resolveAppUrl();
const FALLBACK_PAGE = join(__dirname, 'ui', 'index.html');
const RETRY_MS = 1500;

// The dev server may redirect between hostname spellings of the same local
// server (e.g. 127.0.0.1 → localhost), so the in-app navigation guard treats
// them as equivalent — otherwise every in-app click would bounce to the
// system browser.
const APP_ORIGIN = new URL(APP_URL);
const EQUIVALENT_HOSTS = new Set(['localhost', '127.0.0.1', APP_ORIGIN.hostname]);

function isAppUrl(url) {
  try {
    const u = new URL(url);
    return (
      u.protocol === APP_ORIGIN.protocol &&
      u.port === APP_ORIGIN.port &&
      EQUIVALENT_HOSTS.has(u.hostname)
    );
  } catch {
    return false;
  }
}

let mainWindow = null;
let tray = null;
let retryTimer = null;
let quitting = false;

async function serverUp() {
  try {
    // Any HTTP response (including auth redirects) means the server is up.
    await net.fetch(APP_URL, { method: 'HEAD' });
    return true;
  } catch {
    return false;
  }
}

/** Load the dashboard; on failure show the fallback page and poll until up. */
async function connect(window) {
  try {
    await window.loadURL(APP_URL);
    return;
  } catch {
    await window.loadFile(FALLBACK_PAGE, { query: { serverUrl: APP_URL } }).catch(() => {});
  }
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = setInterval(async () => {
    if (window.isDestroyed()) {
      clearInterval(retryTimer);
      retryTimer = null;
      return;
    }
    if (!(await serverUp())) return;
    clearInterval(retryTimer);
    retryTimer = null;
    window.loadURL(APP_URL).catch(() => void connect(window));
  }, RETRY_MS);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    title: 'Inkwell',
    backgroundColor: '#f9fafb',
    webPreferences: {
      partition: 'persist:inkwell',
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Keep navigation inside the app; external links go to the system browser.
  // Exception: in-app popup flows must open as real Electron windows. The
  // Connected Accounts OAuth flow opens the provider's auth URL in a named
  // popup ('oauth-popup'/'oauth-upgrade-popup', width/height features); the
  // provider redirects back to the app-origin callback, which reports the
  // result via window.opener.postMessage — so the popup needs a non-null
  // window.open return and an intact opener. Plain target=_blank links
  // (frameName '_blank', no size features) still go to the system browser.
  window.webContents.setWindowOpenHandler(({ url, frameName, features }) => {
    const isPopupFlow =
      (frameName && frameName !== '_blank') || /(^|,)\s*width=/.test(features ?? '');
    if (isPopupFlow || isAppUrl(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: {
            partition: 'persist:inkwell',
            contextIsolation: true,
            nodeIntegration: false,
          },
        },
      };
    }
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  // macOS convention: closing hides to the tray; Cmd+Q / tray Quit exits.
  window.on('close', (event) => {
    if (process.platform === 'darwin' && !quitting) {
      event.preventDefault();
      window.hide();
    }
  });
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  void connect(window);
  return window;
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    return;
  }
  mainWindow.show();
  mainWindow.focus();
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    mainWindow = createWindow();
    return;
  }
  if (mainWindow.isVisible()) {
    mainWindow.hide();
  } else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function openRoute(route) {
  showWindow();
  mainWindow.loadURL(new URL(route, APP_URL).toString()).catch(() => void connect(mainWindow));
}

function createTray() {
  const icon = nativeImage
    .createFromPath(join(__dirname, 'assets', 'icon-source.png'))
    .resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip('Inkwell');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Show/Hide Inkwell', click: toggleWindow },
      { type: 'separator' },
      { label: 'Open Sessions', click: () => openRoute('/sessions') },
      { label: 'Open Missions', click: () => openRoute('/missions') },
      { type: 'separator' },
      {
        label: 'Quit Inkwell',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ])
  );
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'fileMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ])
  );
  createTray();
  mainWindow = createWindow();

  app.on('activate', () => {
    showWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
