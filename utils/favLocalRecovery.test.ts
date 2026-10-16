import { describe, expect, it } from "vitest";
import {
  LOCAL_COVER_SOURCE_LABEL,
  applyLocalCover,
  buildLocalCoverIndex,
  resourceBvid,
} from "./favLocalRecovery";
import { PLACEHOLDER_COVER_PATH } from "./imageUrl";
import type { FavoriteResource } from "./types";

const NOW = 1_800_000_000_000;
const PLACEHOLDER_COVER = `https://i0.hdslb.com${PLACEHOLDER_COVER_PATH}`;

const makeResource = (id: number, patch: Partial<FavoriteResource> = {}): FavoriteResource => ({
  id,
  type: 2,
  title: "已失效视频",
  cover: PLACEHOLDER_COVER,
  intro: "",
  duration: 1,
  upper: { mid: 1, name: "UP", face: "" },
  cnt_info: { collect: 0, play: 0, danmaku: 0 },
  link: "",
  ctime: 1,
  pubtime: 1,
  fav_time: 1,
  bv_id: "",
  bvid: "BV1RLEp6KEKi",
  folder_id: 100,
  index: 0,
  attr: 1,
  ...patch,
});

describe("buildLocalCoverIndex", () => {
  it("从观看历史建立索引", () => {
    const index = buildLocalCoverIndex({
      history: [{ bvid: "BV1aa", cover: "https://x/history.jpg" }],
    });

    expect(index.get("BV1aa")).toEqual({ cover: "https://x/history.jpg", source: "history" });
  });

  it("喜欢的音乐用 pic 字段", () => {
    const index = buildLocalCoverIndex({
      likedMusic: [{ bvid: "BV1bb", pic: "https://x/liked.jpg" }],
    });

    expect(index.get("BV1bb")?.source).toBe("likedMusic");
    expect(index.get("BV1bb")?.cover).toBe("https://x/liked.jpg");
  });

  it("订阅合集内容也纳入", () => {
    const index = buildLocalCoverIndex({
      collectionResources: [{ bvid: "BV1cc", cover: "https://x/collection.jpg" }],
    });

    expect(index.get("BV1cc")?.source).toBe("collection");
  });

  it("关键：占位封面不进索引", () => {
    // 否则会给失效条目"匹配"到另一个占位封面，白忙一场
    const index = buildLocalCoverIndex({
      history: [{ bvid: "BV1aa", cover: PLACEHOLDER_COVER }],
    });

    expect(index.size).toBe(0);
  });

  it("缺少 bvid 或封面时跳过", () => {
    const index = buildLocalCoverIndex({
      history: [{ bvid: "", cover: "https://x/a.jpg" }, { bvid: "BV1aa", cover: "" }, {}],
    });

    expect(index.size).toBe(0);
  });

  it("同一个 bvid 先到先得，不互相覆盖", () => {
    const index = buildLocalCoverIndex({
      history: [{ bvid: "BV1aa", cover: "https://x/history.jpg" }],
      likedMusic: [{ bvid: "BV1aa", pic: "https://x/liked.jpg" }],
    });

    expect(index.size).toBe(1);
    expect(index.get("BV1aa")?.source).toBe("history");
  });

  it("空输入返回空索引", () => {
    expect(buildLocalCoverIndex({}).size).toBe(0);
  });

  it("每种来源都有中文标签", () => {
    expect(LOCAL_COVER_SOURCE_LABEL.history).toBeTruthy();
    expect(LOCAL_COVER_SOURCE_LABEL.likedMusic).toBeTruthy();
    expect(LOCAL_COVER_SOURCE_LABEL.collection).toBeTruthy();
  });
});

describe("resourceBvid", () => {
  it("优先用 bvid", () => {
    expect(resourceBvid(makeResource(1, { bvid: "BV1aa", bv_id: "BV1bb" }))).toBe("BV1aa");
  });

  it("bvid 缺失时回退到 bv_id", () => {
    expect(resourceBvid(makeResource(1, { bvid: "", bv_id: "BV1bb" }))).toBe("BV1bb");
  });

  it("都没有时返回空串，便于直接做 Map 查询", () => {
    expect(resourceBvid(makeResource(1, { bvid: "", bv_id: "" }))).toBe("");
  });
});

describe("applyLocalCover", () => {
  it("用本地索引里的真实封面替换占位封面", () => {
    const outcome = applyLocalCover(
      makeResource(1),
      { cover: "https://x/real.jpg", source: "history" },
      NOW,
    );

    expect(outcome.changed).toBe(true);
    expect(outcome.resource.cover).toBe("https://x/real.jpg");
    expect(outcome.resource.recoveredAt).toBe(NOW);
    expect(outcome.resource.recoverySource).toBe("local_history");
    expect(outcome.fields).toEqual(["cover"]);
  });

  it("按来源写入对应的 recoverySource", () => {
    expect(
      applyLocalCover(makeResource(1), { cover: "https://x/a.jpg", source: "likedMusic" }, NOW)
        .resource.recoverySource,
    ).toBe("local_liked");
    expect(
      applyLocalCover(makeResource(1), { cover: "https://x/a.jpg", source: "collection" }, NOW)
        .resource.recoverySource,
    ).toBe("local_collection");
  });

  it("关键：只动封面，不动标题——标题仍要走恢复流程", () => {
    const outcome = applyLocalCover(
      makeResource(1, { title: "已失效视频" }),
      { cover: "https://x/real.jpg", source: "history" },
      NOW,
    );

    expect(outcome.resource.title).toBe("已失效视频");
    expect(outcome.fields).not.toContain("title");
  });

  it("本地已有真实封面时不覆盖", () => {
    const resource = makeResource(1, { cover: "https://x/local.jpg" });
    const outcome = applyLocalCover(resource, { cover: "https://x/real.jpg", source: "history" }, NOW);

    expect(outcome.changed).toBe(false);
    expect(outcome.resource.cover).toBe("https://x/local.jpg");
  });

  it("没有匹配到候选时不算变更", () => {
    expect(applyLocalCover(makeResource(1), undefined, NOW).changed).toBe(false);
  });

  it("索引里是占位图时不采用（双重保险）", () => {
    const outcome = applyLocalCover(
      makeResource(1),
      { cover: PLACEHOLDER_COVER, source: "history" },
      NOW,
    );
    expect(outcome.changed).toBe(false);
  });
});
