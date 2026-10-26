import { describe, expect, it } from "vitest";
import {
  isSuspiciousFormerNameTarget,
  parseUserMarkPayload,
  pickFormerNameCandidates,
  sanitizeFormerNames,
} from "./thirdPartyNameLookup";
import type { FollowingItem } from "./types";

const NOW = 1_800_000_000_000;

const makeItem = (mid: number, patch: Partial<FollowingItem> = {}): FollowingItem => ({
  mid,
  name: `UP_${mid}`,
  face: "",
  sign: "",
  mtime: Math.floor(NOW / 1000),
  attribute: 2,
  special: 0,
  status: "following",
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  nameHistory: [{ name: `UP_${mid}`, seenAt: NOW }],
  ...patch,
});

describe("sanitizeFormerNames", () => {
  it("过滤占位文案、空值、超长文本与重复项，保持原顺序", () => {
    expect(
      sanitizeFormerNames([
        " 旧名A ",
        "账号已注销",
        "",
        "旧名A",
        "x".repeat(31),
        "旧名B",
        123,
        null,
      ]),
    ).toEqual(["旧名A", "旧名B"]);
  });

  it("不是数组时返回空数组", () => {
    expect(sanitizeFormerNames(undefined)).toEqual([]);
    expect(sanitizeFormerNames("旧名")).toEqual([]);
  });
});

describe("parseUserMarkPayload", () => {
  it("正常响应取 data.hname", () => {
    const result = parseUserMarkPayload({
      code: 0,
      data: { hname: ["尚硅谷", "尚硅谷官方", "账号已注销"] },
      message: "",
    });
    expect(result.ok).toBe(true);
    expect(result.names).toEqual(["尚硅谷", "尚硅谷官方"]);
  });

  it("hname 缺失按「未收录」处理，而不是失败", () => {
    const result = parseUserMarkPayload({ code: 0, data: {} });
    expect(result).toEqual({ ok: true, names: [] });
  });

  it("code 非 0、结构异常都归一成失败并带原因", () => {
    expect(parseUserMarkPayload({ code: -1, message: "限流" }).ok).toBe(false);
    expect(parseUserMarkPayload({ code: -1, message: "限流" }).message).toBe("限流");
    expect(parseUserMarkPayload({ code: 0 }).ok).toBe(false);
    expect(parseUserMarkPayload(null).ok).toBe(false);
  });
});

describe("isSuspiciousFormerNameTarget", () => {
  it("已注销、空名字、占位文案都算可疑", () => {
    expect(isSuspiciousFormerNameTarget(makeItem(1, { status: "gone" }))).toBe(true);
    expect(isSuspiciousFormerNameTarget(makeItem(2, { name: "" }))).toBe(true);
    expect(isSuspiciousFormerNameTarget(makeItem(3, { name: "账号已注销" }))).toBe(true);
    expect(isSuspiciousFormerNameTarget(makeItem(4))).toBe(false);
  });
});

describe("pickFormerNameCandidates", () => {
  it("跳过已查询过的，可疑账号优先，并遵守上限", () => {
    const items = [
      makeItem(10),
      makeItem(20, { status: "gone" }),
      makeItem(30, { thirdPartyQueriedAt: NOW }),
      makeItem(40, { name: "" }),
      makeItem(50),
    ];

    expect(pickFormerNameCandidates(items, 10).map((item) => item.mid)).toEqual([20, 40, 10, 50]);
    expect(pickFormerNameCandidates(items, 2).map((item) => item.mid)).toEqual([20, 40]);
    expect(pickFormerNameCandidates(items, 0)).toEqual([]);
  });
});
