---
name: harness-child-environment
description: Use when building, reviewing or running a test harness, smoke test, integration-stack run, launcher or wrapper script that spawns external tools (Supabase CLI, docker, yarn, npx, node, python, git, gh, curl). Covers giving every child an explicit minimal environment, pinning tools to concrete binaries, containing credential stores tools consult on their own (Docker credential helpers, keychains, rc files), keeping HOME deliberate, checking interpreters' effective flags, fencing real-binary credential probes and name resolution, and reporting evidence without overclaiming. Not for application code that spawns no tools.
---

# Harness child environment

## Why this exists

The mechanism, seen Oct 14, 2026:

- A smoke harness ran its children with the agent session's inherited environment.
- Supabase CLI 2.84.2's `--version` fetches the latest release from api.github.com, and its source attaches any non-empty `GITHUB_TOKEN` it inherits.
- The session's `INK_*` and `CLAUDE_CODE_*` variables reached the harness processes too.
- The sandboxed application was fenced; the parent harness was not.
- Whether a credential was actually sent is unverified.

The lesson:

- A child gets whatever it inherits.
- Some tools go and fetch credentials on their own.
- So containment has to be explicit, and tested at each process boundary.

## 1. Children get an explicit environment, not the session's

- **Run the harness under `env -i`,** with a written allowlist of names and values:
  - HOME, USER/LOGNAME, SHELL, LANG;
  - a shape-checked TMPDIR;
  - a fixed PATH;
  - the run's own variables.
- **Start the launcher itself minimal:**
  `nohup /usr/bin/env -i HOME="$HOME" USER="$USER" TMPDIR="$TMPDIR" PATH=/usr/bin:/bin /bin/bash launcher.sh`.
  - Bash sources an inherited `BASH_ENV` before your script can refuse it.
  - The launcher must check its own exported environment, and refuse if it holds anything else, before claiming any one-attempt slot.
- **Never pass these through:**
  - **Ambient credentials:** `*_TOKEN`, `*_KEY`, `*_SECRET`, `GITHUB_TOKEN`/`GH_TOKEN`, `INK_*`, `CLAUDE_CODE_*`, npm and Yarn auth, cloud keys, `DOCKER_AUTH_CONFIG`.
  - **Runtime injection:** `NODE_OPTIONS`, `NODE_PATH`, `DYLD_*`, `LD_PRELOAD`.
  - **Proxies:** `HTTP(S)_PROXY`, `ALL_PROXY`.
  - **Startup hooks:** `BASH_ENV`, `ENV`, `PYTHONSTARTUP`, `PYTHONPATH`. Set `PYTHONNOUSERSITE=1` and `PYTHONDONTWRITEBYTECODE=1`.
    - **Those two only work if the interpreter reads its environment.** `-I` and `-E` make Python ignore every `PYTHON*` variable. Measured on 3.12.1, with both set:
      - `-I` writes bytecode (it implies `-s`, so the user site stays off);
      - `-E` writes bytecode **and** reports `no_user_site = 0`: it drops the user-site restriction the environment asked for. That's the flag; it doesn't show that a user-site folder or module actually loaded.
    - Where a harness passes `-I`, also pass `-B`. Where it passes `-E`, also pass `-B -s`.
    - Check the effective flags, not the variable names (section 5).
  - **Tool overrides you didn't choose:** `DOCKER_HOST`, `SUPABASE_*`, `INTEGRATION_*`.
- **Ambient credentials are not the same as scoped test credentials.**
  - Ambient credentials (session tokens, host logins, keychain entries) are never inherited.
  - A credential the test needs on purpose is passed explicitly, by name, and listed in the review packet. It must be invented, or local to a disposable stack; never a real account token.

## 2. Pin the tools

- **Use a dedicated bin folder.** Fill it with symlinks to concrete binaries, and put only it plus the system folders on PATH.
- **Hold that folder to an exact listing.** An extra executable there is on every child's PATH, yet in no pin and no manifest.
- **Version-manager shims choose at run time:** pyenv by version files, Corepack by `packageManager`, nvm by shell state. A shim path pins nothing.
  - Link the interpreter itself (`~/.pyenv/versions/X/bin/python3.X`).
  - Run a pinned Yarn bundle with a pinned node.
