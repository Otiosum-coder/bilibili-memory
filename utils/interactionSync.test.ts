import { describe, expect, it } from "vitest";
import { InteractionRequestError } from "./interactionApi";
import { interactionKey, type InteractionProbeResult } from "./interactionDiff";
import {
  DEFAULT_INTERACTION_PROBE_DELAY_MS,
  runInteractionSync,
  shouldRunInteractionSync,
  type InteractionSyncDeps,
  type InteractionSyncProgress,
} from "./interactionSync";
import type { InteractionItem, InteractionType, RawInteractionEntry } from "./types";

const NOW = 1_700_000_000_000;

const raw = (bvid: string): RawInteractionEntry => ({
  bvid,
  title: `标题 ${bvid}`,
  pic: "https://i0.hdslb.com/bfs/archive/a.jpg",
  duration: 100,
  pubdate: 1_600_000_000,
  owner: { mid: 1, name: "UP" },
});

const makeItem = (bvid: string, overrides: Partial<InteractionItem> = {}): InteractionItem => ({
  id: interactionKey("like", bvid),
  type: "like",
  bvid,
  title: `标题 ${bvid}`,
  firstTitle: `标题 ${bvid}`,
  cover: "https://i0.hdslb.com/bfs/archive/a.jpg",
  duration: 100,
  authorName: "UP",
  authorMid: 1,
  pubdate: 1_600_000_000,
  interactedAt: NOW - 10_000,
  interactedAtExact: false,
  state: "listed",
  firstSeenAt: NOW - 10_000,
  lastSeenAt: NOW - 10_000,
  lastSeenOnlineAt: NOW - 10_000,
  ...overrides,
});

interface Harness {
  deps: InteractionSyncDeps;
  persisted: InteractionItem[][];
  probes: string[];
  fetchedPages: number[];
  delays: number[];
  progress: InteractionSyncProgress[];
  /** 首次同步标记是否已被写入 */
  firstSyncMarked: boolean;
}

const makeHarness = (config: {
  pages: RawInteractionEntry[][];
  existing: Partial<Record<InteractionType, InteractionItem[]>>;
  probeResult?: (item: InteractionItem) => InteractionProbeResult;
  fetchError?: Error;
}): Harness => {
  const persisted: InteractionItem[][] = [];
  const probes: string[] = [];
  const fetchedPages: number[] = [];
  const delays: number[] = [];
  const progress: InteractionSyncProgress[] = [];
  // 默认当作"已经同步过"，避免所有既有用例都被当成首轮；需要验证首轮的用例自行覆盖
  let firstSyncMarked = true;

  const deps: InteractionSyncDeps = {
    fetchPage: async (_type, page) => {
      fetchedPages.push(page);
      if (config.fetchError) throw config.fetchError;
      return { items: config.pages[page - 1] ?? [] };
    },
    loadExisting: async (type) => config.existing[type] ?? [],
    persist: async (items) => {
      persisted.push(items);
    },
    probe: async (item) => {
      probes.push(item.id);
      return (
        config.probeResult?.(item) ?? { content: "ok", retained: true }
      );
    },
    saveProgress: async (value) => {
      progress.push(value);
    },
    hasFirstSync: async () => firstSyncMarked,
    markFirstSync: async () => {
      firstSyncMarked = true;
    },
    now: () => NOW,
    delay: async (ms) => {
      delays.push(ms);
    },
  };

  return {
    deps,
    persisted,
    probes,
    fetchedPages,
    delays,
    progress,
    get firstSyncMarked() {
      return firstSyncMarked;
    },
    set firstSyncMarked(value: boolean) {
      firstSyncMarked = value;
    },
  };
};

