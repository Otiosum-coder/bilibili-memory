import { describe, expect, it } from "vitest";
import {
  INVALIDATED_KIND_LABEL,
  INVALIDATED_TITLE_RE,
  VANISH_REASON_LABEL,
  buildVanishedRecord,
  buildVanishedStats,
  buildVanishCandidates,
  classifyViewProbe,
  isInvalidatedResource,
  queryVanishedResources,
  resolveInvalidatedKind,
} from "./favVanishedDiff";
import type { FavoriteResource, FavVanishReason, VanishedFavResource } from "./types";

const NOW = 1_800_000_000_000;

const makeResource = (id: number, patch: Partial<FavoriteResource> = {}): FavoriteResource => ({
  id,
  type: 2,
  title: `视频 ${id}`,
  cover: `https://i0.hdslb.com/bfs/archive/${id}.jpg`,
  intro: "",
  duration: 100,
  upper: { mid: 1, name: "UP", face: "" },
  cnt_info: { collect: 0, play: 0, danmaku: 0 },
  link: `bilibili://video/${id}`,
  ctime: 1,
  pubtime: 1,
  fav_time: 1,
  bv_id: "",
  bvid: `BV1xx${id}`,
  folder_id: 100,
  index: 0,
  ...patch,
});

describe("resolveInvalidatedKind", () => {
  it("attr 为 0 或缺失表示正常", () => {
    expect(resolveInvalidatedKind(0)).toBeNull();
    expect(resolveInvalidatedKind(undefined)).toBeNull();
    expect(resolveInvalidatedKind(null)).toBeNull();
  });

  it("attr 1 是其他原因删除/退回", () => {
    expect(resolveInvalidatedKind(1)).toBe("removed_by_other");
  });

  it("attr 9 是 UP 主自己删除", () => {
    expect(resolveInvalidatedKind(9)).toBe("removed_by_uploader");
  });

  it("未知取值归入 other，不当作正常", () => {
    expect(resolveInvalidatedKind(16)).toBe("other");
    expect(resolveInvalidatedKind(25)).toBe("other");
  });
});

describe("isInvalidatedResource", () => {
  it("以 attr 为主判定", () => {
    expect(isInvalidatedResource(makeResource(1, { attr: 1 }))).toBe(true);
    expect(isInvalidatedResource(makeResource(1, { attr: 9 }))).toBe(true);
    expect(isInvalidatedResource(makeResource(1, { attr: 0 }))).toBe(false);
  });

  it("attr 缺失时退回标题文案判定", () => {
    // 兜底路径：B 站历史上用过这个文案，且旧数据没有 attr 字段
    expect(isInvalidatedResource(makeResource(1, { title: "已失效视频" }))).toBe(true);
    expect(isInvalidatedResource(makeResource(1, { title: "【正常视频】已失效视频解析" }))).toBe(
      true,
    );
    expect(isInvalidatedResource(makeResource(1, { title: "正常标题" }))).toBe(false);
  });

  it("undefined 不是失效（避免把缺失记录误判成失效）", () => {
    expect(isInvalidatedResource(undefined)).toBe(false);
  });

  it("兜底正则覆盖已知的失效文案", () => {
    expect(INVALIDATED_TITLE_RE.test("已失效视频")).toBe(true);
    expect(INVALIDATED_TITLE_RE.test("稿件不可见")).toBe(true);
    expect(INVALIDATED_TITLE_RE.test("该视频已被删除")).toBe(true);
  });
});

describe("buildVanishCandidates", () => {
  const local = [makeResource(1), makeResource(2), makeResource(3)];

  it("完整全量同步后，在线列表里没有的即为候选", () => {
    const candidates = buildVanishCandidates({
      localResources: local,
      onlineResourceIds: new Set([1, 3]),
      isFullSync: true,
      allPagesFetched: true,
    });

    expect(candidates.map((item) => item.id)).toEqual([2]);
  });

  it("关键负例：增量同步绝不产生候选", () => {
    // 增量同步只翻前几页，未出现的条目不代表消失
    const candidates = buildVanishCandidates({
      localResources: local,
      onlineResourceIds: new Set([1]),
      isFullSync: false,
      allPagesFetched: true,
    });

    expect(candidates).toEqual([]);
  });

  it("关键负例：未完整翻页时绝不产生候选", () => {
    // 一次网络抖动导致中途失败，若不拦住会把整页误判为消失
    const candidates = buildVanishCandidates({
      localResources: local,
      onlineResourceIds: new Set([1]),
      isFullSync: true,
      allPagesFetched: false,
    });

    expect(candidates).toEqual([]);
  });

  it("两个前提都不满足时也不产生候选", () => {
    expect(
      buildVanishCandidates({
        localResources: local,
        onlineResourceIds: new Set(),
        isFullSync: false,
        allPagesFetched: false,
      }),
    ).toEqual([]);
  });

  it("全部在线时没有候选", () => {
    expect(
      buildVanishCandidates({
        localResources: local,
        onlineResourceIds: new Set([1, 2, 3]),
        isFullSync: true,
        allPagesFetched: true,
      }),
    ).toEqual([]);
  });
});

describe("classifyViewProbe", () => {
  it("code 0 表示视频还在，即你取消了收藏", () => {
    expect(classifyViewProbe({ ok: true, code: 0 })).toBe("unfavorited");
  });

  it("-404 表示稿件不存在", () => {
    expect(classifyViewProbe({ ok: true, code: -404 })).toBe("content_deleted");
  });

  it("62002 表示稿件不可见（可能转为私密）", () => {
    expect(classifyViewProbe({ ok: true, code: 62002 })).toBe("content_hidden");
  });

  it("关键负例：请求失败归为原因不明，而不是任何「可以删」的结论", () => {
    expect(classifyViewProbe({ ok: false, code: null, message: "探测超时" })).toBe("unknown");
    expect(classifyViewProbe({ ok: true, code: null })).toBe("unknown");
  });

  it("风控等未预期返回码归为原因不明", () => {
    expect(classifyViewProbe({ ok: true, code: -352 })).toBe("unknown");
    expect(classifyViewProbe({ ok: true, code: -101 })).toBe("unknown");
  });
});

