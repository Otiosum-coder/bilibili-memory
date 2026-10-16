import { describe, expect, it } from "vitest";
import {
  buildDailyViewSeries,
  buildHistoryReport,
  buildHourHistogram,
  buildReportAvailability,
  buildTopAuthors,
  buildHourAxisLabels,
  buildDurationDistribution,
  computeCoverageDays,
  computeLongestStreak,
  countCompletedPlays,
  filterStatsEvents,
  isCompletedObservation,
  findPeakDay,
  findPeakHourWindow,
  formatHourWindow,
  isStatsEligibleBusiness,
  resolvePeriodStartMs,
  summarizeViewCounts,
  toDayKey,
  type StatsEvent,
} from "./historyStats";

const DAY = 86_400_000;

// 用固定的基准时间，测试不随运行时刻漂移：2026-10-08 12:00（本地时区）
const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();

/** 相对基准日偏移 dayOffset 天、指定小时的时间戳（秒） */
const at = (dayOffset: number, hour = 12, minute = 0): number => {
  const date = new Date(NOW);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  date.setHours(hour, minute, 0, 0);
  return Math.floor(date.getTime() / 1000);
};

let seq = 0;
const event = (patch: Partial<StatsEvent> = {}): StatsEvent => {
  seq += 1;
  return {
    business: "archive",
    content_key: "archive:" + seq,
    view_at: at(0),
    author_mid: 100,
    author_name: "UP100",
    ...patch,
  };
};

describe("内容类型过滤", () => {
  it("视频 / 番剧 / 课程计入统计", () => {
    expect(isStatsEligibleBusiness("archive")).toBe(true);
    expect(isStatsEligibleBusiness("pgc")).toBe(true);
    expect(isStatsEligibleBusiness("cheese")).toBe(true);
  });

  it("直播与文章被排除", () => {
    expect(isStatsEligibleBusiness("live")).toBe(false);
    expect(isStatsEligibleBusiness("article")).toBe(false);
    expect(isStatsEligibleBusiness("article-list")).toBe(false);
  });

  it("filterStatsEvents 剔除直播与文章", () => {
    const kept = filterStatsEvents([
      event({ business: "archive" }),
      event({ business: "live" }),
      event({ business: "article" }),
      event({ business: "pgc" }),
    ]);
    expect(kept).toHaveLength(2);
    expect(kept[0].business).toBe("archive");
    expect(kept[1].business).toBe("pgc");
  });
});

describe("本地日期切分", () => {
  it("按本地时区生成 YYYY-MM-DD", () => {
    expect(toDayKey(at(0))).toBe("2026-10-08");
    expect(toDayKey(at(-1))).toBe("2026-10-07");
    expect(toDayKey(at(0, 0, 5))).toBe("2026-10-08");
    expect(toDayKey(at(0, 23, 59))).toBe("2026-10-08");
  });
});

describe("每日观看序列", () => {
  it("窗口内每天都有一点，没有观看的日子补 0", () => {
    const series = buildDailyViewSeries([], 3, NOW);
    expect(series).toHaveLength(3);
    expect(series[0].day).toBe("2026-10-06");
    expect(series[2].day).toBe("2026-10-08");
    expect(series[0].views).toBe(0);
  });

  it("同一天两条不同视频：2 次观看、2 个不同视频", () => {
    const series = buildDailyViewSeries(
      [
        event({ view_at: at(0, 9), content_key: "archive:1" }),
        event({ view_at: at(0, 21), content_key: "archive:2" }),
      ],
      2,
      NOW,
    );
    expect(series[1].views).toBe(2);
    expect(series[1].uniqueContents).toBe(2);
  });

  it("同一天重复看同一个视频：次数 2、不同视频 1", () => {
    const series = buildDailyViewSeries(
      [
        event({ view_at: at(0, 9), content_key: "archive:1" }),
        event({ view_at: at(0, 21), content_key: "archive:1" }),
      ],
      1,
      NOW,
    );
    expect(series[0].views).toBe(2);
    expect(series[0].uniqueContents).toBe(1);
  });

  it("窗口之外的事件不计入", () => {
    const series = buildDailyViewSeries([event({ view_at: at(-10) })], 7, NOW);
    expect(series.reduce((sum, point) => sum + point.views, 0)).toBe(0);
  });
});

