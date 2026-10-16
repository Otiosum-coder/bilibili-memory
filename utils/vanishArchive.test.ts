import { describe, expect, it } from "vitest";
import {
  buildCollectionArchiveItem,
  buildFavoriteArchiveItem,
  buildFollowingArchiveItem,
  buildInteractionArchiveItem,
  buildVanishArchiveStats,
  collectLiveVanishArchive,
  mergeVanishArchive,
  queryVanishArchive,
  resolveInteractionArchiveReason,
  shouldArchiveInteraction,
  vanishArchiveId,
  isWorthArchiving,
} from "./vanishArchive";
import type {
  FavoriteResource,
  FollowingItem,
  InteractionItem,
  SubscribedCollectionResource,
  VanishArchiveItem,
} from "./types";

const NOW = new Date(2026, 9, 14, 12, 0, 0).getTime();
const DAY = 86_400_000;

const makeFav = (id: number, patch: Partial<FavoriteResource> = {}): FavoriteResource =>
  ({
    id,
    folder_id: 100,
    bvid: `BV1aa411c7m${id}`,
    bv_id: `BV1aa411c7m${id}`,
    title: `收藏 ${id}`,
    cover: "https://i0.hdslb.com/a.jpg",
    attr: 0,
    upper: { mid: 7, name: "某 UP", face: "" },
    ...patch,
  }) as FavoriteResource;

const makeCollectionResource = (
  id: string,
  patch: Partial<SubscribedCollectionResource> = {},
): SubscribedCollectionResource =>
  ({
    id,
    collection_id: 300,
    aid: 42,
    bvid: "BV1bb411c7m1",
    title: `合集视频 ${id}`,
    cover: "https://i0.hdslb.com/b.jpg",
    duration: 100,
    author_name: "合集 UP",
    author_mid: 9,
    pubdate: 1_600_000_000,
    index: 0,
    ...patch,
  }) as SubscribedCollectionResource;

const makeFollowing = (mid: number, patch: Partial<FollowingItem> = {}): FollowingItem =>
  ({
    mid,
    name: `UP_${mid}`,
    face: "https://i0.hdslb.com/face.jpg",
    sign: "",
    mtime: 1_600_000_000,
    attribute: 2,
    special: 0,
    status: "following",
    firstSeenAt: NOW - 10 * DAY,
    lastSeenAt: NOW,
    lastSeenInSyncAt: NOW,
    nameHistory: [{ name: `UP_${mid}`, seenAt: NOW - 10 * DAY }],
    ...patch,
  }) as FollowingItem;

const makeInteraction = (
  type: "like" | "coin",
  bvid: string,
  patch: Partial<InteractionItem> = {},
): InteractionItem =>
  ({
    id: `${type}:${bvid}`,
    type,
    bvid,
    title: `现名 ${bvid}`,
    firstTitle: `原名 ${bvid}`,
    cover: "https://i0.hdslb.com/c.jpg",
    duration: 100,
    authorName: "互动 UP",
    authorMid: 11,
    pubdate: 1_600_000_000,
    interactedAt: NOW - 5 * DAY,
    interactedAtExact: type === "coin",
    state: "listed",
    firstSeenAt: NOW - 5 * DAY,
    lastSeenAt: NOW,
    lastSeenOnlineAt: NOW,
    ...patch,
  }) as InteractionItem;

describe("vanishArchiveId", () => {
  it("同类同源得到同一个 id（重复归档才会幂等覆盖）", () => {
    expect(vanishArchiveId("collection", "300-42")).toBe("collection:300-42");
    expect(vanishArchiveId("collection", "300-42")).toBe(vanishArchiveId("collection", "300-42"));
  });

  it("不同 kind 即使 sourceId 相同也不冲突", () => {
    expect(vanishArchiveId("like", "x")).not.toBe(vanishArchiveId("coin", "x"));
  });
});

