import type { InteractionItem, InteractionState, InteractionType } from "./types";

/**
 * 互动记录的查询、统计与展示派生（纯函数，可单测）。
 *
 * 这里承载一条硬约束：B 站只保留最近 20 条，且接口**不解释条目为什么消失**。
 * 所以界面文案必须比数据本身更谨慎——`ended` 只能说成"互动已结束"，
 * 不能写成"你取消了点赞"，因为「你取消」与「B 站自己不再保留」在接口上无法区分。
 */

export const INTERACTION_TYPE_LABEL: Record<InteractionType, string> = {
  like: "点赞",
  coin: "投币",
};

/**
 * 状态标签。写的是**"你的互动怎么了"**，不是我们的内部状态名。
 *
 * 评审结论（用户明确要求，别改回术语）：
 * - `列表外仍在` → **`点赞过`**
 * - `列表外待判定` → **`未判定`**：用"我们还没判定"的口吻只会让人不知道在等什么
 *
 * **`ended` 的文案是唯一一处刻意反直觉的地方，理由如下**：
 * `x/web-interface/archive/relation`（以及 `has/like`）的社区文档明确写着
 * **它只反映近期状态**——半年前点赞的视频再查已经是 `like=false`。
 * 实测也印证了这一点：对一条很久以前点过赞的视频再点一次，B 站会提示
 * **"重复点赞"**，说明**它的数据库里那条赞还在**，只是接口/列表不再报告。
 *
 * 所以 `like=false` **不能**推出"用户取消了点赞"。原先写「取消点赞」是在说一件
 * 我们并没有证据的事（违反本功能设计文档 2.1 节的约定）。改成如实描述：
 * B 站不显示它了，仅此而已。
 */
export const INTERACTION_STATE_LABEL: Record<InteractionState, string> = {
  listed: "仍在列表",
  unlisted: "未判定",
  retained: "点赞过",
  ended: "B站已不显示",
  content_deleted: "内容已删除",
  content_hidden: "内容不可见",
};

/** 悬停说明。每一句都在解释"这个状态是怎么来的、能信到什么程度" */
export const INTERACTION_STATE_HINT: Record<InteractionState, string> = {
  listed: "最近一次同步时它还在 B 站的互动列表里。",
  unlisted: "已不在 B 站列表里，但还没核查成功，所以不下任何结论。下一次同步会继续核查。",
  retained:
    "已不在 B 站最近 20 条的互动列表里，但核查证明你的互动还在（点赞仍在 / 投币记录仍存在）——只是 B 站不再展示它了。",
  ended:
    "B 站的列表与接口都查不到这条互动了。但这不是「你取消了点赞」的证据：B 站的接口只反映近期状态，很早的赞再查就是 false（实测对老视频重新点赞会提示「重复点赞」，说明记录仍在）。可能是你取消的，也可能只是 B 站不再报告它——两者在接口上无法区分。",
  content_deleted: "稿件已被删除（view 接口返回 -404）。",
  content_hidden: "稿件已被转私密或被限制，不再公开可见（view 接口返回 62002）。",
};

/**
 * 界面上的筛选只有三档。
 *
 * 内部状态机有六个取值（改写不了：取消 / B 站不再保留 / 稿件被删 / 稿件不可见
 * 是四件不同的事，判定时就必须分开），但**界面不该照搬它**：B 站只给最近 20 条，
 * 绝大多数记录永远停在「仍在列表」，把六个状态平铺出来只会是一屏的 0。
 * 精确原因留在卡片徽章上——只有真的发生时才会看见。
 */
export type InteractionFilter = "all" | "listed" | "gone";

export const INTERACTION_FILTER_OPTIONS: Array<{
  value: InteractionFilter;
  label: string;
  hint: string;
}> = [
  { value: "all", label: "全部记录", hint: "本地留存的全部点赞与投币记录。" },
  {
    value: "listed",
    label: "仍在列表",
    hint: "最近一次同步时仍出现在 B 站「最近点赞 / 最近投币」列表里的记录。",
  },
  {
    value: "gone",
    label: "已不在列表",
    hint: "已从 B 站列表里消失的记录。卡片徽章会写明具体原因；判定不了的一律显示为「未判定」，不会猜。",
  },
];