describe("完整播放次数（观测下界）", () => {
  it("进度到 -1 或达到 95% 都算播完", () => {
    expect(isCompletedObservation(event({ progress: -1, duration: 100 }))).toBe(true);
    expect(isCompletedObservation(event({ progress: 95, duration: 100 }))).toBe(true);
    expect(isCompletedObservation(event({ progress: 94, duration: 100 }))).toBe(false);
    expect(isCompletedObservation(event({ progress: 50, duration: 100 }))).toBe(false);
  });

  it("没有时长信息时，只有 -1 算播完", () => {
    expect(isCompletedObservation(event({ progress: -1 }))).toBe(true);
    expect(isCompletedObservation(event({ progress: 100 }))).toBe(false);
    expect(isCompletedObservation(event({ progress: 100, duration: 0 }))).toBe(false);
  });

  it("循环两轮：-1 之后再回到开头，算 2 次", () => {
    const stats = countCompletedPlays([
      event({ content_key: "archive:1", view_at: at(0, 9, 0), progress: 30, duration: 100 }),
      event({ content_key: "archive:1", view_at: at(0, 9, 1), progress: 100, duration: 100 }),
      event({ content_key: "archive:1", view_at: at(0, 9, 2), progress: -1, duration: 100 }),
      event({ content_key: "archive:1", view_at: at(0, 9, 3), progress: 20, duration: 100 }),
      event({ content_key: "archive:1", view_at: at(0, 9, 4), progress: 60, duration: 100 }),
      event({ content_key: "archive:1", view_at: at(0, 9, 5), progress: -1, duration: 100 }),
    ]);
    expect(stats.total).toBe(2);
    expect(stats.byContent.get("archive:1")).toBe(2);
    expect(stats.contents).toBe(1);
  });

  it("播完后停在那里，连续多条片尾状态只算 1 次", () => {
    const stats = countCompletedPlays([
      event({ content_key: "archive:1", view_at: at(0, 9, 0), progress: 10, duration: 100 }),
      event({ content_key: "archive:1", view_at: at(0, 9, 1), progress: -1, duration: 100 }),
      event({ content_key: "archive:1", view_at: at(0, 9, 2), progress: -1, duration: 100 }),
      event({ content_key: "archive:1", view_at: at(0, 9, 3), progress: -1, duration: 100 }),
    ]);
    expect(stats.total).toBe(1);
  });

  it("真实数据形态：多次爬到片尾、只最后一轮标记 -1，应算多次", () => {
    // 取自真实诊断输出：3865 → 回退 → 3833 → -1 → 回退 → 1441
    const stats = countCompletedPlays([
      event({ content_key: "archive:9", view_at: at(0, 9, 0), progress: 805, duration: 4000 }),
      event({ content_key: "archive:9", view_at: at(0, 9, 1), progress: 3865, duration: 4000 }),
      event({ content_key: "archive:9", view_at: at(0, 9, 2), progress: 45, duration: 4000 }),
      event({ content_key: "archive:9", view_at: at(0, 9, 3), progress: 3833, duration: 4000 }),
      event({ content_key: "archive:9", view_at: at(0, 9, 4), progress: -1, duration: 4000 }),
      event({ content_key: "archive:9", view_at: at(0, 9, 5), progress: 30, duration: 4000 }),
      event({ content_key: "archive:9", view_at: at(0, 9, 6), progress: 1441, duration: 4000 }),
    ]);
    expect(stats.total).toBe(2);
  });

  it("只看了中间一段没有播完，算 0 次", () => {
    const stats = countCompletedPlays([
      event({ content_key: "archive:1", view_at: at(0, 9, 0), progress: 100, duration: 4000 }),
      event({ content_key: "archive:1", view_at: at(0, 9, 1), progress: 900, duration: 4000 }),
    ]);
    expect(stats.total).toBe(0);
    expect(stats.contents).toBe(0);
  });

  it("多个内容各自计数，按内容拆分", () => {
    const stats = countCompletedPlays([
      event({ content_key: "archive:1", view_at: at(0, 9, 0), progress: -1, duration: 100 }),
      event({ content_key: "archive:2", view_at: at(0, 9, 1), progress: -1, duration: 100 }),
      event({ content_key: "archive:2", view_at: at(0, 9, 2), progress: 10, duration: 100 }),
      event({ content_key: "archive:2", view_at: at(0, 9, 3), progress: -1, duration: 100 }),
    ]);
    expect(stats.total).toBe(3);
    expect(stats.contents).toBe(2);
  });

  it("事件顺序打乱也能正确计数（内部按时间排序）", () => {
    const stats = countCompletedPlays([
      event({ content_key: "archive:1", view_at: at(0, 9, 2), progress: -1, duration: 100 }),
      event({ content_key: "archive:1", view_at: at(0, 9, 0), progress: 30, duration: 100 }),
      event({ content_key: "archive:1", view_at: at(0, 9, 1), progress: 90, duration: 100 }),
    ]);
    expect(stats.total).toBe(1);
  });

  it("汇总与榜单、报告都带上完整播放次数", () => {
    const events = [
      event({ content_key: "archive:1", view_at: at(0, 9, 0), progress: 10, duration: 100, author_mid: 7 }),
      event({ content_key: "archive:1", view_at: at(0, 9, 1), progress: -1, duration: 100, author_mid: 7 }),
    ];
    expect(summarizeViewCounts(events, NOW).completedPlays).toBe(1);
    expect(buildTopAuthors(events)[0].completedPlays).toBe(1);
    expect(buildHistoryReport(events, "week", NOW).completedPlays).toBe(1);
  });
});

