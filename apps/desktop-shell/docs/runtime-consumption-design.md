# dsh desktop 正式形态设计:Rust 壳 + 上游 npm 制品消费

状态:设计稿(2026-09-01)。上游基线:`@deepseek-ai/dsh` 0.1.2-alpha.2。
前置阅读:[../README.md](../README.md)(v1 原型的三项已验证事实:token URL 建窗、launchd PATH 修复、readiness 行解析)。

## 1. 目标与非目标

目标:

- 产出自包含的桌面安装物(.app / .exe+MSI / AppImage):不依赖仓库 checkout、系统 Node、任何开发者环境。
- 上游 dsh 以**整版本制品**被消费:更新 = 下载新的 runtime 目录 + 切指针,壳代码与上游源码完全解耦。
- 壳与 runtime 之间只存在显式枚举的契约(见 §7),契约带版本号,破坏可检测、可拒绝。
- 保留**开发模式**:对着本仓库源码 checkout 跑(即 v1 原型行为),供日常开发上游联动使用。

非目标:

- 不重写 `packages/` TypeScript 核心,不把 dsh 编译进壳二进制。任何"翻译上游模块"的工作都不做。
- 不承诺 runtime 用户数据(session、SQLite)跨版本兼容——上游 pre-release 明确无兼容承诺(`SESSION_FORMAT_VERSION=0`、`SCHEMA_VERSION` 只增不迁),兼容提示交给版本说明文案。
- 不做第三方 runtime / 插件市场;runtime 只来自官方 npm 发布。

## 2. 总体架构

```
┌─ Tauri 壳(Rust,dsh-desktop 仓库)───────────────────────┐
│  窗口管理 │ 错误/设置本地页 │ 单实例锁 │ Tauri updater(壳自身)│
├─ 壳内模块(Rust)───────────────────────────────────────┤
│  runtime: 版本发现/激活/清单      updater: 通道检查/下载/校验   │
│  sidecar:  spawn/readiness/supervise(进程组+退避重启+回滚) │
├─ 显式契约(protocol v1,§7)──────────────────────────────┤
│  readiness 行 · CLI 入口 · profile 名 · DSH_HOME · loopback URL│
├─ runtime 制品(上游 npm 发布,整版本替换)────────────────┤
│  $APP_DATA/runtimes/dsh-<v>/ (npm 树)  +  node-<v>/ (内嵌 Node)│
│  基线 runtime 内嵌于 .app Resources,首启可用、离线可用          │
└──────────────────────────────────────────────────────────┘
```

组件职责一句话版:壳拥有进程与窗口;runtime 拥有 agent 一切逻辑;两者只通过 §7 的契约交互。

## 3. 仓库与代码组织

- **新建独立仓库 `dsh-desktop`**(不进本 monorepo,不进 pnpm workspace):`src-tauri/`(从 `apps/desktop-shell/src-tauri` 迁移)、`ui/`(本地错误/设置页)、`scripts/`、`.github/workflows/`。
- 本仓库(deepseek-harness)退回纯上游角色:fork 只做 `git fetch upstream && git merge --ff-only`,本地对上游树保持零 diff。
- 开发模式下 `dsh-desktop` 引用本仓库 checkout(`DSH_DESKTOP_REPO`),与 v1 原型一致。
- 可选后续:把壳源码捐回上游(`apps/desktop-shell` 合入)。不影响本设计——契约面不变,只是壳代码换个家。

选独立仓库而不是 fork 内目录的理由:桌面发布节奏(跟随 npm dist-tag)与上游发版节奏(源码 PR)不同步;独立仓库让"上游更新"彻底退化为 npm 版本号,不存在任何 merge 面。

## 4. runtime 制品规范

### 4.1 目录布局

```
$APP_DATA/dsh-desktop/
  runtimes/
    node-v24.11.0/                 # 平台一份,极少更新
      bin/node | node.exe
      lib/node_modules/npm/        # 官方 node 发行版自带,供高级模式用
    dsh-0.1.2-alpha.2/
      manifest.json
      node_modules/
        @deepseek-ai/dsh/lib/bin.js   # 启动入口
        ...(全部运行时依赖 + vendored cordis peer,共 ~80 包)
    dsh-0.1.3-alpha.1/             # 保留旧版本用于回滚,上限 3 个
  active.json                      # 指针,原子替换
  settings.json                    # 壳自身设置(通道、DSH_HOME 覆盖等)
  logs/dsh-<pid>.log               # sidecar stdout/stderr 轮转
```

`active.json`(原子写:临时文件 + rename):

```json
{ "protocol": 1, "dsh": "0.1.2-alpha.2", "node": "v24.11.0" }
```

