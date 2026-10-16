import { INVALIDATED_TITLE_RE } from "./favVanishedDiff";
import { isPlaceholderImage } from "./imageUrl";
import type {
  InteractionItem,
  InteractionState,
  InteractionType,
  RawInteractionEntry,
} from "./types";

/**
 * 点赞 / 投币记录的判定逻辑（纯函数，不依赖 IndexedDB 与网络，可直接单测）。
 *
 * ## 背景：B 站的这两个列表是**滚动窗口**
 *
 * 匿名实测：`x/space/like/video` 与 `x/space/coin/video` 固定只返回 20 条，
 * `pn` / `ps` / `p` 三种分页参数全部被忽略。空间设置接口里这两个板块的名字就是
 * 「最近点赞的视频」「最近投币的视频」。也就是说条目会**自己掉出去**：
 * 可能是你取消了，可能是稿件被删了，也可能只是 B 站不再展示了。
 *
 * 接口对此**不给任何解释**，所以本模块的判定必须遵守两条硬约束：
 *
 * 1. **绝不允许因为"不在列表里"就删除本地记录。** 记录只增不改，状态只做标注。
 * 2. **不在列表里 ≠ 互动消失。** 唯一权威的判断来源是对接口的二次探测
 *    （稿件详情 + 互动状态），探测没成功就老实停在 `unlisted`，绝不猜。
 */

/** 一条互动记录的主键。同一条视频的点赞与投币是两条独立记录 */
export const interactionKey = (type: InteractionType, bvid: string): string =>
  `${type}:${bvid}`;

/** 探测失败后的重试间隔：一天 */
export const PROBE_RETRY_MS = 24 * 60 * 60 * 1000;
/** 探测成功后的复查间隔：一个月。状态会变（稿件可能之后才被删），但不必频繁复核 */
export const PROBE_RECHECK_MS = 30 * 24 * 60 * 60 * 1000;

/** 探测结果。由 `utils/interactionApi.ts` 产出，本模块只消费 */
export interface InteractionProbeResult {
  /** 稿件本身的状态 */
  content: "ok" | "deleted" | "hidden" | "unknown";
  /** 稿件可探测时，互动是否仍在。null 表示没问到（请求失败） */
  retained: boolean | null;
  error?: string;
}

const isUsableBvid = (value: string): boolean => value.startsWith("BV") && value.length >= 10;

/** 从原始条目里取出可用的 BV 号；只有 aid 时退化为 `av{aid}` */
export const resolveBvid = (raw: RawInteractionEntry): string => {
  const bvid = (raw.bvid ?? "").trim();
  if (isUsableBvid(bvid)) return bvid;
  const aid = Number(raw.aid);
  if (Number.isSafeInteger(aid) && aid > 0) return `av${aid}`;
  return "";
};

/**
 * 标题取值：新值不可用（空 / 失效占位文案）时保留旧值。
 *
 * 这一条是数据保全的核心：稿件被删后 B 站会把 `title` 换成「已失效视频」，
 * 一旦照单全收，用户手里就只剩一句占位文案了。
 */
export const pickTitle = (
  incoming: string | undefined,
  previous: InteractionItem | undefined,
): string => {
  const trimmed = (incoming ?? "").trim();
  if (!trimmed || INVALIDATED_TITLE_RE.test(trimmed)) return previous?.title ?? "";
  return trimmed;
};

/** 封面取值：新值不可用（空 / 平台占位图）时保留旧值。理由同上 */
export const pickCover = (
  incoming: string | undefined,
  previous: InteractionItem | undefined,
): string => {
  const trimmed = (incoming ?? "").trim();
  if (!trimmed || isPlaceholderImage(trimmed)) return previous?.cover ?? "";
  return trimmed;
};

/**
 * 互动时间。投币接口给真实的 `time`，点赞接口**不返回点赞时间**。
 *
 * 因此点赞只能退化为"首次观测到它的时间"，这是一个**上界**（真实点赞时间 ≤ 它），
 * 数据结构上用 `interactedAtExact` 标记来源，界面必须如实区分，不能伪装成点赞时间。
 */
export const resolveInteractedAt = (
  type: InteractionType,
  raw: RawInteractionEntry,
  previous: InteractionItem | undefined,
  now: number,
): { at: number; exact: boolean } => {
  if (type === "coin") {
    const seconds = Number(raw.time);
    if (Number.isSafeInteger(seconds) && seconds > 0) {
      return { at: seconds * 1000, exact: true };
    }
  }
  // 已经拿到过准确时间就不要再被近似值覆盖（点赞记录跨轮次也保持一致）
  if (previous?.interactedAtExact) {
    return { at: previous.interactedAt, exact: true };
  }
  return { at: previous?.interactedAt ?? now, exact: false };
};

