import {
  DEFAULT_LOCAL_HISTORY_BACKUP_INTERVAL_HOURS,
  DEFAULT_LOCAL_HISTORY_BACKUP_ITEMS,
  DEFAULT_LOCAL_HISTORY_BACKUP_RETENTION_COUNT,
  BackupItemKey,
  BackupItems,
  LOCAL_HISTORY_BACKUP_ENABLED,
  LOCAL_HISTORY_BACKUP_INTERVAL_HOURS,
  LOCAL_HISTORY_BACKUP_ITEMS,
  LOCAL_HISTORY_BACKUP_LAST_ATTEMPT_AT,
  LOCAL_HISTORY_BACKUP_LAST_CLEANUP_WARNING,
  LOCAL_HISTORY_BACKUP_LAST_ERROR,
  LOCAL_HISTORY_BACKUP_LAST_FILE_NAME,
  LOCAL_HISTORY_BACKUP_LAST_RECORD_COUNT,
  LOCAL_HISTORY_BACKUP_LAST_SUCCESS_AT,
  LOCAL_HISTORY_BACKUP_NEEDS_PERMISSION,
  LOCAL_HISTORY_BACKUP_RETENTION_COUNT,
} from "./constants";
import {
  getAllFavFolders,
  getAllFavResources,
  getAllHistory,
  getAllHistoryEvents,
  getAllHistoryTombstones,
  getAllSubscribedCollectionResources,
  getAllSubscribedCollections,
  getAllFollowing,
  getAllFollowingEvents,
  getAllVanishedFavResources,
  getAllVanishArchive,
  getAllInteractions,
  getAllAssets,
} from "./db";
import { assetFileName } from "./assetArchive";
import { mergeArchiveWithLegacy } from "./vanishArchive";
import { getLocalBackupDirectoryHandle } from "./localBackupHandle";
import { getStorageValue, setStorageValues } from "./storage";
import { LocalHistoryBackupErrorCode, LocalHistoryBackupResult } from "./types";

const AUTO_BACKUP_FILE_PATTERN = /^bilibili-history-\d{4}-\d{2}-\d{2}-\d{6}\.json$/;

/** 归档图片字节所在的子目录名 */
export const ASSET_BACKUP_DIRECTORY = "images";

export interface AssetBackupResult {
  total: number;
  written: number;
  skipped: number;
  failed: number;
}

/**
 * 把归档的图片字节写进 `images/` 子目录，一图一文件。
 *
 * ## 为什么必须单独做这件事
 *
 * `assets` 里存的是**已经消失内容的最后一份影像**——头像被 B站 换成 noface、
 * 封面被换成占位图之后，就只剩本地这份。但它没有进任何备份：
 * 浏览器配置被清、换机器、扩展重装，这些字节就全部蒸发，
 * 而它们恰恰是当初为了"防丢失"才存下来的。
 *
 * 放进 JSON 做 base64 是错的：文件会膨胀三分之一以上且没法直接查看。
 * 本地目录本来就是二进制该待的地方。
 *
 * ## 增量写入
 *
 * 文件名由 asset id 确定派生（见 `assetFileName`），内容也由路径哈希决定，
 * 所以**已存在的文件直接跳过**——后续每次备份几乎是零成本。
 */
export const writeAssetFiles = async (
  directoryHandle: FileSystemDirectoryHandle,
  assets: Array<{ id: string; blob: Blob }>,
): Promise<AssetBackupResult> => {
  const result: AssetBackupResult = {
    total: assets.length,
    written: 0,
    skipped: 0,
    failed: 0,
  };
  if (assets.length === 0) return result;

  const imagesDirectory = await directoryHandle.getDirectoryHandle(ASSET_BACKUP_DIRECTORY, {
    create: true,
  });

  for (const asset of assets) {
    const name = assetFileName(asset.id);
    try {
      try {
        await imagesDirectory.getFileHandle(name);
        result.skipped += 1;
        continue;
      } catch {
        // 不存在，继续写入
      }

      const fileHandle = await imagesDirectory.getFileHandle(name, { create: true });
      const writable = await fileHandle.createWritable();
      try {
        await writable.write(asset.blob);
        await writable.close();
      } catch (error) {
        try {
          await writable.abort();
        } catch {
          // 保留原始写入错误
        }
        throw error;
      }
      result.written += 1;
    } catch (error) {
      result.failed += 1;
      console.warn(`写入归档图片失败（${asset.id}）:`, error);
    }
  }

  return result;
};

