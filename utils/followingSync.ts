import { FollowingRequestError, type FollowingPageResult, type FollowingRequestErrorKind } from "./followingApi";
import { diffFollowing, type RawFollowingEntry } from "./followingDiff";
import type { FollowingEvent, FollowingItem } from "./types";

/**
 * 关注同步的编排层。
 *
 * 全部外部依赖通过 `FollowingSyncDeps` 注入，因此分页、完整性护栏、基线建立时机
 * 都能用假依赖做单测，不需要网络也不需要 IndexedDB。
 */

/**
 * 单次抓取的最大页数。
 *
 * 实测本人关注 1142 条 ≈ 23 页；100 页可覆盖 5000 关注，按每页 350ms 间隔约 35 秒，
 * 对每日后台任务完全可接受。
 *
 * 刻意**不做跨轮次游标续跑**：续跑必须把"本轮已扫描的 mid 集合"持久化到下一轮，
 * 一旦该集合丢失或与本地记录不一致，就会把前面几页的人全部误判为已取关。
 * 宁可标记"本轮不完整、不判定取关"，也不引入这种静默的数据损坏风险。
 */
export const MAX_FOLLOWING_PAGES_PER_RUN = 100;
export const DEFAULT_FOLLOWING_PAGE_DELAY_MS = 350;

export type FollowingSyncStatus =
  | "completed"
  | "incomplete"
  | "rate_limited"
  | "auth_invalid"
  | "failed";

export interface FollowingSyncProgress {
  status: FollowingSyncStatus;
  pagesFetched: number;
  fetchedCount: number;
  total: number | null;
  /** 是否完整扫完全部 total 条。false 表示本轮未做取关判定 */
  fullScanCompleted: boolean;
  lastErrorKind?: FollowingRequestErrorKind;
  lastError?: string;
  startedAt: number;
  completedAt?: number;
  eventsCreated: number;
}

export interface FollowingSyncDeps {
  /** 抓取第 page 页（从 1 开始） */
  fetchPage: (page: number) => Promise<FollowingPageResult>;
  loadExisting: () => Promise<FollowingItem[]>;
  persist: (next: FollowingItem[], events: FollowingEvent[]) => Promise<void>;
  hasBaseline: () => Promise<boolean>;
  markBaseline: () => Promise<void>;
  saveProgress: (progress: FollowingSyncProgress) => Promise<void>;
  now: () => number;
  delay: (ms: number) => Promise<void>;
}

export interface FollowingSyncOptions {
  pageSize: number;
  maxPages?: number;
  pageDelayMs?: number;
}

export interface FollowingSyncOutcome {
  status: FollowingSyncStatus;
  pagesFetched: number;
  fetchedCount: number;
  total: number | null;
  fullScanCompleted: boolean;
  eventsCreated: number;
  baselineEstablished: boolean;
  error?: string;
}

export const runFollowingSync = async (
  deps: FollowingSyncDeps,
  options: FollowingSyncOptions,
): Promise<FollowingSyncOutcome> => {
  const maxPages = options.maxPages ?? MAX_FOLLOWING_PAGES_PER_RUN;
  const pageDelayMs = options.pageDelayMs ?? DEFAULT_FOLLOWING_PAGE_DELAY_MS;
  const startedAt = deps.now();

  const collected: RawFollowingEntry[] = [];
  let pagesFetched = 0;
  let total: number | null = null;
  let fullScanCompleted = false;
  let status: FollowingSyncStatus = "completed";
  let errorKind: FollowingRequestErrorKind | undefined;
  let error: string | undefined;

  try {
    while (pagesFetched < maxPages) {
      const result = await deps.fetchPage(pagesFetched + 1);
      pagesFetched += 1;
      total = result.total;
      collected.push(...result.list);

      if (result.list.length < options.pageSize) {
        // 本页不满 → 已到末页
        fullScanCompleted = true;
        break;
      }
      if (collected.length >= result.total) {
        // 已收齐接口声明的总数。这一条是取关判定的关键护栏：
        // 只看页数会让"固定页数上限 < total"时漏掉的人被误判为已取关。
        fullScanCompleted = true;
        break;
      }
      await deps.delay(pageDelayMs);
    }

    if (!fullScanCompleted) {
      status = "incomplete";
      error = `超过单次抓取上限（${maxPages} 页），本轮不判定取关`;
    }
  } catch (caught) {
    const known = caught instanceof FollowingRequestError ? caught : null;
    errorKind = known?.kind ?? "unknown";
    error = known?.message ?? (caught instanceof Error ? caught.message : String(caught));
    status =
      errorKind === "rate_limited"
        ? "rate_limited"
        : errorKind === "auth"
          ? "auth_invalid"
          : "failed";
  }

  let eventsCreated = 0;
  let baselineEstablished = false;

  // 一条都没取到且本轮也没完整结束时，没有必要回写整张表
  if (collected.length > 0 || fullScanCompleted) {
    const [existing, hadBaseline] = await Promise.all([deps.loadExisting(), deps.hasBaseline()]);

    const { next, events } = diffFollowing(existing, collected, {
      // 基线标记为真、但本地**一条记录都没有**时，仍然按"首次建立基线"处理。
      //
      // 为什么必须这样：`HAS_FULL_FOLLOWING_SYNC` 只说明"以前同步过"，
      // 一旦本地 `following` 表因为迁移/清理/扩容变成空的，而标记还在，
      // 上一行逻辑就会把这批账号全部当成 `isNew` → 一次性刷出成百上千条
      // 「新增关注」假事件（实测出现过 1132 条）。有基线标记但没基线数据，
      // 本质上就是没有基线，不该产生事件。
      hasBaseline: hadBaseline && existing.length > 0,
      syncStartedAt: startedAt,
      // 出错或超限时这里为 false，取关判定会被双重护栏挡住
      fullScanCompleted,
      now: deps.now(),
    });

    await deps.persist(next, events);
    eventsCreated = events.length;

    // 基线只在**完整**扫描成功后才建立。
    // 若用残缺数据建立基线，下一轮完整扫描会把没取到的数百人全部判成"新关注"。
    if (fullScanCompleted && !hadBaseline) {
      await deps.markBaseline();
      baselineEstablished = true;
    }
  }

  await deps.saveProgress({
    status,
    pagesFetched,
    fetchedCount: collected.length,
    total,
    fullScanCompleted,
    lastErrorKind: errorKind,
    lastError: error,
    startedAt,
    completedAt: deps.now(),
    eventsCreated,
  });

  return {
    status,
    pagesFetched,
    fetchedCount: collected.length,
    total,
    fullScanCompleted,
    eventsCreated,
    baselineEstablished,
    error,
  };
};

/**
 * 判断当前是否该跑同步。沿用仓库既有的"每分钟 tick + 时间差节流"模式。
 * 抽成纯函数便于单测。
 */
export const shouldRunFollowingSync = (input: {
  enabled: boolean;
  intervalMinutes: number;
  lastSyncAt: number | null;
  now: number;
}): boolean => {
  if (!input.enabled) return false;
  if (!input.lastSyncAt) return true;
  const intervalMs = Math.max(0, input.intervalMinutes) * 60 * 1000;
  if (intervalMs === 0) return true;
  return input.now - input.lastSyncAt >= intervalMs;
};
