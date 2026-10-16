import { isPlaceholderImage } from "./imageUrl";

/**
 * 收藏封面的字节归档任务。
 *
 * ## 为什么它是唯一"防患于未然"的方案
 *
 * 其余恢复途径都是**事后**找回（公开接口 / biliplus / jijidown / 本地交叉引用），
 * 只有这一条是在封面还正常时就把字节存进本地 IndexedDB。
 * 之后无论 B站 换 URL、把封面替换成占位图，还是稿件被删，手里那份永远在。
 *
 * Phase 1b 实测：失效稿件的封面会被统一替换成同一个占位图
 * （`/bfs/archive/be27fd62c99036dce67efface486fb0a88ffed06.jpg`），
 * 也就是说**等发现失效再抓，抓到的只是占位图**。所以必须提前做、持续做。
 *
 * ## 可续跑性来自筛选条件
 *
 * 已归档的记录 `coverAssetId` 非空，下一轮自然跳过——不需要游标，
 * Service Worker 中途被杀也不丢进度。这一点与关注头像归档是同一套设计。
 */

/** 单轮处理的条数上限。按每条约 150ms 估算，一轮约 30 秒 */
export const COVER_ARCHIVE_BATCH_SIZE = 200;
/** 每条之间的间隔，避免对图片 CDN 造成压力 */
export const COVER_ARCHIVE_ITEM_DELAY_MS = 120;
/** 每攒够多少条落一次库。太小则事务过多，太大则中断时白干 */
export const COVER_ARCHIVE_PERSIST_EVERY = 25;
/** 每处理多少条写一次进度。一轮要跑几十秒，界面不该只能干等 */
export const COVER_ARCHIVE_PROGRESS_EVERY = 20;

export type CoverArchiveStatus = "idle" | "running" | "completed" | "failed";

export interface CoverArchiveProgress {
  status: CoverArchiveStatus;
  /** 累计已归档（跨轮次累加） */
  archived: number;
  /** 累计失败 */
  failed: number;
  /** 本轮开始前的待处理总数 */
  pending: number;
  /** 本轮之后还剩多少 */
  remaining: number;
  lastError?: string;
  startedAt: number;
  completedAt?: number;
}

/**
 * 任何"有封面、且能记录归档结果"的记录。
 *
 * 收藏资源与订阅合集内容都满足这个形状，所以同一个归档任务可以服务两者，
 * 不必把 120 行逻辑复制一遍。
 */
export interface ArchivableCover {
  cover: string;
  coverAssetId?: string;
}

export interface CoverArchiveDeps<T extends ArchivableCover> {
  loadResources: () => Promise<T[]>;
  /** 落库。各 store 主键不同，所以由调用方决定怎么写 */
  persist: (updates: T[]) => Promise<unknown>;
  saveProgress: (progress: CoverArchiveProgress) => Promise<void>;
  now: () => number;
  delay: (ms: number) => Promise<void>;
  /** 归档一张封面。null 表示无需归档（占位图 / 地址无法解析） */
  archive: (cover: string) => Promise<{ assetId: string } | null>;
}

export interface CoverArchiveOptions {
  batchSize?: number;
  itemDelayMs?: number;
  persistEvery?: number;
  progressEvery?: number;
  baseArchived?: number;
  baseFailed?: number;
}

/** 是否还需要归档：没有归档记录、且当前封面不是平台占位图 */
export const needsCoverArchive = (resource: ArchivableCover): boolean =>
  !resource.coverAssetId && !isPlaceholderImage(resource.cover);

/**
 * 跑一轮封面归档。
 *
 * 停止策略与头像归档一致：
 * - 待处理为空 → `completed`，此后 alarm 不再重复读取整张表
 * - 仍有剩余 → `idle`，下一轮继续
 * - 一条都没成功却全是失败 → `failed` 熔断，避免对坏地址无限重试
 */
export const runCoverArchive = async <T extends ArchivableCover>(
  deps: CoverArchiveDeps<T>,
  options: CoverArchiveOptions = {},
): Promise<CoverArchiveProgress> => {
  const batchSize = options.batchSize ?? COVER_ARCHIVE_BATCH_SIZE;
  const itemDelayMs = options.itemDelayMs ?? COVER_ARCHIVE_ITEM_DELAY_MS;
  const persistEvery = Math.max(1, options.persistEvery ?? COVER_ARCHIVE_PERSIST_EVERY);
  const progressEvery = Math.max(1, options.progressEvery ?? COVER_ARCHIVE_PROGRESS_EVERY);
  const startedAt = deps.now();

  const resources = await deps.loadResources();
  const pendingItems = resources.filter(needsCoverArchive);
  const batch = pendingItems.slice(0, Math.max(0, batchSize));
  const remaining = Math.max(0, pendingItems.length - batch.length);

  let archived = options.baseArchived ?? 0;
  let failed = options.baseFailed ?? 0;
  let lastError: string | undefined;

  let buffer: T[] = [];
  const flush = async () => {
    if (buffer.length === 0) return;
    await deps.persist(buffer);
    buffer = [];
  };

  let processed = 0;
  for (const resource of batch) {
    try {
      const result = await deps.archive(resource.cover);
      if (result) {
        buffer.push({ ...resource, coverAssetId: result.assetId });
        archived += 1;
        if (buffer.length >= persistEvery) await flush();
      } else {
        // 理论上到不了这里：needsCoverArchive 已排除占位图与无法解析的地址
        failed += 1;
        lastError = "封面地址无法归档";
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

  await flush();

  const successThisRun = archived - (options.baseArchived ?? 0);
  const failureThisRun = failed - (options.baseFailed ?? 0);

  let status: CoverArchiveStatus;
  if (batch.length === 0) {
    status = "completed";
  } else if (remaining > 0) {
    status = "idle";
  } else if (successThisRun === 0 && failureThisRun > 0) {
    status = "failed";
  } else {
    status = "completed";
  }

  const progress: CoverArchiveProgress = {
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
