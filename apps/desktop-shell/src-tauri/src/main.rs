#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
//! Tauri shell for the dsh web GUI (v2: bundled-runtime sidecar).
//!
//! Starts `dsh web` as a child process, reads the `dsh web: <url>` readiness
//! line from its stdout, then creates the window directly at that loopback
//! URL. The token exchange must happen as the webview's first load: navigating
//! an already-created Tauri window with `WebviewWindow::navigate` drops the
//! Set-Cookie carried on the server's 303, so the page would stay on the
//! 401 response. Creating the window at the tokenized URL authenticates and
//! loads the GUI in one step.
//!
//! The sidecar runs from the bundled `resources/runtime/` — a Node dist plus
//! the published `@deepseek-ai/dsh` npm tree produced by
//! `scripts/embed-runtime.mjs` — so an installed app works with no repo
//! checkout and no system Node. When the bundle has no runtime (a dev build),
//! the shell falls back to launching from the repository checkout.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::{Manager, RunEvent, Url, WebviewUrl, WebviewWindowBuilder};

/// Readiness line prefix printed by `dsh-web-app` once the server is up.
const READY_LINE_PREFIX: &str = "dsh web: ";

/// Shared handle to the spawned dsh process so shutdown can kill it.
struct DshProcess(Arc<Mutex<Option<Child>>>);

