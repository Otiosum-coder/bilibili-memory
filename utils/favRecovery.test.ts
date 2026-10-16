import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER_TITLE,
  applyGuessedTitle,
  applyPublicMedia,
  applyRecoveryResult,
  buildRecoveryCandidates,
  buildRecoveryStats,
  chunkAids,
  isBetterCover,
  isBetterTitle,
  isBetterUpperName,
  isPlaceholderTitle,
  isValidAid,
  needsRecovery,
  resolveGuessedTitle,
  shouldPreserveLocalMetadata,
  toValidAid,
} from "./favRecovery";
import { PLACEHOLDER_COVER_PATH } from "./imageUrl";
import type { FavoriteResource } from "./types";

const NOW = 1_800_000_000_000;
const PLACEHOLDER_COVER = `https://i0.hdslb.com${PLACEHOLDER_COVER_PATH}`;

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
  attr: 0,
  ...patch,
});

/** B站 已把标题与封面替换为占位内容的那种条目 */
const makeInvalid = (id: number, patch: Partial<FavoriteResource> = {}): FavoriteResource =>
  makeResource(id, { attr: 1, title: PLACEHOLDER_TITLE, cover: PLACEHOLDER_COVER, ...patch });

describe("isPlaceholderTitle", () => {
  it("空标题与 B站 占位文案都算占位", () => {
    expect(isPlaceholderTitle(PLACEHOLDER_TITLE)).toBe(true);
    expect(isPlaceholderTitle("")).toBe(true);
    expect(isPlaceholderTitle("   ")).toBe(true);
    expect(isPlaceholderTitle(undefined)).toBe(true);
  });

  it("真实标题不算占位", () => {
    expect(isPlaceholderTitle("【MV】保加利亚妖王")).toBe(false);
  });
});

describe("needsRecovery", () => {
  it("失效且标题或封面是占位时需要恢复", () => {
    expect(needsRecovery(makeInvalid(1))).toBe(true);
    expect(needsRecovery(makeInvalid(1, { title: "真实标题" }))).toBe(true); // 封面仍是占位
    expect(needsRecovery(makeInvalid(1, { cover: "https://x/real.jpg" }))).toBe(true); // 标题仍是占位
  });

  it("未失效的条目不需要恢复", () => {
    expect(needsRecovery(makeResource(1))).toBe(false);
  });

  it("已完全恢复的条目（标题与封面都真实）不再需要恢复", () => {
    const fixed = makeInvalid(1, {
      recoveredAt: NOW,
      title: "恢复的标题",
      cover: "https://x/r.jpg",
    });
    expect(needsRecovery(fixed)).toBe(false);
  });

  it("关键：只补了标题的条目仍需要恢复，否则封面永远补不上", () => {
    // 判定依据是「现在缺什么」，不是「有没有补过」
    const partial = makeInvalid(1, { recoveredAt: NOW, title: "恢复的标题" });
    expect(needsRecovery(partial)).toBe(true);
  });

  it("关键：只补了封面的条目仍需要恢复", () => {
    const partial = makeInvalid(1, { recoveredAt: NOW, cover: "https://x/r.jpg" });
    expect(needsRecovery(partial)).toBe(true);
  });

  it("关键：本地已保留真实元数据的失效条目无需恢复", () => {
    // saveFavResources 的失效保护会在失效前同步过的情况下保住旧数据
    const preserved = makeInvalid(1, { title: "失效前的真实标题", cover: "https://x/real.jpg" });
    expect(needsRecovery(preserved)).toBe(false);
  });

  it("标题与封面都仍是占位时才判定为待恢复（两者之一就好）", () => {
    expect(needsRecovery(makeInvalid(1, { title: "真实标题", cover: "https://x/real.jpg" }))).toBe(
      false,
    );
  });
});

