import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  CheckCircle2,
  Clock3,
  CloudDownload,
  CloudUpload,
  DatabaseBackup,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  FileJson2,
  Image as ImageIcon,
  Info,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Save,
  Server,
  ShieldCheck,
  Upload,
  X,
} from "lucide-react";
import { toast } from "react-hot-toast";
import { getStorageValue, setStorageValue } from "@/utils/storage";
import {
  WEBDAV_CONFIG,
  WEBDAV_LAST_SYNC,
  WEBDAV_AUTO_SYNC_ENABLED,
  WEBDAV_AUTO_SYNC_INTERVAL,
  LOCAL_HISTORY_BACKUP_ENABLED,
  LOCAL_HISTORY_BACKUP_LAST_SUCCESS_AT,
  LOCAL_HISTORY_BACKUP_LAST_RECORD_COUNT,
  LOCAL_HISTORY_BACKUP_LAST_ERROR,
  WEBDAV_SYNC_ITEMS,
  DEFAULT_WEBDAV_SYNC_ITEMS,
  BACKUP_LAST_EXPORT_AT,
  MANUAL_BACKUP_ITEMS,
  WebDavSyncItems,
  WebDavSyncKey,
} from "@/utils/constants";
import {
  WebDavConfig,
  testConnection,
  ensureDirectory,
  uploadFile,
  downloadFile,
  withWebDavOperationLock,
  loadWebDavConfig,
  sealWebDavConfig,
} from "@/utils/webdav";
import {
  getAllHistory,
  getAllFavFolders,
  getAllFavResources,
  getAllSubscribedCollections,
  getAllSubscribedCollectionResources,
  getAllFollowing,
  getAllFollowingEvents,
  getBackupLocalIds,
  getAllInteractions,
  getAllVanishedFavResources,
  getAllVanishArchive,
  saveHistory,
  importLikedMusic,
  importFavFolders,
  importFavResources,
  smartMergeHistory,
  smartMergeLikedMusic,
  smartMergeFavResources,
  importSubscribedCollections,
  smartMergeSubscribedCollectionResources,
  smartMergeFollowing,
  smartMergeFollowingEvents,
  smartMergeVanishedFavResources,
  smartMergeVanishArchive,
  smartMergeInteractions,
  getDeletedHistoryIds,
  getHistoryV2Backup,
  mergeHistoryV2Backup,
} from "@/utils/db";
import {
  HistoryItem,
  HistoryV2Backup,
  LikedMusic,
  FavoriteFolder,
  SubscribedCollection,
} from "@/utils/types";
import { LocalHistoryBackupPanel } from "@/components/LocalHistoryBackupPanel";
import { BackupItemsPicker } from "@/components/BackupItemsPicker";
import { buildBackupPreview, formatBackupPreview } from "@/utils/backupPreview";
import {
  buildFavoritesCsv,
  buildFavoritesMarkdown,
  buildFollowingCsv,
  buildFollowingMarkdown,
  buildInteractionsCsv,
  buildInteractionsMarkdown,
  buildVanishedCsv,
} from "@/utils/humanReadableExport";

/** Per-dataset definition: remote file name, label, local reader, and remote-merge strategy */
interface DataItemDef {
  key: WebDavSyncKey;
  label: string;
  file: string;
  getAll: () => Promise<unknown[]>;
  merge: (items: any[]) => Promise<{ merged: number; skipped: number }>;
}