describe("runInteractionSync 翻页", () => {
  it("本页不满 pageSize 视为抓完", async () => {
    const harness = makeHarness({ pages: [[raw("BV1xx411c7mD")]], existing: {} });
    const outcome = await runInteractionSync(harness.deps, { pageSize: 20 }, ["like"]);
    expect(harness.fetchedPages).toEqual([1]);
    expect(outcome.types[0].scanCompleted).toBe(true);
    expect(outcome.types[0].fetchedCount).toBe(1);
    expect(outcome.types[0].added).toBe(1);
    expect(outcome.status).toBe("completed");
  });

  it("第二页与第一页完全重复时停止翻页（实测接口忽略 pn 的表现）", async () => {
    const page = Array.from({ length: 20 }, (_, index) => raw(`BV1xx411c7m${index}`));
    const harness = makeHarness({ pages: [page, page], existing: {} });
    const outcome = await runInteractionSync(harness.deps, { pageSize: 20 }, ["like"]);
    expect(harness.fetchedPages).toEqual([1, 2]);
    expect(outcome.types[0].scanCompleted).toBe(true);
    // 重复条目被去重，不会重复入库
    expect(outcome.types[0].added).toBe(20);
  });

  it("页数达到上限时扫描不算完整，因此不做消失判定", async () => {
    const page1 = Array.from({ length: 20 }, (_, index) => raw(`BV1aa411c7m${index}`));
    const page2 = Array.from({ length: 20 }, (_, index) => raw(`BV1bb411c7m${index}`));
    const existing = makeItem("BV1cc411c7mD");
    const harness = makeHarness({ pages: [page1, page2], existing: { like: [existing] } });
    const outcome = await runInteractionSync(
      harness.deps,
      { pageSize: 20, maxPagesPerType: 2 },
      ["like"],
    );
    expect(outcome.types[0].scanCompleted).toBe(false);
    expect(outcome.types[0].unlisted).toBe(0);
    expect(harness.probes).toHaveLength(0);
    const persistedItem = harness.persisted[0].find((item) => item.id === existing.id);
    expect(persistedItem?.state).toBe("listed");
  });

  it("抓取报错时不判定消失，并把错误类型带出来", async () => {
    const existing = makeItem("BV1cc411c7mD");
    const harness = makeHarness({
      pages: [],
      existing: { like: [existing] },
      fetchError: new InteractionRequestError("触发风控", "rate_limited", 412),
    });
    const outcome = await runInteractionSync(harness.deps, { pageSize: 20 }, ["like"]);
    expect(outcome.status).toBe("rate_limited");
    expect(outcome.types[0].status).toBe("rate_limited");
    expect(outcome.types[0].scanCompleted).toBe(false);
    expect(outcome.types[0].unlisted).toBe(0);
  });
});

describe("runInteractionSync 消失判定与探测", () => {
  it("抓完整后不在列表的条目被探测并判定为已结束", async () => {
    const existing = makeItem("BV1cc411c7mD");
    const harness = makeHarness({
      pages: [[]],
      existing: { like: [existing] },
      probeResult: () => ({ content: "ok", retained: false }),
    });
    const outcome = await runInteractionSync(harness.deps, { pageSize: 20 }, ["like"]);
    expect(outcome.types[0].unlisted).toBe(1);
    expect(outcome.types[0].probed).toBe(1);
    expect(outcome.types[0].ended).toBe(1);
    const item = harness.persisted[0].find((entry) => entry.id === existing.id);
    expect(item?.state).toBe("ended");
    expect(item?.endedDetectedAt).toBe(NOW);
  });

  it("探测到互动仍在时标记为 retained —— 这是本地副本独有的信息", async () => {
    const existing = makeItem("BV1cc411c7mD");
    const harness = makeHarness({
      pages: [[]],
      existing: { like: [existing] },
      probeResult: () => ({ content: "ok", retained: true }),
    });
    await runInteractionSync(harness.deps, { pageSize: 20 }, ["like"]);
    expect(harness.persisted[0][0].state).toBe("retained");
  });

  it("探测预算用完时剩下的留到下一轮，且不会被误判", async () => {
    const existing = ["BV1aa411c7m0", "BV1bb411c7m1", "BV1cc411c7m2"].map((bvid) =>
      makeItem(bvid, { lastSeenOnlineAt: NOW - Number(bvid.slice(-1)) * 1000 }),
    );
    const harness = makeHarness({
      pages: [[]],
      existing: { like: existing },
      probeResult: () => ({ content: "ok", retained: true }),
    });
    const outcome = await runInteractionSync(
      harness.deps,
      { pageSize: 20, maxProbesPerRun: 2 },
      ["like"],
    );
    expect(outcome.types[0].probed).toBe(2);
    expect(outcome.types[0].unlisted).toBe(3);
    // 最近还在列表里的两条先探测
    expect(harness.probes).toEqual([
      interactionKey("like", "BV1aa411c7m0"),
      interactionKey("like", "BV1bb411c7m1"),
    ]);
    const untouched = harness.persisted[0].find(
      (item) => item.id === interactionKey("like", "BV1cc411c7m2"),
    );
    expect(untouched?.state).toBe("unlisted");
    expect(untouched?.probeAttemptedAt).toBeUndefined();
  });

  it("探测预算为 0 时只抓不判定（个人主页触发的补充同步就是这么跑的）", async () => {
    const existing = makeItem("BV1cc411c7mD");
    const harness = makeHarness({ pages: [[]], existing: { like: [existing] } });
    const outcome = await runInteractionSync(
      harness.deps,
      { pageSize: 20, maxProbesPerRun: 0, trigger: "page" },
      ["like"],
    );
    expect(harness.probes).toHaveLength(0);
    expect(outcome.types[0].unlisted).toBe(1);
    expect(outcome.types[0].probed).toBe(0);
    // 记录仍在，只是被打上待判定标记
    const item = harness.persisted[0].find((entry) => entry.id === existing.id);
    expect(item?.state).toBe("unlisted");
    expect(harness.progress[0].trigger).toBe("page");
  });

  it("探测间隔只作用于条目之间，不会白白 sleep", async () => {
    const existing = ["BV1aa411c7m0", "BV1bb411c7m1"].map((bvid) => makeItem(bvid));
    const harness = makeHarness({ pages: [[]], existing: { like: existing } });
    await runInteractionSync(harness.deps, { pageSize: 20 }, ["like"]);
    expect(harness.delays).toEqual([DEFAULT_INTERACTION_PROBE_DELAY_MS]);
  });
});

