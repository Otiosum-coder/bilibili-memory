# 设计文档：关注 UP 主记录、每日变动追踪与数据面板

> 状态：设计已评审通过，Phase 1 已实测，尚未实现。
> 相关文档：[content-preservation-design.md](./content-preservation-design.md)（收藏夹消失语义与视频封面归档）

## 需求

1. 记录当前账号关注的全部 UP 主**基础信息**（不含投稿内容），用于日后理解"这个 UP 主是谁"。
2. 同步频率：独立定时任务，默认每天一次（1440 分钟）。
3. 每天统计关注列表的变动：
   - 新关注了谁
   - 取关了谁
   - 哪个 UP 主改了名字（旧名 → 新名）
4. **取关与 UP 主注销必须区分**，通过筛选查看。
5. **必须保留 UP 主注销前的名字**，即注销后仍能看到"这个 UP 主当时叫什么"。
6. 提供独立的数据面板页面，展示跨模块指标与关注变动趋势。
7. 头像做字节归档，UP 主注销后头像 URL 失效也不会丢图。

### 明确不做：不记录 UP 主的投稿内容

关注模块只保存 UP 主本人的基础信息（mid、昵称、曾用名、头像、签名、认证、关注时间、互关/特别关注、状态与时间戳），**不保存投稿列表**。理由：工程量过大，且不符合使用习惯。

连带后果：内容保全的责任全部落在既有收藏夹 / 历史记录模块上，见 [content-preservation-design.md](./content-preservation-design.md)。

## 现状核对

- 本仓库此前**完全没有**关注列表功能：全仓库无 `relation/followings` 调用、无 `following` store。
- "收藏夹的同步频率"**当前并不存在**：`FAV_AUTO_SYNC_ENABLED` / `FAV_SYNC_INTERVAL` / `FAV_SYNC_TIME_REMAIN` 是死代码，见 [fav-auto-sync-switch.md](./fav-auto-sync-switch.md) 与 v2.1.0 更新日志"后台同步去掉自动同步收藏夹的逻辑"。收藏夹与订阅合集均为手动触发。
- 仓库**没有任何图表库**，也无指标/事件基础设施；`utils/db.ts` 已有各模块本地计数 getter，可低成本支撑跨模块静态指标。
- 仓库**没有 blob/资源 store**，所有图片字段（`FavoriteResource.cover`、`FavoriteResource.upper.face`、`SubscribedCollection.cover`、`SubscribedCollectionResource.cover`、`HistoryItem.cover`、`LikedMusic.pic`）都只存 URL。
- `HistoryItem` 不存 UP 主头像（只有 `author_name` / `author_mid`）；目前只有 `FavoriteResource.upper.face` 与 `SubscribedCollection.upper.face` 两处存过头像。

## 设计

### 1. 状态模型（单枚举 + 终态优先级）

```ts
status: "following" | "unfollowed" | "gone";
```

- `following`：仍在关注。
- `unfollowed`：已取关，且账号仍存在。
- `gone`：账号已注销。

**优先级规则：`gone` 是终态，不被 `unfollowed` 覆盖。**

已知取舍：若用户先取关、该 UP 主之后才注销，快照态显示为 `gone` 而非 `unfollowed`。完整历史不丢失——`followingEvents` 事件流中 `unfollowed` 与 `account_gone` 两条事件都保留，时间线仍能还原先后顺序。快照态只服务于当前状态的筛选。

### 2. 数据模型

#### 2.1 `following`（keyPath `mid`，索引 `by-status`）

| 字段 | 说明 |
| --- | --- |
| `mid` | UID |
| `name` | **最后一次已知的真实昵称，永不写入空值或平台占位文案** |
| `avatarAssetId` | 指向 `assets` store 的头像字节归档 |
| `face` | 原始头像 URL（归档失败时的兜底） |
| `sign` | 签名 |
| `mtime` | 关注时间（接口字段，秒级时间戳） |
| `attribute` | 2 已关注 / 6 互粉 |
| `special` | 是否特别关注 |
| `official_verify` | 认证信息，改名后识别身份的第二锚点 |
| `status` | 上述单枚举 |
| `firstSeenAt` / `lastSeenAt` / `lastSeenInSyncAt` | 首次/最后出现时间 |
| `goneDetectedAt` | 判定注销的时间 |
| `unfollowedDetectedAt` | 判定取关的时间 |
| `nameHistory` | `Array<{ name: string; seenAt: number }>`，纯追加 |
| `nameSource` | `"api"` / `"local_backfill"`，标记 `name` 的来源 |
| `thirdPartyNames` | `string[]`，第三方存档的曾用名列表；**无时间戳，绝不并入 `nameHistory`** |
| `thirdPartyQueriedAt` | 第三方曾用名查询时间；已查过的不重复请求 |

