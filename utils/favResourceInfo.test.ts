import { describe, expect, it } from "vitest";
import {
  FAV_RESOURCE_STATE_HINT,
  FAV_RESOURCE_STATE_LABEL,
  buildResourceCopyText,
  resolveFavResourceBadge,
  resolveFavResourceHint,
  resolveFavResourceState,
} from "./favResourceInfo";
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
  duration: 437,
  upper: { mid: 247177563, name: "俺是帮帮龙", face: "" },
  cnt_info: { collect: 36203, play: 2185453, danmaku: 15301 },
  link: `bilibili://video/${id}`,
  ctime: 1,
  pubtime: 1780794000,
  fav_time: 1782551572,
  bv_id: "",
  bvid: "BV1RLEp6KEKi",
  folder_id: 100,
  index: 0,
  attr: 0,
  ...patch,
});

describe("resolveFavResourceState", () => {
  it("正常条目是 normal", () => {
    expect(resolveFavResourceState(makeResource(1))).toBe("normal");
  });

  it("失效但已有真实信息的是 repaired", () => {
    const repaired = makeResource(1, { attr: 1, title: "失效前的标题", cover: "https://x/r.jpg" });
    expect(resolveFavResourceState(repaired)).toBe("repaired");
  });

  it("第三方恢复过的算 repaired", () => {
    const recovered = makeResource(1, {
      attr: 1,
      title: "私自乱吃激素误入歧途的男娘",
      cover: "https://x/r.jpg",
      recoveredAt: NOW,
    });
    expect(resolveFavResourceState(recovered)).toBe("repaired");
  });

  it("失效且仍是占位内容的是 broken", () => {
    const broken = makeResource(1, { attr: 1, title: "已失效视频", cover: PLACEHOLDER_COVER });
    expect(resolveFavResourceState(broken)).toBe("broken");
  });

  it("标题已保住但封面仍是占位图 → broken（封面还能救）", () => {
    const half = makeResource(1, { attr: 1, title: "真实标题", cover: PLACEHOLDER_COVER });
    expect(resolveFavResourceState(half)).toBe("broken");
  });

  it("三种状态都有标签，normal 的标签为空（界面上不显示徽章）", () => {
    expect(FAV_RESOURCE_STATE_LABEL.normal).toBe("");
    expect(FAV_RESOURCE_STATE_LABEL.repaired).toBe("已保留");
    expect(FAV_RESOURCE_STATE_LABEL.broken).toBe("已失效");
    expect(FAV_RESOURCE_STATE_HINT.repaired).toBeTruthy();
    expect(FAV_RESOURCE_STATE_HINT.broken).toBeTruthy();
  });
});

describe("resolveFavResourceBadge", () => {
  it("正常条目不显示徽章", () => {
    expect(resolveFavResourceBadge(makeResource(1))).toBe("");
  });

  it("失效且信息缺失显示「已失效」", () => {
    const broken = makeResource(1, { attr: 1, title: "已失效视频", cover: PLACEHOLDER_COVER });
    expect(resolveFavResourceBadge(broken)).toBe("已失效");
  });

  it("失效前就存下信息显示「已保留」", () => {
    const preserved = makeResource(1, { attr: 1, title: "真实标题", cover: "https://x/r.jpg" });
    expect(resolveFavResourceBadge(preserved)).toBe("已保留");
  });

  it("关键区分：第三方恢复来的显示「已恢复」而不是「已保留」", () => {
    // 对用户来说两者含义不同：一个是本来就在，一个是找回来的
    const recovered = makeResource(1, {
      attr: 1,
      title: "私自乱吃激素误入歧途的男娘",
      cover: "https://x/r.jpg",
      recoveredAt: NOW,
      recoverySource: "biliplus",
    });
    expect(resolveFavResourceBadge(recovered)).toBe("已恢复");
    expect(resolveFavResourceHint(recovered)).toContain("第三方档案");
  });

  it("提示文案与徽章一致", () => {
    expect(resolveFavResourceHint(makeResource(1))).toBe("");
    expect(
      resolveFavResourceHint(
        makeResource(1, { attr: 1, title: "已失效视频", cover: PLACEHOLDER_COVER }),
      ),
    ).toContain("恢复失效内容");
  });
});

