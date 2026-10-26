import { useEffect, useState, useRef, useMemo } from "react";
import toast from "react-hot-toast";
import {
  clearFavResourcesByFolder,
  deleteFavFolderWithResources,
  getFavFolders,
  getFavResources,
} from "../utils/db";
import {
  FavoriteFolder,
  FavoriteResource,
  RefreshFavoriteFoldersRequest,
  RefreshFavoriteFoldersResponse,
  FavoriteFolderSyncProgress,
  AllFavoriteFoldersSyncProgress,
} from "../utils/types";
import {
  FAVORITE_FOLDER_SYNC_PROGRESS,
  ALL_FAVORITE_FOLDERS_SYNC_PROGRESS,
} from "../utils/constants";
import {
  Folder,
  Video,
  Search,
  X,
  ChevronDownIcon,
  CloudDownload,
  RefreshCw,
  Trash2,
  MoreHorizontal,
  Wand2,
  Copy,
} from "lucide-react";
import { Pagination } from "../components/Pagination";
import { buildRecoveryStats } from "../utils/favRecovery";
import {
  buildResourceCopyText,
  resolveFavResourceBadge,
  resolveFavResourceHint,
  resolveFavResourceState,
} from "../utils/favResourceInfo";
import { FavResourceHoverPanel } from "../components/FavResourceHoverPanel";
import { PLACEHOLDER_COVER_PATH } from "../utils/imageUrl";
import { getStorageValue } from "../utils/storage";
import { FAV_RECOVERY_PROGRESS } from "../utils/constants";
import { formatInteractionDuration } from "../utils/interactionQuery";
import { FavoriteFolderSyncModal } from "../components/FavoriteFolderSyncModal";
import { AllFavoriteFoldersSyncModal } from "../components/AllFavoriteFoldersSyncModal";
import { ClearFavoriteFolderModal } from "../components/ClearFavoriteFolderModal";
import { DeleteFavoriteFolderModal } from "../components/DeleteFavoriteFolderModal";

/**
 * storage 里的恢复进度超过这个时间没有心跳，就认为任务已经随 Service Worker
 * 重启而消失（旧版本结束时只写 running、不写完成，会留下"僵尸进度"）。
 */
const FAV_RECOVERY_STALE_MS = 120_000;

/** 恢复流水线的阶段名。页面据此显示「正在 biliplus 查询 20/83」而不是一个不动的数字 */
const RECOVERY_PHASE_LABEL: Record<string, string> = {
  local: "本地比对",
  biliplus: "biliplus 查询",
  public: "公开接口补全",
  jijidown: "jijidown 补全",
  archiving: "归档封面",
  done: "收尾",
};

interface RecoveryProgressView {
  done: number;
  total: number;
  recovered: number;
  phase?: string;
  phaseDone?: number;
  phaseTotal?: number;
}

const recoveryPercent = (progress: RecoveryProgressView | null): number => {
  if (!progress) return 5;
  if (progress.phaseTotal && progress.phaseTotal > 0) {
    return Math.min(100, Math.round(((progress.phaseDone ?? 0) / progress.phaseTotal) * 100));
  }
  if (progress.total > 0) {
    return Math.min(100, Math.round((progress.done / progress.total) * 100));
  }
  return 5;
};

const recoveryProgressText = (progress: RecoveryProgressView | null): string => {
  if (!progress) return "正在准备…";
  const label = progress.phase ? RECOVERY_PHASE_LABEL[progress.phase] : undefined;
  if (label && progress.phaseTotal) {
    return `${label} ${progress.phaseDone ?? 0}/${progress.phaseTotal} · 已恢复 ${progress.recovered} 条`;
  }
  return `已查询 ${progress.done}/${progress.total} 条，成功找回 ${progress.recovered} 条`;
};