describe("汇总（今天 / 本周 / 本月 / 本年）", () => {
  it("按本地日期分别归类", () => {
    const summary = summarizeViewCounts(
      [
        event({ view_at: at(0, 9) }),
        event({ view_at: at(0, 10) }),
        event({ view_at: at(-1, 9) }),
        event({ view_at: at(-40, 9) }),
      ],
      NOW,
    );
    // 视频数（主口径）
    expect(summary.todayVideos).toBe(2);
    expect(summary.monthVideos).toBe(3);
    expect(summary.yearVideos).toBe(4);
    // 记录条数（辅助口径）
    expect(summary.todayRecords).toBe(2);
    expect(summary.monthRecords).toBe(3);
    expect(summary.yearRecords).toBe(4);
  });

  it("同一视频一天看多次：记录 3 条，但只算 1 个视频", () => {
    const summary = summarizeViewCounts(
      [
        event({ view_at: at(0, 9), content_key: "archive:1" }),
        event({ view_at: at(0, 10), content_key: "archive:1" }),
        event({ view_at: at(0, 11), content_key: "archive:1" }),
      ],
      NOW,
    );
    expect(summary.todayRecords).toBe(3);
    expect(summary.todayVideos).toBe(1);
  });

  it("本周从周一开始，周日的事件不算进本周", () => {
    const weekStartMs = resolvePeriodStartMs("week", NOW);
    expect(new Date(weekStartMs).getDay()).toBe(1);
    const weekStartSec = Math.floor(weekStartMs / 1000);

    const summary = summarizeViewCounts(
      [
        event({ view_at: weekStartSec + 60 }),
        event({ view_at: weekStartSec - 60 }),
      ],
      NOW,
    );
    expect(summary.weekVideos).toBe(1);
    expect(summary.weekRecords).toBe(1);
  });

  it("活跃天数与不同视频数去重", () => {
    const summary = summarizeViewCounts(
      [
        event({ view_at: at(0), content_key: "archive:1" }),
        event({ view_at: at(0), content_key: "archive:1" }),
        event({ view_at: at(-2), content_key: "archive:1" }),
        event({ view_at: at(-2), content_key: "archive:9" }),
      ],
      NOW,
    );
    expect(summary.activeDays).toBe(2);
    expect(summary.uniqueContents).toBe(2);
  });
});

