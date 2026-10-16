import type { HistoryEvent } from "./types";

/**
 * 观看统计的纯函数层。
 *
 * 只统计"视频类"内容：接口对直播不返回 `progress` / `duration`（文档标注为
 * "仅用于稿件视频或剧集"），文章也不是视频。混进来会让"每天看了多少个视频"
 * 虚高且语义混乱，因此统一排除。
 *
 * 口径（必须与界面文案一致）：
 *
 * **展示口径是「不同视频数」，不是「观看次数」。**
 * B 站的历史接口不返回观看次数，只返回每个内容**最后一次**观看时间（`view_at`）；
 * 而播放器会在观看过程中不断上报进度、把 `view_at` 往后刷新，同步又是每分钟一次，
 * 于是**一次连续观看会留下几十条记录**（长视频尤其明显）。因此：
 * - 界面上的"看了多少个视频"一律用按 `content_key` 去重后的数字；
 * - 原始记录条数只作为辅助信息（`views` / `*Records`），不单独展示成"次数"；
 * - 时段分布同样按不同视频去重，否则长视频会堆出假高峰。
 *
 * 记录起点 = 库里最早的一条观看记录，早于它的时间补不回来。
 */

/** 不计入观看统计的内容类型 */
export const EXCLUDED_BUSINESSES = ["live", "article", "article-list"] as const;

/** 统计只需要这几个字段，便于单测构造数据 */
export interface StatsEvent {
  business: string;
  content_key: string;
  view_at: number;
  author_mid: number;
  author_name: string;
  /** 观看进度（秒）。接口对直播不返回，可能缺失。`-1` 表示已看完 */
  progress?: number;
  /** 视频总时长（秒）。接口对直播不返回，可能缺失 */
  duration?: number;
}

export const isStatsEligibleBusiness = (business: string): boolean =>
  !(EXCLUDED_BUSINESSES as readonly string[]).includes(business);

export const filterStatsEvents = (events: readonly StatsEvent[]): StatsEvent[] =>
  events.filter((event) => isStatsEligibleBusiness(event.business));

/** 本地时区的 YYYY-MM-DD。统计一律按用户本地日期切分 */
export const toDayKey = (viewAtSec: number): string => {
  const date = new Date(viewAtSec * 1000);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
};

/** 当天 00:00（本地时区）的秒级时间戳 */
export const startOfLocalDaySec = (ms: number): number => {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
};

const startOfLocalWeekDayKey = (ms: number): string => {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  // getDay() 里 0 是周日；换算成"距离本周一几天"
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return toDayKey(Math.floor(date.getTime() / 1000));
};

export interface DailyViewPoint {
  day: string;
  views: number;
  uniqueContents: number;
}

/**
 * 每日观看数量序列。窗口内**每一天都有点**（没有观看的日子是 0），
 * 这样日期轴是连续的，断档一眼可见。
 */
export const buildDailyViewSeries = (
  events: readonly StatsEvent[],
  days: number,
  nowMs: number,
): DailyViewPoint[] => {
  const safeDays = Math.max(1, Math.floor(days));
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);

  const series: DailyViewPoint[] = [];
  const indexByDay = new Map<string, number>();
  for (let offset = safeDays - 1; offset >= 0; offset--) {
    const date = new Date(today);
    date.setDate(today.getDate() - offset);
    const day = toDayKey(Math.floor(date.getTime() / 1000));
    indexByDay.set(day, series.length);
    series.push({ day, views: 0, uniqueContents: 0 });
  }

  const uniqueByIndex = new Map<number, Set<string>>();
  for (const event of events) {
    const index = indexByDay.get(toDayKey(event.view_at));
    if (index === undefined) continue;
    series[index].views += 1;
    const set = uniqueByIndex.get(index) ?? new Set<string>();
    set.add(event.content_key);
    uniqueByIndex.set(index, set);
  }
  for (const [index, set] of uniqueByIndex) {
    series[index].uniqueContents = set.size;
  }

  return series;
};

/**
 * 判定"播到片尾"的进度比例。留 5% 余量：播放器上报未必精确落在 total 上，
 * 而且很多视频最后几秒是片尾/推荐位。
 */
export const COMPLETION_RATIO = 0.95;

