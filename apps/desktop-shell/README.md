# dsh desktop-shell (experimental)

English | [中文](README.zh.md)

Tauri v1 prototype: hosting the `dsh web` GUI inside a Tauri shell. The Rust layer does exactly three things — spawn the `dsh web` child process, parse the `dsh web: <url>` readiness line on stdout, and create the main window directly on the parsed result. All browser-side logic (token/cookie authentication, the `/api` bridge, WebSocket) is unchanged.

This directory deliberately stays out of the pnpm workspace (no package.json): the root `tsdown.config.ts` workspace glob matches `packages/*/*`, and a subdirectory without package.json would resolve to the root package and fail `pnpm run build`; pnpm's own `apps/*` glob skips this directory safely.

## Run (dev machine, needs a repo checkout)

Prerequisite: the repo has been `pnpm install`ed and `pnpm run build` has run (`dsh web` requires the built frontend dist at startup).

```sh
cd apps/desktop-shell/src-tauri
cargo run
```

The window appears once `dsh web` is ready (the first cargo run downloads and compiles the Tauri dependencies). The `DSH_DESKTOP_REPO` environment variable overrides the dsh checkout path (the default walks up from this crate to a directory containing `apps/cli/src/bin.ts`).

## Package a local .app

```sh
cd apps/desktop-shell/src-tauri
npx -y @tauri-apps/cli@^2 build
# output: target/release/bundle/macos/DeepSeek Harness.app
```

Tauri 2's `bundle.active` defaults to `false`; it must be enabled explicitly in `tauri.conf.json` for a .app to be produced (otherwise only the bare binary is produced). The artifact still depends on the local Node and repo checkout (see below) and only runs on the machine that built it.

## Node resolution (the Finder/Dock launch crash fix)

Apps launched through Finder/Dock are spawned by launchd with a PATH of only `/usr/bin:/bin:/usr/sbin:/sbin`; nvm/Homebrew-installed node is not on it — a bare `Command::new("node")` fails to spawn, the setup returns Err and Tauri panics, and the panic lands in an app-delegate callback that cannot unwind, aborting with SIGABRT (symptom: crash at startup). So `resolve_node()` resolves in order: `DSH_DESKTOP_NODE` (must be an existing executable) → PATH → the newest versioned `bin/node` under `~/.nvm/versions/node/` → `~/.volta/bin/node` → `/opt/homebrew/bin/node` → `/usr/local/bin/node`. It also prepends node's directory and two Homebrew prefixes to the sidecar's PATH so its own child processes resolve as a login shell would.

## Bundled plugin: the community market

The desktop app ships with the pinned community market plugin `dshmarket@1.45.1` (the install source is the same `dsh plugin` transaction a user could run; the version moves only with app releases). Before the sidecar composes the `web` profile — so the market is live on first launch with no restart round — the shell checks `$DSH_HOME/profiles/web/package.json` for the dependency and, when missing, runs `dsh plugin --profile web add dshmarket@1.45.1` with the embedded runtime's pnpm on PATH. A successful seed drops a `.dshmarket-embedded` marker into the profile: dependency present → no-op; dependency gone but marker present → the user uninstalled deliberately and it is not reinstalled; any install failure is logged to stderr and retried on the next launch, never blocking the app.

## Key implementation constraint: the window must be created with the token URL

`dsh web` authentication is "trade a URL token for a 303 + Set-Cookie, then keep the cookie". Found by measurement: **calling `WebviewWindow::navigate(token_url)` on an already-created Tauri window makes WKWebView drop the Set-Cookie on the 303 response**, and the page lands on an unauthenticated 401. So this shell parses the readiness URL first and only then creates the window with `WebviewWindowBuilder::new(.., WebviewUrl::External(token_url))` — the very first load completes the token exchange and authenticates correctly. When debugging, `lsof -nP -iTCP:<port>` confirms an ESTABLISHED long-lived connection between the WebKit network process and the sidecar (the GUI WebSocket); `WebviewWindow::cookies_for_url` has a flaky reporting race on wry (tauri-apps/wry#1486) — an empty result from it is not evidence.

## Known limitations (out of v1 scope)

- Requires the system Node and a repo source checkout to run (`node --import tsx/esm`); single-binary sidecar packaging is the next step (a local .app from `tauri build` already works).
- On exit only the direct node child process is SIGKILLed; the whole process tree is not tracked.
- When `dsh web` fails to start, the reason is only written to this process's stderr (invisible under a GUI launch) and the app aborts with no retry; no window exists until the URL is ready.

## Path forward

B1 (embedded dist + direct loopback + trustedHosts accepting the Tauri origin) is the upgrade path to the production desktop form; this prototype only validates the shell and sidecar link. The merge PR must add the repo-required Agent Note (recording the wry navigate Set-Cookie loss finding and the window-creation timing decision).