describe("时段分布（星期分布已废弃）", () => {
  it("小时直方图长度 24，总量等于事件数", () => {
    const hours = buildHourHistogram([
      event({ view_at: at(0, 22) }),
      event({ view_at: at(0, 22) }),
      event({ view_at: at(-1, 8) }),
    ]);
    expect(hours).toHaveLength(24);
    expect(hours[22]).toBe(2);
    expect(hours[8]).toBe(1);
  });

  it("时段直方图按不同视频去重，同一视频看两次只算一次", () => {
    const hours = buildHourHistogram([
      event({ view_at: at(0, 22, 0), content_key: "archive:1" }),
      event({ view_at: at(0, 22, 30), content_key: "archive:1" }),
      event({ view_at: at(0, 22, 40), content_key: "archive:2" }),
    ]);
    expect(hours[22]).toBe(2);
  });

  it("24 格：相邻小时各自计数，同一视频在同一小时看两次只算一次", () => {
    const hours = buildHourHistogram([
      event({ view_at: at(0, 20, 10), content_key: "archive:1" }),
      event({ view_at: at(0, 20, 50), content_key: "archive:1" }),
      event({ view_at: at(0, 21, 10), content_key: "archive:1" }),
      event({ view_at: at(0, 22, 10), content_key: "archive:2" }),
    ]);
    expect(hours).toHaveLength(24);
    expect(hours[20]).toBe(1);
    expect(hours[21]).toBe(1);
    expect(hours[22]).toBe(1);
  });

  it("时长分布按不同视频去重，缺时长的单独成档", () => {
    const buckets = buildDurationDistribution([
      event({ content_key: "archive:1", duration: 120 }),
      event({ content_key: "archive:1", duration: 120 }),
      event({ content_key: "archive:2", duration: 600 }),
      event({ content_key: "archive:3", duration: 1500 }),
      event({ content_key: "archive:4", duration: 3000 }),
      event({ content_key: "archive:5", duration: 4200 }),
      event({ content_key: "archive:6", duration: 0 }),
      event({ content_key: "archive:7" }),
    ]);
    expect(buckets.map((bucket) => bucket.contents)).toEqual([1, 1, 1, 1, 1, 2]);
    expect(buckets[5].label).toBe("无时长信息");
  });

  it("没有缺失时不额外产出「无时长信息」档", () => {
    const buckets = buildDurationDistribution([event({ content_key: "archive:1", duration: 60 })]);
    expect(buckets.map((bucket) => bucket.label)).toEqual([
      "5 分钟以内",
      "5–15 分钟",
      "15–30 分钟",
      "30–60 分钟",
      "1 小时以上",
    ]);
  });

  it("横轴标签只每 step 小时给一个 H:00，其余留空占位", () => {
    const labels = buildHourAxisLabels();
    expect(labels).toHaveLength(24);
    expect(labels[0]).toBe("0:00");
    expect(labels[3]).toBe("3:00");
    expect(labels[21]).toBe("21:00");
    expect(labels[1]).toBe("");
    expect(buildHourAxisLabels(6).filter(Boolean)).toEqual(["0:00", "6:00", "12:00", "18:00"]);
  });

  it("最爱时段取窗口内观看最多的那一段", () => {
    const hours = new Array(24).fill(0);
    hours[21] = 3;
    hours[22] = 5;
    hours[3] = 1;
    const peak = findPeakHourWindow(hours, 2);
    expect(peak === null).toBe(false);
    expect(peak?.startHour).toBe(21);
    expect(peak?.endHour).toBe(23);
    expect(peak?.views).toBe(8);
  });

  it("没有观看时返回 null", () => {
    expect(findPeakHourWindow(new Array(24).fill(0), 2)).toBeNull();
  });

  it("时段格式化成 HH:00–HH:00", () => {
    expect(formatHourWindow(null)).toBe("—");
    expect(formatHourWindow({ startHour: 2, endHour: 4, views: 9 })).toBe("02:00–04:00");
  });
});

