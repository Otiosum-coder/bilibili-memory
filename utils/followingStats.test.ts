import { describe, expect, it } from "vitest";
import { formatLocalDay } from "./followingDiff";
import {
  buildDailyChangeSeries,
  buildDashboardMetrics,
  buildLongestFollowed,
  buildRecentEvents,
  buildRenameLeaderboard,
  countEventsByType,
  earliestEventDay,
  filterEventsByType,
  renameCountOf,
  summarizeEventTypes,
} from "./followingStats";
import type { FollowingEvent, FollowingEventType, FollowingItem } from "./types";

const NOW = new Date(2026, 9, 7, 12, 0, 0).getTime();
const DAY_MS = 86_400_000;

const dayOf = (offsetDays: number): string => {
  const date = new Date(NOW);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - offsetDays);
  return formatLocalDay(date.getTime());
};

const makeEvent = (
  type: FollowingEventType,
  mid: number,
  day: string,
  occurredAt = NOW,
): FollowingEvent => ({
  event_id: `${type}:${mid}:${day}`,
  type,
  mid,
  day,
  occurred_at: occurredAt,
  name: `UP_${mid}`,
});

const makeItem = (mid: number, patch: Partial<FollowingItem> = {}): FollowingItem => ({
  mid,
  name: `UP_${mid}`,
  face: "",
  sign: "",
  mtime: Math.floor(NOW / 1000),
  attribute: 2,
  special: 0,
  status: "following",
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  lastSeenInSyncAt: NOW,
  nameHistory: [{ name: `UP_${mid}`, seenAt: NOW }],
  ...patch,
});

describe("buildDashboardMetrics", () => {
  it("按固定顺序输出全部模块指标", () => {
    const metrics = buildDashboardMetrics(
      {
        historyCount: 100,
        favoriteCount: 20,
        folderCount: 6,
        collectionCount: 3,
        collectionResourceCount: 50,
      },
      1142,
    );

    expect(metrics.map((metric) => metric.label)).toEqual([
      "历史记录",
      "收藏内容",
      "收藏夹",
      "订阅合集",
      "合集内容",
      "关注 UP 主",
    ]);
    expect(metrics[metrics.length - 1].value).toBe(1142);
    expect(metrics[0].value).toBe(100);
  });
});

describe("buildDailyChangeSeries", () => {
  it("生成连续日期轴，没有变动的日子补 0", () => {
    const series = buildDailyChangeSeries([], 3, NOW);

    expect(series).toHaveLength(3);
    expect(series.map((point) => point.day)).toEqual([dayOf(2), dayOf(1), dayOf(0)]);
    expect(series.every((point) => point.total === 0)).toBe(true);
  });

  it("把事件按类型放进取关/改名/注销各自的桶", () => {
    const events = [
      makeEvent("followed", 1, dayOf(0)),
      makeEvent("followed", 2, dayOf(0)),
      makeEvent("unfollowed", 3, dayOf(1)),
      makeEvent("renamed", 4, dayOf(1)),
      makeEvent("account_gone", 5, dayOf(2)),
    ];

    const series = buildDailyChangeSeries(events, 3, NOW);

    expect(series[2]).toMatchObject({ followed: 2, total: 2 });
    expect(series[1]).toMatchObject({ unfollowed: 1, renamed: 1, total: 2 });
    expect(series[0]).toMatchObject({ accountGone: 1, total: 1 });
  });

  it("窗口之外的历史事件被忽略（不会把总和对不上）", () => {
    const events = [
      makeEvent("followed", 1, dayOf(0)),
      makeEvent("followed", 2, dayOf(10)), // 超出 3 天窗口
    ];

    const series = buildDailyChangeSeries(events, 3, NOW);

    expect(series.reduce((sum, point) => sum + point.total, 0)).toBe(1);
  });

  it("dayCount 为 1 时只返回今天", () => {
    const series = buildDailyChangeSeries([], 1, NOW);
    expect(series).toHaveLength(1);
    expect(series[0].day).toBe(formatLocalDay(NOW));
  });

  it("dayCount 非法时至少返回一天", () => {
    expect(buildDailyChangeSeries([], 0, NOW)).toHaveLength(1);
    expect(buildDailyChangeSeries([], -5, NOW)).toHaveLength(1);
  });
});

describe("summarizeEventTypes", () => {
  it("分别统计四类事件与总数", () => {
    const events = [
      makeEvent("followed", 1, dayOf(0)),
      makeEvent("followed", 2, dayOf(0)),
      makeEvent("unfollowed", 3, dayOf(0)),
      makeEvent("renamed", 4, dayOf(0)),
      makeEvent("account_gone", 5, dayOf(0)),
    ];

    expect(summarizeEventTypes(events)).toEqual({
      followed: 2,
      unfollowed: 1,
      renamed: 1,
      accountGone: 1,
      total: 5,
    });
  });

  it("空事件流返回全 0", () => {
    expect(summarizeEventTypes([]).total).toBe(0);
  });
});

describe("earliestEventDay", () => {
  it("返回最早的一天，用于说明记录起始日期", () => {
    const events = [
      makeEvent("followed", 1, "2026-10-05"),
      makeEvent("followed", 2, "2026-09-30"),
      makeEvent("followed", 3, "2026-10-02"),
    ];
    expect(earliestEventDay(events)).toBe("2026-09-30");
  });

  it("没有事件时返回 null", () => {
    expect(earliestEventDay([])).toBeNull();
  });
});