const LOCAL_BACKUP_DATA_ITEMS: {
  key: Exclude<BackupItemKey, "history">;
  label: string;
  getAll: () => Promise<unknown[]>;
}[] = [
  { key: "favFolders", label: "收藏夹", getAll: getAllFavFolders },
  { key: "favResources", label: "收藏资源", getAll: getAllFavResources },
  { key: "subscribedCollections", label: "订阅合集", getAll: getAllSubscribedCollections },
  {
    key: "subscribedCollectionResources",
    label: "合集视频",
    getAll: getAllSubscribedCollectionResources,
  },
  { key: "following", label: "关注的 UP 主", getAll: getAllFollowing },
  { key: "followingEvents", label: "关注变动", getAll: getAllFollowingEvents },
  // 旧 store 不再单独作为备份项：它已被 `vanishArchive` 取代，
  // 数据会在写 `vanishArchive` 时一起并进来（见本文件下方的合并逻辑）
  { key: "vanishedFavResources", label: "消失档案", getAll: getAllVanishedFavResources },
  { key: "vanishArchive", label: "消失档案", getAll: getAllVanishArchive },
  { key: "interactions", label: "点赞与投币", getAll: getAllInteractions },
];

const toErrorMessage = (error: unknown): string => {
  return error instanceof Error ? error.message : "未知错误";
};

const updateFailureState = async (
  errorCode: LocalHistoryBackupErrorCode,
  error: string,
  needsPermission = false,
): Promise<LocalHistoryBackupResult> => {
  await setStorageValues({
    [LOCAL_HISTORY_BACKUP_LAST_ERROR]: error,
    [LOCAL_HISTORY_BACKUP_NEEDS_PERMISSION]: needsPermission,
  });
  return { success: false, errorCode, error };
};

const pad = (value: number, length = 2): string => String(value).padStart(length, "0");

const formatBackupTimestamp = (date: Date): string => {
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join("-");
};

const fileExists = async (
  directoryHandle: FileSystemDirectoryHandle,
  fileName: string,
): Promise<boolean> => {
  try {
    await directoryHandle.getFileHandle(fileName);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return false;
    throw error;
  }
};

const createUniqueBackupFileName = async (
  directoryHandle: FileSystemDirectoryHandle,
): Promise<string> => {
  const baseTime = Date.now();
  for (let offsetSeconds = 0; offsetSeconds < 120; offsetSeconds += 1) {
    const fileName = `bilibili-history-${formatBackupTimestamp(
      new Date(baseTime + offsetSeconds * 1000),
    )}.json`;
    if (!(await fileExists(directoryHandle, fileName))) return fileName;
  }
  throw new Error("短时间内生成的备份文件过多，请稍后再试");
};

const cleanupOldBackups = async (
  directoryHandle: FileSystemDirectoryHandle,
  retentionCount: number,
): Promise<void> => {
  const backupFiles: string[] = [];
  for await (const [name, handle] of directoryHandle.entries()) {
    if (handle.kind === "file" && AUTO_BACKUP_FILE_PATTERN.test(name)) {
      backupFiles.push(name);
    }
  }

  backupFiles.sort((left, right) => right.localeCompare(left));
  const normalizedRetention = Math.min(100, Math.max(1, Math.floor(retentionCount)));
  for (const fileName of backupFiles.slice(normalizedRetention)) {
    await directoryHandle.removeEntry(fileName);
  }
};

export const isLocalDirectoryBackupSupported = (): boolean => {
  return typeof window !== "undefined" && "showDirectoryPicker" in window;
};