describe("buildRecoveryCandidates", () => {
  it("过滤出待恢复条目，并保持输入顺序", () => {
    const resources = [
      makeInvalid(1, { invalidatedKind: "removed_by_other" }),
      makeResource(2), // 正常，不参与
      makeInvalid(3, { invalidatedKind: "removed_by_uploader" }),
      makeInvalid(4, { invalidatedKind: "other" }),
      makeInvalid(5), // 无 kind
    ];

    // 曾按 attr 分类排序，但该依据已被真实样本推翻（attr 1 同样可恢复），
    // 所以现在只保证顺序稳定，不做优先级假设
    expect(buildRecoveryCandidates(resources).map((item) => item.id)).toEqual([1, 3, 4, 5]);
  });

  it("顺序稳定，重复调用结果一致", () => {
    const resources = [makeInvalid(10), makeInvalid(11), makeInvalid(12)];
    expect(buildRecoveryCandidates(resources).map((item) => item.id)).toEqual([10, 11, 12]);
    expect(buildRecoveryCandidates(resources).map((item) => item.id)).toEqual([10, 11, 12]);
  });

  it("尊重 limit", () => {
    const resources = [makeInvalid(1), makeInvalid(2), makeInvalid(3)];
    expect(buildRecoveryCandidates(resources, 2).map((item) => item.id)).toEqual([1, 2]);
  });

  it("没有待恢复条目时返回空数组", () => {
    expect(buildRecoveryCandidates([makeResource(1), makeResource(2)])).toEqual([]);
  });

  it("关键：aid 非法的记录不进入候选（否则会拖垮整批请求）", () => {
    const resources = [
      makeInvalid(1),
      makeInvalid(0), // aid 0
      makeInvalid(-5), // 负数
      makeInvalid(3),
    ];
    expect(buildRecoveryCandidates(resources).map((item) => item.id)).toEqual([1, 3]);
  });
});