export interface InteractionStats {
  /** 记录条数（一条视频可能既有点赞又有投币，算两条） */
  total: number;
  like: number;
  coin: number;
  byState: Record<InteractionState, number>;
  /** 仍在 B 站列表里的条数 */
  listed: number;
  /** 已不在列表的条数（含尚未判定的） */
  gone: number;
  /** 其中尚未探测出原因的条数 */
  pendingProbe: number;
  /**
   * 只有**近似**互动时间的条数（点赞全部计入，投币接口没给 time 的也计入）。
   *
   * 这个数字必须露出来：B 站点赞接口不返回点赞时间，本地的"互动时间"其实是首次观测时间。
   * 界面如果只显示一个时间而不说明可信度，就是在暗示一个并不存在的精度。
   */
  approximateTime: number;
}

export const buildInteractionStats = (items: InteractionItem[]): InteractionStats => {
  const byState: Record<InteractionState, number> = {
    listed: 0,
    unlisted: 0,
    retained: 0,
    ended: 0,
    content_deleted: 0,
    content_hidden: 0,
  };
  const stats: InteractionStats = {
    total: 0,
    like: 0,
    coin: 0,
    byState,
    listed: 0,
    gone: 0,
    pendingProbe: 0,
    approximateTime: 0,
  };

  for (const item of items) {
    stats.total += 1;
    if (item.type === "like") stats.like += 1;
    else stats.coin += 1;
    if (byState[item.state] === undefined) byState.unlisted += 1;
    else byState[item.state] += 1;
    if (item.state === "listed") stats.listed += 1;
    else stats.gone += 1;
    if (item.state === "unlisted") stats.pendingProbe += 1;
    if (!item.interactedAtExact) stats.approximateTime += 1;
  }
  return stats;
};

/**
 * 排序只有四档，全部由**卡片上能看到的那个日期**和时长派生。
 *
 * 评审结论（别随手加回去）：
 * - `recorded_*`（按入库时间）已删除。它与日期排序在界面上是同一件事：
 *   点赞的"日期"本来就取自首次记录时间，投币才可能有更早的真实投币时间，
 *   摆两个入口只会让用户切来切去却看不出差别。
 * - `author_asc` / `title_asc` 已删除。这页是**检索**场景（搜索框能直达标题、
 *   原名、UP 主），而它还是分页的——按作者或标题排序会把同一位 UP 的记录
 *   打散到不同页，归拢效果根本看不见。
 */
export type InteractionSort = "date_desc" | "date_asc" | "duration_desc" | "duration_asc";

export interface InteractionQueryInput {
  items: InteractionItem[];
  keyword?: string;
  type?: InteractionType | "all";
  state?: InteractionFilter;
  sort?: InteractionSort;
}

/** 搜索范围包含 `firstTitle`：稿件改名后，用户记得住的往往是当时那个标题 */
const matchKeyword = (item: InteractionItem, term: string): boolean => {
  if (!term) return true;
  if (item.title.toLowerCase().includes(term)) return true;
  if ((item.firstTitle ?? "").toLowerCase().includes(term)) return true;
  if ((item.authorName ?? "").toLowerCase().includes(term)) return true;
  if (item.bvid.toLowerCase().includes(term)) return true;
  if (String(item.aid ?? "").includes(term)) return true;
  if (String(item.authorMid).includes(term)) return true;
  return false;
};

/**
 * 在线列表里的名次。接口最新在前，所以名次越小越新。
 *
 * **没有名次（从未出现在列表里 / 老备份缺字段）的一律当 +∞**：
 * `date_desc` 与 `date_asc` 都按名次正序比较这一级，所以"最大"才会沉到后面。
 * 这里曾经用过 `-1`（当时误以为"最旧"应该更小），结果未知名次的记录
 * 被推到列表最前——方向与"正序比较"不匹配。哨兵值必须往**比较方向的末尾**取。
 *
 * 用 `Number.isFinite` 而不是 `typeof === "number"`：`listRank` 是可选字段，
 * 而 WebDAV / 备份导入的远端记录是**原样落库、零校验**的（`utils/db.ts` 的
 * `smartMergeInteractions`），老备份或手工 JSON 里可能有 `NaN` / `null`。
 * `typeof NaN === "number"` 会放过 NaN，而 NaN 参与比较时 `<` 与 `>` 同时为 false，
 * 比较函数就不再满足反对称性，排序结果会随输入顺序变化。
 */
const rankOf = (item: InteractionItem): number =>
  Number.isFinite(item.listRank) ? (item.listRank as number) : Number.MAX_SAFE_INTEGER;