describe("runInteractionSync 多类型", () => {
  it("点赞与投币各自独立抓取与落库", async () => {
    let call = 0;
    const harness = makeHarness({ pages: [], existing: {} });
    harness.deps.fetchPage = async () => {
      call += 1;
      return { items: call === 1 ? [raw("BV1aa411c7m0")] : [raw("BV1bb411c7m1")] };
    };
    const outcome = await runInteractionSync(harness.deps, { pageSize: 20 }, ["like", "coin"]);
    expect(outcome.types.map((item) => item.type)).toEqual(["like", "coin"]);
    expect(harness.persisted[0][0].type).toBe("like");
    expect(harness.persisted[1][0].type).toBe("coin");
    // 进度会随每种类型推进各写一次，末尾再写一次汇总
    expect(harness.progress.length).toBeGreaterThanOrEqual(3);
  });
});

describe("首轮基线标记（「早期」）", () => {
  it("第一次同步时抓到的记录会被标为早期", async () => {
    const harness = makeHarness({ pages: [[raw("BV1aa411c7m0")]], existing: {} });
    harness.firstSyncMarked = false;
    await runInteractionSync(harness.deps, { pageSize: 20 }, ["like"]);
    expect(harness.persisted[0][0].caughtInBaseline).toBe(true);
    expect(harness.firstSyncMarked).toBe(true);
  });

  it("之后的同步新抓到的记录不再标早期", async () => {
    const existing = makeItem("BV1aa411c7m0");
    const harness = makeHarness({ pages: [[raw("BV1bb411c7m1")]], existing: { like: [existing] } });
    await runInteractionSync(harness.deps, { pageSize: 20 }, ["like"]);
    const added = harness.persisted[0].find((item) => item.bvid === "BV1bb411c7m1");
    expect(added?.caughtInBaseline).toBeUndefined();
  });

  it("一次都没抓全时不建立首轮标记，免得下一轮的新记录被误判", async () => {
    const page = Array.from({ length: 20 }, (_, index) => raw(`BV1aa411c7m${index}`));
    const page2 = Array.from({ length: 20 }, (_, index) => raw(`BV1bb411c7m${index}`));
    const harness = makeHarness({ pages: [page, page2], existing: {} });
    harness.firstSyncMarked = false;
    await runInteractionSync(harness.deps, { pageSize: 20, maxPagesPerType: 2 }, ["like"]);
    expect(harness.firstSyncMarked).toBe(false);
  });
});

describe("shouldRunInteractionSync", () => {
  it("关闭时永不运行", () => {
    expect(
      shouldRunInteractionSync({ enabled: false, intervalMinutes: 1, lastSyncAt: null, now: NOW }),
    ).toBe(false);
  });

  it("从未同步过时立即运行", () => {
    expect(
      shouldRunInteractionSync({ enabled: true, intervalMinutes: 180, lastSyncAt: null, now: NOW }),
    ).toBe(true);
  });

  it("间隔未到时跳过，到点才运行", () => {
    const base = {
      enabled: true,
      intervalMinutes: 180,
      lastSyncAt: NOW - 1000 * 60 * 60,
      now: NOW,
    };
    expect(shouldRunInteractionSync(base)).toBe(false);
    expect(shouldRunInteractionSync({ ...base, now: NOW + 1000 * 60 * 60 * 2 + 1 })).toBe(true);
  });
});