describe("构造档案条目", () => {
  it("收藏：sourceId 用 folder_id:id，并保留封面归档指针", () => {
    const item = buildFavoriteArchiveItem(
      makeFav(42, { coverAssetId: "asset-1" }),
      "unfavorited",
      NOW,
    );
    expect(item.id).toBe("favorite:100:42");
    expect(item.kind).toBe("favorite");
    expect(item.source).toBe("favorites");
    expect(item.coverAssetId).toBe("asset-1");
    expect(item.bvid).toBe("BV1aa411c7m42");
    expect(item.authorName).toBe("某 UP");
  });

  it("合集：记录 collection_removed 这个专属原因", () => {
    const item = buildCollectionArchiveItem(makeCollectionResource("300-42"), "collection_removed", NOW);
    expect(item.kind).toBe("collection");
    expect(item.source).toBe("collections");
    expect(item.reason).toBe("collection_removed");
    expect(item.bvid).toBe("BV1bb411c7m1");
    expect(item.aid).toBe(42);
  });

  it("关注：sourceId 用 mid（唯一且永不变），标题取昵称", () => {
    const item = buildFollowingArchiveItem(
      makeFollowing(555, { name: "已注销的 UP", avatarAssetId: "avatar-1" }),
      "unknown",
      NOW,
    );
    expect(item.id).toBe("following:555");
    expect(item.sourceId).toBe("555");
    expect(item.title).toBe("已注销的 UP");
    expect(item.coverAssetId).toBe("avatar-1");
    // 关注类没有稿件概念
    expect(item.bvid).toBeUndefined();
  });

  it("互动：标题优先取 firstTitle——档案要回答'当时点的是什么'", () => {
    const item = buildInteractionArchiveItem(
      makeInteraction("like", "BV1cc411c7m2"),
      "content_deleted",
      NOW,
    );
    expect(item.title).toBe("原名 BV1cc411c7m2");
    expect(item.kind).toBe("like");
    expect(item.source).toBe("interactions");
  });

  it("原因不明也照样留档：探测失败不等于没消失", () => {
    const item = buildCollectionArchiveItem(
      makeCollectionResource("300-9"),
      "unknown",
      NOW,
      "请求超时",
    );
    expect(item.reason).toBe("unknown");
    expect(item.probeError).toBe("请求超时");
    // 失败也要带上原始快照——档案的价值是"消失前它长什么样"
    expect(Boolean(item.item)).toBe(true);
  });

  it("重复归档时 vanishedAt 保留最早那次，不随后续同步漂移", () => {
    const first = buildCollectionArchiveItem(makeCollectionResource("300-1"), "unknown", NOW - 3 * DAY);
    const again = buildCollectionArchiveItem(
      makeCollectionResource("300-1"),
      "content_deleted",
      NOW,
      undefined,
    );
    const merged = buildCollectionArchiveItem(
      makeCollectionResource("300-1"),
      "content_deleted",
      NOW,
      undefined,
    );
    expect(first.vanishedAt).toBe(NOW - 3 * DAY);
    // 新判定覆盖 reason，但时间保留最早值
    expect(merged.vanishedAt).toBe(NOW);
    // 调用方负责传入 previous；这里直接验证幂等语义由 mergeVanishArchive 保证
    expect(mergeVanishArchive([first], [again])[0].vanishedAt).toBe(NOW - 3 * DAY);
  });

  it("非法 aid / authorMid 不写入（避免把 0 当成真值）", () => {
    const item = buildCollectionArchiveItem(
      makeCollectionResource("300-2", { aid: Number.NaN, author_mid: 0 }),
      "unknown",
      NOW,
    );
    expect(item.aid).toBeUndefined();
    expect(item.authorMid).toBeUndefined();
  });
});

describe("互动是否该进档案", () => {
  it("只有稿件本身查不到才归档——掉出窗口与未判定都不算", () => {
    expect(shouldArchiveInteraction(makeInteraction("like", "BV1", { state: "listed" }))).toBe(false);
    expect(shouldArchiveInteraction(makeInteraction("like", "BV1", { state: "retained" }))).toBe(
      false,
    );
    expect(shouldArchiveInteraction(makeInteraction("like", "BV1", { state: "unlisted" }))).toBe(
      false,
    );
    expect(shouldArchiveInteraction(makeInteraction("like", "BV1", { state: "ended" }))).toBe(false);
    expect(
      shouldArchiveInteraction(makeInteraction("like", "BV1", { state: "content_deleted" })),
    ).toBe(true);
    expect(
      shouldArchiveInteraction(makeInteraction("like", "BV1", { state: "content_hidden" })),
    ).toBe(true);
  });

  it("原因映射与状态一一对应", () => {
    expect(resolveInteractionArchiveReason(makeInteraction("like", "BV1", { state: "content_deleted" }))).toBe(
      "content_deleted",
    );
    expect(resolveInteractionArchiveReason(makeInteraction("like", "BV1", { state: "content_hidden" }))).toBe(
      "content_hidden",
    );
    expect(resolveInteractionArchiveReason(makeInteraction("like", "BV1", { state: "retained" }))).toBeNull();
  });
});

