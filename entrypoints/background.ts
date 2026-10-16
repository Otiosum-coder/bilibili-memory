import {
  HAS_FULL_SYNC,
  HAS_FULL_FAV_SYNC,
  HISTORY_LAST_SYNC,
  SYNC_INTERVAL,
  IS_SYNC_DELETE_FROM_BILIBILI,
  WEBDAV_LAST_SYNC,
  WEBDAV_AUTO_SYNC_ENABLED,
  WEBDAV_AUTO_SYNC_INTERVAL,
  WEBDAV_SYNC_ITEMS,
  DEFAULT_WEBDAV_SYNC_ITEMS,
  WebDavSyncItems,
  WebDavSyncKey,
  LOCAL_HISTORY_BACKUP_ALARM,
  FAVORITE_FOLDER_SYNC_PROGRESS,
  ALL_FAVORITE_FOLDERS_SYNC_PROGRESS,
  HISTORY_SYNC_WATERMARK_VIEW_AT,
  HAS_FULL_FOLLOWING_SYNC,
  FOLLOWING_LAST_SYNC,
  FOLLOWING_AUTO_SYNC_ENABLED,
  FOLLOWING_SYNC_INTERVAL,
  FOLLOWING_SYNC_PROGRESS,
  FOLLOWING_AVATAR_ARCHIVE_PROGRESS,
  FAV_COVER_ARCHIVE_PROGRESS,
  FAVORITES_AUTO_SYNC_ENABLED,
  FAVORITES_SYNC_INTERVAL,
  FAVORITES_LAST_SYNC,
  FAVORITES_LAST_FULL_SYNC,
  FAVORITES_FULL_SYNC_INTERVAL,
  DEFAULT_FAV_AUTO_SYNC_ENABLED,
  DEFAULT_FAV_SYNC_INTERVAL_MINUTES,
  DEFAULT_FAV_FULL_SYNC_INTERVAL_MINUTES,
  COLLECTION_COVER_ARCHIVE_PROGRESS,
  DEFAULT_FOLLOWING_AUTO_SYNC_ENABLED,
  DEFAULT_FOLLOWING_SYNC_INTERVAL_MINUTES,
  INTERACTIONS_LAST_SYNC,
  INTERACTIONS_AUTO_SYNC_ENABLED,
  INTERACTIONS_SYNC_INTERVAL,
  INTERACTIONS_SYNC_PROGRESS,
  INTERACTIONS_COVER_ARCHIVE_PROGRESS,
  INTERACTIONS_PAGE_TRIGGER_LAST_AT,
  INTERACTIONS_FIRST_SYNC_AT,
  DEFAULT_INTERACTIONS_AUTO_SYNC_ENABLED,
  DEFAULT_INTERACTIONS_SYNC_INTERVAL_MINUTES,
  DEFAULT_INTERACTIONS_PAGE_TRIGGER_GAP_MINUTES,
} from "../utils/constants";
import {
  deleteHistoryContent,
  saveFavFolders,
  replaceFavFolders,
  saveFavResources,
  getFavResources,
  moveFavResourcesToVanished,
  applyFavResourceRecovery,
  applySubscribedCollectionCoverAssets,
  getAllHistory,
  getAllLikedMusic,
  getAllFavFolders,
  getAllFavResources,
  getAllSubscribedCollections,
  getAllSubscribedCollectionResources,
  smartMergeHistory,
  smartMergeFavResources,
  importFavFolders,
  importSubscribedCollections,
  smartMergeSubscribedCollectionResources,
  replaceSubscribedCollections,
  replaceSubscribedCollectionResources,
  getSubscribedCollectionResources,
  putVanishArchive,
  getAllVanishArchive,
  smartMergeVanishArchive,
  getDeletedHistoryIds,
  getHistoryV2Backup,
  mergeHistoryV2Backup,
  upsertHistorySnapshots,
  getAllFollowing,
  getAllFollowingEvents,
  getFollowingEventsByDay,
  getAllVanishedFavResources,
  smartMergeFollowing,
  smartMergeFollowingEvents,
  smartMergeVanishedFavResources,
  applyFollowingSync,
  patchFollowingItems,
  getAllInteractions,
  getInteractionsByType,
  putInteractionItems,
  applyInteractionCoverAssets,
  smartMergeInteractions,
} from "../utils/db";
import { getStorageValue, setStorageValue } from "../utils/storage";
import { recordStorageWarning } from "../utils/storageHealth";
import {
  ensureDirectory,
  uploadFile,
  downloadFile,
  withWebDavOperationLock,
  loadWebDavConfig,
} from "../utils/webdav";
import {
  FavoriteFolder,
  FavoriteResource,
  VanishedFavResource,
  RefreshFavoriteFoldersResponse,
  SubscribedCollection,
  SubscribedCollectionResource,
  SyncFavoriteFolderRequest,
  SyncFavoriteFolderResponse,
  SyncHistoryRequest,
  SyncHistoryResponse,
  LocalHistoryBackupRequest,
  LocalHistoryBackupResult,
  FavoriteFolderSyncProgress,
  FavoriteFolderSyncErrorKind,
  SyncAllFavoriteFoldersRequest,
  SyncAllFavoriteFoldersResponse,
  AllFavoriteFoldersSyncProgress,
  HistoryItem,
  InteractionItem,
  InteractionType,
} from "../utils/types";
import type { VanishArchiveItem, VanishArchiveReason } from "../utils/types";
import {
  buildVanishedRecord,
  buildVanishCandidates,
  classifyViewProbe,
} from "../utils/favVanishedDiff";
import { probeFavoriteResource, VANISH_PROBE_DELAY_MS } from "../utils/favRepairProbe";
import {
  buildCollectionArchiveItem,
  buildFavoriteArchiveItem,
  buildInteractionArchiveItem,
  shouldArchiveInteraction,
  resolveInteractionArchiveReason,
  buildFollowingArchiveItem,
  isWorthArchiving,
} from "../utils/vanishArchive";
import {
  DEFAULT_RECOVERY_LIMIT,
  applyGuessedTitle,
  applyPublicMedia,
  applyRecoveryResult,
  buildRecoveryCandidates,
  buildRecoveryStats,
  chunkAids,
  needsRecovery,
  toValidAid,
  type FavRecoveryOutcome,
} from "../utils/favRecovery";
import {
  BILIPLUS_BATCH_DELAY_MS,
  BILIPLUS_BATCH_SIZE,
  JIJIDOWN_BACKOFF_BASE_MS,
  JIJIDOWN_ITEM_DELAY_MS,
  JIJIDOWN_MAX_PASSES,
  fetchBiliplusAidInfoWithRetry,
  fetchJijidownInfo,
} from "../utils/favBiliplusClient";
import {
  PUBLIC_FAV_MAX_PAGES_PER_RUN,
  PUBLIC_FAV_PAGE_DELAY_MS,
  fetchPublicFavPage,
  groupCandidatesByPage,
} from "../utils/favPublicApi";
import {
  applyLocalCover,
  buildLocalCoverIndex,
  resourceBvid,
} from "../utils/favLocalRecovery";
import {
  buildFollowingNotification,
  buildVanishedNotification,
  sendChangeNotification,
} from "../utils/notifications";
import { formatLocalDay } from "../utils/followingDiff";
import { isLocalHistoryBackupDue, runLocalHistoryBackup } from "../utils/localHistoryBackup";
import {
  FOLLOWING_PAGE_SIZE,
  FollowingRequestError,
  fetchFollowingPage,
  getBilibiliSessdata,
  getCurrentBilibiliMid,
} from "../utils/followingApi";
import {
  DEFAULT_FOLLOWING_PAGE_DELAY_MS,
  runFollowingSync,
  shouldRunFollowingSync,
  type FollowingSyncOutcome,
  type FollowingSyncProgress,
} from "../utils/followingSync";
import {
  runAvatarArchive,
  type AvatarArchiveProgress,
} from "../utils/followingAssetArchive";
import { archiveAvatar, archiveCover } from "../utils/assetArchive";
import {
  runCoverArchive,
  type CoverArchiveProgress,
} from "../utils/favCoverArchive";
import {
  INTERACTION_PAGE_SIZE,
  fetchInteractionPage,
  probeInteraction,
} from "../utils/interactionApi";
import {
  DEFAULT_INTERACTION_PAGE_DELAY_MS,
  DEFAULT_INTERACTION_PROBE_DELAY_MS,
  DEFAULT_MAX_PROBES_PER_RUN,
  runInteractionSync,
  shouldRunInteractionSync,
  type InteractionSyncOutcome,
  type InteractionSyncProgress,
  type InteractionSyncTrigger,
} from "../utils/interactionSync";

const FAVORITE_FOLDER_RATE_LIMIT_COOLDOWNS_MS = [10, 30, 60].map((minutes) => minutes * 60 * 1000);
const FAVORITE_FOLDER_PAGE_DELAY_MIN_MS = 1500;
const FAVORITE_FOLDER_PAGE_DELAY_MAX_MS = 3000;
const FAVORITE_FOLDER_DELAY_MIN_MS = 2000;
const FAVORITE_FOLDER_DELAY_MAX_MS = 5000;

class FavoriteFolderRequestError extends Error {
  constructor(
    message: string,
    readonly kind: FavoriteFolderSyncErrorKind,
    readonly status?: number,
  ) {
    super(message);
    this.name = "FavoriteFolderRequestError";
  }
}

const normalizeFavoriteFolderRequestError = (error: unknown): FavoriteFolderRequestError => {
  if (error instanceof FavoriteFolderRequestError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new FavoriteFolderRequestError("请求超时", "network");
  }
  if (error instanceof TypeError) {
    return new FavoriteFolderRequestError(error.message || "网络请求失败", "network");
  }
  return new FavoriteFolderRequestError(
    error instanceof Error ? error.message : "未知错误",
    "unknown",
  );
};

const getRandomDelay = (minMs: number, maxMs: number): number =>
  Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;