**`nameHistory` 采用纯追加语义**：只记录"某次同步看到它叫这个名字"，展示时由相邻两条推算时间区间。

- 优点：写入逻辑最简、不可变追加、WebDAV 合并只需并集去重；"推算区间"是纯函数，可进单测。
- 若改为回填 `endedAt` 的写法，一旦漏回填整条时间轴即断裂。
- 首次基线的名字也写入，因此 `nameHistory.length === 1` 表示"从未改名"。

**关键数据陷阱**：接口文档明确 `mtime` 为"对方关注目标用户时间，**互关后刷新**"。因此：

- 它是"最近一次关系变化时间"，不是稳定的"你何时关注他"。
- **绝不能因为 `mtime` 变化就推断"重新关注"**，那会造出一批假事件。
- 界面文案标注为"关注时间"而非"关注于"。

#### 2.2 `followingEvents`（keyPath `event_id`，索引 `occurred_at` / `day` / `type` / `mid`）

```ts
type FollowingEventType = "followed" | "unfollowed" | "renamed" | "account_gone";

interface FollowingEvent {
  event_id: string; // `${type}:${mid}:${day}`，保证同日重复同步幂等
  type: FollowingEventType;
  mid: string;
  day: string; // YYYY-MM-DD，本地时区
  occurred_at: number;
  name: string; // 变动后的名称；account_gone 时为注销前名称
  previous_name?: string; // 仅 renamed / account_gone
}
```

事件 id 使用 `type:mid:day` 而非时间戳：日频同步下同一天可能重复跑，带时间戳会产生重复事件。

#### 2.3 `assets`（keyPath `id`，索引 `by-kind`）— 与内容保全模块共享

```ts
interface AssetRecord {
  id: string;
  kind: "avatar" | "cover";
  mimeType: string;
  blob: Blob;
  sourceUrl: string;
  createdAt: number;
}
```

**图片字节只存本地 IndexedDB，不进 WebDAV / 本地目录备份。** 备份只保留元数据与 URL，避免云同步被几十到几百 MB 的图片拖垮。

### 3. 判定规则表

按顺序执行，先判异常再判变动。

| # | 情况 | 条件 | 结果 |
| --- | --- | --- | --- |
| 1 | 首次基线 | `HAS_FULL_FOLLOWING_SYNC` 未置位 | 只写快照，**零事件**（否则首日刷出数百条"新关注"） |
| 2 | 新关注 | 本地无此 mid 且已过基线 | `followed` |
| 3 | 重新关注 | 本地 `unfollowed` → 本轮在列表 | `followed` |
| 4 | 账号已注销 | 本轮返回的名字为空 / 属于占位文案集合 | `account_gone`，`name` 保留原名 |
| 5 | 改名 | 新旧名字**均非空且非占位**，且不相等 | `renamed`，带 `previous_name` |
| 6 | 取关 | **完整分页扫完全部 `total` 条后**本轮未出现 | `unfollowed` |

规则 4、5 的顺序是关键：**绝不允许把占位文案当成新昵称而产生"改名"事件**，这是"保留注销前名字"能成立的唯一前提。

改名比较只做 `trim()`，不做 Unicode 归一化——归一化会把"全角改半角"这类真实改名吃掉。

规则 6 的护栏来自既有实践：只有一次**完整**分页成功结束后才允许判定取关，中途失败或只扫首页必须不判定，否则一次网络抖动会把整个关注列表误标为已取关。

**护栏必须按 `total` 判定，不能按页数判定。** 实测：本人关注 1142 条，而固定 20 页上限只能扫到 1000 条——若按页数判定，剩余 142 条会被全部误判为"已取关"，一次性产生 142 条假事件。

### 4. 注销判定：不需要任何探测（Phase 1 已实测确认）

原设计曾计划对"消失的 mid"二次探测以区分取关与注销。**实测证明这是多余的，该流程已从设计中删除。**

实测证据（自身账号：关注 1142 条，本次扫描 1000 条）：

- 关注列表中 11 个已注销账号**全部仍在列表中**，`uname` 是**字面量 `"账号已注销"`**（长度 5），**不是空字符串**；`attribute` 仍为 2；`mtime` 跨度从 2023-10 到 2026-06，说明注销账号长期保留在关注列表里。
- `https://api.bilibili.com/x/web-interface/card?mid=` 对已注销账号返回 **`code: 0` / `message: "OK"`**，并不会返回 `-404`——它只是把占位文案当正常名字返回。

因此注销判定完全由关注列表接口自身完成，**不引入 `x/web-interface/card` 依赖、不需要探测节流、没有探测失败分支**。

占位文案集合集中在一个常量中（当前为 `"账号已注销"`；同时把空字符串与 trim 后为空也纳入，作防御性处理）。