describe("buildResourceCopyText", () => {
  it("包含最基本的四个字段", () => {
    const text = buildResourceCopyText(makeResource(116704059399752));

    expect(text).toContain("AV号：116704059399752");
    expect(text).toContain("BV号：BV1RLEp6KEKi");
    expect(text).toContain("标题：视频 116704059399752");
    expect(text).toContain("UP主：俺是帮帮龙");
    expect(text).toContain("https://space.bilibili.com/247177563");
  });

  it("时长、时间与统计数按可读格式输出", () => {
    const text = buildResourceCopyText(makeResource(1));

    expect(text).toContain("时长：07:17");
    expect(text).toContain("播放数：2185453");
    expect(text).toContain("收藏数：36203");
    expect(text).toContain("弹幕数：15301");
    expect(text).toContain("收藏时间：");
    expect(text).toContain("发布时间：");
  });

  it("简介为空时不输出该行（不留空行占位）", () => {
    expect(buildResourceCopyText(makeResource(1, { intro: "" }))).not.toContain("简介：");
    expect(buildResourceCopyText(makeResource(1, { intro: "男娘" }))).toContain("简介：男娘");
  });

  it("失效条目输出失效原因，含 attr 原始值便于核对", () => {
    const text = buildResourceCopyText(
      makeResource(1, { attr: 1, title: "已失效视频", cover: PLACEHOLDER_COVER }),
    );

    expect(text).toContain("失效原因：其他原因删除/退回（attr=1）");
    expect(text).toContain("信息来源：失效前本地保存");
  });

  it("UP 主自己删除与未知取值都能正确标注", () => {
    expect(buildResourceCopyText(makeResource(1, { attr: 9 }))).toContain("UP 主自己删除（attr=9）");
    expect(buildResourceCopyText(makeResource(1, { attr: 25 }))).toContain("其他原因（attr=25）");
  });

  it("已恢复的条目标明具体来源", () => {
    const viaBiliplus = buildResourceCopyText(
      makeResource(1, { attr: 1, recoveredAt: NOW, recoverySource: "biliplus" }),
    );
    expect(viaBiliplus).toContain("信息来源：第三方档案 biliplus");
    expect(viaBiliplus).not.toContain("失效前本地保存");

    const viaJijidown = buildResourceCopyText(
      makeResource(1, { attr: 1, recoveredAt: NOW, recoverySource: "jijidown" }),
    );
    expect(viaJijidown).toContain("信息来源：第三方档案 jijidown");
  });

  it("分P标题推测出来的要标明是推测，不能冒充官方标题", () => {
    const text = buildResourceCopyText(
      makeResource(1, {
        attr: 1,
        recoveredAt: NOW,
        recoverySource: "bilibili_pages",
        title: "studio_video_123.mp4（视频投稿上传时的标题）",
      }),
    );
    expect(text).toContain("信息来源：B站 分P标题推测");
    expect(text).toContain("（视频投稿上传时的标题）");
  });

  it("正常条目不输出失效原因与信息来源", () => {
    const text = buildResourceCopyText(makeResource(1));
    expect(text).not.toContain("失效原因");
    expect(text).not.toContain("信息来源");
  });

  it("UP 主信息缺失时不输出空链接", () => {
    const text = buildResourceCopyText(makeResource(1, { upper: { mid: 0, name: "", face: "" } }));
    expect(text).toContain("UP主：未知");
  });

  it("BV 号缺失时给出明确占位而不是 undefined", () => {
    const text = buildResourceCopyText(makeResource(1, { bvid: "", bv_id: "" }));
    expect(text).toContain("BV号：（无）");
    expect(text).not.toContain("undefined");
  });
});