describe("最常看的 UP 主", () => {
  it("视频数相同才比记录条数，再并列按 mid 升序", () => {
    const authors = buildTopAuthors([
      event({ author_mid: 20, author_name: "B" }),
      event({ author_mid: 10, author_name: "A" }),
      event({ author_mid: 10, author_name: "A" }),
      event({ author_mid: 30, author_name: "C" }),
      event({ author_mid: 30, author_name: "C" }),
    ]);
    expect(authors).toHaveLength(3);
    expect(authors[0].mid).toBe(10);
    expect(authors[0].views).toBe(2);
    expect(authors[1].mid).toBe(30);
    expect(authors[2].mid).toBe(20);
  });

  it("同一 UP 主的不同视频会去重计数", () => {
    const authors = buildTopAuthors([
      event({ author_mid: 7, content_key: "archive:1" }),
      event({ author_mid: 7, content_key: "archive:1" }),
      event({ author_mid: 7, content_key: "archive:2" }),
    ]);
    expect(authors[0].views).toBe(3);
    expect(authors[0].uniqueContents).toBe(2);
  });

  it("按不同视频数排序：一个视频看十遍也比不过三个视频", () => {
    const authors = buildTopAuthors([
      // 甲：只有 1 个视频，但被记了 10 条（长视频会被反复刷新 view_at）
      ...Array.from({ length: 10 }, (_, i) =>
        event({ author_mid: 1, author_name: "甲", content_key: "archive:1", view_at: at(0, 9, i) }),
      ),
      // 乙：3 个视频，各 1 条
      event({ author_mid: 2, author_name: "乙", content_key: "archive:2" }),
      event({ author_mid: 2, author_name: "乙", content_key: "archive:3" }),
      event({ author_mid: 2, author_name: "乙", content_key: "archive:4" }),
    ]);
    expect(authors[0].mid).toBe(2);
    expect(authors[0].uniqueContents).toBe(3);
    expect(authors[1].mid).toBe(1);
    expect(authors[1].views).toBe(10);
    expect(authors[1].uniqueContents).toBe(1);
  });

  it("尊重 limit", () => {
    const events = [1, 2, 3, 4, 5, 6].map((mid) => event({ author_mid: mid }));
    expect(buildTopAuthors(events, 5)).toHaveLength(5);
    expect(buildTopAuthors(events, 0)).toHaveLength(0);
  });

  it("空名字不会覆盖已观测到的真实名字", () => {
    const authors = buildTopAuthors([
      event({ author_mid: 5, author_name: "真名" }),
      event({ author_mid: 5, author_name: "" }),
    ]);
    expect(authors[0].name).toBe("真名");
  });
});

