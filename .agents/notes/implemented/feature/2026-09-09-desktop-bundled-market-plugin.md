# Agent Note: The desktop shell bundles the community market plugin

Status: implemented

English | [中文](2026-09-09-desktop-bundled-market-plugin.zh.md)

## Problem

The desktop app needs a plugin marketplace. A first iteration built one inside this repository: a `dsh-host-plugin-market` Host package owning a `pluginMarket` Remote namespace (registry search, installed inventory, install/remove transactions through pnpm) and a `dsh-client-ui-settings-plugin-market` settings section, both mounted into the web bundle, with the desktop shell injecting `DSH_PNPM_ENTRY`/`DSH_PNPM_NODE` so the Host package could reach the embedded package manager. None of that work was committed. Meanwhile `dshmarket` already exists on npm as a self-contained dsh bundle plus web client covering the same user need, so owning a second marketplace in-tree meant owning registry search, transaction policy, and marketplace UI that a plugin already provides.

## Decision

The desktop shell no longer ships an owned marketplace. The uncommitted Host/client marketplace packages, the shared profile-plugin pipeline extracted for them, and their composition smoke test were deleted; every tracked file they touched was reverted to `HEAD`, and the `DSH_PNPM_ENTRY`/`DSH_PNPM_NODE` injection left `main.rs`.

Instead, `apps/desktop-shell/src-tauri/src/main.rs` seeds the community plugin at launch. Before spawning the sidecar, `ensure_market_plugin` reads the web profile manifest at `$DSH_HOME/profiles/web/package.json` and, when `dshmarket` is absent and the marker file `$DSH_HOME/profiles/web/.dshmarket-embedded` is also absent, runs the real user-facing transaction `dsh plugin --profile web add dshmarket@1.45.1` with the embedded Node and with the embedded pnpm's bin directory prepended to `PATH` (the CLI spawns `pnpm` from `PATH`). Running before the sidecar means the profile composes with the market bundle already layered, so the market is live on first launch. The version is pinned by the `MARKET_SPEC` constant and moves only with app releases.

The marker file records terminal states: dependency present records `installed=outside-shell` and succeeds silently; a run of this seeder records `spec=dshmarket@<version>`. A later launch that finds the marker but not the dependency treats the absence as a user uninstall and never reinstalls. A failed run writes no marker, logs the status code and stderr tail, and retries on the next launch; it never aborts the app. The dev arm (`DSH_DESKTOP_REPO`) runs the same seeder against the repository checkout so dev and packaged behavior match.

The embed step in `apps/desktop-shell/scripts/embed-runtime.mjs` keeps installing pnpm into the runtime tree. The pruned Node distribution has no npm, and the seeder — plus any later `dsh plugin` transaction the user runs from the desktop — needs a package manager.

The scope is desktop-only. The `dsh web` CLI profile keeps its existing composition; CLI users install `dshmarket` the documented way when they want it.

## Alternatives considered

**Keep the self-built marketplace.** It duplicated `dshmarket` inside the repo as another capability seam, another settings section, another typed Remote surface, and a pnpm-launch bridge from Rust — all to deliver what one dependency already gives. The whole feature was uncommitted, so deletion cost nothing and removed a maintenance surface before it shipped.

**Declare `dshmarket` in the web profile template.** Profile templates only apply at profile creation, so existing installations would never receive the plugin, and a user uninstall would be re-added on profile recreation. The launch seeder covers upgrades and respects uninstalls.

**Vend a `dshmarket` tarball inside the runtime and install offline.** The pinned dependency plus the standard registry transaction keep one install path for both the seeder and later user transactions; an offline vendored copy adds a second artifact to keep fresh without removing the runtime's need for a package manager.

## Consequences

First launch after install or upgrade needs registry access to seed the market; offline machines get the app without the market until a later connected launch. The desktop acquires local state in `$DSH_HOME` (the marker file) whose absence/presence distinguishes "never seeded" from "user uninstalled". Upgrading the bundled market means editing `MARKET_SPEC` and shipping a new app build. The embedded pnpm stays in the runtime even though no in-tree consumer remains, because the seeder and desktop `dsh plugin` transactions depend on it.
