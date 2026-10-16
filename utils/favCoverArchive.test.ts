import { describe, expect, it } from "vitest";
import {
  needsCoverArchive,
  runCoverArchive,
  type CoverArchiveDeps,
  type CoverArchiveProgress,
} from "./favCoverArchive";
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
  attr: 0,
  ...patch,
});

interface Harness {
  deps: CoverArchiveDeps<FavoriteResource>;
  persisted: FavoriteResource[][];
  progress: CoverArchiveProgress[];
  delays: number[];
  archiveCalls: string[];
}

const makeHarness = (
  items: FavoriteResource[],
  archiveImpl?: (cover: string) => Promise<{ assetId: string } | null>,
): Harness => {
  const persisted: FavoriteResource[][] = [];
  const progress: CoverArchiveProgress[] = [];
  const delays: number[] = [];
  const archiveCalls: string[] = [];

  const deps: CoverArchiveDeps<FavoriteResource> = {
    loadResources: async () => items,
    persist: async (updates) => {
      persisted.push(updates);
    },
    saveProgress: async (value) => {
      progress.push(value);
    },
    now: () => NOW,
    delay: async (ms) => {
      delays.push(ms);
    },
    archive:
      archiveImpl ??
      (async (cover) => {
        archiveCalls.push(cover);
        const file = cover.split("/").pop() ?? "unknown";
        return { assetId: `cover:/bfs/archive/${file}` };
      }),
  };

  return { deps, persisted, progress, delays, archiveCalls };
};

describe("needsCoverArchive", () => {
  it("没有归档记录且封面是真实地址时需要归档", () => {
    expect(needsCoverArchive(makeResource(1))).toBe(true);
  });

  it("已经有归档记录时不再归档", () => {
    expect(needsCoverArchive(makeResource(1, { coverAssetId: "cover:/x.jpg" }))).toBe(false);
  });

  it("关键：平台占位图不归档（失效后封面已被替换，抓下来毫无意义）", () => {
    expect(needsCoverArchive(makeResource(1, { cover: PLACEHOLDER_COVER }))).toBe(false);
  });

  it("封面为空或无法解析时不归档，否则会陷入永远处理", () => {
    expect(needsCoverArchive(makeResource(1, { cover: "" }))).toBe(false);
    expect(needsCoverArchive(makeResource(1, { cover: "not-a-url" }))).toBe(false);
  });
});

describe("runCoverArchive", () => {
  it("归档待处理项并写回 coverAssetId", async () => {
    const h = makeHarness([makeResource(1), makeResource(2)]);

    const result = await runCoverArchive(h.deps);

    expect(result.status).toBe("completed");
    expect(result.archived).toBe(2);
    const written = h.persisted.flat();
    expect(written.map((item) => item.id)).toEqual([1, 2]);
    expect(written[0].coverAssetId).toBe("cover:/bfs/archive/1.jpg");
  });

  it("跳过已归档与占位图，不重复请求", async () => {
    const h = makeHarness([
      makeResource(1, { coverAssetId: "cover:/bfs/archive/1.jpg" }),
      makeResource(2, { cover: PLACEHOLDER_COVER }),
      makeResource(3),
    ]);

    const result = await runCoverArchive(h.deps);

    expect(result.pending).toBe(1);
    expect(h.archiveCalls).toEqual(["https://i0.hdslb.com/bfs/archive/3.jpg"]);
  });

  it("没有待处理项时标记 completed 且不发请求", async () => {
    const h = makeHarness([makeResource(1, { coverAssetId: "cover:/x.jpg" })]);

    const result = await runCoverArchive(h.deps);

    expect(result.status).toBe("completed");
    expect(result.pending).toBe(0);
    expect(h.archiveCalls).toEqual([]);
    expect(h.persisted).toEqual([]);
  });

  it("超过单轮上限时标记 idle 并报告剩余", async () => {
    const h = makeHarness([1, 2, 3, 4, 5].map((id) => makeResource(id)));

    const result = await runCoverArchive(h.deps, { batchSize: 2 });

    expect(result.pending).toBe(5);
    expect(result.remaining).toBe(3);
    expect(result.status).toBe("idle");
  });

  it("按 persistEvery 分批落库，中断时不会白干", async () => {
    const h = makeHarness([1, 2, 3, 4, 5].map((id) => makeResource(id)));

    await runCoverArchive(h.deps, { persistEvery: 2 });

    // 2 + 2 + 1（最后一次 flush）
    expect(h.persisted.map((batch) => batch.length)).toEqual([2, 2, 1]);
  });

  it("单条失败不影响其余条目", async () => {
    const h = makeHarness([makeResource(1), makeResource(2), makeResource(3)], async (cover) => {
      if (cover.includes("/2.jpg")) throw new Error("图片下载失败 HTTP 500");
      const file = cover.split("/").pop()!;
      return { assetId: `cover:/bfs/archive/${file}` };
    });

    const result = await runCoverArchive(h.deps);

    expect(result.archived).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.lastError).toContain("500");
    expect(result.status).toBe("completed");
  });

  it("关键负例：整批全失败时熔断为 failed，避免无限重试坏地址", async () => {
    const h = makeHarness([makeResource(1), makeResource(2)], async () => {
      throw new Error("网络断了");
    });

    const result = await runCoverArchive(h.deps);

    expect(result.status).toBe("failed");
    expect(result.archived).toBe(0);
    expect(result.failed).toBe(2);
    expect(h.persisted).toEqual([]);
  });

  it("累计值可以跨轮次传递", async () => {
    const h = makeHarness([makeResource(1)]);

    const result = await runCoverArchive(h.deps, { baseArchived: 100, baseFailed: 2 });

    expect(result.archived).toBe(101);
    expect(result.failed).toBe(2);
  });

  it("每条之间都有间隔", async () => {
    const h = makeHarness([makeResource(1), makeResource(2)]);

    await runCoverArchive(h.deps, { itemDelayMs: 55 });

    expect(h.delays).toEqual([55, 55]);
  });

  it("把进度写入存储，便于界面展示", async () => {
    const h = makeHarness([makeResource(1)]);

    await runCoverArchive(h.deps);

    expect(h.progress).toHaveLength(1);
    expect(h.progress[0]).toMatchObject({ status: "completed", archived: 1, pending: 1 });
  });

  /**
   * 归档一轮要跑几十秒。若只在结束时写一次进度，界面就只能对着静止的数字干等
   * —— 这是真实反馈过的问题，所以中途必须也写。
   */
  it("中途也会写进度，界面不必干等", async () => {
    const h = makeHarness([1, 2, 3, 4, 5].map((id) => makeResource(id)));

    await runCoverArchive(h.deps, { progressEvery: 2 });

    const running = h.progress.filter((item) => item.status === "running");
    expect(running.length).toBeGreaterThan(0);
    // 中途的 remaining 必须大于 0，否则界面会以为快跑完了
    expect(running[0].remaining).toBeGreaterThan(0);
    // 逐次递减，进度条才会往前走
    expect(running.map((item) => item.remaining)).toEqual([3, 1]);
    expect(running[0].archived).toBe(2);
  });

  it("最后一轮结束时写入最终进度", async () => {
    const h = makeHarness([1, 2, 3].map((id) => makeResource(id)));

    await runCoverArchive(h.deps, { progressEvery: 1 });

    const last = h.progress[h.progress.length - 1];
    expect(last.status).toBe("completed");
    expect(last.remaining).toBe(0);
  });
});
