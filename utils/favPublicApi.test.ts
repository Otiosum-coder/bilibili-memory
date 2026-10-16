import { describe, expect, it } from "vitest";
import {
  PUBLIC_FAV_PAGE_SIZE,
  derivePublicPage,
  groupCandidatesByPage,
} from "./favPublicApi";
import type { FavoriteResource } from "./types";

const makeResource = (id: number, folderId: number, index: number): FavoriteResource => ({
  id,
  type: 2,
  title: `视频 ${id}`,
  cover: "",
  intro: "",
  duration: 1,
  upper: { mid: 1, name: "UP", face: "" },
  cnt_info: { collect: 0, play: 0, danmaku: 0 },
  link: "",
  ctime: 1,
  pubtime: 1,
  fav_time: 1,
  bv_id: "",
  bvid: "",
  folder_id: folderId,
  index,
  attr: 1,
});

describe("derivePublicPage", () => {
  it("服务端 ps 上限是 20，所以每页 20 条", () => {
    expect(PUBLIC_FAV_PAGE_SIZE).toBe(20);
  });

  it("按位置算出页码，1 起", () => {
    expect(derivePublicPage(0)).toBe(1);
    expect(derivePublicPage(19)).toBe(1);
    expect(derivePublicPage(20)).toBe(2);
    expect(derivePublicPage(39)).toBe(2);
    expect(derivePublicPage(40)).toBe(3);
    expect(derivePublicPage(813)).toBe(41);
  });

  it("index 缺失或非法时回退到第一页", () => {
    expect(derivePublicPage(undefined)).toBe(1);
    expect(derivePublicPage(-5)).toBe(1);
    expect(derivePublicPage(Number.NaN)).toBe(1);
  });
});

describe("groupCandidatesByPage", () => {
  it("同一收藏夹同一页的多个候选合并成一个请求", () => {
    // 关键：不合并就会对同一页重复请求
    const tasks = groupCandidatesByPage([
      makeResource(1, 100, 0),
      makeResource(2, 100, 5),
      makeResource(3, 100, 19),
    ]);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].folderId).toBe(100);
    expect(tasks[0].page).toBe(1);
    expect([...tasks[0].aids].sort()).toEqual([1, 2, 3]);
  });

  it("跨页的候选分成多个请求", () => {
    const tasks = groupCandidatesByPage([makeResource(1, 100, 0), makeResource(2, 100, 25)]);

    expect(tasks).toHaveLength(2);
    expect(tasks.map((task) => task.page)).toEqual([1, 2]);
  });

  it("不同收藏夹分开", () => {
    const tasks = groupCandidatesByPage([makeResource(1, 100, 0), makeResource(2, 200, 0)]);

    expect(tasks.map((task) => task.folderId)).toEqual([100, 200]);
  });

  it("同一收藏夹内按页码升序，减少来回跳页", () => {
    const tasks = groupCandidatesByPage([
      makeResource(1, 100, 60),
      makeResource(2, 100, 0),
      makeResource(3, 100, 25),
    ]);

    expect(tasks.map((task) => task.page)).toEqual([1, 2, 4]);
  });

  it("folder_id 非法的记录被跳过", () => {
    const tasks = groupCandidatesByPage([
      makeResource(1, Number.NaN, 0),
      makeResource(2, 100, 0),
    ]);

    expect(tasks).toHaveLength(1);
    expect(tasks[0].folderId).toBe(100);
  });

  it("空输入返回空数组", () => {
    expect(groupCandidatesByPage([])).toEqual([]);
  });
});