#### 4.1 注销前名字的恢复（两级）

在安装插件之前就已注销的账号，真实名字本地从未记录过，`name` 只能拿到占位文案。恢复分两级：先跑免费的，再动用第三方的。

**第一级：本地反查（零成本，自动执行）**

- 来源一：`HistoryItem.author_name`（按 `author_mid` 匹配）
- 来源二：`FavoriteResource.upper.name` 与 `SubscribedCollection.upper.name`（按 `upper.mid` 匹配）
- 实测支撑：失效收藏条目**仍完整保留 UP 主 `mid/name/face`**，即使视频已失效，UP 主真实名字仍在
- **实测覆盖率**：收藏夹来源 **0/15**（Phase 1b——用户收藏夹内 736 个不同 UP 主与 15 个已注销账号零交集）。历史来源尚未实测，需 Phase 2 在扩展内量。
- 定位：免费的一遍扫描，代价为零，但不指望它解决问题

**第二级：第三方曾用名查询（可选，用户主动触发）**

官方接口对已注销账号只返回 `"账号已注销"`（Phase 1 实测），本地数据又几乎无覆盖（0/15），因此**唯一能恢复注销前名字的途径是第三方存档站**。

Phase 3 实测确认的来源与行为：

- 域名：**`https://api.aicu.cc`**（前端写的是相对路径；实测 `www.aicu.cc` 与 `worker.aicu.cc` 都不可用）
- 接口：`GET /api/v4/user/getusermark?uid={mid}` → 取 `data.hname[]`
- **无需鉴权**，直接返回 `code 0`
- `data` 字段：`hname` / `gh` / `gh2` / `device` / `tag` / `text`（只用到 `hname`）
- **实测覆盖率：11/15（73%）**，共 40 条曾用名

**hname 的三个数据质量限制（必须在实现里体现）**

1. **没有时间戳。** 所以第三方数据只能回答"改过哪些名字"，**回答不了"哪天改的"**。因此**绝不能并入 `nameHistory`**——那个是按 `seenAt` 排序的本地观测记录，混入无时间的数据会污染整条时间轴。必须单独存 `thirdPartyNames`。
2. **顺序不保证按时间，且可能混入占位文案。** 实测 `mid=393396916` 的列表里 `"账号已注销"` 出现在中间位置、其后还有两个名字；`mid=19486158` 的列表以 `"账号已注销"` 结尾。实现必须**先过滤占位文案，再取最后一个作为"最可能的注销前名字"**，并把完整列表原样展示、标注来源与不确定性——不要假装知道哪个是"确定的那一个"。
3. **空数组无法区分"从未改名"与"未收录"。** 4 个账号返回空列表。UI 不得把空呈现为"确定没有曾用名"。

**CORS / Origin 风险（发布版必须验证）**：`api.aicu.cc` 允许 `www.aicu.cc` 跨域读取，但**是否允许 `chrome-extension://` 来源未知**。扩展的 service worker 对已在 `host_permissions`（当前为 `<all_urls>`）内的地址通常可绕过 CORS，但服务器若校验 `Origin` 仍会拒绝。**此项必须在 Phase 2 实测，未通过则该功能整条不可用。**

**因为本项目要发布给其他用户，这一级必须满足以下硬约束：**

| 约束 | 要求 |
| --- | --- |
| 触发方式 | **仅用户主动点击**。绝不进入定时任务、绝不随同步自动发生 |
| 查询范围 | **仅限本地名字已是占位文案的账号**（即已注销账号）。绝不对全部关注批量查询 |
| 默认状态 | 默认**关闭**，设置页提供开关 |
| 明示同意 | 首次使用前弹出确认，明确告知"将把该账号 mid 发送至第三方站点 aicu.cc" |
| 限速 | 单次最多 N 个，请求间隔 ≥ 1 秒，可随时中断 |
| 幂等 | 记录 `thirdPartyQueriedAt`，已查过的不重复请求 |
| 失败降级 | 接口变更 / 限流 / 站点下线时静默失败，**不影响任何本地功能** |
| 模块隔离 | 独立文件 `utils/thirdPartyNameLookup.ts`，便于日后整体移除 |
| 硬约束不变 | 只写入非空且非占位的名字 |

**风险声明（须写进设置页说明）**：该接口是第三方站的内部接口，无文档、无承诺，可能随时变更或关闭；批量滥用会给对方造成负担；嵌入发布版存在被投诉或下架的风险。因此"**永不自动调用**"是最重要的一条边界。

许可证方面无阻碍：本仓库为 MIT，fork 与发布只要保留版权声明即可。但 MIT 只约束代码，不覆盖第三方站点接口的使用条款。

### 5. 头像字节归档