describe("queryVanishArchive", () => {
  const items: VanishArchiveItem[] = [
    buildCollectionArchiveItem(makeCollectionResource("300-1"), "collection_removed", NOW - DAY),
    buildFavoriteArchiveItem(makeFav(42), "unfavorited", NOW - 3 * DAY),
    buildFollowingArchiveItem(makeFollowing(555, { name: "消失的 UP" }), "unknown", NOW - 2 * DAY),
  ];

  it("默认按消失时间倒序", () => {
    expect(queryVanishArchive(items).map((item) => item.sourceId)).toEqual([
      "300-1",
      "555",
      "100:42",
    ]);
  });

  it("按来源筛选", () => {
    expect(queryVanishArchive(items, { source: "collections" })).toHaveLength(1);
    expect(queryVanishArchive(items, { source: "favorites" })).toHaveLength(1);
  });

  it("按原因筛选", () => {
    expect(queryVanishArchive(items, { reason: "collection_removed" })).toHaveLength(1);
    expect(queryVanishArchive(items, { reason: "content_deleted" })).toHaveLength(0);
  });

  it("关键词命中标题、UP 主、BV 号与 sourceId", () => {
    expect(queryVanishArchive(items, { keyword: "消失" })).toHaveLength(1);
    expect(queryVanishArchive(items, { keyword: "bv1aa" })).toHaveLength(1);
    expect(queryVanishArchive(items, { keyword: "300-1" })).toHaveLength(1);
  });

  it("不改动入参数组顺序", () => {
    const before = items.map((item) => item.id);
    queryVanishArchive(items);
    expect(items.map((item) => item.id)).toEqual(before);
  });
});

describe("buildVanishArchiveStats", () => {
  it("按 kind 与 reason 分别计数，五种 kind 都要出现在结果里", () => {
    const stats = buildVanishArchiveStats([
      buildCollectionArchiveItem(makeCollectionResource("a"), "collection_removed", NOW),
      buildInteractionArchiveItem(makeInteraction("like", "BV1"), "content_deleted", NOW),
      buildInteractionArchiveItem(makeInteraction("coin", "BV2"), "content_hidden", NOW),
    ]);
    expect(stats.total).toBe(3);
    expect(stats.byKind).toEqual({ favorite: 0, collection: 1, following: 0, like: 1, coin: 1 });
    expect(stats.byReason.collection_removed).toBe(1);
    expect(stats.byReason.content_deleted).toBe(1);
    expect(stats.byReason.content_hidden).toBe(1);
    expect(stats.byReason.unfavorited).toBe(0);
  });

  it("空输入不崩", () => {
    expect(buildVanishArchiveStats([]).total).toBe(0);
  });
});