fn main() {
    let child_slot: Arc<Mutex<Option<Child>>> = Arc::new(Mutex::new(None));

    tauri::Builder::default()
        .manage(DshProcess(child_slot.clone()))
        .setup(move |app| {
            let handle = app.handle().clone();
            let mut child = spawn_dsh(&handle)?;
            let stdout = child
                .stdout
                .take()
                .expect("spawn_dsh pipes stdout");
            let stderr = child
                .stderr
                .take()
                .expect("spawn_dsh pipes stderr");
            *child_slot.lock().unwrap() = Some(child);

            std::thread::spawn(move || forward_stream(stderr, "[dsh] "));
            std::thread::spawn(move || match wait_for_ready_url(stdout) {
                Ok(url) => open_main_window(&handle, url),
                Err(reason) => eprintln!("dsh-desktop-shell: {reason}"),
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build tauri application")
        .run(|app_handle, event| {
            if let RunEvent::Exit = event {
                if let Some(mut child) = app_handle
                    .state::<DshProcess>()
                    .0
                    .lock()
                    .unwrap()
                    .take()
                {
                    let _ = child.kill();
                }
            }
        });
}

/// How the sidecar launches: from the bundled `resources/runtime/` or from a
/// repo checkout with a system Node (dev builds and `DSH_DESKTOP_REPO`).
enum DshLaunch {
    /// Bundled Node dist plus the published `@deepseek-ai/dsh` npm tree.
    Bundled { node: PathBuf, root: PathBuf },
    /// Repo checkout launched through tsx (`node --import tsx/esm`).
    Dev { node: PathBuf, repo: PathBuf },
}

/// Entry script of the published dsh package, relative to the runtime root.
const DSH_CLI: &str = "dsh/node_modules/@deepseek-ai/dsh/lib/bin.js";

/// Pick the sidecar launch. Bundled runtime wins when both its Node and the
/// dsh entry exist; otherwise fall back to the developer flow.
fn resolve_launch(handle: &tauri::AppHandle) -> Result<DshLaunch, String> {
    if let Ok(root) = std::env::var("DSH_DESKTOP_REPO") {
        return Ok(DshLaunch::Dev {
            node: resolve_node()?,
            repo: PathBuf::from(root),
        });
    }
    if let Ok(resources) = handle.path().resource_dir() {
        // Bundler layouts keep the `resources/` prefix differently per target;
        // accept both.
        for runtime in [resources.join("resources/runtime"), resources.join("runtime")] {
            let node = [runtime.join("node/bin/node"), runtime.join("node/node.exe")]
                .into_iter()
                .find(|candidate| candidate.is_file());
            if let (Some(node), bin) = (node, runtime.join(DSH_CLI)) {
                if bin.is_file() {
                    eprintln!(
                        "dsh-desktop-shell: using bundled runtime at {}",
                        runtime.display()
                    );
                    return Ok(DshLaunch::Bundled { node, root: runtime });
                }
            }
        }
        eprintln!(
            "dsh-desktop-shell: no bundled runtime under {}, falling back to a repo checkout",
            resources.display()
        );
    }
    let mut dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    while dir.pop() {
        if dir.join("apps/cli/src/bin.ts").is_file() {
            return Ok(DshLaunch::Dev {
                node: resolve_node()?,
                repo: dir,
            });
        }
    }
    Err(
        "no bundled dsh runtime and no repo checkout above this crate; set DSH_DESKTOP_REPO to \
         the repo root"
            .to_owned(),
    )
}

/// Node executable for the sidecar. Finder/Dock launches come from launchd
/// with a minimal PATH, so a bare `node` lookup fails on machines where Node
/// lives in nvm or Homebrew. `DSH_DESKTOP_NODE` wins, then PATH, then the
/// newest nvm install, then the common macOS prefixes.
fn resolve_node() -> Result<PathBuf, String> {
    if let Ok(node) = std::env::var("DSH_DESKTOP_NODE") {
        let node = PathBuf::from(node);
        if node.is_file() {
            return Ok(node);
        }
        return Err(format!(
            "DSH_DESKTOP_NODE does not point at a node executable: {}",
            node.display()
        ));
    }
    if let Ok(path) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("node");
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    let home = PathBuf::from(
        std::env::var("HOME").map_err(|_| "HOME is not set; cannot locate node".to_owned())?,
    );
    if let Some(node) = newest_nvm_node(&home) {
        return Ok(node);
    }
    for candidate in [
        home.join(".volta/bin/node"),
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
    ] {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(
        "node executable not found (looked in PATH, ~/.nvm, ~/.volta, /opt/homebrew/bin, \
         /usr/local/bin); set DSH_DESKTOP_NODE to an absolute node path"
            .to_owned(),
    )
}

/// The newest `~/.nvm/versions/node/v<semver>/bin/node`, by version-directory
/// name compared as numeric parts.
fn newest_nvm_node(home: &Path) -> Option<PathBuf> {
    let versions = home.join(".nvm/versions/node");
    let mut best: Option<(Vec<u64>, PathBuf)> = None;
    for entry in std::fs::read_dir(&versions).ok()? {
        let entry = entry.ok()?;
        let name = entry.file_name().into_string().ok()?;
        let Some(rest) = name.strip_prefix('v') else {
            continue;
        };
        let Some(parts) = rest
            .split('.')
            .map(|p| p.parse::<u64>().ok())
            .collect::<Option<Vec<_>>>()
        else {
            continue;
        };
        let candidate = entry.path().join("bin/node");
        if !candidate.is_file() {
            continue;
        }
        if best.as_ref().is_none_or(|(known, _)| parts > *known) {
            best = Some((parts, candidate));
        }
    }
    best.map(|(_, path)| path)
}

/// Start `dsh web` on an OS-assigned port with the browser handoff disabled.
fn spawn_dsh(handle: &tauri::AppHandle) -> Result<Child, Box<dyn std::error::Error>> {
    let launch = resolve_launch(handle).map_err(|reason| -> Box<dyn std::error::Error> {
        format!("failed to resolve the dsh sidecar: {reason}").into()
    })?;
    let (node, mut command) = match &launch {
        DshLaunch::Bundled { node, root } => {
            let mut command = Command::new(node);
            command
                .arg(root.join(DSH_CLI))
                .current_dir(root.join("dsh"));
            (node.clone(), command)
        }
        DshLaunch::Dev { node, repo } => {
            let mut command = Command::new(node);
            command
                .args(["--import", "tsx/esm", "apps/cli/src/bin.ts"])
                .current_dir(repo);
            (node.clone(), command)
        }
    };
    eprintln!("dsh-desktop-shell: sidecar node at {}", node.display());
    command
        .args(["web", "--no-open", "--port", "0"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // The launchd PATH omits the node directory and Homebrew; give the
    // sidecar a login-like PATH so its own subprocesses resolve as in a shell.
    if let Some(node_dir) = node.parent() {
        let mut dirs = vec![
            node_dir.to_path_buf(),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ];
        if let Ok(path) = std::env::var("PATH") {
            dirs.extend(std::env::split_paths(&path));
        }
        command.env("PATH", std::env::join_paths(dirs)?);
    }
    command
        .spawn()
        .map_err(|error| -> Box<dyn std::error::Error> {
            format!("failed to launch {} for dsh web: {error}", node.display()).into()
        })
}

/// Read dsh stdout until the `dsh web: <url>` readiness line appears.
/// Fails when the process exits or prints a startup refusal first.
fn wait_for_ready_url(stdout: std::process::ChildStdout) -> Result<String, String> {
    for line in BufReader::new(stdout).lines() {
        let line = line.map_err(|error| format!("reading dsh stdout failed: {error}"))?;
        if let Some(rest) = line.strip_prefix(READY_LINE_PREFIX) {
            if rest.starts_with("opening the default browser") {
                continue;
            }
            // The line may carry a `(LAN: ...)` suffix; the tokenized URL is
            // the first whitespace-delimited token.
            let url = rest.split_whitespace().next().unwrap_or_default();
            if url.starts_with("http") {
                return Ok(url.to_owned());
            }
        }
        eprintln!("[dsh] {line}");
    }
    Err("dsh web exited before announcing its URL".to_owned())
}

fn forward_stream(stream: std::process::ChildStderr, prefix: &str) {
    for line in BufReader::new(stream).lines().flatten() {
        eprintln!("{prefix}{line}");
    }
}

/// Create the main window directly at the tokenized URL; see the module doc.
fn open_main_window(handle: &tauri::AppHandle, url: String) {
    let url = match Url::parse(&url) {
        Ok(url) => url,
        Err(error) => {
            eprintln!("dsh-desktop-shell: invalid dsh web URL ({error}): {url}");
            return;
        }
    };
    let closure_handle = handle.clone();
    let _ = handle.run_on_main_thread(move || {
        eprintln!("dsh-desktop-shell: opening main window at the dsh web URL");
        if let Err(error) =
            WebviewWindowBuilder::new(&closure_handle, "main", WebviewUrl::External(url))
            .title("DeepSeek Harness")
            .inner_size(1360.0, 860.0)
            .min_inner_size(720.0, 480.0)
            .build()
        {
            eprintln!("dsh-desktop-shell: window build failed: {error}");
        }
    });
}
