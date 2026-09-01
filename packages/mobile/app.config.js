const os = require('os');

/**
 * Dynamic app config — its job is to capture, at bundle time, two facts about
 * the machine serving the app that the phone cannot work out for itself.
 *
 * Everything static still lives in app.json; this file only adds `extra`.
 *
 * ## Why the port has to come from here
 *
 * The runtime resolver derives the API HOST from Metro (see
 * src/lib/resolveApiUrl.ts) — the phone is already talking to the dev machine,
 * so the API is on that same machine. It cannot derive the PORT the same way:
 * Metro's port (8081) has nothing to do with the API's, and probing a guessed
 * list of ports is both slow and wrong the moment someone picks a new base.
 *
 * But the shell that starts the server already knows the answer. PCP_PORT_BASE
 * is how every isolated server in this repo is launched (see AGENTS.md), and
 * Metro is started from that same environment, so reading it here is a fact
 * rather than a guess. Default 3001 matches the main dev server.
 *
 * ## Why the LAN IP is baked
 *
 * A release build on a physical device has no Metro host, so host derivation
 * has nothing to work from and falls back to loopback — which on a phone is
 * the phone itself, and fails with a confusing network error. Recording the
 * dev machine's LAN address at build time gives that case something real to
 * fall back to. It is deliberately ranked BELOW the Metro host so a dev build
 * still follows a changing DHCP lease without a rebuild.
 */

/** Port the Inkwell API listens on, from the environment that launched Metro. */
function apiPort() {
  const base = Number.parseInt(process.env.PCP_PORT_BASE ?? '', 10);
  return Number.isInteger(base) && base > 0 && base < 65536 ? base : 3001;
}

/**
 * This machine's LAN IPv4, preferring macOS Wi-Fi/Ethernet.
 *
 * Interface order matters: a Docker bridge or VPN adapter is also a
 * non-internal IPv4, and picking one produces an address the phone cannot
 * reach. en0/en1 first, then anything else, and never an internal one.
 */
function lanHost() {
  const interfaces = os.networkInterfaces();
  const preferred = ['en0', 'en1'];
  const names = [...preferred, ...Object.keys(interfaces).filter((n) => !preferred.includes(n))];
  for (const name of names) {
    for (const info of interfaces[name] ?? []) {
      const isIpv4 = info.family === 'IPv4' || info.family === 4;
      if (isIpv4 && !info.internal) return info.address;
    }
  }
  return null;
}

module.exports = ({ config }) => ({
  ...config,
  extra: {
    ...config.extra,
    apiPort: apiPort(),
    lanHost: lanHost(),
  },
});
