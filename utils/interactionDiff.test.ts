import { describe, expect, it } from "vitest";
import {
  applyInteractionProbes,
  diffInteractions,
  interactionKey,
  mergeOnlineEntry,
  pickCover,
  pickTitle,
  resolveBvid,
  resolveInteractedAt,
  resolveStateFromProbe,
  shouldProbeInteraction,
  PROBE_RECHECK_MS,
  PROBE_RETRY_MS,
} from "./interactionDiff";
import { PLACEHOLDER_COVER_PATH } from "./imageUrl";
import type { InteractionItem, RawInteractionEntry } from "./types";

const NOW = 1_700_000_000_000;

const likeRaw = (bvid: string, title = "标题", pic = "https://i0.hdslb.com/bfs/archive/a.jpg"): RawInteractionEntry => ({
  aid: 12345,
  bvid,
  title,
  pic,
  duration: 120,
  pubdate: 1_600_000_000,
  owner: { mid: 999, name: "某 UP" },
});

const makeItem = (overrides: Partial<InteractionItem> = {}): InteractionItem => ({
  id: "like:BV1xx411c7mD",
  type: "like",
  bvid: "BV1xx411c7mD",
  title: "标题",
  firstTitle: "标题",
  cover: "https://i0.hdslb.com/bfs/archive/a.jpg",
  duration: 120,
  authorName: "某 UP",
  authorMid: 999,
  pubdate: 1_600_000_000,
  interactedAt: NOW - 1000,
  interactedAtExact: false,
  state: "listed",
  firstSeenAt: NOW - 1000,
  lastSeenAt: NOW - 1000,
  lastSeenOnlineAt: NOW - 1000,
  ...overrides,
});

describe("resolveBvid", () => {
  it("优先用 bvid", () => {
    expect(resolveBvid({ bvid: "BV1xx411c7mD", aid: 1 })).toBe("BV1xx411c7mD");
  });

  it("没有 bvid 时退化为 av 号", () => {
    expect(resolveBvid({ aid: 42 })).toBe("av42");
  });

  it("两者都没有时返回空串", () => {
    expect(resolveBvid({})).toBe("");
  });
});

describe("pickTitle / pickCover 的数据保全语义", () => {
  const previous = makeItem({ title: "真实标题", cover: "https://x/a.jpg" });

  it("空标题不覆盖旧值", () => {
    expect(pickTitle("", previous)).toBe("真实标题");
    expect(pickTitle(undefined, previous)).toBe("真实标题");
  });

  it("已失效占位文案不覆盖旧值", () => {
    expect(pickTitle("已失效视频", previous)).toBe("真实标题");
    expect(pickTitle("【已失效】", previous)).toBe("真实标题");
  });

  it("平台占位封面不覆盖旧值", () => {
    expect(pickCover(`https://i0.hdslb.com${PLACEHOLDER_COVER_PATH}`, previous)).toBe(
      "https://x/a.jpg",
    );
    expect(pickCover("", previous)).toBe("https://x/a.jpg");
  });

  it("正常新值照常覆盖", () => {
    expect(pickTitle("新标题", previous)).toBe("新标题");
    expect(pickCover("https://x/b.jpg", previous)).toBe("https://x/b.jpg");
  });
});

describe("resolveInteractedAt", () => {
  it("投币用接口给的真实时间并标记为精确", () => {
    const result = resolveInteractedAt("coin", { time: 1_601_802_763 }, undefined, NOW);
    expect(result.at).toBe(1_601_802_763_000);
    expect(result.exact).toBe(true);
  });

  it("点赞没有真实时间，退化为首次观测时间且标记为近似", () => {
    const result = resolveInteractedAt("like", {}, undefined, NOW);
    expect(result.at).toBe(NOW);
    expect(result.exact).toBe(false);
  });

  it("已经拿到过精确时间的记录不被近似值覆盖", () => {
    const previous = makeItem({ interactedAt: 111, interactedAtExact: true });
    expect(resolveInteractedAt("like", {}, previous, NOW)).toEqual({ at: 111, exact: true });
  });

  it("已有近似时间时保持首次观测值，不用本轮时间覆盖", () => {
    const previous = makeItem({ interactedAt: 111, interactedAtExact: false });
    expect(resolveInteractedAt("like", {}, previous, NOW)).toEqual({ at: 111, exact: false });
  });
});

