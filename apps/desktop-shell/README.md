# dsh desktop-shell (experimental)

Tauri v1 原型：用 Tauri 壳承载 `dsh web` GUI。Rust 层只做三件事——拉起 `dsh web` 子进程、解析 stdout 的 `dsh web: <url>` readiness 行、在解析结果上直接创建主窗口。浏览器侧全部逻辑（token/cookie 认证、`/api` 桥、WebSocket）不改动。

本目录故意不进 pnpm workspace（无 package.json）：根 `tsdown.config.ts` 的 workspace glob 匹配 `packages/*/*`，无 package.json 的子目录会让它的 workspace 解析归到根包并使 `pnpm run build` 失败；pnpm 自己的 `apps/*` glob 则会安全跳过本目录。

## 运行（开发机，需仓库 checkout）

前提：仓库已 `pnpm install` 且 `pnpm run build`（`dsh web` 启动时要求前端 dist 已构建）。

```sh
cd apps/desktop-shell/src-tauri
cargo run
```

窗口在 `dsh web` 就绪后出现（首次 cargo run 需先下载并编译 Tauri 依赖）。`DSH_DESKTOP_REPO` 环境变量可覆盖 dsh checkout 路径（默认从本 crate 向上查找含 `apps/cli/src/bin.ts` 的目录）。

## 打包本机 .app

```sh
cd apps/desktop-shell/src-tauri
npx -y @tauri-apps/cli@^2 build
# 产物：target/release/bundle/macos/DeepSeek Harness.app
```

Tauri 2 的 `bundle.active` 默认为 `false`，必须在 `tauri.conf.json` 显式开启才会产出 .app（否则只有裸二进制）。产物仍依赖本机的 Node 与仓库 checkout（见下），只能在构建机上运行。

## node 解析（Finder/Dock 启动的崩溃修复）

Finder/Dock 启动的应用由 launchd 拉起，PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，nvm/Homebrew 装的 node 不在其中——裸 `Command::new("node")` 会 spawn 失败，setup 返回 Err 后 Tauri panic，且 panic 落在无法 unwind 的 app-delegate 回调里直接 SIGABRT（症状：启动即崩）。因此 `resolve_node()` 按序解析：`DSH_DESKTOP_NODE`（必须是存在的可执行文件）→ PATH → `~/.nvm/versions/node/` 下版本号最新的 `bin/node` → `~/.volta/bin/node` → `/opt/homebrew/bin/node` → `/usr/local/bin/node`。同时给 sidecar 的 PATH 前置 node 所在目录与两个 Homebrew 前缀，使其子进程按接近登录 shell 的 PATH 解析。

## 关键实现约束：必须用 token URL 直接创建窗口

`dsh web` 的认证是"URL 上的 token 换 303 + Set-Cookie，再以 cookie 访问"。实测发现：**对已创建的 Tauri 窗口调用 `WebviewWindow::navigate(token_url)`，WKWebView 会丢弃 303 响应上的 Set-Cookie**，页面随后落在无认证的 401 响应上。因此本壳在解析到 readiness URL 后才用 `WebviewWindowBuilder::new(.., WebviewUrl::External(token_url))` 创建窗口——首次加载即完成 token 交换，认证正常。排障时可用 `lsof -nP -iTCP:<port>` 确认 WebKit 网络进程与 sidecar 之间存在 ESTABLISHED 常驻连接（GUI 的 WebSocket）；`WebviewWindow::cookies_for_url` 在 wry 上有漏报竞态（tauri-apps/wry#1486），不要以它的空结果下结论。

## 已知限制（v1 范围外）

- 依赖系统 Node 与仓库源码运行（`node --import tsx/esm`）；单二进制 sidecar 打包是下一步（`tauri build` 本机 .app 已可产出）。
- 退出时只 SIGKILL 直属 node 进程，不追踪整个进程树。
- `dsh web` 启动失败时只把原因写到本进程 stderr 并 abort（GUI 启动下 stderr 不可见），无重试；窗口在 URL 就绪前不存在。

## 后续路径

B1（dist 内嵌 + 直连 loopback + trustedHosts 加 Tauri origin）是正式桌面形态的升级路径；本原型只验证壳与 sidecar 链路。合入 PR 时需按仓库规范补写 Agent Note（记录 wry navigate 丢 Set-Cookie 的发现与窗口创建时机决策）。
