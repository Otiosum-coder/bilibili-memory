import { describe, expect, it } from "vitest";
import { applyArchiveNames, mergeFormerNames, parseNameArchive } from "./nameArchive";
import type { FollowingItem } from "./types";

const NOW = 1_800_000_000_000;

const makeItem = (patch: Partial<FollowingItem> = {}): FollowingItem => ({
  mid: 42,
  name: "现在的名字",
  face: "",
  sign: "",
  mtime: Math.floor(NOW / 1000),
  attribute: 2,
  special: 0,
  status: "following",
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  nameHistory: [{ name: "现在的名字", seenAt: NOW }],
  ...patch,
});

const buildSlice = (
  entries: Record<string, string[]>,
  patch: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    formatVersion: 1,
    source: "aicu.cc hname dump",
    generatedAt: "2026-10-24T12:00:00.000Z",
    followingCount: 3,
    matchedUids: 2,
    totalNames: 4,
    entries,
    ...patch,
  });

describe("parseNameArchive", () => {
  it("解析出 UID → 名字，并过滤占位文案、超长文本与重复项", () => {
    const parsed = parseNameArchive(
      buildSlice({
        "100": ["旧名字", "账号已注销", "旧名字", "x".repeat(31)],
        "200": ["另一个名字"],
        "300": [],
      }),
    );

    expect(parsed.entries.get(100)).toEqual(["旧名字"]);
    expect(parsed.entries.get(200)).toEqual(["另一个名字"]);
    expect(parsed.entries.has(300)).toBe(false);
    expect(parsed.meta.matchedUids).toBe(2);
    expect(parsed.meta.source).toBe("aicu.cc hname dump");
  });

  it("非 JSON、版本不符、缺 entries 都要报错", () => {
    expect(() => parseNameArchive("not json")).toThrow("不是合法的 JSON");
    expect(() => parseNameArchive(buildSlice({}, { formatVersion: 2 }))).toThrow("版本不受支持");
    expect(() => parseNameArchive(JSON.stringify({ formatVersion: 1 }))).toThrow("缺少 entries");
  });

  it("缺失的统计字段用实际内容兜底", () => {
    const parsed = parseNameArchive(
      JSON.stringify({ formatVersion: 1, entries: { "7": ["甲", "乙"] } }),
    );
    expect(parsed.meta.matchedUids).toBe(1);
    expect(parsed.meta.totalNames).toBe(2);
    expect(parsed.meta.followingCount).toBe(0);
  });
});

describe("mergeFormerNames", () => {
  it("过滤当前昵称、本地时间轴已有名字、占位文案与重复", () => {
    const item = makeItem({
      nameHistory: [
        { name: "甲", seenAt: NOW - 1000 },
        { name: "现在的名字", seenAt: NOW },
      ],
    });
    const merged = mergeFormerNames(item, [
      "甲", // 本地时间轴已有
      "现在的名字", // 当前名字
      "账号已注销", // 占位
      " ",
      "乙",
      "乙", // 重复
      "x".repeat(31),
      "丙",
    ]);
    expect(merged).toEqual(["乙", "丙"]);
  });

  it("把已有的 thirdPartyNames 与存档名字合并，且保持先后顺序", () => {
    const item = makeItem({ thirdPartyNames: ["接口给的旧名"] });
    expect(mergeFormerNames(item, ["存档旧名", "接口给的旧名"])).toEqual([
      "接口给的旧名",
      "存档旧名",
    ]);
  });

  it("没有可用名字时返回空数组", () => {
    expect(mergeFormerNames(makeItem(), undefined)).toEqual([]);
    expect(mergeFormerNames(makeItem(), ["现在的名字"])).toEqual([]);
  });
});

describe("applyArchiveNames", () => {
  it("有名字时返回叠加后的新对象，不改原对象", () => {
    const item = makeItem();
    const next = applyArchiveNames(item, ["旧名字"]);
    expect(next.thirdPartyNames).toEqual(["旧名字"]);
    expect(item.thirdPartyNames).toBeUndefined();
  });

  it("没有可展示名字时原样返回同一个引用", () => {
    const item = makeItem();
    expect(applyArchiveNames(item, ["现在的名字"])).toBe(item);
    expect(applyArchiveNames(item, undefined)).toBe(item);
  });
});