export const buildHistoryBackupJson = async (
  selectedItems: BackupItems = DEFAULT_LOCAL_HISTORY_BACKUP_ITEMS,
): Promise<{
  json: string;
  recordCount: number;
  contentCount: number;
  eventCount: number;
  includesHistory: boolean;
  summary: string;
}> => {
  const data: Record<string, unknown> = {
    formatVersion: 2,
    exportedAt: new Date().toISOString(),
  };
  const summaries: string[] = [];
  let contentCount = 0;
  let eventCount = 0;

  if (selectedItems.history) {
    const [history, historyEvents, historyTombstones] = await Promise.all([
      getAllHistory(),
      getAllHistoryEvents(),
      getAllHistoryTombstones(),
    ]);
    data.history = history;
    data.historyEvents = historyEvents;
    data.historyTombstones = historyTombstones;
    contentCount = history.length;
    eventCount = historyEvents.length;
    summaries.push(`历史记录 ${contentCount} 个内容 / ${eventCount} 次观看`);
  }

  for (const item of LOCAL_BACKUP_DATA_ITEMS) {
    if (!selectedItems[item.key]) continue;
    // 统一消失档案：把旧 store 的收藏档案一起并进来。
    // 界面上只有「消失档案」一个勾选项——分两个选项让用户去理解
    // 「消失档案（旧）/ 统一消失档案」的区别是没必要的负担，
    // 而旧数据仍然要保下来（旧备份、旧版本兼容）。
    if (item.key === "vanishArchive") {
      const [archive, legacy] = await Promise.all([
        getAllVanishArchive(),
        getAllVanishedFavResources(),
      ]);
      const merged = mergeArchiveWithLegacy(archive, legacy);
      data[item.key] = merged;
      summaries.push(`${item.label} ${merged.length} 条`);
      continue;
    }
    const records = await item.getAll();
    data[item.key] = records;
    summaries.push(`${item.label} ${records.length} 条`);
  }

  return {
    json: JSON.stringify(data, null, 2),
    recordCount: eventCount,
    contentCount,
    eventCount,
    includesHistory: selectedItems.history,
    summary: summaries.join("，"),
  };
};

export const validateLocalBackupDirectory = async (
  directoryHandle: FileSystemDirectoryHandle,
): Promise<void> => {
  const permission = await directoryHandle.queryPermission({ mode: "readwrite" });
  if (permission !== "granted") {
    throw new Error("没有获得目录读写权限");
  }

  const testFileName = `bilibili-history-backup-access-test-${Date.now()}.tmp`;
  const fileHandle = await directoryHandle.getFileHandle(testFileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write("Bilibili history backup access test");
    await writable.close();
  } catch (error) {
    try {
      await writable.abort();
    } catch {
      // 保留原始写入错误。
    }
    throw error;
  }

  try {
    await directoryHandle.removeEntry(testFileName);
  } catch (error) {
    throw new Error(`目录可写，但无法删除测试文件：${toErrorMessage(error)}`);
  }
};

export const isLocalHistoryBackupDue = async (): Promise<boolean> => {
  const enabled = await getStorageValue(LOCAL_HISTORY_BACKUP_ENABLED, false);
  if (!enabled) return false;

  const lastSuccessAt = await getStorageValue<number>(LOCAL_HISTORY_BACKUP_LAST_SUCCESS_AT, 0);
  const intervalHours = await getStorageValue<number>(
    LOCAL_HISTORY_BACKUP_INTERVAL_HOURS,
    DEFAULT_LOCAL_HISTORY_BACKUP_INTERVAL_HOURS,
  );
  const intervalMs = Math.max(1 / 60, intervalHours) * 60 * 60 * 1000;
  return lastSuccessAt === 0 || Date.now() - lastSuccessAt >= intervalMs;
};

