import { describe, expect, it } from "vitest";
import { formatDateTime, formatDuration } from "./format";

describe("formatDuration", () => {
  it("不足一小时用 mm:ss", () => {
    expect(formatDuration(437)).toBe("07:17");
    expect(formatDuration(59)).toBe("00:59");
    expect(formatDuration(60)).toBe("01:00");
  });

  it("超过一小时用 hh:mm:ss", () => {
    expect(formatDuration(3661)).toBe("01:01:01");
    expect(formatDuration(9354)).toBe("02:35:54");
  });

  it("零与非法值都回退为 00:00", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(undefined)).toBe("00:00");
    expect(formatDuration(null)).toBe("00:00");
    expect(formatDuration(-5)).toBe("00:00");
    expect(formatDuration(Number.NaN)).toBe("00:00");
  });

  it("小数向下取整，不产生 xx:xx.5 这种结果", () => {
    expect(formatDuration(59.9)).toBe("00:59");
  });
});

describe("formatDateTime", () => {
  it("输出到秒，便于与 B站 页面比对", () => {
    const timestamp = new Date(2026, 5, 7, 9, 0, 0).getTime();
    expect(formatDateTime(timestamp)).toBe("2026/6/7 09:00:00");
  });

  it("补零", () => {
    const timestamp = new Date(2026, 0, 1, 1, 2, 3).getTime();
    expect(formatDateTime(timestamp)).toBe("2026/1/1 01:02:03");
  });

  it("缺失或非法值回退为占位符", () => {
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDateTime(0)).toBe("—");
    expect(formatDateTime(Number.NaN)).toBe("—");
  });
});