export const Favorites = () => {
  const [folders, setFolders] = useState<FavoriteFolder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<number | null>(null);
  const [resources, setResources] = useState<FavoriteResource[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [keyword, setKeyword] = useState("");
  const [searchType, setSearchType] = useState<"all" | "title" | "up" | "bvid" | "avid">("all");
  const [isSearchKindDropdownOpen, setIsSearchKindDropdownOpen] = useState(false);
  const [syncTargetFolder, setSyncTargetFolder] = useState<FavoriteFolder | null>(null);
  const [isAllFoldersSyncOpen, setIsAllFoldersSyncOpen] = useState(false);
  const [clearTargetFolder, setClearTargetFolder] = useState<FavoriteFolder | null>(null);
  const [isClearingFolder, setIsClearingFolder] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  /** 悬停失效卡片封面时展示的详情浮层 */
  const [hoverResource, setHoverResource] = useState<{
    resource: FavoriteResource;
    rect: DOMRect;
  } | null>(null);
  /**
   * 当前是否只是"附加"到后台已有的恢复任务上（而不是本页发起的）。
   * 附加模式没有 sendMessage 的返回值可等，只能靠进度里的 status 收尾。
   */
  const recoveryAttachedRef = useRef(false);
  /** 本页发起恢复的时间点：用来忽略上一轮遗留的旧进度，避免刚点就被判"已完成" */
  const recoveryStartRef = useRef(0);
  /** 恢复进度。后台每处理完一批就写一次 storage，页面轮询显示，避免长时间无反馈 */
  const [recoveryProgress, setRecoveryProgress] = useState<{
    done: number;
    total: number;
    recovered: number;
    /** 当前阶段 + 阶段内进度（biliplus / 公开接口 / jijidown / 归档封面） */
    phase?: string;
    phaseDone?: number;
    phaseTotal?: number;
  } | null>(null);

  // 打开页面时如果后台已有恢复任务在跑，自动附加上去（否则用户会看到一个
  // "恢复任务正在进行中"的错误提示，却没有任何进度）。
  // 先问后台任务是否真实存在：storage 里的 running 可能是上一轮留下的僵尸记录。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const stored = await getStorageValue<{
        status?: string;
        total?: number;
        startedAt?: number;
        updatedAt?: number;
      } | null>(FAV_RECOVERY_PROGRESS, null);
      if (cancelled || !stored || stored.status !== "running" || !stored.total) return;

      let actuallyRunning = false;
      try {
        const state = await browser.runtime.sendMessage({ action: "getRecoveryTaskState" });
        actuallyRunning = Boolean(state?.running);
      } catch {
        actuallyRunning = false;
      }
      if (cancelled) return;

      if (actuallyRunning) {
        recoveryAttachedRef.current = true;
        setIsRecovering(true);
        return;
      }

      // 僵尸进度：任务已经不存在了，直接收尾，别让用户永远看到一个不会动的进度条
      await setStorageValue(FAV_RECOVERY_PROGRESS, {
        ...stored,
        status: "completed",
        updatedAt: Date.now(),
      }).catch(() => undefined);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // 恢复期间轮询进度。500ms 足够顺滑，也只读一个 storage 键，不会给后台压力
  useEffect(() => {
    if (!isRecovering) {
      setRecoveryProgress(null);
      return;
    }
    let active = true;
    const tick = async () => {
      const stored = await getStorageValue<{
        status?: string;
        done: number;
        total: number;
        recovered: number;
        startedAt?: number;
        updatedAt?: number;
        phase?: string;
        phaseDone?: number;
        phaseTotal?: number;
      } | null>(FAV_RECOVERY_PROGRESS, null);
      if (!active || !stored) return;
      // 本页刚发起的任务：忽略上一轮遗留的旧进度，否则点击瞬间就会被判"已完成"，
      // 进度条一闪而过（用户看到的就是"点击没反应、刷新才有"）。
      if (
        recoveryStartRef.current > 0 &&
        typeof stored.startedAt === "number" &&
        stored.startedAt < recoveryStartRef.current - 1000
      ) {
        return;
      }
      if (stored.status === "running") {
        if (!stored.total) return;
        setRecoveryProgress({
          done: stored.done ?? 0,
          total: stored.total ?? 0,
          recovered: stored.recovered ?? 0,
          phase: typeof stored.phase === "string" ? stored.phase : undefined,
          phaseDone: typeof stored.phaseDone === "number" ? stored.phaseDone : undefined,
          phaseTotal: typeof stored.phaseTotal === "number" ? stored.phaseTotal : undefined,
        });
        return;
      }
      // 任务已结束：附加模式下没有 sendMessage 返回可等，靠这里收尾
      active = false;
      const attached = recoveryAttachedRef.current;
      recoveryAttachedRef.current = false;
      setIsRecovering(false);
      setRecoveryProgress(null);
      if (attached) {
        toast.success("失效内容恢复已完成");
        if (selectedFolderId) {
          void loadResources(selectedFolderId, { resetSearch: false });
        }
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [isRecovering, selectedFolderId]);
  const [recoveryResult, setRecoveryResult] = useState<{
    attempted: number;
    recovered: number;
    remaining: number;
  } | null>(null);
  const [openFolderMenuId, setOpenFolderMenuId] = useState<number | null>(null);
  const [deleteTargetFolder, setDeleteTargetFolder] = useState<FavoriteFolder | null>(null);
  const [isDeletingFolder, setIsDeletingFolder] = useState(false);
  const [syncProgress, setSyncProgress] = useState<FavoriteFolderSyncProgress | null>(null);
  const [allSyncProgress, setAllSyncProgress] = useState<AllFavoriteFoldersSyncProgress | null>(
    null,
  );
  const pageSize = 50;

  const contentRef = useRef<HTMLDivElement>(null);
  const hasRefreshedFolderDirectoryRef = useRef(false);

  useEffect(() => {
    if (hasRefreshedFolderDirectoryRef.current) return;
    hasRefreshedFolderDirectoryRef.current = true;

    const initializeFolders = async () => {
      // 先展示本地目录，再从网络刷新，网络失败时仍可使用 IndexedDB 中的数据。
      await loadFolders();

      try {
        const syncState = await browser.storage.local.get([
          FAVORITE_FOLDER_SYNC_PROGRESS,
          ALL_FAVORITE_FOLDERS_SYNC_PROGRESS,
        ]);
        const singleProgress = syncState[
          FAVORITE_FOLDER_SYNC_PROGRESS
        ] as FavoriteFolderSyncProgress | null;
        const allProgress = syncState[
          ALL_FAVORITE_FOLDERS_SYNC_PROGRESS
        ] as AllFavoriteFoldersSyncProgress | null;
        const shouldSkipOnlineRefresh = [singleProgress, allProgress].some(
          (progress) =>
            progress?.status === "syncing" ||
            progress?.status === "paused" ||
            progress?.status === "interrupted",
        );
        if (shouldSkipOnlineRefresh) return;

        const request: RefreshFavoriteFoldersRequest = {
          action: "refreshFavoriteFolders",
        };
        const response = (await browser.runtime.sendMessage(request)) as
          RefreshFavoriteFoldersResponse | undefined;

        if (!response) throw new Error("未收到收藏夹目录刷新响应");
        if (!response.success) throw new Error(response.error || "刷新收藏夹目录失败");

        await loadFolders();
      } catch (error) {
        console.error("从网络刷新收藏夹目录失败，继续使用本地数据", error);
      }
    };

    void initializeFolders();
  }, []);

  useEffect(() => {
    if (folders.length === 0) {
      if (selectedFolderId !== null) {
        setSelectedFolderId(null);
        setResources([]);
      }
      return;
    }

    if (selectedFolderId === null || !folders.some((folder) => folder.id === selectedFolderId)) {
      // Default select first folder
      setSelectedFolderId(folders[0].id);
    }
  }, [folders, selectedFolderId]);

  useEffect(() => {
    if (selectedFolderId !== null) {
      void loadResources(selectedFolderId);
    }
  }, [selectedFolderId]);

  useEffect(() => {
    if (openFolderMenuId === null) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenFolderMenuId(null);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [openFolderMenuId]);

  useEffect(() => {
    const loadProgress = async () => {
      try {
        const [data, nextAllProgress] = await Promise.all([
          browser.storage.local.get(FAVORITE_FOLDER_SYNC_PROGRESS),
          browser.runtime.sendMessage({
            action: "getAllFavoriteFoldersSyncProgress",
          }) as Promise<AllFavoriteFoldersSyncProgress | null>,
        ]);
        if (data[FAVORITE_FOLDER_SYNC_PROGRESS]) {
          setSyncProgress(data[FAVORITE_FOLDER_SYNC_PROGRESS] as FavoriteFolderSyncProgress);
        }
        setAllSyncProgress(nextAllProgress);
      } catch (error) {
        console.error("读取收藏夹同步进度失败:", error);
      }
    };
    void loadProgress();

    const listener = (changes: any) => {
      if (changes[FAVORITE_FOLDER_SYNC_PROGRESS]) {
        const newProg = changes[FAVORITE_FOLDER_SYNC_PROGRESS]
          .newValue as FavoriteFolderSyncProgress | null;
        setSyncProgress(newProg);
        if (newProg && (newProg.status === "success" || newProg.status === "error")) {
          if (selectedFolderId !== null) {
            void loadResources(selectedFolderId, { resetSearch: false, showLoading: false });
          }
          void loadFolders();
        }
      }
      if (changes[ALL_FAVORITE_FOLDERS_SYNC_PROGRESS]) {
        const newProg = changes[ALL_FAVORITE_FOLDERS_SYNC_PROGRESS]
          .newValue as AllFavoriteFoldersSyncProgress | null;
        setAllSyncProgress(newProg);
        if (newProg && (newProg.status === "success" || newProg.status === "error")) {
          void loadFolders();
          if (selectedFolderId !== null) {
            void loadResources(selectedFolderId, { resetSearch: false, showLoading: false });
          }
        }
      }
    };
    browser.storage.local.onChanged.addListener(listener);
    return () => {
      browser.storage.local.onChanged.removeListener(listener);
    };
  }, [selectedFolderId]);

  const loadFolders = async () => {
    try {
      const list = await getFavFolders();
      // Sort by index
      const sortedList = list.sort((a, b) => (a.index || 0) - (b.index || 0));
      setFolders(sortedList);
      return true;
    } catch (error) {
      console.error("加载收藏夹失败", error);
      return false;
    }
  };

  const loadResources = async (
    folderId: number,
    {
      resetSearch = true,
      showLoading = true,
    }: { resetSearch?: boolean; showLoading?: boolean } = {},
  ) => {
    if (showLoading) setLoading(true);
    try {
      const list = await getFavResources(folderId);
      // Sort by index
      const sortedList = list.sort((a, b) => (a.index || 0) - (b.index || 0));
      setResources(sortedList);
      setCurrentPage(1);
      if (resetSearch) setKeyword("");
      return true;
    } catch (error) {
      console.error("加载收藏资源失败", error);
      return false;
    } finally {
      if (showLoading) setLoading(false);
    }
  };

  /**
   * 失效内容的第三方恢复。
   *
   * 能力边界（Phase 4 实测）：biliplus 持有部分独立档案，能救回「UP 主自己删除」
   * 那一类（B站 返回 62002），但对 B站 彻底删除的（-404）同样没有数据。
   * 所以恢复数量可能是 0，那是数据源的限制而不是故障。
   */
  const handleRecoverInvalid = async () => {
    // 记录发起时间：轮询据此忽略上一轮遗留的旧进度
    recoveryStartRef.current = Date.now();
    recoveryAttachedRef.current = false;
    setIsRecovering(true);
    try {
      const response = await browser.runtime.sendMessage({ action: "recoverInvalidFavorites" });
      if (!response?.success) {
        throw new Error(response?.error || "恢复失效内容失败");
      }
      setRecoveryResult({
        attempted: response.attempted ?? 0,
        recovered: response.recovered ?? 0,
        remaining: response.remaining ?? 0,
      });
      if (response.attempted === 0) {
        toast("没有需要恢复的条目：失效内容都已有本地数据");
      } else if (response.recovered === 0) {
        toast(
          `查询 ${response.attempted} 条，第三方档案中都没有记录（数据源限制，非故障）`,
        );
      } else {
        toast.success(response.message ?? `已恢复 ${response.recovered} 条`);
      }
      if (selectedFolderId) {
        await loadResources(selectedFolderId, { resetSearch: false });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "恢复失效内容失败";
      // 后台已经有一个恢复任务在跑（例如页面刷新/重开过）：不要报错，
      // 把本页附加到那个任务的进度上；但如果后台根本没有任务，就清理僵尸进度。
      if (message.includes("正在进行中")) {
        const stored = await getStorageValue<{ status?: string; total?: number } | null>(
          FAV_RECOVERY_PROGRESS,
          null,
        );
        let actuallyRunning = false;
        try {
          const state = await browser.runtime.sendMessage({ action: "getRecoveryTaskState" });
          actuallyRunning = Boolean(state?.running);
        } catch {
          actuallyRunning = false;
        }
        if (actuallyRunning && stored?.status === "running" && stored.total) {
          recoveryStartRef.current = 0;
          recoveryAttachedRef.current = true;
          setIsRecovering(true);
          toast("恢复任务已在后台进行，已显示进度");
          return;
        }
        // 僵尸进度（任务只剩 storage 里一条 running 记录）：直接收尾
        await setStorageValue(FAV_RECOVERY_PROGRESS, {
          ...(stored ?? {}),
          status: "completed",
          updatedAt: Date.now(),
        }).catch(() => undefined);
        toast("上次恢复已中断，进度已重置，可重新点击恢复");
        return;
      }
      toast.error(message);
    } finally {
      // 附加模式不能在这里关掉进度：任务还在后台跑，进度靠轮询收尾
      if (!recoveryAttachedRef.current) {
        recoveryStartRef.current = 0;
        setIsRecovering(false);
      }
    }
  };

  /** 复制单条收藏的完整信息，便于外部留存与检索 */
  const handleCopyResource = async (resource: Parameters<typeof buildResourceCopyText>[0]) => {
    try {
      await navigator.clipboard.writeText(buildResourceCopyText(resource));
      toast.success("已复制这条收藏的完整信息");
    } catch (error) {
      console.error("复制失败:", error);
      toast.error("复制失败，请检查剪贴板权限");
    }
  };

  /** 当前收藏夹的失效与待恢复统计。纯本地计算，不发请求 */
  const recoveryStats = useMemo(() => buildRecoveryStats(resources), [resources]);

  const handleFolderSyncSuccess = async (folderId: number) => {
    const foldersRefreshed = await loadFolders();
    const resourcesRefreshed =
      selectedFolderId === folderId ? await loadResources(folderId, { resetSearch: false }) : true;

    if (!foldersRefreshed || !resourcesRefreshed) {
      throw new Error("收藏夹页面刷新失败");
    }
  };

  const handleAllFoldersSyncComplete = async () => {
    const foldersRefreshed = await loadFolders();
    const resourcesRefreshed =
      selectedFolderId !== null
        ? await loadResources(selectedFolderId, { resetSearch: false })
        : true;

    if (!foldersRefreshed || !resourcesRefreshed) {
      throw new Error("收藏夹页面刷新失败");
    }
  };

  const handleClearFavoriteFolder = async () => {
    if (!clearTargetFolder || isClearingFolder) return;

    setIsClearingFolder(true);
    try {
      const progressData = await browser.storage.local.get([
        FAVORITE_FOLDER_SYNC_PROGRESS,
        ALL_FAVORITE_FOLDERS_SYNC_PROGRESS,
      ]);
      const singleProgress = progressData[
        FAVORITE_FOLDER_SYNC_PROGRESS
      ] as FavoriteFolderSyncProgress | null;
      const allProgress = progressData[
        ALL_FAVORITE_FOLDERS_SYNC_PROGRESS
      ] as AllFavoriteFoldersSyncProgress | null;

      if (singleProgress?.status === "syncing" || allProgress?.status === "syncing") {
        throw new Error("收藏夹正在同步，请等待同步结束后再清空");
      }

      const progressKeysToRemove: string[] = [];
      if (
        singleProgress?.folderId === clearTargetFolder.id &&
        singleProgress.status !== "success"
      ) {
        progressKeysToRemove.push(FAVORITE_FOLDER_SYNC_PROGRESS);
      }
      if (
        allProgress?.status !== "success" &&
        allProgress?.folderIds?.includes(clearTargetFolder.id)
      ) {
        progressKeysToRemove.push(ALL_FAVORITE_FOLDERS_SYNC_PROGRESS);
      }
      if (progressKeysToRemove.length > 0) {
        await browser.storage.local.remove(progressKeysToRemove);
      }

      const deletedCount = await clearFavResourcesByFolder(clearTargetFolder.id);
      if (selectedFolderId === clearTargetFolder.id) {
        setResources([]);
        setKeyword("");
        setCurrentPage(1);
        setIsSearchKindDropdownOpen(false);
      }

      toast.success(
        `已清空「${clearTargetFolder.title}」的 ${deletedCount} 条本地收藏，不影响 B 站线上数据`,
      );
      setClearTargetFolder(null);
    } catch (error) {
      console.error("清空收藏夹本地数据失败:", error);
      toast.error(error instanceof Error ? error.message : "清空本地收藏失败，请重试");
    } finally {
      setIsClearingFolder(false);
    }
  };

  const handleDeleteFavoriteFolder = async () => {
    if (!deleteTargetFolder || isDeletingFolder) return;

    setIsDeletingFolder(true);
    try {
      const progressData = await browser.storage.local.get([
        FAVORITE_FOLDER_SYNC_PROGRESS,
        ALL_FAVORITE_FOLDERS_SYNC_PROGRESS,
      ]);
      const singleProgress = progressData[
        FAVORITE_FOLDER_SYNC_PROGRESS
      ] as FavoriteFolderSyncProgress | null;
      const allProgress = progressData[
        ALL_FAVORITE_FOLDERS_SYNC_PROGRESS
      ] as AllFavoriteFoldersSyncProgress | null;

      if (singleProgress?.status === "syncing" || allProgress?.status === "syncing") {
        throw new Error("收藏夹正在同步，请等待同步结束后再删除");
      }

      const progressKeysToRemove: string[] = [];
      if (singleProgress?.folderId === deleteTargetFolder.id) {
        progressKeysToRemove.push(FAVORITE_FOLDER_SYNC_PROGRESS);
      }
      if (allProgress?.folderIds?.includes(deleteTargetFolder.id)) {
        progressKeysToRemove.push(ALL_FAVORITE_FOLDERS_SYNC_PROGRESS);
      }
      if (progressKeysToRemove.length > 0) {
        await browser.storage.local.remove(progressKeysToRemove);
      }

      const deletedFolder = deleteTargetFolder;
      const deletedFolderIndex = folders.findIndex((folder) => folder.id === deletedFolder.id);
      const deletedResourceCount = await deleteFavFolderWithResources(deletedFolder.id);
      const remainingFolders = folders.filter((folder) => folder.id !== deletedFolder.id);
      setFolders(remainingFolders);

      if (selectedFolderId === deletedFolder.id) {
        const nextFolder =
          remainingFolders[Math.min(deletedFolderIndex, remainingFolders.length - 1)] ?? null;
        setSelectedFolderId(nextFolder?.id ?? null);
        setResources([]);
        setKeyword("");
        setCurrentPage(1);
        setIsSearchKindDropdownOpen(false);
      }

      toast.success(
        `已删除本地收藏夹「${deletedFolder.title}」及 ${deletedResourceCount} 条收藏，不影响 B 站线上数据`,
      );
      setDeleteTargetFolder(null);
    } catch (error) {
      console.error("删除本地收藏夹失败:", error);
      toast.error(error instanceof Error ? error.message : "删除本地收藏夹失败，请重试");
    } finally {
      setIsDeletingFolder(false);
    }
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    // Scroll to top of content
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  };

  const filteredResources = resources.filter((item) => {
    if (!keyword) return true;
    const lowerKeyword = keyword.toLowerCase();

    switch (searchType) {
      case "title":
        return item.title.toLowerCase().includes(lowerKeyword);
      case "up":
        return item.upper?.name.toLowerCase().includes(lowerKeyword);
      case "bvid":
        return item.bvid && item.bvid.toLowerCase().includes(lowerKeyword);
      case "avid":
        return item.id && String(item.id).includes(lowerKeyword);
      case "all":
      default:
        return (
          item.title.toLowerCase().includes(lowerKeyword) ||
          item.upper?.name.toLowerCase().includes(lowerKeyword) ||
          (item.bvid && item.bvid.toLowerCase().includes(lowerKeyword)) ||
          (item.id && String(item.id).includes(lowerKeyword))
        );
    }
  });

  const startIndex = (currentPage - 1) * pageSize;
  const currentResources = filteredResources.slice(startIndex, startIndex + pageSize);
  const selectedFolder = folders.find((folder) => folder.id === selectedFolderId) ?? null;
  const isFavoriteSyncing =
    syncProgress?.status === "syncing" || allSyncProgress?.status === "syncing";

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-[#0a0a0a]">
      {/* 左侧收藏夹列表 */}
      <div className="w-64 bg-white dark:bg-neutral-900 border-r border-gray-200 dark:border-neutral-800 overflow-y-auto flex-shrink-0">
        <div className="flex items-center justify-between gap-2 border-b border-gray-200 p-4 dark:border-neutral-800">
          <h2 className="flex min-w-0 items-center gap-2 text-lg font-bold">
            <Folder className="h-5 w-5 shrink-0" />
            <span className="truncate">收藏夹</span>
          </h2>
          <button
            type="button"
            onClick={() => setIsAllFoldersSyncOpen(true)}
            disabled={folders.length === 0}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-pink-200 bg-white/80 px-2 py-1 text-xs font-medium text-pink-600 shadow-sm transition-colors hover:border-pink-300 hover:bg-pink-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-pink-500/30 dark:bg-neutral-900/80 dark:text-pink-400 dark:hover:border-pink-500/50 dark:hover:bg-pink-500/20"
            title="同步所有收藏夹"
            aria-label="同步所有收藏夹"
          >
            <CloudDownload className="h-3.5 w-3.5" />
            <span>同步所有</span>
          </button>
        </div>

        {allSyncProgress && allSyncProgress.status === "syncing" && (
          <div
            role="status"
            className="m-2 rounded-lg border border-pink-200 bg-pink-50 p-3 text-pink-700 dark:border-pink-500/20 dark:bg-pink-500/10 dark:text-pink-300"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin text-pink-600 dark:text-pink-400" />
                <p className="text-xs font-semibold truncate">
                  {allSyncProgress.currentFolderTitle
                    ? `正在同步「${allSyncProgress.currentFolderTitle}」`
                    : "正在准备..."}
                </p>
              </div>
              <span className="text-[10px] font-medium opacity-80 shrink-0">
                {allSyncProgress.completedCount}/{allSyncProgress.totalFolders}
              </span>
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-pink-100 dark:bg-pink-950/60">
              <div
                className="h-full rounded-full bg-pink-600 transition-[width] duration-300 dark:bg-pink-400"
                style={{
                  width: allSyncProgress.totalFolders
                    ? `${Math.max(4, Math.floor((allSyncProgress.completedCount / allSyncProgress.totalFolders) * 100))}%`
                    : "4%",
                }}
              />
            </div>
          </div>
        )}

        {allSyncProgress &&
          (allSyncProgress.status === "paused" || allSyncProgress.status === "interrupted") && (
            <button
              type="button"
              onClick={() => setIsAllFoldersSyncOpen(true)}
              className="m-2 block w-[calc(100%-1rem)] rounded-lg border border-amber-200 bg-amber-50 p-3 text-left text-amber-800 transition-colors hover:bg-amber-100 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300 dark:hover:bg-amber-500/20"
            >
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-xs font-semibold">
                  {allSyncProgress.status === "paused" ? "全部同步已暂停" : "全部同步已中断"}
                </p>
                <span className="shrink-0 text-[10px] font-medium opacity-80">
                  {allSyncProgress.completedCount}/{allSyncProgress.totalFolders}
                </span>
              </div>
              <p className="mt-1.5 truncate text-[11px] opacity-80">
                {allSyncProgress.currentFolderTitle
                  ? `「${allSyncProgress.currentFolderTitle}」将从第 ${allSyncProgress.nextPage} 页继续`
                  : "点击查看同步进度"}
              </p>
            </button>
          )}

        {allSyncProgress?.status !== "syncing" &&
          syncProgress &&
          syncProgress.status === "syncing" && (
            <div
              role="status"
              className="m-2 rounded-lg border border-pink-200 bg-pink-50 p-3 text-pink-700 dark:border-pink-500/20 dark:bg-pink-500/10 dark:text-pink-300"
            >
              <div className="flex items-center gap-2">
                <RefreshCw className="h-3.5 w-3.5 shrink-0 animate-spin text-pink-600 dark:text-pink-400" />
                <p className="text-xs font-semibold truncate">同步「{syncProgress.folderTitle}」</p>
              </div>
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-pink-100 dark:bg-pink-950/60">
                <div
                  className={`h-full rounded-full bg-pink-600 transition-[width] duration-300 dark:bg-pink-400 ${
                    syncProgress.mode !== "full" ? "animate-pulse" : ""
                  }`}
                  style={{
                    width: syncProgress.totalItems
                      ? `${Math.max(4, Math.floor((syncProgress.processedItems / syncProgress.totalItems) * 100))}%`
                      : "4%",
                  }}
                />
              </div>
              <p className="mt-1.5 text-[11px] text-pink-600 dark:text-pink-300 truncate">
                {syncProgress.currentPage
                  ? syncProgress.totalItems > 0
                    ? `${syncProgress.processedItems}/${syncProgress.totalItems} (${Math.floor((syncProgress.processedItems / syncProgress.totalItems) * 100)}%) 第${syncProgress.currentPage}页`
                    : `已检查 ${syncProgress.processedItems} 条，第${syncProgress.currentPage}页`
                  : "正在获取合集信息..."}
              </p>
            </div>
          )}

        <div className="p-2">
          {folders.map((folder) => (
            <div
              key={folder.id}
              className={`relative mb-1 cursor-pointer rounded-lg p-3 pr-10 transition-colors ${
                selectedFolderId === folder.id
                  ? "bg-pink-50 dark:bg-pink-500/10 text-pink-600 dark:text-pink-400"
                  : "hover:bg-gray-100 dark:hover:bg-neutral-800"
              }`}
              onClick={() => setSelectedFolderId(folder.id)}
            >
              <div className="min-w-0">
                <div className="truncate font-medium" title={folder.title}>
                  {folder.title}
                </div>
                <div className="mt-1 text-xs text-gray-400 dark:text-neutral-500">
                  {folder.media_count}个内容
                </div>
              </div>

              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setOpenFolderMenuId((current) => (current === folder.id ? null : folder.id));
                }}
                className="absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-white hover:text-gray-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                title={`更多操作：${folder.title}`}
                aria-label={`更多操作：${folder.title}`}
                aria-haspopup="menu"
                aria-expanded={openFolderMenuId === folder.id}
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>

              {openFolderMenuId === folder.id && (
                <>
                  <button
                    type="button"
                    className="fixed inset-0 z-10 cursor-default"
                    onClick={(event) => {
                      event.stopPropagation();
                      setOpenFolderMenuId(null);
                    }}
                    aria-label="关闭收藏夹操作菜单"
                  />
                  <div
                    role="menu"
                    className="absolute right-2 top-10 z-20 min-w-28 overflow-hidden rounded-lg border border-gray-100 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <button
                      type="button"
                      role="menuitem"
                      disabled={isFavoriteSyncing}
                      onClick={() => {
                        setOpenFolderMenuId(null);
                        setSyncTargetFolder(folder);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40 dark:text-neutral-200 dark:hover:bg-neutral-800"
                    >
                      <CloudDownload className="h-4 w-4 text-pink-500" />
                      同步
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={isFavoriteSyncing}
                      onClick={() => {
                        setOpenFolderMenuId(null);
                        setDeleteTargetFolder(folder);
                      }}
                      className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:text-red-400 dark:hover:bg-red-500/10"
                    >
                      <Trash2 className="h-4 w-4" />
                      删除
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* 右侧内容列表 */}
      <div className="flex-1 overflow-y-auto" ref={contentRef}>
        <div className="p-6">
          {selectedFolderId && (
            <div className="mb-6 flex flex-col md:flex-row justify-between md:items-center gap-4 bg-white dark:bg-neutral-900 p-4 rounded-xl shadow-sm border border-gray-100 dark:border-neutral-800">
              <div className="flex flex-wrap items-center gap-3">
                <h1 className="flex items-center gap-2 text-xl font-bold">
                  {selectedFolder?.title}
                  <span className="whitespace-nowrap rounded-full border border-gray-100 bg-gray-50 px-2 py-1 text-sm font-normal text-gray-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400">
                    {filteredResources.length} 个内容
                  </span>
                  {selectedFolder && selectedFolder.media_count > resources.length ? (
                    <span
                      className="whitespace-nowrap rounded-full bg-amber-50 px-2 py-1 text-[11px] font-normal text-amber-600 dark:bg-amber-500/10 dark:text-amber-400"
                      title={`在线收藏夹共 ${selectedFolder.media_count} 条，本地已有 ${resources.length} 条；执行一次全量同步会尝试补全被隐藏/漏掉的条目`}
                    >
                      在线 {selectedFolder.media_count} 条
                    </span>
                  ) : null}
                </h1>
                <button
                  type="button"
                  onClick={() => setClearTargetFolder(selectedFolder)}
                  disabled={
                    !selectedFolder ||
                    resources.length === 0 ||
                    loading ||
                    isClearingFolder ||
                    isFavoriteSyncing
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:border-red-300 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-red-500/30 dark:bg-neutral-900 dark:text-red-400 dark:hover:border-red-500/50 dark:hover:bg-red-500/10"
                  title={isFavoriteSyncing ? "收藏夹同步期间不能清空" : "清空当前收藏夹的本地数据"}
                >
                  <Trash2 className="h-4 w-4" />
                  清空
                </button>

                <button
                  type="button"
                  onClick={handleRecoverInvalid}
                  disabled={!selectedFolder || loading || isRecovering || isFavoriteSyncing}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    recoveryStats.pending > 0
                      ? "border-transparent bg-[#fb7299] text-white hover:bg-[#e4638a] dark:border-transparent"
                      : "border-pink-200 bg-white text-pink-600 hover:border-pink-300 hover:bg-pink-50 dark:border-pink-500/30 dark:bg-neutral-900 dark:text-pink-400 dark:hover:border-pink-500/50 dark:hover:bg-pink-500/10"
                  }`}
                  title="用第三方档案（biliplus / jijidown）与本地分P标题尝试找回已失效内容的标题与封面。恢复结果会直接覆盖到本页。需要手动点击，不会自动运行"
                >
                  <Wand2 className={`h-4 w-4 ${isRecovering ? "animate-pulse" : ""}`} />
                  {isRecovering
                    ? recoveryProgress
                      ? `恢复中 ${recoveryPercent(recoveryProgress)}%`
                      : "恢复中…"
                    : "恢复失效内容"}
                </button>

                {/* 恢复是长耗时操作（分批请求第三方档案），必须给出可见进度，
                    否则用户只看到按钮文字变了，分不清是卡死还是慢 */}
                {isRecovering ? (
                  <div className="mt-2 w-full">
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-neutral-700">
                      <div
                        className="h-full rounded-full bg-[#fb7299] transition-[width] duration-300"
                        style={{ width: `${recoveryPercent(recoveryProgress)}%` }}
                      />
                    </div>
                    <p className="mt-1 text-xs text-gray-400 dark:text-neutral-500">
                      {recoveryProgressText(recoveryProgress)}
                    </p>
                  </div>
                ) : null}

                {/* 本地即可算出的诊断数字，无需开控制台就能判断有没有可恢复的内容 */}
                <span className="text-xs text-gray-400 dark:text-neutral-500">
                  已失效 {recoveryStats.invalid} 条
                  {recoveryStats.invalid > 0 ? (
                    <>
                      {" · "}已有本地数据 {recoveryStats.intact} 条
                      {" · "}
                      <span
                        className={
                          recoveryStats.pending > 0
                            ? "font-medium text-pink-500 dark:text-pink-400"
                            : ""
                        }
                      >
                        待恢复 {recoveryStats.pending} 条
                      </span>
                    </>
                  ) : null}
                  {recoveryResult ? ` · 上轮查询 ${recoveryResult.attempted}、恢复 ${recoveryResult.recovered}` : ""}
                  {recoveryStats.pending > 0 && !isRecovering && !recoveryResult ? (
                    <span className="ml-1 font-medium text-[#fb7299]">
                      ← 点左侧按钮开始恢复（不会自动运行）
                    </span>
                  ) : null}
                </span>
              </div>

              <div className="relative w-full md:max-w-xl group flex items-center bg-gray-50 dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-full transition-all duration-300 shadow-sm hover:shadow-md focus-within:bg-white dark:focus-within:bg-neutral-800 focus-within:ring-2 focus-within:ring-blue-100 dark:focus-within:ring-blue-500/20 focus-within:border-blue-400 dark:focus-within:border-blue-500">
                {/* 搜索类型下拉 */}
                <div className="relative">
                  <button
                    className="pl-4 pr-3 py-2 text-sm text-gray-600 dark:text-neutral-300 font-medium cursor-pointer border-r border-gray-200 dark:border-neutral-700 hover:text-blue-600 dark:hover:text-blue-400 flex items-center gap-1 transition-colors whitespace-nowrap"
                    onClick={() => setIsSearchKindDropdownOpen(!isSearchKindDropdownOpen)}
                  >
                    <span>
                      {searchType === "all" && "综合"}
                      {searchType === "title" && "标题"}
                      {searchType === "up" && "UP主"}
                      {searchType === "bvid" && "BV号"}
                      {searchType === "avid" && "AV号"}
                    </span>
                    <ChevronDownIcon className="w-3 h-3 text-gray-400 dark:text-neutral-500" />
                  </button>

                  {isSearchKindDropdownOpen && (
                    <>
                      <div
                        className="fixed inset-0 z-10"
                        onClick={() => setIsSearchKindDropdownOpen(false)}
                      ></div>
                      <div className="absolute top-full left-0 mt-2 w-28 bg-white dark:bg-neutral-900 rounded-lg shadow-lg border border-gray-100 dark:border-neutral-800 py-1 z-20 animate-in fade-in zoom-in-95 duration-200 overflow-hidden">
                        {[
                          { value: "all", label: "综合搜索" },
                          { value: "title", label: "视频标题" },
                          { value: "up", label: "UP主" },
                          { value: "bvid", label: "视频BV号" },
                          { value: "avid", label: "视频AV号" },
                        ].map((option) => (
                          <button
                            key={option.value}
                            className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                              searchType === option.value
                                ? "bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium"
                                : "text-gray-600 dark:text-neutral-300 hover:bg-gray-50 dark:hover:bg-neutral-800"
                            }`}
                            onClick={() => {
                              setSearchType(option.value as any);
                              setIsSearchKindDropdownOpen(false);
                            }}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>

                <input
                  type="text"
                  className="flex-1 bg-transparent border-none focus:ring-0 pl-4 pr-10 py-2 text-sm text-gray-700 dark:text-neutral-100 placeholder-gray-400 dark:placeholder-neutral-500 focus:outline-none"
                  placeholder={
                    searchType === "bvid"
                      ? "输入BV号..."
                      : searchType === "avid"
                        ? "输入AV号..."
                        : searchType === "up"
                          ? "输入UP主名称..."
                          : "搜索..."
                  }
                  value={keyword}
                  onChange={(e) => {
                    setKeyword(e.target.value);
                    setCurrentPage(1);
                  }}
                />
                {keyword ? (
                  <button
                    onClick={() => {
                      setKeyword("");
                      setCurrentPage(1);
                    }}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 dark:text-neutral-500 hover:text-gray-600 dark:hover:text-neutral-300 transition-colors"
                  >
                    <X className="h-4 w-4" />
                  </button>
                ) : (
                  <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                    <Search className="h-4 w-4 text-gray-400 dark:text-neutral-500" />
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="w-full">
            {loading ? (
              <div className="text-center py-10 text-gray-500 dark:text-neutral-400">加载中...</div>
            ) : (
              <>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-6">
                  {currentResources.map((item) => {
                    const state = resolveFavResourceState(item);
                    const invalidated = state !== "normal";
                    return (
                      <div
                        key={item.id}
                        className="border border-gray-200 dark:border-neutral-800 rounded-lg overflow-hidden flex flex-col bg-white dark:bg-neutral-900 hover:shadow-md transition-shadow"
                      >
                        <a
                          href={`https://www.bilibili.com/video/${item.bvid}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="no-underline text-inherit flex flex-col h-full"
                        >
                          <div>
                            <div
                              className="relative w-full aspect-video"
                              onMouseEnter={(event) => {
                                if (invalidated) {
                                  setHoverResource({
                                    resource: item,
                                    rect: event.currentTarget.getBoundingClientRect(),
                                  });
                                }
                              }}
                              onMouseLeave={() => setHoverResource(null)}
                            >
                              <img
                                src={`${item.cover.replace("http:", "https:")}@760w_428h_1c.avif`}
                                alt={item.title}
                                className={`w-full h-full object-cover ${
                                  state === "broken" ? "opacity-70" : ""
                                }`}
                                loading="lazy"
                                onError={(event) => {
                                  const image = event.currentTarget;
                                  const fallback = `https://i0.hdslb.com${PLACEHOLDER_COVER_PATH}@760w_428h_1c.avif`;
                                  if (!image.src.startsWith(fallback)) image.src = fallback;
                                }}
                              />
                              {invalidated ? (
                                <span
                                  className={`absolute left-2 top-2 rounded px-1.5 py-0.5 text-xs text-white ${
                                    state === "broken" ? "bg-gray-500/90" : "bg-emerald-500/90"
                                  }`}
                                  title={resolveFavResourceHint(item)}
                                >
                                  {resolveFavResourceBadge(item)}
                                </span>
                              ) : null}
                              {/* 时长压在封面右下角。它是"基本不变"的元数据，
                                  比标题更能说明这是哪条内容——标题会被占位文案顶掉 */}
                              {formatInteractionDuration(item.duration) ? (
                                <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-xs tabular-nums text-white">
                                  {formatInteractionDuration(item.duration)}
                                </span>
                              ) : null}
                            </div>
                            <div className="p-3 flex-1 flex flex-col">
                              <div className="flex items-start justify-between gap-2">
                                <h3
                                  className={`m-0 text-sm leading-[1.4] h-10 overflow-hidden line-clamp-2 flex-1 ${
                                    state === "broken"
                                      ? "line-through text-gray-400 dark:text-neutral-500"
                                      : state === "repaired"
                                        ? "line-through text-gray-600 dark:text-neutral-300"
                                        : ""
                                  }`}
                                  title={item.title}
                                >
                                  {item.title}
                                </h3>
                              </div>
                              <div className="flex justify-between items-center text-gray-500 dark:text-neutral-400 text-xs mt-2">
                                <span
                                  onClick={(e) => {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    window.open(
                                      `https://space.bilibili.com/${item.upper?.mid}`,
                                      "_blank",
                                    );
                                  }}
                                  className="hover:text-[#fb7299] transition-colors cursor-pointer truncate mr-2"
                                >
                                  {item.upper?.name}
                                </span>
                                <span className="flex shrink-0 items-center gap-1.5">
                                  <span>
                                    {item.fav_time || item.ctime
                                      ? new Date(
                                          (item.fav_time || item.ctime) * 1000,
                                        ).toLocaleDateString()
                                      : "时间未知"}
                                  </span>
                                  <button
                                    type="button"
                                    title="复制这条收藏的完整信息"
                                    aria-label="复制这条收藏的完整信息"
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      void handleCopyResource(item);
                                    }}
                                    className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-[#fb7299] dark:text-neutral-500 dark:hover:bg-neutral-800"
                                  >
                                    <Copy className="h-3.5 w-3.5" />
                                  </button>
                                </span>
                              </div>
                            </div>
                          </div>
                        </a>
                      </div>
                    );
                  })}
                  {currentResources.length === 0 && (
                    <div className="col-span-full text-center py-10 text-gray-400 dark:text-neutral-500">
                      这个收藏夹是空的
                    </div>
                  )}
                </div>
                <div className="mt-8">
                  <Pagination
                    currentPage={currentPage}
                    totalItems={filteredResources.length}
                    pageSize={pageSize}
                    onPageChange={handlePageChange}
                  />
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      <FavoriteFolderSyncModal
        folder={syncTargetFolder}
        onClose={() => setSyncTargetFolder(null)}
        onSyncSuccess={handleFolderSyncSuccess}
      />
      <AllFavoriteFoldersSyncModal
        folders={folders}
        open={isAllFoldersSyncOpen}
        onClose={() => setIsAllFoldersSyncOpen(false)}
        onSyncComplete={handleAllFoldersSyncComplete}
      />
      <ClearFavoriteFolderModal
        folder={clearTargetFolder}
        localResourceCount={clearTargetFolder?.id === selectedFolderId ? resources.length : 0}
        isClearing={isClearingFolder}
        onClose={() => {
          if (!isClearingFolder) setClearTargetFolder(null);
        }}
        onConfirm={handleClearFavoriteFolder}
      />
      <DeleteFavoriteFolderModal
        folder={deleteTargetFolder}
        isDeleting={isDeletingFolder}
        onClose={() => {
          if (!isDeletingFolder) setDeleteTargetFolder(null);
        }}
        onConfirm={handleDeleteFavoriteFolder}
      />
      {hoverResource ? (
        <FavResourceHoverPanel
          resource={hoverResource.resource}
          anchor={hoverResource.rect}
          onClose={() => setHoverResource(null)}
        />
      ) : null}
    </div>
  );
};

export default Favorites;
