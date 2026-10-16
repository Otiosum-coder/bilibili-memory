import { describe, expect, it } from "vitest";
import { FollowingRequestError, type FollowingPageResult } from "./followingApi";
import type { RawFollowingEntry } from "./followingDiff";
import {
  runFollowingSync,
  shouldRunFollowingSync,
  type FollowingSyncDeps,
  type FollowingSyncProgress,
} from "./followingSync";
import type { FollowingEvent, FollowingItem } from "./types";

const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;

const rawEntry = (mid: number, uname = `UP_${mid}`): RawFollowingEntry => ({ mid, uname });

const makePage = (mids: number[], total: number): FollowingPageResult => ({
  list: mids.map((mid) => rawEntry(mid)),
  total,
});

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
  lastSeenAt: NOW - DAY_MS,
  lastSeenInSyncAt: NOW - DAY_MS,
  nameHistory: [{ name: `UP_${mid}`, seenAt: NOW - DAY_MS }],
  ...patch,
});

interface Harness {
  deps: FollowingSyncDeps;
  persisted: Array<{ next: FollowingItem[]; events: FollowingEvent[] }>;
  progress: FollowingSyncProgress[];
  delays: number[];
  isBaseline: () => boolean;
  setExisting: (items: FollowingItem[]) => void;
  setBaseline: (value: boolean) => void;
}

const makeHarness = (pages: Record<number, FollowingPageResult>): Harness => {
  const persisted: Array<{ next: FollowingItem[]; events: FollowingEvent[] }> = [];
  const progress: FollowingSyncProgress[] = [];
  const delays: number[] = [];
  let existing: FollowingItem[] = [];
  let baseline = false;

  const deps: FollowingSyncDeps = {
    fetchPage: async (page) => {
      const result = pages[page];
      if (!result) throw new Error(`测试未配置第 ${page} 页`);
      return result;
    },
    loadExisting: async () => existing,
    persist: async (next, events) => {
      persisted.push({ next, events });
    },
    hasBaseline: async () => baseline,
    markBaseline: async () => {
      baseline = true;
    },
    saveProgress: async (value) => {
      progress.push(value);
    },
    now: () => NOW,
    delay: async (ms) => {
      delays.push(ms);
    },
  };

  return {
    deps,
    persisted,
    progress,
    delays,
    isBaseline: () => baseline,
    setExisting: (items) => {
      existing = items;
    },
    setBaseline: (value) => {
      baseline = value;
    },
  };
};

describe("runFollowingSync - 完整性与基线", () => {
  it("收齐接口声明的 total 条 → 完整，且首次同步建立基线", async () => {
    const h = makeHarness({ 1: makePage([1, 2], 4), 2: makePage([3, 4], 4) });

    const outcome = await runFollowingSync(h.deps, { pageSize: 2 });

    expect(outcome.status).toBe("completed");
    expect(outcome.fullScanCompleted).toBe(true);
    expect(outcome.pagesFetched).toBe(2);
    expect(outcome.fetchedCount).toBe(4);
    expect(outcome.baselineEstablished).toBe(true);
    expect(h.isBaseline()).toBe(true);
    // 首次基线不产事件
    expect(outcome.eventsCreated).toBe(0);
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0].events).toEqual([]);
  });

  it("末页不满 → 判定为完整（不依赖 total 是否精确）", async () => {
    const h = makeHarness({
      1: makePage([1, 2], 5),
      2: makePage([3, 4], 5),
      3: makePage([5], 5),
    });

    const outcome = await runFollowingSync(h.deps, { pageSize: 2 });

    expect(outcome.fullScanCompleted).toBe(true);
    expect(outcome.pagesFetched).toBe(3);
    expect(outcome.fetchedCount).toBe(5);
  });

  it("total 为 0（没有关注任何人）→ 视为完整", async () => {
    const h = makeHarness({ 1: makePage([], 0) });

    const outcome = await runFollowingSync(h.deps, { pageSize: 2 });

    expect(outcome.fullScanCompleted).toBe(true);
    expect(outcome.baselineEstablished).toBe(true);
    expect(outcome.fetchedCount).toBe(0);
  });

  it("超过单次页数上限 → 标记不完整，且**不建立基线**", async () => {
    const h = makeHarness({ 1: makePage([1, 2], 10), 2: makePage([3, 4], 10) });

    const outcome = await runFollowingSync(h.deps, { pageSize: 2, maxPages: 2 });

    expect(outcome.status).toBe("incomplete");
    expect(outcome.fullScanCompleted).toBe(false);
    expect(outcome.baselineEstablished).toBe(false);
    expect(h.isBaseline()).toBe(false);
    expect(outcome.error).toContain("上限");
  });

  it("已有基线时不重复建立", async () => {
    const h = makeHarness({ 1: makePage([1, 2], 2) });
    h.setBaseline(true);

    const outcome = await runFollowingSync(h.deps, { pageSize: 2 });

    expect(outcome.fullScanCompleted).toBe(true);
    expect(outcome.baselineEstablished).toBe(false);
  });
});

