import { isGoneName } from "./followingDiff";
import type { FollowingItem } from "./types";

/**
 * 关注列表的查询、统计与展示派生（纯函数，可单测）。
 *
 * 这里承载一条硬约束的落地：`FollowingItem.name` 永不写入占位文案或空值，
 * 所以"注销且从未知道真名"的账号 `name` 是空字符串。界面绝不能直接渲染空字符串，
 * 必须走 `resolveDisplayName` 兜底。
 */

export type FollowingFilter = "all" | "following" | "unfollowed" | "gone";

export type FollowingSort =
  | "followed_desc"
  | "followed_asc"
  | "name_asc"
  | "uid_asc"
  | "uid_desc";

export interface FollowingStats {
  total: number;
  following: number;
  unfollowed: number;
  gone: number;
}

export interface DisplayNameInfo {
  name: string;
  /** 名字来自第三方存档推测，而不是 B 站接口返回的真实昵称 */
  inferred: boolean;
  /** 可选的第三方名字数量（`inferred` 时 > 0） */
  candidateCount: number;
  /** 当前展示的是第几个候选（从 0 开始；`inferred` 时有效） */
  candidateIndex: number;
}

/** 用户手动切换过的下标优先；越界或缺省时回退到最后一个（最可能的注销前名字） */
const normalizeFormerNameIndex = (index: number | undefined, length: number): number => {
  if (typeof index === "number" && Number.isInteger(index) && index >= 0 && index < length) {
    return index;
  }
  return length - 1;
};

/**
 * 卡片显示名。真实昵称优先；拿不到真实昵称时，用第三方存档里「最后一个非占位名字」
 * 兜底（旧设计文档的规则：过滤占位文案后取最后一条作为最可能的注销前名字）。
 *
 * 注意：aicu 的 `hname` 没有时间戳、顺序不保证，所以这只是**推测**，
 * 界面必须通过 `inferred` 标出来，不能当成"最后一次改名"的事实。
 */
export const resolveDisplayNameInfo = (item: FollowingItem): DisplayNameInfo => {
  if (item.name && !isGoneName(item.name)) {
    return { name: item.name, inferred: false, candidateCount: 0, candidateIndex: -1 };
  }
  const candidates = buildThirdPartyNames(item);
  if (candidates.length > 0) {
    const candidateIndex = normalizeFormerNameIndex(item.formerNameDisplayIndex, candidates.length);
    return {
      name: candidates[candidateIndex],
      inferred: true,
      candidateCount: candidates.length,
      candidateIndex,
    };
  }
  return { name: `UID ${item.mid}（名字未知）`, inferred: false, candidateCount: 0, candidateIndex: -1 };
};

/** 名字未知时的兜底展示。绝不返回空串或占位文案 */
export const resolveDisplayName = (item: FollowingItem): string => resolveDisplayNameInfo(item).name;

export const buildFollowingStats = (items: FollowingItem[]): FollowingStats => {
  const stats: FollowingStats = { total: 0, following: 0, unfollowed: 0, gone: 0 };
  for (const item of items) {
    stats.total += 1;
    if (item.status === "gone") stats.gone += 1;
    else if (item.status === "unfollowed") stats.unfollowed += 1;
    else stats.following += 1;
  }
  return stats;
};

export interface FollowingQueryInput {
  items: FollowingItem[];
  keyword?: string;
  filter?: FollowingFilter;
  sort?: FollowingSort;
}

/** 搜索是否命中曾用名 —— 痛点正是"记得旧名字却搜不到人" */
const matchKeyword = (item: FollowingItem, term: string): boolean => {
  if (!term) return true;
  if (item.name.toLowerCase().includes(term)) return true;
  if (String(item.mid).includes(term)) return true;
  if ((item.sign ?? "").toLowerCase().includes(term)) return true;
  if ((item.officialVerifyDesc ?? "").toLowerCase().includes(term)) return true;
  if ((item.nameHistory ?? []).some((record) => record.name.toLowerCase().includes(term))) {
    return true;
  }
  if ((item.thirdPartyNames ?? []).some((name) => name.toLowerCase().includes(term))) {
    return true;
  }
  return false;
};