interface MergeContext {
  now: number;
  syncStartedAt: number;
  /** 本轮是否是插件的第一次同步；是则新建的记录标为"早期"。缺省视为否 */
  isFirstSync?: boolean;
}

/**
 * 把一条在线条目并成完整记录。
 *
 * 只做字段合并，不做状态跃迁判定——状态由 `diffInteractions` 统一决定，
 * 这样"什么时候允许改状态"只有一处逻辑。
 */
export const mergeOnlineEntry = (
  type: InteractionType,
  raw: RawInteractionEntry,
  rank: number,
  previous: InteractionItem | undefined,
  context: MergeContext,
): InteractionItem | null => {
  const bvid = resolveBvid(raw);
  if (!bvid) return null;

  const id = interactionKey(type, bvid);
  const title = pickTitle(raw.title, previous);
  const cover = pickCover(raw.pic, previous);
  const { at, exact } = resolveInteractedAt(type, raw, previous, context.now);
  const coinCount = Number(raw.coins);

  const item: InteractionItem = {
    id,
    type,
    bvid,
    title,
    firstTitle: previous?.firstTitle || title,
    cover,
    coverAssetId: previous?.coverAssetId,
    duration: Number.isFinite(Number(raw.duration)) ? Number(raw.duration) : (previous?.duration ?? 0),
    authorName: (raw.owner?.name ?? "").trim() || (previous?.authorName ?? ""),
    authorMid: Number.isSafeInteger(Number(raw.owner?.mid))
      ? Number(raw.owner?.mid)
      : (previous?.authorMid ?? 0),
    pubdate: Number.isSafeInteger(Number(raw.pubdate))
      ? Number(raw.pubdate)
      : (previous?.pubdate ?? 0),
    interactedAt: at,
    interactedAtExact: exact,
    // 首次同步时就在列表里的记录：只能标"早期"，不能把同步时刻当成点赞时间
    caughtInBaseline: previous?.caughtInBaseline ?? (context.isFirstSync === true ? true : undefined),
    listRank: rank,
    state: "listed",
    firstSeenAt: previous?.firstSeenAt ?? context.syncStartedAt,
    lastSeenAt: context.syncStartedAt,
    lastSeenOnlineAt: context.syncStartedAt,
    // 消失时间与探测记录是历史事实，条目重新出现也不清空
    unlistedDetectedAt: previous?.unlistedDetectedAt,
    endedDetectedAt: previous?.endedDetectedAt,
    probeAttemptedAt: previous?.probeAttemptedAt,
    probeError: previous?.probeError,
  };

  const aid = Number(raw.aid);
  if (Number.isSafeInteger(aid) && aid > 0) item.aid = aid;
  if (type === "coin" && Number.isSafeInteger(coinCount) && coinCount > 0) {
    item.coins = coinCount;
  }
  return item;
};

/** 是否该对这条记录发起探测 */
export const shouldProbeInteraction = (item: InteractionItem, now: number): boolean => {
  if (item.probeAttemptedAt === undefined) return true;
  const elapsed = now - item.probeAttemptedAt;
  // 上次探测失败 → 一天后重试；成功过 → 一个月后复查
  if (item.probeError) return elapsed >= PROBE_RETRY_MS;
  return elapsed >= PROBE_RECHECK_MS;
};

export interface InteractionDiffOptions {
  type: InteractionType;
  /** 本轮在线列表，保持接口顺序（最新在前） */  online: RawInteractionEntry[];
  /** 本轮同步前本地已有的**同类型**记录 */
  existing: InteractionItem[];
  /**
   * 本轮是否完整抓到了接口愿意给的**全部**条目。
   *
   * false 表示翻页被页数上限截断或中途出错——此时缺的条目可能只是没抓到，
   * 一律不进入消失判定，只刷新 `lastSeenAt`。
   */
  scanCompleted: boolean;
  syncStartedAt: number;
  now: number;
  /** 本轮是否是插件的第一次同步。缺省视为否 */
  isFirstSync?: boolean;
  /**
   * 强制重新探测"未判定"的条目，**忽略 `shouldProbeInteraction` 的时间门**。
   *
   * 存在理由：失败后要等 24 小时、成功过要等 30 天才复查，于是用户点「立即同步」
   * 也推不动一条卡住的记录——他只能干等，且无从判断是不是功能坏了。
   * 手动同步时打开它，就能把未判定的条目立刻推一遍（仍受每轮探测预算限制）。
   */
  forceProbeUnlisted?: boolean;
}