describe("buildVanishedRecord", () => {
  it("冗余保存消失前的标题与封面", () => {
    const resource = makeResource(7, { title: "消失前的标题", cover: "https://x/cover.jpg" });

    const record = buildVanishedRecord(resource, "content_deleted", NOW);

    expect(record.lastKnownTitle).toBe("消失前的标题");
    expect(record.lastKnownCover).toBe("https://x/cover.jpg");
    expect(record.vanishedAt).toBe(NOW);
    expect(record.vanishReason).toBe("content_deleted");
    expect(record.probeAttemptedAt).toBe(NOW);
    expect(record.probeError).toBeUndefined();
  });

  it("保留原记录的全部字段，便于以后还原", () => {
    const resource = makeResource(7);

    const record = buildVanishedRecord(resource, "unfavorited", NOW);

    expect(record.id).toBe(7);
    expect(record.folder_id).toBe(100);
    expect(record.bvid).toBe("BV1xx7");
    expect(record.fav_time).toBe(1);
  });

  it("探测失败时记录错误信息", () => {
    const record = buildVanishedRecord(makeResource(7), "unknown", NOW, "HTTP 503");

    expect(record.probeError).toBe("HTTP 503");
    expect(record.vanishReason).toBe("unknown");
  });
});

describe("标签映射", () => {
  it("每种消失原因都有中文标签", () => {
    const reasons: FavVanishReason[] = [
      "unfavorited",
      "content_deleted",
      "content_hidden",
      "unknown",
    ];
    for (const reason of reasons) {
      expect(VANISH_REASON_LABEL[reason]).toBeTruthy();
    }
  });

  it("每种失效类型都有中文标签", () => {
    expect(INVALIDATED_KIND_LABEL.removed_by_other).toBeTruthy();
    expect(INVALIDATED_KIND_LABEL.removed_by_uploader).toBe("UP 主自己删除");
    expect(INVALIDATED_KIND_LABEL.other).toBeTruthy();
  });
});

const makeVanished = (
  id: number,
  reason: FavVanishReason,
  patch: Partial<VanishedFavResource> = {},
): VanishedFavResource => ({
  ...makeResource(id, patch),
  vanishedAt: patch.vanishedAt ?? NOW,
  vanishReason: reason,
  lastKnownTitle: patch.lastKnownTitle ?? `视频 ${id}`,
  ...patch,
});

describe("buildVanishedStats", () => {
  it("按原因分别计数", () => {
    const stats = buildVanishedStats([
      makeVanished(1, "unfavorited"),
      makeVanished(2, "unfavorited"),
      makeVanished(3, "content_deleted"),
      makeVanished(4, "unknown"),
    ]);

    expect(stats.total).toBe(4);
    expect(stats.byReason.unfavorited).toBe(2);
    expect(stats.byReason.content_deleted).toBe(1);
    expect(stats.byReason.content_hidden).toBe(0);
    expect(stats.byReason.unknown).toBe(1);
  });

  it("空档案返回全 0", () => {
    expect(buildVanishedStats([]).total).toBe(0);
  });

  it("遇到未预期的原因取值时归入 unknown，不炸也不漏计", () => {
    const stats = buildVanishedStats([
      makeVanished(1, "brand_new_reason" as FavVanishReason),
    ]);
    expect(stats.total).toBe(1);
    expect(stats.byReason.unknown).toBe(1);
  });
});

describe("queryVanishedResources", () => {
  const items = [
    makeVanished(1, "unfavorited", { vanishedAt: 100, lastKnownTitle: "猫猫视频" }),
    makeVanished(2, "content_deleted", { vanishedAt: 300, lastKnownTitle: "狗狗视频" }),
    makeVanished(3, "content_deleted", { vanishedAt: 200, folder_id: 999 }),
  ];

  it("默认按消失时间倒序", () => {
    expect(queryVanishedResources(items).map((item) => item.id)).toEqual([2, 3, 1]);
  });

  it("按原因筛选", () => {
    const result = queryVanishedResources(items, { reason: "content_deleted" });
    expect(result.map((item) => item.id)).toEqual([2, 3]);
  });

  it("按收藏夹筛选", () => {
    const result = queryVanishedResources(items, { folderId: 999 });
    expect(result.map((item) => item.id)).toEqual([3]);
  });

  it("关键词命中消失前的标题", () => {
    // 关键：档案的 title 可能已被占位内容覆盖，检索必须走 lastKnownTitle
    const result = queryVanishedResources(items, { keyword: "猫猫" });
    expect(result.map((item) => item.id)).toEqual([1]);
  });

  it("关键词也命中 UP 主名与 BV 号", () => {
    expect(queryVanishedResources(items, { keyword: "BV1xx2" }).map((item) => item.id)).toEqual([2]);
    expect(queryVanishedResources(items, { keyword: "UP" }).length).toBe(3);
  });

  it("多个条件同时生效", () => {
    const result = queryVanishedResources(items, {
      reason: "content_deleted",
      folderId: 100,
    });
    expect(result.map((item) => item.id)).toEqual([2]);
  });

  it("没有命中时返回空数组", () => {
    expect(queryVanishedResources(items, { keyword: "不存在的关键词" })).toEqual([]);
  });
});