describe("runFollowingSync - 故障处理", () => {
  it("风控错误 → status rate_limited，不建立基线，但已取到的页面仍然写入", async () => {
    const h = makeHarness({ 1: makePage([1, 2], 10) });
    h.deps.fetchPage = async (page) => {
      if (page === 1) return makePage([1, 2], 10);
      throw new FollowingRequestError("触发访问风控", "rate_limited", 412);
    };

    const outcome = await runFollowingSync(h.deps, { pageSize: 2 });

    expect(outcome.status).toBe("rate_limited");
    expect(outcome.fullScanCompleted).toBe(false);
    expect(h.isBaseline()).toBe(false);
    // 第一页的数据仍然落库，只是不做取关判定
    expect(h.persisted).toHaveLength(1);
    expect(h.persisted[0].next.map((item) => item.mid).sort()).toEqual([1, 2]);
  });

  it("鉴权失败 → status auth_invalid", async () => {
    const h = makeHarness({});
    h.deps.fetchPage = async () => {
      throw new FollowingRequestError("未登录", "auth");
    };

    const outcome = await runFollowingSync(h.deps, { pageSize: 2 });

    expect(outcome.status).toBe("auth_invalid");
    expect(outcome.fetchedCount).toBe(0);
  });

  it("一条都没取到且失败 → 不回写整张表，但仍记录进度", async () => {
    const h = makeHarness({});
    h.setExisting([makeItem(1)]);
    h.deps.fetchPage = async () => {
      throw new FollowingRequestError("网络断了", "network");
    };

    const outcome = await runFollowingSync(h.deps, { pageSize: 2 });

    expect(outcome.status).toBe("failed");
    expect(h.persisted).toHaveLength(0);
    expect(h.progress).toHaveLength(1);
    expect(h.progress[0].status).toBe("failed");
    expect(h.progress[0].lastErrorKind).toBe("network");
  });
});

describe("runFollowingSync - 与判定逻辑的集成", () => {
  it("完整扫描后缺失的人被判为已取关", async () => {
    const h = makeHarness({ 1: makePage([1, 2], 2) });
    h.setBaseline(true);
    h.setExisting([makeItem(1), makeItem(2), makeItem(99)]);

    const outcome = await runFollowingSync(h.deps, { pageSize: 2 });

    expect(outcome.fullScanCompleted).toBe(true);
    expect(h.persisted[0].events).toHaveLength(1);
    expect(h.persisted[0].events[0].type).toBe("unfollowed");
    expect(h.persisted[0].events[0].mid).toBe(99);
  });

  it("关键负例：未完整扫描时绝不产生取关事件", async () => {
    // 10 条关注，但单次只允许抓 1 页，于是 99 没被扫到
    const h = makeHarness({ 1: makePage([1, 2], 10) });
    h.setBaseline(true);
    h.setExisting([makeItem(1), makeItem(2), makeItem(99)]);

    const outcome = await runFollowingSync(h.deps, { pageSize: 2, maxPages: 1 });

    expect(outcome.fullScanCompleted).toBe(false);
    expect(h.persisted[0].events).toEqual([]);
    const kept = h.persisted[0].next.find((item) => item.mid === 99);
    expect(kept?.status).toBe("following");
  });

  it("改名会被记录", async () => {
    const h = makeHarness({ 1: { list: [rawEntry(1, "改了名")], total: 1 } });
    h.setBaseline(true);
    h.setExisting([makeItem(1, { name: "原名" })]);

    const outcome = await runFollowingSync(h.deps, { pageSize: 2 });

    expect(outcome.eventsCreated).toBe(1);
    expect(h.persisted[0].events[0].type).toBe("renamed");
    expect(h.persisted[0].events[0].previous_name).toBe("原名");
  });
});

describe("runFollowingSync - 翻页节奏", () => {
  it("页间有延迟，末页之后不再延迟", async () => {
    const h = makeHarness({
      1: makePage([1, 2], 5),
      2: makePage([3, 4], 5),
      3: makePage([5], 5),
    });

    await runFollowingSync(h.deps, { pageSize: 2, pageDelayMs: 123 });

    // 3 页之间只有 2 次间隔
    expect(h.delays).toEqual([123, 123]);
  });
});

describe("shouldRunFollowingSync", () => {
  it("关闭时永不运行", () => {
    expect(
      shouldRunFollowingSync({ enabled: false, intervalMinutes: 1, lastSyncAt: null, now: NOW }),
    ).toBe(false);
  });

  it("从未同步过时运行", () => {
    expect(
      shouldRunFollowingSync({ enabled: true, intervalMinutes: 1440, lastSyncAt: null, now: NOW }),
    ).toBe(true);
  });

  it("未到间隔时不运行，到点后运行", () => {
    const lastSyncAt = NOW - 10 * 60 * 1000;
    expect(
      shouldRunFollowingSync({ enabled: true, intervalMinutes: 1440, lastSyncAt, now: NOW }),
    ).toBe(false);
    expect(
      shouldRunFollowingSync({
        enabled: true,
        intervalMinutes: 5,
        lastSyncAt,
        now: NOW,
      }),
    ).toBe(true);
  });

  it("间隔为 0 视为每次都跑", () => {
    expect(
      shouldRunFollowingSync({
        enabled: true,
        intervalMinutes: 0,
        lastSyncAt: NOW,
        now: NOW,
      }),
    ).toBe(true);
  });
});
