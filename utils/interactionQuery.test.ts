import { describe, expect, it } from "vitest";
import {
  buildInteractionDetail,
  buildInteractionStats,
  formatInteractionDuration,
  formatInteractionTime,
  interactionTimeLabel,
  isInteractionContentGone,
  paginateInteractions,
  queryInteractions,
} from "./interactionQuery";
import { interactionKey } from "./interactionDiff";
import type { InteractionItem, InteractionType } from "./types";

const NOW = 1_700_000_000_000;

const makeItem = (
  type: InteractionType,
  bvid: string,
  overrides: Partial<InteractionItem> = {},
): InteractionItem => ({
  id: interactionKey(type, bvid),
  type,
  bvid,
  title: `标题 ${bvid}`,
  firstTitle: `标题 ${bvid}`,
  cover: "https://i0.hdslb.com/bfs/archive/a.jpg",
  duration: 100,
  authorName: "某 UP",
  authorMid: 1,
  pubdate: 1_600_000_000,
  interactedAt: 1_600_000_000_000,
  interactedAtExact: type === "coin",
  state: "listed",
  firstSeenAt: 1_600_000_000_000,
  lastSeenAt: 1_600_000_000_000,
  lastSeenOnlineAt: 1_600_000_000_000,
  ...overrides,
});

describe("buildInteractionStats", () => {
  it("按类型与状态分别计数", () => {
    const items = [
      makeItem("like", "BV1aa411c7m0"),
      makeItem("like", "BV1bb411c7m1", { state: "retained" }),
      makeItem("coin", "BV1cc411c7m2", { state: "content_deleted" }),
    ];
    const stats = buildInteractionStats(items);
    expect(stats.total).toBe(3);
    expect(stats.like).toBe(2);
    expect(stats.coin).toBe(1);
    expect(stats.byState.listed).toBe(1);
    expect(stats.byState.retained).toBe(1);
    expect(stats.byState.content_deleted).toBe(1);
    expect(stats.byState.ended).toBe(0);
    // 两条点赞的 interactedAtExact 为 false，投币那条为 true
    expect(stats.approximateTime).toBe(2);
    // 界面只用这三档：仍在列表 / 已不在列表（含未判定）
    expect(stats.listed).toBe(1);
    expect(stats.gone).toBe(2);
    expect(stats.pendingProbe).toBe(0);
  });

  it("空数组不会崩", () => {
    expect(buildInteractionStats([]).total).toBe(0);
  });
});

