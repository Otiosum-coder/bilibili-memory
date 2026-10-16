import { formatLocalDay } from "./followingDiff";
import { followTimeOf, resolveDisplayName } from "./followingQuery";
import type { FollowingEvent, FollowingEventType, FollowingItem } from "./types";

/**
 * 数据面板的聚合逻辑（纯函数，可单测）。
 *
 * 面板有两类数据：
 * - 跨模块静态指标：直接来自各模块的本地计数，零新增同步
 * - 关注变动：来自 followingEvents 事件流
 *
 * 注意一个结构性限制：**趋势只能从建立基线那天开始画**。B 站侧不存在
 * 取关/改名的历史记录，无法回溯；因此空状态必须如实说明起始日期。
 */

export interface CrossModuleMetrics {
  historyCount: number;
  favoriteCount: number;
  folderCount: number;
  collectionCount: number;
  collectionResourceCount: number;
}

export interface DashboardMetric {
  key: keyof CrossModuleMetrics | "followingCount";
  label: string;
  value: number;
}

export const buildDashboardMetrics = (
  metrics: CrossModuleMetrics,
  followingCount: number,
): DashboardMetric[] => [
  { key: "historyCount", label: "历史记录", value: metrics.historyCount },
  { key: "favoriteCount", label: "收藏内容", value: metrics.favoriteCount },
  { key: "folderCount", label: "收藏夹", value: metrics.folderCount },
  { key: "collectionCount", label: "订阅合集", value: metrics.collectionCount },
  { key: "collectionResourceCount", label: "合集内容", value: metrics.collectionResourceCount },
  { key: "followingCount", label: "关注 UP 主", value: followingCount },
];

// ---------------------------------------------------------------------------
// 每日变动趋势
// ---------------------------------------------------------------------------

export interface DailyChangePoint {
  day: string;
  followed: number;
  unfollowed: number;
  renamed: number;
  accountGone: number;
  total: number;
}

export const CHANGE_TYPE_LABEL: Record<FollowingEventType, string> = {
  followed: "新增关注",
  unfollowed: "取关",
  renamed: "改名",
  account_gone: "账号注销",
};

/** 堆叠柱的颜色，与页面图例保持一致 */
export const CHANGE_TYPE_COLOR: Record<FollowingEventType, string> = {
  followed: "#22c55e",
  unfollowed: "#f59e0b",
  renamed: "#3b82f6",
  account_gone: "#94a3b8",
};

const emptyPoint = (day: string): DailyChangePoint => ({
  day,
  followed: 0,
  unfollowed: 0,
  renamed: 0,
  accountGone: 0,
  total: 0,
});

/**
 * 生成连续的每日变动序列。
 *
 * 缺失的日期补 0 —— 柱状图必须建立在连续日期轴上，否则"某天没有变动"会被
 * 压缩掉，趋势看起来是错的。
 *
 * 用 `setDate` 而不是减去 `dayCount * 86400000` 来推日期：后者在夏令时切换日
 * 会产生重复或跳过的日期。
 */
export const buildDailyChangeSeries = (
  events: FollowingEvent[],
  dayCount: number,
  now: number,
): DailyChangePoint[] => {
  const safeDays = Math.max(1, Math.floor(dayCount));
  const base = new Date(now);
  base.setHours(0, 0, 0, 0);

  const byDay = new Map<string, DailyChangePoint>();
  const orderedDays: string[] = [];
  for (let offset = safeDays - 1; offset >= 0; offset -= 1) {
    const date = new Date(base);
    date.setDate(date.getDate() - offset);
    const day = formatLocalDay(date.getTime());
    orderedDays.push(day);
    byDay.set(day, emptyPoint(day));
  }

  for (const event of events) {
    const point = byDay.get(event.day);
    // 落在窗口之外的事件直接忽略
    if (!point) continue;
    if (event.type === "followed") point.followed += 1;
    else if (event.type === "unfollowed") point.unfollowed += 1;
    else if (event.type === "renamed") point.renamed += 1;
    else point.accountGone += 1;
    point.total += 1;
  }

  return orderedDays.map((day) => byDay.get(day)!);
};

export interface EventTypeTotals {
  followed: number;
  unfollowed: number;
  renamed: number;
  accountGone: number;
  total: number;
}

