import {
  InteractionRequestError,
  type InteractionPageResult,
  type InteractionRequestErrorKind,
} from "./interactionApi";
import {
  applyInteractionProbes,
  diffInteractions,
  resolveBvid,
  type InteractionProbeResult,
} from "./interactionDiff";
import type { InteractionItem, InteractionType, RawInteractionEntry } from "./types";

/**
 * 点赞 / 投币同步的编排层。
 *
 * 全部外部依赖通过 `InteractionSyncDeps` 注入，因此翻页终止条件、探测预算、
 * "抓不全就不判定"的护栏都能用假依赖做单测，既不联网也不需要 IndexedDB。
 */

/** 单类型单轮最多翻多少页。实测接口固定 20 条时第 2 页就会重复，这个上限只是防呆 */
export const MAX_INTERACTION_PAGES_PER_TYPE = 25;
export const DEFAULT_INTERACTION_PAGE_DELAY_MS = 400;
export const DEFAULT_INTERACTION_PROBE_DELAY_MS = 600;
/**
 * 单轮最多探测多少条。
 *
 * 掉出 20 条窗口的条目会随使用时间线性增长，第一轮导入备份后可能有几千条待判定。
 * 没有这个上限就会一次性打出几千个请求，直接触发风控。剩下的下一轮继续。
 */
export const DEFAULT_MAX_PROBES_PER_RUN = 200;

export type InteractionSyncStatus =
  | "completed"
  | "incomplete"
  | "rate_limited"
  | "auth_invalid"
  | "failed";

export interface InteractionTypeProgress {
  type: InteractionType;
  status: InteractionSyncStatus;
  pagesFetched: number;
  fetchedCount: number;
  /** 是否抓完了接口愿意给的全部条目。false 表示本轮不做消失判定 */
  scanCompleted: boolean;
  added: number;
  refreshed: number;
  unlisted: number;
  probed: number;
  ended: number;
  lastErrorKind?: InteractionRequestErrorKind;
  lastError?: string;
}

/** 这一轮同步是谁触发的。界面据此区分"定时抓的"与"逛主页时顺手抓的" */
export type InteractionSyncTrigger = "schedule" | "manual" | "page";

export interface InteractionSyncProgress {
  status: InteractionSyncStatus;
  types: InteractionTypeProgress[];
  /** 缺省视为 schedule（旧数据兼容） */
  trigger?: InteractionSyncTrigger;
  startedAt: number;
  completedAt?: number;
  lastError?: string;
}

export interface InteractionSyncDeps {
  fetchPage: (type: InteractionType, page: number) => Promise<InteractionPageResult>;
  loadExisting: (type: InteractionType) => Promise<InteractionItem[]>;
  persist: (items: InteractionItem[]) => Promise<void>;
  probe: (item: InteractionItem) => Promise<InteractionProbeResult>;
  saveProgress: (progress: InteractionSyncProgress) => Promise<void>;
  /** 插件是否已经完成过一次同步。用于给首轮记录打「早期」标记 */
  hasFirstSync: () => Promise<boolean>;
  /** 首次成功同步后调用一次 */
  markFirstSync: () => Promise<void>;
  now: () => number;
  delay: (ms: number) => Promise<void>;
}

export interface InteractionSyncOptions {
  pageSize: number;
  pageDelayMs?: number;
  probeDelayMs?: number;
  maxPagesPerType?: number;
  maxProbesPerRun?: number;
  /**
   * 强制重新探测"未判定"的条目，忽略 24 小时 / 30 天的时间门。
   * 手动同步时打开：用户点一次就能把卡住的记录推一遍，不必干等。
   */
  forceProbeUnlisted?: boolean;
  /** 触发来源，只用于进度展示 */
  trigger?: InteractionSyncTrigger;
}

export interface InteractionSyncOutcome {
  status: InteractionSyncStatus;
  types: InteractionTypeProgress[];
  added: number;
  unlisted: number;
  probed: number;
  ended: number;
  error?: string;
}

const statusFromError = (error: unknown): InteractionSyncStatus => {
  const kind =
    error instanceof InteractionRequestError ? error.kind : ("unknown" as InteractionRequestErrorKind);
  if (kind === "rate_limited") return "rate_limited";
  if (kind === "auth") return "auth_invalid";
  return "failed";
};

/**
 * 翻页抓取一种类型。
 *
 * 终止条件有四个，任一命中都算"抓完了接口愿意给的条目"：
 * - 空页
 * - 本页没有任何新 BV 号（说明 `pn` 被忽略，再翻也是同一批）——实测就是这条在起作用
 * - 本页不满 `pageSize`
 * - 页数达到上限（此时**不算**抓完，因为可能还有内容没取到）
 */
const collectType = async (
  type: InteractionType,
  deps: InteractionSyncDeps,
  options: Required<Pick<InteractionSyncOptions, "pageSize" | "pageDelayMs" | "maxPagesPerType">>,
): Promise<{
  items: RawInteractionEntry[];
  pagesFetched: number;
  scanCompleted: boolean;
  error?: unknown;
}> => {
  const items: RawInteractionEntry[] = [];
  const seen = new Set<string>();
  let pagesFetched = 0;

  try {
    while (pagesFetched < options.maxPagesPerType) {
      const result = await deps.fetchPage(type, pagesFetched + 1);
      pagesFetched += 1;

      let freshCount = 0;
      for (const raw of result.items) {
        const bvid = resolveBvid(raw);
        if (!bvid) continue;
        if (seen.has(bvid)) continue;
        seen.add(bvid);
        freshCount += 1;
      }
      items.push(...result.items);

      if (result.items.length === 0) return { items, pagesFetched, scanCompleted: true };
      if (freshCount === 0) return { items, pagesFetched, scanCompleted: true };
      if (result.items.length < options.pageSize) {
        return { items, pagesFetched, scanCompleted: true };
      }

      await deps.delay(options.pageDelayMs);
    }
    // 达到页数上限：可能还有内容没取到，因此不判定消失
    return { items, pagesFetched, scanCompleted: false };
  } catch (error) {
    return { items, pagesFetched, scanCompleted: false, error };
  }
};

