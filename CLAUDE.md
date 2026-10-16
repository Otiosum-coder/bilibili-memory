# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

哔哩哔哩记忆（Bilibili Memory）— 基于 [WXT](https://wxt.dev/) + React 19 + TailwindCSS 3 的浏览器扩展（Chrome / Edge / Firefox）。在本地永久保存 B 站观看历史、收藏夹、订阅合集、关注的 UP 主，以及点赞过与投币过的视频，防止内容被删除、下架、账号注销或平台自身不再保留后无从追溯；并支持 WebDAV / 自建云端双向同步。

本项目是 [bilibili-history-wxt](https://github.com/mundane799699/bilibili-history-wxt) 的 fork（MIT），在其基础上增加关注 UP 主追踪等能力。**请保留 LICENSE 并在关于页注明出处。**

## 常用命令

```bash
pnpm install            # 安装依赖（postinstall 会自动跑 wxt prepare）
pnpm dev                # Chrome 开发模式（输出到 .output/chrome-mv3-dev）
pnpm dev:firefox        # Firefox 开发模式
pnpm build              # Chrome 生产构建
pnpm build:firefox      # Firefox 生产构建
pnpm zip                # 打包 Chrome 上架 zip
pnpm zip:firefox        # 打包 Firefox 上架 zip
pnpm compile            # tsc --noEmit 类型检查（最终校验以它为准）
pnpm test               # vitest 单测（需先 npm install -D vitest）
pnpm format             # Prettier 写入
pnpm format:check       # Prettier 校验
```

加载本地扩展：Chrome 打开 `chrome://extensions/` → 加载已解压扩展程序 → 选择 `.output/chrome-mv3-dev`。

**环境要求与已知坑**：

- **Node ≥ 22.13**。pnpm 11 依赖 `node:sqlite`，Node 20 会直接报 `ERR_UNKNOWN_BUILTIN_MODULE`。
- 仓库以 pnpm 为准（`pnpm-workspace.yaml` 的 `patchedDependencies` 给 `wxt` 打了补丁）。npm 也能正常构建，只是补丁不生效 —— `npm run dev` 下重载扩展时可能看到一个未捕获的 Promise 报错，`build` 不受影响。
- **不要跑 `prettier --write`。** 当前安装的 Prettier 版本与仓库现有代码格式不一致，`format:check` 在**未改动的文件上**也会失败；`--write` 会产生大量无关改动。改动后请人工保证：行长 ≤ 100 列、双引号、尾随逗号、2 空格缩进。
- 单测只覆盖纯函数（如 `utils/followingDiff.ts` / `utils/interactionDiff.ts`），不 mock IndexedDB；`pnpm compile` 是最终校验。
- **在 DSH 沙箱里 `pnpm test` 跑不起来**：Vite 在 Windows 会 `exec("net use")`，带管道的子进程被系统拒绝（spawn EPERM）。替代方案是 `pwsh -File verify/interaction-run/run-tests.ps1`（原生 esbuild 编译 + `verify/interaction-run/harness.mjs` 这个 await 版垫片），它跑的是同一批 `*.test.ts`。

## 顶层架构

WXT 按目录约定生成多入口 manifest，所有入口共享同一份 IndexedDB（`bilibiliHistory`）和 `browser.storage.local` 配置。

### Entrypoints（[entrypoints/](entrypoints/)）

| 入口                                                                           | 类型                                                | 作用                                                                                                                                                        |
| ------------------------------------------------------------------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [background.ts](entrypoints/background.ts)                                     | service worker                                      | 全部同步逻辑：B 站历史/收藏夹增量+全量同步、`browser.alarms` 定时调度、WebDAV 自动双向同步、与 content script / 页面通过 `browser.runtime.sendMessage` 通信 |
| [content.ts](entrypoints/content.ts)                                           | content script (`*.bilibili.com`, `document_start`) | 注入 `injected.js`、转发 `window.postMessage` 到 background、为 history 页面提供 `deleteHistory` RPC（需要 `bili_jct` + `SESSDATA`）                        |
| [injected.ts](entrypoints/injected.ts)                                         | unlisted page script                                | 重写 `window.fetch` 拦截 `api.bilibili.com/x/v2/history/delete`，把删除事件 `postMessage` 给 content script，从而实现 "B 站网页端删除 → 同步删除插件历史"   |
| [my-history/](entrypoints/my-history/)                                         | extension page                                      | 主 UI（`my-history.html`），用 `HashRouter` 承载 [pages/](pages/) 下所有页面（详见下方路由表）                                                              |
| [popup/](entrypoints/popup/)                                                   | browser action popup                                | 触发同步、跳转主页面                                                                                                                                        |
| [about/](entrypoints/about/), [webdav-tutorial/](entrypoints/webdav-tutorial/) | extension page                                      | 独立的关于页 / WebDAV 教程页                                                                                                                                |

manifest 在 [wxt.config.ts](wxt.config.ts) 声明，关键权限：`storage / tabs / cookies / alarms / declarativeNetRequest`，并通过 `referrer.json` 的 DNR 规则改写 Referer 让图片资源（B 站防盗链）能在扩展页面里加载。

### Background 同步循环

`browser.alarms` 每分钟触发，但内部用 `*_TIME_REMAIN` 计数器实现"X 分钟跑一次"，避免 alarm 抖动：

1. `syncHistory` — 调 `x/web-interface/history/cursor` 游标分页；增量同步按上次成功的 `view_at` 水位重叠扫描，统一写入最近投影和观看事件。`SYNC_INTERVAL` 单位分钟。
2. `syncFavorites` — 先取 `nav` 拿 mid，再取收藏夹列表，逐夹翻页。**增量**从第一页开始，保存当前页后在页首和页尾资源都已存在于同步前本地数据时停止（`AbortController` 30s 超时 + 最多 2 次重试）。**全量**同步在完整翻页后做消失判定：在线列表里不存在的本地记录**先转入 `vanishedFavResources` 消失档案再移除，绝不直接删除**——B 站接口不返回消失原因，无法区分"你取消收藏"（删掉合理）与"内容被 UP 主删除/下架"（删掉等于销毁证据）。移除前会对每条做一次 `x/web-interface/view` 二次探测，尽力分类为 `unfavorited` / `content_deleted` / `content_hidden` / `unknown`；**探测失败也一律留档**。判定逻辑在 [utils/favVanishedDiff.ts](utils/favVanishedDiff.ts)（纯函数）。
3. `syncWebDav` — 当 `WEBDAV_AUTO_SYNC_ENABLED=true` 时按 `WEBDAV_LAST_SYNC` 间隔触发 `autoSyncWebDav`：**先 download → smartMerge\*（在 [utils/db.ts](utils/db.ts)）→ upload**，避免单向覆盖丢数据。注意 `smartMergeFavResources` 会**跳过已在消失档案里的记录**，否则远端备份会把已消失的收藏"复活"回来。
4. `syncFollowing` / `archiveFollowingAvatars` — fork 新增。`syncFollowing` 每分钟检查、按 `FOLLOWING_SYNC_INTERVAL`（默认 1440 分钟）节流；`archiveFollowingAvatars` 每分钟推进一批头像字节归档，全部归档完成后自动短路停止。
5. `syncInteractions` / `archiveInteractionCovers` — fork 新增（v10）。`syncInteractions` 每分钟检查、按 `INTERACTIONS_SYNC_INTERVAL`（默认 180 分钟）节流，抓取**点赞**与**投币**两个列表。**B 站这两个列表都是滚动窗口（实测固定 20 条、分页参数被忽略），所以掉出列表的条目绝不允许删除**：只用 `x/web-interface/view` + `x/web-interface/archive/relation` 二次探测来标注状态（`retained` / `ended` / `content_deleted` / `content_hidden`），探测失败就停在 `unlisted`，且每轮探测有条数上限（`DEFAULT_MAX_PROBES_PER_RUN`）。判定逻辑在 [utils/interactionDiff.ts](utils/interactionDiff.ts)，编排在 [utils/interactionSync.ts](utils/interactionSync.ts)，见 [docs/interaction-tracker-design.md](docs/interaction-tracker-design.md)。

新增 alarm 类型时记得在 `onInstalled` 里 `alarms.create` 并在 `onAlarm` 里分支处理。

### 数据层（[utils/db.ts](utils/db.ts)）

单一文件管理整套 IndexedDB（DB `bilibiliHistory`，当前 `version: 10`）。共有 13 个 store：

- `history` (keyPath `id`，最近观看投影；索引 `view_at` / `[view_at, id]`)
- `historyEvents` (keyPath `event_id`，每次被同步观测到的观看事件)
- `historyTombstones` (keyPath `tombstone_id`，事件级/内容级删除墓碑)
- `likedMusic` (keyPath `bvid`，索引 `added_at`)
- `favFolders` (keyPath `id`，索引 `mid`)
- `favResources` (复合 keyPath `[folder_id, id]`，索引 `id` / `folder_id` / `fav_time`)
- `subscribedCollections` (keyPath `id`，索引 `mid`)
- `subscribedCollectionResources` (keyPath `id`，索引 `collection_id` / `pubdate`)
- `following` (keyPath `mid`，索引 `status`) — 关注 UP 主快照
- `followingEvents` (keyPath `event_id`，索引 `day` / `type` / `mid` / `occurred_at`) — 关注变动事件
- `assets` (keyPath `id`，索引 `kind`) — 头像/封面图片字节，**只存本地、不进备份**
- `vanishedFavResources` (复合 keyPath `[folder_id, id]`，索引 `vanishedAt` / `vanishReason`) — 收藏消失档案
- `interactions` (keyPath `id` = `${type}:${bvid}`，索引 `type` / `bvid` / `state` / `observed_at` / `[type, observed_at]`) — 点赞 / 投币记录

后 5 个是 fork 新增（v9 的四个 + v10 的 `interactions`）。判定逻辑（改名/取关/注销、互动消失）一律放在纯函数模块如 `utils/followingDiff.ts` / `utils/interactionDiff.ts` 里，`utils/db.ts` 只做存取，便于单测不依赖 IndexedDB。

**改 schema 必须 bump `DB_CONFIG.version` 并在 `onupgradeneeded` 里写迁移分支**。历史写入必须走 `upsertHistorySnapshots()`，同时维护最近投影和观看事件；不能绕开它直接 `put`。当前实现里有兜底 `if (!db.objectStoreNames.contains(...))` 用来修复历史版本里 else-if 互斥导致的 store 缺失，新加 store 时也要补到这段兜底里。`smartMerge*` 系列是 WebDAV 双向同步的合并基元。

### 配置 / 状态键（[utils/constants.ts](utils/constants.ts)）

所有 `browser.storage.local` 的 key 都集中在这里以字符串常量导出。`UPDATE_HISTORY` 也在此维护——**发版时要同步更新它和 [package.json](package.json) 的 `version`**，侧边栏角标读 `UPDATE_HISTORY[0].version`。

读写一律走 [utils/storage.ts](utils/storage.ts) 的 `getStorageValue<T>` / `setStorageValue<T>`，不要直接 `browser.storage.local.get/set`。

### 前端（[pages/](pages/) + [components/](components/)）

- 路由由 [entrypoints/my-history/App.tsx](entrypoints/my-history/App.tsx) 用 `HashRouter` 定义：`/`(总览) `/history` `/welcome` `/about` `/settings` `/feedback` `/webdav-sync` `/favorites` `/collections` `/following` `/interactions`。`/welcome` 不显示侧边栏。
  （fork 已移除上游的 `/reward` 赞赏页、`/cloud-sync` 云同步页，以及 `/ai-search` AI 探索、`/music/*` 听歌、`/vanished` 消失档案页）
- 侧边栏菜单在 [components/Sidebar.tsx](components/Sidebar.tsx) 写死，可被 `HIDDEN_MENUS` 隐藏；新增页面要同时改 App.tsx 的 `<Route>` 和 Sidebar 的 `menuList`。
- 状态管理：除页面本地 `useState` + `browser.storage.local` 外无全局状态库（fork 已移除上游的 zustand `utils/store.ts`，用户身份改为直接读本地 B 站登录态）。
- 图标统一 `lucide-react`，路径别名 `@/` 指向项目根（见 [tsconfig.json](tsconfig.json) 继承的 `.wxt/tsconfig.json`）。

### 远端服务

fork **已删除**上游的云同步相关代码（`services/`、`utils/apiClient.ts`、`.env.*` 与 `/cloud-sync` 页面），因为那套会将用户历史数据发往第三方服务器（`bilibilihistory.com`）。B 站官方 API 调用一律直接 `fetch`（带 `SESSDATA`）。

保留的远端能力只有 [utils/webdav.ts](utils/webdav.ts)：用户自建 WebDAV 的双向同步（download → `smartMerge*` → upload）。

### AI 搜索（已移除）

上游的 `/ai-search` 页面（调 OpenAI 兼容接口做语义检索）在 fork 中**已删除**，连同 `pages/AISearch.tsx`。
`OPENAI_*` 与 `AI_SEARCH_HISTORY` 常量保留但已无引用。

### 听歌（已移除）

上游的 `/music/search` 与 `/music/liked` 页面、`components/SongItem.tsx`、`components/LikedMusicItem.tsx`
均**已删除**，备份项里的 `likedMusic` 仍保留（数据仍在库里，且旧备份仍可导入）。

### 消失档案页（已移除）

`pages/Vanished.tsx` 与 `/vanished` 路由**已删除**，但**底层机制完整保留**：

- `syncFavoriteFolderResources` 仍然「先留档再移除」，绝不硬删除在线消失的收藏
- `vanishedFavResources` store、`utils/favVanishedDiff.ts`、备份项都还在
- `smartMergeFavResources` 的防复活逻辑也还在

也就是说页面没了，但「收藏消失时数据不会被抹掉」这条保护依然生效。数据可在数据面板或备份文件中查看。

## 风格约定

- Prettier 配置见 [.prettierrc](.prettierrc)：100 列、双引号、尾随逗号、`arrowParens: always`。
- TS 严格模式来自 `.wxt/tsconfig.json`，`pnpm compile` 是唯一类型守卫。
- 共享类型集中在 [utils/types/index.ts](utils/types/index.ts)。新加 IDB 字段务必同步更新对应 interface（`HistoryItem` / `FavoriteFolder` / `FavoriteResource` 等）。
- TailwindCSS 3 + PostCSS；`tailwind.config.js` 的 `content` 已覆盖 `assets/entrypoints/pages/components`，新建顶层目录要补进去否则样式不会被扫描。