/** 这一次观测是否代表"已经播到片尾" */
export const isCompletedObservation = (event: StatsEvent): boolean => {
  const progress = Number(event.progress);
  const duration = Number(event.duration);
  if (progress === -1) return true;
  if (!Number.isFinite(progress) || !Number.isFinite(duration) || duration <= 0) return false;
  return progress / duration >= COMPLETION_RATIO;
};

export interface CompletedPlayStats {
  /** 观测到的完整播放总次数 */
  total: number;
  /** 按 content_key 拆分 */
  byContent: Map<string, number>;
  /** 至少完整播放过一次的视频数 */
  contents: number;
}

/**
 * 统计"完整播放完整个视频"的次数（观测值，是**下界**）。
 *
 * ## 为什么这样数
 *
 * 每个内容的事件按时间排序后，只在**从"未到片尾"跨入"到片尾"**时计 1 次。
 *
 * 为什么不用 `progress === -1` 直接数：实测（真实数据 96 条序列）里循环播放
 * 会出现多次"进度爬到片尾 → 回退到开头"，但只有最后一轮接口才标记为 `-1`。
 * 只数 `-1` 会把跑了好几轮的视频算成 1 次。
 *
 * 为什么"连续多条都到片尾"只算 1 次：视频播完后停在那里，同步每分钟采一次，
 * 会连续采到多条片尾状态——那是同一次播放。
 *
 * ## 为什么是下界
 *
 * - 扩展没运行（浏览器关着）时的观看看不到；
 * - 循环短于同步间隔时可能整轮都没被采到；
 * - 装插件之前的无从重建；
 * - 反向误差也有：手动把进度拖到片尾会被算成 1 次完整播放。
 */
export const countCompletedPlays = (events: readonly StatsEvent[]): CompletedPlayStats => {
  const byContent = new Map<string, StatsEvent[]>();
  for (const event of events) {
    const list = byContent.get(event.content_key);
    if (list) list.push(event);
    else byContent.set(event.content_key, [event]);
  }

  const counts = new Map<string, number>();
  let total = 0;
  for (const [key, list] of byContent) {
    const sorted = [...list].sort((a, b) => a.view_at - b.view_at);
    let inside = false;
    let count = 0;
    for (const event of sorted) {
      const completed = isCompletedObservation(event);
      if (completed && !inside) count += 1;
      inside = completed;
    }
    if (count > 0) counts.set(key, count);
    total += count;
  }

  return { total, byContent: counts, contents: counts.size };
};

export interface ViewSummary {
  /**
   * 去重后的视频数——「看了多少个视频」用这一组。
   *
   * 它才是用户能理解的数字。原始记录条数（下面那四个）不能当"看了多少次"：
   * B 站在播放过程中会不断刷新该内容的 `view_at`，同步每分钟跑一次，
   * 于是一次连续观看会被记成几十条记录（长视频尤其明显）。
   */
  todayVideos: number;
  weekVideos: number;
  monthVideos: number;
  yearVideos: number;
  /** 原始观看记录条数。只用于排查与说明，不作为展示口径 */
  todayRecords: number;
  weekRecords: number;
  monthRecords: number;
  yearRecords: number;
  activeDays: number;
  /** 传入区间内的不同视频数 */
  uniqueContents: number;
  /** 观测到的完整播放次数（下界，见 countCompletedPlays） */
  completedPlays: number;
}