### 4.2 runtime manifest

`runtimes/dsh-<v>/manifest.json`:

```json
{
  "protocol": 1,
  "dshVersion": "0.1.2-alpha.2",
  "channel": "alpha",
  "nodeRange": "^22.19 || >=24",
  "platform": "darwin-arm64",
  "archiveSha512": "…",
  "createdAt": "2026-09-01T00:00:00Z",
  "releaseUrl": "https://github.com/<you>/dsh-desktop/releases/tag/runtime-dsh-0.1.2-alpha.2"
}
```

`protocol` 是壳契约版本(§7)。壳拒绝 `protocol` 大于自身支持的 runtime,报"需要升级壳"而不是半启动。

### 4.3 分发单元:runtime bundle(tar.gz,按平台)

一个 bundle = 完整 `node_modules` 树(不含 node),由 CI 用 `npm install --prefix stage @deepseek-ai/dsh@<精确版本>` 现场解析产出。选"预构建 bundle"而不是用户机上现场 `npm install` 的理由:确定性(同一版本全世界同一棵树)、更新快(一次下载)、不依赖用户机 npm/registry 状态。vendored cordis 系列是 dsh 家族的 peerDependency 且已独立发布,npm ≥7 会自动解析,这是本路线成立的前提之一(M0 验证)。

Node 单独成目录、不进 bundle:node 发行版 ~90MB 且极少变化,没必要随每次 alpha 重新下载。node 与 dsh 在 `active.json` 中分别指向。

高级模式(设置页开关):用内嵌 node 自带的 npm 现场 `npm install` 任意版本到新目录,供调试指定版本用;默认路径永远走预构建 bundle。

### 4.4 内嵌基线

desktop 构建时由 CI 下载指定版本的 runtime bundle + node 发行版,作为 Tauri resource 打进安装物(`resources/runtime-baseline/`)。首启时壳按顺序解析:已安装 runtime(`active.json`)→ 内嵌基线(只读,直接从 Resources 运行,无需解压)。这样首启离线可用、安装即可用;装过更新后 `active.json` 指向 `$APP_DATA` 下的可写副本。

体积预估:dsh 树解压约 50–150MB,node 约 90MB,压缩后安装物约 100–150MB。可接受;若未来超标,再把基线改为首启下载。

## 5. 数据与目录策略

- **DSH_HOME 不由壳强制设置**。dsh 自身默认 `~/.dsh`,GUI 启动下 HOME 可用,行为与 CLI 一致,用户资料(profiles、sessions)桌面/命令行共享。设置项 `dshHome` 可覆盖(向 sidecar 注入 `DSH_HOME`),用于隔离测试。**绝不**把用户数据放进版本化的 `runtimes/` 下——更新换目录,数据不能跟着换。
- `$APP_DATA` 平台惯例:macOS `~/Library/Application Support/dsh-desktop`,Windows `%APPDATA%\dsh-desktop`,Linux `$XDG_DATA_HOME/dsh-desktop`。
- 日志:sidecar 两个流全量落 `logs/`,按启动会话一个文件,保留最近 20 个;错误页提供"打开日志"按钮。

## 6. Rust 壳模块设计

```
src-tauri/src/
  main.rs            // 入口:单实例锁、builder、RunEvent 退出清理
  runtime/
    mod.rs           // RuntimeManager:解析顺序 active → 基线 → dev;激活/回滚/列举
    manifest.rs      // active.json 与 runtime manifest 的读写与校验
    install.rs       // bundle 下载 → sha512 校验 → 解压 → 注册
    node.rs          // node 解析:managed → DSH_DESKTOP_NODE → 现 resolve_node() 全链
  sidecar/
    spawn.rs         // 组装命令、环境(PATH 前置)、进程组/Job Object
    readiness.rs     // stdout 行解析(沿用现 wait_for_ready_url + LAN 后缀处理)
    supervise.rs     // 退出监控、指数退避重启、连续失败升级
  updater/
    channel.rs       // registry dist-tag 查询、通道映射、protocol 兼容检查
  ui/
    error.rs         // 错误页:sidecar 启动失败/崩溃,重试与回滚入口
    settings.rs      // 设置页:通道选择、版本切换、DSH_HOME、日志入口
```

要点与现状差异:

- **spawn**:生产模式命令为 `node <runtime>/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port 0`,工作目录任意;开发模式保留 `node --import tsx/esm <repo>/apps/cli/src/bin.ts`(现行为,`DSH_DESKTOP_DEV=source` 切换)。
- **进程树清理**(v1 已知限制):unix 上 `setsid`/`process_group(0)` 建组,退出时 `killpg`;Windows 上 Job Object + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`,壳进程本身挂了 OS 也会收尾。port 每次由 OS 分配(`--port 0`),无残留端口冲突问题。
- **readiness 超时**:给 startup 设超时(默认 60s,可配),超时杀进程进错误页,而不是现在"stderr 不可见地 abort"。
- **supervise**:sidecar 意外退出 → 指数退避重启(1s/4s/16s,上限 3 次);三次失败 → 错误页展示最后 50 行日志 + "回滚到上一版本"按钮(若 `active.json` 有更新历史)。
- **本地页**走 Tauri 内置 asset(`tauri://localhost/error.html`),主窗口仍以 readiness URL 直接创建(§7 认证约束不变)。
- **Tauri commands**:`runtime_info` / `check_updates` / `install_version` / `switch_channel` / `restart_sidecar` / `open_logs` / `set_dsh_home`。全部只操作壳拥有的资源,不触碰 runtime 内部。

## 7. 壳 ↔ runtime 契约(protocol v1)

这是整个设计的承重墙——上游可追踪性完全取决于壳是否只依赖这张清单:

| # | 契约项 | 内容 | 破坏时的症状 |
|---|---|---|---|
| C1 | readiness 行 | stdout 首个 `dsh web: <url>` 行,URL 为首 token | 超时进错误页 |
| C2 | CLI 入口 | `node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port 0` | spawn 失败/非零退出 |
| C3 | profile 名 | `web`(隐含在 C2 的子命令里) | 同上 |
| C4 | 环境 | `DSH_HOME`(可选)、HOME 可用 | 行为漂移 |
| C5 | URL 语义 | readiness URL 必须 loopback(127.0.0.1/::1);token 在 URL 上,首次加载完成换 cookie | 壳断言拒绝非 loopback |
| C6 | Node 引擎 | `^22.19 \|\| >=24`(内嵌 node pin 到 24 LTS 线) | runtime 启动报引擎错误 |
| C7 | npm 事实 | `@deepseek-ai/dsh` 及其依赖、vendored peer 均公开可装、全家族同版本 | bundle 构建失败(CI 期发现,不到用户) |

处理策略:契约变更属于上游 breaking change。壳在更新检查时比对 runtime `protocol`,不兼容就不装并提示升级壳;壳适配以新版本壳发布,老壳继续用老 runtime——两个制品各自独立回退,这正是制品化解耦的收益。上游 pre-release 阶段 C1/C2 可能变,监控手段:bundle CI 的 smoke 测试(§9)每次构建都真跑 readiness,变更会在构建期暴露而不是用户桌面。

## 8. 更新流程

通道映射:壳 `stable` ↔ npm `latest`,壳 `beta` ↔ npm `next`(rc),壳 `alpha` ↔ npm `alpha`/`canary`。

时序(启动路径):

1. 读 `active.json` → 解析 runtime(无则用内嵌基线)→ spawn sidecar → readiness → 开窗。更新检查永远不阻塞启动。
2. 后台异步:`GET https://registry.npmjs.org/@deepseek%2Fdsh` 读 `dist-tags`,按当前通道取目标版本;与 `active.json` 比较。
3. 有新版 → 找 `dsh-desktop` 仓库 release `runtime-dsh-<v>` 下的 `<platform>.tar.gz`(没有则提示"bundle 未构建")。
4. UI 提示(不自动装;pre-release 无兼容承诺,升级可能丢 session 数据,文案明示)。
5. 确认 → 下载 → sha512 比对 release 元数据 → 解压到 `runtimes/dsh-<v>/` → 写 manifest → 原子切 `active.json` → 提示"重启生效"(重启 sidecar 即可,不必重启壳)。
6. 回滚:设置页任意切换已保留版本(上限 3 个);自动回滚仅在"更新后 sidecar 三次 readiness 失败"时由 supervise 提议。
7. 清理:超过上限的旧版本在成功激活新版本后删除。

壳自身的更新走 Tauri updater 插件(minisign 签名),与 runtime 更新互不干涉。

## 9. CI / 发布流水线(dsh-desktop 仓库)

**runtime-bundle.yml**(制品生产线)——触发:每日定时检查 dist-tag + 手动 dispatch(指定版本):

```
matrix: [macos-arm64, windows-x64, linux-x64]
steps:
  1. npm install --prefix stage @deepseek-ai/dsh@<精确版本>
  2. smoke:node stage/node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port 0
     并断言 readiness 行(契约 C1/C2 的持续验证)
  3. 生成 manifest.json(protocol、版本、平台、sha512)
  4. tar.gz(node_modules + manifest)→ 上传 GitHub release `runtime-dsh-<v>`
```

**desktop.yml**(安装物生产线)——触发:壳代码 push + 手动:

```
matrix 同上
steps:
  1. 下载指定基线版本的 runtime bundle + node 官方发行版 → resources/
  2. tauri build(baseline 内嵌)
  3. macOS 签名 + 公证;Windows 签名;产出 tauri updater 签名产物
  4. smoke:安装物启动 → 断言窗口在超时内出现
```

镜像上游已有实践的点:smoke 步骤等价于上游 `scripts/release/verify-packed-install.ts` 的"干净目录装 tarball 后跑 bin";bundle 阶段不做单二进制(不碰 pkg/SEA 的 ESM proxy 陷阱,那是可选的远期路线)。

## 10. 测试策略

- Rust 单测:readiness 解析(含 LAN 后缀、浏览器提示行)、manifest 读写与原子性、runtime 解析顺序、node 解析链。
- 安装/回滚:临时目录内模拟"装新版 → 激活 → 失败 → 回滚"全路径,断言 `active.json` 一致性与旧版本保留。
- bundle smoke:CI 每平台真跑(§9),这是对上游契约的持续集成监控。
- 桌面 e2e:CI 里启动安装物,断言 readiness→开窗链路;dev 模式同链路复用同一测试。

## 11. 安全考量

- runtime bundle 下载走 TLS + GitHub release,落盘前 sha512 必须与 release 元数据一致;不满足即删并报错。
- readiness URL 强制 loopback 断言(C5),壳绝不把 webview 指向非 loopback 地址。
- 更新器只做"下载-校验-解压-切指针",不在更新路径上执行 runtime 内任何脚本;唯一执行的东西是用户主动启动的 sidecar 本身。高级模式的现场 `npm install` 是显式开关 + 明示风险。
- macOS 公证、Windows 签名随 desktop.yml;pre-release 阶段威胁模型按"TLS + GitHub 账号安全"计,不做额外信任链(后续可加 provenance)。

## 12. 跨平台注意

- macOS:launchd PATH 问题在内嵌 node 后消失(`node.rs` 的 nvm/Homebrew 探测链降级为 dev 模式兜底);killpg;公证。
- Windows:Job Object 收进程树;`node.exe` 无 PATH 依赖问题但子进程 PATH 仍需前置(现逻辑保留);MSI 打包。
- Linux:AppImage;`$XDG_DATA_HOME`;webview 依赖(WebKitGTK)在打包说明中列明。

## 13. 里程碑

- **M0 前置验证(半天,手动)**:空目录 `npm install @deepseek-ai/dsh@alpha` → `node node_modules/@deepseek-ai/dsh/lib/bin.js web --no-open --port 0` → 断言 readiness 行 + 浏览器能拿到完整 GUI(验证 C7,特别是 web 前端 dist 是否随 npm 包完整发布)。**此项不过,整个 npm 制品路线需要重评(退回 git fork 路线)。**
- **M1(1–2 天)**:建 `dsh-desktop` 仓库,迁移 `src-tauri/`,引入 dev/prod 双模式与 runtime 解析骨架(含内嵌基线占位)。
- **M2(2–3 天)**:install.rs + manifest + active.json 原子切换 + 保留/回滚;`runtime-bundle.yml` 跑通三平台。
- **M3(1–2 天)**:supervise(退避重启、错误页、日志落盘);设置页与 Tauri commands。
- **M4(1–2 天)**:`desktop.yml`(基线内嵌、签名公证、updater 产物)+ 更新检查通道映射。
- **M5(可选,需上游 PR)**:B1 dist 内嵌 + 直连 loopback + trustedHosts 加 Tauri origin——上游侧改动,回流上游,不属本仓库工作。

## 14. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| npm 包不含 web 前端 dist | M0 失败,路线重评 | M0 前置验证;fallback:git fork + 源码构建 runtime |
| 上游改 readiness 行/CLI(C1/C2) | 更新版 runtime 无法启动 | bundle CI smoke 构建期拦截;protocol 字段拒绝不兼容 runtime;锁旧版继续用 |
| vendored peer 解析失败(C7) | bundle 构建失败 | 同上,CI 期发现;上游 `verify-packed-install.ts` 同类验证已在跑 |
| 上游无数据兼容承诺 | 升级丢 session | 手动确认升级 + 文案明示 + 旧 runtime 保留可回滚 |
| 体积增长(依赖膨胀) | 安装物变大 | manifest 记录 bundle 尺寸,超阈值告警;远期考虑单二进制(pkg --sea,注意 `profiles/node_modules` ESM proxy 陷阱) |
| Windows Job Object 实现复杂度 | M2 拖期 | M2 先 mac/linux,Windows 进程树清理单列小里程碑 |