**必须在头像 URL 还活着的时候抓取，不能等到发现 UP 主注销时才动手**——那时 URL 已失效，什么也抓不到。因此归档是一个**持续任务**而非一次性动作：

- **增量补齐**：每次关注同步后，对新增或 `avatarAssetId` 为空的记录抓取头像，存入 `assets`，回写 `avatarAssetId`。
- **一次性回填**：对已有关注记录批量补齐。
- 抓取目标使用带尺寸参数的缩略地址（约 5KB/张），归档约 1000 关注 ≈ 5 MB。
- 页面渲染优先用 `avatarAssetId` 对应的 Blob，缺失时回退 `face` URL，再缺失回退 `public/noface.jpg`。

**硬前置条件已通过（Phase 2 实测）**：扩展内 `fetch` hdslb 头像返回 `200`、`image/jpeg`、73215 字节可读，且**不需要 DNR 规则**。归档可以开工。

实测同时给出了尺寸依据：**原图 71.5 KB**，所以抓取必须使用带尺寸参数的缩略地址（如 `@160w_160h_1c.webp`），否则 1142 个头像约占 80 MB，而不是原先预估的 5 MB。缩略参数能否同样读成 Blob 需在实现时顺手确认。

### 6. 调度

- 新建独立 alarm，每分钟 tick + 时间差节流（沿用现有 `syncHistory` 模式）。
- `FOLLOWING_SYNC_INTERVAL` 默认 **1440 分钟**。
- `FOLLOWING_AUTO_SYNC_ENABLED` 默认 **开启**：每日变动日志的价值依赖持续运行，默认关闭会让功能形同虚设。设置页提供关闭开关。
- 必须带：单次最多翻 N 页后落游标续跑（实测关注数 1142 条 ≈ 23 页）、页间随机延迟、`-352` 冷却、`-101` 提示登录。

### 7. 接口约束（已从接口文档 + 实测确认）

`https://api.bilibili.com/x/relation/followings?vmid={自己mid}&pn={page}&ps=50`

- 认证：Cookie `SESSDATA`；自己 mid 经 `x/web-interface/nav` 获取。
- **要求 Referer 在 bilibili.com 域下，且 UA 不含 `python`**，否则不返回列表。实测在 `t.bilibili.com`（子域）下正常返回，符合文档"子域即可"。
- 返回字段：`mid / uname / face / sign / mtime / attribute / special / official_verify / vip`，以及 `data.total`。
- 错误码：`-101` 未登录、`-352` 请求被拦截、`22115` 用户已设置隐私无法查看（查自己不受限）。
- `attribute` 语义：2 已关注、6 已互粉、128 已拉黑。实测分布：2 → 995、6 → 5。

`x/web-interface/nav` **不需要** Referer（现有收藏夹同步只带 Cookie 调用它，生产可用即为证据）。

### 8. 界面设计

#### 8.1 关注列表页 `/following`

**布局：左侧筛选面板（带计数）+ 三列卡片网格。**

> ⚠️ **本条推翻了早先的决定。** 原设计写的是"用列表行、不用卡片网格"，理由是"关注列表没有封面图，套网格会留大片空白"。实现完成后与 B 站官方关注页比对，发现这个前提是错的：UP 主卡片不需要封面，头像是圆形、签名占两行、再加关注时间，**内容是填得满的**。真正会留白的是 Favorites 那种以封面为主体的卡片。故改为卡片网格。

- **左侧面板**（`w-56`）：`全部关注 / 仍关注 / 已取关 / 已注销` 四项，各带实时计数；底部显示上次同步时间与同步健康状态（未登录 / 风控 / 上次不完整）。
- **主区容器**：`mx-auto max-w-[1500px] px-6 py-5 lg:px-10` —— 列表页用宽容器（对齐 History 的 `max-w-[1600px]`），两侧保留明显留白。
- **网格**：`grid gap-4 sm:grid-cols-2 xl:grid-cols-3`，每页 48 条。

卡片结构：

- **左**：64px 圆形头像。优先渲染归档 Blob，回退 `face` URL（`.replace("http:", "https:")`），最终回退 `public/noface.jpg`，并有 `onError` 兜底。
- **右**：昵称 + 状态徽章 + 互关 / 特别关注标记；认证信息；签名（`line-clamp-2` + `title` 全文）；关注时间（**精确到秒**，与 B 站官方页一致）或状态变更时间；曾用名入口。

**跳转个人空间**：使用真正的 `<a href={`https://space.bilibili.com/${mid}`} target="_blank" rel="noopener noreferrer">` 包住昵称（头像不做链接，避免与卡片内其它可点元素冲突）。理由：保留中键新标签页、右键菜单、键盘聚焦。已注销的卡片把昵称渲染为不可点的 `<span>`。

**已注销禁用跳转**：注销后 `space.bilibili.com/{mid}` 只会落到"账号已注销"页面，是死路。