describe("mergeOnlineEntry", () => {
  it("首次建档写入 firstTitle 与 firstSeenAt", () => {
    const item = mergeOnlineEntry("like", likeRaw("BV1xx411c7mD", "首见标题"), 0, undefined, {
      now: NOW,
      syncStartedAt: NOW,
    });
    expect(item?.id).toBe(interactionKey("like", "BV1xx411c7mD"));
    expect(item?.firstTitle).toBe("首见标题");
    expect(item?.firstSeenAt).toBe(NOW);
    expect(item?.state).toBe("listed");
    expect(item?.listRank).toBe(0);
  });

  it("首次标题永不被后续覆盖", () => {
    const previous = makeItem({ firstTitle: "当时叫这个", title: "当时叫这个" });
    const item = mergeOnlineEntry("like", likeRaw("BV1xx411c7mD", "后来改名了"), 0, previous, {
      now: NOW,
      syncStartedAt: NOW,
    });
    expect(item?.firstTitle).toBe("当时叫这个");
    expect(item?.title).toBe("后来改名了");
  });

  it("投币记录带上投币枚数", () => {
    const item = mergeOnlineEntry(
      "coin",
      { ...likeRaw("BV1xx411c7mD"), coins: 2, time: 1_601_802_763 },
      0,
      undefined,
      { now: NOW, syncStartedAt: NOW },
    );
    expect(item?.coins).toBe(2);
    expect(item?.interactedAtExact).toBe(true);
  });

  it("首次同步抓到的记录带早期标记，之后的同步不带", () => {
    const first = mergeOnlineEntry("like", likeRaw("BV1xx411c7mD"), 0, undefined, {
      now: NOW,
      syncStartedAt: NOW,
      isFirstSync: true,
    });
    expect(first?.caughtInBaseline).toBe(true);

    const later = mergeOnlineEntry("like", likeRaw("BV1yy411c7mD"), 0, undefined, {
      now: NOW,
      syncStartedAt: NOW,
    });
    expect(later?.caughtInBaseline).toBeUndefined();
  });

  it("早期标记一旦写下就不会被后续同步抹掉", () => {
    const previous = makeItem({ caughtInBaseline: true });
    const item = mergeOnlineEntry("like", likeRaw("BV1xx411c7mD"), 0, previous, {
      now: NOW,
      syncStartedAt: NOW,
    });
    expect(item?.caughtInBaseline).toBe(true);
  });

  it("没有可用 BV 号时返回 null", () => {
    expect(
      mergeOnlineEntry("like", { title: "x" }, 0, undefined, { now: NOW, syncStartedAt: NOW }),
    ).toBeNull();
  });

  it("重新出现时状态回到 listed，但消失时间作为历史保留", () => {
    const previous = makeItem({ state: "retained", unlistedDetectedAt: NOW - 5000 });
    const item = mergeOnlineEntry("like", likeRaw("BV1xx411c7mD"), 0, previous, {
      now: NOW,
      syncStartedAt: NOW,
    });
    expect(item?.state).toBe("listed");
    expect(item?.unlistedDetectedAt).toBe(NOW - 5000);
  });
});

describe("diffInteractions", () => {
  it("抓不完整时绝不做消失判定", () => {
    const existing = [makeItem()];
    const result = diffInteractions({
      type: "like",
      online: [],
      existing,
      scanCompleted: false,
      syncStartedAt: NOW,
      now: NOW,
    });
    expect(result.unlisted).toBe(0);
    expect(result.probeCandidates).toHaveLength(0);
    expect(result.next[0].state).toBe("listed");
    expect(result.next[0].lastSeenAt).toBe(NOW);
  });

  it("抓完整时不在列表的条目转为 unlisted 并进入探测队列", () => {
    const existing = [makeItem()];
    const result = diffInteractions({
      type: "like",
      online: [],
      existing,
      scanCompleted: true,
      syncStartedAt: NOW,
      now: NOW,
    });
    expect(result.unlisted).toBe(1);
    expect(result.next[0].state).toBe("unlisted");
    expect(result.next[0].unlistedDetectedAt).toBe(NOW);
    expect(result.probeCandidates.map((item) => item.id)).toEqual([existing[0].id]);
  });

  it("已判定过的条目不会被改回 unlisted", () => {
    const existing = [makeItem({ state: "retained", probeAttemptedAt: NOW - 1000 })];
    const result = diffInteractions({
      type: "like",
      online: [],
      existing,
      scanCompleted: true,
      syncStartedAt: NOW,
      now: NOW,
    });
    expect(result.next[0].state).toBe("retained");
    expect(result.probeCandidates).toHaveLength(0);
  });

  it("已在列表里的条目状态回到 listed，并统计新增/刷新", () => {
    const existing = [makeItem({ state: "ended", id: interactionKey("like", "BV1xx411c7mD") })];
    const result = diffInteractions({
      type: "like",
      online: [likeRaw("BV1xx411c7mD"), likeRaw("BV1yy411c7mD")],
      existing,
      scanCompleted: true,
      syncStartedAt: NOW,
      now: NOW,
    });
    expect(result.refreshed).toBe(1);
    expect(result.added).toBe(1);
    expect(result.next.find((item) => item.bvid === "BV1xx411c7mD")?.state).toBe("listed");
  });

  it("同一条 bvid 重复出现时只保留一条", () => {
    const result = diffInteractions({
      type: "like",
      online: [likeRaw("BV1xx411c7mD", "第一"), likeRaw("BV1xx411c7mD", "第二")],
      existing: [],
      scanCompleted: true,
      syncStartedAt: NOW,
      now: NOW,
    });
    expect(result.next).toHaveLength(1);
    expect(result.next[0].title).toBe("第一");
    expect(result.next[0].listRank).toBe(0);
  });

  it("点赞与投币是两条互相独立的记录", () => {
    const result = diffInteractions({
      type: "coin",
      online: [likeRaw("BV1xx411c7mD")],
      existing: [makeItem({ type: "like" })],
      scanCompleted: true,
      syncStartedAt: NOW,
      now: NOW,
    });
    expect(result.added).toBe(1);
    expect(result.unlisted).toBe(1);
    expect(result.next.map((item) => item.id).sort()).toEqual([
      "coin:BV1xx411c7mD",
      "like:BV1xx411c7mD",
    ]);
  });
});

