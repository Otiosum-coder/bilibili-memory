import { describe, expect, it } from "vitest";
import {
  ASSET_KIND_META,
  estimateJsonBytes,
  sumBreakdownBytes,
  sumSelectedAssetBytes,
  summarizeAssets,
} from "./storageFormat";
import type { AssetKind } from "./types";

const measured = (kind: AssetKind, count: number, bytes: number) => ({ kind, count, bytes });

describe("estimateJsonBytes", () => {
  it("纯 ASCII 按 1 字节算——URL、bvid、时间戳这些本来就只占 1 字节", () => {
    expect(estimateJsonBytes("abc")).toBe(3);
    expect(estimateJsonBytes('{"bvid":"BV1aa411c7m0"}')).toBe(23);
  });

  it("非 ASCII 按 2 字节算（V8 里含中文的字符串会升为 two-byte）", () => {
    // "中文" 两个字 = 4 字节
    expect(estimateJsonBytes("中文")).toBe(4);
  });

  it("混合内容分别计费", () => {
    expect(estimateJsonBytes("a中b")).toBe(1 + 2 + 1);
  });

  it("空串是 0，不抛错", () => {
    expect(estimateJsonBytes("")).toBe(0);
  });

  it("不再一律按 2 字节算——否则估算会大到超过浏览器报的整站用量", () => {
    const ascii = '{"view_at":1600000000,"duration":120,"progress":42}';
    // 一律 ×2 会得到 2 倍长度；按字符类别计费应该正好等于长度（全 ASCII）
    expect(estimateJsonBytes(ascii)).toBe(ascii.length);
    expect(estimateJsonBytes(ascii)).toBeLessThan(ascii.length * 2);
  });
});

describe("summarizeAssets", () => {
  it("按占用从大到小排——用户是来看谁占地方的", () => {
    const result = summarizeAssets([
      measured("avatar", 1142, 5_000_000),
      measured("cover", 3201, 18_000_000),
    ]);
    expect(result.map((entry) => entry.kind)).toEqual(["cover", "avatar"]);
    expect(result[0].bytes).toBe(18_000_000);
  });

  it("带上类别标题与'清掉会怎样'的说明", () => {
    const result = summarizeAssets([measured("cover", 1, 100)]);
    expect(result[0].title).toBe(ASSET_KIND_META.cover.title);
    expect(result[0].description).toBe(ASSET_KIND_META.cover.description);
  });

  it("某类为空时也保留（0 张也要能显示出来，否则用户不知道有这一类）", () => {
    const result = summarizeAssets([
      measured("cover", 0, 0),
      measured("avatar", 10, 500),
    ]);
    expect(result).toHaveLength(2);
    // 0 字节的排在后面，但仍在列表里
    expect(result.map((entry) => entry.kind)).toEqual(["avatar", "cover"]);
  });

  it("空输入返回空数组，不抛错", () => {
    expect(summarizeAssets([])).toEqual([]);
  });
});

describe("sumSelectedAssetBytes", () => {
  const assets = summarizeAssets([
    measured("cover", 3201, 18_000_000),
    measured("avatar", 1142, 5_000_000),
  ]);

  it("只算选中类别", () => {
    expect(sumSelectedAssetBytes(assets, ["avatar"])).toBe(5_000_000);
    expect(sumSelectedAssetBytes(assets, ["cover"])).toBe(18_000_000);
  });

  it("多选累加", () => {
    expect(sumSelectedAssetBytes(assets, ["cover", "avatar"])).toBe(23_000_000);
  });

  it("一个都不选时为 0（默认状态，不能顺手给个非零值）", () => {
    expect(sumSelectedAssetBytes(assets, [])).toBe(0);
  });
});

describe("sumBreakdownBytes", () => {
  it("图片与结构化数据相加", () => {
    const assets = summarizeAssets([measured("cover", 1, 1000)]);
    const total = sumBreakdownBytes(assets, [
      { label: "观看事件", count: 10, bytes: 2000 },
      { label: "收藏资源", count: 3, bytes: 500 },
    ]);
    expect(total).toBe(3500);
  });

  it("两边都为空时为 0", () => {
    expect(sumBreakdownBytes([], [])).toBe(0);
  });
});