describe("collectLiveVanishArchive：从源记录读时派生", () => {
  const never = () => false;
  const always = () => true;

  it("收藏：只有被标记失效的才汇出", () => {
    const items = collectLiveVanishArchive({
      favorites: [makeFav(1), makeFav(2)],
      collections: [],
      following: [],
      interactions: [],
      isInvalidated: (resource) => resource.id === 2,
    });
    expect(items.map((item) => item.sourceId)).toEqual(["100:2"]);
    expect(items[0].source).toBe("favorites");
  });

  it("关注：只汇出已注销，取关不算消失（人还在 B 站）", () => {
    const items = collectLiveVanishArchive({
      favorites: [],
      collections: [],
      following: [
        makeFollowing(1, { status: "following" }),
        makeFollowing(2, { status: "unfollowed" }),
        makeFollowing(3, { status: "gone", goneDetectedAt: NOW - DAY }),
      ],
      interactions: [],
      isInvalidated: never,
    });
    expect(items.map((item) => item.sourceId)).toEqual(["3"]);
    // 时间取首次判定注销的时刻，而不是"现在"
    expect(items[0].vanishedAt).toBe(NOW - DAY);
  });

  it("关注：什么都没观测到的注销账号不进档案（只有 UID，没有有效信息）", () => {
    const bare = makeFollowing(9, {
      status: "gone",
      name: "",
      sign: "",
      nameHistory: [],
    });
    const withName = makeFollowing(10, { status: "gone", name: "还记得的名字" });
    const withHistory = makeFollowing(11, {
      status: "gone",
      name: "",
      nameHistory: [
        { name: "旧名 A", seenAt: NOW - 30 * DAY },
        { name: "旧名 B", seenAt: NOW - 10 * DAY },
      ],
    });

    const items = collectLiveVanishArchive({
      favorites: [],
      collections: [],
      following: [bare, withName, withHistory],
      interactions: [],
      isInvalidated: never,
    });

    // 只有 UID 的那个被排除；有名字或改过名的留下
    expect(items.map((item) => item.sourceId)).toEqual(["10", "11"]);
    expect(isWorthArchiving(bare)).toBe(false);
    expect(isWorthArchiving(withName)).toBe(true);
    expect(isWorthArchiving(withHistory)).toBe(true);
  });

  it("互动：只有稿件本身查不到的才汇出，掉出窗口与未判定都不算", () => {
    const items = collectLiveVanishArchive({
      favorites: [],
      collections: [],
      following: [],
      interactions: [
        makeInteraction("like", "BV1", { state: "retained" }),
        makeInteraction("like", "BV2", { state: "unlisted" }),
        makeInteraction("like", "BV3", { state: "ended" }),
        makeInteraction("coin", "BV4", { state: "content_deleted", endedDetectedAt: NOW - 2 * DAY }),
        makeInteraction("like", "BV5", { state: "content_hidden" }),
      ],
      isInvalidated: never,
    });
    expect(items.map((item) => item.kind)).toEqual(["coin", "like"]);
    expect(items[0].reason).toBe("content_deleted");
    expect(items[0].vanishedAt).toBe(NOW - 2 * DAY);
    expect(items[1].reason).toBe("content_hidden");
  });

  it("订阅合集不派生：资源本身没有失效标记，只能靠同步时留档", () => {
    const items = collectLiveVanishArchive({
      favorites: [],
      collections: [makeCollectionResource("300-1")],
      following: [],
      interactions: [],
      isInvalidated: always,
    });
    expect(items).toHaveLength(0);
  });

  it("三处都没问题时返回空——反向验证「共 0 条」不该出现于有内容的库", () => {
    const items = collectLiveVanishArchive({
      favorites: [makeFav(1), makeFav(2)],
      collections: [],
      following: [makeFollowing(1)],
      interactions: [makeInteraction("like", "BV1")],
      isInvalidated: never,
    });
    expect(items).toEqual([]);
  });
});

describe("mergeVanishArchive", () => {
  it("同 id 保留消失时间更早的那条", () => {
    const early = buildCollectionArchiveItem(makeCollectionResource("x"), "unknown", NOW - 5 * DAY);
    const late = buildCollectionArchiveItem(makeCollectionResource("x"), "content_deleted", NOW);
    expect(mergeVanishArchive([late], [early])[0].vanishedAt).toBe(NOW - 5 * DAY);
    expect(mergeVanishArchive([early], [late])[0].vanishedAt).toBe(NOW - 5 * DAY);
  });

  it("不同 id 全部保留", () => {
    const a = buildCollectionArchiveItem(makeCollectionResource("a"), "unknown", NOW);
    const b = buildCollectionArchiveItem(makeCollectionResource("b"), "unknown", NOW);
    expect(mergeVanishArchive([a], [b])).toHaveLength(2);
  });

  it("两边都为空返回空数组", () => {
    expect(mergeVanishArchive([], [])).toEqual([]);
  });
});