const compareFollowing = (
  a: FollowingItem,
  b: FollowingItem,
  sort: FollowingSort,
): number => {
  switch (sort) {
    case "name_asc":
      return resolveDisplayName(a).localeCompare(resolveDisplayName(b), "zh-Hans-CN");
    case "uid_asc":
      return a.mid - b.mid;
    case "uid_desc":
      return b.mid - a.mid;
    case "followed_asc":
      return followTimeOf(a) - followTimeOf(b);
    case "followed_desc":
    default:
      return followTimeOf(b) - followTimeOf(a);
  }
};

/** 关注时间。mtime 缺失时回退到首次观测时间 */
export const followTimeOf = (item: FollowingItem): number =>
  item.mtime > 0 ? item.mtime * 1000 : item.firstSeenAt;

export const queryFollowing = (input: FollowingQueryInput): FollowingItem[] => {
  const term = (input.keyword ?? "").trim().toLowerCase();
  const filter = input.filter ?? "all";
  const sort = input.sort ?? "followed_desc";

  return input.items
    .filter((item) => {
      if (filter === "following" && item.status !== "following") return false;
      if (filter === "unfollowed" && item.status !== "unfollowed") return false;
      if (filter === "gone" && item.status !== "gone") return false;
      return matchKeyword(item, term);
    })
    .sort((a, b) => compareFollowing(a, b, sort));
};

export interface FollowingPage<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export const paginateFollowing = <T>(
  items: T[],
  page: number,
  pageSize: number,
): FollowingPage<T> => {
  const safePage = Math.max(1, Math.floor(page));
  const safeSize = Math.max(1, Math.floor(pageSize));
  const start = (safePage - 1) * safeSize;
  return {
    items: items.slice(start, start + safeSize),
    total: items.length,
    page: safePage,
    pageSize: safeSize,
    totalPages: Math.max(1, Math.ceil(items.length / safeSize)),
  };
};

// ---------------------------------------------------------------------------
// 曾用名时间轴
// ---------------------------------------------------------------------------

export interface FollowingNameSegment {
  name: string;
  /** 首次观测到该名字的同步时间 */
  from: number;
  /** 下一次改名的时间；当前名字为 undefined */
  to?: number;
  isCurrent: boolean;
}

/**
 * 由 `nameHistory` 推算本地观测到的时间轴。
 *
 * 存储层是纯追加的"某次同步看到它叫这个名字"，区间由相邻两条推导——
 * 这样写入逻辑最简，也不会因为漏回填 `endedAt` 而让整条时间轴断裂。
 * 返回**倒序**（最近的在前），便于界面直接渲染。
 */
export const buildLocalNameTimeline = (item: FollowingItem): FollowingNameSegment[] => {
  const history = item.nameHistory ?? [];
  const segments = history.map((record, index) => {
    const next = history[index + 1];
    const isCurrent = index === history.length - 1 && record.name === item.name;
    const segment: FollowingNameSegment = { name: record.name, from: record.seenAt, isCurrent };
    if (next) segment.to = next.seenAt;
    return segment;
  });
  return segments.reverse();
};

/**
 * 第三方（aicu.cc）存档的曾用名。
 *
 * 该数据**没有时间戳、顺序不保证、可能混入占位文案**，因此必须与本地观测的
 * 时间轴分开呈现，绝不能合并进同一条时间轴。这里做去重与占位文案过滤。
 */
export const buildThirdPartyNames = (item: FollowingItem): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const name of item.thirdPartyNames ?? []) {
    const trimmed = (name ?? "").trim();
    if (!trimmed || isGoneName(trimmed) || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
};

/** 是否展示"曾用名"入口：本地改过名，或第三方存档里有名字 */
export const hasFormerNames = (item: FollowingItem): boolean =>
  (item.nameHistory?.length ?? 0) > 1 || buildThirdPartyNames(item).length > 0;

// ---------------------------------------------------------------------------
// 状态展示
// ---------------------------------------------------------------------------

export const FOLLOWING_STATUS_LABEL: Record<FollowingItem["status"], string> = {
  following: "仍关注",
  unfollowed: "已取关",
  gone: "已注销",
};

/** 已取关 / 已注销的行需要弱化显示，扫读时才能一眼分辨 */
export const isDeemphasized = (item: FollowingItem): boolean => item.status !== "following";

/** 变更时间：优先状态变更时间，最后回退到最近一次观测 */
export const statusChangedAt = (item: FollowingItem): number | undefined => {
  if (item.status === "gone") return item.goneDetectedAt;
  if (item.status === "unfollowed") return item.unfollowedDetectedAt;
  return undefined;
};