**状态可视化不止徽章**：已取关 / 已注销整张卡片降不透明度 + 头像灰度，扫读时立刻可辨。状态变更时间显示为"YYYY/MM/DD HH:mm:ss 检测到注销"。

**曾用名呈现**：

- 昵称旁小标签 `曾用名 N`，**仅当 `nameHistory.length > 1` 时出现**。
- 点击展开 Popover，倒序时间轴：

  ```
  现名 XXX        2026-06-10 起
  ← 旧名 A        2026-05-01 ~ 2026-06-10
  ← 旧名 B        ~ 2026-05-01
  ```

- 反查回填得到的名字要标注来源（如"由收藏记录反查"），因为它不是通过同步观测到的
- **第三方曾用名单独分区展示**：标注"来自第三方存档 · 无时间 · 顺序不保证"，与本地观测到的带时间改名记录明确分开，绝不混入同一条时间轴
- 不使用 `title` 属性（无法多行排版、不可复制、悬浮延迟长；仓库中 `title` 仅用于纯文本截断兜底）。
- 不在行内直接铺开（改过三次名会撑爆行高，扫读噪音大）。
- 不只显示"上一个名字"（多次改名会丢信息，而需求恰恰是"那个 UP 主改了名字"）。
- **搜索必须覆盖曾用名**：痛点是"记得旧名字却搜不到人"。

工具栏：搜索（昵称 / UID / 签名 / 曾用名）、四态筛选（全部 / 仍关注 / 已取关 / 已注销）、排序（关注时间新→旧、旧→新、UID、昵称 `localeCompare("zh-Hans-CN")`）、手动同步按钮、最后同步时间。分页 pageSize 50（与同步页一致）。

UI 层的直接结果：**页面上永远不会出现"账号已注销"这个占位文案作为人名**——显示的 `name` 就是注销前的真实昵称（或反查到的名字）。

#### 8.2 数据面板 `/dashboard`（顶层一级入口）

侧边栏新增一级入口（注意侧边栏仅 160px 宽 `w-40`，标题需短）。

**图表手写 SVG + Tailwind，不引入图表库。** 理由：仓库现无任何图表依赖；扩展体积与更新量敏感；所需图形仅堆叠柱、占比条、折线三类；深色模式可直接用 Tailwind 类控制。聚合逻辑做成 `utils/followingStats.ts` 纯函数（输入 `following[]` + `followingEvents[]` + 各模块计数，输出视图模型），与 `utils/followingDiff.ts` 一起进 vitest，无需 mock IndexedDB。

面板模块：

| 区块 | 内容 | 数据来源 |
| --- | --- | --- |
| A 跨模块 KPI | 历史记录数 / 收藏夹资源数 / 收藏夹个数 / 订阅合集数 / 听歌数 / 关注总数 | 复用现有 getter：`getTotalHistoryCount`、`getFavResources`、`getFavFolders`、`getAllSubscribedCollections`、`getTotalLikedMusicCount`。零新增同步 |
| B 关注构成 | 仍关注 / 已取关 / 已注销 横向占比条 | `following` 快照 |
| C 每日变动趋势 | 堆叠柱，四类事件分色（新增/取关/改名/注销），近 7/30/90 天可切 | `followingEvents` 按 `day` 分组 |
| D 变动构成 | 取关 vs 注销占比（核心诉求在统计层的落点） | `followingEvents` |
| E 榜单 | 改过名最多 Top 5（含曾用名数）、关注最久 Top 5、最近变动明细（点击跳列表页对应筛选） | `following` + `followingEvents` |
| F 数据健康度 | 最后/下次同步时间、同步状态（正常 / 风控冷却 / 未登录）、累计失败次数、基线是否建立、归档进度 | `browser.storage.local` |

**不做 `mtime` 历史增长曲线**：`mtime` 互关后会刷新，回溯重建只能得到近似值，本期不展示这类近似数据。直接后果是**趋势图在刚安装时为空**，因此空状态文案必须写明"记录自 YYYY-MM-DD，趋势随每日同步累积"，否则用户会以为功能损坏。KPI 与关注构成立即可用（全部来自快照）。

**首页（历史记录页 `/`）不加入任何变动流**：该页已承担分页/滚动双模式、搜索+类型筛选、日期区间选择器、视图设置弹窗，再加入第二条跨模块信息流属于职责错配，且用户看到"新增收藏"却身处历史记录页会产生概念错配。跨模块状态沿用 `HistoryItem` 的"已收藏"徽章这类轻量提示，需要增强时增强徽章而非加信息流。

### 9. 集成点清单

关注追踪链路的代码已全部完成（`tsc` 通过、99 项单测通过）。`[ ]` 表示尚未开始。

**已完成**