/** 时间戳规整：非有限值（NaN / Infinity / undefined）一律当成"未知"，压到最小 */
const timeOf = (item: InteractionItem): number =>
  Number.isFinite(item.interactedAt) ? item.interactedAt : 0;

/**
 * 日期排序的次序键。每一级都是**显式比较**，不写 `a - b || ...` 那种链式简写：
 * 值域里存在 NaN / undefined（见 `rankOf` 的说明）时，减法的结果也是 NaN，
 * 而 NaN 是 falsy，会静默落到下一级——"未知"和"相等"就混成了同一件事。
 *
 * 层级与方向：
 * 1. `interactedAt`——卡片上那一格（投币是接口给的真实时间，点赞是首次记录时刻），
 *    跟随 `ascending`；这是唯一的"主方向"
 * 2. `listRank`——接口给的在线名次。**无论哪个方向都按正序**（rank 0 最新排最前）。
 *    首轮那批记录的 `interactedAt` 完全相等，顺序全靠它；而 B 站那份列表本身就是
 *    按互动时间倒序给的，正序即"原样"。曾经为了追求"两个方向严格互为逆序"把它一起
 *    反转，结果那一屏的次序跟 B 站列表刚好相反——用户一眼就看出来了。
 * 3. `bvid` 字典序——前两级都并列时的兜底，跟随 `ascending`。三级合起来对**任意**
 *    取值都给出全序，所以结果与输入顺序无关。
 */
const compareByDate = (a: InteractionItem, b: InteractionItem, ascending: boolean): number => {
  const order = (first: number | string, second: number | string, ascending: boolean): number => {
    if (first === second) return 0;
    const lower = first < second;
    return (ascending ? lower : !lower) ? -1 : 1;
  };

  // 主方向
  const primary = order(timeOf(a), timeOf(b), ascending);
  if (primary !== 0) return primary;

  // 并列：名次一律正序（rank 小 = 更新 = 在前）。
  // `rankOf` 把"无排名"规整成 -1（比任何真实名次都旧），所以 -1 会自然沉到后面，
  // 这里不需要为它做特殊处理。
  const leftRank = rankOf(a);
  const rightRank = rankOf(b);
  if (leftRank !== rightRank) return leftRank < rightRank ? -1 : 1;

  // 兜底也要跟随主方向。这里**必须显式传 `ascending`**：
  // 漏掉就会让 `ascending` 变成 undefined，`order` 恒走降序分支，
  // 于是 `cmp(a,b)` 与 `cmp(b,a)` 可能同时返回 -1——比较器不再满足反对称性，
  // 排序结果直接错乱。这个坑真实发生过（首轮基线那批记录次序颠倒）。
  return order(a.bvid, b.bvid, ascending);
};

/**
 * 时长排序：**时长为未知（0）的条目恒排末尾**，与升降序无关。
 *
 * 早期记录与探测失败的条目 `duration` 为 0，那是"不知道"而不是"最短"，
 * 放任它排到"时长长→短"的最前面（或者"短→长"的第一屏）都是在制造假象。
 *
 * 时长**相等**时（批量同步回来的记录时长撞在一起很常见，未知时长也算一种"相等"）
 * 一律按**日期新→旧**收尾，不跟着升降序翻转：否则同一批数据在两种时长排序下的
 * 内部次序会互相矛盾，用户切一下方向会觉得列表被重新洗过。
 */
const compareByDuration = (a: InteractionItem, b: InteractionItem, ascending: boolean): number => {
  const left = a.duration > 0 ? a.duration : 0;
  const right = b.duration > 0 ? b.duration : 0;

  // 未知时长永远沉底，不参与"最长/最短"的竞争
  if (left === 0 && right === 0) return compareByDate(a, b, false);
  if (left === 0) return 1;
  if (right === 0) return -1;

  if (left !== right) {
    const shorter = left < right;
    return (ascending ? shorter : !shorter) ? -1 : 1;
  }

  return compareByDate(a, b, false);
};

/**
 * 按给定次序排序，**不改动入参**（内部先 `slice()`，页面 state 里那份数组不会被排乱）。
 *
 * 用原生 `Array.prototype.sort`：比较函数已是全序（最后一级落到 `bvid`，见 `compareByDate`），
 * 而 ES2019 起规范保证 `sort` 稳定，因此结果只由比较函数决定。
 *
 * 早先这里手写插入排序，实测在 5000 条时要 89ms，而原生 sort 只要 2.3ms——
 * 这页每次按键都会跑好几次"近似全量"的查询（`stateCounts` 就跑了三次），
 * 又没给关键词加防抖，插入排序会把输入卡成幻灯片。
 */
