import { describe, expect, it } from "vitest";
import { buildFollowingNotification, buildVanishedNotification } from "./notifications";
import type { FollowingEvent, FollowingEventType, VanishedFavResource } from "./types";
import { PLACEHOLDER_COVER_PATH } from "./imageUrl";

const makeEvent = (
  type: FollowingEventType,
  mid: number,
  patch: Partial<FollowingEvent> = {},
): FollowingEvent => ({
  event_id: `${type}:${mid}:2026-10-07`,
  type,
  mid,
  day: "2026-10-07",
  occurred_at: 1_800_000_000_000,
  name: `UP_${mid}`,
  ...patch,
});

/**
 * 这组用例锁定一个刻意的取舍：**只通知改名与注销**。
 *
 * 新增关注和取关是用户自己在 B 站点的，心里有数；通知它们会变成噪音，
 * 而噪音的代价是用户关掉通知权限——那样真正重要的改名/注销也就通知不到了。
 */
describe("buildFollowingNotification", () => {
  it("关键：只有新增关注时不通知", () => {
    expect(buildFollowingNotification([makeEvent("followed", 1)])).toBeNull();
    expect(buildFollowingNotification([makeEvent("followed", 1), makeEvent("followed", 2)])).toBeNull();
  });

  it("关键：只有取关时不通知", () => {
    expect(buildFollowingNotification([makeEvent("unfollowed", 1)])).toBeNull();
    expect(
      buildFollowingNotification([makeEvent("unfollowed", 1), makeEvent("unfollowed", 2)]),
    ).toBeNull();
  });

  it("新增与取关混在一起也不通知", () => {
    expect(
      buildFollowingNotification([makeEvent("followed", 1), makeEvent("unfollowed", 2)]),
    ).toBeNull();
  });

  it("单条注销时给出注销前的名字", () => {
    const notification = buildFollowingNotification([
      makeEvent("account_gone", 123, { name: "账号已注销", previous_name: "某某某" }),
    ]);

    expect(notification).not.toBeNull();
    expect(notification!.message).toContain("「某某某」已注销");
    expect(notification!.message).toContain("本地记录已保留");
  });

  it("单条改名时同时给出新旧名字", () => {
    const notification = buildFollowingNotification([
      makeEvent("renamed", 1, { name: "新名字", previous_name: "旧名字" }),
    ]);

    expect(notification!.message).toContain("「旧名字」改名为「新名字」");
    expect(notification!.title).toBe("UP 主改名了");
  });

  it("改名时缺少原名也不会输出 undefined", () => {
    const notification = buildFollowingNotification([makeEvent("renamed", 1, { name: "新名字" })]);
    expect(notification!.message).toContain("原名未知");
    expect(notification!.message).not.toContain("undefined");
  });

  it("关键：有改名/注销时，新增与取关不进通知正文", () => {
    const notification = buildFollowingNotification([
      makeEvent("followed", 1),
      makeEvent("unfollowed", 2),
      makeEvent("renamed", 3, { name: "新名", previous_name: "旧名" }),
    ]);

    expect(notification!.message).toContain("改名为");
    expect(notification!.message).not.toContain("取关");
    expect(notification!.message).not.toContain("新增关注");
  });

  it("多条注销时用「等 N 个」概括，避免通知过长", () => {
    const events = [1, 2, 3, 4, 5].map((mid) =>
      makeEvent("account_gone", mid, { previous_name: `名字${mid}` }),
    );
    const notification = buildFollowingNotification(events);

    expect(notification!.message).toContain("名字1、名字2、名字3 等 5 个");
  });

  it("多条改名只给数量，不逐条罗列", () => {
    const events = [1, 2].map((mid) =>
      makeEvent("renamed", mid, { name: `新${mid}`, previous_name: `旧${mid}` }),
    );
    const notification = buildFollowingNotification(events);

    expect(notification!.message).toContain("2 位 UP 主改了名");
  });

  it("空事件返回 null", () => {
    expect(buildFollowingNotification([])).toBeNull();
  });
});

const makeVanished = (
  id: number,
  reason: VanishedFavResource["vanishReason"],
  title = `视频 ${id}`,
): VanishedFavResource =>
  ({
    id,
    type: 2,
    title,
    lastKnownTitle: title,
    cover: `https://i0.hdslb.com/bfs/archive/${id}.jpg`,
    intro: "",
    duration: 1,
    upper: { mid: 1, name: "UP", face: "" },
    cnt_info: { collect: 0, play: 0, danmaku: 0 },
    link: "",
    ctime: 1,
    pubtime: 1,
    fav_time: 1,
    bv_id: "",
    bvid: `BV1xx${id}`,
    folder_id: 100,
    index: 0,
    vanishedAt: 1_800_000_000_000,
    vanishReason: reason,
  }) as VanishedFavResource;

describe("buildVanishedNotification", () => {
  it("关键：单纯取消收藏不通知（那是用户自己的操作）", () => {
    expect(buildVanishedNotification([makeVanished(1, "unfavorited")])).toBeNull();
  });

  it("内容被删除时通知，并带上消失前的标题", () => {
    const notification = buildVanishedNotification([
      makeVanished(1, "content_deleted", "消失前的标题"),
    ]);

    expect(notification).not.toBeNull();
    expect(notification!.message).toContain("消失前的标题");
    expect(notification!.title).toBe("收藏内容消失");
  });

  it("内容不可见时也通知", () => {
    expect(buildVanishedNotification([makeVanished(1, "content_hidden")])).not.toBeNull();
  });

  it("原因不明不通知（无法区分是不是用户自己取消的）", () => {
    expect(buildVanishedNotification([makeVanished(1, "unknown")])).toBeNull();
  });

  it("混合时只统计真正丢失的那部分", () => {
    const notification = buildVanishedNotification([
      makeVanished(1, "unfavorited"),
      makeVanished(2, "content_deleted"),
      makeVanished(3, "content_hidden"),
    ]);

    expect(notification!.message).toContain("2 条收藏的内容消失了");
    expect(notification!.message).toContain("其中 1 条已被删除");
    expect(notification!.message).toContain("其中 1 条已不可见");
  });

  it("空数组返回 null", () => {
    expect(buildVanishedNotification([])).toBeNull();
  });
});