describe("queryInteractions", () => {
  const items = [
    makeItem("like", "BV1aa411c7m0", {
      title: "原神攻略",
      authorName: "甲",
      firstSeenAt: 3000,
      state: "listed",
    }),
    makeItem("coin", "BV1bb411c7m1", {
      title: "剪辑教程",
      authorName: "乙",
      firstSeenAt: 2000,
      firstTitle: "旧标题：剪辑入门",
      state: "ended",
    }),
    makeItem("like", "BV1cc411c7m2", {
      title: "无关内容",
      authorName: "丙",
      firstSeenAt: 1000,
      state: "retained",
    }),
  ];

  it("默认按日期（卡片上那一格）倒序", () => {
    const result = queryInteractions({ items });
    // 三条的 interactedAt 都是 1_600_000_000_000（工厂默认值：点赞没有真实时间），
    // 于是三级判据一路走到 bvid。倒序把三级一起反转，所以并列项按 bvid 从大到小。
    expect(result.map((item) => item.bvid)).toEqual([
      "BV1cc411c7m2",
      "BV1bb411c7m1",
      "BV1aa411c7m0",
    ]);
  });

  it("日期并列时按接口给的列表名次排先后", () => {
    const sameTime = items.map((item) => ({ ...item, interactedAt: 5000 }));
    // 名次 0 最新。刻意把数组顺序打乱，验证排序真的用了 listRank
    const shuffled = [
      { ...sameTime[1], listRank: 2 },
      { ...sameTime[0], listRank: 0 },
      { ...sameTime[2], listRank: 1 },
    ];
    const result = queryInteractions({ items: shuffled });
    // 日期并列 → 比名次；名次越小越新，所以 0 → 1 → 2。
    // 按输入顺序本会是 2,0,1，所以这条断言确实在验证 listRank 参与了比较。
    expect(result.map((item) => item.listRank)).toEqual([0, 1, 2]);
  });

  it("日期与名次都并列时退回 bvid 字典序，排序结果永远确定", () => {
    const sameTime = items.map((item) => ({ ...item, interactedAt: 5000, listRank: 0 }));
    const result = queryInteractions({ items: sameTime });
    // 三条 bvid 只差最后一位。没有这一级，并列元素的次序就取决于输入顺序，
    // 每次打开看到的排列都可能不同。倒序下三级一起反转，因此是 cc → bb → aa。
    expect(result.map((item) => item.bvid)).toEqual([
      "BV1cc411c7m2",
      "BV1bb411c7m1",
      "BV1aa411c7m0",
    ]);
    // 打乱输入顺序也得到同一个结果 —— 这才是"永远确定"的含义
    expect(queryInteractions({ items: [...sameTime].reverse() }).map((item) => item.bvid)).toEqual(
      result.map((item) => item.bvid),
    );
  });

  it("首轮基线（日期全相同）按 listRank 正序——rank 0 是最新的，必须排最前", () => {
    // 这是真实用户报告的问题：20 条点赞都被标「早期」，interactedAt 完全相同，
    // 于是整个顺序完全由 listRank 决定。而 B 站那份列表**本身就是按互动时间倒序**的，
    // 所以 rank 小的更新、必须排前面。曾经为了"两个方向严格互为逆序"把 rank 也反转，
    // 结果是这一屏的次序刚好跟 B 站列表相反，用户一眼就看出不对。
    const baseline = [
      makeItem("like", "BV1aa411c7m0", { interactedAt: 5000, listRank: 0 }),
      makeItem("like", "BV1bb411c7m1", { interactedAt: 5000, listRank: 1 }),
      makeItem("like", "BV1cc411c7m2", { interactedAt: 5000, listRank: 2 }),
    ];
    expect(
      queryInteractions({ items: baseline, sort: "date_desc" }).map((item) => item.listRank),
    ).toEqual([0, 1, 2]);
    // 旧的→新方向同样按 rank 正序，只是把整批"早期"记录整体放到另一头
    expect(
      queryInteractions({ items: baseline, sort: "date_asc" }).map((item) => item.listRank),
    ).toEqual([0, 1, 2]);
  });

  it("日期旧→新是日期新→旧的严格逆序", () => {
    const desc = queryInteractions({ items, sort: "date_desc" }).map((item) => item.bvid);
    const asc = queryInteractions({ items, sort: "date_asc" }).map((item) => item.bvid);
    expect(asc).toEqual([...desc].reverse());
  });

  it("时间或名次是非法值（导入的老数据）时仍给出确定顺序", () => {
    // WebDAV / 备份导入的记录是原样落库的，可能缺 interactedAt 或者是 NaN。
    // 这类值如果不规整，a<b 与 b<a 会同时为 false，比较函数就不再是反对称的，
    // 排序结果会随输入顺序变化 —— 那正是这个模块注释里承诺不会发生的事。
    const brokenTime = [
      makeItem("like", "BV1aa411c7m0", { interactedAt: Number.NaN }),
      makeItem("like", "BV1bb411c7m1", { interactedAt: 2000 }),
      makeItem("like", "BV1cc411c7m2", { interactedAt: 999 }),
    ];
    const byTime = queryInteractions({ items: brokenTime }).map((item) => item.bvid);
    // 有效值之间保持"新的在前"，未知时间沉底，且与输入顺序无关
    expect(byTime).toEqual(["BV1bb411c7m1", "BV1cc411c7m2", "BV1aa411c7m0"]);
    expect(
      queryInteractions({ items: [...brokenTime].reverse() }).map((item) => item.bvid),
    ).toEqual(byTime);

    const brokenRank = [
      makeItem("like", "BV1aa411c7m0", { listRank: Number.NaN }),
      makeItem("like", "BV1bb411c7m1", { listRank: 1 }),
      makeItem("like", "BV1cc411c7m2", { listRank: 0 }),
    ];
    const byRank = queryInteractions({ items: brokenRank }).map((item) => item.bvid);
    // 日期并列（都是工厂默认值）→ 比名次，名次一律正序（越小越新）：
    // cc(0) → bb(1) → aa(NaN 当成未知，沉底)。
    expect(byRank).toEqual(["BV1cc411c7m2", "BV1bb411c7m1", "BV1aa411c7m0"]);
    expect(
      queryInteractions({ items: [...brokenRank].reverse() }).map((item) => item.bvid),
    ).toEqual(byRank);
  });

  it("按类型筛选", () => {
    expect(queryInteractions({ items, type: "coin" })).toHaveLength(1);
    expect(queryInteractions({ items, type: "like" })).toHaveLength(2);
  });

  it("按状态筛选只有三档：全部 / 仍在列表 / 已不在列表", () => {
    // 内部状态有六个取值，界面只暴露两档；精确原因由卡片徽章表达
    expect(queryInteractions({ items, state: "listed" }).map((item) => item.bvid)).toEqual([
      "BV1aa411c7m0",
    ]);
    // 命中两条，仍按日期新→旧；两条的日期相同（都是工厂默认值），
    // 于是并列判据把 bvid 大的排前面，得到 cc → bb
    expect(queryInteractions({ items, state: "gone" }).map((item) => item.bvid)).toEqual([
      "BV1cc411c7m2",
      "BV1bb411c7m1",
    ]);
    expect(queryInteractions({ items, state: "all" })).toHaveLength(3);
  });

  it("搜索能命中首次记录标题（稿件改名后仍搜得到）", () => {
    const result = queryInteractions({ items, keyword: "剪辑入门" });
    expect(result.map((item) => item.bvid)).toEqual(["BV1bb411c7m1"]);
  });

  it("搜索能命中 UP 主与 BV 号", () => {
    expect(queryInteractions({ items, keyword: "乙" })).toHaveLength(1);
    expect(queryInteractions({ items, keyword: "bv1aa" })).toHaveLength(1);
  });

  it("时长排序：按时长分组，时长未知的条目一律沉底", () => {
    // 两条有时长（300 / 60），两条拿不到时长（0）。两条未知的 duration 相同，
    // 于是内部再按日期新→旧并列判据（它们 date 也相同，最后落到 bvid 倒序）。
    const byDuration = [
      makeItem("like", "BV1aa411c7m0", { duration: 300 }),
      makeItem("like", "BV1bb411c7m1", { duration: 60 }),
      makeItem("like", "BV1cc411c7m2", { duration: 0 }),
      makeItem("like", "BV1dd411c7m3", { duration: 0 }),
    ];
    expect(
      queryInteractions({ items: byDuration, sort: "duration_desc" }).map((item) => item.bvid),
    ).toEqual(["BV1aa411c7m0", "BV1bb411c7m1", "BV1dd411c7m3", "BV1cc411c7m2"]);
    // 两种方向下未知时长都在末尾：它不参与"最长/最短"的竞争
    expect(
      queryInteractions({ items: byDuration, sort: "duration_asc" }).map((item) => item.bvid),
    ).toEqual(["BV1bb411c7m1", "BV1aa411c7m0", "BV1dd411c7m3", "BV1cc411c7m2"]);
  });

  it("时长全部相等时按日期新→旧收尾，不跟着升降序翻转", () => {
    const sameDuration = [
      makeItem("like", "BV1aa411c7m0", { duration: 100, interactedAt: 1000 }),
      makeItem("like", "BV1bb411c7m1", { duration: 100, interactedAt: 3000 }),
      makeItem("like", "BV1cc411c7m2", { duration: 100, interactedAt: 2000 }),
    ];
    // 两种时长排序下都是"日期新的在前"，切换方向不会把同一批数据的内部次序倒过来
    const expected = ["BV1bb411c7m1", "BV1cc411c7m2", "BV1aa411c7m0"];
    expect(
      queryInteractions({ items: sameDuration, sort: "duration_desc" }).map((item) => item.bvid),
    ).toEqual(expected);
    expect(
      queryInteractions({ items: sameDuration, sort: "duration_asc" }).map((item) => item.bvid),
    ).toEqual(expected);
  });
});