const sortBy = (
  items: InteractionItem[],
  compare: (a: InteractionItem, b: InteractionItem) => number,
): InteractionItem[] => items.slice().sort(compare);

const compareInteractions = (a: InteractionItem, b: InteractionItem, sort: InteractionSort): number => {
  switch (sort) {
    case "date_asc":
      return compareByDate(a, b, true);
    case "duration_desc":
      return compareByDuration(a, b, false);
    case "duration_asc":
      return compareByDuration(a, b, true);
    case "date_desc":
    default:
      return compareByDate(a, b, false);
  }
};

export const queryInteractions = (input: InteractionQueryInput): InteractionItem[] => {
  const term = (input.keyword ?? "").trim().toLowerCase();
  const type = input.type ?? "all";
  const state = input.state ?? "all";
  const sort = input.sort ?? "date_desc";

  // `sortBy` 内部自己 slice，`input.items`（页面的 state）不会被原地改动。
  const filtered = input.items.filter((item) => {
    if (type !== "all" && item.type !== type) return false;
    if (state === "listed" && item.state !== "listed") return false;
    if (state === "gone" && item.state === "listed") return false;
    return matchKeyword(item, term);
  });

  return sortBy(filtered, (a, b) => compareInteractions(a, b, sort));
};

export interface InteractionPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const paginateInteractions = <T>(
  items: T[],
  page: number,
  pageSize: number,
): InteractionPage<T> => {
  const safePage = Math.max(1, Math.floor(page));
  const safeSize = Math.max(1, Math.floor(pageSize));
  const start = (safePage - 1) * safeSize;
  return {
    items: items.slice(start, start + safeSize),
    total: items.length,
    page: safePage,
    pageSize: safeSize,
    totalPages: Math.max(1, Math.ceil(items.length / safeSize)),
  };
};

/**
 * "互动时间"该如何标注。
 *
 * 投币接口给真实投币时间；点赞接口不返回点赞时间，本地只有"首次看到它"的时刻，
 * 那是真实点赞时间的**上界**。两者绝不能显示成同一个词。
 */
export const interactionTimeLabel = (item: InteractionItem): string =>
  item.type === "coin" && item.interactedAtExact ? "投币时间" : "首次记录时间";

// ---------------------------------------------------------------------------
// 时间与徽章文案
// ---------------------------------------------------------------------------

/** 距今几天以内用相对说法，超过就显示绝对日期 */
export const RELATIVE_TIME_DAYS = 3;

const startOfLocalDay = (timestamp: number): number => {
  const date = new Date(timestamp);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

/**
 * 卡片上显示的短时间。
 *
 * 规则（与设计评审一致）：**三天以内说"今天/昨天/前天/N 天前"，更早显示绝对日期**；
 * 同年只给 `M/D`，跨年才补上年份。绝对时间精确到分钟没有意义——
 * 用户扫的是"多久以前"，需要精确值时由 hover 提供。
 */
export const formatInteractionTime = (at: number, now: number): string => {
  if (!at) return "";
  const dayMs = 24 * 60 * 60 * 1000;
  const diffDays = Math.round((startOfLocalDay(now) - startOfLocalDay(at)) / dayMs);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays === 2) return "前天";
  if (diffDays <= RELATIVE_TIME_DAYS) return `${diffDays} 天前`;

  const date = new Date(at);
  const monthDay = `${date.getMonth() + 1}/${date.getDate()}`;
  return date.getFullYear() === new Date(now).getFullYear()
    ? monthDay
    : `${date.getFullYear()}/${monthDay}`;
};

/** 完整时间，只用于 hover 提示 */
export const formatFullDateTime = (timestamp?: number): string => {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
};

/** 与收藏页同一套写法：`toLocaleDateString()`，例如 2026/10/10 */
export const formatInteractionDate = (timestamp?: number): string =>
  timestamp ? new Date(timestamp).toLocaleDateString() : "";

export interface InteractionDetail {
  /** 卡片右下角显示的文字，格式与收藏页一致；空串表示这一格没有内容可显示 */
  date: string;
  /** 悬停说明：把"这个时间是怎么来的、为什么没有时间"讲清楚 */
  title: string;
}