/** 今天 / 本周（周一起）/ 本月 / 本年，以及活跃天数与不同视频数 */
export const summarizeViewCounts = (
  events: readonly StatsEvent[],
  nowMs: number,
): ViewSummary => {
  const todayKey = toDayKey(Math.floor(nowMs / 1000));
  const weekStartKey = startOfLocalWeekDayKey(nowMs);
  const monthPrefix = todayKey.slice(0, 7);
  const yearPrefix = todayKey.slice(0, 4);

  const activeDays = new Set<string>();
  const contents = new Set<string>();
  const todaySet = new Set<string>();
  const weekSet = new Set<string>();
  const monthSet = new Set<string>();
  const yearSet = new Set<string>();
  const summary: ViewSummary = {
    todayVideos: 0,
    weekVideos: 0,
    monthVideos: 0,
    yearVideos: 0,
    todayRecords: 0,
    weekRecords: 0,
    monthRecords: 0,
    yearRecords: 0,
    activeDays: 0,
    uniqueContents: 0,
    completedPlays: 0,
  };

  for (const event of events) {
    const day = toDayKey(event.view_at);
    const inToday = day === todayKey;
    const inWeek = day >= weekStartKey;
    const inMonth = day.startsWith(monthPrefix);
    const inYear = day.startsWith(yearPrefix);

    if (inToday) summary.todayRecords += 1;
    if (inWeek) summary.weekRecords += 1;
    if (inMonth) summary.monthRecords += 1;
    if (inYear) summary.yearRecords += 1;

    if (inToday) todaySet.add(event.content_key);
    if (inWeek) weekSet.add(event.content_key);
    if (inMonth) monthSet.add(event.content_key);
    if (inYear) yearSet.add(event.content_key);

    activeDays.add(day);
    contents.add(event.content_key);
  }

  summary.todayVideos = todaySet.size;
  summary.weekVideos = weekSet.size;
  summary.monthVideos = monthSet.size;
  summary.yearVideos = yearSet.size;
  summary.activeDays = activeDays.size;
  summary.uniqueContents = contents.size;
  summary.completedPlays = countCompletedPlays(events).total;
  return summary;
};

/**
 * 一天之内的时段分布，下标 = 第几个时段（本地时区）；
 * 值为**该时段看过的不同视频数**。
 *
 * 不用记录条数：长视频会连着刷新 view_at，在时段图上堆出一座假高峰。
 * 一个视频横跨两个时段时会在两个格子各计一次——它确实在这两个时段都被看过。
 *
 * 返回 24 格。**先按格子收集视频集合再取 size**，不能把相邻小时的数量相加，
 * 否则同一视频跨小时看过就会被算两次。
 */
export const buildHourHistogram = (events: readonly StatsEvent[]): number[] => {
  const buckets: Array<Set<string>> = Array.from({ length: 24 }, () => new Set<string>());
  for (const event of events) {
    buckets[new Date(event.view_at * 1000).getHours()].add(event.content_key);
  }
  return buckets.map((bucket) => bucket.size);
};

/**
 * 「时段分布」图表的横轴标签，长度固定 24，与柱子一一对齐。
 *
 * 只每隔 `step` 小时给一个 `H:00`，其余留空串占位——24 根柱子下面塞 24 个标签必然挤成一团，
 * 而光写 "0 3 6" 又看不出是几点（用户反馈过），所以带上 `:00`。
 */
export const buildHourAxisLabels = (step = 3): string[] => {
  const size = Math.max(1, Math.min(24, Math.floor(step)));
  return Array.from({ length: 24 }, (_, hour) => (hour % size === 0 ? `${hour}:00` : ""));
};

export interface PeakHourWindow {
  /** 起始小时，0–23 */
  startHour: number;
  /** 结束小时（不含），1–24 */
  endHour: number;
  views: number;
}

/**
 * 最爱时段：在 24 小时环上找不到跨零点的窗口，只在 0→23 的直线范围里滑动，
 * 因为"凌晨 2 点"和"晚上 11 点"在作息语义上不该被当成同一段连续时间。
 */
export const findPeakHourWindow = (
  hours: readonly number[],
  windowSize = 2,
): PeakHourWindow | null => {
  const size = Math.max(1, Math.min(24, Math.floor(windowSize)));
  let best: PeakHourWindow | null = null;
  for (let start = 0; start + size <= hours.length; start++) {
    let views = 0;
    for (let offset = 0; offset < size; offset++) views += hours[start + offset];
    if (views === 0) continue;
    if (!best || views > best.views) {
      best = { startHour: start, endHour: start + size, views };
    }
  }
  return best;
};

/**
 * 视频时长分档（秒）。用于"你更爱看多长的视频"。
 *
 * 边界按"观看习惯"取整数分钟，不按数据分位数——分位数会让"15–30 分钟"
 * 这种有意义的语义标签随窗口漂移。缺时长的记录**单列一档**，绝不塞进"5 分钟以内"。
 */