export default defineBackground(() => {
  let localHistoryBackupPromise: Promise<LocalHistoryBackupResult> | null = null;
  let webDavSyncPromise: Promise<void> | null = null;
  let favoriteSyncPromise: Promise<unknown> | null = null;
  let favoriteFolderSyncPromise: Promise<FavoriteFolder> | null = null;
  let allFavoriteFoldersSyncPromise: Promise<void> | null = null;

  const isSameFolderCheckpoint = (
    progress: FavoriteFolderSyncProgress | null,
    folderId: number,
    mode: "full" | "incremental",
  ) =>
    progress?.status !== "success" &&
    progress?.folderId === folderId &&
    progress.mode === mode &&
    Number.isSafeInteger(progress.nextPage) &&
    progress.nextPage >= 1;

  const normalizeAllFoldersCheckpoint = (
    progress: AllFavoriteFoldersSyncProgress | null,
    folderIds: number[],
    mode: "full" | "incremental",
  ): AllFavoriteFoldersSyncProgress | null => {
    if (
      !progress ||
      progress.status === "success" ||
      progress.mode !== mode ||
      !Array.isArray(progress.folderIds) ||
      progress.folderIds.length !== folderIds.length ||
      !progress.folderIds.every((id, index) => id === folderIds[index]) ||
      !Number.isSafeInteger(progress.nextPage) ||
      progress.nextPage < 1
    ) {
      return null;
    }

    const hasExplicitIndex = Number.isSafeInteger(progress.currentFolderIndex);
    const currentFolderIndex = hasExplicitIndex
      ? progress.currentFolderIndex
      : progress.completedCount;
    if (
      !Number.isSafeInteger(currentFolderIndex) ||
      currentFolderIndex < 0 ||
      currentFolderIndex >= folderIds.length ||
      (hasExplicitIndex && progress.completedCount !== currentFolderIndex)
    ) {
      return null;
    }

    const expectedFolderId = folderIds[currentFolderIndex];
    const currentFolderId = Number.isSafeInteger(progress.currentFolderId)
      ? progress.currentFolderId
      : expectedFolderId;
    if (currentFolderId !== expectedFolderId) return null;

    return {
      ...progress,
      currentFolderIndex,
      currentFolderId,
      completedCount: currentFolderIndex,
      totalFolders: folderIds.length,
    };
  };

  const startFavoriteSync = <T>(task: () => Promise<T>): Promise<T> | null => {
    if (favoriteSyncPromise) return null;
    const promise = task();
    favoriteSyncPromise = promise;
    return promise;
  };

  const finishFavoriteSync = (task: Promise<unknown>): void => {
    if (favoriteSyncPromise === task) favoriteSyncPromise = null;
  };

  async function updateFavoriteFolderSyncProgress(
    progress: FavoriteFolderSyncProgress | null,
  ): Promise<void> {
    if (progress === null) {
      await browser.storage.local.remove(FAVORITE_FOLDER_SYNC_PROGRESS);
      return;
    }
    await setStorageValue(FAVORITE_FOLDER_SYNC_PROGRESS, progress);
  }

  async function updateAllFavoriteFoldersSyncProgress(
    progress: AllFavoriteFoldersSyncProgress | null,
  ): Promise<void> {
    if (progress === null) {
      await browser.storage.local.remove(ALL_FAVORITE_FOLDERS_SYNC_PROGRESS);
      return;
    }
    await setStorageValue(ALL_FAVORITE_FOLDERS_SYNC_PROGRESS, progress);
  }

  const ensureLocalHistoryBackupAlarm = async (): Promise<void> => {
    const alarm = await browser.alarms.get(LOCAL_HISTORY_BACKUP_ALARM);
    if (!alarm || alarm.periodInMinutes !== 1) {
      await browser.alarms.create(LOCAL_HISTORY_BACKUP_ALARM, {
        periodInMinutes: 1,
      });
    }
  };

  const runLocalHistoryBackupOnce = (allowEmpty = false): Promise<LocalHistoryBackupResult> => {
    if (localHistoryBackupPromise) return localHistoryBackupPromise;

    localHistoryBackupPromise = runLocalHistoryBackup(allowEmpty).finally(() => {
      localHistoryBackupPromise = null;
    });
    return localHistoryBackupPromise;
  };

  void ensureLocalHistoryBackupAlarm().catch((error) => {
    console.error("初始化历史记录本地备份定时任务失败:", error);
  });

  const actionApi = browser.action ?? browser.browserAction;
  actionApi.onClicked.addListener(() => {
    void browser.tabs.create({
      url: browser.runtime.getURL("/my-history.html"),
    });
  });

  // 兜底：Service Worker 每次启动都确保本 fork 新增的 alarm 存在。
  // 仅靠 onInstalled 不够——重载未打包扩展时它未必触发，定时任务会静默消失。
  // alarms.create 同名覆盖，重复调用是幂等的。
  browser.alarms.create("syncFollowing", {
    periodInMinutes: 1,
  });
  browser.alarms.create("archiveFollowingAvatars", {
    periodInMinutes: 1,
  });
  browser.alarms.create("archiveFavCovers", {
    periodInMinutes: 1,
  });
  browser.alarms.create("archiveCollectionCovers", {
    periodInMinutes: 1,
  });
  browser.alarms.create("syncInteractions", {
    periodInMinutes: 1,
  });
  browser.alarms.create("archiveInteractionCovers", {
    periodInMinutes: 1,
  });
  // 收藏夹自动同步（默认关闭）。日常走增量——增量拉到"本地边界"就停，很便宜；
  // 只有距上次全量超过 FAVORITES_FULL_SYNC_INTERVAL 时才跑全量，
  // 因为**只有全量才会做消失判定**（增量有 allPagesFetched 护栏，一律不判）。
  browser.alarms.create("syncFavorites", {
    periodInMinutes: 1,
  });
  // 初始化定时任务
  browser.runtime.onInstalled.addListener(async (details) => {
    // 设置每分钟同步一次
    browser.alarms.create("syncHistory", {
      periodInMinutes: 1,
    });
    // 设置每分钟检查一次 WebDAV 自动同步
    browser.alarms.create("syncWebDav", {
      periodInMinutes: 1,
    });
    // 设置每分钟检查一次关注列表同步（内部按 FOLLOWING_SYNC_INTERVAL 节流，默认 1 天）
    browser.alarms.create("syncFollowing", {
      periodInMinutes: 1,
    });
    // 设置每分钟推进一次头像字节归档，归档完成后自动停止
    browser.alarms.create("archiveFollowingAvatars", {
      periodInMinutes: 1,
    });
    // 设置每分钟推进一次收藏封面字节归档，归档完成后自动停止
    browser.alarms.create("archiveFavCovers", {
      periodInMinutes: 1,
    });
    browser.alarms.create("archiveCollectionCovers", {
      periodInMinutes: 1,
    });
    // 点赞 / 投币列表只有 20 条窗口，节流间隔默认 3 小时（见 INTERACTIONS_SYNC_INTERVAL）
    browser.alarms.create("syncInteractions", {
      periodInMinutes: 1,
    });
    // 每分钟推进一次互动记录封面归档，归档完成后自动停止
    browser.alarms.create("archiveInteractionCovers", {
      periodInMinutes: 1,
    });

    // 只在首次安装时打开设置页面并执行初始化同步
    if (details.reason === "install") {
      const url = browser.runtime.getURL("/my-history.html#/welcome");
      browser.tabs.create({ url });

      // 延迟执行，确保页面加载状态
      setTimeout(async () => {
        // 并行执行初始化同步
        const initHistory = async () => {
          try {
            await syncHistory(true);
          } catch (e) {
            console.error("History init failed", e);
          }
        };
        const initFav = async () => {
          try {
            const task = startFavoriteSync(() => syncFavorites(true));
            if (!task) return;
            try {
              await task;
              await setStorageValue(HAS_FULL_FAV_SYNC, true);
            } finally {
              finishFavoriteSync(task);
            }
          } catch (e) {
            console.error("Fav init failed", e);
          }
        };
        // 安装后立刻抓一次点赞 / 投币：这两个列表只有 20 条窗口，越早开始留存越好
        const initInteractions = async () => {
          try {
            const task = startInteractionSync({
              trigger: "manual",
              maxProbesPerRun: DEFAULT_MAX_PROBES_PER_RUN,
            });
            if (!task) return;
            await task;
          } catch (e) {
            console.error("Interactions init failed", e);
          }
        };
        initHistory();
        initFav();
        initInteractions();
      }, 1000);
    }
  });

  const intervalSync = async () => {
    try {
      // 执行增量同步
      await syncHistory(false);
    } catch (error) {
      console.error("定时同步失败:", error);
    }
  };

  // 监听定时任务
  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === "syncHistory") {
      // 获取同步间隔
      const syncInterval = await getStorageValue(SYNC_INTERVAL, 1);
      // 根据最近一次成功同步的时间判断是否需要同步
      const lastSyncTime = await getStorageValue<number>(HISTORY_LAST_SYNC, 0);
      const elapsed = Date.now() - lastSyncTime;
      const intervalMs = syncInterval * 60 * 1000;

      if (elapsed <= intervalMs) {
        const remainingMinutes = Math.ceil((intervalMs - elapsed) / 60000);
        console.log(`还需${remainingMinutes}分钟进行历史记录同步，暂时跳过`);
        return;
      }

      // 同步成功后，syncHistory 会更新最近一次同步时间
      void intervalSync();
    } else if (alarm.name === "syncWebDav") {
      // WebDAV 自动同步：基于上次同步时间判断
      const enabled = await getStorageValue(WEBDAV_AUTO_SYNC_ENABLED, false);
      if (!enabled) return;

      const syncInterval = await getStorageValue(WEBDAV_AUTO_SYNC_INTERVAL, 30);
      const lastSyncTime = await getStorageValue<number>(WEBDAV_LAST_SYNC, 0);
      const elapsed = Date.now() - lastSyncTime;
      const intervalMs = syncInterval * 60 * 1000;

      if (elapsed < intervalMs) {
        console.log(
          `WebDAV 自动同步：距上次同步仅 ${Math.round(elapsed / 60000)} 分钟，需等待 ${syncInterval} 分钟`,
        );
        return;
      }

      // 距离上次同步已超过设定间隔，执行备份
      if (!webDavSyncPromise) {
        webDavSyncPromise = withWebDavOperationLock(autoSyncWebDav).finally(() => {
          webDavSyncPromise = null;
        });
      }
      await webDavSyncPromise;
    } else if (alarm.name === "syncFollowing") {
      try {
        const enabled = await getStorageValue(
          FOLLOWING_AUTO_SYNC_ENABLED,
          DEFAULT_FOLLOWING_AUTO_SYNC_ENABLED,
        );
        const intervalMinutes = await getStorageValue(
          FOLLOWING_SYNC_INTERVAL,
          DEFAULT_FOLLOWING_SYNC_INTERVAL_MINUTES,
        );
        const lastSyncAt = await getStorageValue<number | null>(FOLLOWING_LAST_SYNC, null);

        if (
          !shouldRunFollowingSync({
            enabled,
            intervalMinutes,
            lastSyncAt,
            now: Date.now(),
          })
        ) {
          // 静默跳过会让"功能是不是坏了"无从判断，照历史记录同步的做法打一行日志
          const intervalMs = Math.max(0, intervalMinutes) * 60 * 1000;
          const remaining = lastSyncAt
            ? Math.max(0, Math.ceil((intervalMs - (Date.now() - lastSyncAt)) / 60000))
            : 0;
          const suffix = lastSyncAt ? `还需${remaining}分钟` : "尚未同步过";
          console.log(`${suffix}进行关注列表同步，暂时跳过`);
          return;
        }

        void startFollowingSync();
      } catch (error) {
        console.error("关注列表定时同步失败:", error);
      }
    } else if (alarm.name === "archiveFollowingAvatars") {
      try {
        // 全部归档完成后不再每分钟读整张表
        const progress = await readAvatarArchiveProgress();
        if (progress?.status === "completed") return;

        const task = startAvatarArchive();
        if (!task) return;
        const result = await task;
        console.log(
          `头像归档：累计 ${result.archived} 张，失败 ${result.failed}，剩余 ${result.remaining}`,
        );
      } catch (error) {
        console.error("头像归档失败:", error);
      }
    } else if (alarm.name === "archiveFavCovers") {
      try {
        // 全部归档完成后不再每分钟读整张表
        const progress = await readCoverArchiveProgress();
        if (progress?.status === "completed") return;

        const task = startCoverArchive();
        if (!task) return;
        const result = await task;
        console.log(
          `封面归档：累计 ${result.archived} 张，失败 ${result.failed}，剩余 ${result.remaining}`,
        );
      } catch (error) {
        console.error("封面归档失败:", error);
      }
    } else if (alarm.name === "archiveCollectionCovers") {
      try {
        const progress = await readCollectionCoverArchiveProgress();
        if (progress?.status === "completed") return;

        const task = startCollectionCoverArchive();
        if (!task) return;
        const result = await task;
        console.log(
          `合集封面归档：累计 ${result.archived} 张，失败 ${result.failed}，剩余 ${result.remaining}`,
        );
      } catch (error) {
        console.error("合集封面归档失败:", error);
      }
    } else if (alarm.name === "syncInteractions") {
      try {
        const enabled = await getStorageValue(
          INTERACTIONS_AUTO_SYNC_ENABLED,
          DEFAULT_INTERACTIONS_AUTO_SYNC_ENABLED,
        );
        const intervalMinutes = await getStorageValue(
          INTERACTIONS_SYNC_INTERVAL,
          DEFAULT_INTERACTIONS_SYNC_INTERVAL_MINUTES,
        );
        const lastSyncAt = await getStorageValue<number | null>(INTERACTIONS_LAST_SYNC, null);

        if (!shouldRunInteractionSync({ enabled, intervalMinutes, lastSyncAt, now: Date.now() })) {
          const intervalMs = Math.max(0, intervalMinutes) * 60 * 1000;
          const remaining = lastSyncAt
            ? Math.max(0, Math.ceil((intervalMs - (Date.now() - lastSyncAt)) / 60000))
            : 0;
          const suffix = lastSyncAt ? `还需${remaining}分钟` : "尚未同步过";
          console.log(`${suffix}进行互动记录同步，暂时跳过`);
          return;
        }

        void startInteractionSync();
      } catch (error) {
        console.error("互动记录定时同步失败:", error);
      }
    } else if (alarm.name === "syncFavorites") {
      try {
        const enabled = await getStorageValue<boolean>(
          FAVORITES_AUTO_SYNC_ENABLED,
          DEFAULT_FAV_AUTO_SYNC_ENABLED,
        );
        if (!enabled) return;

        const intervalMinutes = await getStorageValue<number>(
          FAVORITES_SYNC_INTERVAL,
          DEFAULT_FAV_SYNC_INTERVAL_MINUTES,
        );
        const lastSyncAt = await getStorageValue<number | null>(FAVORITES_LAST_SYNC, null);
        const elapsedMs = lastSyncAt ? Date.now() - lastSyncAt : Number.POSITIVE_INFINITY;
        if (elapsedMs < Math.max(0, intervalMinutes) * 60 * 1000) return;

        const folders = await getAllFavFolders();
        if (folders.length === 0) return;

        // 到点才做全量：全量要翻完整个收藏夹并对消失条目逐条探测，开销明显更大
        const fullIntervalMinutes = await getStorageValue<number>(
          FAVORITES_FULL_SYNC_INTERVAL,
          DEFAULT_FAV_FULL_SYNC_INTERVAL_MINUTES,
        );
        const lastFullSyncAt = await getStorageValue<number | null>(
          FAVORITES_LAST_FULL_SYNC,
          null,
        );
        const fullDue =
          !lastFullSyncAt ||
          Date.now() - lastFullSyncAt >= Math.max(0, fullIntervalMinutes) * 60 * 1000;

        const request: SyncAllFavoriteFoldersRequest = {
          action: "syncAllFavoriteFolders",
          folders: folders.map((folder) => ({ id: folder.id, title: folder.title })),
          isFullSync: fullDue,
        };

        await new Promise<void>((resolve) => {
          handleSyncAllFavoriteFolders(request, (response) => {
            if (response.success) {
              console.log(`收藏夹自动同步完成（${fullDue ? "全量" : "增量"}）：${response.message}`);
            } else {
              console.warn("收藏夹自动同步未完成:", response.error);
            }
            resolve();
          });
        });

        await setStorageValue(FAVORITES_LAST_SYNC, Date.now());
        if (fullDue) await setStorageValue(FAVORITES_LAST_FULL_SYNC, Date.now());
      } catch (error) {
        console.error("收藏夹定时同步失败:", error);
      }
    } else if (alarm.name === "archiveInteractionCovers") {
      try {
        const progress = await readInteractionCoverArchiveProgress();
        if (progress?.status === "completed") return;

        const task = startInteractionCoverArchive();
        if (!task) return;
        const result = await task;
        console.log(
          `互动封面归档：累计 ${result.archived} 张，失败 ${result.failed}，剩余 ${result.remaining}`,
        );
      } catch (error) {
        console.error("互动封面归档失败:", error);
      }
    } else if (alarm.name === LOCAL_HISTORY_BACKUP_ALARM) {
      try {
        if (await isLocalHistoryBackupDue()) {
          const result = await runLocalHistoryBackupOnce();
          if (!result.success) {
            console.warn("本地自动备份未完成:", result.error);
          }
        }
      } catch (error) {
        console.error("本地自动备份失败:", error);
      }
    }
  });

  // 处理同步历史记录的消息
  const handleSyncHistory = async (
    message: SyncHistoryRequest,
    sendResponse: (response: SyncHistoryResponse) => void,
  ) => {
    try {
      // 获取前端传递的isFullSync参数，如果没有则根据历史记录判断
      const forceFullSync = message.isFullSync;
      let syncResult = "";

      if (forceFullSync) {
        // 如果前端强制要求全量同步
        await syncHistory(true);
        syncResult = "全量同步成功";
        sendResponse({ success: true, message: syncResult });
      } else {
        await syncHistory(false);
        syncResult = "增量同步成功";
        sendResponse({ success: true, message: syncResult });
      }
    } catch (error) {
      console.error("同步失败:", error);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "未知错误",
      });
    }
  };

  const handleSyncFavorites = async (sendResponse: (response: any) => void) => {
    const task = startFavoriteSync(async () => {
      const hasFullFavSync = await getStorageValue(HAS_FULL_FAV_SYNC, false);
      await syncFavorites(!hasFullFavSync);
      if (!hasFullFavSync) await setStorageValue(HAS_FULL_FAV_SYNC, true);
    });
    if (!task) {
      sendResponse({ success: false, error: "收藏夹同步正在进行中，请稍后再试" });
      return;
    }

    try {
      await task;
      sendResponse({ success: true, message: "收藏夹同步成功" });
    } catch (error) {
      console.error("同步收藏夹失败:", error);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "未知错误",
      });
    } finally {
      finishFavoriteSync(task);
    }
  };

  const handleSyncFavoriteFolder = async (
    message: SyncFavoriteFolderRequest,
    sendResponse: (response: SyncFavoriteFolderResponse) => void,
  ) => {
    const folderId = Number(message.folderId);
    if (!Number.isSafeInteger(folderId) || folderId <= 0) {
      sendResponse({ success: false, error: "收藏夹信息不完整" });
      return;
    }
    if (typeof message.isFullSync !== "boolean") {
      sendResponse({ success: false, error: "同步方式不完整" });
      return;
    }

    if (favoriteSyncPromise) {
      sendResponse({ success: false, error: "收藏夹同步正在进行中，请稍后再试" });
      return;
    }

    const mode = message.isFullSync ? "full" : "incremental";
    const previousProgress = await getStorageValue<FavoriteFolderSyncProgress | null>(
      FAVORITE_FOLDER_SYNC_PROGRESS,
      null,
    );
    const isSameTask = previousProgress?.folderId === folderId && previousProgress.mode === mode;
    if (
      isSameTask &&
      previousProgress?.status === "paused" &&
      previousProgress.retryAfter &&
      Date.now() < previousProgress.retryAfter
    ) {
      sendResponse({
        success: false,
        status: "paused",
        error: previousProgress.message || "收藏夹同步正在冷却，请稍后继续",
        nextPage: previousProgress.nextPage,
        retryAfter: previousProgress.retryAfter,
      });
      return;
    }
    const checkpoint = isSameFolderCheckpoint(previousProgress, folderId, mode)
      ? previousProgress
      : null;
    const startedAt = checkpoint?.startedAt ?? Date.now();
    const task = startFavoriteSync(() =>
      syncFavoriteFolderById(folderId, message.isFullSync, startedAt, checkpoint),
    );
    if (!task) {
      sendResponse({ success: false, error: "收藏夹同步正在进行中，请稍后再试" });
      return;
    }
    favoriteFolderSyncPromise = task;

    let response: SyncFavoriteFolderResponse;
    try {
      const folder = await favoriteFolderSyncPromise;
      const messageText = `「${folder.title}」${message.isFullSync ? "全量" : "增量"}同步成功`;
      const progress = await getStorageValue<FavoriteFolderSyncProgress | null>(
        FAVORITE_FOLDER_SYNC_PROGRESS,
        null,
      );
      const completedProgress = progress ?? {
        currentPage: 0,
        nextPage: 1,
        processedItems: 0,
        totalItems: folder.media_count,
        onlineResourceIds: [],
        startedAt,
      };
      await updateFavoriteFolderSyncProgress({
        folderId,
        folderTitle: folder.title,
        mode,
        status: "success",
        currentPage: completedProgress.currentPage,
        nextPage: completedProgress.nextPage,
        processedItems: completedProgress.processedItems,
        totalItems: completedProgress.totalItems,
        onlineResourceIds: completedProgress.onlineResourceIds,
        startedAt: completedProgress.startedAt,
        updatedAt: Date.now(),
        message: messageText,
      });
      response = {
        success: true,
        message: messageText,
        folderId,
        mode,
      };
    } catch (error) {
      console.error("同步单个收藏夹失败:", error);
      const requestError = normalizeFavoriteFolderRequestError(error);
      const progress = await getStorageValue<FavoriteFolderSyncProgress | null>(
        FAVORITE_FOLDER_SYNC_PROGRESS,
        null,
      );
      const failureProgress: FavoriteFolderSyncProgress = progress ?? {
        folderId,
        folderTitle: message.folderTitle || "未知收藏夹",
        mode,
        status: "error",
        currentPage: Math.max(0, (checkpoint?.nextPage ?? 1) - 1),
        nextPage: checkpoint?.nextPage ?? 1,
        processedItems: checkpoint?.processedItems ?? 0,
        totalItems: checkpoint?.totalItems ?? 0,
        onlineResourceIds: checkpoint?.onlineResourceIds ?? [],
        startedAt,
        updatedAt: Date.now(),
        ...(checkpoint?.rateLimitCount ? { rateLimitCount: checkpoint.rateLimitCount } : {}),
      };
      if (requestError.kind === "rate_limited") {
        const rateLimitCount = (failureProgress.rateLimitCount ?? 0) + 1;
        const cooldownIndex = Math.min(
          rateLimitCount - 1,
          FAVORITE_FOLDER_RATE_LIMIT_COOLDOWNS_MS.length - 1,
        );
        const retryAfter = Date.now() + FAVORITE_FOLDER_RATE_LIMIT_COOLDOWNS_MS[cooldownIndex];
        const errorMessage = "触发 B 站访问风控，同步已暂停";
        await updateFavoriteFolderSyncProgress({
          ...failureProgress,
          status: "paused",
          errorKind: "rate_limited",
          rateLimitCount,
          retryAfter,
          updatedAt: Date.now(),
          message: errorMessage,
        });
        response = {
          success: false,
          status: "paused",
          error: errorMessage,
          nextPage: failureProgress.nextPage,
          retryAfter,
        };
      } else {
        const errorMessage = requestError.message;
        await updateFavoriteFolderSyncProgress({
          ...failureProgress,
          status: "error",
          errorKind: requestError.kind,
          updatedAt: Date.now(),
          message: errorMessage,
        });
        response = {
          success: false,
          status: "error",
          error: errorMessage,
          nextPage: failureProgress.nextPage,
        };
      }
    } finally {
      favoriteFolderSyncPromise = null;
      finishFavoriteSync(task);
    }
    sendResponse(response);
  };

  const handleSyncAllFavoriteFolders = async (
    message: SyncAllFavoriteFoldersRequest,
    sendResponse: (response: SyncAllFavoriteFoldersResponse) => void,
  ) => {
    if (favoriteSyncPromise) {
      sendResponse({ success: false, error: "收藏夹同步正在进行中，请稍后再试" });
      return;
    }

    const { folders, isFullSync } = message;
    if (!Array.isArray(folders) || folders.length === 0) {
      sendResponse({ success: false, error: "没有需要同步的收藏夹" });
      return;
    }
    if (typeof isFullSync !== "boolean") {
      sendResponse({ success: false, error: "同步方式不完整" });
      return;
    }
    if (
      folders.some(
        (folder) =>
          !Number.isSafeInteger(folder.id) || folder.id <= 0 || typeof folder.title !== "string",
      )
    ) {
      sendResponse({ success: false, error: "收藏夹信息不完整" });
      return;
    }

    const mode = isFullSync ? "full" : "incremental";
    const folderIds = folders.map((folder) => folder.id);
    if (new Set(folderIds).size !== folderIds.length) {
      sendResponse({ success: false, error: "收藏夹列表包含重复项目" });
      return;
    }

    const previousProgress = await getStorageValue<AllFavoriteFoldersSyncProgress | null>(
      ALL_FAVORITE_FOLDERS_SYNC_PROGRESS,
      null,
    );
    const checkpoint = normalizeAllFoldersCheckpoint(previousProgress, folderIds, mode);
    if (
      checkpoint?.status === "paused" &&
      checkpoint.retryAfter &&
      Date.now() < checkpoint.retryAfter
    ) {
      sendResponse({
        success: false,
        status: "paused",
        error: checkpoint.message || "全部收藏夹同步正在冷却，请稍后继续",
        currentFolderIndex: checkpoint.currentFolderIndex,
        currentFolderId: checkpoint.currentFolderId,
        nextPage: checkpoint.nextPage,
        retryAfter: checkpoint.retryAfter,
      });
      return;
    }

    const startedAt = checkpoint?.startedAt ?? Date.now();

    const task = startFavoriteSync(async () => {
      let currentFolderIndex = checkpoint?.currentFolderIndex ?? 0;
      let completedCount = currentFolderIndex;
      const failedFolders = [...(checkpoint?.failedFolders ?? [])];
      const rateLimitCount = checkpoint?.rateLimitCount;
      const initialFolder = folders[currentFolderIndex];

      await updateAllFavoriteFoldersSyncProgress({
        status: "syncing",
        mode,
        currentFolderIndex,
        currentFolderId: initialFolder.id,
        currentFolderTitle: initialFolder.title,
        completedCount,
        totalFolders: folders.length,
        failedFolders,
        folderIds,
        currentPage: checkpoint?.currentPage ?? 0,
        nextPage: checkpoint?.nextPage ?? 1,
        processedItems: checkpoint?.processedItems ?? 0,
        totalItems: checkpoint?.totalItems ?? 0,
        onlineResourceIds: checkpoint?.onlineResourceIds ?? [],
        startedAt,
        updatedAt: Date.now(),
        ...(rateLimitCount ? { rateLimitCount } : {}),
      });

      const { sessdata, folders: onlineFolders } = await getFavoriteFoldersFromBilibili();
      const onlineFoldersById = new Map(onlineFolders.map((folder) => [folder.id, folder]));

      for (let index = currentFolderIndex; index < folders.length; index++) {
        const folder = folders[index];
        const resumeFolder =
          checkpoint?.currentFolderIndex === index && checkpoint.currentFolderId === folder.id
            ? checkpoint
            : null;
        let currentPage = resumeFolder?.currentPage ?? 0;
        let nextPage = resumeFolder?.nextPage ?? 1;
        let processedItems = resumeFolder?.processedItems ?? 0;
        let totalItems = resumeFolder?.totalItems ?? 0;
        let onlineResourceIds = resumeFolder?.onlineResourceIds ?? [];
        currentFolderIndex = index;
        completedCount = index;

        await updateAllFavoriteFoldersSyncProgress({
          status: "syncing",
          mode,
          currentFolderIndex,
          currentFolderId: folder.id,
          currentFolderTitle: folder.title,
          completedCount,
          totalFolders: folders.length,
          failedFolders,
          folderIds,
          currentPage,
          nextPage,
          processedItems,
          totalItems,
          onlineResourceIds,
          startedAt,
          updatedAt: Date.now(),
          ...(rateLimitCount ? { rateLimitCount } : {}),
        });

        const onlineFolder = onlineFoldersById.get(folder.id);
        if (!onlineFolder) {
          throw new FavoriteFolderRequestError(`收藏夹「${folder.title}」不存在或无权访问`, "data");
        }

        await saveFavFolders([onlineFolder]);
        await syncFavoriteFolderResources(
          onlineFolder,
          sessdata,
          isFullSync,
          async (update) => {
            currentPage = update.currentPage;
            nextPage = update.nextPage;
            processedItems = update.processedItems;
            totalItems = update.totalItems;
            onlineResourceIds = update.onlineResourceIds;
            await updateAllFavoriteFoldersSyncProgress({
              status: "syncing",
              mode,
              currentFolderIndex,
              currentFolderId: folder.id,
              currentFolderTitle: folder.title,
              completedCount,
              totalFolders: folders.length,
              failedFolders,
              folderIds,
              currentPage,
              nextPage,
              processedItems,
              totalItems,
              onlineResourceIds,
              startedAt,
              updatedAt: Date.now(),
              ...(rateLimitCount ? { rateLimitCount } : {}),
            });
            console.info("[all-favorite-folders-sync] checkpoint", {
              currentFolderIndex,
              currentFolderId: folder.id,
              completedCount,
              currentPage,
              nextPage,
              rateLimitCount: rateLimitCount ?? 0,
            });
          },
          resumeFolder,
          true,
        );

        const currentFailureIndex = failedFolders.findIndex((item) => item.id === folder.id);
        if (currentFailureIndex >= 0) failedFolders.splice(currentFailureIndex, 1);

        completedCount = index + 1;
        currentFolderIndex = completedCount;
        const nextFolder = folders[currentFolderIndex];
        if (nextFolder) {
          await updateAllFavoriteFoldersSyncProgress({
            status: "syncing",
            mode,
            currentFolderIndex,
            currentFolderId: nextFolder.id,
            currentFolderTitle: nextFolder.title,
            completedCount,
            totalFolders: folders.length,
            failedFolders,
            folderIds,
            currentPage: 0,
            nextPage: 1,
            processedItems: 0,
            totalItems: 0,
            onlineResourceIds: [],
            startedAt,
            updatedAt: Date.now(),
            ...(rateLimitCount ? { rateLimitCount } : {}),
          });

          const folderDelay = getRandomDelay(
            FAVORITE_FOLDER_DELAY_MIN_MS,
            FAVORITE_FOLDER_DELAY_MAX_MS,
          );
          await new Promise((resolve) => setTimeout(resolve, folderDelay));
        }
      }

      const messageText = `全部 ${folders.length} 个收藏夹${isFullSync ? "全量" : "增量"}同步成功`;
      await updateAllFavoriteFoldersSyncProgress({
        status: "success",
        mode,
        currentFolderIndex: folders.length,
        currentFolderId: null,
        currentFolderTitle: "",
        completedCount: folders.length,
        totalFolders: folders.length,
        failedFolders: [],
        folderIds,
        currentPage: 0,
        nextPage: 1,
        processedItems: 0,
        totalItems: 0,
        onlineResourceIds: [],
        startedAt,
        updatedAt: Date.now(),
        message: messageText,
      });
    });
    if (!task) {
      sendResponse({ success: false, error: "收藏夹同步正在进行中，请稍后再试" });
      return;
    }
    allFavoriteFoldersSyncPromise = task;

    try {
      await task;
      sendResponse({
        success: true,
        message: `全部 ${folders.length} 个收藏夹${isFullSync ? "全量" : "增量"}同步成功`,
        mode,
      });
    } catch (error) {
      console.error("同步所有收藏夹失败:", error);
      const requestError = normalizeFavoriteFolderRequestError(error);
      const progress = await getStorageValue<AllFavoriteFoldersSyncProgress | null>(
        ALL_FAVORITE_FOLDERS_SYNC_PROGRESS,
        null,
      );
      const latestCheckpoint = normalizeAllFoldersCheckpoint(progress, folderIds, mode);
      const currentFolderIndex = Math.min(
        latestCheckpoint?.currentFolderIndex ?? checkpoint?.currentFolderIndex ?? 0,
        folders.length - 1,
      );
      const currentFolder = folders[currentFolderIndex];
      const failureProgress: AllFavoriteFoldersSyncProgress = latestCheckpoint ?? {
        status: "error",
        mode,
        currentFolderIndex,
        currentFolderId: currentFolder.id,
        currentFolderTitle: currentFolder.title,
        completedCount: currentFolderIndex,
        totalFolders: folders.length,
        failedFolders: [],
        folderIds,
        currentPage: Math.max(0, (checkpoint?.nextPage ?? 1) - 1),
        nextPage: checkpoint?.nextPage ?? 1,
        processedItems: checkpoint?.processedItems ?? 0,
        totalItems: checkpoint?.totalItems ?? 0,
        onlineResourceIds: checkpoint?.onlineResourceIds ?? [],
        startedAt,
        updatedAt: Date.now(),
        ...(checkpoint?.rateLimitCount ? { rateLimitCount: checkpoint.rateLimitCount } : {}),
      };

      let response: SyncAllFavoriteFoldersResponse;
      if (requestError.kind === "rate_limited") {
        const rateLimitCount = (failureProgress.rateLimitCount ?? 0) + 1;
        const cooldownIndex = Math.min(
          rateLimitCount - 1,
          FAVORITE_FOLDER_RATE_LIMIT_COOLDOWNS_MS.length - 1,
        );
        const retryAfter = Date.now() + FAVORITE_FOLDER_RATE_LIMIT_COOLDOWNS_MS[cooldownIndex];
        const errorMessage = "触发 B 站访问风控，全部收藏夹同步已暂停";
        await updateAllFavoriteFoldersSyncProgress({
          ...failureProgress,
          status: "paused",
          errorKind: "rate_limited",
          rateLimitCount,
          retryAfter,
          updatedAt: Date.now(),
          message: errorMessage,
        });
        response = {
          success: false,
          status: "paused",
          error: errorMessage,
          currentFolderIndex: failureProgress.currentFolderIndex,
          currentFolderId: failureProgress.currentFolderId,
          nextPage: failureProgress.nextPage,
          retryAfter,
        };
      } else {
        const errorMessage = requestError.message;
        const failedFolders = [...failureProgress.failedFolders];
        const failedFolderId = failureProgress.currentFolderId;
        if (failedFolderId !== null) {
          const failure = {
            id: failedFolderId,
            title: failureProgress.currentFolderTitle,
            error: errorMessage,
          };
          const existingFailureIndex = failedFolders.findIndex(
            (folder) => folder.id === failedFolderId,
          );
          if (existingFailureIndex >= 0) failedFolders[existingFailureIndex] = failure;
          else failedFolders.push(failure);
        }
        await updateAllFavoriteFoldersSyncProgress({
          ...failureProgress,
          status: "error",
          failedFolders,
          errorKind: requestError.kind,
          updatedAt: Date.now(),
          message: errorMessage,
        });
        response = {
          success: false,
          status: "error",
          error: errorMessage,
          currentFolderIndex: failureProgress.currentFolderIndex,
          currentFolderId: failureProgress.currentFolderId,
          nextPage: failureProgress.nextPage,
        };
      }
      sendResponse(response);
    } finally {
      allFavoriteFoldersSyncPromise = null;
      finishFavoriteSync(task);
    }
  };

  const handleGetFavoriteFolderSyncProgress = async (sendResponse: (response: unknown) => void) => {
    const progress = await getStorageValue<FavoriteFolderSyncProgress | null>(
      FAVORITE_FOLDER_SYNC_PROGRESS,
      null,
    );

    if (progress?.status === "syncing" && !favoriteFolderSyncPromise) {
      const interruptedProgress: FavoriteFolderSyncProgress = {
        ...progress,
        status: "interrupted",
        updatedAt: Date.now(),
        message: `同步任务已中断，可从第 ${progress.nextPage} 页继续`,
      };
      await updateFavoriteFolderSyncProgress(interruptedProgress);
      sendResponse(interruptedProgress);
      return;
    }

    sendResponse(progress);
  };

  const handleGetAllFavoriteFoldersSyncProgress = async (
    sendResponse: (response: unknown) => void,
  ) => {
    const storedProgress = await getStorageValue<AllFavoriteFoldersSyncProgress | null>(
      ALL_FAVORITE_FOLDERS_SYNC_PROGRESS,
      null,
    );
    const progress =
      storedProgress &&
      storedProgress.status !== "success" &&
      Array.isArray(storedProgress.folderIds)
        ? (normalizeAllFoldersCheckpoint(
            storedProgress,
            storedProgress.folderIds,
            storedProgress.mode,
          ) ?? storedProgress)
        : storedProgress;

    if (progress?.status === "syncing" && !allFavoriteFoldersSyncPromise) {
      const interruptedProgress: AllFavoriteFoldersSyncProgress = {
        ...progress,
        status: "interrupted",
        updatedAt: Date.now(),
        message: `同步任务已中断，可从「${progress.currentFolderTitle}」第 ${progress.nextPage} 页继续`,
      };
      await updateAllFavoriteFoldersSyncProgress(interruptedProgress);
      sendResponse(interruptedProgress);
      return;
    }

    sendResponse(progress);
  };

  const handleRefreshFavoriteFolders = async (
    sendResponse: (response: RefreshFavoriteFoldersResponse) => void,
  ) => {
    try {
      if (favoriteSyncPromise) {
        sendResponse({ success: false, error: "收藏夹同步正在进行中，已跳过目录刷新" });
        return;
      }

      const [singleProgress, allProgress] = await Promise.all([
        getStorageValue<FavoriteFolderSyncProgress | null>(FAVORITE_FOLDER_SYNC_PROGRESS, null),
        getStorageValue<AllFavoriteFoldersSyncProgress | null>(
          ALL_FAVORITE_FOLDERS_SYNC_PROGRESS,
          null,
        ),
      ]);
      const now = Date.now();
      const isCoolingDown = [singleProgress, allProgress].some(
        (progress) =>
          progress?.status === "paused" &&
          Boolean(progress.retryAfter && progress.retryAfter > now),
      );
      if (isCoolingDown) {
        sendResponse({ success: false, error: "收藏夹同步正在冷却，已跳过目录刷新" });
        return;
      }

      const { folders } = await getFavoriteFoldersFromBilibili();
      await replaceFavFolders(folders);
      sendResponse({ success: true, folderCount: folders.length });
    } catch (error) {
      console.error("刷新收藏夹目录失败:", error);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "未知错误",
      });
    }
  };

  const handleSyncSubscribedCollections = async (sendResponse: (response: any) => void) => {
    try {
      await syncSubscribedCollections();
      sendResponse({ success: true, message: "订阅合集同步成功" });
    } catch (error) {
      console.error("同步订阅合集失败:", error);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "未知错误",
      });
    }
  };

  const handleSyncSubscribedCollectionResources = async (
    message: any,
    sendResponse: (response: any) => void,
  ) => {
    const collectionId = Number(message.collectionId);

    if (!Number.isFinite(collectionId)) {
      sendResponse({ success: false, error: "合集信息不完整" });
      return;
    }

    try {
      await syncSubscribedCollectionResources(collectionId);
      sendResponse({ success: true, message: "合集内容同步成功" });
    } catch (error) {
      console.error("同步合集内容失败:", error);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "未知错误",
      });
    }
  };

  // 处理删除历史记录的消息
  const handleDeleteHistoryItem = async (message: any, sendResponse: (response: any) => void) => {
    const id = Number(message?.id);
    const business = message?.business as HistoryItem["business"] | undefined;
    const validBusinesses: HistoryItem["business"][] = [
      "archive",
      "pgc",
      "article",
      "article-list",
      "live",
      "cheese",
    ];
    if (!Number.isSafeInteger(id) || id <= 0 || !business || !validBusinesses.includes(business)) {
      sendResponse({ success: false, error: "历史记录信息不完整" });
      return;
    }
    try {
      const syncDeleteFromBilibili = await getStorageValue(IS_SYNC_DELETE_FROM_BILIBILI, false);
      if (!syncDeleteFromBilibili) {
        sendResponse({ success: true, message: "同步删除未开启" });
        return;
      }
      await deleteHistoryContent(business, id, "bilibili-page");
      sendResponse({ success: true, message: "历史记录删除成功" });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "删除失败",
      });
    }
  };

  const handleRunLocalHistoryBackup = async (
    message: LocalHistoryBackupRequest,
    sendResponse: (response: LocalHistoryBackupResult) => void,
  ) => {
    try {
      sendResponse(await runLocalHistoryBackupOnce(Boolean(message.allowEmpty)));
    } catch (error) {
      sendResponse({
        success: false,
        errorCode: "WRITE_FAILED",
        error: error instanceof Error ? error.message : "本地备份失败",
      });
    }
  };

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "syncHistory") {
      handleSyncHistory(message as SyncHistoryRequest, sendResponse);
      return true; // 保持消息通道开放
    } else if (message.action === "getCookies") {
      browser.cookies.getAll({ domain: "bilibili.com" }, (cookies) => {
        sendResponse({ success: true, cookies });
      });
      return true;
    } else if (message.action === "deleteHistoryItem") {
      handleDeleteHistoryItem(message, sendResponse);
      return true; // 保持消息通道开放
    } else if (message.action === "syncFavorites") {
      handleSyncFavorites(sendResponse);
      return true;
    } else if (message.action === "syncFavoriteFolder") {
      handleSyncFavoriteFolder(message as SyncFavoriteFolderRequest, sendResponse);
      return true;
    } else if (message.action === "syncAllFavoriteFolders") {
      handleSyncAllFavoriteFolders(message as SyncAllFavoriteFoldersRequest, sendResponse);
      return true;
    } else if (message.action === "getFavoriteFolderSyncProgress") {
      handleGetFavoriteFolderSyncProgress(sendResponse);
      return true;
    } else if (message.action === "getAllFavoriteFoldersSyncProgress") {
      handleGetAllFavoriteFoldersSyncProgress(sendResponse);
      return true;
    } else if (message.action === "refreshFavoriteFolders") {
      handleRefreshFavoriteFolders(sendResponse);
      return true;
    } else if (message.action === "syncSubscribedCollections") {
      handleSyncSubscribedCollections(sendResponse);
      return true;
    } else if (message.action === "syncSubscribedCollectionResources") {
      handleSyncSubscribedCollectionResources(message, sendResponse);
      return true;
    } else if (message.action === "runLocalHistoryBackup") {
      handleRunLocalHistoryBackup(message as LocalHistoryBackupRequest, sendResponse);
      return true;
    } else if (message.action === "syncFollowing") {
      handleSyncFollowing(sendResponse);
      return true;
    } else if (message.action === "archiveFollowingAvatars") {
      handleAvatarArchive(sendResponse);
      return true;
    } else if (message.action === "archiveFavCovers") {
      handleCoverArchive(sendResponse);
      return true;
    } else if (message.action === "archiveCollectionCovers") {
      handleCollectionCoverArchive(sendResponse);
      return true;
    } else if (message.action === "syncInteractions") {
      handleSyncInteractions(sendResponse);
      return true;
    } else if (message.action === "archiveInteractionCovers") {
      handleInteractionCoverArchive(sendResponse);
      return true;
    } else if (message.action === "recoverInvalidFavorites") {
      handleFavRecovery(sendResponse);
      return true;
    }
  });

  // 全量同步历史记录
  async function syncHistory(isFullSync = false): Promise<boolean> {
    try {
      // 获取 B 站 cookie
      const cookies = await browser.cookies.getAll({
        domain: "bilibili.com",
      });
      const SESSDATA = cookies.find((cookie) => cookie.name === "SESSDATA")?.value;

      if (!SESSDATA) {
        throw new Error("未找到 B 站登录信息，请先登录 B 站");
      }

      let hasMore = true;
      let max = 0;
      let view_at = 0;
      const type = "all";
      const ps = 30;
      // 增量同步的兜底翻页上限，防止"首尾记录均不存在于本地"时无限翻页。
      // 超出后按服务端 is_end 或空列表正常收尾，不影响正确性，只是多拉几页。
      const MAX_INCREMENTAL_PAGES = 500;
      let incrementalPages = 0;
      const previousWatermark = await getStorageValue<number>(HISTORY_SYNC_WATERMARK_VIEW_AT, 0);
      let newestObservedViewAt = previousWatermark;
      console.log(`${isFullSync ? "全量" : "增量"}同步开始`);

      // 循环获取所有历史记录
      while (hasMore) {
        // 获取历史记录
        const response = await fetch(
          `https://api.bilibili.com/x/web-interface/history/cursor?max=${max}&view_at=${view_at}&type=${type}&ps=${ps}`,
          {
            headers: {
              Cookie: `SESSDATA=${SESSDATA}`,
            },
          },
        );

        if (!response.ok) {
          throw new Error("获取历史记录失败");
        }

        const { data, code, message } = await response.json();

        if (code !== 0) {
          throw new Error(message || "获取历史记录失败");
        }

        const { cursor, list } = data;
        // 更新分页参数
        // 服务端返回 is_end 或空列表才代表真正翻完。仅依赖 list.length 会在
        // 最后一页 cursor 归零后重新从头返回数据，造成死循环。
        hasMore = list.length > 0 && !cursor.is_end;
        max = cursor.max;
        view_at = cursor.view_at;
        incrementalPages++;

        if (list.length > 0) {
          const snapshots: HistoryItem[] = list.map((item: any) => ({
            id: item.history.oid,
            business: item.history.business,
            bvid: item.history.bvid,
            cid: item.history.cid,
            title: item.title,
            tag_name: item.tag_name,
            cover: item.cover || (item.covers && item.covers[0]),
            view_at: item.view_at,
            uri: item.uri,
            author_name: item.author_name || "",
            author_mid: Number(item.author_mid) || 0,
            progress: item.progress,
            duration: item.duration,
            is_fav: item.is_fav === 1, // 保存是否收藏字段
            uploaded: false,
          }));

          await upsertHistorySnapshots(snapshots, "bilibili");
          const pageViewTimes = snapshots
            .map((item) => Number(item.view_at))
            .filter((value) => Number.isSafeInteger(value) && value > 0);
          if (pageViewTimes.length > 0) {
            newestObservedViewAt = Math.max(newestObservedViewAt, ...pageViewTimes);
          }

          if (!isFullSync && previousWatermark > 0 && pageViewTimes.length > 0) {
            const oldestOnPage = Math.min(...pageViewTimes);
            if (oldestOnPage < previousWatermark) hasMore = false;
          }

          if (!isFullSync && hasMore && incrementalPages >= MAX_INCREMENTAL_PAGES) {
            throw new Error(
              `增量同步已达到 ${MAX_INCREMENTAL_PAGES} 页保护上限，本轮未推进同步水位`,
            );
          }

          // 添加延时，避免请求过于频繁
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
      console.log(`${isFullSync ? "全量" : "增量"}同步结束`);

      if (isFullSync) {
        await setStorageValue(HAS_FULL_SYNC, true);
      }

      if (newestObservedViewAt > 0) {
        await setStorageValue(HISTORY_SYNC_WATERMARK_VIEW_AT, newestObservedViewAt);
      }

      // 更新最后同步时间
      await setStorageValue(HISTORY_LAST_SYNC, Date.now());

      return true;
    } catch (error) {
      console.error("同步历史记录失败:", error);
      throw error;
    }
  }

  interface FavoriteFolderPage {
    medias: any[];
    hasMore: boolean;
  }

  async function getFavoriteFoldersFromBilibili(): Promise<{
    sessdata: string;
    folders: FavoriteFolder[];
  }> {
    const sessdata = await getBilibiliSession();

    const navRes = await fetch("https://api.bilibili.com/x/web-interface/nav", {
      headers: { Cookie: `SESSDATA=${sessdata}` },
    });
    if (navRes.status === 412 || navRes.status === 429) {
      throw new FavoriteFolderRequestError(
        `获取用户信息失败：HTTP ${navRes.status}`,
        "rate_limited",
        navRes.status,
      );
    }
    if (navRes.status === 401 || navRes.status === 403) {
      throw new FavoriteFolderRequestError("登录状态无效，请重新登录 B 站", "auth", navRes.status);
    }
    if (!navRes.ok) {
      throw new FavoriteFolderRequestError(
        `获取用户信息失败：HTTP ${navRes.status}`,
        navRes.status >= 500 ? "server" : "unknown",
        navRes.status,
      );
    }

    const navData = await navRes.json();
    if (navData.code === -412) {
      throw new FavoriteFolderRequestError(
        navData.message || "获取用户信息触发访问风控",
        "rate_limited",
        412,
      );
    }
    if (navData.code !== 0) {
      throw new FavoriteFolderRequestError(navData.message || "获取用户信息失败", "unknown");
    }

    const mid = Number(navData.data?.mid);
    if (!Number.isSafeInteger(mid) || mid <= 0) throw new Error("获取用户信息失败");

    const folderRes = await fetch(
      `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`,
      { headers: { Cookie: `SESSDATA=${sessdata}` } },
    );
    if (folderRes.status === 412 || folderRes.status === 429) {
      throw new FavoriteFolderRequestError(
        `获取收藏夹失败：HTTP ${folderRes.status}`,
        "rate_limited",
        folderRes.status,
      );
    }
    if (folderRes.status === 401 || folderRes.status === 403) {
      throw new FavoriteFolderRequestError(
        "登录状态无效，请重新登录 B 站",
        "auth",
        folderRes.status,
      );
    }
    if (!folderRes.ok) {
      throw new FavoriteFolderRequestError(
        `获取收藏夹失败：HTTP ${folderRes.status}`,
        folderRes.status >= 500 ? "server" : "unknown",
        folderRes.status,
      );
    }

    const folderData = await folderRes.json();
    if (folderData.code === -412) {
      throw new FavoriteFolderRequestError(
        folderData.message || "获取收藏夹触发访问风控",
        "rate_limited",
        412,
      );
    }
    if (folderData.code !== 0) {
      throw new FavoriteFolderRequestError(folderData.message || "获取收藏夹失败", "unknown");
    }

    if (!folderData.data || !("list" in folderData.data)) {
      throw new Error("收藏夹数据格式异常");
    }

    const onlineFolders = folderData.data.list;
    if (onlineFolders !== null && !Array.isArray(onlineFolders)) {
      throw new Error("收藏夹数据格式异常");
    }

    const folders = (onlineFolders || []).map(
      (folder: FavoriteFolder, index: number): FavoriteFolder => ({
        ...folder,
        id: Number(folder.id),
        index,
      }),
    );

    return { sessdata, folders };
  }

  async function fetchFavoriteFolderPage(
    folder: FavoriteFolder,
    page: number,
    sessdata: string,
  ): Promise<FavoriteFolderPage> {
    let lastError = new FavoriteFolderRequestError("未知错误", "unknown");

    for (let attempt = 1; attempt <= 3; attempt++) {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      try {
        const response = await fetch(
          `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${folder.id}&pn=${page}&ps=20`,
          {
            headers: { Cookie: `SESSDATA=${sessdata}` },
            signal: controller.signal,
          },
        );

        if (response.status === 412 || response.status === 429) {
          throw new FavoriteFolderRequestError(
            `HTTP ${response.status}`,
            "rate_limited",
            response.status,
          );
        }
        if (response.status === 401 || response.status === 403) {
          throw new FavoriteFolderRequestError(
            `登录状态无效（HTTP ${response.status}）`,
            "auth",
            response.status,
          );
        }
        if (!response.ok) {
          throw new FavoriteFolderRequestError(
            `HTTP ${response.status}`,
            response.status >= 500 ? "server" : "unknown",
            response.status,
          );
        }

        const data = await response.json();
        if (data.code === -412) {
          throw new FavoriteFolderRequestError(
            data.message || "B 站接口触发访问风控",
            "rate_limited",
            412,
          );
        }
        if (data.code !== 0) {
          throw new FavoriteFolderRequestError(data.message || "B 站接口返回失败", "unknown");
        }
        if (!data.data || (data.data.medias != null && !Array.isArray(data.data.medias))) {
          throw new FavoriteFolderRequestError("收藏夹资源数据格式异常", "data");
        }

        return {
          medias: data.data.medias || [],
          hasMore: Boolean(data.data.has_more),
        };
      } catch (error) {
        lastError = normalizeFavoriteFolderRequestError(error);
        const canRetry = lastError.kind === "network" || lastError.kind === "server";
        if (!canRetry || attempt >= 3) {
          throw new FavoriteFolderRequestError(
            `获取收藏夹「${folder.title}」第 ${page} 页失败：${lastError.message}`,
            lastError.kind,
            lastError.status,
          );
        }

        const retryDelay = (attempt === 1 ? 2000 : 5000) + getRandomDelay(0, 500);
        console.warn(
          `请求收藏夹 ${folder.title} 第 ${page} 页失败，${retryDelay}ms 后重试 (${attempt}/3)`,
        );
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw new FavoriteFolderRequestError(
      `获取收藏夹「${folder.title}」第 ${page} 页失败：${lastError.message}`,
      lastError.kind,
      lastError.status,
    );
  }

  async function syncFavoriteFolderResources(
    folder: FavoriteFolder,
    sessdata: string,
    isFullSync: boolean,
    reportProgress?: (update: {
      currentPage: number;
      nextPage: number;
      processedItems: number;
      totalItems: number;
      onlineResourceIds: number[];
    }) => Promise<void>,
    checkpoint?: Pick<
      FavoriteFolderSyncProgress | AllFavoriteFoldersSyncProgress,
      "nextPage" | "processedItems" | "onlineResourceIds"
    > | null,
    useConservativePageDelay = false,
  ): Promise<void> {
    console.log(`正在同步收藏夹: ${folder.title} (${isFullSync ? "全量" : "增量"})`);

    const localResources = await getFavResources(folder.id);
    const existingResourceIds = new Set(localResources.map((item) => item.id));
    const onlineResourceIds = new Set<number>(checkpoint?.onlineResourceIds ?? []);

    let page = Math.max(1, checkpoint?.nextPage ?? 1);
    let allPagesFetched = false;
    let processedItems = checkpoint?.processedItems ?? 0;

    await reportProgress?.({
      currentPage: Math.max(0, page - 1),
      nextPage: page,
      processedItems,
      totalItems: folder.media_count,
      onlineResourceIds: [...onlineResourceIds],
    });

    while (true) {
      const { medias, hasMore } = await fetchFavoriteFolderPage(folder, page, sessdata);

      if (medias.length === 0) {
        if (hasMore) throw new Error(`收藏夹「${folder.title}」分页数据异常`);
        allPagesFetched = true;
        await reportProgress?.({
          currentPage: page,
          nextPage: page + 1,
          processedItems,
          totalItems: folder.media_count,
          onlineResourceIds: [...onlineResourceIds],
        });
        break;
      }

      const resourceIds = medias.map((media: any) => Number(media.id));
      if (resourceIds.some((id: number) => !Number.isSafeInteger(id) || id <= 0)) {
        throw new Error(`收藏夹「${folder.title}」资源数据格式异常`);
      }

      resourceIds.forEach((id: number) => onlineResourceIds.add(id));

      const reachedLocalBoundary =
        !isFullSync &&
        existingResourceIds.has(resourceIds[0]) &&
        existingResourceIds.has(resourceIds[resourceIds.length - 1]);

      const resources = medias.map((media: any, index: number) => ({
        ...media,
        folder_id: folder.id,
        index: (page - 1) * 20 + index,
        id: resourceIds[index],
        bv_id: media.bv_id || media.bvid,
      }));
      await saveFavResources(resources);
      processedItems += resources.length;
      await reportProgress?.({
        currentPage: page,
        nextPage: page + 1,
        processedItems,
        totalItems: folder.media_count,
        onlineResourceIds: [...onlineResourceIds],
      });

      if (!hasMore) {
        allPagesFetched = true;
        break;
      }
      if (reachedLocalBoundary) break;

      page += 1;
      const pageDelay = useConservativePageDelay
        ? getRandomDelay(FAVORITE_FOLDER_PAGE_DELAY_MIN_MS, FAVORITE_FOLDER_PAGE_DELAY_MAX_MS)
        : 500;
      await new Promise((resolve) => setTimeout(resolve, pageDelay));
    }

    if (isFullSync) {
      if (!allPagesFetched) {
        throw new Error(`收藏夹「${folder.title}」未完整同步，已跳过本地清理`);
      }

      // 在线消失的条目**先转入消失档案再移除**，绝不直接删除。
      //
      // 原实现在这里直接 deleteFavResources，但它无法区分两种完全不同的原因：
      // 你主动取消收藏（删掉合理）与内容被 UP 主删除/下架（删掉等于销毁证据）。
      // B 站接口不返回消失原因，所以只能保守留档。代价是"取消收藏"的记录也会进档案，
      // 这是已确认接受的取舍 —— 宁可多留，也不能把被删内容的记录抹掉。
      const candidates = buildVanishCandidates({
        localResources,
        onlineResourceIds,
        isFullSync,
        allPagesFetched,
      });

      if (candidates.length > 0) {
        const probed = await archiveVanishedResources(candidates, sessdata);

        // **你手动取消的收藏不进档案**（用户明确要求）：探测到稿件仍可访问
        // （`unfavorited`）说明内容好端端在 B 站，只是你不想留着它了——
        // 这种记录归档只是噪音，与"内容消失"是完全不同的两件事。
        // 它们照常从本地移除（那是用户的意愿），只是不写进档案。
        const archived = probed.filter((item) => item.vanishReason !== "unfavorited");
        const unarchived = probed.filter((item) => item.vanishReason === "unfavorited");

        if (unarchived.length > 0) {
          // 取消收藏的：从收藏夹移除即可，不写档案、不发通知
          await deleteFavResources(
            folder.id,
            unarchived.map((item) => item.id),
          );
          console.log(`收藏夹「${folder.title}」：${unarchived.length} 项是你取消的收藏，已移除但不归档`);
        }

        if (archived.length > 0) {
          // 内容真的消失了：同一事务内"写档案 + 移出收藏夹"，绝不直接删
          await moveFavResourcesToVanished(folder.id, archived);
          console.log(
            `收藏夹「${folder.title}」：${archived.length} 项在线消失，已转入消失档案（未删除）`,
          );

          // 内容真的丢了就告知用户，而不是等他某天自己打开插件发现
          const notification = buildVanishedNotification(archived);
          if (notification) await sendChangeNotification(notification);
        }
      }
    }

    // 本次同步可能带来新的收藏条目，复位封面归档状态让归档任务重新启动
    await resetCoverArchiveIfCompleted();
    await resetCollectionCoverArchiveIfCompleted();
  }

  /**
   * 对"在线消失"的条目做二次探测并组装消失档案。
   *
   * 探测**从不抛错**：任何失败都归类为"原因不明"，但条目**依然留档**。
   * 探测失败绝不能等价于"可以安全删除"。
   */
  async function archiveVanishedResources(
    candidates: FavoriteResource[],
    sessdata: string,
  ): Promise<VanishedFavResource[]> {
    const now = Date.now();
    const records: VanishedFavResource[] = [];
    const reasonCounts: Record<string, number> = {};

    for (const resource of candidates) {
      const probe = await probeFavoriteResource(resource, sessdata);
      const reason = classifyViewProbe(probe);
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;

      records.push(
        buildVanishedRecord(resource, reason, now, probe.ok ? undefined : probe.message ?? undefined),
      );

      await new Promise((resolve) => setTimeout(resolve, VANISH_PROBE_DELAY_MS));
    }

    console.log("消失档案分类结果:", reasonCounts);
    return records;
  }

  async function syncFavoriteFolderById(
    folderId: number,
    isFullSync: boolean,
    startedAt: number,
    checkpoint: FavoriteFolderSyncProgress | null,
  ): Promise<FavoriteFolder> {
    const { sessdata, folders } = await getFavoriteFoldersFromBilibili();
    const folder = folders.find((item) => item.id === folderId);
    if (!folder) throw new Error("收藏夹不存在或无权访问");

    await saveFavFolders([folder]);
    await updateFavoriteFolderSyncProgress({
      folderId,
      folderTitle: folder.title,
      mode: isFullSync ? "full" : "incremental",
      status: "syncing",
      currentPage: 0,
      nextPage: checkpoint?.nextPage ?? 1,
      processedItems: checkpoint?.processedItems ?? 0,
      totalItems: folder.media_count,
      onlineResourceIds: checkpoint?.onlineResourceIds ?? [],
      startedAt,
      updatedAt: Date.now(),
      ...(checkpoint?.rateLimitCount ? { rateLimitCount: checkpoint.rateLimitCount } : {}),
    });
    await syncFavoriteFolderResources(
      folder,
      sessdata,
      isFullSync,
      async (update) => {
        await updateFavoriteFolderSyncProgress({
          folderId,
          folderTitle: folder.title,
          mode: isFullSync ? "full" : "incremental",
          status: "syncing",
          ...update,
          startedAt,
          updatedAt: Date.now(),
          ...(checkpoint?.rateLimitCount ? { rateLimitCount: checkpoint.rateLimitCount } : {}),
        });
      },
      checkpoint,
      true,
    );
    return folder;
  }

  // ---------------------------------------------------------------------------
  // 关注列表同步
  //
  // 判定与编排逻辑全在 utils/followingSync.ts（纯函数、有单测）。这里只负责把真实的
  // API / IndexedDB / storage 依赖接上去，所以这一段应当尽量薄。
  // ---------------------------------------------------------------------------
  let followingSyncPromise: Promise<FollowingSyncOutcome> | null = null;

  const startFollowingSync = (): Promise<FollowingSyncOutcome> | null => {
    if (followingSyncPromise) return null;

    const task = (async (): Promise<FollowingSyncOutcome> => {
      const startedAt = Date.now();
      try {
        const sessdata = await getBilibiliSessdata();
        const vmid = await getCurrentBilibiliMid(sessdata);

        const outcome = await runFollowingSync(
          {
            fetchPage: async (page) => {
              const result = await fetchFollowingPage(vmid, page, sessdata, FOLLOWING_PAGE_SIZE);
              // 后台任务用户看不见，逐页打日志是唯一能确认它在动的途径
              console.log(
                `关注列表第 ${page} 页：${result.list.length} 条（接口报告共 ${result.total} 条）`,
              );
              return result;
            },
            loadExisting: () => getAllFollowing(),
            persist: (next, events) => applyFollowingSync(next, events),
            hasBaseline: () => getStorageValue(HAS_FULL_FOLLOWING_SYNC, false),
            markBaseline: async () => {
              await setStorageValue(HAS_FULL_FOLLOWING_SYNC, true);
            },
            saveProgress: async (progress) => {
              await setStorageValue(FOLLOWING_SYNC_PROGRESS, progress);
            },
            now: () => Date.now(),
            delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          },
          { pageSize: FOLLOWING_PAGE_SIZE, pageDelayMs: DEFAULT_FOLLOWING_PAGE_DELAY_MS },
        );

        // 完整与否都记录时间：否则超出页数上限的账号会被每分钟反复重试
        await setStorageValue(FOLLOWING_LAST_SYNC, Date.now());
        // 新增关注可能带来未归档的头像，复位归档状态让归档任务重新启动
        await resetAvatarArchiveIfCompleted();
        // 新收藏的条目也可能还没归档封面
        await resetCoverArchiveIfCompleted();

        // 关注变动主动告知用户——"不知道"才是痛苦的来源
        if (outcome.eventsCreated > 0) {
          try {
            const todayEvents = await getFollowingEventsByDay(formatLocalDay(Date.now()));
            const notification = buildFollowingNotification(todayEvents);
            if (notification) await sendChangeNotification(notification);
          } catch (error) {
            // 通知失败不影响同步
            console.error("构建关注变动通知失败:", error);
          }
        }

        // 把已注销的关注账号转进统一消失档案。
        //
        // 关注记录**从不删除**（`status: "gone"` 是终态），所以这里同样是"汇入档案"
        // 而不是"先留档再移除"。档案条目带的是注销那一刻的快照，改名链路
        // （`nameHistory`）留在源记录里，档案页会一并展示——这正是用户要的
        // "关注列表要保存用户的改名和注销等记录"。
        try {
          const followingList = await getAllFollowing();
          // 只收"留下过有效信息"的账号：连名字都没观测到的注销账号在关注列表里
          // 本来就能查到，档案再收一份不增加信息，只会把档案页刷成一片白卡
          const gone = followingList.filter((item) => item.status === "gone" && isWorthArchiving(item));
          if (gone.length > 0) {
            const now = Date.now();
            await putVanishArchive(
              gone.map((item) => buildFollowingArchiveItem(item, "unknown", now)),
            );
            console.log(`关注列表：${gone.length} 个账号已注销，已汇入消失档案`);
          }
        } catch (error) {
          console.warn("汇入关注消失档案失败:", error);
        }

        console.log("关注同步结束:", outcome);
        return outcome;
      } catch (error) {
        // 走到这里说明失败发生在 getBilibiliSessdata / getCurrentBilibiliMid 阶段，
        // runFollowingSync 内部的抓取错误它自己已经兜住了。
        const kind = error instanceof FollowingRequestError ? error.kind : "unknown";
        const status: FollowingSyncOutcome["status"] =
          kind === "auth" ? "auth_invalid" : kind === "rate_limited" ? "rate_limited" : "failed";
        const message = error instanceof Error ? error.message : String(error);
        console.error("关注同步失败:", message);

        const progress: FollowingSyncProgress = {
          status,
          pagesFetched: 0,
          fetchedCount: 0,
          total: null,
          fullScanCompleted: false,
          lastErrorKind: kind,
          lastError: message,
          startedAt,
          completedAt: Date.now(),
          eventsCreated: 0,
        };
        await setStorageValue(FOLLOWING_SYNC_PROGRESS, progress).catch(() => undefined);

        return {
          status,
          pagesFetched: 0,
          fetchedCount: 0,
          total: null,
          fullScanCompleted: false,
          eventsCreated: 0,
          baselineEstablished: false,
          error: message,
        };
      }
    })();

    followingSyncPromise = task;
    const clear = () => {
      if (followingSyncPromise === task) followingSyncPromise = null;
    };
    task.then(clear, clear);
    return task;
  };

  const handleSyncFollowing = async (sendResponse: (response: any) => void) => {
    const task = startFollowingSync();
    if (!task) {
      sendResponse({ success: false, error: "关注同步正在进行中，请稍后再试" });
      return;
    }

    try {
      const outcome = await task;
      const ok = outcome.status === "completed" || outcome.status === "incomplete";
      sendResponse({
        success: ok,
        status: outcome.status,
        fetchedCount: outcome.fetchedCount,
        total: outcome.total,
        eventsCreated: outcome.eventsCreated,
        fullScanCompleted: outcome.fullScanCompleted,
        message: ok
          ? `关注同步完成：抓取 ${outcome.fetchedCount} 条，产生 ${outcome.eventsCreated} 条变动`
          : undefined,
        error: outcome.error,
      });
    } catch (error) {
      console.error("同步关注列表失败:", error);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "未知错误",
      });
    }
  };

  // ---------------------------------------------------------------------------
  // 关注头像的字节归档
  //
  // 动机（Phase 1b 实测）：账号注销后 B 站会把头像换成 noface.jpg，真实头像立即丢失。
  // 所以必须在图片还正常时抓下来。任务是**持续**的、且越早跑越好。
  //
  // 可续跑性来自筛选条件：已归档的记录 avatarAssetId 非空，下一轮自然跳过，
  // 因此不需要游标，Service Worker 中途被杀也不丢进度。
  // ---------------------------------------------------------------------------
  let avatarArchivePromise: Promise<AvatarArchiveProgress> | null = null;

  const readAvatarArchiveProgress = async (): Promise<AvatarArchiveProgress | null> =>
    await getStorageValue<AvatarArchiveProgress | null>(FOLLOWING_AVATAR_ARCHIVE_PROGRESS, null);

  const startAvatarArchive = (): Promise<AvatarArchiveProgress> | null => {
    if (avatarArchivePromise) return null;

    const task = (async (): Promise<AvatarArchiveProgress> => {
      const previous = await readAvatarArchiveProgress();
      // 上一轮没跑完时累计计数；上一轮已完成则重新计数
      const carryOver = previous && previous.status !== "completed" ? previous : null;

      return await runAvatarArchive(
        {
          loadFollowing: () => getAllFollowing(),
          patchFollowing: (mids, patch) => patchFollowingItems(mids, patch),
          saveProgress: async (progress) => {
            await setStorageValue(FOLLOWING_AVATAR_ARCHIVE_PROGRESS, progress);
          },
          now: () => Date.now(),
          delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          archive: (face) => archiveAvatar(face),
        },
        {
          baseArchived: carryOver?.archived ?? 0,
          baseFailed: carryOver?.failed ?? 0,
        },
      );
    })();

    avatarArchivePromise = task;
    const clear = () => {
      if (avatarArchivePromise === task) avatarArchivePromise = null;
    };
    task.then(clear, clear);
    return task;
  };

  /** 关注同步后可能有新账号需要归档，把状态从 completed 复位以重新启动归档 */
  const resetAvatarArchiveIfCompleted = async (): Promise<void> => {
    const progress = await readAvatarArchiveProgress();
    if (progress?.status === "completed") {
      await setStorageValue(FOLLOWING_AVATAR_ARCHIVE_PROGRESS, { ...progress, status: "idle" });
    }
  };

  // ---------------------------------------------------------------------------
  // 收藏封面的字节归档
  //
  // 这是唯一"防患于未然"的方案：其余恢复途径都是事后找回（公开接口 / biliplus /
  // jijidown / 本地交叉引用），只有它是在封面还正常时就把字节存进本地。
  //
  // Phase 1b 实测：失效稿件的封面会被统一替换成同一个占位图，所以**等发现失效再抓，
  // 抓到的只是占位图**。因此必须提前做、持续做。
  //
  // 可续跑性同样来自筛选条件：`coverAssetId` 非空的记录下一轮自动跳过。
  // ---------------------------------------------------------------------------
  let coverArchivePromise: Promise<CoverArchiveProgress> | null = null;

  const readCoverArchiveProgress = async (): Promise<CoverArchiveProgress | null> =>
    await getStorageValue<CoverArchiveProgress | null>(FAV_COVER_ARCHIVE_PROGRESS, null);

  const startCoverArchive = (): Promise<CoverArchiveProgress> | null => {
    if (coverArchivePromise) return null;

    const task = (async (): Promise<CoverArchiveProgress> => {
      const previous = await readCoverArchiveProgress();
      const carryOver = previous && previous.status !== "completed" ? previous : null;

      return await runCoverArchive(
        {
          loadResources: () => getAllFavResources(),
          persist: (updates) => applyFavResourceRecovery(updates),
          saveProgress: async (progress) => {
            await setStorageValue(FAV_COVER_ARCHIVE_PROGRESS, progress);
          },
          now: () => Date.now(),
          delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          archive: (cover) => archiveCover(cover),
        },
        {
          baseArchived: carryOver?.archived ?? 0,
          baseFailed: carryOver?.failed ?? 0,
        },
      );
    })();

    coverArchivePromise = task;
    const clear = () => {
      if (coverArchivePromise === task) coverArchivePromise = null;
    };
    task.then(clear, clear);
    return task;
  };

  /** 收藏同步后可能有新条目需要归档，把状态从 completed 复位以重新启动 */
  const resetCoverArchiveIfCompleted = async (): Promise<void> => {
    const progress = await readCoverArchiveProgress();
    if (progress?.status === "completed") {
      await setStorageValue(FAV_COVER_ARCHIVE_PROGRESS, { ...progress, status: "idle" });
    }
  };

  const handleCoverArchive = async (sendResponse: (response: any) => void) => {
    const task = startCoverArchive();
    if (!task) {
      sendResponse({ success: false, error: "封面归档正在进行中，请稍后再试" });
      return;
    }

    try {
      const result = await task;
      sendResponse({
        success: true,
        archived: result.archived,
        failed: result.failed,
        remaining: result.remaining,
        status: result.status,
        message: `本轮归档 ${result.pending - result.remaining} 张，剩余 ${result.remaining} 张`,
      });
    } catch (error) {
      console.error("封面归档失败:", error);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "封面归档失败",
      });
    }
  };

  // ---------------------------------------------------------------------------
  // 订阅合集内容的封面字节归档
  //
  // 与收藏封面共用同一个归档任务（`runCoverArchive` 已泛型化）与同一个 `assets`
  // 的 `cover` 类型，只是 store 与主键不同。
  // ---------------------------------------------------------------------------
  let collectionCoverArchivePromise: Promise<CoverArchiveProgress> | null = null;

  const readCollectionCoverArchiveProgress = async (): Promise<CoverArchiveProgress | null> =>
    await getStorageValue<CoverArchiveProgress | null>(COLLECTION_COVER_ARCHIVE_PROGRESS, null);

  const startCollectionCoverArchive = (): Promise<CoverArchiveProgress> | null => {
    if (collectionCoverArchivePromise) return null;

    const task = (async (): Promise<CoverArchiveProgress> => {
      const previous = await readCollectionCoverArchiveProgress();
      const carryOver = previous && previous.status !== "completed" ? previous : null;

      return await runCoverArchive(
        {
          loadResources: () => getAllSubscribedCollectionResources(),
          persist: (updates) => applySubscribedCollectionCoverAssets(updates),
          saveProgress: async (progress) => {
            await setStorageValue(COLLECTION_COVER_ARCHIVE_PROGRESS, progress);
          },
          now: () => Date.now(),
          delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          archive: (cover) => archiveCover(cover),
        },
        {
          baseArchived: carryOver?.archived ?? 0,
          baseFailed: carryOver?.failed ?? 0,
        },
      );
    })();

    collectionCoverArchivePromise = task;
    const clear = () => {
      if (collectionCoverArchivePromise === task) collectionCoverArchivePromise = null;
    };
    task.then(clear, clear);
    return task;
  };

  const resetCollectionCoverArchiveIfCompleted = async (): Promise<void> => {
    const progress = await readCollectionCoverArchiveProgress();
    if (progress?.status === "completed") {
      await setStorageValue(COLLECTION_COVER_ARCHIVE_PROGRESS, { ...progress, status: "idle" });
    }
  };

  const handleCollectionCoverArchive = async (sendResponse: (response: any) => void) => {
    const task = startCollectionCoverArchive();
    if (!task) {
      sendResponse({ success: false, error: "合集封面归档正在进行中，请稍后再试" });
      return;
    }

    try {
      const result = await task;
      sendResponse({
        success: true,
        archived: result.archived,
        failed: result.failed,
        remaining: result.remaining,
        status: result.status,
        message: `本轮归档 ${result.pending - result.remaining} 张，剩余 ${result.remaining} 张`,
      });
    } catch (error) {
      console.error("合集封面归档失败:", error);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "合集封面归档失败",
      });
    }
  };

  const handleAvatarArchive = async (sendResponse: (response: any) => void) => {
    const task = startAvatarArchive();
    if (!task) {
      sendResponse({ success: false, error: "头像归档正在进行中，请稍后再试" });
      return;
    }

    try {
      const result = await task;
      sendResponse({
        success: true,
        archived: result.archived,
        failed: result.failed,
        remaining: result.remaining,
        status: result.status,
        message: `本轮归档 ${result.pending - result.remaining} 张，剩余 ${result.remaining} 张`,
      });
    } catch (error) {
      console.error("头像归档失败:", error);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "头像归档失败",
      });
    }
  };

  // ---------------------------------------------------------------------------
  // 点赞 / 投币互动记录同步
  //
  // 判定与编排全在 utils/interactionDiff.ts / utils/interactionSync.ts
  // （纯函数、有单测）。这里只负责把真实的 API / IndexedDB / storage 接上去。
  //
  // 与关注同步最大的不同：B 站只给最近 20 条，条目随时会掉出去，所以
  //   1）默认间隔更短（3 小时），
  //   2）掉出列表的条目要用 view + relation 二次探测才能下结论，
  //   3）探测条数有上限，避免第一轮就把几千个请求打出去。
  // ---------------------------------------------------------------------------
  let interactionSyncPromise: Promise<InteractionSyncOutcome> | null = null;

  interface InteractionSyncRunOptions {
    trigger: InteractionSyncTrigger;
    /** 逛主页时的补充同步传 0：只抓新数据，不做消失判定，避免反复探测 */
    maxProbesPerRun: number;
    /**
     * 手动同步时打开：忽略 24 小时/30 天的时间门，把"未判定"的条目立刻重探一遍。
     * 没有它，用户点「立即同步」也推不动一条卡住的记录，只能干等。
     */
    forceProbeUnlisted?: boolean;
  }

  const startInteractionSync = (
    runOptions: InteractionSyncRunOptions = {
      trigger: "schedule",
      maxProbesPerRun: DEFAULT_MAX_PROBES_PER_RUN,
    },
  ): Promise<InteractionSyncOutcome> | null => {
    if (interactionSyncPromise) return null;

    const task = (async (): Promise<InteractionSyncOutcome> => {
      const startedAt = Date.now();
      try {
        const sessdata = await getBilibiliSessdata();
        const vmid = await getCurrentBilibiliMid(sessdata);

        const outcome = await runInteractionSync(
          {
            fetchPage: async (type, page) => {
              const result = await fetchInteractionPage(
                type,
                vmid,
                page,
                sessdata,
                INTERACTION_PAGE_SIZE,
              );
              // 后台任务用户看不见，逐页打日志是唯一能确认它在动的途径
              console.log(
                `互动列表（${type === "like" ? "点赞" : "投币"}）第 ${page} 页：${result.items.length} 条`,
              );
              return result;
            },
            loadExisting: (type) => getInteractionsByType(type),
            persist: (items) => putInteractionItems(items),
            probe: (item: InteractionItem) => probeInteraction(item.type, item.bvid, sessdata),
            saveProgress: async (progress) => {
              await setStorageValue(INTERACTIONS_SYNC_PROGRESS, progress);
            },
            hasFirstSync: async () =>
              (await getStorageValue<number | null>(INTERACTIONS_FIRST_SYNC_AT, null)) !== null,
            markFirstSync: async () => {
              const existing = await getStorageValue<number | null>(INTERACTIONS_FIRST_SYNC_AT, null);
              if (existing === null) await setStorageValue(INTERACTIONS_FIRST_SYNC_AT, Date.now());
            },
            now: () => Date.now(),
            delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          },
          {
            pageSize: INTERACTION_PAGE_SIZE,
            pageDelayMs: DEFAULT_INTERACTION_PAGE_DELAY_MS,
            probeDelayMs: DEFAULT_INTERACTION_PROBE_DELAY_MS,
            maxProbesPerRun: runOptions.maxProbesPerRun,
            forceProbeUnlisted: runOptions.forceProbeUnlisted,
            trigger: runOptions.trigger,
          },
        );

        // 完整与否都记录时间：否则超出探测预算的账号会被每分钟反复重试。
        // 主页触发的补充同步刻意**不**更新这个水位：判定工作留给下一次定时任务，
        // 否则频繁逛主页会把定时任务一直往后推，消失判定永远轮不到。
        if (runOptions.trigger !== "page") {
          await setStorageValue(INTERACTIONS_LAST_SYNC, Date.now());
        }
        // 新记录可能带着还没归档的封面，复位归档状态让归档任务重新启动
        await resetInteractionCoverArchiveIfCompleted();

        // 把"稿件本身查不到"的互动记录转进统一消失档案。
        //
        // 互动记录**从不删除**，所以这里不是"先留档再移除"，而是把已经判定为
        // `content_deleted` / `content_hidden` 的条目汇进档案页，让用户在一个地方
        // 看到"哪些内容真的没了"。只掉出 20 条窗口（`retained`）或还没核查出来
        // （`unlisted`）的**不进档案**——那两种内容还在。
        try {
          const all = await getAllInteractions();
          const lost = all.filter(shouldArchiveInteraction);
          if (lost.length > 0) {
            const now = Date.now();
            const archived = lost
              .map((item) => {
                const reason = resolveInteractionArchiveReason(item);
                return reason ? buildInteractionArchiveItem(item, reason, now) : null;
              })
              .filter((item): item is VanishArchiveItem => item !== null);
            await putVanishArchive(archived);
            console.log(`互动记录：${archived.length} 条稿件已不可查，已汇入消失档案`);
          }
        } catch (error) {
          // 归档失败不能影响同步本身：同步结果已经落库了
          console.warn("汇入互动消失档案失败:", error);
        }

        console.log("互动记录同步结束:", outcome);
        return outcome;
      } catch (error) {
        // 走到这里说明失败发生在 getBilibiliSessdata / getCurrentBilibiliMid 阶段，
        // runInteractionSync 内部的抓取错误它自己已经兜住了。
        const kind = error instanceof FollowingRequestError ? error.kind : "unknown";
        const status: InteractionSyncOutcome["status"] =
          kind === "auth" ? "auth_invalid" : kind === "rate_limited" ? "rate_limited" : "failed";
        const message = error instanceof Error ? error.message : String(error);
        console.error("互动记录同步失败:", message);

        const progress: InteractionSyncProgress = {
          status,
          types: [],
          trigger: runOptions.trigger,
          startedAt,
          completedAt: Date.now(),
          lastError: message,
        };
        await setStorageValue(INTERACTIONS_SYNC_PROGRESS, progress).catch(() => undefined);

        return {
          status,
          types: [],
          added: 0,
          unlisted: 0,
          probed: 0,
          ended: 0,
          error: message,
        };
      }
    })();

    interactionSyncPromise = task;
    const clear = () => {
      if (interactionSyncPromise === task) interactionSyncPromise = null;
    };
    task.then(clear, clear);
    return task;
  };

  // ---------------------------------------------------------------------------
  // 逛 B 站个人主页时顺手补一次同步
  //
  // 动机只有一个：B 站只给最近 20 条，定时同步默认 3 小时一次，中间点赞多了，
  // 早的那几条会被挤出窗口、永久拿不回来。用户正在浏览个人主页时顺手抓一把最划算。
  //
  // 两条自我约束：
  //   1）最小间隔 30 分钟，避免连点页面就发一串请求；
  //   2）**不做消失判定**（maxProbesPerRun: 0）——浏览是浏览，判定留给定时任务。
  // 用 tabs.onUpdated 而不是往 content script 里加逻辑：后台本来就有 tabs 权限，
  // 这样不必再动页面注入脚本。
  // ---------------------------------------------------------------------------
  const maybeSyncInteractionsOnSpaceVisit = async (): Promise<void> => {
    try {
      const enabled = await getStorageValue(
        INTERACTIONS_AUTO_SYNC_ENABLED,
        DEFAULT_INTERACTIONS_AUTO_SYNC_ENABLED,
      );
      if (!enabled) return;
      if (interactionSyncPromise) return;

      const lastTriggerAt = await getStorageValue<number>(INTERACTIONS_PAGE_TRIGGER_LAST_AT, 0);
      const gapMs =
        Math.max(1, DEFAULT_INTERACTIONS_PAGE_TRIGGER_GAP_MINUTES) * 60 * 1000;
      if (lastTriggerAt && Date.now() - lastTriggerAt < gapMs) return;

      await setStorageValue(INTERACTIONS_PAGE_TRIGGER_LAST_AT, Date.now());
      const task = startInteractionSync({ trigger: "page", maxProbesPerRun: 0 });
      if (!task) return;
      const outcome = await task;
      console.log(`主页访问触发的互动记录补充同步：${outcome.status}`);
    } catch (error) {
      console.error("主页访问触发的互动记录同步失败:", error);
    }
  };

  browser.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
    if (changeInfo.status !== "complete") return;
    const url = tab?.url ?? "";
    // 任何人的个人主页都算：抓的始终是**自己**的点赞/投币列表
    if (!/^https:\/\/space\.bilibili\.com\//.test(url)) return;
    void maybeSyncInteractionsOnSpaceVisit();
  });

  const handleSyncInteractions = async (sendResponse: (response: any) => void) => {
    // 手动同步：强制重探"未判定"的条目，用户点一次就能把卡住的记录推一遍
    const task = startInteractionSync({
      trigger: "manual",
      maxProbesPerRun: DEFAULT_MAX_PROBES_PER_RUN,
      forceProbeUnlisted: true,
    });
    if (!task) {
      sendResponse({ success: false, error: "互动记录同步正在进行中，请稍后再试" });
      return;
    }

    try {
      const outcome = await task;
      const ok = outcome.status === "completed" || outcome.status === "incomplete";
      const parts = outcome.types.map(
        (item) =>
          `${item.type === "like" ? "点赞" : "投币"} ${item.fetchedCount} 条（新增 ${item.added}）`,
      );
      sendResponse({
        success: ok,
        status: outcome.status,
        added: outcome.added,
        unlisted: outcome.unlisted,
        probed: outcome.probed,
        ended: outcome.ended,
        types: outcome.types,
        message: ok
          ? `互动记录同步完成：${parts.join("，")}，判定结束 ${outcome.ended} 条`
          : undefined,
        error: outcome.error,
      });
    } catch (error) {
      console.error("同步互动记录失败:", error);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "未知错误",
      });
    }
  };

  // ---------------------------------------------------------------------------
  // 互动记录封面的字节归档
  //
  // 与收藏封面共用同一个泛型任务（runCoverArchive）与同一套 assets 存储：
  // 封面还被 B 站正常提供时就把字节存下来，之后换成占位图也不怕。
  // 可续跑性来自筛选条件——已归档的记录 coverAssetId 非空，下一轮自然跳过。
  // ---------------------------------------------------------------------------
  let interactionCoverArchivePromise: Promise<CoverArchiveProgress> | null = null;

  const readInteractionCoverArchiveProgress = async (): Promise<CoverArchiveProgress | null> =>
    await getStorageValue<CoverArchiveProgress | null>(INTERACTIONS_COVER_ARCHIVE_PROGRESS, null);

  const startInteractionCoverArchive = (): Promise<CoverArchiveProgress> | null => {
    if (interactionCoverArchivePromise) return null;

    const task = (async (): Promise<CoverArchiveProgress> => {
      const previous = await readInteractionCoverArchiveProgress();
      const carryOver = previous && previous.status !== "completed" ? previous : null;

      return await runCoverArchive(
        {
          loadResources: () => getAllInteractions(),
          persist: (updates) => applyInteractionCoverAssets(updates),
          saveProgress: async (progress) => {
            await setStorageValue(INTERACTIONS_COVER_ARCHIVE_PROGRESS, progress);
          },
          now: () => Date.now(),
          delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          archive: (cover) => archiveCover(cover),
        },
        {
          baseArchived: carryOver?.archived ?? 0,
          baseFailed: carryOver?.failed ?? 0,
        },
      );
    })();

    interactionCoverArchivePromise = task;
    const clear = () => {
      if (interactionCoverArchivePromise === task) interactionCoverArchivePromise = null;
    };
    task.then(clear, clear);
    return task;
  };

  /** 互动同步后可能有新记录需要归档，把状态从 completed 复位以重新启动归档 */
  const resetInteractionCoverArchiveIfCompleted = async (): Promise<void> => {
    const progress = await readInteractionCoverArchiveProgress();
    if (progress?.status === "completed") {
      await setStorageValue(INTERACTIONS_COVER_ARCHIVE_PROGRESS, { ...progress, status: "idle" });
    }
  };

  const handleInteractionCoverArchive = async (sendResponse: (response: any) => void) => {
    const task = startInteractionCoverArchive();
    if (!task) {
      sendResponse({ success: false, error: "互动封面归档正在进行中，请稍后再试" });
      return;
    }

    try {
      const result = await task;
      sendResponse({
        success: true,
        archived: result.archived,
        failed: result.failed,
        remaining: result.remaining,
        status: result.status,
        message: `本轮归档 ${result.pending - result.remaining} 张，剩余 ${result.remaining} 张`,
      });
    } catch (error) {
      console.error("互动封面归档失败:", error);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "互动封面归档失败",
      });
    }
  };

  // ---------------------------------------------------------------------------
  // 失效收藏的第三方恢复
  //
  // Phase 4 实测确定的能力边界（不要给用户过度承诺）：
  // - biliplus 持有**部分独立档案**：同一个 aid 上 B站 返回 `62002 稿件不可见`，
  //   而 biliplus 能给出真实标题与封面
  // - 但对 B站 已彻底删除的（`-404 啥都木有`），biliplus 同样没有
  // - xbeibeix 实测 20 秒超时（等效下线），因此只用 biliplus；jijidown 保留为降级来源
  //
  // 所以恢复按 `invalidatedKind` 排优先级：`attr 9`（UP 主自己删除，B站 62002）
  // 先跑，`attr 1`（其他原因删除/退回，B站 -404）最后跑，避免把请求配额浪费在
  // 几乎必然失败的条目上。
  //
  // 恢复结果直接写回 `title` / `cover`，并由 `saveFavResources` 的保护逻辑持有，
  // 不会被下一次同步的占位内容覆盖。
  // ---------------------------------------------------------------------------
  let favRecoveryPromise: Promise<FavRecoveryOutcome> | null = null;

  /**
   * 恢复成功后把封面字节也归档下来。
   *
   * 恢复那一刻封面还可以抓到，正是归档的时机；只记 URL 的话，等它再次失效就没了。
   * `archiveCover` 对占位图与无法解析的地址会返回 null，此时原样返回。
   */
  const archiveRecoveredCover = async (
    resource: FavoriteResource,
  ): Promise<FavoriteResource> => {
    try {
      const result = await archiveCover(resource.cover);
      return result ? { ...resource, coverAssetId: result.assetId } : resource;
    } catch (error) {
      // 归档失败不影响恢复结果本身
      console.warn(`恢复后归档封面失败（av${resource.id}）:`, error);
      return resource;
    }
  };

  const startFavRecovery = (
    options: { limit?: number } = {},
  ): Promise<FavRecoveryOutcome> | null => {
    if (favRecoveryPromise) return null;

    const task = (async (): Promise<FavRecoveryOutcome> => {
      const all = await getAllFavResources();
      const stats = buildRecoveryStats(all);
      const candidates = buildRecoveryCandidates(all, options.limit ?? DEFAULT_RECOVERY_LIMIT);

      const result: FavRecoveryOutcome = {
        scanned: all.length,
        invalid: stats.invalid,
        pending: stats.pending,
        attempted: candidates.length,
        recovered: 0,
        recoveredLocal: 0,
        failedBatches: 0,
        sources: {},
        remaining: stats.pending,
      };

      console.log(
        `失效收藏恢复：共 ${stats.total} 条，失效 ${stats.invalid} 条，待恢复 ${stats.pending} 条，本轮处理 ${candidates.length} 条`,
      );
      if (candidates.length === 0) return result;

      // 诊断：确认收藏夹接口到底有没有把分P信息存进来。
      // 分P标题还原是零请求路径，若它一直为 0，说明 `pages` 不在本地记录里。
      const sample = candidates[0];
      console.log(
        `样本记录诊断：aid=${sample.id} page=${String(sample.page)} pages=${JSON.stringify(sample.pages)?.slice(0, 200) ?? "无"}`,
      );
      console.log(`样本记录实际字段：${Object.keys(sample).join(", ")}`);

      // 整条流水线共用一份工作副本。
      // 必须如此：第零步补好的封面，若后续步骤拿着**旧对象**去改标题，
      // 最后写库时会把刚补上的封面又覆盖回占位图。
      const working = new Map<number, FavoriteResource>(
        candidates.map((resource) => [resource.id, resource]),
      );
      const touched = new Set<number>();
      const markImproved = (resource: FavoriteResource) => {
        working.set(resource.id, resource);
        touched.add(resource.id);
      };
      const fieldChanged = (fields: string[], names: string[]) =>
        fields.some((field) => names.includes(field));

      const unresolved: FavoriteResource[] = [];

      const illegalAidCount = all.filter(
        (resource) => needsRecovery(resource) && toValidAid(resource) === null,
      ).length;
      if (illegalAidCount > 0) {
        console.warn(`跳过 ${illegalAidCount} 条 aid 非法的记录（无法查询）`);
      }

      // 第零步：本地交叉引用（**零网络请求**，所以排在最前）。
      // 同一个稿件可能也在观看历史 / 喜欢的音乐 / 订阅合集里，
      // 那些记录是稿件失效**之前**抓下来的，封面往往还是好的。
      const localCoverIndex = buildLocalCoverIndex({
        history: await getAllHistory(),
        likedMusic: await getAllLikedMusic(),
        collectionResources: await getAllSubscribedCollectionResources(),
      });
      let localCoverHits = 0;
      if (localCoverIndex.size > 0) {
        for (const resource of candidates) {
          const candidate = localCoverIndex.get(resourceBvid(resource));
          if (!candidate) continue;
          const outcome = applyLocalCover(working.get(resource.id)!, candidate, Date.now());
          if (!outcome.changed) continue;
          markImproved(outcome.resource);
          localCoverHits += 1;
          result.recovered += 1;
          const source = outcome.resource.recoverySource ?? "local_history";
          result.sources[source] = (result.sources[source] ?? 0) + 1;
        }
      }
      console.log(
        `本地交叉引用：索引 ${localCoverIndex.size} 条封面，命中补齐 ${localCoverHits} 条（无网络请求）`,
      );

      // 第一步：本地分P标题还原。零网络请求，能本地解决的就不要去麻烦外部站点。
      for (const resource of candidates) {
        const outcome = applyGuessedTitle(working.get(resource.id)!, Date.now());
        if (outcome.changed) {
          markImproved(outcome.resource);
          result.recovered += 1;
          result.recoveredLocal += 1;
          result.sources.bilibili_pages = (result.sources.bilibili_pages ?? 0) + 1;
        } else {
          unresolved.push(resource);
        }
      }
      console.log(`分P标题还原：${result.recoveredLocal}/${candidates.length} 条（无网络请求）`);

      // 第二步：biliplus 批量。一次请求可查多个 aid，是覆盖面主力（但对本用户实测 0 命中）。
      let stillUnresolved: FavoriteResource[] = [];
      if (unresolved.length > 0) {
        const byAid = new Map(unresolved.map((item) => [item.id, item]));
        const chunks = chunkAids(
          unresolved.map((item) => item.id),
          BILIPLUS_BATCH_SIZE,
        );

        for (const chunk of chunks) {
          const batch = await fetchBiliplusAidInfoWithRetry(chunk, {
            onWait: (waitMs, status) => {
              console.log(
                `biliplus ${status === "rate_limited" ? "限流" : "网络失败"}，等待 ${Math.round(
                  waitMs / 1000,
                )} 秒后重试同一批（${chunk.length} 条）`,
              );
            },
          });

          // all_missing 是正常结果：本批的 aid 在 biliplus 都没有记录，继续下一批
          if (batch.status === "ok" || batch.status === "all_missing") {
            for (const aid of chunk) {
              const resource = byAid.get(aid);
              if (!resource) continue;
              const outcome = applyRecoveryResult(
                working.get(aid)!,
                batch.data[String(aid)],
                "biliplus",
                Date.now(),
              );
              if (outcome.changed) {
                markImproved(outcome.resource);
                result.recovered += 1;
                result.sources.biliplus = (result.sources.biliplus ?? 0) + 1;
              } else {
                stillUnresolved.push(resource);
              }
            }

            console.log(
              `biliplus 批次完成：命中 ${Object.keys(batch.data).length}/${chunk.length} 条` +
                (batch.status === "all_missing" ? "（本批全部无记录）" : ""),
            );
          } else {
            // 重试后仍失败：这批暂时判不了，交给 jijidown 降级，而不是直接丢弃
            result.failedBatches += 1;
            console.warn(
              `biliplus 批次放弃：status=${batch.status} message=${batch.message ?? "无"}，转由 jijidown 处理`,
            );
            stillUnresolved.push(...chunk.map((aid) => byAid.get(aid)).filter(Boolean) as FavoriteResource[]);
          }

          await new Promise((resolve) => setTimeout(resolve, BILIPLUS_BATCH_DELAY_MS));
        }
      }

      // 第三步：B站 非鉴权公开收藏夹接口。
      // 鉴权接口不返回分P 数组 `pages`，这是拿到它的唯一途径；
      // 而分P标题是失效稿件标题的最后一条免费线索。
      // 用记录的 index 直接定位页码，避免把整个收藏夹翻一遍（814 条要 41 页）。
      if (stillUnresolved.length > 0) {
        const pageTasks = groupCandidatesByPage(stillUnresolved).slice(
          0,
          PUBLIC_FAV_MAX_PAGES_PER_RUN,
        );
        const byId = new Map(stillUnresolved.map((item) => [item.id, item]));
        const resolvedIds = new Set<number>();
        let pagesRequested = 0;
        let matched = 0;
        let improved = 0;

        for (const task of pageTasks) {
          const page = await fetchPublicFavPage(task.folderId, task.page);
          pagesRequested += 1;

          if (!page.ok) {
            console.warn(
              `公开接口失败（folder=${task.folderId} pn=${task.page}）：${page.message ?? "未知原因"}`,
            );
          } else {
            for (const media of page.medias) {
              if (!task.aids.has(media.id)) continue;
              const resource = byId.get(media.id);
              if (!resource) continue;
              matched += 1;

              const outcome = applyPublicMedia(working.get(media.id)!, media, Date.now());
              if (!outcome.changed) continue;

              improved += 1;
              resolvedIds.add(media.id);
              markImproved(outcome.resource);
              result.sources.bilibili_public = (result.sources.bilibili_public ?? 0) + 1;
              // 只有标题或封面真的改善了才算「恢复」；仅补到分P信息不算
              if (fieldChanged(outcome.fields, ["title", "cover", "title_by_pages"])) {
                result.recovered += 1;
              }
            }
          }

          await new Promise((resolve) => setTimeout(resolve, PUBLIC_FAV_PAGE_DELAY_MS));
        }

        console.log(
          `公开收藏夹接口：请求 ${pagesRequested} 页，匹配 ${matched} 条，改善 ${improved} 条`,
        );

        // 只有确实改善过的才算解决；公开接口没匹配到的继续走 jijidown
        stillUnresolved = stillUnresolved.filter((item) => !resolvedIds.has(item.id));
      }

      // 第四步：jijidown 单条降级，**自动多轮重试**。
      //
      // jijidown 也会限流，表现是 **upid 缺失 / code 0 / HTTP 502-503**，
      // 与"确实没有这条记录"（upid 为 -1 / 0）是两回事。
      // 社区脚本对限流的处理是提示用户"请求过快，请点击手动加载"——靠人工反复重试。
      // 这里改成自动：本轮被限流的条目，退避之后统一再跑一轮。
      if (stillUnresolved.length > 0) {
        let pendingJijidown = [...stillUnresolved];
        let jijidownHit = 0;
        let jijidownMiss = 0;

        for (let pass = 0; pass < JIJIDOWN_MAX_PASSES && pendingJijidown.length > 0; pass += 1) {
          const retryNext: FavoriteResource[] = [];
          let hit = 0;
          let miss = 0;

          for (let index = 0; index < pendingJijidown.length; index += 1) {
            const resource = pendingJijidown[index];

            if (index % 10 === 0) {
              console.log(`jijidown 第 ${pass + 1} 轮：${index + 1}/${pendingJijidown.length}`);
            }

            const response = await fetchJijidownInfo(resource.id);

            if (response.status === "rate_limited") {
              // 已被限流：剩余条目不要继续撞墙，整批留到下一轮
              retryNext.push(resource, ...pendingJijidown.slice(index + 1));
              console.log(
                `jijidown 触发限流（已处理 ${index}/${pendingJijidown.length}），` +
                  `剩余 ${retryNext.length} 条留待下一轮`,
              );
              break;
            }

            if (response.status === "ok" && response.info) {
              const outcome = applyRecoveryResult(
                working.get(resource.id)!,
                response.info,
                "jijidown",
                Date.now(),
              );
              if (outcome.changed) {
                markImproved(outcome.resource);
                result.recovered += 1;
                result.sources.jijidown = (result.sources.jijidown ?? 0) + 1;
                hit += 1;
                await new Promise((resolve) => setTimeout(resolve, JIJIDOWN_ITEM_DELAY_MS));
                continue;
              }
            }

            miss += 1;
            await new Promise((resolve) => setTimeout(resolve, JIJIDOWN_ITEM_DELAY_MS));
          }

          jijidownHit += hit;
          jijidownMiss += miss;
          console.log(
            `jijidown 第 ${pass + 1} 轮结束：命中 ${hit}，确实没有 ${miss}，待重试 ${retryNext.length}`,
          );

          pendingJijidown = retryNext;
          if (retryNext.length > 0 && pass + 1 < JIJIDOWN_MAX_PASSES) {
            const waitMs = JIJIDOWN_BACKOFF_BASE_MS * (pass + 1);
            console.log(
              `jijidown 退避 ${Math.round(waitMs / 1000)} 秒后重试 ${retryNext.length} 条`,
            );
            await new Promise((resolve) => setTimeout(resolve, waitMs));
          }
        }

        if (pendingJijidown.length > 0) {
          console.warn(
            `jijidown 仍有 ${pendingJijidown.length} 条因限流未处理，稍后再点一次「恢复失效内容」可继续`,
          );
        }
        console.log(`jijidown 合计：命中 ${jijidownHit}，确实没有 ${jijidownMiss}`);
      }

      // 一次性写回所有被改善的记录（取自共享工作副本，避免互相覆盖）
      const changedResources = [...touched]
        .map((id) => working.get(id))
        .filter(Boolean) as FavoriteResource[];

      // 恢复拿到的封面**同样是"还能抓到"的时机**，顺手把字节归档下来。
      // 否则只是记了个 URL，等它再次失效就彻底没了。
      const finalResources: FavoriteResource[] = [];
      for (const resource of changedResources) {
        if (resource.coverAssetId) {
          finalResources.push(resource);
          continue;
        }
        finalResources.push(await archiveRecoveredCover(resource));
      }

      if (finalResources.length > 0) {
        await applyFavResourceRecovery(finalResources);
      }

      result.remaining = Math.max(0, stats.pending - result.recovered);
      console.log("失效收藏恢复结束:", result);
      return result;
    })();

    favRecoveryPromise = task;
    const clear = () => {
      if (favRecoveryPromise === task) favRecoveryPromise = null;
    };
    task.then(clear, clear);
    return task;
  };

  const handleFavRecovery = async (sendResponse: (response: any) => void) => {
    // 这行是"消息到底有没有送达"的唯一凭据。看不到它就说明请求根本没进来
    console.log("收到失效收藏恢复请求");
    const task = startFavRecovery();
    if (!task) {
      sendResponse({ success: false, error: "恢复任务正在进行中，请稍后再试" });
      return;
    }

    try {
      const result = await task;
      sendResponse({
        success: true,
        ...result,
        message:
          result.attempted === 0
            ? "没有需要恢复的条目"
            : `本轮查询 ${result.attempted} 条，恢复 ${result.recovered} 条，剩余 ${result.remaining} 条`,
      });
    } catch (error) {
      console.error("失效收藏恢复失败:", error);
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : "失效收藏恢复失败",
      });
    }
  };

  async function syncFavorites(isFullSync = false): Promise<void> {
    try {
      const { sessdata, folders } = await getFavoriteFoldersFromBilibili();

      if (folders.length > 0) {
        await saveFavFolders(folders);
        console.log(`同步了 ${folders.length} 个收藏夹`);
      }

      for (const folder of folders) {
        await syncFavoriteFolderResources(folder, sessdata, isFullSync);
      }
    } catch (error) {
      console.error("同步收藏夹过程出错:", error);
      throw error;
    }
  }

  async function getBilibiliSession(): Promise<string> {
    const cookies = await browser.cookies.getAll({ domain: "bilibili.com" });
    const sessdata = cookies.find((cookie) => cookie.name === "SESSDATA")?.value;
    if (!sessdata) throw new Error("未找到 B 站登录信息，请先登录 B 站");
    return sessdata;
  }

  async function getCurrentBilibiliMid(sessdata: string): Promise<number> {
    const navRes = await fetch("https://api.bilibili.com/x/web-interface/nav", {
      headers: { Cookie: `SESSDATA=${sessdata}` },
    });
    if (!navRes.ok) throw new Error("获取用户信息失败");

    const navData = await navRes.json();
    if (navData.code !== 0 || !navData.data?.mid)
      throw new Error(navData.message || "获取用户信息失败");
    return navData.data.mid;
  }

  async function syncSubscribedCollections(): Promise<void> {
    const sessdata = await getBilibiliSession();
    const currentMid = await getCurrentBilibiliMid(sessdata);
    const pageSize = 50;
    let page = 1;
    let total: number | null = null;
    const collections: SubscribedCollection[] = [];

    // total 只能从第一页响应中取得，因此必须保证第一页至少请求一次。
    while (total === null || collections.length < total) {
      const response = await fetch(
        `https://api.bilibili.com/x/v3/fav/folder/collected/list?pn=${page}&ps=${pageSize}&up_mid=${currentMid}&platform=web&web_location=333.1387`,
        { headers: { Cookie: `SESSDATA=${sessdata}` } },
      );
      if (!response.ok) throw new Error("获取订阅合集失败");

      const data = await response.json();
      if (data.code !== 0) throw new Error(data.message || "获取订阅合集失败");

      if (!data.data || !("list" in data.data)) {
        throw new Error("订阅合集数据格式异常");
      }

      const onlineCollections = data.data.list;
      if (onlineCollections !== null && !Array.isArray(onlineCollections)) {
        throw new Error("订阅合集数据格式异常");
      }

      const nextTotal = Number(data.data.count);
      if (!Number.isSafeInteger(nextTotal) || nextTotal < 0) {
        throw new Error("订阅合集数量格式异常");
      }

      const list = onlineCollections || [];
      total = nextTotal;
      const startIndex = collections.length;
      collections.push(
        ...list.map((item: any, index: number) => ({
          id: item.id,
          mid: item.mid,
          title: item.title || "未命名合集",
          cover: item.cover || "",
          intro: item.intro || "",
          ctime: item.ctime || 0,
          mtime: item.mtime || 0,
          media_count: item.media_count || 0,
          upper: item.upper || { mid: item.mid, name: "未知 UP 主", face: "" },
          index: startIndex + index,
        })),
      );

      if (collections.length >= total) break;
      if (list.length === 0) break; // 空页保护，防止接口异常导致死循环
      page += 1;
    }

    await replaceSubscribedCollections(collections);
  }

  async function syncSubscribedCollectionResources(collectionId: number): Promise<void> {
    const sessdata = await getBilibiliSession();
    const pageSize = 30;
    let page = 1;
    let hasMore = true;
    const resources: SubscribedCollectionResource[] = [];

    while (hasMore) {
      const response = await fetch(
        `https://api.bilibili.com/x/space/fav/season/list?season_id=${collectionId}&pn=${page}&ps=${pageSize}`,
        {
          headers: {
            Cookie: `SESSDATA=${sessdata}`,
          },
        },
      );
      if (!response.ok) throw new Error("获取合集内容失败");

      const data = await response.json();
      if (data.code !== 0) throw new Error(data.message || "获取合集内容失败");

      const medias = data.data?.medias || [];
      resources.push(
        ...medias.map((media: any, index: number) => ({
          id: `${collectionId}-${media.id}`,
          collection_id: collectionId,
          aid: media.id,
          bvid: media.bvid || media.bv_id || "",
          title: media.title || "未命名视频",
          cover: media.cover || "",
          duration: media.duration || 0,
          author_name: media.upper?.name || "未知 UP 主",
          author_mid: media.upper?.mid || 0,
          pubdate: media.pubtime || media.ctime || 0,
          index: resources.length + index,
          // 失效标记必须一起抓：没有它，整夹替换时失效视频的元数据会被占位内容覆盖
          attr: Number(media.attr) || 0,
        })),
      );

      hasMore = Boolean(data.data?.has_more);
      if (hasMore && medias.length === 0) break; // 空页保护，防止接口异常导致死循环
      page += 1;
    }

    // 整夹替换前**先把本轮要消失的条目留档**。
    //
    // 原实现直接 replaceSubscribedCollectionResources：本地有、在线没有的键会被删掉，
    // 数据当场就没了。收藏早就有"先留档再移除"，合集却一直漏着——用户反馈
    // "订阅里已经有一半内容消失了"，就是从这里丢的。
    const previous = await getSubscribedCollectionResources(collectionId);
    if (previous.length > 0) {
      const incomingIds = new Set(resources.map((resource) => resource.id));
      const vanished = previous.filter((resource) => !incomingIds.has(resource.id));

      if (vanished.length > 0 && resources.length === 0) {
        // 本地有、这次却一条都没抓到：更可能是接口异常而不是合集被清空。
        // 宁可这一轮不留档（也不删——replace 会删，所以这里直接跳过替换），
        // 也不能把几百条正常内容一次性打成"消失"。
        console.warn(`合集 ${collectionId} 本次返回 0 条而本地有 ${previous.length} 条，跳过替换以免误判`);
        return;
      }

      if (vanished.length > 0) {
        const now = Date.now();
        const archived: VanishArchiveItem[] = [];
        for (const resource of vanished) {
          // 复用收藏那套探测：判断是"内容被删/不可见"还是只是从合集里移出
          const probe = await probeFavoriteResource(
            { bvid: resource.bvid } as FavoriteResource,
            sessdata,
          );
          // `classifyViewProbe` 的 `unfavorited` 对合集而言就是"稿件仍在、
          // 只是不再属于这个合集"，映射成合集专属原因；其余原因直接沿用。
          const probed = classifyViewProbe(probe);
          const reason: VanishArchiveReason =
            probed === "unfavorited" ? "collection_removed" : probed;
          archived.push(
            buildCollectionArchiveItem(
              resource,
              reason,
              now,
              probe.ok ? undefined : `探测失败：${probe.message ?? "未知原因"}`,
            ),
          );
          await new Promise((resolve) => setTimeout(resolve, VANISH_PROBE_DELAY_MS));
        }
        await putVanishArchive(archived);
        console.log(`合集 ${collectionId}：${archived.length} 条已转入消失档案`);
      }
    }

    await replaceSubscribedCollectionResources(collectionId, resources);
  }

  // WebDAV 同步数据项定义：文件名、本地读取与远端合并策略（与 WebDavSync 页面保持一致）
  const WEBDAV_DATA_ITEMS: {
    key: WebDavSyncKey;
    label: string;
    file: string;
    getAll: () => Promise<unknown[]>;
    merge: (items: any[]) => Promise<unknown>;
  }[] = [
    {
      key: "history",
      label: "历史",
      file: "history.json",
      getAll: getAllHistory,
      merge: smartMergeHistory,
    },
    {
      key: "favFolders",
      label: "收藏夹",
      file: "favFolders.json",
      getAll: getAllFavFolders,
      merge: importFavFolders,
    },
    {
      key: "favResources",
      label: "收藏",
      file: "favResources.json",
      getAll: getAllFavResources,
      merge: smartMergeFavResources,
    },
    {
      key: "subscribedCollections",
      label: "订阅合集",
      file: "subscribedCollections.json",
      getAll: getAllSubscribedCollections,
      merge: importSubscribedCollections,
    },
    {
      key: "subscribedCollectionResources",
      label: "合集视频",
      file: "subscribedCollectionResources.json",
      getAll: getAllSubscribedCollectionResources,
      merge: smartMergeSubscribedCollectionResources,
    },
    {
      key: "following",
      label: "关注",
      file: "following.json",
      getAll: getAllFollowing,
      merge: smartMergeFollowing,
    },
    {
      key: "followingEvents",
      label: "关注变动",
      file: "followingEvents.json",
      getAll: getAllFollowingEvents,
      merge: smartMergeFollowingEvents,
    },
    {
      key: "vanishedFavResources",
      label: "消失档案",
      file: "vanishedFavResources.json",
      getAll: getAllVanishedFavResources,
      merge: smartMergeVanishedFavResources,
    },
    {
      key: "interactions",
      label: "点赞与投币",
      file: "interactions.json",
      getAll: getAllInteractions,
      merge: smartMergeInteractions,
    },
    {
      key: "vanishArchive",
      label: "消失档案",
      file: "vanishArchive.json",
      getAll: getAllVanishArchive,
      merge: smartMergeVanishArchive,
    },
  ];

  // WebDAV 自动双向同步：拉取 → 合并 → 推送（仅同步用户勾选的数据项）
  async function autoSyncWebDav(): Promise<void> {
    try {
      const config = await loadWebDavConfig();
      if (!config || !config.serverUrl) {
        console.log("WebDAV 未配置，跳过自动同步");
        return;
      }

      const syncItems = await getStorageValue<WebDavSyncItems>(
        WEBDAV_SYNC_ITEMS,
        DEFAULT_WEBDAV_SYNC_ITEMS,
      );
      const items = WEBDAV_DATA_ITEMS.filter((item) => syncItems[item.key]);
      if (items.length === 0) {
        console.log("WebDAV 同步数据项均未勾选，跳过自动同步");
        return;
      }

      console.log(`开始 WebDAV 双向同步（${items.map((i) => i.label).join("、")}）...`);
      if (!(await ensureDirectory(config))) {
        throw new Error("WebDAV 备份目录创建失败");
      }

      // ===== 第一步：拉取远端数据并合并到本地 =====
      console.log("[WebDAV 同步] 步骤 1/2：拉取并合并远端数据...");
      const deletedHistoryIds = await getDeletedHistoryIds();
      for (const item of items) {
        const remote = await downloadFile(config, item.file);
        if (remote) {
          if (item.key === "history") {
            await smartMergeHistory(JSON.parse(remote), deletedHistoryIds);
          } else {
            await item.merge(JSON.parse(remote));
          }
        }
        if (item.key === "history") {
          const remoteV2 = await downloadFile(config, "history-v2.json");
          if (remoteV2) await mergeHistoryV2Backup(JSON.parse(remoteV2));
        }
      }

      // ===== 第二步：将合并后的最新本地数据推送到远端 =====
      console.log("[WebDAV 同步] 步骤 2/2：推送本地数据到远端...");
      const summary: string[] = [];
      for (const item of items) {
        const data = await item.getAll();
        if (item.key === "history") {
          const v2 = await getHistoryV2Backup();
          if (!(await uploadFile(config, "history-v2.json", JSON.stringify(v2)))) {
            throw new Error("WebDAV 上传历史 v2 失败");
          }
        }
        if (!(await uploadFile(config, item.file, JSON.stringify(data)))) {
          throw new Error(`WebDAV 上传${item.label}失败`);
        }
        if (item.key === "history") {
          const v2 = await getHistoryV2Backup();
          summary.push(`${item.label} ${data.length} 个内容 / ${v2.events.length} 次观看`);
        } else {
          summary.push(`${item.label} ${data.length}`);
        }
      }

      // 同步完成，记录时间戳
      await setStorageValue(WEBDAV_LAST_SYNC, Date.now());

      console.log(`WebDAV 双向同步完成：${summary.join("，")}`);
    } catch (error) {
      console.error("WebDAV 双向同步失败:", error);
    }
  }
});