/**
 * 卡片右下角那一格的内容 + 悬停说明。
 *
 * 口径（评审结论，别随手改回去）：
 * - 日期用**完整日期**（`2026/10/10`），与收藏页一致；"3 天前"这种相对说法只出现在悬停里。
 * - **投币**用接口给的真实投币时间。
 * - **点赞**没有可信时间：首轮同步就在列表里的标「早期」（只能说"早于开始记录"），
 *   之后才出现的显示本地首次记录日期。
 *   **不在「早期」旁边补观测日期**（评审结论）：观测时刻不是点赞时间，摆到卡片主位
 *   容易被读成"点赞日期"。它只出现在悬停说明里，并明确写成"本地首次记录到它"。
 *   由此带来的现象要记住：一批「早期」记录的日期完全相同，所以
 *   "日期新→旧 / 旧→新"切来切去结果一模一样——那是日期并列，不是排序坏了。
 * - **不显示投了几枚**（评审结论）：用户要的是"记录下我投过币"，1 枚和 2 枚没有区分价值，
 *   而"两枚硬币叠在一起"的图标和 `×2` 前缀都只会让卡片变吵。
 *   枚数仍然照常写进数据与备份（`item.coins`），只是不展示——以后想用随时能加回来。
 */
export const buildInteractionDetail = (
  item: InteractionItem,
  now: number,
): InteractionDetail => {
  const relative = (at: number): string => {
    const text = formatInteractionTime(at, now);
    return text ? `（${text}）` : "";
  };

  if (item.type === "like") {
    if (item.caughtInBaseline === true) {
      return {
        date: "早期",
        title: `加入插件之前就已经点过赞。B 站不提供点赞时间，所以只能标为「早期」。本地首次记录到它是在 ${formatFullDateTime(
          item.firstSeenAt,
        )}${relative(item.firstSeenAt)}——那是观测时刻，不是点赞时刻。`,
      };
    }
    return {
      date: formatInteractionDate(item.firstSeenAt),
      title: `B 站不提供点赞时间。这个赞是本地在 ${formatFullDateTime(
        item.firstSeenAt,
      )} 首次记录到的${relative(item.firstSeenAt)}。`,
    };
  }

  if (item.interactedAtExact) {
    return {
      date: formatInteractionDate(item.interactedAt),
      title: `投币于 ${formatFullDateTime(item.interactedAt)}${relative(
        item.interactedAt,
      )}，B 站接口提供`,
    };
  }
  return {
    date: formatInteractionDate(item.firstSeenAt),
    title: `投币时间接口没有返回，这里用的是本地首次记录时间 ${formatFullDateTime(
      item.firstSeenAt,
    )}${relative(item.firstSeenAt)}`,
  };
};

/**
 * 稿件本身是否**已经查不到**——被删除或转私密，本地只剩副本。
 *
 * 界面据此给**标题加删除线**（与收藏页对已失效收藏的处理一致），这条线表达的是
 * "这个视频你点不进去了"。因此**只包含内容层面的两种状态**：
 *
 * - `content_deleted` / `content_hidden`：稿件没了，删除线准确
 * - `ended`（取消点赞）**不算**：稿件好端端的、仍能正常打开，变的只是你的互动状态。
 *   给它加删除线等于谎称"内容失效了"。
 * - `retained`（点赞过）/ `unlisted`（未判定）也不算：它们连"失效"都谈不上。
 *
 * 同时**不给整张卡加透明度**：淡化整卡会把封面和作者一起压暗，
 * 而 `retained` / `unlisted` 其实都是有效记录，一视同淡等于把"只是掉出窗口"误报成"已作废"。
 */
export const isInteractionContentGone = (item: InteractionItem): boolean =>
  item.state === "content_deleted" || item.state === "content_hidden";

export const interactionVideoUrl = (item: InteractionItem): string =>
  `https://www.bilibili.com/video/${item.bvid}`;

export const interactionAuthorUrl = (item: InteractionItem): string =>
  `https://space.bilibili.com/${item.authorMid}`;

/** 时长格式化。与仓库其它页面保持一致的 `mm:ss` / `h:mm:ss` 写法 */
export const formatInteractionDuration = (seconds: number | undefined): string => {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total === 0) return "";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
};

// 曾经有一个 buildInteractionTimeline：由记录字段派生出"首次入库 / 掉出列表 / 判定结束"时间线。
// 总览页试过用它，但评审认为"最近变动"明细放在总览里太杂（用户明确要求撤掉），
// 于是连同 5 条一屏的列表一起删除——互动页的卡片本身已经带状态与日期，不需要第二处入口。