describe("paginateInteractions", () => {
  it("按页切片并给出总页数", () => {
    const items = Array.from({ length: 5 }, (_, index) => makeItem("like", `BV1aa411c7m${index}`));
    const page = paginateInteractions(items, 2, 2);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBe(5);
    expect(page.totalPages).toBe(3);
  });

  it("页码越界时返回空页而不是抛错", () => {
    const page = paginateInteractions([makeItem("like", "BV1aa411c7m0")], 9, 2);
    expect(page.items).toHaveLength(0);
  });
});

describe("展示派生", () => {
  it("点赞只有首次记录时间，投币才有真实投币时间", () => {
    expect(interactionTimeLabel(makeItem("like", "BV1aa411c7m0"))).toBe("首次记录时间");
    expect(interactionTimeLabel(makeItem("coin", "BV1bb411c7m1"))).toBe("投币时间");
    // 投币但接口没给时间时也不能谎称投币时间
    expect(
      interactionTimeLabel(makeItem("coin", "BV1bb411c7m1", { interactedAtExact: false })),
    ).toBe("首次记录时间");
  });

  it("只有稿件查不到时才加删除线：取消点赞不算", () => {
    const of = (state: InteractionItem["state"]) =>
      isInteractionContentGone(makeItem("like", "BV1aa411c7m0", { state }));

    // 稿件还能正常打开 → 不能加删除线
    expect(of("listed")).toBe(false);
    expect(of("retained")).toBe(false); // 赞还在，只是 B 站不展示了
    expect(of("unlisted")).toBe(false); // 还没核查出结果，不能当成失效
    expect(of("ended")).toBe(false); // 取消点赞：稿件好端端的，加删除线等于谎称内容失效

    // 稿件本身查不到了
    expect(of("content_deleted")).toBe(true);
    expect(of("content_hidden")).toBe(true);
  });

  it("时长格式化补齐前导零", () => {
    expect(formatInteractionDuration(0)).toBe("");
    expect(formatInteractionDuration(65)).toBe("1:05");
    expect(formatInteractionDuration(3661)).toBe("1:01:01");
  });
});

