import { describe, expect, it } from "vitest";
import {
  UTF8_BOM,
  buildFavoritesCsv,
  buildFavoritesMarkdown,
  buildFollowingCsv,
  buildFollowingMarkdown,
  buildVanishedCsv,
  escapeCsvField,
  toCsv,
} from "./humanReadableExport";
import type { FavoriteResource, FollowingItem, VanishedFavResource } from "./types";

const makeFavorite = (id: number, patch: Partial<FavoriteResource> = {}): FavoriteResource => ({
  id,
  type: 2,
  title: `视频 ${id}`,
  cover: "",
  intro: "",
  duration: 437,
  upper: { mid: 9, name: "UP主", face: "" },
  cnt_info: { collect: 3, play: 2185453, danmaku: 1 },
  link: "",
  ctime: 1,
  pubtime: 1,
  fav_time: 1782551572,
  bv_id: "",
  bvid: `BV1xx${id}`,
  folder_id: 100,
  index: 0,
  attr: 0,
  ...patch,
});

const makeFollowing = (mid: number, patch: Partial<FollowingItem> = {}): FollowingItem => ({
  mid,
  name: `UP_${mid}`,
  face: "",
  sign: "",
  mtime: 1782551572,
  attribute: 2,
  special: 0,
  status: "following",
  firstSeenAt: 1,
  lastSeenAt: 1,
  lastSeenInSyncAt: 1,
  nameHistory: [{ name: `UP_${mid}`, seenAt: 1 }],
  ...patch,
});

describe("escapeCsvField", () => {
  it("普通内容原样输出", () => {
    expect(escapeCsvField("普通标题")).toBe("普通标题");
    expect(escapeCsvField(123)).toBe("123");
  });

  it("关键：含逗号的内容必须加引号，否则会多出一列", () => {
    expect(escapeCsvField("标题,带逗号")).toBe('"标题,带逗号"');
  });

  it("关键：内部引号要双写", () => {
    expect(escapeCsvField('他说"你好"')).toBe('"他说""你好"""');
  });

  it("换行会被包进引号（否则一行会变成两行）", () => {
    expect(escapeCsvField("第一行\n第二行")).toBe('"第一行\n第二行"');
  });

  it("null 与 undefined 输出空串", () => {
    expect(escapeCsvField(null)).toBe("");
    expect(escapeCsvField(undefined)).toBe("");
  });
});

describe("toCsv", () => {
  it("关键：带 UTF-8 BOM，否则 Excel 打开中文是乱码", () => {
    expect(toCsv(["标题"], [["测试"]]).startsWith(UTF8_BOM)).toBe(true);
  });

  it("用 CRLF 换行（Excel 兼容更好）", () => {
    const csv = toCsv(["A"], [["1"]]);
    expect(csv).toContain("\r\n");
  });

  it("表头在第一行", () => {
    const lines = toCsv(["列一", "列二"], [["a", "b"]]).replace(UTF8_BOM, "").split("\r\n");
    expect(lines[0]).toBe("列一,列二");
    expect(lines[1]).toBe("a,b");
  });
});

describe("buildFavoritesCsv", () => {
  it("表头覆盖用户真正关心的字段", () => {
    const csv = buildFavoritesCsv([makeFavorite(1)]);
    for (const header of ["AV号", "BV号", "标题", "UP主", "时长", "收藏时间"]) {
      expect(csv).toContain(header);
    }
  });

  it("时长按 mm:ss 输出而不是秒数", () => {
    expect(buildFavoritesCsv([makeFavorite(1, { duration: 437 })])).toContain("07:17");
  });

  it("标题里的逗号不会撑破列数", () => {
    const csv = buildFavoritesCsv([makeFavorite(1, { title: "标题,带逗号,还有" })]);
    expect(csv).toContain('"标题,带逗号,还有"');
  });

  it("已失效的条目输出 attr 值，便于核对", () => {
    expect(buildFavoritesCsv([makeFavorite(1, { attr: 9 })])).toContain("9");
  });
});

describe("buildFollowingCsv", () => {
  it("输出状态中文标签而不是枚举值", () => {
    const csv = buildFollowingCsv([makeFollowing(1, { status: "gone" })]);
    expect(csv).toContain("已注销");
  });

  it("名字未知的注销账号用 UID 占位（不会输出空单元格）", () => {
    const csv = buildFollowingCsv([makeFollowing(123, { name: "账号已注销" })]);
    expect(csv).toContain("UID 123");
  });

  it("曾用名用 / 分隔", () => {
    const csv = buildFollowingCsv([
      makeFollowing(1, {
        name: "现名",
        nameHistory: [
          { name: "旧名A", seenAt: 1 },
          { name: "现名", seenAt: 2 },
        ],
      }),
    ]);
    expect(csv).toContain("旧名A");
  });
});

describe("buildVanishedCsv", () => {
  it("输出消失原因的中文标签", () => {
    const record = {
      ...makeFavorite(1, { title: "消失前的标题" }),
      vanishedAt: 1782551572,
      vanishReason: "content_deleted",
      lastKnownTitle: "消失前的标题",
    } as VanishedFavResource;

    const csv = buildVanishedCsv([record]);
    expect(csv).toContain("内容已被删除");
    expect(csv).toContain("消失前的标题");
  });
});

describe("Markdown 导出", () => {
  it("收藏导出按收藏夹分组，并给出总数", () => {
    const markdown = buildFavoritesMarkdown([
      makeFavorite(1, { folder_id: 100 }),
      makeFavorite(2, { folder_id: 200 }),
    ]);

    expect(markdown).toContain("# 收藏内容");
    expect(markdown).toContain("共 2 条");
    expect(markdown).toContain("收藏夹 100");
    expect(markdown).toContain("收藏夹 200");
  });

  it("收藏夹标题可传入", () => {
    const markdown = buildFavoritesMarkdown([makeFavorite(1, { folder_id: 100 })], {
      100: "默认收藏夹",
    });
    expect(markdown).toContain("## 默认收藏夹（1 条）");
  });

  it("关键：标题里的竖线要转义，否则表格会被拆散", () => {
    const markdown = buildFollowingMarkdown([makeFollowing(1, { name: "A|B" })]);
    expect(markdown).toContain("A\\|B");
  });

  it("关键：单元格里的换行会被替换，否则 Markdown 表格断开", () => {
    // 昵称在 Markdown 表格里；换行若不处理会把一行拆成两行，表格就断了
    const markdown = buildFollowingMarkdown([makeFollowing(1, { name: "第一行\n第二行" })]);
    expect(markdown).toContain("第一行 第二行");
  });

  it("Markdown 表格有表头与分隔行", () => {
    const markdown = buildFollowingMarkdown([makeFollowing(1)]);
    expect(markdown).toContain("| UID | 昵称 |");
    expect(markdown).toContain("| --- |");
  });
});