- [x] `utils/constants.ts`：storage key 常量（`HAS_FULL_FOLLOWING_SYNC` / `FOLLOWING_LAST_SYNC` / `FOLLOWING_AUTO_SYNC_ENABLED` / `FOLLOWING_SYNC_INTERVAL` / `FOLLOWING_SYNC_PROGRESS` / `THIRD_PARTY_NAME_LOOKUP_ENABLED` / `FOLLOWING_AVATAR_ARCHIVE_PROGRESS`）与 `UPDATE_HISTORY` 条目
- [x] `utils/types/index.ts`：`FollowingItem` / `FollowingNameRecord` / `FollowingEvent` / `AssetRecord` / `VanishedFavResource`；`DBConfig.stores` 扩展 4 个 store
- [x] `utils/db.ts`：版本 8→9；`oldVersion < 9` 迁移分支（幂等，同时覆盖全新安装与升级）；四个新 store 的 CRUD；`moveFavResourcesToVanished`（同事务写档案 + 删原记录）
- [x] `utils/followingDiff.ts`：判定规则 1–6（纯函数）
- [x] `utils/followingApi.ts`：关注接口层，错误按 `rate_limited` / `auth` / `network` / `data` / `unknown` 分类
- [x] `utils/followingSync.ts`：编排层（依赖注入），含完整性护栏与基线建立时机
- [x] `utils/followingQuery.ts`：查询 / 筛选 / 排序 / 分页 / 曾用名时间轴（纯函数）
- [x] `utils/followingStats.ts`：面板聚合（纯函数）
- [x] `utils/imageUrl.ts`：图片 URL 纯工具（**实现过程中拆出来的**——原先混在 `assetArchive.ts` 里，导致纯逻辑模块的单测被拖入 `db.ts` 的整个模块图）
- [x] `utils/assetArchive.ts`：图片字节归档 IO
- [x] `utils/followingAssetArchive.ts`：头像归档任务（依赖注入，可单测）
- [x] `entrypoints/background.ts`：`syncFollowing` 与 `archiveFollowingAvatars` 两条 alarm（含 Service Worker 启动兜底）、手动同步与手动归档消息
- [x] `entrypoints/my-history/App.tsx`：`/following` 与 `/dashboard` 两条路由
- [x] `components/Sidebar.tsx`：`menuList` 新增「关注」「数据面板」
- [x] `pages/Following.tsx`、`pages/Dashboard.tsx`

**尚未开始**

- [ ] `utils/nameBackfill.ts`：本地反查注销前名字。**历史来源的覆盖率至今没有实测过**（收藏夹来源实测 0/15），做之前应先量
- [ ] `utils/thirdPartyNameLookup.ts`：第三方曾用名查询，**独立可移除模块**；默认关闭、仅手动触发、仅限已注销账号（硬约束见 4.1）
- [ ] `utils/export.ts`：JSON 导出 / 导入接入新 store
- [ ] `DEFAULT_WEBDAV_SYNC_ITEMS` 与 `DEFAULT_LOCAL_HISTORY_BACKUP_ITEMS` 增加 `following` / `followingEvents`（**不含 `assets`**）。它牵连 `background.ts` / `WebDavSync.tsx` / `LocalHistoryBackupPanel.tsx` / `localHistoryBackup.ts` 四处，刻意推迟到数据形态稳定之后
- [ ] `pages/Settings.tsx`：关注自动同步的开关与间隔

**实现顺序建议**：关注追踪（已完成）→ 头像归档（已完成）→ 第三方曾用名查询 → 内容保全（破坏性变更，最后做）

**统一 DB 迁移**：两个模块都需要升级 schema，**只升一次**（当前 `version: 8` → 9），一次性创建全部新 store：

| store | 归属模块 | keyPath |
| --- | --- | --- |
| `following` | 关注追踪 | `mid` |
| `followingEvents` | 关注追踪 | `event_id` |
| `assets` | 共享 | `id` |
| `vanishedFavResources` | 内容保全 | `[folder_id, id]` |

### 10. 测试策略

本仓库此前无测试框架（CLAUDE.md 明确说明）。本次引入 **vitest**，但**只覆盖纯函数**：

`utils/followingDiff.ts`：

- 基线（首轮不产事件）
- 新关注 / 重新关注
- 改名（含"占位文案不得判为改名"的负例）
- 注销（名字为空 / 为字面量占位文案两种输入）
- 取关仅在完整扫描后成立（含"未扫到 `total` 条时不得判定取关"的负例）

`utils/followingStats.ts`：

- `nameHistory` 区间推算（含仅有基线一条、多次改名、时间倒序）
- 按日事件聚合与四类计数
- 跨模块 KPI 组装

其余 UI 与调度逻辑以 `pnpm compile` + `pnpm format:check` + 浏览器手工验证为准。