export const DURATION_BUCKETS: Array<{ label: string; maxSeconds: number }> = [
  { label: "5 分钟以内", maxSeconds: 300 },
  { label: "5–15 分钟", maxSeconds: 900 },
  { label: "15–30 分钟", maxSeconds: 1800 },
  { label: "30–60 分钟", maxSeconds: 3600 },
  { label: "1 小时以上", maxSeconds: Number.POSITIVE_INFINITY },
];

export const UNKNOWN_DURATION_LABEL = "无时长信息";

export interface DurationBucket {
  label: string;
  /** 该档下看过的不同视频数 */
  contents: number;
}

/**
 * 时长分布，按**不同视频数**去重（与其它图同一口径）。
 *
 * 同一个视频可能有多条观看事件，这里按 `content_key` 取它最后一次已知的 duration；
 * 没有 duration（0 或缺失）的进「无时长信息」——回填任务会逐步把它们补上。
 */
export const buildDurationDistribution = (
  events: readonly StatsEvent[],
): DurationBucket[] => {
  const durations = new Map<string, number>();
  for (const event of events) {
    const duration = Number(event.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      if (!durations.has(event.content_key)) durations.set(event.content_key, 0);
      continue;
    }
    // 后出现的观测会覆盖：duration 不会变，取哪一次都一样，这里图个确定
    durations.set(event.content_key, duration);
  }

  const counts = new Array(DURATION_BUCKETS.length).fill(0) as number[];
  let unknown = 0;
  for (const duration of durations.values()) {
    if (duration <= 0) {
      unknown += 1;
      continue;
    }
    const index = DURATION_BUCKETS.findIndex((bucket) => duration <= bucket.maxSeconds);
    counts[index < 0 ? DURATION_BUCKETS.length - 1 : index] += 1;
  }

  const result: DurationBucket[] = DURATION_BUCKETS.map((bucket, index) => ({
    label: bucket.label,
    contents: counts[index],
  }));
  if (unknown > 0) result.push({ label: UNKNOWN_DURATION_LABEL, contents: unknown });
  return result;
};

export interface TopAuthor {
  mid: number;
  name: string;
  views: number;
  uniqueContents: number;
  /** 这个 UP 主名下被观测到的完整播放次数（下界） */
  completedPlays: number;
  /** 近期窗口内看过的不同视频数 */
  recentVideos: number;
  /** 最近一次观看的时间（秒），没看过为 null */
  lastViewedAt: number | null;
}

export interface TopAuthorOptions {
  /**
   * 近期窗口的起点（秒）。默认 0 = 不做近期切分，此时 `recentVideos` 等于
   * `uniqueContents`，排序结果与旧行为一致。
   */
  recentSinceSec?: number;
  /**
   * 名字兜底表（mid → 昵称）。接口对部分内容类型不返回 `author_name`，
   * 实测确实存在整条记录名字为空的 UP 主。调用方可以传关注列表里的当前昵称来补。
   */
  nameByMid?: ReadonlyMap<number, string>;
}

/** 榜单条目的显示名：事件里的名字 → 兜底表 → UID（与关注列表的兜底文案一致） */
export const resolveAuthorName = (
  mid: number,
  name: string | undefined,
  nameByMid?: ReadonlyMap<number, string>,
): string => name || nameByMid?.get(mid) || `UID ${mid}（名字未知）`;

/**
 * 看得最多的 UP 主（按**不同视频数**排序，不是按记录条数）。
 *
 * 按记录条数排会被长视频带偏：同一个视频连着看两小时会产出几十条记录。
 * 并列时先比记录条数，再按 mid 升序，保证输出稳定可测。
 */
