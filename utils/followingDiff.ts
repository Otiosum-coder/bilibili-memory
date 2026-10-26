import type { FollowingEvent, FollowingEventType, FollowingItem, FollowingStatus } from "./types";

/**
 * 关注列表的变动判定（纯函数，不依赖 IndexedDB 与网络，可直接单测）。
 *
 * 判定依据来自 Phase 1 实测：
 * - 已注销账号**仍留在关注列表里**，`uname` 是字面量占位文案（长度 5），`attribute` 仍为 2。
 *   所以注销**不需要任何探测接口**，看名字即可。
 * - `mtime` 是"关注时间"，但**互关后会被刷新**，因此绝不能因为 mtime 变化就推断"重新关注"。
 *
 * 数据完整性硬约束：
 * - `name` 永不写入空值或占位文案。拿不到真实名字时保持空字符串，由 UI 兜底展示。
 * - `gone` 是终态，不被 `unfollowed` 覆盖。
 * - 只有**完整扫完接口返回的全部 total 条**之后，才允许判定取关。
 */

/** 平台占位昵称。命中即视为"账号已注销"。 */
export const GONE_NAME_PLACEHOLDERS = ["账号已注销", "用户不存在", "已注销"];

/** 名字是否属于"账号已注销"信号（含空字符串与纯空白） */
export const isGoneName = (name: string | undefined | null): boolean => {
  const trimmed = (name ?? "").trim();
  if (trimmed === "") return true;
  return GONE_NAME_PLACEHOLDERS.includes(trimmed);
};

/** 关注列表接口返回的单条原始数据（只声明用到的字段） */
export interface RawFollowingEntry {
  mid: number;
  uname?: string;
  face?: string;
  sign?: string;
  /** 关注时间，秒级时间戳。互关后会被刷新 */
  mtime?: number;
  /** 2 已关注 / 6 已互粉 / 128 已拉黑 */
  attribute?: number;
  /** 1 表示特别关注 */
  special?: number;
  official_verify?: { type?: number; desc?: string };
}

export interface FollowingDiffOptions {
  /** 首次基线是否已建立。`false` 表示本轮是首次完整同步 → 只写快照，零事件 */
  hasBaseline: boolean;
  /** 本轮同步开始时间，写入 `lastSeenInSyncAt` 与 `lastSeenAt` */
  syncStartedAt: number;
  /**
   * 本轮是否**完整扫完接口返回的全部 total 条**。
   * 调用方必须仅在"确实到达 total"时置为 true —— 实测关注 1142 条，
   * 若按固定页数上限只扫到 1000 条就置 true，会把剩余 142 条全部误判为已取关。
   */
  fullScanCompleted: boolean;
  /** 判定用的"现在"，由调用方注入以便测试 */
  now: number;
}

export interface FollowingDiffResult {
  next: FollowingItem[];
  events: FollowingEvent[];
}