- **Check `command -v` under the allowlisted environment, and `readlink -f`,** against the pinned values without executing anything. Hash the binaries in the freeze manifest.
- **Some tools add to PATH themselves.** Yarn puts its temporary bin folder and `node_modules/.bin` first in a script's PATH. Anything resolved by name after that point is outside your pins. Contain it by configuration (section 3), not by hoping the name is absent.

## 3. Contain the credential stores tools consult on their own

A clean environment isn't enough, because some tools reach host credentials through files, helpers and keychains. **Trace each tool from the source of the version you run, and label what you found by version.**

- **Docker CLI** (v28.5.2 and v29.7.2 source):
  - With no `credsStore`, `credHelpers` or `auths` entry, `DetectDefaultStore` picks `osxkeychain` if `docker-credential-osxkeychain` is on PATH.
  - A named `credsStore` is executed as `docker-credential-<name>` from PATH. So naming a helper that doesn't exist rests on an absence that nothing enforces.
  - **Use a config that names no helper, with a non-empty `auths`:** `{"auths": {"<an .invalid registry>": {}}}`. Detection is off, and every lookup uses the file store, whatever PATH holds.
  - Exclude `DOCKER_AUTH_CONFIG`.
  - Pin `DOCKER_HOST` explicitly, because an isolated config has no contexts, and verify that the socket exists and belongs to you.
  - `docker info` also runs each CLI plugin's metadata command from the system plugin folders. Account for it.
- **Supabase CLI** (2.84.2 source):
  - `--version` fetches release metadata from GitHub, authenticated if `GITHUB_TOKEN` is set.
  - It writes `supabase/.temp/cli-latest` relative to the cwd.
  - Its in-process registry auth reads the same Docker config.
- **git, gh, npm and Yarn:** credential helpers, the keyring, `~/.npmrc`, and `.yarnrc*` in every ancestor folder. A unique `YARN_RC_FILENAME` keeps ancestor and home rc files from loading.
- **Don't read real credential stores to investigate.** Read the tool's source, and test with invented configs and helpers.

## 4. Keep HOME deliberate

- **Prefer an isolated HOME.**
- **Keep the real HOME only when something needs the real namespace,** for example integration locks taken under `Path.home()` that must exclude other runs. Then contain each tool's config and credential paths explicitly (a dedicated `DOCKER_CONFIG`, a unique rc filename), and write down what the real HOME still exposes.
- **Either way, this is environment isolation, not host isolation.** Say which one you have.

## 5. Prove absence; don't just assert it

- **Model the child chain with mock executables** that each record their environment and call the next. For example: launcher → node → bash → python3 → supabase / docker / yarn → node.
- **Start the launcher with hostile inputs:**
  - invented sentinels for every excluded class;
  - a hostile `BASH_ENV`;
  - look-alike tools first on the caller's PATH;
  - hostile version-manager state;
  - extra executables named exactly as a tool might look them up: credential helpers by every name, **including any name you configured**.
- **Assert at every boundary:** no sentinel; only allowlisted names; pinned HOME, PATH and tool configs; no look-alike or helper ran; no hook was sourced.
- **Run red controls.** Run the old launcher. If you model a tool's selection logic, add a positive control showing the model does catch the bad configuration; otherwise a green result may be vacuous.
- **Probe each interpreter's effective flags.**
  - Take the exact flags from the harness's source; don't retype them.
  - Start the pinned interpreter with them under the allowlisted environment, and record `sys.flags`: `isolated`, `ignore_environment`, `no_user_site`, `dont_write_bytecode`.
  - Then show the effect: import an invented one-line module from a fresh folder, and check whether a `__pycache__` appears. Use a fresh folder per case, because an earlier cache file would hide a write.