describe("近期维度（最近在看的 UP 主）", () => {
  it("按近期视频数优先：全时段多但近期没看的会被挤到后面", () => {
    const authors = buildTopAuthors(
      [
        // 甲：3 个视频，全是 40 天前看的
        event({ author_mid: 1, author_name: "甲", content_key: "a:1", view_at: at(-40) }),
        event({ author_mid: 1, author_name: "甲", content_key: "a:2", view_at: at(-40) }),
        event({ author_mid: 1, author_name: "甲", content_key: "a:3", view_at: at(-41) }),
        // 乙：2 个视频，最近看的
        event({ author_mid: 2, author_name: "乙", content_key: "b:1", view_at: at(0) }),
        event({ author_mid: 2, author_name: "乙", content_key: "b:2", view_at: at(-1) }),
      ],
      5,
      { recentSinceSec: at(-29) },
    );
    expect(authors[0].mid).toBe(2);
    expect(authors[0].recentVideos).toBe(2);
    expect(authors[0].uniqueContents).toBe(2);
    expect(authors[1].mid).toBe(1);
    expect(authors[1].recentVideos).toBe(0);
    expect(authors[1].uniqueContents).toBe(3);
  });

  it("窗口内重复看同一个视频只算 1 个", () => {
    const authors = buildTopAuthors(
      [
        event({ author_mid: 3, content_key: "c:1", view_at: at(0, 9) }),
        event({ author_mid: 3, content_key: "c:1", view_at: at(0, 10) }),
        event({ author_mid: 3, content_key: "c:1", view_at: at(-1) }),
      ],
      5,
      { recentSinceSec: at(-6) },
    );
    expect(authors[0].recentVideos).toBe(1);
  });

  it("不传窗口时行为与旧版一致（近期数等于全部数）", () => {
    const authors = buildTopAuthors([
      event({ author_mid: 1, content_key: "a:1", view_at: at(-40) }),
      event({ author_mid: 2, content_key: "b:1", view_at: at(-40) }),
      event({ author_mid: 2, content_key: "b:2", view_at: at(-41) }),
    ]);
    expect(authors[0].mid).toBe(2);
    expect(authors[0].recentVideos).toBe(2);
    expect(authors[0].uniqueContents).toBe(2);
  });

  it("名字为空时先用兜底表，再没有就显示 UID（避免整行空白）", () => {
    const events = [event({ author_mid: 42, author_name: "", content_key: "a:1" })];
    const withMap = buildTopAuthors(events, 5, { nameByMid: new Map([[42, "补上的真名"]]) });
    expect(withMap[0].name).toBe("补上的真名");

    const withoutMap = buildTopAuthors(events);
    expect(withoutMap[0].name).toBe("UID 42（名字未知）");
  });

  it("最近一次观看时间取最大值，没看过时为 null", () => {
    const authors = buildTopAuthors([
      event({ author_mid: 5, view_at: at(-10) }),
      event({ author_mid: 5, view_at: at(-2) }),
      event({ author_mid: 5, view_at: at(-7) }),
    ]);
    expect(authors[0].lastViewedAt).toBe(at(-2));
    expect(buildTopAuthors([])).toHaveLength(0);
  });
});

describe("峰值与连续天数", () => {
  it("取观看最多的一天", () => {
    const series = buildDailyViewSeries(
      [
        event({ view_at: at(-2) }),
        event({ view_at: at(-1) }),
        event({ view_at: at(-1) }),
      ],
      3,
      NOW,
    );
    const peak = findPeakDay(series);
    expect(peak?.day).toBe("2026-10-07");
    expect(peak?.views).toBe(2);
  });

  it("单日最高按不同视频数，而不是记录条数", () => {
    const series = buildDailyViewSeries(
      [
        ...Array.from({ length: 5 }, (_, i) =>
          event({ view_at: at(-2, 9, i), content_key: "archive:1" }),
        ),
        event({ view_at: at(-1), content_key: "archive:2" }),
        event({ view_at: at(-1), content_key: "archive:3" }),
      ],
      3,
      NOW,
    );
    const peak = findPeakDay(series);
    expect(peak?.day).toBe("2026-10-07");
    expect(peak?.uniqueContents).toBe(2);
    expect(peak?.views).toBe(2);
  });

  it("全为 0 时没有峰值", () => {
    expect(findPeakDay(buildDailyViewSeries([], 3, NOW))).toBeNull();
  });

  it("最长连续观看天数", () => {
    const series = buildDailyViewSeries(
      [event({ view_at: at(-3) }), event({ view_at: at(-2) }), event({ view_at: at(0) })],
      5,
      NOW,
    );
    expect(computeLongestStreak(series)).toBe(2);
  });

  it("完全连续时等于窗口长度", () => {
    const series = buildDailyViewSeries(
      [0, -1, -2].map((offset) => event({ view_at: at(offset) })),
      3,
      NOW,
    );
    expect(computeLongestStreak(series)).toBe(3);
  });
});

