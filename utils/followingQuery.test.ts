import { describe, expect, it } from "vitest";
import {
  buildFollowingStats,
  buildLocalNameTimeline,
  buildThirdPartyNames,
  followTimeOf,
  hasFormerNames,
  paginateFollowing,
  queryFollowing,
  resolveDisplayName,
  resolveDisplayNameInfo,
} from "./followingQuery";
import type { FollowingItem } from "./types";

const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;

const makeItem = (mid: number, patch: Partial<FollowingItem> = {}): FollowingItem => ({
  mid,
  name: `UP_${mid}`,
  face: "",
  sign: "",
  mtime: Math.floor((NOW - DAY_MS) / 1000),
  attribute: 2,
  special: 0,
  status: "following",
  firstSeenAt: NOW - DAY_MS,
  lastSeenAt: NOW,
  lastSeenInSyncAt: NOW,
  nameHistory: [{ name: `UP_${mid}`, seenAt: NOW - DAY_MS }],
  ...patch,
});

describe("resolveDisplayName", () => {
  it("有真实名字时用真名", () => {
    expect(resolveDisplayName(makeItem(1, { name: "讲宏观的猴子" }))).toBe("讲宏观的猴子");
  });

  it("名字为空时兜底为 UID，绝不渲染空字符串", () => {
    expect(resolveDisplayName(makeItem(123, { name: "" }))).toBe("UID 123（名字未知）");
  });

  it("名字是占位文案时同样兜底", () => {
    expect(resolveDisplayName(makeItem(456, { name: "账号已注销" }))).toBe("UID 456（名字未知）");
  });
});

describe("resolveDisplayNameInfo", () => {
  it("没有真实名字时用第三方存档最后一个名字兜底，并标记 inferred", () => {
    const item = makeItem(789, { name: "账号已注销", thirdPartyNames: ["旧名A", "旧名B"] });
    expect(resolveDisplayNameInfo(item)).toEqual({
      name: "旧名B",
      inferred: true,
      candidateCount: 2,
      candidateIndex: 1,
    });
  });

  it("尊重用户手动切换的下标，越界时回退到最后一个", () => {
    const base = makeItem(790, { name: "", thirdPartyNames: ["甲", "乙", "丙"] });
    expect(resolveDisplayNameInfo({ ...base, formerNameDisplayIndex: 0 }).name).toBe("甲");
    expect(resolveDisplayNameInfo({ ...base, formerNameDisplayIndex: 99 }).name).toBe("丙");
  });

  it("有真实名字时永远优先真名，不用第三方存档", () => {
    const info = resolveDisplayNameInfo(
      makeItem(1, { name: "真名", thirdPartyNames: ["旧名"] }),
    );
    expect(info.name).toBe("真名");
    expect(info.inferred).toBe(false);
  });
});

describe("buildFollowingStats", () => {
  it("按状态分别计数", () => {
    const stats = buildFollowingStats([
      makeItem(1),
      makeItem(2),
      makeItem(3, { status: "unfollowed" }),
      makeItem(4, { status: "gone" }),
      makeItem(5, { status: "gone" }),
    ]);

    expect(stats).toEqual({ total: 5, following: 2, unfollowed: 1, gone: 2 });
  });

  it("空列表返回全 0", () => {
    expect(buildFollowingStats([])).toEqual({ total: 0, following: 0, unfollowed: 0, gone: 0 });
  });
});

describe("queryFollowing - 筛选", () => {
  const items = [
    makeItem(1),
    makeItem(2, { status: "unfollowed" }),
    makeItem(3, { status: "gone" }),
  ];

  it("all 返回全部", () => {
    expect(queryFollowing({ items }).map((item) => item.mid)).toEqual([1, 2, 3]);
  });

  it("following / unfollowed / gone 各自只返回对应状态", () => {
    expect(queryFollowing({ items, filter: "following" }).map((item) => item.mid)).toEqual([1]);
    expect(queryFollowing({ items, filter: "unfollowed" }).map((item) => item.mid)).toEqual([2]);
    expect(queryFollowing({ items, filter: "gone" }).map((item) => item.mid)).toEqual([3]);
  });
});