export const runLocalHistoryBackup = async (
  allowEmpty = false,
): Promise<LocalHistoryBackupResult> => {
  await setStorageValues({ [LOCAL_HISTORY_BACKUP_LAST_ATTEMPT_AT]: Date.now() });

  let directoryHandle: FileSystemDirectoryHandle | null;
  try {
    directoryHandle = await getLocalBackupDirectoryHandle();
  } catch (error) {
    return updateFailureState("NO_DIRECTORY", `读取备份目录失败：${toErrorMessage(error)}`);
  }
  if (!directoryHandle) {
    return updateFailureState("NO_DIRECTORY", "尚未选择备份目录");
  }

  let permission: PermissionState;
  try {
    permission = await directoryHandle.queryPermission({ mode: "readwrite" });
  } catch (error) {
    return updateFailureState(
      "PERMISSION_REQUIRED",
      `无法检查备份目录权限：${toErrorMessage(error)}`,
      true,
    );
  }
  if (permission !== "granted") {
    return updateFailureState("PERMISSION_REQUIRED", "备份目录需要重新授权", true);
  }

  let backupData: Awaited<ReturnType<typeof buildHistoryBackupJson>>;
  try {
    const storedItems = await getStorageValue<BackupItems>(
      LOCAL_HISTORY_BACKUP_ITEMS,
      DEFAULT_LOCAL_HISTORY_BACKUP_ITEMS,
    );
    const selectedItems = { ...DEFAULT_LOCAL_HISTORY_BACKUP_ITEMS, ...storedItems };
    if (!Object.values(selectedItems).some(Boolean)) {
      return updateFailureState("READ_FAILED", "请至少选择一项要备份的数据");
    }
    backupData = await buildHistoryBackupJson(selectedItems);
  } catch (error) {
    return updateFailureState("READ_FAILED", `读取备份数据失败：${toErrorMessage(error)}`);
  }

  const previousRecordCount = await getStorageValue<number>(
    LOCAL_HISTORY_BACKUP_LAST_RECORD_COUNT,
    0,
  );
  const emptyHistoryAnomaly =
    backupData.includesHistory &&
    previousRecordCount > 0 &&
    backupData.contentCount === 0 &&
    backupData.eventCount === 0;
  if (!allowEmpty && emptyHistoryAnomaly) {
    return updateFailureState(
      "EMPTY_HISTORY_ANOMALY",
      "当前历史记录变为 0 条，为保护旧备份已停止自动写入",
    );
  }

  let fileName: string;
  try {
    fileName = await createUniqueBackupFileName(directoryHandle);
    const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    try {
      await writable.write(backupData.json);
      await writable.close();
    } catch (error) {
      try {
        await writable.abort();
      } catch {
        // 保留原始写入错误。
      }
      throw error;
    }
  } catch (error) {
    return updateFailureState("WRITE_FAILED", `写入备份文件失败：${toErrorMessage(error)}`);
  }

  // 归档的图片字节单独写进 images/ 子目录。
  // 失败**不判整次备份失败**——JSON 才是主体，图片是附加保险。
  let assetSummary = "";
  try {
    const assets = await getAllAssets();
    const assetResult = await writeAssetFiles(directoryHandle, assets);
    assetSummary =
      `归档图片 ${assetResult.total} 张` +
      `（新增 ${assetResult.written}，已存在 ${assetResult.skipped}` +
      (assetResult.failed > 0 ? `，失败 ${assetResult.failed}` : "") +
      "）";
  } catch (error) {
    assetSummary = `归档图片备份失败：${toErrorMessage(error)}`;
  }

  const completedAt = Date.now();
  const retentionCount = await getStorageValue<number>(
    LOCAL_HISTORY_BACKUP_RETENTION_COUNT,
    DEFAULT_LOCAL_HISTORY_BACKUP_RETENTION_COUNT,
  );
  let cleanupWarning = "";
  if (emptyHistoryAnomaly) {
    cleanupWarning = "本次生成了空备份，为保护已有数据已跳过旧文件清理";
  } else {
    try {
      await cleanupOldBackups(directoryHandle, retentionCount);
    } catch (error) {
      cleanupWarning = `旧备份清理失败：${toErrorMessage(error)}`;
    }
  }

  await setStorageValues({
    [LOCAL_HISTORY_BACKUP_LAST_SUCCESS_AT]: completedAt,
    [LOCAL_HISTORY_BACKUP_LAST_FILE_NAME]: fileName,
    [LOCAL_HISTORY_BACKUP_LAST_RECORD_COUNT]: backupData.includesHistory
      ? backupData.recordCount
      : previousRecordCount,
    [LOCAL_HISTORY_BACKUP_LAST_ERROR]: "",
    [LOCAL_HISTORY_BACKUP_LAST_CLEANUP_WARNING]: cleanupWarning,
    [LOCAL_HISTORY_BACKUP_NEEDS_PERMISSION]: false,
  });

  return {
    success: true,
    fileName,
    recordCount: backupData.recordCount,
    contentCount: backupData.contentCount,
    eventCount: backupData.eventCount,
    summary: [backupData.summary, assetSummary].filter(Boolean).join("，"),
    completedAt,
    cleanupWarning: cleanupWarning || undefined,
  };
};