## 决策记录

| 决策 | 结论 |
| --- | --- |
| 目标代码库 | 本仓库（bilibili-history-wxt 工作区副本） |
| 项目定位 | **要发布给其他用户** → 第三方能力不得进入任何自动路径 |
| 同步频率 | 独立 alarm，默认 1440 分钟 |
| 状态建模 | 单枚举 `following/unfollowed/gone`，`gone` 为终态 |
| 取关 vs 注销 | 仅靠 `uname === "账号已注销"` 判定；**探测流程已删除**（Phase 1 实测证明多余） |
| 注销前名字恢复 | 两级：本地反查（自动、零成本）+ 第三方曾用名查询（可选、手动、仅限已注销账号） |
| 第三方依赖 | 采用 `api.aicu.cc` 的 `/api/v4/user/getusermark`，但**永不自动调用**；默认关闭、明示同意、限速、模块可移除 |
| 第三方数据落库 | 单独存 `thirdPartyNames`，**不并入 `nameHistory`**（第三方数据无时间戳，混入会污染时间轴） |
| DNR 规则 | **不需要**（Phase 2 实测：不加规则直接可用，加规则结果一致）；仅当 SW 内出现 `-352` 时补 |
| Cookie 传递 | 沿用手动 `Cookie: SESSDATA=...` 头（上游生产已验证）；`credentials: include` 虽可用，但受 Chrome 第三方 Cookie 政策影响 |
| 测试策略 | 引入 vitest，只测纯函数 |
| 列表布局 | **卡片网格（三列）+ 左侧筛选面板**；早先的"列表行"决定已被与 B 站官方页的比对推翻 |
| 曾用名呈现 | 标签 + Popover 时间轴；搜索覆盖曾用名 |
| 已注销跳转 | 禁用 |
| 面板位置 | 顶层一级入口 `/dashboard` |
| 面板范围 | 跨模块静态指标 + 关注变动事件流 |
| 图表实现 | 手写 SVG + Tailwind，不引入图表库 |
| mtime 历史曲线 | 不做（互关刷新时间，只能是近似值） |
| 收藏夹变动流 | 本期不做；其他模块仅进静态指标 |
| UP 主投稿动态 | 不做（需额外接口与 WBI 签名） |
| 首页变动流 | 不做 |
| 关注模块内容范围 | 只存 UP 主基础信息，不存投稿 |
| 头像归档 | 做，只存本地不进备份；实测只对"尚未注销"的账号有意义 |
| 收藏夹消失语义 | 分层留档 + 二次探测（见内容保全文档） |
| 封面归档 | 收藏视频封面，失效条目跳过（见内容保全文档） |

## 验证状态

### Phase 1 已完成（页面上下文，Referer 与 Cookie 天然正确）

| 问题 | 结论 |
| --- | --- |
| 注销账号是否仍在关注列表 | ✅ 是。全量扫完 1142 条得到 **15 个**，全部仍在，`mtime` 跨度 2020-04 至 2026-06 |
| `uname` 是空字符串还是占位文案 | ✅ 字面量 `"账号已注销"`（长度 5） |
| `x/web-interface/card` 对注销账号的返回 | ✅ `code: 0` / `message: "OK"`，**不是 `-404`** → 探测流程已删除 |
| 关注接口的 Referer 要求 | ✅ 在 `t.bilibili.com`（子域）下正常返回，符合"子域即可" |
| 关注规模 | ✅ 1142 条 → 完整性护栏须按 `total` 判定 |

### Phase 1b 已完成（页面上下文）

| 问题 | 结论 |
| --- | --- |
| 已注销账号的头像 | ⚠️ 15 个全部为 `member/noface.jpg`（路径去重数 1）→ **注销后真实头像立即丢失**，归档只对"尚未注销"的账号有意义 |
| 本地反查注销前名字 | ⚠️ 收藏夹来源 **0/15**（收藏夹内 736 个不同 UP 主与 15 个注销账号零交集）；历史来源待 Phase 2 实测 |
| 第三方曾用名接口 | ✅ 字段为 `data.hname[]`，接口出自 aicu.cc 后端（非官方）；覆盖率待 Phase 3 实测 |

### Phase 3 已完成（在 aicu.cc 页面控制台运行）

| 问题 | 结论 |
| --- | --- |
| 接口真实域名 | ✅ `https://api.aicu.cc`（相对路径与 `www.aicu.cc` 均返回 SPA HTML，`worker.aicu.cc` 返回 404） |
| 是否需要鉴权 | ✅ 不需要，直接 `code 0` |
| 曾用名覆盖率 | ✅ **11/15（73%）**，共 40 条曾用名 |
| 是否含时间戳 | ❌ 不含 → **不能并入 `nameHistory`**，单存 `thirdPartyNames` |
| 顺序是否可靠 | ❌ 不可靠，且可能混入 `"账号已注销"` → 必须过滤占位文案后取末项，并展示完整列表 |
| 扩展内是否可调用 | ⏳ 待 Phase 2 实测（CORS / Origin 校验风险） |