export const buildTopAuthors = (
  events: readonly StatsEvent[],
  limit = 5,
  options: TopAuthorOptions = {},
): TopAuthor[] => {
  const recentSinceSec = options.recentSinceSec ?? 0;
  const byMid = new Map<
    number,
    {
      name: string;
      views: number;
      contents: Set<string>;
      recentContents: Set<string>;
      lastViewedAt: number;
    }
  >();
  for (const event of events) {
    const current = byMid.get(event.author_mid) ?? {
      name: event.author_name,
      views: 0,
      contents: new Set<string>(),
      recentContents: new Set<string>(),
      lastViewedAt: 0,
    };
    current.views += 1;
    current.contents.add(event.content_key);
    if (event.view_at >= recentSinceSec) current.recentContents.add(event.content_key);
    if (event.view_at > current.lastViewedAt) current.lastViewedAt = event.view_at;
    // 名字以最后一次观测到为准，避免早期的空名字覆盖后来的真实名字
    if (event.author_name) current.name = event.author_name;
    byMid.set(event.author_mid, current);
  }

  // 完整播放次数按内容归属到作者
  const authorByContent = new Map<string, number>();
  for (const event of events) authorByContent.set(event.content_key, event.author_mid);
  const completedByAuthor = new Map<number, number>();
  for (const [contentKey, count] of countCompletedPlays(events).byContent) {
    const mid = authorByContent.get(contentKey);
    if (mid === undefined) continue;
    completedByAuthor.set(mid, (completedByAuthor.get(mid) ?? 0) + count);
  }

  return [...byMid.entries()]
    .map(([mid, value]) => ({
      mid,
      name: resolveAuthorName(mid, value.name, options.nameByMid),
      views: value.views,
      uniqueContents: value.contents.size,
      completedPlays: completedByAuthor.get(mid) ?? 0,
      recentVideos: value.recentContents.size,
      lastViewedAt: value.lastViewedAt > 0 ? value.lastViewedAt : null,
    }))
    .sort((a, b) => {
      // 近期优先：不传窗口时 recentVideos 等于 uniqueContents，等价于按视频数排序
      if (b.recentVideos !== a.recentVideos) return b.recentVideos - a.recentVideos;
      if (b.uniqueContents !== a.uniqueContents) return b.uniqueContents - a.uniqueContents;
      if (b.views !== a.views) return b.views - a.views;
      return a.mid - b.mid;
    })
    .slice(0, Math.max(0, limit));
};

/** 看得最多的一天（按不同视频数）。并列时取更早的一天 */
export const findPeakDay = (series: readonly DailyViewPoint[]): DailyViewPoint | null => {
  let best: DailyViewPoint | null = null;
  for (const point of series) {
    if (point.uniqueContents === 0) continue;
    if (!best || point.uniqueContents > best.uniqueContents) best = point;
  }
  return best;
};

/** 最长连续观看天数（期间内每一天都有记录才算连续） */
export const computeLongestStreak = (series: readonly DailyViewPoint[]): number => {
  let longest = 0;
  let current = 0;
  for (const point of series) {
    current = point.views > 0 ? current + 1 : 0;
    if (current > longest) longest = current;
  }
  return longest;
};

// ---------------------------------------------------------------------------
// 报告可用性：记录覆盖天数不足就不生成报告
// ---------------------------------------------------------------------------

export type ReportKind = "week" | "month" | "year";

export const REPORT_KINDS: ReportKind[] = ["week", "month", "year"];

export const REPORT_KIND_LABEL: Record<ReportKind, string> = {
  week: "周报",
  month: "月报",
  year: "年报",
};

/**
 * 生成报告所需的记录覆盖天数。
 * 不足就不显示生成按钮——宁可没有报告，也不给一份"看起来有数据"的空报告。
 */
export const REQUIRED_COVERAGE_DAYS: Record<ReportKind, number> = {
  week: 7,
  month: 30,
  year: 365,
};

export const DAY_IN_MS = 24 * 60 * 60 * 1000;

/** 记录覆盖天数：从最早一条记录到现在，按本地自然日计 */
export const computeCoverageDays = (startedAtSec: number | null, nowMs: number): number => {
  if (!startedAtSec) return 0;
  const start = new Date(startedAtSec * 1000);
  start.setHours(0, 0, 0, 0);
  const today = new Date(nowMs);
  today.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((today.getTime() - start.getTime()) / DAY_IN_MS) + 1);
};

export interface ReportAvailability {
  coverageDays: number;
  available: Record<ReportKind, boolean>;
}

export const buildReportAvailability = (
  startedAtSec: number | null,
  nowMs: number,
): ReportAvailability => {
  const coverageDays = computeCoverageDays(startedAtSec, nowMs);
  return {
    coverageDays,
    available: {
      week: coverageDays >= REQUIRED_COVERAGE_DAYS.week,
      month: coverageDays >= REQUIRED_COVERAGE_DAYS.month,
      year: coverageDays >= REQUIRED_COVERAGE_DAYS.year,
    },
  };
};