/** YYYY-MM-DD（本地时区） */
export const formatLocalDay = (timestamp: number): string => {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const buildEvent = (
  type: FollowingEventType,
  mid: number,
  name: string,
  occurredAt: number,
  previousName?: string,
): FollowingEvent => {
  const event: FollowingEvent = {
    // 用 `type:mid:day` 而非时间戳：日频同步下同一天可能重复跑，带时间戳会产生重复事件
    event_id: `${type}:${mid}:${formatLocalDay(occurredAt)}`,
    type,
    mid,
    day: formatLocalDay(occurredAt),
    occurred_at: occurredAt,
    name,
  };
  if (previousName !== undefined) event.previous_name = previousName;
  return event;
};

/**
 * 关注时间（秒级）。
 * 优先用接口的 mtime（比同步时间准确），缺失或非法时回退到上一轮已知值。
 * 注意：返回秒，与 `FollowingItem.mtime` 的单位保持一致。
 */
const resolveMtimeSeconds = (entry: RawFollowingEntry, fallbackSeconds: number): number => {
  const mtime = Number(entry.mtime);
  if (Number.isSafeInteger(mtime) && mtime > 0) return mtime;
  return fallbackSeconds;
};

export const diffFollowing = (
  existing: FollowingItem[],
  incoming: RawFollowingEntry[],
  options: FollowingDiffOptions,
): FollowingDiffResult => {
  const { hasBaseline, syncStartedAt, fullScanCompleted, now } = options;

  const existingByMid = new Map<number, FollowingItem>();
  for (const item of existing) existingByMid.set(item.mid, item);

  const next: FollowingItem[] = [];
  const events: FollowingEvent[] = [];
  const scannedMids = new Set<number>();

  for (const entry of incoming) {
    const mid = Number(entry.mid);
    // 脏数据防御：非法 mid 直接丢弃
    if (!Number.isSafeInteger(mid) || mid <= 0) continue;
    // 接口偶发重复条目时去重
    if (scannedMids.has(mid)) continue;
    scannedMids.add(mid);

    const previous = existingByMid.get(mid);
    const nameIsGone = isGoneName(entry.uname);
    const realName = nameIsGone ? "" : (entry.uname ?? "").trim();
    const previousName = previous?.name ?? "";
    // 拿不到真实名字时保留已知的真名，绝不写入占位文案
    const nextName = realName !== "" ? realName : previousName;

    // ---- nameHistory：纯追加，只记真实名字 ----
    const nameHistory = [...(previous?.nameHistory ?? [])];
    if (realName !== "") {
      const lastObserved = nameHistory.length > 0 ? nameHistory[nameHistory.length - 1].name : "";
      if (lastObserved !== realName) {
        nameHistory.push({ name: realName, seenAt: syncStartedAt });
      }
    }

    // ---- 状态判定 ----
    const wasGone = previous?.status === "gone";
    const isNew = !previous;
    const status: FollowingStatus = nameIsGone ? "gone" : "following";

    let goneDetectedAt = previous?.goneDetectedAt;
    let unfollowedDetectedAt = previous?.unfollowedDetectedAt;

    if (nameIsGone) {
      if (!wasGone) goneDetectedAt = now;
      // 注销优先于取关
      unfollowedDetectedAt = undefined;
    } else {
      // 接口给出真实名字 → 账号存在且关系为关注中。
      // 清掉 gone 标记是为了兼容 B 站注销有冷静期、可撤销的情况。
      goneDetectedAt = undefined;
      unfollowedDetectedAt = undefined;
    }

    // ---- 事件判定 ----
    if (hasBaseline) {
      // 新关注的 occurred_at 用真实关注时间，比同步时间准确
      const followedAt = resolveMtimeSeconds(entry, Math.floor(syncStartedAt / 1000)) * 1000;

      if (isNew) {
        // 新关注。若一出现就是占位名，说明我们从未知道他是谁 → 不产事件
        if (!nameIsGone) {
          events.push(buildEvent("followed", mid, nextName, followedAt));
        }
      } else {
        // 重新关注
        if (previous.status === "unfollowed" && status === "following") {
          events.push(buildEvent("followed", mid, nextName, followedAt));
        }
        // 改名：新旧都是真实名字且不同。occurred_at 只能是"发现时间"，B 站不提供改名时间
        if (previousName !== "" && realName !== "" && previousName !== realName) {
          events.push(buildEvent("renamed", mid, realName, now, previousName));
        }
        // 账号注销：只在首次进入 gone 时产事件，避免每次同步重复产
        if (nameIsGone && !wasGone) {
          events.push(buildEvent("account_gone", mid, previousName, now));
        }
      }
    }

    next.push({
      mid,
      name: nextName,
      face: entry.face || previous?.face || "",
      avatarAssetId: previous?.avatarAssetId,
      sign: typeof entry.sign === "string" ? entry.sign : (previous?.sign ?? ""),
      mtime: resolveMtimeSeconds(entry, previous?.mtime ?? 0),
      attribute: typeof entry.attribute === "number" ? entry.attribute : (previous?.attribute ?? 0),
      special: typeof entry.special === "number" ? entry.special : (previous?.special ?? 0),
      officialVerifyDesc: entry.official_verify?.desc || previous?.officialVerifyDesc,
      status,
      firstSeenAt: previous?.firstSeenAt ?? syncStartedAt,
      lastSeenAt: syncStartedAt,
      lastSeenInSyncAt: syncStartedAt,
      unfollowedDetectedAt,
      goneDetectedAt,
      nameHistory,
      nameSource: realName !== "" ? "api" : previous?.nameSource,
      thirdPartyNames: previous?.thirdPartyNames,
      thirdPartyQueriedAt: previous?.thirdPartyQueriedAt,
      formerNameDisplayIndex: previous?.formerNameDisplayIndex,
    });
  }

  // ---- 取关判定：只有完整扫完全部 total 条之后才允许 ----
  for (const item of existing) {
    if (scannedMids.has(item.mid)) continue;

    // 未完整扫描：原样保留，不做任何判定
    if (!hasBaseline || !fullScanCompleted) {
      next.push({ ...item });
      continue;
    }

    // gone 是终态，账号从列表消失也不改判为取关
    if (item.status === "gone" || item.status === "unfollowed") {
      next.push({ ...item });
      continue;
    }

    next.push({ ...item, status: "unfollowed", unfollowedDetectedAt: now });
    events.push(buildEvent("unfollowed", item.mid, item.name, now));
  }

  return { next, events };
};