describe("isValidAid 与 toValidAid", () => {
  it("正整数才合法", () => {
    expect(isValidAid(1)).toBe(true);
    expect(isValidAid(116704059399752)).toBe(true);
    expect(isValidAid(0)).toBe(false);
    expect(isValidAid(-1)).toBe(false);
    expect(isValidAid(1.5)).toBe(false);
    expect(isValidAid(Number.NaN)).toBe(false);
    expect(isValidAid(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidAid("123")).toBe(false);
    expect(isValidAid(undefined)).toBe(false);
    expect(isValidAid(null)).toBe(false);
  });

  it("toValidAid 从记录里取出 aid，非法返回 null", () => {
    expect(toValidAid(makeResource(42))).toBe(42);
    expect(toValidAid(makeResource(0))).toBeNull();
    expect(toValidAid(makeResource(Number.NaN))).toBeNull();
  });
});

describe("chunkAids", () => {
  it("按大小切分并保留余数", () => {
    expect(chunkAids([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it("空数组返回空", () => {
    expect(chunkAids([], 20)).toEqual([]);
  });

  it("大小非法时至少为 1，不会死循环", () => {
    expect(chunkAids([1, 2], 0)).toEqual([[1], [2]]);
    expect(chunkAids([1, 2], -5)).toEqual([[1], [2]]);
  });

  it("恰好整除时不多出空块", () => {
    expect(chunkAids([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });
});

describe("优劣判定", () => {
  it("只有占位标题才会被真实标题替换", () => {
    expect(isBetterTitle(PLACEHOLDER_TITLE, "真实标题")).toBe(true);
    expect(isBetterTitle("", "真实标题")).toBe(true);
    expect(isBetterTitle("本地真实标题", "另一个标题")).toBe(false);
    expect(isBetterTitle(PLACEHOLDER_TITLE, PLACEHOLDER_TITLE)).toBe(false);
    expect(isBetterTitle(PLACEHOLDER_TITLE, "")).toBe(false);
  });

  it("占位封面才会被真实封面替换", () => {
    expect(isBetterCover(PLACEHOLDER_COVER, "https://x/real.jpg")).toBe(true);
    expect(isBetterCover("", "https://x/real.jpg")).toBe(true);
    expect(isBetterCover("https://x/local.jpg", "https://x/real.jpg")).toBe(false);
    expect(isBetterCover(PLACEHOLDER_COVER, PLACEHOLDER_COVER)).toBe(false);
  });

  it("账号已注销与空名会被真实 UP 名替换", () => {
    expect(isBetterUpperName("账号已注销", "真实UP")).toBe(true);
    expect(isBetterUpperName("", "真实UP")).toBe(true);
    expect(isBetterUpperName("真实UP", "另一个UP")).toBe(false);
    expect(isBetterUpperName("账号已注销", "账号已注销")).toBe(false);
  });
});

describe("applyRecoveryResult", () => {
  const info = {
    title: "【电影】后会无期",
    pic: "https://i0.hdslb.com/bfs/archive/real.jpg",
    author: "AR·M⑨R",
    mid: 4694544,
  };

  it("把占位内容替换为真实数据并记录来源", () => {
    const outcome = applyRecoveryResult(makeInvalid(3), info, "biliplus", NOW);

    expect(outcome.changed).toBe(true);
    expect(outcome.resource.title).toBe("【电影】后会无期");
    expect(outcome.resource.cover).toBe("https://i0.hdslb.com/bfs/archive/real.jpg");
    expect(outcome.resource.recoveredAt).toBe(NOW);
    expect(outcome.resource.recoverySource).toBe("biliplus");
    expect(outcome.fields).toContain("title");
    expect(outcome.fields).toContain("cover");
  });

  it("B站 对失效稿件仍保留 UP 信息，所以真实 UP 名不该被替换", () => {
    // Phase 1b 实测：失效条目仍带 bvid 与完整 upper 信息，丢的是标题与封面
    const outcome = applyRecoveryResult(makeInvalid(3), info, "biliplus", NOW);

    expect(outcome.resource.upper.name).toBe("UP");
    expect(outcome.fields).not.toContain("upper.name");
  });

  it("UP 名是占位时才会被替换", () => {
    const outcome = applyRecoveryResult(
      makeInvalid(3, { upper: { mid: 0, name: "账号已注销", face: "" } }),
      info,
      "biliplus",
      NOW,
    );

    expect(outcome.resource.upper.name).toBe("AR·M⑨R");
    expect(outcome.fields).toContain("upper.name");
  });

  it("关键负例：绝不覆盖本地已有的真实元数据", () => {
    const local = makeInvalid(3, { title: "失效前的真实标题", cover: "https://x/local.jpg" });

    const outcome = applyRecoveryResult(local, info, "biliplus", NOW);

    // 标题与封面都不该被动，UP 名因为是占位所以可以补
    expect(outcome.resource.title).toBe("失效前的真实标题");
    expect(outcome.resource.cover).toBe("https://x/local.jpg");
    expect(outcome.fields).not.toContain("title");
    expect(outcome.fields).not.toContain("cover");
  });

  it("查询无结果时原样返回，不标记为已恢复", () => {
    const outcome = applyRecoveryResult(makeInvalid(3), undefined, "biliplus", NOW);

    expect(outcome.changed).toBe(false);
    expect(outcome.resource.recoveredAt).toBeUndefined();
    expect(outcome.resource.title).toBe(PLACEHOLDER_TITLE);
  });

  it("结果全无价值时不算变更", () => {
    const outcome = applyRecoveryResult(
      makeInvalid(3, { upper: { mid: 1, name: "真实UP", face: "" } }),
      { title: PLACEHOLDER_TITLE, pic: PLACEHOLDER_COVER, author: "账号已注销" },
      "biliplus",
      NOW,
    );

    expect(outcome.changed).toBe(false);
    expect(outcome.resource.recoveredAt).toBeUndefined();
  });

  it("补齐缺失的 UP mid", () => {
    const outcome = applyRecoveryResult(
      makeInvalid(3, { upper: { mid: 0, name: "", face: "" } }),
      info,
      "biliplus",
      NOW,
    );
    expect(outcome.resource.upper.mid).toBe(4694544);
    expect(outcome.fields).toContain("upper.mid");
  });
});

describe("resolveGuessedTitle 与 applyGuessedTitle", () => {
  it("单分P 稿件的分P标题可以还原稿件标题，并追加推测后缀", () => {
    const resource = makeInvalid(3, { pages: [{ title: "studio_video_1780840034214.mp4" }] });
    expect(resolveGuessedTitle(resource)).toBe(
      "studio_video_1780840034214.mp4（视频投稿上传时的标题）",
    );
  });

  it("多分P 时不采用——那时第一P 标题是子标题，还原出来是错的", () => {
    const resource = makeInvalid(3, {
      pages: [{ title: "第一P" }, { title: "第二P" }],
    });
    expect(resolveGuessedTitle(resource)).toBeNull();
  });

  it("分P标题本身是占位或空时不采用", () => {
    expect(resolveGuessedTitle(makeInvalid(3, { pages: [{ title: PLACEHOLDER_TITLE }] }))).toBeNull();
    expect(resolveGuessedTitle(makeInvalid(3, { pages: [{ title: "   " }] }))).toBeNull();
    expect(resolveGuessedTitle(makeInvalid(3, { pages: [{}] }))).toBeNull();
  });

  it("没有分P 信息时不采用（老数据可能没有该字段）", () => {
    expect(resolveGuessedTitle(makeInvalid(3))).toBeNull();
    expect(resolveGuessedTitle(makeInvalid(3, { pages: [] }))).toBeNull();
  });

  it("本地标题仍是占位时才用分P标题还原", () => {
    const outcome = applyGuessedTitle(
      makeInvalid(3, { pages: [{ title: "studio_video_123.mp4" }] }),
      NOW,
    );

    expect(outcome.changed).toBe(true);
    expect(outcome.resource.title).toBe("studio_video_123.mp4（视频投稿上传时的标题）");
    expect(outcome.resource.recoveredAt).toBe(NOW);
    expect(outcome.resource.recoverySource).toBe("bilibili_pages");
  });

  it("本地标题已真实时不动它（不能把好数据换成推测）", () => {
    const outcome = applyGuessedTitle(
      makeInvalid(3, { title: "真实标题", pages: [{ title: "别的" }] }),
      NOW,
    );
    expect(outcome.changed).toBe(false);
    expect(outcome.resource.title).toBe("真实标题");
  });

  it("没有可用的分P标题时不算变更", () => {
    const outcome = applyGuessedTitle(makeInvalid(3), NOW);
    expect(outcome.changed).toBe(false);
    expect(outcome.resource.recoveredAt).toBeUndefined();
  });
});

describe("applyPublicMedia", () => {
  const pagesPayload = { title: "真实标题", cover: "https://x/real.jpg", page: 1, pages: [{ title: "真实标题" }] };

  it("补上鉴权接口不给的分P 信息", () => {
    const outcome = applyPublicMedia(makeInvalid(3), { pages: [{ title: "某分P" }] }, NOW);

    expect(outcome.changed).toBe(true);
    expect(outcome.resource.pages).toEqual([{ title: "某分P" }]);
    expect(outcome.fields).toContain("pages");
  });

  it("单分P 时补 pages 会顺带把标题也还原（这就是它的价值）", () => {
    const outcome = applyPublicMedia(makeInvalid(3), { pages: [{ title: "某分P" }] }, NOW);

    expect(outcome.resource.title).toBe("某分P（视频投稿上传时的标题）");
    expect(outcome.resource.recoveredAt).toBe(NOW);
  });

  it("关键：只补到 pages 时不算「已恢复」——分P信息不是内容", () => {
    // 多分P 时无法从分P标题推断稿件标题（那是子标题），所以只有 pages 变化、
    // 没有任何内容改善。此时若打上 recoveredAt，界面会谎报"已找回"。
    const outcome = applyPublicMedia(
      makeInvalid(3),
      { pages: [{ title: "第一P" }, { title: "第二P" }] },
      NOW,
    );

    expect(outcome.changed).toBe(true);
    expect(outcome.fields).toEqual(["pages"]);
    expect(outcome.resource.recoveredAt).toBeUndefined();
    expect(outcome.resource.title).toBe(PLACEHOLDER_TITLE);
  });

  it("公开接口给了真实标题就直接采用", () => {
    const outcome = applyPublicMedia(makeInvalid(3), pagesPayload, NOW);

    expect(outcome.resource.title).toBe("真实标题");
    expect(outcome.resource.cover).toBe("https://x/real.jpg");
    expect(outcome.resource.recoveredAt).toBe(NOW);
    expect(outcome.resource.recoverySource).toBe("bilibili_public");
  });

  it("标题仍是占位但有单分P 信息时，就地用分P标题还原", () => {
    const outcome = applyPublicMedia(
      makeInvalid(3),
      { pages: [{ title: "studio_video_123.mp4" }] },
      NOW,
    );

    expect(outcome.resource.title).toBe("studio_video_123.mp4（视频投稿上传时的标题）");
    expect(outcome.resource.recoverySource).toBe("bilibili_pages");
    expect(outcome.fields).toContain("title_by_pages");
  });

  it("不覆盖本地已有的真实数据", () => {
    const local = makeInvalid(3, { title: "本地真实标题", cover: "https://x/local.jpg" });
    const outcome = applyPublicMedia(local, pagesPayload, NOW);

    expect(outcome.resource.title).toBe("本地真实标题");
    expect(outcome.resource.cover).toBe("https://x/local.jpg");
  });

  it("没有 media 时原样返回", () => {
    const outcome = applyPublicMedia(makeInvalid(3), undefined, NOW);
    expect(outcome.changed).toBe(false);
  });

  it("media 没有任何值得采用的信息时不算变更", () => {
    const outcome = applyPublicMedia(makeInvalid(3), { title: PLACEHOLDER_TITLE }, NOW);
    expect(outcome.changed).toBe(false);
  });
});

describe("shouldPreserveLocalMetadata", () => {
  it("关键：恢复来的数据必须被保护，否则下次同步会被占位内容覆盖", () => {
    const recovered = makeInvalid(1, { title: "恢复的标题", recoveredAt: NOW });
    expect(shouldPreserveLocalMetadata(recovered)).toBe(true);
  });

  it("本地仍是有效元数据时被保护", () => {
    expect(shouldPreserveLocalMetadata(makeResource(1))).toBe(true);
  });

  it("本地就是占位内容时不保护（让新数据覆盖）", () => {
    expect(shouldPreserveLocalMetadata(makeInvalid(1))).toBe(false);
  });

  it("没有本地记录时不保护", () => {
    expect(shouldPreserveLocalMetadata(undefined)).toBe(false);
  });
});

describe("buildRecoveryStats", () => {
  it("分别统计失效、完好与待恢复", () => {
    const stats = buildRecoveryStats([
      makeResource(1), // 正常，完全不参与统计
      makeInvalid(2), // 待恢复
      makeInvalid(3, { title: "失效前标题", cover: "https://x/real.jpg" }), // 完好（已保护）
      makeInvalid(4, { recoveredAt: NOW, title: "恢复的标题", cover: "https://x/r.jpg" }), // 已恢复
    ]);

    expect(stats.total).toBe(4);
    expect(stats.invalid).toBe(3);
    expect(stats.pending).toBe(1);
    // intact 只数「失效但已有真实元数据」的，不是「所有标题正常的条目」
    expect(stats.intact).toBe(2);
  });

  it("没有失效条目时三个计数都是 0", () => {
    const stats = buildRecoveryStats([makeResource(1), makeResource(2)]);
    expect(stats.invalid).toBe(0);
    expect(stats.intact).toBe(0);
    expect(stats.pending).toBe(0);
  });

  it("空列表返回全 0", () => {
    expect(buildRecoveryStats([])).toEqual({ total: 0, invalid: 0, intact: 0, pending: 0 });
  });
});
