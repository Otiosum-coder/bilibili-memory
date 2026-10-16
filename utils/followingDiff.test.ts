import { describe, expect, it } from "vitest";
import {
  diffFollowing,
  formatLocalDay,
  isGoneName,
  type FollowingDiffOptions,
  type RawFollowingEntry,
} from "./followingDiff";
import type { FollowingItem } from "./types";

/** 固定"现在"，避免测试依赖真实时间 */
const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;

const makeOptions = (patch: Partial<FollowingDiffOptions> = {}): FollowingDiffOptions => ({
  hasBaseline: true,
  syncStartedAt: NOW,
  fullScanCompleted: true,
  now: NOW,
  ...patch,
});

const makeEntry = (
  mid: number,
  uname: string,
  patch: Partial<RawFollowingEntry> = {},
): RawFollowingEntry => ({
  mid,
  uname,
  face: `https://i0.hdslb.com/bfs/face/${mid}.jpg`,
  sign: "",
  mtime: Math.floor(NOW / 1000),
  attribute: 2,
  special: 0,
  ...patch,
});

const makeExisting = (mid: number, patch: Partial<FollowingItem> = {}): FollowingItem => ({
  mid,
  name: `UP_${mid}`,
  face: `https://i0.hdslb.com/bfs/face/${mid}.jpg`,
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

describe("isGoneName", () => {
  it("把空值、空白与已知占位文案都判为注销信号", () => {
    expect(isGoneName("")).toBe(true);
    expect(isGoneName("   ")).toBe(true);
    expect(isGoneName(undefined)).toBe(true);
    expect(isGoneName(null)).toBe(true);
    expect(isGoneName("账号已注销")).toBe(true);
    expect(isGoneName(" 账号已注销 ")).toBe(true);
    expect(isGoneName("用户不存在")).toBe(true);
  });

  it("真实昵称不判为注销", () => {
    expect(isGoneName("讲宏观的猴子")).toBe(false);
    expect(isGoneName("noyee雪")).toBe(false);
    // 含"注销"二字但不是纯占位文案的昵称，不应误判
    expect(isGoneName("注销了也不改名")).toBe(false);
  });
});

describe("diffFollowing - 首次基线", () => {
  it("只写快照，不产生任何事件", () => {
    const incoming = [makeEntry(1, "甲"), makeEntry(2, "乙")];
    const { next, events } = diffFollowing([], incoming, makeOptions({ hasBaseline: false }));

    expect(events).toEqual([]);
    expect(next).toHaveLength(2);
    expect(next.every((item) => item.status === "following")).toBe(true);
  });

  it("基线的名字也写入 nameHistory，因此 length === 1 表示从未改名", () => {
    const { next } = diffFollowing([], [makeEntry(1, "甲")], makeOptions({ hasBaseline: false }));

    expect(next[0].nameHistory).toEqual([{ name: "甲", seenAt: NOW }]);
    expect(next[0].name).toBe("甲");
  });

  it("基线遇到已注销账号：标记 gone 但不产事件，且 name 保持为空而非占位文案", () => {
    const { next, events } = diffFollowing(
      [],
      [makeEntry(9, "账号已注销")],
      makeOptions({ hasBaseline: false }),
    );

    expect(events).toEqual([]);
    expect(next[0].status).toBe("gone");
    expect(next[0].name).toBe("");
    expect(next[0].nameHistory).toEqual([]);
    expect(next[0].goneDetectedAt).toBe(NOW);
  });
});

describe("diffFollowing - 新关注与重新关注", () => {
  it("新关注产 followed，且 occurred_at 用接口的 mtime 而不是同步时间", () => {
    const followedSeconds = Math.floor((NOW - 3 * DAY_MS) / 1000);
    const { next, events } = diffFollowing(
      [],
      [makeEntry(1, "甲", { mtime: followedSeconds })],
      makeOptions(),
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("followed");
    expect(events[0].name).toBe("甲");
    expect(events[0].occurred_at).toBe(followedSeconds * 1000);
    expect(next[0].mtime).toBe(followedSeconds);
  });

  it("mtime 缺失时回退到同步开始时间", () => {
    const { events } = diffFollowing([], [makeEntry(1, "甲", { mtime: 0 })], makeOptions());

    expect(events[0].occurred_at).toBe(NOW);
  });

  it("已取关的人重新出现在列表 → 产 followed，并清除取关标记", () => {
    const existing = [
      makeExisting(1, { status: "unfollowed", unfollowedDetectedAt: NOW - DAY_MS }),
    ];
    const { next, events } = diffFollowing(existing, [makeEntry(1, "UP_1")], makeOptions());

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("followed");
    expect(next[0].status).toBe("following");
    expect(next[0].unfollowedDetectedAt).toBeUndefined();
  });

  it("从没见过的 mid 一出现就是占位名 → 不产事件（我们从不知道他是谁）", () => {
    const { next, events } = diffFollowing([], [makeEntry(7, "账号已注销")], makeOptions());

    expect(events).toEqual([]);
    expect(next[0].status).toBe("gone");
    expect(next[0].name).toBe("");
  });
});

describe("diffFollowing - 改名", () => {
  it("旧名与新名都是真实名字且不同 → 产 renamed 并带 previous_name", () => {
    const existing = [makeExisting(1, { name: "旧名字" })];
    const { next, events } = diffFollowing(existing, [makeEntry(1, "新名字")], makeOptions());

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("renamed");
    expect(events[0].previous_name).toBe("旧名字");
    expect(events[0].name).toBe("新名字");
    expect(events[0].occurred_at).toBe(NOW);
    expect(next[0].nameHistory.map((entry) => entry.name)).toEqual(["UP_1", "新名字"]);
  });

  it("名字没变则不产事件", () => {
    const existing = [makeExisting(1, { name: "同一个名字" })];
    const { events } = diffFollowing(existing, [makeEntry(1, "同一个名字")], makeOptions());

    expect(events).toEqual([]);
  });

  it("本地已知名字为空、首次拿到真实名字 → 不算改名", () => {
    const existing = [makeExisting(1, { name: "", nameHistory: [] })];
    const { next, events } = diffFollowing(existing, [makeEntry(1, "第一次知道的名字")], makeOptions());

    expect(events).toEqual([]);
    expect(next[0].name).toBe("第一次知道的名字");
    expect(next[0].nameSource).toBe("api");
  });

  it("mtime 变化不产任何事件（互关会刷新 mtime，不能据此推断重新关注）", () => {
    const existing = [makeExisting(1, { mtime: 1000 })];
    const { next, events } = diffFollowing(
      existing,
      [makeEntry(1, "UP_1", { mtime: 2_000_000_000 })],
      makeOptions(),
    );

    expect(events).toEqual([]);
    expect(next[0].mtime).toBe(2_000_000_000);
  });
});

describe("diffFollowing - 账号注销", () => {
  it("占位文案产 account_gone，保留注销前的真实名字，且绝不产 renamed", () => {
    const existing = [makeExisting(1, { name: "注销前的名字" })];
    const { next, events } = diffFollowing(existing, [makeEntry(1, "账号已注销")], makeOptions());

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("account_gone");
    expect(events[0].name).toBe("注销前的名字");
    expect(events.some((event) => event.type === "renamed")).toBe(false);
    expect(next[0].name).toBe("注销前的名字");
    expect(next[0].status).toBe("gone");
    expect(next[0].goneDetectedAt).toBe(NOW);
  });

  it("关键负例：占位文案绝不覆盖已知的真实名字，也不写进 nameHistory", () => {
    const existing = [makeExisting(1, { name: "真名" })];
    const { next } = diffFollowing(existing, [makeEntry(1, "账号已注销")], makeOptions());

    expect(next[0].name).toBe("真名");
    expect(next[0].nameHistory.map((entry) => entry.name)).toEqual(["UP_1"]);
    expect(next[0].nameHistory.some((entry) => isGoneName(entry.name))).toBe(false);
  });

  it("重复同步不重复产 account_gone", () => {
    const existing = [makeExisting(1, { name: "真名", status: "gone", goneDetectedAt: NOW - DAY_MS })];
    const { next, events } = diffFollowing(existing, [makeEntry(1, "账号已注销")], makeOptions());

    expect(events).toEqual([]);
    expect(next[0].goneDetectedAt).toBe(NOW - DAY_MS);
  });

  it("gone 是终态：账号从列表消失也不改判为取关", () => {
    const existing = [
      makeExisting(1, { name: "真名", status: "gone", goneDetectedAt: NOW - DAY_MS }),
    ];
    const { next, events } = diffFollowing(existing, [], makeOptions());

    expect(events).toEqual([]);
    expect(next[0].status).toBe("gone");
  });

  it("账号恢复（B 站注销有冷静期）→ 回到 following 并清除gone 标记", () => {
    const existing = [
      makeExisting(1, { name: "真名", status: "gone", goneDetectedAt: NOW - DAY_MS }),
    ];
    const { next, events } = diffFollowing(existing, [makeEntry(1, "真名")], makeOptions());

    expect(events).toEqual([]);
    expect(next[0].status).toBe("following");
    expect(next[0].goneDetectedAt).toBeUndefined();
  });
});

describe("diffFollowing - 取关判定", () => {
  it("完整扫描后本轮未出现 → unfollowed 并记录时间", () => {
    const existing = [makeExisting(1), makeExisting(2)];
    const { next, events } = diffFollowing(existing, [makeEntry(1, "UP_1")], makeOptions());

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("unfollowed");
    expect(events[0].mid).toBe(2);
    expect(events[0].name).toBe("UP_2");

    const removed = next.find((item) => item.mid === 2);
    expect(removed?.status).toBe("unfollowed");
    expect(removed?.unfollowedDetectedAt).toBe(NOW);
  });

  it("关键负例：未完整扫完全部 total 条时，绝不判定取关", () => {
    const existing = [makeExisting(1), makeExisting(2)];
    const { next, events } = diffFollowing(
      existing,
      [makeEntry(1, "UP_1")],
      makeOptions({ fullScanCompleted: false }),
    );

    expect(events).toEqual([]);
    const kept = next.find((item) => item.mid === 2);
    expect(kept?.status).toBe("following");
    expect(kept?.unfollowedDetectedAt).toBeUndefined();
  });

  it("未建立基线时即便缺失也不判定取关", () => {
    const existing = [makeExisting(1), makeExisting(2)];
    const { next, events } = diffFollowing(
      existing,
      [makeEntry(1, "UP_1")],
      makeOptions({ hasBaseline: false }),
    );

    expect(events).toEqual([]);
    expect(next.find((item) => item.mid === 2)?.status).toBe("following");
  });

  it("已取关的人再次缺失 → 不重复产事件", () => {
    const existing = [makeExisting(2, { status: "unfollowed", unfollowedDetectedAt: NOW - DAY_MS })];
    const { next, events } = diffFollowing(existing, [], makeOptions());

    expect(events).toEqual([]);
    expect(next[0].unfollowedDetectedAt).toBe(NOW - DAY_MS);
  });
});

describe("diffFollowing - 事件幂等与脏数据", () => {
  it("同一类型同一天同一 mid 的 event_id 相同，重复同步不会产生重复记录", () => {
    const existing = [makeExisting(1)];
    const first = diffFollowing(existing, [], makeOptions());
    const second = diffFollowing(existing, [], makeOptions());

    expect(first.events[0].event_id).toBe(second.events[0].event_id);
    expect(first.events[0].event_id).toBe(`unfollowed:1:${formatLocalDay(NOW)}`);
  });

  it("丢弃非法 mid，并对重复条目去重", () => {
    const incoming = [
      makeEntry(1, "甲"),
      makeEntry(1, "甲"),
      makeEntry(0, "非法"),
      makeEntry(-5, "非法"),
      { mid: Number.NaN, uname: "非法" } as RawFollowingEntry,
    ];
    const { next } = diffFollowing([], incoming, makeOptions());

    expect(next).toHaveLength(1);
    expect(next[0].mid).toBe(1);
  });

  it("缺字段的条目不会清掉上一轮已知的信息", () => {
    const existing = [
      makeExisting(1, { sign: "老签名", officialVerifyDesc: "bilibili 知名UP主" }),
    ];
    const { next } = diffFollowing(
      existing,
      [{ mid: 1, uname: "UP_1" } as RawFollowingEntry],
      makeOptions(),
    );

    expect(next[0].face).toBe(existing[0].face);
    expect(next[0].sign).toBe("老签名");
    expect(next[0].officialVerifyDesc).toBe("bilibili 知名UP主");
    expect(next[0].mtime).toBe(existing[0].mtime);
  });

  it("保留上一轮的 avatarAssetId 与第三方曾用名", () => {
    const existing = [
      makeExisting(1, {
        avatarAssetId: "avatar:/bfs/face/1.jpg",
        thirdPartyNames: ["旧名A", "旧名B"],
        thirdPartyQueriedAt: NOW - DAY_MS,
      }),
    ];
    const { next } = diffFollowing(existing, [makeEntry(1, "UP_1")], makeOptions());

    expect(next[0].avatarAssetId).toBe("avatar:/bfs/face/1.jpg");
    expect(next[0].thirdPartyNames).toEqual(["旧名A", "旧名B"]);
    expect(next[0].thirdPartyQueriedAt).toBe(NOW - DAY_MS);
  });
});
