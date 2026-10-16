import { isPlaceholderImage } from "./imageUrl";
import type { FollowingItem } from "./types";

/**
 * 关注头像的字节归档任务。
 *
 * 为什么必须持续做（Phase 1b / Phase 2 实测）：
 * - UP 主注销后，B 站会把头像地址换成 `member/noface.jpg`，**真实头像立即丢失**。
 * - 接口返回的是原图（实测 71.5 KB），所以抓取必须走缩略地址，否则 1100+ 个头像要约 80 MB。
 *
 * 可续跑性来自筛选条件本身：已归档的记录 `avatarAssetId` 非空，下一轮自然被跳过，
 * 因此不需要游标，Service Worker 中途被杀也不会丢进度。
 */

/** 单轮处理的条数上限。按每条约 200ms 估算，一轮约 40 秒 */
export const AVATAR_ARCHIVE_BATCH_SIZE = 200;
/** 每条之间的间隔，避免对图片 CDN 造成压力 */
export const AVATAR_ARCHIVE_ITEM_DELAY_MS = 120;
/** 每处理多少条写一次进度。一轮要跑几十秒，界面不该只能干等 */
export const AVATAR_ARCHIVE_PROGRESS_EVERY = 20;

export type AvatarArchiveStatus = "idle" | "running" | "completed" | "failed";

export interface AvatarArchiveProgress {
  status: AvatarArchiveStatus;
  /** 累计已归档（跨轮次累加） */
  archived: number;
  /** 累计失败 */
  failed: number;
  /** 本轮的待处理总数 */
  pending: number;
  /** 本轮之后还剩多少 */
  remaining: number;
  lastError?: string;
  startedAt: number;
  completedAt?: number;
}

export interface AvatarArchiveDeps {
  loadFollowing: () => Promise<FollowingItem[]>;
  patchFollowing: (mids: number[], patch: Partial<FollowingItem>) => Promise<unknown>;
  saveProgress: (progress: AvatarArchiveProgress) => Promise<void>;
  now: () => number;
  delay: (ms: number) => Promise<void>;
  /** 归档一张头像。null 表示无需归档（占位图 / 地址无法解析） */
  archive: (face: string) => Promise<{ assetId: string } | null>;
}

export interface AvatarArchiveOptions {
  batchSize?: number;
  itemDelayMs?: number;
  progressEvery?: number;
  /** 上一轮累计值，用于跨轮次累加展示 */
  baseArchived?: number;
  baseFailed?: number;
}

/** 是否还需要归档：没有归档记录、且当前地址不是平台占位图 */
export const needsAvatarArchive = (item: FollowingItem): boolean =>
  !item.avatarAssetId && !isPlaceholderImage(item.face);

/**
 * 跑一轮归档。
 *
 * 停止策略：
 * - 待处理为空 → `completed`，此后 alarm 不再重复读取
 * - 仍有剩余 → `idle`，下一轮继续（新关注的账号也会被这个条件捞到）
 * - 一条都没成功却全是失败 → `failed` 熔断，避免对坏地址无限重试
 */
export const runAvatarArchive = async (
  deps: AvatarArchiveDeps,
  options: AvatarArchiveOptions = {},
): Promise<AvatarArchiveProgress> => {
  const batchSize = options.batchSize ?? AVATAR_ARCHIVE_BATCH_SIZE;
  const itemDelayMs = options.itemDelayMs ?? AVATAR_ARCHIVE_ITEM_DELAY_MS;
  const progressEvery = Math.max(1, options.progressEvery ?? AVATAR_ARCHIVE_PROGRESS_EVERY);
  const startedAt = deps.now();

  const items = await deps.loadFollowing();
  const pendingItems = items.filter(needsAvatarArchive);
  const batch = pendingItems.slice(0, Math.max(0, batchSize));
  const remaining = Math.max(0, pendingItems.length - batch.length);

  let archived = options.baseArchived ?? 0;
  let processed = 0;
  let failed = options.baseFailed ?? 0;
  let lastError: string | undefined;

  for (const item of batch) {
    try {
      const result = await deps.archive(item.face);
      if (result) {
        await deps.patchFollowing([item.mid], { avatarAssetId: result.assetId });
        archived += 1;
      } else {
        // 理论上到不了这里：needsAvatarArchive 已经排除了占位图与无法解析的地址
        failed += 1;
        lastError = "头像地址无法归档";
      }
    } catch (error) {
      failed += 1;
      lastError = error instanceof Error ? error.message : String(error);
    }

    processed += 1;
    // 中途也写进度：归档一轮要跑几十秒，界面不该只能干等
    if (processed % progressEvery === 0) {
      await deps.saveProgress({
        status: "running",
        archived,
        failed,
        pending: pendingItems.length,
        remaining: remaining + (batch.length - processed),
        lastError,
        startedAt,
      });
    }

    await deps.delay(itemDelayMs);
  }

  const successThisRun = archived - (options.baseArchived ?? 0);
  const failureThisRun = failed - (options.baseFailed ?? 0);

  let status: AvatarArchiveStatus;
  if (batch.length === 0) {
    status = "completed";
  } else if (remaining > 0) {
    status = "idle";
  } else if (successThisRun === 0 && failureThisRun > 0) {
    // 全部失败：熔断，等下一次关注同步重新触发
    status = "failed";
  } else {
    status = "completed";
  }

  const progress: AvatarArchiveProgress = {
    status,
    archived,
    failed,
    pending: pendingItems.length,
    remaining,
    lastError,
    startedAt,
    completedAt: deps.now(),
  };

  await deps.saveProgress(progress);
  return progress;
};
