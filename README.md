<div align="center">
  <img src="public/icon/128.png" alt="哔哩哔哩记忆" width="120" />

  <h1>哔哩哔哩记忆 · Bilibili Memory</h1>

  <p>
    <b>把 B 站的观看历史、收藏夹、订阅合集、关注列表与点赞/投币记录存在本地</b>
    <br/>
    当内容被删除、下架、转私密，或账号注销改名之后，你仍然知道自己丢过什么
  </p>

  <p>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" /></a>
    <img src="https://img.shields.io/badge/Chrome-支持-blue?style=flat-square" alt="Chrome" />
    <img src="https://img.shields.io/badge/Edge-支持-blue?style=flat-square" alt="Edge" />
    <img src="https://img.shields.io/badge/Firefox-支持-orange?style=flat-square" alt="Firefox" />
  </p>
</div>

---

## 这个项目要解决什么

B 站的很多东西**默认都是会消失的**：

| 数据 | B 站的限制 | 消失之后 |
| --- | --- | --- |
| 观看历史 | 只保留最近 3 个月 | 找不回来 |
| 点赞 / 投币记录 | 只保留最近 20 条 | 再也查不到你点过什么 |
| 收藏夹内容 | 可能被 UP 主删除、下架、转私密 | 只剩一条「已失效视频」 |
| 订阅合集内容 | 会被移出合集，或整夹被替换 | 连 BV 号都不剩 |
| 关注的 UP 主 | 可能改名，甚至注销账号 | **改名后连他原来叫什么都不知道** |

**哔哩哔哩记忆**把这些数据全部保存在浏览器本地 IndexedDB，并在发现内容消失时先留档、再处理。

## 功能特性

### 永久保存

- **观看历史** — 自动同步并永久保留，突破官方 3 个月限制
- **收藏夹** — 全量 + 增量同步；失效条目会保留本地已有的标题、封面与时长，不被占位数据覆盖
- **订阅合集** — 与收藏夹同一套失效保护
- **关注列表** — 记录改名、取关与注销，保留**曾用名链路**（B 站不提供历史昵称查询，这是唯一来源）
- **点赞与投币** — B 站只留最近 20 条，超出后本地仍完整保留；掉出窗口的条目**不会被删除**

### 消失档案

一个统一的留档页，汇总**收藏、订阅合集、关注、互动**四处「已经查不到」的内容：

- 每条都保存**消失那一刻的完整快照**，按来源与原因筛选，支持搜索与导出
- **可以恢复到原来的页面** —— 把快照写回收藏夹 / 订阅合集 / 关注列表 / 互动记录
- 按原因区分：UP 主删除、其他原因删除、内容不可见、已移出合集、改过曾用名……
- 只增不删；**默认纳入备份范围**（它是内容消失后的唯一副本）

### 备份与同步

- **WebDAV 双向同步** — 与坚果云 / 自建 WebDAV 互通，合并时逐字段择优，不因单向覆盖丢数据
- **本地目录自动备份** — 定时把数据写入你选的目录，**并把图片字节一并写成真实文件**
- **JSON 导出 / 导入** — 手动备份与迁移

> ⚠️ **图片字节（头像、封面）只在「本地目录备份」里保存**。JSON 与 WebDAV 备份**不含**图片字节。
> 如果你要「即使 B 站把图删了、我还能看到当时的头像」，必须用本地目录备份并把 `images/` 一起保存。

### 其他

- **存储明细** — 按类别列出占用：图片字节为精确值，结构化数据为采样估算，可按类别清理
- **失效收藏恢复** — 尝试从公开接口找回失效收藏的标题与封面
- **隐私优先** — 数据默认只存在本地；是否上传云端完全由你决定，且只发往你自己配置的地址

## 与上游项目的关系