export interface InteractionDiffResult {
  next: InteractionItem[];
  /** 已通过护栏、需要发起探测的条目 */
  probeCandidates: InteractionItem[];
  added: number;
  refreshed: number;
  unlisted: number;
}

export const diffInteractions = (options: InteractionDiffOptions): InteractionDiffResult => {
  const { type, online, existing, scanCompleted, syncStartedAt, now, isFirstSync, forceProbeUnlisted } =
    options;  const existingById = new Map(existing.map((item) => [item.id, item]));
  const seen = new Set<string>();
  const next: InteractionItem[] = [];
  let added = 0;
  let refreshed = 0;

  online.forEach((raw, rank) => {
    const bvid = resolveBvid(raw);
    if (!bvid) return; // 脏数据防御：没有可用标识的条目直接丢弃
    const id = interactionKey(type, bvid);
    if (seen.has(id)) return; // 接口偶发重复条目时去重，保留更靠前（更新）的那条
    seen.add(id);

    const previous = existingById.get(id);
    const merged = mergeOnlineEntry(type, raw, rank, previous, { now, syncStartedAt, isFirstSync });
    if (!merged) return;
    if (previous) refreshed += 1;
    else added += 1;
    next.push(merged);
  });

  const probeCandidates: InteractionItem[] = [];
  let unlisted = 0;

  for (const item of existing) {
    if (seen.has(item.id)) continue;

    // 护栏：本轮没抓全就不判定，只更新"最后被扫到"的时间
    if (!scanCompleted) {
      next.push({ ...item, lastSeenAt: syncStartedAt });
      continue;
    }

    unlisted += 1;
    const updated: InteractionItem = {
      ...item,
      // 只有"上一轮还在列表里"才需要改状态；已判定过的条目保持原状态
      state: item.state === "listed" ? "unlisted" : item.state,
      lastSeenAt: syncStartedAt,
      unlistedDetectedAt: item.unlistedDetectedAt ?? now,
    };
    next.push(updated);
    const shouldProbe = forceProbeUnlisted
      ? // 强制模式只关心"还没判定"的条目：已判定的不去无谓地骚扰接口
        updated.state === "unlisted"
      : shouldProbeInteraction(updated, now);
    if (shouldProbe) probeCandidates.push(updated);
  }

  return { next, probeCandidates, added, refreshed, unlisted };
};

/** 探测结果 → 状态。判定不了就停在 `unlisted`，绝不猜 */
export const resolveStateFromProbe = (
  result: InteractionProbeResult,
): InteractionState => {
  if (result.content === "deleted") return "content_deleted";
  if (result.content === "hidden") return "content_hidden";
  if (result.content === "unknown") return "unlisted";
  if (result.retained === true) return "retained";
  if (result.retained === false) return "ended";
  return "unlisted";
};

export interface InteractionProbeOutcome {
  id: string;
  result: InteractionProbeResult;
}

/** 判定为"互动不可再确认"的状态集合，用于统计与界面分组 */
export const ENDED_STATES: readonly InteractionState[] = [
  "ended",
  "content_deleted",
  "content_hidden",
];

export interface ApplyProbeResult {
  next: InteractionItem[];
  /** 本次探测新判定为"互动已结束 / 内容已消失"的条数 */
  ended: number;
}

/** 把探测结果写回记录。只改状态与探测元数据，不动标题、封面与时间线 */
export const applyInteractionProbes = (
  items: InteractionItem[],
  outcomes: InteractionProbeOutcome[],
  now: number,
): ApplyProbeResult => {
  if (outcomes.length === 0) return { next: items, ended: 0 };

  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome.result]));
  const endedStates = new Set<InteractionState>(ENDED_STATES);
  let ended = 0;

  const next = items.map((item) => {
    const result = byId.get(item.id);
    if (!result) return item;

    const state = resolveStateFromProbe(result);
    const wasEnded = endedStates.has(item.state);
    const isEnded = endedStates.has(state);
    if (isEnded && !wasEnded) ended += 1;

    return {
      ...item,
      state,
      probeAttemptedAt: now,
      probeError: result.error,
      endedDetectedAt: isEnded ? (item.endedDetectedAt ?? now) : item.endedDetectedAt,
    };
  });

  return { next, ended };
};