### Phase 2 已完成（扩展页上下文，扩展 ID `gdnigbmjcjkldciajkjgeoibmimlionh`，v2.2.3）

全部通过：

| 检查 | 结果 |
| --- | --- |
| nav（手动 Cookie 头） | ✅ `code 0` |
| 关注接口（手动 Cookie 头，**不加 DNR 规则**） | ✅ `code 0`，返回 5 条 |
| 关注接口（`credentials: include`，不加规则） | ✅ `code 0` |
| 关注接口（加 DNR 规则） | ✅ `code 0`（与不加规则一致） |
| **hdslb 图片 fetch 成 Blob** | ✅ `200`、`image/jpeg`、**73215 字节可读** |
| **`api.aicu.cc` 调用** | ✅ `code 0`，`hname` 5 条 |
| `x/web-interface/view`（已知失效 bvid） | ✅ `code 62002`，与页面上下文一致 |

**两个纠正原设计的结论**

1. **不需要新增 DNR 规则。** 原设计把"为关注接口追加 Referer 规则"列为必需集成点并标记为风险点，实测不必需——不加规则直接 `code 0`。
2. **`credentials: include` 也能带 Cookie**，比上游"手动读 Cookie 再塞 header"更简洁。但**仍建议沿用手动 Cookie 头**：`credentials: include` 依赖浏览器把 bilibili.com 的 Cookie 当第三方 Cookie 发送，而 Chrome 正在逐步收紧第三方 Cookie，行为会随时间变化；手动 Cookie 头不依赖该策略，且上游已在生产验证。

注意：本轮在**扩展页**上下文完成，不是 service worker。两者在 `host_permissions` 下的跨域行为一致，但 Referer/Origin 头的具体取值可能有差异。鉴于"不加规则即可成功"说明 B站 对扩展来源足够宽松，SW 大概率一致——但实现时保留兜底：**若 SW 内出现 `-352`，补一条 DNR 规则即可。**

## 不做

- **不记录 UP 主的投稿内容**（只存 UP 主基础信息）。
- **不做注销二次探测**（Phase 1 实测证明 `uname` 占位文案已足够）。
- **不自动调用任何第三方接口**（第三方曾用名查询仅手动触发、默认关闭、仅限已注销账号）。
- **不对全部关注批量查询第三方**（会外发完整关注列表，且给对方造成负担）。
- **不做 `mtime` 历史增长曲线**（互关刷新时间，只能是近似值）。
- **不做收藏夹及其他模块的变动事件流**（其他模块仅作为静态指标进入数据面板）。
- **不做 UP 主投稿/更新动态分析**（需 space 稿件接口 + WBI 签名，独立一期）。
- **历史记录封面不进字节归档**（量级过大，本期只归档头像与收藏视频封面）。
- **图片字节不进 WebDAV / 本地目录备份**。
- **首页（历史记录页）不加入任何变动流**。
- 不做卡片网格布局及其切换开关。
- 不同步、不展示关注分组（`x/relation/tags`）。
- 不做"最常访问"排序（`order_type=attention`），只按关注顺序全量扫描。
- 不改动历史记录、收藏夹、订阅合集、WebDAV 的既有主流程。

## 验收

1. 首次完整同步后建立基线，不产生任何变动事件。
2. 第二次完整同步能正确产出新增关注、取关、改名、注销四类事件。
3. 中途失败或未扫到接口 `total` 条时，不产生任何取关误判。
4. 已注销 UP 主在页面上仍显示注销前的名字（本地反查或第三方查询所得），且"账号已注销"占位文案绝不作为人名出现。
5. 筛选能区分"已取关"与"已注销"。
6. 曾用名标签仅在改过名时出现，Popover 时间轴顺序正确；反查回填的名字标注来源；用旧名字能搜到该 UP 主。
7. 已注销行的空间跳转被禁用。
8. 头像字节归档生效：断网或头像 URL 失效后，头像仍能显示。
9. 数据面板跨模块 KPI 有数据；趋势图空状态文案写明记录起始日期。
10. `pnpm compile` 与 `pnpm format:check` 通过；`utils/followingDiff.ts` 与 `utils/followingStats.ts` 的 vitest 用例通过。
11. WebDAV 与本地目录备份包含关注数据，且**不含**图片字节。
12. 第三方曾用名查询默认关闭；未开启时扩展不向 aicu.cc 发起任何请求。
13. 第三方曾用名与本地观测的改名记录分开呈现，且标明"无时间戳、顺序不保证"。