describe("queryFollowing - 搜索", () => {
  it("命中昵称、UID、签名、认证信息", () => {
    const items = [
      makeItem(111, { name: "讲宏观的猴子" }),
      makeItem(222, { sign: "一个喜欢码代码的人" }),
      makeItem(333, { officialVerifyDesc: "bilibili 知名UP主" }),
    ];

    expect(queryFollowing({ items, keyword: "宏观" }).map((item) => item.mid)).toEqual([111]);
    expect(queryFollowing({ items, keyword: "222" }).map((item) => item.mid)).toEqual([222]);
    expect(queryFollowing({ items, keyword: "码代码" }).map((item) => item.mid)).toEqual([222]);
    expect(queryFollowing({ items, keyword: "知名up主" }).map((item) => item.mid)).toEqual([333]);
  });

  it("命中曾用名 —— 这是核心痛点：记得旧名字也要能搜到人", () => {
    const items = [
      makeItem(1, {
        name: "现在的名字",
        nameHistory: [
          { name: "最早的名字", seenAt: NOW - 3 * DAY_MS },
          { name: "中间的名字", seenAt: NOW - 2 * DAY_MS },
          { name: "现在的名字", seenAt: NOW },
        ],
      }),
    ];

    expect(queryFollowing({ items, keyword: "中间的名字" }).map((item) => item.mid)).toEqual([1]);
    expect(queryFollowing({ items, keyword: "最早" }).map((item) => item.mid)).toEqual([1]);
  });

  it("命中第三方存档的曾用名", () => {
    const items = [makeItem(1, { thirdPartyNames: ["咕噜大魔王", "王册大魔王"] })];

    expect(queryFollowing({ items, keyword: "咕噜" }).map((item) => item.mid)).toEqual([1]);
  });

  it("关键词为空时不过滤", () => {
    const items = [makeItem(1), makeItem(2)];
    expect(queryFollowing({ items, keyword: "   " })).toHaveLength(2);
  });
});

describe("queryFollowing - 排序", () => {
  it("按关注时间倒序（默认）与升序", () => {
    const items = [
      makeItem(1, { mtime: 100 }),
      makeItem(2, { mtime: 300 }),
      makeItem(3, { mtime: 200 }),
    ];

    expect(queryFollowing({ items }).map((item) => item.mid)).toEqual([2, 3, 1]);
    expect(queryFollowing({ items, sort: "followed_asc" }).map((item) => item.mid)).toEqual([
      1, 3, 2,
    ]);
  });

  it("mtime 缺失时回退到首次观测时间", () => {
    const items = [
      makeItem(1, { mtime: 0, firstSeenAt: NOW - 5 * DAY_MS }),
      makeItem(2, { mtime: 0, firstSeenAt: NOW }),
    ];

    expect(queryFollowing({ items, sort: "followed_desc" }).map((item) => item.mid)).toEqual([2, 1]);
    expect(followTimeOf(items[0])).toBe(NOW - 5 * DAY_MS);
  });

  it("按 UID 升降序", () => {
    const items = [makeItem(30), makeItem(10), makeItem(20)];
    expect(queryFollowing({ items, sort: "uid_asc" }).map((item) => item.mid)).toEqual([10, 20, 30]);
    expect(queryFollowing({ items, sort: "uid_desc" }).map((item) => item.mid)).toEqual([
      30, 20, 10,
    ]);
  });

  it("按名字升序", () => {
    const items = [
      makeItem(1, { name: "charlie" }),
      makeItem(2, { name: "alpha" }),
      makeItem(3, { name: "bravo" }),
    ];
    expect(queryFollowing({ items, sort: "name_asc" }).map((item) => item.mid)).toEqual([2, 3, 1]);
  });

  it("搜索与筛选可以叠加", () => {
    const items = [
      makeItem(1, { name: "alpha" }),
      makeItem(2, { name: "alpha", status: "unfollowed" }),
    ];
    const result = queryFollowing({ items, keyword: "alpha", filter: "following" });
    expect(result.map((item) => item.mid)).toEqual([1]);
  });
});