export const summarizeEventTypes = (events: FollowingEvent[]): EventTypeTotals => {
  const totals: EventTypeTotals = {
    followed: 0,
    unfollowed: 0,
    renamed: 0,
    accountGone: 0,
    total: 0,
  };
  for (const event of events) {
    if (event.type === "followed") totals.followed += 1;
    else if (event.type === "unfollowed") totals.unfollowed += 1;
    else if (event.type === "renamed") totals.renamed += 1;
    else totals.accountGone += 1;
    totals.total += 1;
  }
  return totals;
};

/** 最早的事件日期，用于空状态里说明"记录自哪天开始" */
export const earliestEventDay = (events: FollowingEvent[]): string | null => {
  let earliest: string | null = null;
  for (const event of events) {
    if (earliest === null || event.day < earliest) earliest = event.day;
  }
  return earliest;
};

// ---------------------------------------------------------------------------
// 榜单
// ---------------------------------------------------------------------------

export interface RenameLeader {
  item: FollowingItem;
  displayName: string;
  renameCount: number;
  names: string[];
}

/** 本地观测到改名次数最多的人。`nameHistory` 第一条是基线名，所以改名次数 = 长度 - 1 */
export const buildRenameLeaderboard = (
  items: FollowingItem[],
  limit = 5,
): RenameLeader[] =>
  items
    .map((item) => ({
      item,
      displayName: resolveDisplayName(item),
      renameCount: Math.max(0, (item.nameHistory?.length ?? 0) - 1),
      names: (item.nameHistory ?? []).map((record) => record.name),
    }))
    .filter((entry) => entry.renameCount > 0)
    .sort((a, b) => b.renameCount - a.renameCount)
    .slice(0, Math.max(0, limit));

/** 关注最久的人 */
export const buildLongestFollowed = (items: FollowingItem[], limit = 5): FollowingItem[] =>
  [...items]
    .filter((item) => item.mtime > 0 || item.firstSeenAt > 0)
    .sort((a, b) => followTimeOf(a) - followTimeOf(b))
    .slice(0, Math.max(0, limit));

/**
 * 曾用名个数。`nameHistory` 第一条是基线名，所以改名次数 = 长度 - 1。
 *
 * 这里**只数本地观测到的改名**，不含第三方存档的名字：那些没有时间戳、
 * 顺序也不保证，混进来会让"改过几次名"这个数字失去确定性。
 * 界面上的徽章文案是「曾用名 N」，N 就是这个数。
 */
export const renameCountOf = (item: FollowingItem): number =>
  Math.max(0, (item.nameHistory?.length ?? 0) - 1);

// ---------------------------------------------------------------------------
// 最近变动
// ---------------------------------------------------------------------------

/** 事件筛选：`all` 之外每个取值对应一种 `FollowingEventType` */
export type FollowingChangeFilter = "all" | FollowingEventType;

export const FOLLOWING_CHANGE_FILTERS: FollowingChangeFilter[] = [
  "all",
  "followed",
  "unfollowed",
  "renamed",
  "account_gone",
];

/**
 * 各类型事件的条数，用于筛选 chip 上的计数。
 *
 * **界面必须能显示数量**：刚装插件的人只会有「新增关注」一类事件，
 * 四个 chip 里三个是 0 却不显示数字，用户会以为是筛选坏了。
 */
export const countEventsByType = (events: FollowingEvent[]): Record<FollowingEventType, number> => {
  const counts: Record<FollowingEventType, number> = {
    followed: 0,
    unfollowed: 0,
    renamed: 0,
    account_gone: 0,
  };
  for (const event of events) {
    if (counts[event.type] === undefined) continue;
    counts[event.type] += 1;
  }
  return counts;
};

/** 按类型筛选事件，`all` 原样返回。排序交给 `buildRecentEvents` */
export const filterEventsByType = (
  events: FollowingEvent[],
  filter: FollowingChangeFilter,
): FollowingEvent[] =>
  filter === "all" ? events : events.filter((event) => event.type === filter);

/**
 * 最近变动明细，最新的在前。
 *
 * `limit` 为 `undefined` 表示"全部"（配合界面上的「加载更多」）。
 * 用 `occurred_at` 而不是 `day` 排序：同一天可能有多条事件，
 * 按天排会让它们次序不定。
 */
export const buildRecentEvents = (
  events: FollowingEvent[],
  limit?: number,
): FollowingEvent[] => {
  const sorted = [...events].sort((a, b) => b.occurred_at - a.occurred_at);
  if (limit === undefined) return sorted;
  return sorted.slice(0, Math.max(0, limit));
};