本项目是 [bilibili-history-wxt](https://github.com/mundane799699/bilibili-history-wxt)（作者 [mundane799699](https://github.com/mundane799699)）的 fork，在原项目基础上做了大量扩展。

**上游已有能力**：观看历史、收藏夹、WebDAV 同步、JSON 导入导出、图片字节归档。

**本 fork 新增**：

- **关注 UP 主追踪** —— 改名 / 取关 / 注销事件，曾用名链路，注销前快照
- **点赞与投币记录**（`interactions`）—— 针对 B 站 20 条滚动窗口的永久留档
- **订阅合集备份与失效保护**
- **「消失档案」统一留档页** —— 四处来源汇总、可恢复到原页面
- **存储明细面板**、**失效收藏恢复**、**本地目录自动备份**
- 数据校验与合并策略的若干修正（含收藏/合集失效元数据保护、互动排序修正等）

**同时移除了上游这些功能**（因此本文档不再宣传它们）：

- **AI 语义搜索**（`/ai-search`）—— 它会把历史数据发往第三方 OpenAI 兼容接口
- **云同步**（`/cloud-sync`）—— 上游会把数据发往 `bilibilihistory.com`，本 fork 已彻底删除相关代码
- **听歌**（`/music/*`）与**赞赏页**（`/reward`）

- 原项目采用 MIT 许可证，版权归原作者及贡献者所有，详见 [LICENSE](LICENSE)
- 上游仓库：<https://github.com/mundane799699/bilibili-history-wxt>
- 本 fork 与上游的浏览器商店条目无关，**请勿把上游的商店链接当作本项目**

## 安装

本项目未上架任何浏览器商店，需要以「已解压扩展」方式加载：

```bash
pnpm install
pnpm build
```

或在没有 pnpm 的环境下：

```bash
npm install
npm run build
```

然后：

1. Chrome / Edge 打开 `chrome://extensions/`
2. 打开右上角「开发者模式」
3. 点「加载已解压的扩展程序」，选择 `.output/chrome-mv3`

Firefox 用 `pnpm build:firefox`，选择 `.output/firefox-mv2`（或 `firefox-mv3`）。

## 使用方法

1. 登录 [B 站网页版](https://www.bilibili.com)
2. 点击浏览器工具栏里的扩展图标进入主界面
3. 首次同步会全量抓取你的数据
4. 到「设置」页配置各类自动同步的开关与间隔
5. 到「数据备份」页配置 WebDAV 或本地目录备份——**消失档案不可再得，建议尽早开启**

## 技术栈

- [WXT](https://wxt.dev) — 跨浏览器扩展框架
- [React 19](https://react.dev) + [TailwindCSS 3](https://tailwindcss.com)
- [TypeScript](https://www.typescriptlang.org)
- IndexedDB（库名 `bilibiliHistory`）· `browser.alarms` · `declarativeNetRequest`

> 本 fork 已移除上游的 Zustand 全局状态库，改用页面本地 `useState` + `browser.storage.local`。

## 本地开发

**Node 版本要求：≥ 22.13。** pnpm 11 依赖 `node:sqlite`，Node 20 会直接报 `ERR_UNKNOWN_BUILTIN_MODULE`。

推荐用 pnpm（`pnpm-workspace.yaml` 里用 `patchedDependencies` 给 `wxt` 打了一个补丁，只有 pnpm 会应用）：

```bash
corepack prepare pnpm@11.7.0 --activate   # 或 npm install -g pnpm@11
pnpm install                              # postinstall 会自动跑 wxt prepare
pnpm dev                                  # Chrome 开发模式
```

也可以用 npm（已验证可构建）——代价是那个 wxt 补丁不会应用，`npm run dev` 下重载扩展时可能看到一个未捕获的 Promise 报错，`npm run build` 不受影响。

| 命令                | 说明                |
| ------------------- | ------------------- |
| `pnpm dev`          | Chrome 开发模式     |
| `pnpm build`        | 生产构建            |
| `pnpm compile`      | TypeScript 类型检查 |
| `pnpm test`         | 单元测试（vitest）  |
| `pnpm format`       | Prettier 格式化     |

> ⚠️ 仓库当前的代码与已安装的 Prettier 版本存在格式差异，`format:check` 会在**未改动的文件上**也失败。在弄清基准版本之前，**不要跑 `prettier --write`**，否则会产生大量无关改动。

判定逻辑（改名/取关/注销、互动消失、档案构造与合并）一律放在 `utils/*.ts` 的**纯函数**里，不依赖 IndexedDB，因此可以直接单测。

## 数据与隐私

- 所有数据默认存储在浏览器本地 IndexedDB（库名 `bilibiliHistory`），不上传任何服务器
- 使用 WebDAV 时，数据只会发往你自己配置的地址
- **图片字节归档（头像、收藏封面、互动封面）只存在本地**：本地目录备份会把它写成 `images/` 下的真实文件；JSON 与 WebDAV 备份**不含**图片字节

## 已知边界

这些是**接口能力决定的**，不是 bug：

- **点赞没有时间戳** —— B 站点赞接口不返回点赞时间。首轮记录的条目标「早期」，之后的显示本地首次记录日期
- **「B站已不显示」不等于你取消了点赞** —— B 站的 `relation` / `has/like` 接口**只反映近期状态**，很早的赞再查就是 `false`。实测对老视频重新点赞会提示「重复点赞」，说明记录仍在。因此本扩展**不删除**这类条目，标签也如实写作「B站已不显示」
- **互动记录是滚动窗口** —— B 站只返回最近 20 条，两次同步之间被挤出的条目无法补回
- **失效条目的元数据只在失效前抓到过时才能保留** —— 如果某个条目在保护逻辑生效之前就被占位数据覆盖，那部分信息无法找回

## 免责声明

本项目仅供个人备份自己的 B 站数据使用。所有数据来自你自己的登录态，存储在你自己设备上。请遵守 B 站的服务条款，不要用于批量抓取或任何商业用途。

## License

基于 [MIT License](LICENSE) 开源。

- Copyright (c) 2024 Bilibili History Plugin Contributors（上游）
- Copyright (c) 2026 Otiosum-coder（本 fork）