describe("formatInteractionTime：三天内相对，其余绝对", () => {
  const NOW = new Date(2026, 9, 13, 23, 0, 0).getTime(); // 2026-10-13 23:00 本地时间
  const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

  it("今天 / 昨天 / 前天 / N 天前", () => {
    expect(formatInteractionTime(at(2026, 10, 13, 20), NOW)).toBe("今天");
    expect(formatInteractionTime(at(2026, 10, 12), NOW)).toBe("昨天");
    expect(formatInteractionTime(at(2026, 10, 11), NOW)).toBe("前天");
    expect(formatInteractionTime(at(2026, 10, 10), NOW)).toBe("3 天前");
  });

  it("超过三天显示绝对日期，同年只给 M/D", () => {
    expect(formatInteractionTime(at(2026, 10, 9), NOW)).toBe("10/9");
    expect(formatInteractionTime(at(2026, 8, 14), NOW)).toBe("8/14");
  });

  it("跨年补上年份", () => {
    expect(formatInteractionTime(at(2025, 12, 31), NOW)).toBe("2025/12/31");
  });

  it("没有时间时返回空串", () => {
    expect(formatInteractionTime(0, NOW)).toBe("");
  });
});

describe("buildInteractionDetail：日期与悬停说明", () => {
  const NOW = new Date(2026, 9, 13, 23, 0, 0).getTime();

  it("日期用完整日期，与收藏页一致", () => {
    const detail = buildInteractionDetail(
      makeItem("coin", "BV1bb411c7m1", {
        coins: 1,
        interactedAtExact: true,
        interactedAt: new Date(2026, 9, 10, 20, 44).getTime(),
      }),
      NOW,
    );
    expect(detail.date).toBe("2026/10/10");
  });

  it("相对说法只出现在悬停说明里", () => {
    const detail = buildInteractionDetail(
      makeItem("coin", "BV1bb411c7m1", {
        interactedAtExact: true,
        interactedAt: new Date(2026, 9, 10, 20, 44).getTime(),
      }),
      NOW,
    );
    expect(detail.title).toContain("2026/10/10 20:44");
    expect(detail.title).toContain("3 天前");
    expect(detail.title).toContain("B 站接口提供");
  });

  it("首轮抓到的点赞标「早期」，不把同步那天伪装成点赞日期", () => {
    const baseline = buildInteractionDetail(
      makeItem("like", "BV1aa411c7m0", {
        caughtInBaseline: true,
        firstSeenAt: new Date(2026, 9, 14, 13, 5, 0).getTime(),
      }),
      NOW,
    );
    // 卡片上只有「早期」两个字。观测时刻**不上卡片**（评审结论）：
    // 它不是点赞时间，摆到主位容易被读成"点赞日期"。
    expect(baseline.date).toBe("早期");
    // 但悬停里要把观测时刻给出来，并写清那是观测时刻
    expect(baseline.title).toContain("加入插件之前");
    expect(baseline.title).toContain("2026/10/14 13:05");
    expect(baseline.title).toContain("观测时刻");
  });

  it("之后才出现的点赞显示本地首次记录日期，悬停说明来源", () => {
    const later = buildInteractionDetail(
      makeItem("like", "BV1aa411c7m0", {
        firstSeenAt: new Date(2026, 8, 2, 10, 0).getTime(),
      }),
      NOW,
    );
    expect(later.date).toBe("2026/9/2");
    expect(later.title).toContain("B 站不提供点赞时间");
  });

  it("不区分投了几枚：投 2 枚与投 1 枚的显示完全一样", () => {
    const at = new Date(2026, 9, 10, 20, 44).getTime();
    const one = buildInteractionDetail(
      makeItem("coin", "BV1bb411c7m1", { coins: 1, interactedAtExact: true, interactedAt: at }),
      NOW,
    );
    const two = buildInteractionDetail(
      makeItem("coin", "BV1bb411c7m1", { coins: 2, interactedAtExact: true, interactedAt: at }),
      NOW,
    );
    expect(two.date).toBe("2026/10/10");
    expect(two.date).toBe(one.date);
    // 悬停说明里也不再提枚数
    expect(two.title).not.toContain("×2");
  });

  it("投币接口没给时间时用本地首次记录时间", () => {
    const detail = buildInteractionDetail(
      makeItem("coin", "BV1bb411c7m1", {
        interactedAtExact: false,
        firstSeenAt: new Date(2026, 8, 1, 10, 0).getTime(),
      }),
      NOW,
    );
    expect(detail.date).toBe("2026/9/1");
    expect(detail.title).toContain("接口没有返回");
  });

  it("首轮抓到的投币仍然显示真实投币时间（接口给了就不该藏）", () => {
    const detail = buildInteractionDetail(
      makeItem("coin", "BV1bb411c7m1", {
        caughtInBaseline: true,
        interactedAtExact: true,
        interactedAt: new Date(2026, 9, 12, 9, 0).getTime(),
      }),
      NOW,
    );
    expect(detail.date).toBe("2026/10/12");
  });
});