describe("buildRenameLeaderboard", () => {
  it("按本地观测到的改名次数倒序，且排除没改过名的人", () => {
    const items = [
      makeItem(1, {
        nameHistory: [
          { name: "A", seenAt: 1 },
          { name: "B", seenAt: 2 },
          { name: "C", seenAt: 3 },
        ],
      }),
      makeItem(2, {
        nameHistory: [
          { name: "A", seenAt: 1 },
          { name: "B", seenAt: 2 },
        ],
      }),
      makeItem(3),
    ];

    const board = buildRenameLeaderboard(items);

    expect(board.map((entry) => entry.item.mid)).toEqual([1, 2]);
    expect(board[0].renameCount).toBe(2);
    expect(board[1].renameCount).toBe(1);
    expect(board[0].names).toEqual(["A", "B", "C"]);
  });

  it("尊重 limit", () => {
    const items = [
      makeItem(1, {
        nameHistory: [
          { name: "A", seenAt: 1 },
          { name: "B", seenAt: 2 },
        ],
      }),
      makeItem(2, {
        nameHistory: [
          { name: "A", seenAt: 1 },
          { name: "B", seenAt: 2 },
        ],
      }),
    ];
    expect(buildRenameLeaderboard(items, 1)).toHaveLength(1);
  });

  it("没有改名记录时返回空数组", () => {
    expect(buildRenameLeaderboard([makeItem(1), makeItem(2)])).toEqual([]);
  });
});

describe("buildLongestFollowed", () => {
  it("按关注时间升序，最早关注的排前面", () => {
    const items = [
      makeItem(1, { mtime: 300 }),
      makeItem(2, { mtime: 100 }),
      makeItem(3, { mtime: 200 }),
    ];

    expect(buildLongestFollowed(items).map((item) => item.mid)).toEqual([2, 3, 1]);
  });

  it("mtime 缺失时回退到首次观测时间", () => {
    const items = [
      makeItem(1, { mtime: 0, firstSeenAt: NOW }),
      makeItem(2, { mtime: 0, firstSeenAt: NOW - 10 * DAY_MS }),
    ];
    expect(buildLongestFollowed(items).map((item) => item.mid)).toEqual([2, 1]);
  });
});

describe("buildRecentEvents", () => {
  it("按发生时间倒序并限制条数", () => {
    const events = [
      makeEvent("followed", 1, dayOf(2), NOW - 2 * DAY_MS),
      makeEvent("followed", 2, dayOf(0), NOW),
      makeEvent("followed", 3, dayOf(1), NOW - DAY_MS),
    ];

    const recent = buildRecentEvents(events, 2);

    expect(recent.map((event) => event.mid)).toEqual([2, 3]);
  });

  it("不传 limit 表示全部，仍然按时间倒序", () => {
    const events = [
      makeEvent("followed", 1, dayOf(2), NOW - 2 * DAY_MS),
      makeEvent("unfollowed", 2, dayOf(0), NOW),
      makeEvent("renamed", 3, dayOf(1), NOW - DAY_MS),
    ];

    expect(buildRecentEvents(events).map((event) => event.mid)).toEqual([2, 3, 1]);
  });

  it("同一天的多条事件按 occurred_at 定序，不依赖输入顺序", () => {
    const sameDay = [
      makeEvent("followed", 1, dayOf(0), NOW - 60_000),
      makeEvent("renamed", 2, dayOf(0), NOW),
      makeEvent("unfollowed", 3, dayOf(0), NOW - 30_000),
    ];

    expect(buildRecentEvents(sameDay).map((event) => event.mid)).toEqual([2, 3, 1]);
    expect(buildRecentEvents([...sameDay].reverse()).map((event) => event.mid)).toEqual([2, 3, 1]);
  });
});

describe("最近变动的筛选与计数", () => {
  const events = [
    makeEvent("followed", 1, dayOf(3), NOW - 3 * DAY_MS),
    makeEvent("followed", 2, dayOf(2), NOW - 2 * DAY_MS),
    makeEvent("renamed", 3, dayOf(1), NOW - DAY_MS),
    makeEvent("unfollowed", 4, dayOf(0), NOW),
  ];

  it("按类型统计条数（四种类型都要出现在结果里，哪怕是 0）", () => {
    expect(countEventsByType(events)).toEqual({
      followed: 2,
      unfollowed: 1,
      renamed: 1,
      account_gone: 0,
    });
  });

  it("空输入时四种类型都是 0", () => {
    expect(countEventsByType([])).toEqual({
      followed: 0,
      unfollowed: 0,
      renamed: 0,
      account_gone: 0,
    });
  });

  it("按类型筛选只留下该类型；all 原样返回", () => {
    expect(filterEventsByType(events, "renamed").map((event) => event.mid)).toEqual([3]);
    expect(filterEventsByType(events, "followed")).toHaveLength(2);
    expect(filterEventsByType(events, "account_gone")).toHaveLength(0);
    expect(filterEventsByType(events, "all")).toHaveLength(4);
  });

  it("筛选结果交给 buildRecentEvents 后仍是时间倒序（筛选不破坏排序）", () => {
    const renamedAndFollowed = filterEventsByType(events, "followed");
    // 新加的"加载更多"就是"筛选 + 不传 limit"，这里把两步的组合钉住
    expect(buildRecentEvents(renamedAndFollowed).map((event) => event.mid)).toEqual([2, 1]);
  });
});

describe("renameCountOf", () => {
  it("基线名不算改名，所以 length=1 时为 0", () => {
    expect(renameCountOf(makeItem(1))).toBe(0);
  });

  it("改过几次名就返回几（基线名之外的每一条算一次）", () => {
    expect(
      renameCountOf(
        makeItem(1, {
          name: "C",
          nameHistory: [
            { name: "A", seenAt: NOW - 2 * DAY_MS },
            { name: "B", seenAt: NOW - DAY_MS },
            { name: "C", seenAt: NOW },
          ],
        }),
      ),
    ).toBe(2);
  });
});
