import { describe, expect, it } from "vitest";
import {
  BILIPLUS_CODE_ALL_MISSING,
  BILIPLUS_CODE_RATE_LIMITED,
  classifyBiliplusResponse,
  classifyJijidownResponse,
} from "./favBiliplusClient";

/**
 * 这组用例锁定的是一个真实踩过的坑：把 `-404 cid无记录` 当成失败。
 *
 * 实际语义是"本批全部没有记录"——正常结果。误判成失败后，连续三批就触发了熔断，
 * 导致一整轮恢复 `recovered: 0`。
 */
describe("classifyBiliplusResponse", () => {
  it("code 0 且有数据 → ok", () => {
    expect(classifyBiliplusResponse(0, 3)).toBe("ok");
  });

  it("code 0 但没有数据 → 视作全部无记录，而不是成功", () => {
    expect(classifyBiliplusResponse(0, 0)).toBe("all_missing");
  });

  it("关键：-404 cid无记录 是「本批全部无记录」，不是失败", () => {
    // 误判成失败会让连续几批触发熔断，整轮恢复颗粒无收
    expect(classifyBiliplusResponse(BILIPLUS_CODE_ALL_MISSING, 0)).toBe("all_missing");
  });

  it("关键：-503 停一下！旁友！ 是限流，必须退避重试而不是丢弃", () => {
    expect(classifyBiliplusResponse(BILIPLUS_CODE_RATE_LIMITED, 0)).toBe("rate_limited");
  });

  it("拿不到返回码（网络 / 超时 / 非 JSON）→ network", () => {
    expect(classifyBiliplusResponse(null, 0)).toBe("network");
  });

  it("其他业务错误码 → error，交由降级来源处理", () => {
    expect(classifyBiliplusResponse(-1, 0)).toBe("error");
    expect(classifyBiliplusResponse(22115, 0)).toBe("error");
  });

  it("限流时不关心有没有数据，状态优先", () => {
    expect(classifyBiliplusResponse(BILIPLUS_CODE_RATE_LIMITED, 5)).toBe("rate_limited");
  });
});

/**
 * 这组用例锁定另一个真实踩过的坑：把 jijidown 的**限流**当成"查不到"。
 *
 * 限流表现是 upid 缺失 / code 0 / HTTP 502-503；
 * "确实没有这条记录"是 upid 为 -1 / 0。两者混为一谈会白白丢掉大量可恢复条目。
 */
describe("classifyJijidownResponse", () => {
  it("有合法 upid 就是命中", () => {
    expect(
      classifyJijidownResponse({
        title: "私自乱吃激素误入歧途的男娘",
        upid: 247177563,
        img: "https://x/cover.jpg",
      }),
    ).toBe("ok");
  });

  it("关键：upid 缺失是限流，不是查不到", () => {
    expect(classifyJijidownResponse({ title: "随便什么" })).toBe("rate_limited");
    expect(classifyJijidownResponse({ title: "随便什么", upid: undefined })).toBe("rate_limited");
    expect(classifyJijidownResponse({ title: "随便什么", upid: null })).toBe("rate_limited");
  });

  it("关键：code 为 0 也是限流（成功响应里没有 code 字段）", () => {
    expect(classifyJijidownResponse({ code: 0 })).toBe("rate_limited");
    expect(classifyJijidownResponse({ code: 0, upid: undefined })).toBe("rate_limited");
  });

  it("upid 为 -1 或 0 才是真的没有这条记录", () => {
    expect(classifyJijidownResponse({ upid: -1 })).toBe("not_found");
    expect(classifyJijidownResponse({ upid: 0 })).toBe("not_found");
  });

  it("占位标题也算没有记录", () => {
    expect(classifyJijidownResponse({ upid: 123, title: "视频去哪了呢？" })).toBe("not_found");
    expect(
      classifyJijidownResponse({ upid: 123, title: "该视频或许已经被删除了" }),
    ).toBe("not_found");
  });

  it("有 upid 时优先判命中，不会把成功响应当限流", () => {
    expect(classifyJijidownResponse({ upid: 1, title: "正常标题" })).toBe("ok");
  });

  it("非对象返回 network", () => {
    expect(classifyJijidownResponse(null)).toBe("network");
    expect(classifyJijidownResponse("字符串")).toBe("network");
  });
});