const DATA_ITEMS: DataItemDef[] = [
  {
    key: "history",
    label: "历史记录",
    file: "history.json",
    getAll: getAllHistory,
    merge: smartMergeHistory,
  },
  {
    key: "favFolders",
    label: "收藏夹",
    file: "favFolders.json",
    getAll: getAllFavFolders,
    // Folders are upserted directly without timestamp comparison
    merge: async (items: FavoriteFolder[]) => {
      await importFavFolders(items);
      return { merged: items.length, skipped: 0 };
    },
  },
  {
    key: "favResources",
    label: "收藏资源",
    file: "favResources.json",
    getAll: getAllFavResources,
    merge: smartMergeFavResources,
  },
  {
    key: "subscribedCollections",
    label: "订阅合集",
    file: "subscribedCollections.json",
    getAll: getAllSubscribedCollections,
    merge: async (items: SubscribedCollection[]) => {
      await importSubscribedCollections(items);
      return { merged: items.length, skipped: 0 };
    },
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
    label: "关注的 UP 主",
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

/**
 * 备份/同步内容选择器里展示的数据项。
 *
 * `vanishedFavResources` 是旧版 store：它的数据在写入 `vanishArchive` 时已被合并，
 * 继续作为独立可选项只会让界面出现两个同名「消失档案」。所以从选择器里隐藏，
 * 但仍然保留在 `DATA_ITEMS` 中——旧备份文件的导入/合并按 JSON 字段名直接处理，
 * 不依赖这个列表，删掉会破坏对老数据的兼容。
 */
const SELECTABLE_DATA_ITEMS = DATA_ITEMS.filter(
  (item) => item.key !== "vanishedFavResources",
);

const HISTORY_V2_FILE = "history-v2.json";

const mergeRemoteHistoryFiles = async (
  config: WebDavConfig,
): Promise<{ merged: number; skipped: number }> => {
  let merged = 0;
  let skipped = 0;
  const deletedHistoryIds = await getDeletedHistoryIds();
  const legacyRemote = await downloadFile(config, "history.json");
  if (legacyRemote) {
    const result = await smartMergeHistory(JSON.parse(legacyRemote), deletedHistoryIds);
    merged += result.merged;
    skipped += result.skipped;
  }

  const v2Remote = await downloadFile(config, HISTORY_V2_FILE);
  if (v2Remote) {
    const result = await mergeHistoryV2Backup(JSON.parse(v2Remote));
    merged += result.merged;
    skipped += result.skipped;
  }
  return { merged, skipped };
};

const uploadHistoryFiles = async (
  config: WebDavConfig,
): Promise<{ contentCount: number; eventCount: number }> => {
  const history = await getAllHistory();
  const v2 = await getHistoryV2Backup();
  if (!(await uploadFile(config, HISTORY_V2_FILE, JSON.stringify(v2)))) {
    throw new Error("上传历史记录 v2 失败");
  }
  if (!(await uploadFile(config, "history.json", JSON.stringify(history)))) {
    throw new Error("上传历史记录兼容文件失败");
  }
  return { contentCount: history.length, eventCount: v2.events.length };
};

let webDavOperation: Promise<void> | null = null;

const runWebDavOperation = async (task: () => Promise<void>): Promise<void> => {
  if (webDavOperation) throw new Error("WebDAV 操作正在进行中，请稍后再试");
  const promise = task();
  webDavOperation = promise;
  try {
    await promise;
  } finally {
    if (webDavOperation === promise) webDavOperation = null;
  }
};

/** 备份/恢复进度信息 */
interface SyncProgress {
  current: number;
  total: number;
  message: string;
}

const defaultConfig: WebDavConfig = {
  serverUrl: "",
  username: "",
  password: "",
  basePath: "/bilibili-history/",
};

const WebDavSync = () => {
  // ===== WebDAV 配置状态 =====
  const [config, setConfig] = useState<WebDavConfig>(defaultConfig);
  const [showPassword, setShowPassword] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [lastSync, setLastSync] = useState<number | null>(null);

  // ===== 同步操作状态 =====
  const [isBackingUp, setIsBackingUp] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);

  // ===== 备份模式对话框 =====
  const [showBackupDialog, setShowBackupDialog] = useState(false);
  const backupDialogRef = useRef<HTMLDivElement>(null);
  const closeDialogButtonRef = useRef<HTMLButtonElement>(null);

  // ===== 同步数据项勾选（持久化，后台自动同步共用） =====
  const [selectedKeys, setSelectedKeys] = useState<WebDavSyncItems>(DEFAULT_WEBDAV_SYNC_ITEMS);
  const [manualBackupItems, setManualBackupItems] =
    useState<WebDavSyncItems>(DEFAULT_WEBDAV_SYNC_ITEMS);

  const getSelectedItems = () => {
    const items = DATA_ITEMS.filter((d) => selectedKeys[d.key]);
    if (items.length === 0) toast.error("请至少勾选一项要同步的数据");
    return items;
  };

  // ===== 手动导出/导入状态 =====
  const [isExporting, setIsExporting] = useState(false);
  const [isExportingHumanReadable, setIsExportingHumanReadable] = useState(false);
  const [isImporting, setIsImporting] = useState(false);

  // ===== 自动同步状态 =====
  const [autoSyncEnabled, setAutoSyncEnabled] = useState(false);
  const [autoSyncInterval, setAutoSyncInterval] = useState(30);

  // ===== 顶部「备份状态总览」用（只读展示，不参与备份逻辑） =====
  const [localBackup, setLocalBackup] = useState<{
    enabled: boolean;
    lastSuccessAt: number | null;
    recordCount: number;
    error: string;
  }>({ enabled: false, lastSuccessAt: null, recordCount: 0, error: "" });
  const [lastExportAt, setLastExportAt] = useState<number | null>(null);

  const refreshBackupStatus = useCallback(async () => {
    const [enabled, lastSuccess, recordCount, error, exportedAt] = await Promise.all([
      getStorageValue<boolean>(LOCAL_HISTORY_BACKUP_ENABLED, false),
      getStorageValue<number>(LOCAL_HISTORY_BACKUP_LAST_SUCCESS_AT, 0),
      getStorageValue<number>(LOCAL_HISTORY_BACKUP_LAST_RECORD_COUNT, 0),
      getStorageValue<string>(LOCAL_HISTORY_BACKUP_LAST_ERROR, ""),
      getStorageValue<number>(BACKUP_LAST_EXPORT_AT, 0),
    ]);
    setLocalBackup({
      enabled,
      lastSuccessAt: lastSuccess || null,
      recordCount,
      error: error || "",
    });
    setLastExportAt(exportedAt || null);
  }, []);

  // 加载已保存的配置
  useEffect(() => {
    const loadConfig = async () => {
      const saved = await loadWebDavConfig();
      if (saved) setConfig(saved);
      const syncTime = await getStorageValue<number | null>(WEBDAV_LAST_SYNC, null);
      if (syncTime) setLastSync(syncTime);

      const enabled = await getStorageValue<boolean>(WEBDAV_AUTO_SYNC_ENABLED, false);
      setAutoSyncEnabled(enabled);
      const interval = await getStorageValue<number>(WEBDAV_AUTO_SYNC_INTERVAL, 30);
      setAutoSyncInterval(interval);

      const syncItems = await getStorageValue<WebDavSyncItems>(
        WEBDAV_SYNC_ITEMS,
        DEFAULT_WEBDAV_SYNC_ITEMS,
      );
      // Merge over defaults so newly added keys get a value
      setSelectedKeys({ ...DEFAULT_WEBDAV_SYNC_ITEMS, ...syncItems });

      const savedManualItems = await getStorageValue<WebDavSyncItems>(
        MANUAL_BACKUP_ITEMS,
        DEFAULT_WEBDAV_SYNC_ITEMS,
      );
      setManualBackupItems({ ...DEFAULT_WEBDAV_SYNC_ITEMS, ...savedManualItems });
    };
    loadConfig();
    void refreshBackupStatus();
  }, [refreshBackupStatus]);

  useEffect(() => {
    const listener = (changes: Record<string, unknown>) => {
      if (
        LOCAL_HISTORY_BACKUP_LAST_SUCCESS_AT in changes ||
        LOCAL_HISTORY_BACKUP_LAST_RECORD_COUNT in changes ||
        LOCAL_HISTORY_BACKUP_LAST_ERROR in changes ||
        LOCAL_HISTORY_BACKUP_ENABLED in changes ||
        BACKUP_LAST_EXPORT_AT in changes ||
        WEBDAV_LAST_SYNC in changes
      ) {
        void refreshBackupStatus();
      }
    };
    browser.storage.local.onChanged.addListener(listener);
    return () => browser.storage.local.onChanged.removeListener(listener);
  }, [refreshBackupStatus]);

  // ===== WebDAV 配置操作 =====

  const handleTestConnection = async () => {
    if (!config.serverUrl) {
      toast.error("请先填写服务器地址");
      return;
    }
    setIsTesting(true);
    try {
      const ok = await testConnection(config);
      if (ok) {
        toast.success("连接成功！");
      } else {
        toast.error("连接失败，请检查服务器地址和凭证");
      }
    } catch {
      toast.error("连接测试出错");
    } finally {
      setIsTesting(false);
    }
  };

  const handleSaveConfig = async () => {
    if (!config.serverUrl) {
      toast.error("请先填写服务器地址");
      return;
    }
    setIsSaving(true);
    try {
      await setStorageValue(WEBDAV_CONFIG, await sealWebDavConfig(config));
      toast.success("配置已保存");
    } catch {
      toast.error("保存配置失败");
    } finally {
      setIsSaving(false);
    }
  };

  // ===== WebDAV 备份 =====

  const handleBackup = async () => {
    if (!config.serverUrl) {
      toast.error("请先配置 WebDAV 服务器");
      return;
    }

    const items = getSelectedItems();
    if (items.length === 0) return;

    try {
      await runWebDavOperation(() =>
        withWebDavOperationLock(async () => {
          setIsBackingUp(true);
          setSyncProgress({ current: 0, total: items.length, message: "准备备份数据..." });
          // 确保远程目录存在
          if (!(await ensureDirectory(config))) throw new Error("WebDAV 备份目录创建失败");

          const summary: string[] = [];
          for (const [i, item] of items.entries()) {
            setSyncProgress({
              current: i,
              total: items.length,
              message: `正在备份${item.label}...`,
            });
            if (item.key === "history") {
              const counts = await uploadHistoryFiles(config);
              summary.push(`历史记录 ${counts.contentCount} 个内容 / ${counts.eventCount} 次观看`);
            } else {
              const data = await item.getAll();
              const ok = await uploadFile(config, item.file, JSON.stringify(data));
              if (!ok) throw new Error(`上传${item.label}失败`);
              summary.push(`${item.label} ${data.length} 条`);
            }
          }

          // 记录同步时间（数值时间戳）
          const now = Date.now();
          await setStorageValue(WEBDAV_LAST_SYNC, now);
          setLastSync(now);

          setSyncProgress({ current: items.length, total: items.length, message: "备份完成！" });
          toast.success(`备份完成！${summary.join("，")}`);
        }),
      );
    } catch (error: any) {
      console.error("WebDAV 备份失败:", error);
      toast.error(error.message || "备份失败，请检查配置");
    } finally {
      setIsBackingUp(false);
      setTimeout(() => setSyncProgress(null), 3000);
    }
  };

  // ===== WebDAV 双向同步（拉取+合并+推送） =====

  const handleBidirectionalSync = async () => {
    if (!config.serverUrl) {
      toast.error("请先配置 WebDAV 服务器");
      return;
    }

    const items = getSelectedItems();
    if (items.length === 0) return;
    const total = items.length * 2;

    try {
      await runWebDavOperation(() =>
        withWebDavOperationLock(async () => {
          setIsBackingUp(true);
          setSyncProgress({ current: 0, total, message: "准备双向同步..." });
          if (!(await ensureDirectory(config))) throw new Error("WebDAV 备份目录创建失败");

          // 第一步：拉取远端数据并合并
          let totalMerged = 0;
          let totalSkipped = 0;
          for (const [i, item] of items.entries()) {
            setSyncProgress({ current: i, total, message: `步骤 1/2：拉取${item.label}...` });
            if (item.key === "history") {
              const result = await mergeRemoteHistoryFiles(config);
              totalMerged += result.merged;
              totalSkipped += result.skipped;
            } else {
              const remote = await downloadFile(config, item.file);
              if (remote) {
                const result = await item.merge(JSON.parse(remote));
                totalMerged += result.merged;
                totalSkipped += result.skipped;
              }
            }
          }

          // 第二步：推送合并后的最新数据
          let totalPushed = 0;
          for (const [i, item] of items.entries()) {
            setSyncProgress({
              current: items.length + i,
              total,
              message: `步骤 2/2：推送${item.label}...`,
            });
            if (item.key === "history") {
              const counts = await uploadHistoryFiles(config);
              totalPushed += counts.eventCount;
            } else {
              const data = await item.getAll();
              const ok = await uploadFile(config, item.file, JSON.stringify(data));
              if (!ok) throw new Error(`上传${item.label}失败`);
              totalPushed += data.length;
            }
          }

          const now = Date.now();
          await setStorageValue(WEBDAV_LAST_SYNC, now);
          setLastSync(now);

          setSyncProgress({ current: total, total, message: "双向同步完成！" });
          toast.success(
            `双向同步完成！合并 ${totalMerged} 条，跳过 ${totalSkipped} 条，推送 ${totalPushed} 条`,
          );
        }),
      );
    } catch (error: any) {
      console.error("WebDAV 双向同步失败:", error);
      toast.error(error.message || "双向同步失败，请检查配置");
    } finally {
      setIsBackingUp(false);
      setTimeout(() => setSyncProgress(null), 3000);
    }
  };

  // ===== WebDAV 恢复 =====

  const handleRestore = async () => {
    if (!config.serverUrl) {
      toast.error("请先配置 WebDAV 服务器");
      return;
    }

    const items = getSelectedItems();
    if (items.length === 0) return;

    try {
      await runWebDavOperation(() =>
        withWebDavOperationLock(async () => {
          setIsRestoring(true);
          setSyncProgress({
            current: 0,
            total: items.length,
            message: "正在从 WebDAV 下载数据...",
          });
          let totalMerged = 0;
          let totalSkipped = 0;
          for (const [i, item] of items.entries()) {
            setSyncProgress({
              current: i,
              total: items.length,
              message: `正在恢复${item.label}...`,
            });
            if (item.key === "history") {
              const result = await mergeRemoteHistoryFiles(config);
              totalMerged += result.merged;
              totalSkipped += result.skipped;
            } else {
              const remote = await downloadFile(config, item.file);
              if (remote) {
                const result = await item.merge(JSON.parse(remote));
                totalMerged += result.merged;
                totalSkipped += result.skipped;
              }
            }
          }

          // 记录同步时间
          const now = Date.now();
          await setStorageValue(WEBDAV_LAST_SYNC, now);
          setLastSync(now);

          setSyncProgress({ current: items.length, total: items.length, message: "恢复完成！" });
          toast.success(`恢复完成！合并 ${totalMerged} 条，跳过 ${totalSkipped} 条（本地更新）`);
        }),
      );
    } catch (error: any) {
      console.error("WebDAV 恢复失败:", error);
      toast.error(error.message || "恢复失败，请检查配置");
    } finally {
      setIsRestoring(false);
      setTimeout(() => setSyncProgress(null), 3000);
    }
  };

  // ===== 手动导出全部数据 =====

  /** 通用格式导出（CSV / Markdown）。下载即完成，不需要确认 */
  const handleHumanReadableExport = async (
    kind: "favorites" | "following" | "followingMd" | "vanished" | "interactions" | "interactionsMd",
  ) => {
    setIsExportingHumanReadable(true);
    try {
      let content = "";
      let fileName = "";
      let mime = "text/plain;charset=utf-8";

      if (kind === "favorites") {
        const [resources, folders] = await Promise.all([getAllFavResources(), getAllFavFolders()]);
        content = buildFavoritesCsv(resources);
        fileName = "bilibili-memory-favorites.csv";
        mime = "text/csv;charset=utf-8";
        void folders;
      } else if (kind === "following") {
        content = buildFollowingCsv(await getAllFollowing());
        fileName = "bilibili-memory-following.csv";
        mime = "text/csv;charset=utf-8";
      } else if (kind === "followingMd") {
        content = buildFollowingMarkdown(await getAllFollowing());
        fileName = "bilibili-memory-following.md";
        mime = "text/markdown;charset=utf-8";
      } else if (kind === "interactions") {
        content = buildInteractionsCsv(await getAllInteractions());
        fileName = "bilibili-memory-interactions.csv";
        mime = "text/csv;charset=utf-8";
      } else if (kind === "interactionsMd") {
        content = buildInteractionsMarkdown(await getAllInteractions());
        fileName = "bilibili-memory-interactions.md";
        mime = "text/markdown;charset=utf-8";
      } else {
        content = buildVanishedCsv(await getAllVanishedFavResources());
        fileName = "bilibili-memory-vanished.csv";
        mime = "text/csv;charset=utf-8";
      }

      const url = URL.createObjectURL(new Blob([content], { type: mime }));
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      toast.success(`已导出 ${fileName}`);
    } catch (error) {
      console.error("通用格式导出失败:", error);
      toast.error("导出失败，请重试");
    } finally {
      setIsExportingHumanReadable(false);
    }
  };

  const handleExportAll = async () => {
    const selectedItems = DATA_ITEMS.filter((item) => manualBackupItems[item.key]);
    if (selectedItems.length === 0) {
      toast.error("请至少选择一项要备份的数据");
      return;
    }

    setIsExporting(true);
    try {
      const data: Record<string, unknown> = {
        exportTime: new Date().toISOString(),
        version: "2.0",
      };

      const counts: string[] = [];
      for (const item of selectedItems) {
        const items = await item.getAll();
        data[item.key] = items;
        counts.push(`${item.label} ${items.length} 条`);
        if (item.key === "history") {
          const v2 = await getHistoryV2Backup();
          data.formatVersion = 2;
          data.historyEvents = v2.events;
          data.historyTombstones = v2.tombstones;
          counts[counts.length - 1] =
            `历史记录 ${items.length} 个内容 / ${v2.events.length} 次观看`;
        }
      }

      const json = JSON.stringify(data, null, 2);
      const blob = new Blob([json], { type: "application/json;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `bilibili-history-backup-${new Date().toISOString().split("T")[0]}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
      try {
        await setStorageValue(BACKUP_LAST_EXPORT_AT, Date.now());
      } catch (error) {
        console.error("记录完整数据导出时间失败:", error);
      }

      toast.success(`导出成功：${counts.join("，")}`);
    } catch (error) {
      console.error("导出数据失败:", error);
      toast.error("导出失败，请重试");
    } finally {
      setIsExporting(false);
    }
  };

  // ===== 手动导入数据 =====

  const handleImportAll = async () => {
    setIsImporting(true);
    try {
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = ".json";

      fileInput.onchange = async (event) => {
        const file = (event.target as HTMLInputElement).files?.[0];
        if (!file) {
          setIsImporting(false);
          return;
        }

        const reader = new FileReader();
        reader.onload = async (e) => {
          try {
            const content = e.target?.result as string;
            const data = JSON.parse(content);

            // 导入前先算清楚会发生什么。原先是黑盒：点完只知道一个数字，
            // 一次误操作可能覆盖掉本地更新的数据。
            if (!Array.isArray(data) && data && typeof data === "object") {
              const [localIds, historyCount] = await Promise.all([
                getBackupLocalIds(),
                getTotalHistoryCount(),
              ]);
              const rows = buildBackupPreview(data as Record<string, unknown>, localIds, historyCount);
              const confirmed = window.confirm(
                `即将导入以下数据：\n\n${formatBackupPreview(rows)}\n\n确定继续吗？`,
              );
              if (!confirmed) {
                setIsImporting(false);
                return;
              }
            }

            let totalMerged = 0;
            let totalSkipped = 0;

            // 智能识别格式：支持任意数据项组合和旧版单独数组格式
            const deletedHistoryIds = await getDeletedHistoryIds();
            if (Array.isArray(data)) {
              // 兼容旧版单独数组格式（历史记录或音乐）
              if (data.length > 0 && "view_at" in data[0]) {
                const result = await smartMergeHistory(data as HistoryItem[], deletedHistoryIds);
                totalMerged = result.merged;
                totalSkipped = result.skipped;
              } else if (data.length > 0 && "bvid" in data[0] && "added_at" in data[0]) {
                const result = await smartMergeLikedMusic(data as LikedMusic[]);
                totalMerged = result.merged;
                totalSkipped = result.skipped;
              } else {
                toast.error("无法识别的数据格式");
                setIsImporting(false);
                return;
              }
            } else {
              let recognized = false;
              const isStandaloneHistoryV2 =
                data.schemaVersion === 2 &&
                Array.isArray(data.events) &&
                Array.isArray(data.tombstones);

              if (isStandaloneHistoryV2) {
                const result = await mergeHistoryV2Backup(data as HistoryV2Backup);
                totalMerged += result.merged;
                totalSkipped += result.skipped;
                recognized = true;
              }
              if (Array.isArray(data.historyEvents)) {
                const result = await mergeHistoryV2Backup({
                  schemaVersion: 2,
                  events: data.historyEvents,
                  tombstones: Array.isArray(data.historyTombstones) ? data.historyTombstones : [],
                  updatedAt: Date.now(),
                });
                totalMerged += result.merged;
                totalSkipped += result.skipped;
                recognized = true;
              }
              if (Array.isArray(data.history)) {
                const result = await smartMergeHistory(data.history, deletedHistoryIds);
                totalMerged += result.merged;
                totalSkipped += result.skipped;
                recognized = true;
              }
              if (Array.isArray(data.likedMusic)) {
                const result = await smartMergeLikedMusic(data.likedMusic);
                totalMerged += result.merged;
                totalSkipped += result.skipped;
                recognized = true;
              }
              if (Array.isArray(data.favFolders)) {
                await importFavFolders(data.favFolders);
                totalMerged += data.favFolders.length;
                recognized = true;
              }
              if (Array.isArray(data.favResources)) {
                const result = await smartMergeFavResources(data.favResources);
                totalMerged += result.merged;
                totalSkipped += result.skipped;
                recognized = true;
              }
              if (Array.isArray(data.subscribedCollections)) {
                await importSubscribedCollections(data.subscribedCollections);
                totalMerged += data.subscribedCollections.length;
                recognized = true;
              }
              if (Array.isArray(data.subscribedCollectionResources)) {
                const result = await smartMergeSubscribedCollectionResources(
                  data.subscribedCollectionResources,
                );
                totalMerged += result.merged;
                totalSkipped += result.skipped;
                recognized = true;
              }
              if (Array.isArray(data.following)) {
                const result = await smartMergeFollowing(data.following);
                totalMerged += result.merged;
                totalSkipped += result.skipped;
                recognized = true;
              }
              if (Array.isArray(data.followingEvents)) {
                const result = await smartMergeFollowingEvents(data.followingEvents);
                totalMerged += result.merged;
                totalSkipped += result.skipped;
                recognized = true;
              }
              if (Array.isArray(data.vanishedFavResources)) {
                const result = await smartMergeVanishedFavResources(data.vanishedFavResources);
                totalMerged += result.merged;
                totalSkipped += result.skipped;
                recognized = true;
              }
              if (Array.isArray(data.interactions)) {
                const result = await smartMergeInteractions(data.interactions);
                totalMerged += result.merged;
                totalSkipped += result.skipped;
                recognized = true;
              }
              if (Array.isArray(data.vanishArchive)) {
                const result = await smartMergeVanishArchive(data.vanishArchive);
                totalMerged += result.merged;
                totalSkipped += result.skipped;
                recognized = true;
              }

              if (!recognized) {
                toast.error("无法识别的文件格式");
                setIsImporting(false);
                return;
              }
            }

            toast.success(`导入完成！合并 ${totalMerged} 条，跳过 ${totalSkipped} 条（本地更新）`);
          } catch (parseError) {
            console.error("解析导入文件失败:", parseError);
            toast.error("导入失败，文件内容格式错误");
          } finally {
            setIsImporting(false);
          }
        };
        reader.readAsText(file);
      };

      // 用户取消选择文件时
      fileInput.addEventListener("cancel", () => {
        setIsImporting(false);
      });

      fileInput.click();
    } catch (error) {
      console.error("导入数据失败:", error);
      toast.error("导入失败，请重试");
      setIsImporting(false);
    }
  };

  // ===== 进度条百分比 =====
  const progressPercent =
    syncProgress && syncProgress.total > 0
      ? Math.round((syncProgress.current / syncProgress.total) * 100)
      : 0;

  // ===== 自动同步操作 =====

  const handleAutoSyncToggle = async (enabled: boolean) => {
    setAutoSyncEnabled(enabled);
    await setStorageValue(WEBDAV_AUTO_SYNC_ENABLED, enabled);
    if (enabled) {
      toast.success(`已开启自动同步，每 ${autoSyncInterval} 分钟备份一次`);
    } else {
      toast.success("已关闭自动同步");
    }
  };

  const handleIntervalChange = async (interval: number) => {
    setAutoSyncInterval(interval);
    await setStorageValue(WEBDAV_AUTO_SYNC_INTERVAL, interval);
  };

  useEffect(() => {
    if (!showBackupDialog) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    closeDialogButtonRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setShowBackupDialog(false);
        return;
      }
      if (event.key !== "Tab") return;

      const focusable = backupDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previouslyFocused?.focus();
    };
  }, [showBackupDialog]);

  return (
    <main className="min-h-screen bg-gray-50/70 text-gray-900 dark:bg-[#0a0a0a] dark:text-neutral-100">
      <div className="mx-auto max-w-7xl px-4 py-8 pb-20 sm:px-6">
        <header className="mb-8">
          <div className="flex items-center gap-3">
            <DatabaseBackup className="h-7 w-7 text-pink-600 dark:text-pink-400" />
            <h1 className="text-2xl font-bold tracking-tight text-gray-950 dark:text-white">
              数据备份
            </h1>
          </div>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-gray-600 dark:text-neutral-400">
            将历史记录安全地保存到本地目录、WebDAV 或 JSON 文件，并在需要时恢复。
          </p>
        </header>

        {/* 备份状态总览：一眼看出三处备份有没有在正常工作。
            异常时这里直接给出"下一步做什么"，不必逐个卡片去找。 */}
        <section className="mb-8 grid gap-3 sm:grid-cols-3">
          {[
            {
              key: "local",
              title: "本地目录",
              detail: localBackup.enabled
                ? localBackup.lastSuccessAt
                  ? `上次成功 ${new Date(localBackup.lastSuccessAt).toLocaleString()}`
                  : "已启用，尚未成功备份"
                : "未启用自动备份",
              sub:
                localBackup.recordCount > 0
                  ? `上次写入 ${localBackup.recordCount} 条记录`
                  : undefined,
              warn: localBackup.error || undefined,
            },
            {
              key: "webdav",
              title: "WebDAV",
              detail: lastSync ? `上次同步 ${new Date(lastSync).toLocaleString()}` : "尚未同步",
              sub: autoSyncEnabled
                ? `自动同步已开启 · 每 ${autoSyncInterval} 分钟`
                : "自动同步未开启",
              warn: config.serverUrl ? undefined : "尚未配置服务器地址",
            },
            {
              key: "export",
              title: "JSON 导出",
              detail: lastExportAt
                ? `上次导出 ${new Date(lastExportAt).toLocaleString()}`
                : "尚未导出过",
              sub: "手动触发，适合离线保存与迁移",
              warn: undefined,
            },
          ].map((card) => (
            <div
              key={card.key}
              className="rounded-2xl border border-gray-200 bg-white px-4 py-3.5 dark:border-neutral-800 dark:bg-neutral-900"
            >
              <p className="text-xs text-gray-500 dark:text-neutral-400">{card.title}</p>
              <p className="mt-1 text-sm font-medium text-gray-900 dark:text-neutral-100">
                {card.detail}
              </p>
              {card.sub ? (
                <p className="mt-1 text-xs text-gray-400 dark:text-neutral-500">{card.sub}</p>
              ) : null}
              {card.warn ? (
                <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-2 text-xs leading-5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  {card.warn}
                </p>
              ) : null}
            </div>
          ))}
        </section>

        <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
          <div className="space-y-6">
            <section className="space-y-3" aria-labelledby="local-backup-heading">
              <div>
                <h2
                  id="local-backup-heading"
                  className="text-base font-semibold text-gray-950 dark:text-neutral-100"
                >
                  本地目录
                </h2>
                <p className="mt-1 text-sm text-gray-600 dark:text-neutral-400">
                  按周期把选中的数据写入你授权的目录，可保留多份历史副本。
                </p>
              </div>

              <div data-tour="backup-local">
                <LocalHistoryBackupPanel />
              </div>
            </section>
            <section className="space-y-3" aria-labelledby="json-heading">
              <div>
                <h2
                  id="json-heading"
                  className="text-base font-semibold text-gray-950 dark:text-neutral-100"
                >
                  JSON 文件
                </h2>
                <p className="mt-1 text-sm text-gray-600 dark:text-neutral-400">
                  下载到设备保存，或从已有文件恢复；适合离线保存与迁移。
                </p>
              </div>

              <article
                data-tour="backup-manual"
                className="overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="flex items-start gap-3 border-b border-gray-100 px-5 py-4 dark:border-neutral-800">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-pink-50 text-pink-600 dark:bg-pink-500/10 dark:text-pink-400">
                    <FileJson2 className="h-4.5 w-4.5" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-950 dark:text-neutral-100">JSON 文件</h3>
                    <p className="mt-1 text-sm text-gray-600 dark:text-neutral-400">
                      下载到设备保存，或从已有文件恢复。
                    </p>
                  </div>
                </div>

                <div className="p-5">
                  <div className="mb-5">
                    <p className="mb-2 text-sm font-medium text-gray-700 dark:text-neutral-300">
                      备份内容
                    </p>
                    <BackupItemsPicker
                      options={SELECTABLE_DATA_ITEMS.map((item) => ({
                        key: item.key,
                        label: item.label,
                      }))}
                      value={manualBackupItems}
                      onChange={(next) => {
                        setManualBackupItems(next);
                        void setStorageValue(MANUAL_BACKUP_ITEMS, next);
                      }}
                      scopeHint="只影响这里下载的 JSON 备份文件，不影响本地目录与 WebDAV。归档图片不在其中——它们只随本地目录备份写进 images/ 目录。"
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={handleExportAll}
                      disabled={isExporting}
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-pink-600 px-4 text-sm font-medium text-white transition-colors hover:bg-pink-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-pink-500 dark:hover:bg-pink-600 dark:focus-visible:ring-offset-neutral-900"
                    >
                      {isExporting ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <Download className="h-4 w-4" />
                      )}
                      {isExporting ? "正在生成文件" : "下载备份文件"}
                    </button>

                    <button
                      type="button"
                      onClick={handleImportAll}
                      disabled={isImporting}
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800 dark:focus-visible:ring-offset-neutral-900"
                    >
                      {isImporting ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <Upload className="h-4 w-4" />
                      )}
                      {isImporting ? "正在导入" : "导入数据"}
                    </button>
                  </div>

                  <div className="mt-4 flex items-start gap-2 rounded-lg bg-gray-50 px-3 py-2.5 text-xs leading-5 text-gray-600 dark:bg-neutral-800 dark:text-neutral-300">
                    <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    导出文件仅包含已勾选的数据；导入时会智能合并，并兼容旧版历史记录或音乐 JSON。
                  </div>
                </div>
              </article>
            </section>
            <section className="space-y-3" aria-labelledby="export-heading">
              <div>
                <h2
                  id="export-heading"
                  className="text-base font-semibold text-gray-950 dark:text-neutral-100"
                >
                  导出为通用格式
                </h2>
                <p className="mt-1 text-sm text-gray-600 dark:text-neutral-400">
                  给 Excel、Numbers 或其他工具读的表格文件。它们不是备份，不能用于恢复。
                </p>
              </div>

              {/* 通用格式导出：JSON 只对本插件有意义，CSV 能进 Excel、Markdown 能直接读。
                  万一哪天不用这个插件了，这些数据还能用。 */}
              <article className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
                <p className="mb-3 text-xs leading-relaxed text-gray-500 dark:text-neutral-400">
                  CSV 带 UTF-8 BOM，Excel 打开中文不会乱码。
                </p>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      { key: "favorites", label: "收藏内容 CSV" },
                      { key: "following", label: "关注列表 CSV" },
                      { key: "followingMd", label: "关注列表 Markdown" },
                      { key: "vanished", label: "消失档案 CSV" },
                      { key: "interactions", label: "点赞与投币 CSV" },
                      { key: "interactionsMd", label: "点赞与投币 Markdown" },
                    ] as const
                  ).map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => void handleHumanReadableExport(option.key)}
                      disabled={isExportingHumanReadable}
                      className="rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 transition-colors hover:border-pink-300 hover:text-pink-600 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-pink-500/50 dark:hover:text-pink-400"
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </article>
            </section>
          </div>

          <div className="space-y-6">
            <section className="space-y-3" aria-labelledby="webdav-heading">
              <div>
                <h2
                  id="webdav-heading"
                  className="text-base font-semibold text-gray-950 dark:text-neutral-100"
                >
                  WebDAV
                </h2>
                <p className="mt-1 text-sm text-gray-600 dark:text-neutral-400">
                  配置一次服务器；自动同步与手动同步共用这同一份配置和同一份备份内容。
                </p>
              </div>

              <article
                data-tour="backup-webdav"
                className="overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-4 dark:border-neutral-800">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-pink-50 text-pink-600 dark:bg-pink-500/10 dark:text-pink-400">
                      <Server className="h-4.5 w-4.5" />
                    </div>
                    <div>
                      <h3 className="font-semibold text-gray-950 dark:text-neutral-100">
                        WebDAV 服务器
                      </h3>
                      <p className="mt-1 text-sm text-gray-600 dark:text-neutral-400">
                        支持坚果云、Nextcloud、群晖 NAS 等服务
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-2.5 py-2 text-xs font-medium text-pink-600 transition-colors hover:bg-pink-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 focus-visible:ring-offset-2 dark:text-pink-400 dark:hover:bg-pink-500/10 dark:focus-visible:ring-offset-neutral-900"
                    onClick={() => {
                      const url = browser.runtime.getURL("/webdav-tutorial.html");
                      browser.tabs.create({ url });
                    }}
                  >
                    配置教程
                    <ExternalLink className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="space-y-4 p-5">
                  <div>
                    <label
                      htmlFor="webdav-server-url"
                      className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-neutral-300"
                    >
                      服务器地址
                    </label>
                    <input
                      id="webdav-server-url"
                      type="url"
                      autoComplete="url"
                      placeholder="例如：https://dav.jianguoyun.com/dav"
                      value={config.serverUrl}
                      onChange={(e) => setConfig({ ...config, serverUrl: e.target.value })}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-500 focus:border-pink-500 focus:ring-2 focus:ring-pink-500/20 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <label
                        htmlFor="webdav-username"
                        className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-neutral-300"
                      >
                        用户名
                      </label>
                      <input
                        id="webdav-username"
                        type="text"
                        autoComplete="username"
                        placeholder="WebDAV 用户名"
                        value={config.username}
                        onChange={(e) => setConfig({ ...config, username: e.target.value })}
                        className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-500 focus:border-pink-500 focus:ring-2 focus:ring-pink-500/20 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                      />
                    </div>
                    <div>
                      <label
                        htmlFor="webdav-password"
                        className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-neutral-300"
                      >
                        密码
                      </label>
                      <div className="relative">
                        <input
                          id="webdav-password"
                          type={showPassword ? "text" : "password"}
                          autoComplete="current-password"
                          placeholder="密码 / 应用密码"
                          value={config.password}
                          onChange={(e) => setConfig({ ...config, password: e.target.value })}
                          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 pr-11 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-500 focus:border-pink-500 focus:ring-2 focus:ring-pink-500/20 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                        />
                        <button
                          type="button"
                          onClick={() => setShowPassword(!showPassword)}
                          className="absolute right-1.5 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                          aria-label={showPassword ? "隐藏密码" : "显示密码"}
                        >
                          {showPassword ? (
                            <EyeOff className="h-4 w-4" />
                          ) : (
                            <Eye className="h-4 w-4" />
                          )}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div>
                    <label
                      htmlFor="webdav-base-path"
                      className="mb-1.5 block text-sm font-medium text-gray-700 dark:text-neutral-300"
                    >
                      远程路径
                    </label>
                    <input
                      id="webdav-base-path"
                      type="text"
                      placeholder="/bilibili-history/"
                      value={config.basePath}
                      onChange={(e) => setConfig({ ...config, basePath: e.target.value })}
                      className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-sm text-gray-900 outline-none transition-colors placeholder:text-gray-500 focus:border-pink-500 focus:ring-2 focus:ring-pink-500/20 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100 dark:placeholder:text-neutral-500"
                    />
                  </div>

                  <p className="flex items-start gap-2 text-xs leading-5 text-gray-600 dark:text-neutral-400">
                    <LockKeyhole className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-500 dark:text-neutral-500" />
                    凭证仅保存在本地浏览器存储中，密码会加密，不会发送给第三方。
                  </p>

                  <div className="flex flex-wrap gap-3 pt-1">
                    <button
                      type="button"
                      onClick={handleTestConnection}
                      disabled={isTesting || !config.serverUrl}
                      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800 dark:focus-visible:ring-offset-neutral-900"
                    >
                      {isTesting ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                      {isTesting ? "正在测试" : "测试连接"}
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveConfig}
                      disabled={isSaving || !config.serverUrl}
                      className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-pink-600 px-4 text-sm font-medium text-white transition-colors hover:bg-pink-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-pink-500 dark:hover:bg-pink-600 dark:focus-visible:ring-offset-neutral-900"
                    >
                      {isSaving ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <Save className="h-4 w-4" />
                      )}
                      {isSaving ? "正在保存" : "保存配置"}
                    </button>
                  </div>
                </div>
              </article>

              <article
                data-tour="backup-webdav-auto"
                className="overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="flex items-start gap-3 border-b border-gray-100 px-5 py-4 dark:border-neutral-800">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-pink-50 text-pink-600 dark:bg-pink-500/10 dark:text-pink-400">
                    <Clock3 className="h-4.5 w-4.5" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-950 dark:text-neutral-100">
                      WebDAV 自动同步
                    </h3>
                    <p className="mt-1 text-sm text-gray-600 dark:text-neutral-400">
                      在后台定时将选中的数据写入远端。
                    </p>
                  </div>
                </div>

                <div className="space-y-4 p-5">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-medium text-gray-800 dark:text-neutral-200">
                        启用自动同步
                      </p>
                      <p className="mt-1 text-xs text-gray-600 dark:text-neutral-400">
                        关闭后仍可在右侧手动同步。
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={autoSyncEnabled}
                      aria-label="启用 WebDAV 自动同步"
                      onClick={() => handleAutoSyncToggle(!autoSyncEnabled)}
                      disabled={!config.serverUrl}
                      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-neutral-900 ${
                        autoSyncEnabled
                          ? "bg-pink-600 dark:bg-pink-500"
                          : "bg-gray-300 dark:bg-neutral-700"
                      }`}
                    >
                      <span
                        className={`inline-block h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${
                          autoSyncEnabled ? "translate-x-5.5" : "translate-x-0.5"
                        }`}
                      />
                    </button>
                  </div>

                  {autoSyncEnabled && (
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
                      <label
                        htmlFor="webdav-auto-sync-interval"
                        className="whitespace-nowrap text-sm font-medium text-gray-700 dark:text-neutral-300"
                      >
                        同步间隔
                      </label>
                      <select
                        id="webdav-auto-sync-interval"
                        value={autoSyncInterval}
                        onChange={(e) => handleIntervalChange(Number(e.target.value))}
                        className="min-h-10 flex-1 rounded-lg border border-gray-300 bg-white px-3 text-sm text-gray-900 outline-none transition-colors focus:border-pink-500 focus:ring-2 focus:ring-pink-500/20 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
                      >
                        <option value={15}>每 15 分钟</option>
                        <option value={30}>每 30 分钟</option>
                        <option value={60}>每 1 小时</option>
                        <option value={120}>每 2 小时</option>
                        <option value={360}>每 6 小时</option>
                        <option value={720}>每 12 小时</option>
                        <option value={1440}>每 24 小时</option>
                      </select>
                    </div>
                  )}

                  {!config.serverUrl && (
                    <div className="flex items-start gap-2 rounded-lg bg-gray-50 px-3 py-2.5 text-xs leading-5 text-gray-600 dark:bg-neutral-800 dark:text-neutral-400">
                      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      请先配置并保存 WebDAV 服务器信息，再开启自动同步。
                    </div>
                  )}
                </div>
              </article>

              <article
                data-tour="backup-sync"
                className="overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-neutral-800 dark:bg-neutral-900"
              >
                <div className="flex items-start gap-3 border-b border-gray-100 px-5 py-4 dark:border-neutral-800">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-pink-50 text-pink-600 dark:bg-pink-500/10 dark:text-pink-400">
                    <ArrowLeftRight className="h-4.5 w-4.5" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-gray-950 dark:text-neutral-100">WebDAV 同步</h3>
                    <p className="mt-1 text-sm text-gray-600 dark:text-neutral-400">
                      {lastSync
                        ? `上次同步：${new Date(lastSync).toLocaleString()}`
                        : "尚未进行手动同步"}
                    </p>
                  </div>
                </div>

                <div className="p-5">
                  {syncProgress && (
                    <div
                      className="mb-5 rounded-xl bg-pink-50 p-4 text-pink-800 dark:bg-pink-500/10 dark:text-pink-200"
                      role="status"
                      aria-live="polite"
                    >
                      <div className="mb-2 flex justify-between gap-3 text-sm font-medium">
                        <span>{syncProgress.message}</span>
                        <span className="tabular-nums">{progressPercent}%</span>
                      </div>
                      <div
                        className="h-2 w-full overflow-hidden rounded-full bg-pink-200 dark:bg-pink-500/20"
                        role="progressbar"
                        aria-label="WebDAV 同步进度"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={progressPercent}
                      >
                        <div
                          className="h-full rounded-full bg-pink-600 transition-[width] duration-500 dark:bg-pink-400"
                          style={{ width: `${progressPercent}%` }}
                        />
                      </div>
                    </div>
                  )}

                  <div className="mb-5">
                    <p className="mb-2 text-sm font-medium text-gray-700 dark:text-neutral-300">
                      同步内容
                    </p>
                    {/* 这一份就是 WEBDAV_SYNC_ITEMS：后台自动同步读的是同一个键。
                        之前它被放在"手动备份"一侧、只写"同步内容"，用户改完这里会
                        连带改掉自动同步的范围，界面上完全看不出来。 */}
                    <BackupItemsPicker
                      options={SELECTABLE_DATA_ITEMS.map((item) => ({
                        key: item.key,
                        label: item.label,
                      }))}
                      value={selectedKeys}
                      onChange={(next) => {
                        setSelectedKeys(next);
                        void setStorageValue(WEBDAV_SYNC_ITEMS, next);
                      }}
                      scopeHint="自动同步与手动同步共用这份选择，改动会同时生效。归档图片不在备份内容里——它们只随本地目录备份写进 images/ 目录。"
                    />
                  </div>

                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setShowBackupDialog(true)}
                      disabled={isBackingUp || isRestoring || !config.serverUrl}
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-pink-600 px-4 text-sm font-medium text-white transition-colors hover:bg-pink-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-pink-500 dark:hover:bg-pink-600 dark:focus-visible:ring-offset-neutral-900"
                    >
                      {isBackingUp ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <CloudUpload className="h-4 w-4" />
                      )}
                      {isBackingUp ? "正在备份" : "备份到 WebDAV"}
                    </button>

                    <button
                      type="button"
                      onClick={handleRestore}
                      disabled={isBackingUp || isRestoring || !config.serverUrl}
                      className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800 dark:focus-visible:ring-offset-neutral-900"
                    >
                      {isRestoring ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <CloudDownload className="h-4 w-4" />
                      )}
                      {isRestoring ? "正在恢复" : "从 WebDAV 恢复"}
                    </button>
                  </div>

                  {!config.serverUrl && (
                    <p className="mt-3 text-xs text-gray-600 dark:text-neutral-400">
                      保存服务器配置后即可使用 WebDAV 备份与恢复。
                    </p>
                  )}

                  <div className="mt-4 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    恢复时会智能合并，仅在远端记录更新时覆盖本地数据。
                  </div>
                </div>
              </article>
            </section>
            <aside className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-900">
                <h3 className="text-sm font-semibold text-gray-950 dark:text-neutral-100">
                  备份说明
                </h3>
                <ul className="mt-4 space-y-3 text-sm leading-6 text-gray-600 dark:text-neutral-300">
                  <li className="flex items-start gap-2.5">
                    <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-pink-600 dark:text-pink-400" />
                    <span>WebDAV 适合多设备同步；JSON 文件适合离线保存和迁移。</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <ArrowLeftRight className="mt-1 h-4 w-4 shrink-0 text-pink-600 dark:text-pink-400" />
                    <span>恢复和导入默认智能合并，不会覆盖本地更新的记录。</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <ShieldCheck className="mt-1 h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    <span>数据只写入你选择的目录或服务器，不经过第三方中转。</span>
                  </li>
                  <li className="flex items-start gap-2.5">
                    <ImageIcon className="mt-1 h-4 w-4 shrink-0 text-pink-600 dark:text-pink-400" />
                    <span>
                      归档图片（头像 / 收藏封面的字节）只随本地目录备份写进 images/ 目录，不进 WebDAV 与 JSON。
                    </span>
                  </li>
                </ul>
              </aside>
          </div>
        </div>
      </div>

      {showBackupDialog && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 px-4 py-8"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowBackupDialog(false);
          }}
        >
          <div
            ref={backupDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="backup-mode-title"
            aria-describedby="backup-mode-description"
            className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-neutral-900"
          >
            <div className="flex items-start justify-between gap-4 border-b border-gray-100 px-5 py-4 dark:border-neutral-800">
              <div>
                <h3
                  id="backup-mode-title"
                  className="text-lg font-semibold text-gray-950 dark:text-neutral-100"
                >
                  选择备份模式
                </h3>
                <p
                  id="backup-mode-description"
                  className="mt-1 text-sm leading-6 text-gray-600 dark:text-neutral-400"
                >
                  多设备使用推荐双向同步；强制覆盖会替换远端文件。
                </p>
              </div>
              <button
                ref={closeDialogButtonRef}
                type="button"
                onClick={() => setShowBackupDialog(false)}
                aria-label="关闭备份模式选择"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-3 p-5">
              <button
                type="button"
                onClick={() => {
                  setShowBackupDialog(false);
                  handleBidirectionalSync();
                }}
                className="flex w-full items-start gap-3 rounded-xl border border-pink-200 bg-pink-50 p-4 text-left transition-colors hover:border-pink-300 hover:bg-pink-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 focus-visible:ring-offset-2 dark:border-pink-500/30 dark:bg-pink-500/10 dark:hover:bg-pink-500/15 dark:focus-visible:ring-offset-neutral-900"
              >
                <ArrowLeftRight className="mt-0.5 h-5 w-5 shrink-0 text-pink-600 dark:text-pink-400" />
                <span>
                  <span className="block font-semibold text-pink-900 dark:text-pink-200">
                    双向同步
                    <span className="ml-2 rounded-full bg-pink-600 px-2 py-0.5 text-[11px] font-medium text-white dark:bg-pink-500">
                      推荐
                    </span>
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-pink-800 dark:text-pink-200">
                    先拉取远端数据并智能合并，再将最新数据推送回去，适合多设备使用。
                  </span>
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowBackupDialog(false);
                  handleBackup();
                }}
                className="flex w-full items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-left transition-colors hover:border-amber-300 hover:bg-amber-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500 focus-visible:ring-offset-2 dark:border-amber-500/30 dark:bg-amber-500/10 dark:hover:bg-amber-500/15 dark:focus-visible:ring-offset-neutral-900"
              >
                <CloudUpload className="mt-0.5 h-5 w-5 shrink-0 text-amber-700 dark:text-amber-400" />
                <span>
                  <span className="block font-semibold text-amber-900 dark:text-amber-200">
                    强制覆盖远端
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-amber-800 dark:text-amber-200">
                    直接用本地数据替换远端文件。仅在确认本地数据最新时使用。
                  </span>
                </span>
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
};

export default WebDavSync;
