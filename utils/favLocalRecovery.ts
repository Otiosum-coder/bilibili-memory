import { isBetterCover, type RecoveryOutcome } from "./favRecovery";
import { isPlaceholderImage } from "./imageUrl";
import type { FavoriteResource, FavRecoverySource } from "./types";

/**
 * 本地交叉引用：用**已经在库里的**封面补全失效收藏的封面。**零网络请求。**
 *
 * 思路：同一个稿件可能同时存在于多个模块的本地数据里——
 * 你看过的历史记录、喜欢过的音乐、订阅合集的内容。这些记录里都带 `bvid` 与封面，
 * 而且它们是在稿件失效**之前**被抓下来的，所以封面往往还是好的。
 *
 * 优先级（先到先得，不覆盖已有的更好结果）：
 * `history` → `likedMusic` → `collection`。
 * 顺序本身不关键（同一个 bvid 的封面本来就应该一样），但固定下来结果才可复现。
 *
 * 只补**封面**。标题不受影响，仍走各自的恢复流程，因此这一步不会掩盖标题的缺失。
 */

export type LocalCoverSource = "history" | "likedMusic" | "collection";

const SOURCE_TO_RECOVERY: Record<LocalCoverSource, FavRecoverySource> = {
  history: "local_history",
  likedMusic: "local_liked",
  collection: "local_collection",
};

export const LOCAL_COVER_SOURCE_LABEL: Record<LocalCoverSource, string> = {
  history: "观看历史",
  likedMusic: "喜欢的音乐",
  collection: "订阅合集",
};

export interface LocalCoverCandidate {
  cover: string;
  source: LocalCoverSource;
}

export interface LocalCoverSources {
  history?: Array<{ bvid?: string; cover?: string }>;
  likedMusic?: Array<{ bvid?: string; pic?: string }>;
  collectionResources?: Array<{ bvid?: string; cover?: string }>;
}

/**
 * 建立 `bvid → 封面` 索引。
 *
 * 占位图不收录——把占位封面收进索引等于给失效条目"匹配"到另一个占位封面，白忙一场。
 */
export const buildLocalCoverIndex = (
  sources: LocalCoverSources,
): Map<string, LocalCoverCandidate> => {
  const index = new Map<string, LocalCoverCandidate>();

  const push = (bvid: string | undefined, cover: string | undefined, source: LocalCoverSource) => {
    const key = (bvid ?? "").trim();
    if (!key || !cover) return;
    if (isPlaceholderImage(cover)) return;
    if (index.has(key)) return;
    index.set(key, { cover, source });
  };

  for (const item of sources.history ?? []) push(item.bvid, item.cover, "history");
  for (const item of sources.likedMusic ?? []) push(item.bvid, item.pic, "likedMusic");
  for (const item of sources.collectionResources ?? []) {
    push(item.bvid, item.cover, "collection");
  }

  return index;
};

/** 取记录的 bvid（`bvid` 与 `bv_id` 在不同接口版本里互相缺省） */
export const resourceBvid = (resource: FavoriteResource): string =>
  (resource.bvid || resource.bv_id || "").trim();

/**
 * 用索引里的封面补全记录。
 *
 * `changed: true` 但 `fields` 只含 `cover` —— 调用方据此判断"标题是否仍需恢复"。
 */
export const applyLocalCover = (
  resource: FavoriteResource,
  candidate: LocalCoverCandidate | undefined,
  now: number,
): RecoveryOutcome => {
  if (!candidate) return { resource, changed: false, fields: [] };
  if (!isBetterCover(resource.cover, candidate.cover)) {
    return { resource, changed: false, fields: [] };
  }

  return {
    resource: {
      ...resource,
      cover: candidate.cover,
      recoveredAt: now,
      recoverySource: SOURCE_TO_RECOVERY[candidate.source],
    },
    changed: true,
    fields: ["cover"],
  };
};
