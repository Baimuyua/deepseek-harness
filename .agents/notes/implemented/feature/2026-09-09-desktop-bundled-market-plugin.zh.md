# Agent Note: 桌面壳内置社区市场插件

Status: implemented

[English](2026-09-09-desktop-bundled-market-plugin.md) | 中文

## 问题

桌面应用需要一个插件市场。第一版在本仓库内自研了一套：`dsh-host-plugin-market` 宿主包拥有 `pluginMarket` Remote 命名空间（registry 检索、已安装清单、经 pnpm 的安装/移除事务），`dsh-client-ui-settings-plugin-market` 提供设置页分区，两者挂载进 web bundle，桌面壳注入 `DSH_PNPM_ENTRY`/`DSH_PNPM_NODE` 让宿主包能找到内嵌的包管理器。这些工作全程未提交。与此同时 npm 上已有 `dshmarket`——一个自带 dsh bundle 与 web client 的自包含插件，覆盖同一用户需求；继续在树内维护第二个市场，等于重复承担 registry 检索、事务策略与市场 UI。

## 决策

桌面壳不再自带自研市场。未提交的宿主/客户端市场包、为它们抽取的共享 profile-plugin 管线、及其组合冒烟测试全部删除；所有被它们改过的跟踪文件回退到 `HEAD`，`DSH_PNPM_ENTRY`/`DSH_PNPM_NODE` 注入从 `main.rs` 移除。

取而代之的是 `apps/desktop-shell/src-tauri/src/main.rs` 在启动时播种社区插件。生成 sidecar 之前，`ensure_market_plugin` 读取 `$DSH_HOME/profiles/web/package.json` 的 web profile 清单；当 `dshmarket` 依赖缺席且标记文件 `$DSH_HOME/profiles/web/.dshmarket-embedded` 也不存在时，用内嵌 Node 运行真实的用户侧事务 `dsh plugin --profile web add dshmarket@1.45.1`，并把内嵌 pnpm 的 bin 目录前置到 `PATH`（CLI 从 `PATH` 派生 `pnpm`）。在 sidecar 之前运行让 profile 组装时市场 bundle 已经层化，首启即可见。版本由 `MARKET_SPEC` 常量钉住，只随应用发版移动。

标记文件记录终态：依赖已存在时写入 `installed=outside-shell` 并安静返回；播种器自己跑成功时写入 `spec=dshmarket@<version>`。之后启动若发现标记在而依赖缺席，视为用户主动卸载，永不重装。运行失败不写标记，记录退出码与 stderr 尾部，下次启动重试；绝不阻断应用。Dev 臂（`DSH_DESKTOP_REPO`）对仓库检出运行同一个播种器，保证 dev 与打包行为一致。

`apps/desktop-shell/scripts/embed-runtime.mjs` 的嵌入步骤继续把 pnpm 装进运行时树。剪枝后的 Node 发行版没有 npm，而播种器——以及用户之后在桌面上运行的任何 `dsh plugin` 事务——都需要一个包管理器。

范围仅限桌面。`dsh web` CLI profile 保持原有组装；CLI 用户想要市场时按文档方式自行安装 `dshmarket`。

## 曾考虑的替代方案

**保留自研市场。** 它在仓库里复制了 `dshmarket`：又一条能力线、又一个设置分区、又一套类型化 Remote 面、再加一座 Rust 到 pnpm 的桥——只为交付一个依赖已经提供的东西。整个功能从未提交，删除零成本，并且在发布前就除掉了这块维护面。

**在 web profile 模板里声明 `dshmarket`。** Profile 模板只在 profile 创建时生效，存量安装永远收不到插件；而重建 profile 又会把用户卸载的插件加回来。启动播种器既覆盖升级，也尊重卸载。

**在运行时里随附 `dshmarket` tarball 离线安装。** 钉住的依赖加标准 registry 事务让播种器与后续用户事务共用一条安装路径；离线随附副本只会多一份需要保鲜的制品，运行时对包管理器的需求也不会因此消失。

## 后果

安装或升级后的首次启动需要 registry 访问才能播种市场；离线机器在之后某次联网启动前没有市场。桌面在 `$DSH_HOME` 里新增本地状态（标记文件），用存在与否区分"从未播种"与"用户已卸载"。升级内置市场需要修改 `MARKET_SPEC` 并发新版应用。尽管树内已没有消费者，内嵌 pnpm 仍保留在运行时里，因为播种器与桌面上的 `dsh plugin` 事务依赖它。