describe("报告可用性：覆盖天数不足就不生成", () => {
  it("没有记录时覆盖 0 天，三个报告都不可用", () => {
    expect(computeCoverageDays(null, NOW)).toBe(0);
    const availability = buildReportAvailability(null, NOW);
    expect(availability.coverageDays).toBe(0);
    expect(availability.available.week).toBe(false);
    expect(availability.available.month).toBe(false);
    expect(availability.available.year).toBe(false);
  });

  it("今天才开始记录：都不满足", () => {
    const availability = buildReportAvailability(at(0), NOW);
    expect(availability.coverageDays).toBe(1);
    expect(availability.available.week).toBe(false);
  });

  it("满 7 天显示周报，但不显示月报", () => {
    const availability = buildReportAvailability(at(-6), NOW);
    expect(availability.coverageDays).toBe(7);
    expect(availability.available.week).toBe(true);
    expect(availability.available.month).toBe(false);
    expect(availability.available.year).toBe(false);
  });

  it("不满 7 天仍不显示周报", () => {
    const availability = buildReportAvailability(at(-5), NOW);
    expect(availability.coverageDays).toBe(6);
    expect(availability.available.week).toBe(false);
  });

  it("满 30 天显示月报", () => {
    const availability = buildReportAvailability(at(-29), NOW);
    expect(availability.coverageDays).toBe(30);
    expect(availability.available.month).toBe(true);
    expect(availability.available.year).toBe(false);
  });

  it("满 365 天才显示年报", () => {
    const availability = buildReportAvailability(at(-364), NOW);
    expect(availability.coverageDays).toBe(365);
    expect(availability.available.year).toBe(true);
  });

  it("差一天不显示年报", () => {
    const availability = buildReportAvailability(at(-363), NOW);
    expect(availability.coverageDays).toBe(364);
    expect(availability.available.year).toBe(false);
  });
});

describe("周期报告", () => {
  it("周报起点是周一，月报起点是 1 号，年报起点是 1 月 1 日", () => {
    const week = new Date(resolvePeriodStartMs("week", NOW));
    expect(week.getDay()).toBe(1);
    expect(week.getHours()).toBe(0);

    const month = new Date(resolvePeriodStartMs("month", NOW));
    expect(month.getDate()).toBe(1);
    expect(month.getMonth()).toBe(9);

    const year = new Date(resolvePeriodStartMs("year", NOW));
    expect(year.getMonth()).toBe(0);
    expect(year.getDate()).toBe(1);
  });

  it("只统计周期内的事件", () => {
    const report = buildHistoryReport(
      [event({ view_at: at(-400) }), event({ view_at: at(0) })],
      "year",
      NOW,
    );
    expect(report.summary.yearVideos).toBe(1);
    expect(report.totalDays).toBeGreaterThan(200);
  });

  it("报告内部再次排除直播与文章", () => {
    const report = buildHistoryReport(
      [
        event({ view_at: at(0), business: "live" }),
        event({ view_at: at(0), business: "article" }),
        event({ view_at: at(0) }),
      ],
      "week",
      NOW,
    );
    expect(report.series.reduce((sum, point) => sum + point.views, 0)).toBe(1);
  });

  it("空数据的报告不报错，各项为空", () => {
    const report = buildHistoryReport([], "month", NOW);
    expect(report.peakDay).toBeNull();
    expect(report.peakHour).toBeNull();
    expect(report.topAuthors).toHaveLength(0);
    expect(report.activeDays).toBe(0);
    // 时段分布仍然给出完整格子（全 0），界面可以直接画
    expect(report.hours).toHaveLength(24);
    expect(report.hours.every((value) => value === 0)).toBe(true);
  });

  it("periodLabel 是 起 ~ 止 的本地日期", () => {
    const report = buildHistoryReport([], "week", NOW);
    expect(report.periodLabel.endsWith("~ 2026-10-08")).toBe(true);
    expect(report.kindLabel).toBe("周报");
  });

  it("activeDays 统计周期内有记录的天数", () => {
    const report = buildHistoryReport(
      [event({ view_at: at(0) }), event({ view_at: at(-1) })],
      "month",
      NOW,
    );
    expect(report.activeDays).toBe(2);
  });

  it("周期长度按自然周期计算", () => {
    const weekReport = buildHistoryReport([], "week", NOW);
    const weekStart = new Date(resolvePeriodStartMs("week", NOW));
    const expected = Math.round((new Date(NOW).setHours(0, 0, 0, 0) - weekStart.getTime()) / DAY) + 1;
    expect(weekReport.totalDays).toBe(expected);
  });
});