export const runInteractionSync = async (
  deps: InteractionSyncDeps,
  options: InteractionSyncOptions,
  types: readonly InteractionType[] = ["like", "coin"],
): Promise<InteractionSyncOutcome> => {
  const pageDelayMs = options.pageDelayMs ?? DEFAULT_INTERACTION_PAGE_DELAY_MS;
  const probeDelayMs = options.probeDelayMs ?? DEFAULT_INTERACTION_PROBE_DELAY_MS;
  const maxPagesPerType = options.maxPagesPerType ?? MAX_INTERACTION_PAGES_PER_TYPE;
  let probeBudget = options.maxProbesPerRun ?? DEFAULT_MAX_PROBES_PER_RUN;
  const startedAt = deps.now();
  const progressByType: InteractionTypeProgress[] = [];
  // 整个 run 只读一次：中途不会从"首次"变成"非首次"
  const isFirstSync = !(await deps.hasFirstSync());

  const publish = async (status: InteractionSyncStatus, lastError?: string): Promise<void> => {
    await deps.saveProgress({
      status,
      types: progressByType,
      trigger: options.trigger ?? "schedule",
      startedAt,
      completedAt: deps.now(),
      lastError,
    });
  };

  for (const type of types) {
    const collected = await collectType(type, deps, {
      pageSize: options.pageSize,
      pageDelayMs,
      maxPagesPerType,
    });

    let status: InteractionSyncStatus = collected.scanCompleted
      ? "completed"
      : collected.error
        ? statusFromError(collected.error)
        : "incomplete";
    const errorMessage = collected.error
      ? collected.error instanceof Error
        ? collected.error.message
        : String(collected.error)
      : undefined;

    const existing = await deps.loadExisting(type);
    const now = deps.now();
    const diff = diffInteractions({
      type,
      online: collected.items,
      existing,
      scanCompleted: collected.scanCompleted,
      syncStartedAt: startedAt,
      now,
      isFirstSync,
      forceProbeUnlisted: options.forceProbeUnlisted,
    });

    // 探测预算按"最近还在列表里出现"排序：越新的条目，判定结果越有意义
    const candidates = diff.probeCandidates
      .slice()
      .sort((a, b) => b.lastSeenOnlineAt - a.lastSeenOnlineAt)
      .slice(0, Math.max(0, probeBudget));

    const outcomes: Array<{ id: string; result: InteractionProbeResult }> = [];
    for (const item of candidates) {
      const result = await deps.probe(item);
      outcomes.push({ id: item.id, result });
      if (outcomes.length < candidates.length) await deps.delay(probeDelayMs);
    }
    probeBudget -= outcomes.length;

    const applied = applyInteractionProbes(diff.next, outcomes, deps.now());
    await deps.persist(applied.next);

    const typeProgress: InteractionTypeProgress = {
      type,
      status,
      pagesFetched: collected.pagesFetched,
      fetchedCount: collected.items.length,
      scanCompleted: collected.scanCompleted,
      added: diff.added,
      refreshed: diff.refreshed,
      unlisted: diff.unlisted,
      probed: outcomes.length,
      ended: applied.ended,
      lastErrorKind:
        collected.error instanceof InteractionRequestError ? collected.error.kind : undefined,
      lastError: errorMessage,
    };
    progressByType.push(typeProgress);
    await publish(status, errorMessage);

    console.log(
      `互动记录同步（${type === "like" ? "点赞" : "投币"}）：抓取 ${collected.items.length} 条，` +
        `新增 ${diff.added}，刷新 ${diff.refreshed}，掉出列表 ${diff.unlisted}，` +
        `探测 ${outcomes.length}，判定结束 ${applied.ended}，状态 ${status}`,
    );
  }

  const failed = progressByType.find(
    (item) => item.status !== "completed" && item.status !== "incomplete",
  );
  const status: InteractionSyncStatus = failed
    ? failed.status
    : progressByType.some((item) => item.status === "incomplete")
      ? "incomplete"
      : "completed";

  // 只要有任意一种类型完整抓完，就认为"首次同步"已经发生。
  // 一次都没抓全（网络抖动）时不建立标记，否则下一轮新出现的记录会被误判成"非早期"。
  if (progressByType.some((item) => item.scanCompleted)) {
    await deps.markFirstSync();
  }

  await publish(status, failed?.lastError);

  return {
    status,
    types: progressByType,
    added: progressByType.reduce((sum, item) => sum + item.added, 0),
    unlisted: progressByType.reduce((sum, item) => sum + item.unlisted, 0),
    probed: progressByType.reduce((sum, item) => sum + item.probed, 0),
    ended: progressByType.reduce((sum, item) => sum + item.ended, 0),
    error: failed?.lastError,
  };
};

/**
 * 判断当前是否该跑同步。沿用仓库既有的"每分钟 tick + 时间差节流"模式，抽成纯函数便于单测。
 *
 * 默认间隔刻意比关注同步短：互动列表只有 20 条窗口，间隔太长会让新点赞在两次同步之间
 * 就被挤出去，永久丢失。
 */
export const shouldRunInteractionSync = (input: {
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