describe("shouldProbeInteraction", () => {
  it("从未探测过 → 探测", () => {
    expect(shouldProbeInteraction(makeItem(), NOW)).toBe(true);
  });

  it("探测失败后要等一天才重试", () => {
    const item = makeItem({ probeAttemptedAt: NOW - 1000, probeError: "网络失败" });
    expect(shouldProbeInteraction(item, NOW)).toBe(false);
    expect(shouldProbeInteraction(item, NOW + PROBE_RETRY_MS)).toBe(true);
  });

  it("探测成功后要等一个月才复查", () => {
    const item = makeItem({ probeAttemptedAt: NOW - 1000, probeError: undefined });
    expect(shouldProbeInteraction(item, NOW)).toBe(false);
    expect(shouldProbeInteraction(item, NOW + PROBE_RETRY_MS)).toBe(false);
    expect(shouldProbeInteraction(item, NOW + PROBE_RECHECK_MS)).toBe(true);
  });
});

describe("resolveStateFromProbe", () => {
  it("稿件被删 → content_deleted", () => {
    expect(resolveStateFromProbe({ content: "deleted", retained: null })).toBe("content_deleted");
  });

  it("稿件不可见 → content_hidden", () => {
    expect(resolveStateFromProbe({ content: "hidden", retained: null })).toBe("content_hidden");
  });

  it("稿件还在且互动仍在 → retained", () => {
    expect(resolveStateFromProbe({ content: "ok", retained: true })).toBe("retained");
  });

  it("稿件还在但互动查不到 → ended", () => {
    expect(resolveStateFromProbe({ content: "ok", retained: false })).toBe("ended");
  });

  it("探测失败 → 停在 unlisted，绝不猜", () => {
    expect(resolveStateFromProbe({ content: "unknown", retained: null, error: "超时" })).toBe(
      "unlisted",
    );
    expect(resolveStateFromProbe({ content: "ok", retained: null })).toBe("unlisted");
  });
});

describe("applyInteractionProbes", () => {
  it("只改状态与探测元数据，标题与首次标题不受影响", () => {
    const item = makeItem({ state: "unlisted", firstTitle: "当时叫这个", title: "后来改名了" });
    const result = applyInteractionProbes(
      [item],
      [{ id: item.id, result: { content: "ok", retained: true } }],
      NOW,
    );
    expect(result.next[0].state).toBe("retained");
    expect(result.next[0].firstTitle).toBe("当时叫这个");
    expect(result.next[0].title).toBe("后来改名了");
    expect(result.next[0].probeAttemptedAt).toBe(NOW);
    expect(result.ended).toBe(0);
  });

  it("首次判定为结束时记录 endedDetectedAt 并计数", () => {
    const item = makeItem({ state: "unlisted" });
    const result = applyInteractionProbes(
      [item],
      [{ id: item.id, result: { content: "ok", retained: false } }],
      NOW,
    );
    expect(result.next[0].state).toBe("ended");
    expect(result.next[0].endedDetectedAt).toBe(NOW);
    expect(result.ended).toBe(1);
  });

  it("已经有 endedDetectedAt 的条目不会把时间往后推", () => {
    const item = makeItem({ state: "ended", endedDetectedAt: NOW - 9000 });
    const result = applyInteractionProbes(
      [item],
      [{ id: item.id, result: { content: "deleted", retained: null } }],
      NOW,
    );
    expect(result.next[0].endedDetectedAt).toBe(NOW - 9000);
    expect(result.ended).toBe(0);
  });

  it("探测失败的条目记录错误并停在 unlisted", () => {
    const item = makeItem({ state: "unlisted" });
    const result = applyInteractionProbes(
      [item],
      [{ id: item.id, result: { content: "unknown", retained: null, error: "请求超时" } }],
      NOW,
    );
    expect(result.next[0].state).toBe("unlisted");
    expect(result.next[0].probeError).toBe("请求超时");
  });
});