// ---------------------------------------------------------------------------
// 周期报告（周 / 月 / 年，均为自然周期，截止到今天）
// ---------------------------------------------------------------------------

export interface HistoryReport {
  kind: ReportKind;
  kindLabel: string;
  /** 例："2026-10-05 ~ 2026-10-08" */
  periodLabel: string;
  /** 周期内实际有记录的天数 / 周期总天数 */
  activeDays: number;
  totalDays: number;
  summary: ViewSummary;
  peakDay: DailyViewPoint | null;
  peakHour: PeakHourWindow | null;
  /** 24 小时时段分布（不同视频数） */
  hours: number[];
  topAuthors: TopAuthor[];
  /** 视频时长分布（含「无时长信息」档，仅在有缺失时出现） */
  durationBuckets: DurationBucket[];
  series: DailyViewPoint[];
  longestStreak: number;
  /** 本期观测到的完整播放次数（下界） */
  completedPlays: number;
}

/** 周期起点（本地自然周 / 月 / 年），终点是"今天" */
export const resolvePeriodStartMs = (kind: ReportKind, nowMs: number): number => {
  const date = new Date(nowMs);
  date.setHours(0, 0, 0, 0);
  if (kind === "week") {
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
  } else if (kind === "month") {
    date.setDate(1);
  } else {
    date.setMonth(0, 1);
  }
  return date.getTime();
};

export const countDaysInclusive = (fromMs: number, toMs: number): number => {
  const from = new Date(fromMs);
  from.setHours(0, 0, 0, 0);
  const to = new Date(toMs);
  to.setHours(0, 0, 0, 0);
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_IN_MS) + 1);
};

export const filterEventsInRange = <T extends StatsEvent>(
  events: readonly T[],
  fromSec: number,
  toSec: number,
): T[] => events.filter((event) => event.view_at >= fromSec && event.view_at <= toSec);

export const buildHistoryReport = (
  events: readonly StatsEvent[],
  kind: ReportKind,
  nowMs: number,
  options: TopAuthorOptions = {},
): HistoryReport => {
  const startMs = resolvePeriodStartMs(kind, nowMs);
  const fromSec = Math.floor(startMs / 1000);
  const toSec = Math.floor(nowMs / 1000);
  // 报告是顶层入口，这里再过滤一次直播 / 文章：重复过滤是幂等的，
  // 但能保证调用方忘了先过 toStatsEvents 时数字也不会被污染。
  const periodEvents = filterStatsEvents(filterEventsInRange(events, fromSec, toSec));

  const totalDays = countDaysInclusive(startMs, nowMs);
  const series = buildDailyViewSeries(periodEvents, totalDays, nowMs);
  const hours = buildHourHistogram(periodEvents);
  const peakHour = findPeakHourWindow(hours, 2);

  return {
    kind,
    kindLabel: REPORT_KIND_LABEL[kind],
    periodLabel: `${toDayKey(fromSec)} ~ ${toDayKey(toSec)}`,
    activeDays: series.filter((point) => point.views > 0).length,
    totalDays,
    summary: summarizeViewCounts(periodEvents, nowMs),
    peakDay: findPeakDay(series),
    peakHour,
    hours,
    // 报告里给 10 位：界面是两列布局，5 行会显得太空
    topAuthors: buildTopAuthors(periodEvents, 10, options),
    durationBuckets: buildDurationDistribution(periodEvents),
    series,
    longestStreak: computeLongestStreak(series),
    completedPlays: countCompletedPlays(periodEvents).total,
  };
};

/** 供界面使用：把 [startHour, endHour) 写成人话 */
export const formatHourWindow = (window: PeakHourWindow | null): string => {
  if (!window) return "—";
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return `${pad(window.startHour)}:00–${pad(window.endHour)}:00`;
};

/** 类型守卫：把库里的 HistoryEvent 收敛成统计用的最小形状 */
export const toStatsEvents = (events: readonly HistoryEvent[]): StatsEvent[] =>
  filterStatsEvents(events);
