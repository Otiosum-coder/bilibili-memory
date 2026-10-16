import type {
  FavoriteResource,
  FavInvalidatedKind,
  FavVanishReason,
  VanishedFavResource,
} from "./types";

/**
 * 收藏内容保全的判定逻辑（纯函数，可单测）。
 *
 * 背景：`syncFavoriteFolderResources` 原本在完整全量同步后**直接删除**在线列表里
 * 不存在的本地记录。但 B 站收藏夹接口**不返回"这条为什么消失"**，于是两种完全不同的
 * 原因被一视同仁地当作"你取消收藏"：
 *
 * 1. 你主动取消收藏 —— 删掉本地记录是合理的
 * 2. 视频被 UP 主删除 / 下架 / 转私密 —— 删掉就等于销毁证据
 *
 * 因为无法区分，保守做法只能是**先留档再移除**：宁可多留，也不能把被删内容的记录抹掉。
 * 代价是"你取消收藏"的记录也会进档案，这是已确认接受的取舍。
 */

/** 失效标题的兜底信号。主判定用 `attr`，因为 B 站可能改文案 */
export const INVALIDATED_TITLE_RE = /已失效|失效视频|稿件不可见|已被删除/;

/**
 * 由 `attr` 解析失效类型。`0` 与缺失都表示正常。
 * `attr` 语义来自社区脚本标注，未经官方确认；未知取值归入 `other`。
 */
export const resolveInvalidatedKind = (
  attr: number | undefined | null,
): FavInvalidatedKind | null => {
  if (attr === undefined || attr === null || attr === 0) return null;
  if (attr === 1) return "removed_by_other";
  if (attr === 9) return "removed_by_uploader";
  return "other";
};

/** 是否已失效。以 `attr` 为主判定、标题文案为兜底 */
export const isInvalidatedResource = (resource: FavoriteResource | undefined): boolean => {
  if (!resource) return false;
  if (resolveInvalidatedKind(resource.attr) !== null) return true;
  return INVALIDATED_TITLE_RE.test(resource.title ?? "");
};

export interface VanishCandidatesInput {
  /** 本轮同步前本地已有的记录 */
  localResources: FavoriteResource[];
  /** 本轮在线列表中出现的资源 id 集合 */
  onlineResourceIds: Set<number>;
  /** 是否全量同步。增量同步从不做删除判定 */
  isFullSync: boolean;
  /** 是否完整翻页到末页。未完整时绝不判定，否则一次网络抖动会误删整页 */
  allPagesFetched: boolean;
}

/**
 * L2 候选：完整全量扫描后，在线列表里不存在的本地记录。
 *
 * **任一前提不满足都返回空数组** —— 这是防误删的核心护栏，两个负例都有单测锁定。
 */
export const buildVanishCandidates = (input: VanishCandidatesInput): FavoriteResource[] => {
  if (!input.isFullSync || !input.allPagesFetched) return [];
  return input.localResources.filter((item) => !input.onlineResourceIds.has(item.id));
};

export interface ViewProbeResult {
  /** 请求本身是否成功（能拿到 JSON 且 HTTP 2xx） */
  ok: boolean;
  code: number | null;
  message?: string | null;
}

/**
 * 把二次探测的结果映射为消失原因。
 *
 * - `code 0`：视频仍在 → 判定为你取消了收藏
 * - `-404`：稿件不存在 → 内容被彻底删除
 * - `62002`：稿件不可见 → 转私密 / 被限制（内容可能还在）
 * - 网络失败 / 风控 / 其他错误：**unknown，但依然留档**
 */
export const classifyViewProbe = (result: ViewProbeResult): FavVanishReason => {
  if (!result.ok || result.code === null) return "unknown";
  if (result.code === 0) return "unfavorited";
  if (result.code === -404) return "content_deleted";
  if (result.code === 62002) return "content_hidden";
  return "unknown";
};

/**
 * 组装消失档案条目。
 *
 * 在 `FavoriteResource` 全字段基础上冗余保存 `lastKnownTitle` / `lastKnownCover`：
 * 档案的核心价值就是"消失前它长什么样"，不能依赖上游字段以后还在。
 */
export const buildVanishedRecord = (
  resource: FavoriteResource,
  reason: FavVanishReason,
  now: number,
  probeError?: string,
): VanishedFavResource => {
  const record: VanishedFavResource = {
    ...resource,
    vanishedAt: now,
    vanishReason: reason,
    probeAttemptedAt: now,
    lastKnownTitle: resource.title,
    lastKnownCover: resource.cover,
  };
  if (probeError) record.probeError = probeError;
  return record;
};

/** 消失原因的中文标签，供界面直接使用 */
export const VANISH_REASON_LABEL: Record<FavVanishReason, string> = {
  unfavorited: "已取消收藏",
  content_deleted: "内容已被删除",
  content_hidden: "内容已不可见",
  unknown: "原因不明",
};

/** 失效类型的中文标签 */
export const INVALIDATED_KIND_LABEL: Record<FavInvalidatedKind, string> = {
  removed_by_other: "其他原因删除/退回",
  removed_by_uploader: "UP 主自己删除",
  other: "其他原因",
};

// ---------------------------------------------------------------------------
// 消失档案的查询与统计
// ---------------------------------------------------------------------------

export interface VanishedStats {
  total: number;
  byReason: Record<FavVanishReason, number>;
}

export const buildVanishedStats = (items: VanishedFavResource[]): VanishedStats => {
  const byReason: Record<FavVanishReason, number> = {
    unfavorited: 0,
    content_deleted: 0,
    content_hidden: 0,
    unknown: 0,
  };
  for (const item of items) {
    if (byReason[item.vanishReason] === undefined) byReason.unknown += 1;
    else byReason[item.vanishReason] += 1;
  }
  return { total: items.length, byReason };
};

export interface VanishedFilter {
  keyword?: string;
  reason?: FavVanishReason | "all";
  folderId?: number | "all";
}

/**
 * 档案检索。按消失时间倒序，最新的在前。
 *
 * 检索范围包含 `lastKnownTitle`：档案里 title 可能已经被占位内容覆盖过，
 * 真正有意义的是消失前记录下来的那个标题。
 */
export const queryVanishedResources = (
  items: VanishedFavResource[],
  filter: VanishedFilter = {},
): VanishedFavResource[] => {
  const keyword = (filter.keyword ?? "").trim().toLowerCase();
  const reason = filter.reason ?? "all";
  const folderId = filter.folderId ?? "all";

  return items
    .filter((item) => {
      if (reason !== "all" && item.vanishReason !== reason) return false;
      if (folderId !== "all" && item.folder_id !== folderId) return false;
      if (!keyword) return true;
      const haystack = [
        item.lastKnownTitle ?? "",
        item.title ?? "",
        item.upper?.name ?? "",
        item.bvid ?? "",
        item.bv_id ?? "",
        String(item.id),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(keyword);
    })
    .sort((a, b) => b.vanishedAt - a.vanishedAt);
};
