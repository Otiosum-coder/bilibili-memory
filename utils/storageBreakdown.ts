import { estimateStoreSize, getTotalHistoryCount, measureAssets } from "./db";
import type { AssetKind } from "./types";
import type { StorageHealthReport } from "./storageHealth";
import {
  summarizeAssets,
  sumBreakdownBytes,
  type AssetKindSummary,
  type StoreSizeSummary,
} from "./storageFormat";

/**
 * 本地存储明细（IO 部分）。
 *
 * 为什么需要单独一个模块：`navigator.storage.estimate()` 给的是**整个 origin 的总量**，
 * 里面混着 CacheStorage、localStorage 等不属于本扩展的东西，所以"到底什么占地方"
 * 从来没能回答过。这里按类别拆开，并且**明确区分精确值与估算值**：
 *
 * - **图片字节归档**：`blob.size` 是真实字节，**精确**
 * - **结构化数据**：只采样若干条算平均行大小再乘以条数，**估算**
 *
 * 这条界线不能糊：图片是占用大头，用户要拿这个数字决定删什么，必须可信；
 * 而结构化数据的行大小随内容浮动，给一个"精确到字节"的数字反而是假精度。
 *
 * 纯计算部分在 `storageFormat.ts`（可在 node 环境单测），这里只负责采集。
 */

export type { AssetKindSummary, StoreSizeSummary };
export { ASSET_KIND_META, summarizeAssets, sumBreakdownBytes, sumSelectedAssetBytes } from "./storageFormat";

export interface StorageBreakdown {
  assets: AssetKindSummary[];
  assetBytes: number;
  stores: StoreSizeSummary[];
  businessBytes: number;
  /** 整个 origin 的总用量（含非本扩展的数据），来自 `storage.estimate()` */
  originUsage: number;
  originQuota: number;
  checkedAt: number;
}

/** 采集一次完整明细。条数全部精确，只有结构化数据的字节数是采样估算 */
export const buildStorageBreakdown = async (
  health: StorageHealthReport | null,
): Promise<StorageBreakdown> => {
  const kinds: AssetKind[] = ["cover", "avatar"];
  const measured = await Promise.all(
    kinds.map((kind) => measureAssets(kind).then((result) => ({ kind, ...result }))),
  );

  const [
    history,
    historyEvents,
    historyContent,
    historyVisit,
    favResources,
    favFolders,
    collections,
    collectionResources,
    following,
    followingEvents,
    tombstones,
    vanished,
    likedMusic,
    interactions,
  ] = await Promise.all([
    estimateStoreSize("history"),
    estimateStoreSize("historyEvents"),
    getTotalHistoryCount("content"),
    getTotalHistoryCount("visit"),
    estimateStoreSize("favResources"),
    estimateStoreSize("favFolders"),
    estimateStoreSize("subscribedCollections"),
    estimateStoreSize("subscribedCollectionResources"),
    estimateStoreSize("following"),
    estimateStoreSize("followingEvents"),
    estimateStoreSize("historyTombstones"),
    estimateStoreSize("vanishedFavResources"),
    estimateStoreSize("likedMusic"),
    estimateStoreSize("interactions"),
  ]);

  const assets = summarizeAssets(measured);

  const stores: StoreSizeSummary[] = [
    {
      label: "观看事件",
      count: historyVisit,
      bytes: historyEvents.bytes,
      note: "每次同步观测到都追加一条，反复观看会持续增长（只增不减）",
    },
    {
      label: "最近观看投影",
      count: historyContent,
      bytes: history.bytes,
      note: "每个内容一行，字段是观看事件的子集",
    },
    { label: "收藏资源", count: favResources.count, bytes: favResources.bytes },
    { label: "收藏夹", count: favFolders.count, bytes: favFolders.bytes },
    { label: "订阅合集资源", count: collectionResources.count, bytes: collectionResources.bytes },
    { label: "订阅合集", count: collections.count, bytes: collections.bytes },
    {
      label: "互动记录",
      count: interactions.count,
      bytes: interactions.bytes,
      note: "B 站各保留 20 条窗口，条数天然封顶",
    },
    { label: "关注 UP 主", count: following.count, bytes: following.bytes },
    { label: "关注变动事件", count: followingEvents.count, bytes: followingEvents.bytes },
    {
      label: "删除墓碑",
      count: tombstones.count,
      bytes: tombstones.bytes,
      note: "阻止已删除的记录在同步时复活，只增不减",
    },
    { label: "收藏消失档案", count: vanished.count, bytes: vanished.bytes },
    { label: "喜欢的音乐", count: likedMusic.count, bytes: likedMusic.bytes },
  ];

  return {
    assets,
    assetBytes: assets.reduce((total, entry) => total + entry.bytes, 0),
    stores,
    businessBytes: sumBreakdownBytes(assets, stores),
    originUsage: health?.usage ?? 0,
    originQuota: health?.quota ?? 0,
    checkedAt: Date.now(),
  };
};