- **Mutate each guard,** one rule broken per copy, including the config files. Require a failing assertion, not a crash. If a mutant survives because another guard also catches it, add a scenario that only that guard can catch.
- **Run real binaries in credential tests inside an OS fence that holds even if your fixture is wrong.**
  - **Deny:** real daemon sockets, external network, the system resolver, keychain and credential services, real config folders, and writes outside the fixture.
  - **Socket rules don't cover name resolution on macOS.** When mach-lookup is otherwise allowed, a socket-only restriction (a `network-outbound` deny) leaves the tested resolver path open: `com.apple.dnssd.service` (mDNSResponder) still answers, so a hostname lookup can still leave the host as DNS.
    - Deny the resolver services by `mach-lookup`.
    - Prove it name by name with raw `bootstrap_look_up` codes.
      - A name is live when its lookup succeeds unfenced; that's its same-name positive twin.
      - Every live name must return the sandbox's denial code under the fence.
      - A name that's unavailable unfenced stays unmeasured.
      - At least one name must be live, and any fenced success fails.
      - A benign service of another name must still resolve under the fence, so a dead probe can't pass.
      - Run the oracle on synthetic bad results first: one open and one denied, nothing live, and unregistered instead of denied.
    - Never resolve a real hostname as a control: that is itself an external lookup.
    - Check that numeric loopback still works, and record whether `localhost` resolves.
    - **Bound the claim to the names tested.** These controls cover the named resolver services. They don't enumerate every daemon that can make network requests for a client, so they aren't a universal network-containment claim.
  - **Allow exec only of** the binary under test and what the fixture needs.
  - **Prove the fence first, with harmless controls:** connect without sending; stat without reading; run a helper's `version`; write an empty file in your own scratch; look up a mach service without messaging it.
  - **Each denial must be the fence's own denial,** so a probe that fails for another reason doesn't count.
    - **File, socket and exec controls:** the errno must be EPERM.
    - **Mach controls:** keep the raw bootstrap code. The fence's denial is `BOOTSTRAP_NOT_PRIVILEGED` (1100); it isn't an errno.
    - **A missing or unregistered service** (for example `BOOTSTRAP_UNKNOWN_SERVICE`, 1102) is not denial evidence by itself.
  - **Each denial needs a twin that really works:** it exits 0 and leaves its record. A twin that only checked that exec was allowed once passed while its own shell was being denied.
  - **Only then** run the real tool, against invented configs, mock helpers and a fake daemon. Never against a real keychain or registry.
- **Label probe evidence by the version actually run.** Behaviour known only from source is "by source".

## 6. Account for every external call and exec

- **For each network call** the harness or its tools make, record: the destination, whether it's authenticated, and whether it's conditional (for example, image pulls only when an image is missing).
- **List the processes tools start on their own** (credential helpers, CLI plugins).
- **Don't call a harness "loopback-only" unless the outer process is fenced too, and the resolver path is closed.** Usually only the sandboxed application is.

## 7. Report evidence exactly

- **A variable's name being present now** is not evidence that it was non-empty then, or that it was sent.
- **A log line from a cached path** is not a network receipt. Find the artifact that only the fresh path writes, and its timestamp.
- **An unchanged, up-to-date `.pyc`** is not evidence that bytecode writing was off. Python doesn't rewrite a current cache file. Use the effective-flags probe.
- **Passing fixtures show the cases you tested,** not universal containment.
- **Never test, print, measure or hash a real credential.**

## Reference implementation

On the development machine only, not in the repo, in `~/.ink/files/wren-scratch/smoke/`:

- `run-r11.sh` (launcher revision 3);
- `r11-bin/`;
- `r11-docker-config/`;
- `launcher-env.r11.regress.py` and `.mutants.py`;
- `docker-creds.r11c.regress.py` with `docker-creds.r11c.sb` and `fence-controls.r11c.py`;
- `dns-fence-controls.r12.py` and `runtime-start-controls.r12.py` (the resolver deny in `smoke.sb`).

The effective-flags probe is `~/.ink/files/wren-scratch/skill-r2/effective-flags.py`, on the same machine.

The one-attempt launcher rules also apply:

- the log is claimed atomically (`noclobber`);
- the manifest is pinned by hash and entry count;
- the harness's exit status is passed through.