describe("paginateFollowing", () => {
  const items = Array.from({ length: 25 }, (_, index) => index + 1);

  it("按页切分并给出总页数", () => {
    const page = paginateFollowing(items, 2, 10);
    expect(page.items).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(page.total).toBe(25);
    expect(page.totalPages).toBe(3);
  });

  it("页码越界时被夹到合法范围", () => {
    expect(paginateFollowing(items, 0, 10).page).toBe(1);
    expect(paginateFollowing(items, -3, 10).page).toBe(1);
  });

  it("空列表至少有一页", () => {
    const page = paginateFollowing([], 1, 10);
    expect(page.totalPages).toBe(1);
    expect(page.items).toEqual([]);
  });
});

describe("buildLocalNameTimeline", () => {
  it("倒序返回，并用相邻两条推导区间", () => {
    const item = makeItem(1, {
      name: "现在的名字",
      nameHistory: [
        { name: "最早", seenAt: NOW - 10 * DAY_MS },
        { name: "中间", seenAt: NOW - 5 * DAY_MS },
        { name: "现在的名字", seenAt: NOW },
      ],
    });

    const timeline = buildLocalNameTimeline(item);

    expect(timeline.map((segment) => segment.name)).toEqual(["现在的名字", "中间", "最早"]);
    expect(timeline[0]).toEqual({
      name: "现在的名字",
      from: NOW,
      isCurrent: true,
    });
    expect(timeline[1]).toEqual({
      name: "中间",
      from: NOW - 5 * DAY_MS,
      to: NOW,
      isCurrent: false,
    });
    expect(timeline[2].to).toBe(NOW - 5 * DAY_MS);
  });

  it("只有一条记录（从未改名）时是单段且为当前名", () => {
    const timeline = buildLocalNameTimeline(makeItem(1, { name: "UP_1" }));
    expect(timeline).toHaveLength(1);
    expect(timeline[0].isCurrent).toBe(true);
    expect(timeline[0].to).toBeUndefined();
  });

  it("没有历史时返回空数组", () => {
    expect(buildLocalNameTimeline(makeItem(1, { name: "", nameHistory: [] }))).toEqual([]);
  });
});

describe("buildThirdPartyNames", () => {
  it("过滤占位文案、空白与重复项", () => {
    const item = makeItem(1, {
      thirdPartyNames: ["咕噜大魔王", "账号已注销", "  ", "咕噜大魔王", "王册大魔王"],
    });

    expect(buildThirdPartyNames(item)).toEqual(["咕噜大魔王", "王册大魔王"]);
  });

  it("没有第三方数据时返回空数组", () => {
    expect(buildThirdPartyNames(makeItem(1))).toEqual([]);
  });
});

describe("hasFormerNames", () => {
  it("本地改过名时为 true", () => {
    const item = makeItem(1, {
      nameHistory: [
        { name: "旧", seenAt: NOW - DAY_MS },
        { name: "新", seenAt: NOW },
      ],
    });
    expect(hasFormerNames(item)).toBe(true);
  });

  it("只有一条本地记录且无第三方数据时为 false", () => {
    expect(hasFormerNames(makeItem(1))).toBe(false);
  });

  it("仅有第三方曾用名时也为 true", () => {
    expect(hasFormerNames(makeItem(1, { thirdPartyNames: ["旧名"] }))).toBe(true);
  });

  it("第三方数据全是占位文案时不算有曾用名", () => {
    expect(hasFormerNames(makeItem(1, { thirdPartyNames: ["账号已注销"] }))).toBe(false);
  });
});
