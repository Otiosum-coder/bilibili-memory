import { describe, expect, it } from "vitest";
import {
  needsAvatarArchive,
  runAvatarArchive,
  type AvatarArchiveDeps,
  type AvatarArchiveProgress,
} from "./followingAssetArchive";
import type { FollowingItem } from "./types";

const NOW = 1_800_000_000_000;

const makeItem = (mid: number, patch: Partial<FollowingItem> = {}): FollowingItem => ({
  mid,
  name: `UP_${mid}`,
  face: `https://i0.hdslb.com/bfs/face/${mid}.jpg`,
  sign: "",
  mtime: 1,
  attribute: 2,
  special: 0,
  status: "following",
  firstSeenAt: NOW,
  lastSeenAt: NOW,
  lastSeenInSyncAt: NOW,
  nameHistory: [],
  ...patch,
});

interface Harness {
  deps: AvatarArchiveDeps;
  patched: Array<{ mids: number[]; patch: Partial<FollowingItem> }>;
  progress: AvatarArchiveProgress[];
  delays: number[];
  archiveCalls: string[];
}

const makeHarness = (
  items: FollowingItem[],
  archiveImpl?: (face: string) => Promise<{ assetId: string } | null>,
): Harness => {
  const patched: Array<{ mids: number[]; patch: Partial<FollowingItem> }> = [];
  const progress: AvatarArchiveProgress[] = [];
  const delays: number[] = [];
  const archiveCalls: string[] = [];

  const deps: AvatarArchiveDeps = {
    loadFollowing: async () => items,
    patchFollowing: async (mids, patch) => {
      patched.push({ mids, patch });
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
      (async (face) => {
        archiveCalls.push(face);
        const mid = face.match(/face\/(\d+)\.jpg/)?.[1] ?? "0";
        return { assetId: `avatar:/bfs/face/${mid}.jpg` };
      }),
  };

  return { deps, patched, progress, delays, archiveCalls };
};

describe("needsAvatarArchive", () => {
  it("没有归档记录且头像是真实地址时需要归档", () => {
    expect(needsAvatarArchive(makeItem(1))).toBe(true);
  });

  it("已经有归档记录时不再归档", () => {
    expect(needsAvatarArchive(makeItem(1, { avatarAssetId: "avatar:/bfs/face/1.jpg" }))).toBe(false);
  });

  it("平台占位图（注销后的 noface.jpg）不归档", () => {
    // 关键负例：注销后头像被换成占位图，此时抓下来毫无意义
    expect(
      needsAvatarArchive(makeItem(1, { face: "https://i0.hdslb.com/bfs/face/member/noface.jpg" })),
    ).toBe(false);
  });

  it("头像地址为空或无法解析时不归档（否则会陷入永远处理的死循环）", () => {
    expect(needsAvatarArchive(makeItem(1, { face: "" }))).toBe(false);
    expect(needsAvatarArchive(makeItem(1, { face: "not-a-url" }))).toBe(false);
  });
});

describe("runAvatarArchive", () => {
  it("归档待处理项并写回 avatarAssetId", async () => {
    const h = makeHarness([makeItem(1), makeItem(2)]);

    const result = await runAvatarArchive(h.deps);

    expect(result.status).toBe("completed");
    expect(result.archived).toBe(2);
    expect(h.patched.map((entry) => entry.mids[0])).toEqual([1, 2]);
    expect(h.patched[0].patch.avatarAssetId).toBe("avatar:/bfs/face/1.jpg");
  });

  it("跳过已归档与占位图，不重复请求", async () => {
    const h = makeHarness([
      makeItem(1, { avatarAssetId: "avatar:/bfs/face/1.jpg" }),
      makeItem(2, { face: "https://i0.hdslb.com/bfs/face/member/noface.jpg" }),
      makeItem(3),
    ]);

    const result = await runAvatarArchive(h.deps);

    expect(result.pending).toBe(1);
    expect(h.archiveCalls).toEqual(["https://i0.hdslb.com/bfs/face/3.jpg"]);
    expect(h.patched.map((entry) => entry.mids[0])).toEqual([3]);
  });

  it("没有待处理项时标记 completed 且不发请求", async () => {
    const h = makeHarness([makeItem(1, { avatarAssetId: "avatar:/bfs/face/1.jpg" })]);

    const result = await runAvatarArchive(h.deps);

    expect(result.status).toBe("completed");
    expect(result.pending).toBe(0);
    expect(h.archiveCalls).toEqual([]);
    expect(h.patched).toEqual([]);
  });

  it("超过单轮批次上限时标记 idle 并报告剩余，下一轮继续", async () => {
    const items = [1, 2, 3, 4, 5].map((mid) => makeItem(mid));
    const h = makeHarness(items);

    const result = await runAvatarArchive(h.deps, { batchSize: 2 });

    expect(result.pending).toBe(5);
    expect(result.remaining).toBe(3);
    expect(result.archived).toBe(2);
    expect(result.status).toBe("idle");
    expect(h.patched).toHaveLength(2);
  });

  it("单条失败不影响其余条目", async () => {
    const h = makeHarness([makeItem(1), makeItem(2), makeItem(3)], async (face) => {
      if (face.includes("/2.jpg")) throw new Error("图片下载失败 HTTP 500");
      const mid = face.match(/face\/(\d+)\.jpg/)![1];
      return { assetId: `avatar:/bfs/face/${mid}.jpg` };
    });

    const result = await runAvatarArchive(h.deps);

    expect(result.archived).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.lastError).toContain("500");
    expect(result.status).toBe("completed");
    expect(h.patched.map((entry) => entry.mids[0])).toEqual([1, 3]);
  });

  it("关键负例：整批全失败时熔断为 failed，避免对坏地址无限重试", async () => {
    const h = makeHarness([makeItem(1), makeItem(2)], async () => {
      throw new Error("网络断了");
    });

    const result = await runAvatarArchive(h.deps);

    expect(result.status).toBe("failed");
    expect(result.archived).toBe(0);
    expect(result.failed).toBe(2);
    expect(h.patched).toEqual([]);
  });

  it("累计值可以跨轮次传递", async () => {
    const h = makeHarness([makeItem(1)]);

    const result = await runAvatarArchive(h.deps, { baseArchived: 40, baseFailed: 3 });

    expect(result.archived).toBe(41);
    expect(result.failed).toBe(3);
  });

  it("每条之间都有间隔，避免给图片 CDN 造成压力", async () => {
    const h = makeHarness([makeItem(1), makeItem(2), makeItem(3)]);

    await runAvatarArchive(h.deps, { itemDelayMs: 77 });

    expect(h.delays).toEqual([77, 77, 77]);
  });

  it("把进度写入存储，便于界面展示", async () => {
    const h = makeHarness([makeItem(1)]);

    await runAvatarArchive(h.deps);

    expect(h.progress).toHaveLength(1);
    expect(h.progress[0]).toMatchObject({ status: "completed", archived: 1, pending: 1 });
  });
});
