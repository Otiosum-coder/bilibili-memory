import {
  AssetKind,
  AssetRecord,
  CollectionArchive,
  DBConfig,
  FollowingEvent,
  FollowingItem,
  FormerNameRecord,
  HistoryCursor,
  HistoryDisplayMode,
  HistoryEvent,
  HistoryEventSource,
  HistoryItem,
  HistoryListItem,
  HistoryTombstone,
  HistoryV2Backup,
  InteractionItem,
  InteractionType,
  LikedMusic,
  SubscribedCollection,
  SubscribedCollectionResource,
  VanishArchiveItem,
  VanishedFavResource,
} from "./types";
import dayjs from "dayjs";
import { recordStorageWarning } from "./storageHealth";
import { estimateJsonBytes } from "./storageFormat";
import { getStorageValue, setStorageValue } from "./storage";
import {
  DELETED_HISTORY_IDS,
  HISTORY_EVENT_MIGRATION_REPORT,
  HISTORY_LEGACY_TOMBSTONES_MIGRATED,
} from "./constants";
import {
  INVALIDATED_TITLE_RE,
  isInvalidatedResource,
  resolveInvalidatedKind,
} from "./favVanishedDiff";
import { isPlaceholderTitle, shouldPreserveLocalMetadata } from "./favRecovery";
import { isPlaceholderImage } from "./imageUrl";
import { mergeRestoredFavorite, mergeVanishArchive } from "./vanishArchive";
import { appendDataSafetyEvent } from "./dataSafetyLog";

const DB_CONFIG: DBConfig = {
  name: "bilibiliHistory",
  version: 14,
  stores: {
    history: {
      keyPath: "id",
      indexes: ["view_at", "view_at_id"],
    },
    historyEvents: {
      keyPath: "event_id",
      indexes: ["view_at", "view_at_event_id", "content_key", "content_key_view_at"],
    },
    historyTombstones: {
      keyPath: "tombstone_id",
      indexes: ["scope", "content_key", "deleted_at"],
    },
    likedMusic: {
      keyPath: "bvid",
      indexes: ["added_at"],
    },
    favFolders: {
      keyPath: "id",
      indexes: ["mid"],
    },
    favResources: {
      keyPath: ["folder_id", "id"],
      indexes: ["id", "folder_id", "fav_time"],
    },
    favMetadataSnapshots: {
      keyPath: ["folder_id", "id"],
      indexes: ["folder_id"],
    },
    subscribedCollections: {
      keyPath: "id",
      indexes: ["mid"],
    },
    subscribedCollectionResources: {
      keyPath: "id",
      indexes: ["collection_id", "pubdate"],
    },
    collectionArchives: {
      keyPath: "id",
      indexes: ["archivedAt", "deletedAt"],
    },
    following: {
      keyPath: "mid",
      indexes: ["status"],
    },
    followingEvents: {
      keyPath: "event_id",
      indexes: ["day", "type", "mid", "occurred_at"],
    },
    assets: {
      keyPath: "id",
      indexes: ["kind"],
    },
    vanishedFavResources: {
      keyPath: ["folder_id", "id"],
      indexes: ["vanishedAt", "vanishReason"],
    },
    interactions: {
      keyPath: "id",
      indexes: ["type", "bvid", "state", "observed_at", "type_observed_at"],
    },
    vanishArchive: {
      keyPath: "id",
      indexes: ["kind", "source", "vanishedAt", "reason"],
    },
    formerNames: {
      keyPath: "mid",
      indexes: ["queriedAt"],
    },
  },
};

let databasePromise: Promise<IDBDatabase> | null = null;

const HISTORY_BUSINESSES = new Set<HistoryItem["business"]>([
  "archive",
  "pgc",
  "article",
  "article-list",
  "live",
  "cheese",
]);

export const getHistoryContentKey = (item: Pick<HistoryItem, "business" | "id">): string =>
  `${item.business}:${item.id}`;

export const getHistoryEventId = (item: Pick<HistoryItem, "business" | "id" | "view_at">): string =>
  `${getHistoryContentKey(item)}:${item.view_at}`;

const createHistoryEvent = (
  item: HistoryItem,
  _source: HistoryEventSource,
  observedAt = Date.now(),
): HistoryEvent | null => {
  const id = Number(item.id);
  const viewAt = Number(item.view_at);
  if (
    !HISTORY_BUSINESSES.has(item.business) ||
    !Number.isSafeInteger(id) ||
    id <= 0 ||
    !Number.isSafeInteger(viewAt) ||
    viewAt <= 0
  ) {
    return null;
  }

  const { uploaded: _uploaded, ...snapshot } = item;
  const normalized = { ...snapshot, id, view_at: viewAt } as Omit<HistoryItem, "uploaded">;
  return {
    ...normalized,
    event_id: getHistoryEventId(normalized),
    content_key: getHistoryContentKey(normalized),
    observed_at: observedAt,
    schema_version: 1,
  };
};

const requestResult = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const transactionDone = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted"));
  });

export const openDB = (): Promise<IDBDatabase> => {
  if (databasePromise) return databasePromise;

  const connectionPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_CONFIG.name, DB_CONFIG.version);
    let migrationReport: { migrated: number; skipped: number; completed_at: number } | null = null;

    request.onerror = () => {
      if (databasePromise === connectionPromise) databasePromise = null;
      void recordStorageWarning(request.error, "open-history-database");
      reject(request.error);
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => {
        database.close();
        if (databasePromise === connectionPromise) databasePromise = null;
      };
      database.addEventListener("close", () => {
        if (databasePromise === connectionPromise) databasePromise = null;
      });

      if (!migrationReport) {
        resolve(database);
        return;
      }
      void setStorageValue(HISTORY_EVENT_MIGRATION_REPORT, migrationReport).then(
        () => resolve(database),
        () => resolve(database),
      );
    };

    request.onupgradeneeded = (event) => {
      console.log("onupgradeneeded");
      const db = (event.target as IDBOpenDBRequest).result;
      const transaction = (event.target as IDBOpenDBRequest).transaction!;
      const oldVersion = event.oldVersion;
      const newVersion = event.newVersion || DB_CONFIG.version;

      console.log(`数据库升级: ${oldVersion} -> ${newVersion}`);

      // 首次创建数据库 (oldVersion === 0)
      if (oldVersion === 0) {
        const historyStore = db.createObjectStore("history", { keyPath: "id" });
        historyStore.createIndex("view_at", "view_at", { unique: false });
        historyStore.createIndex("view_at_id", ["view_at", "id"], { unique: false });

        const historyEventsStore = db.createObjectStore("historyEvents", {
          keyPath: "event_id",
        });
        historyEventsStore.createIndex("view_at", "view_at", { unique: false });
        historyEventsStore.createIndex("view_at_event_id", ["view_at", "event_id"], {
          unique: false,
        });
        historyEventsStore.createIndex("content_key", "content_key", { unique: false });
        historyEventsStore.createIndex("content_key_view_at", ["content_key", "view_at"], {
          unique: false,
        });

        const historyTombstonesStore = db.createObjectStore("historyTombstones", {
          keyPath: "tombstone_id",
        });
        historyTombstonesStore.createIndex("scope", "scope", { unique: false });
        historyTombstonesStore.createIndex("content_key", "content_key", { unique: false });
        historyTombstonesStore.createIndex("deleted_at", "deleted_at", { unique: false });

        const likedMusicStore = db.createObjectStore("likedMusic", {
          keyPath: "bvid",
        });
        likedMusicStore.createIndex("added_at", "added_at", { unique: false });

        const favFoldersStore = db.createObjectStore("favFolders", {
          keyPath: "id",
        });
        favFoldersStore.createIndex("mid", "mid", { unique: false });

        const favResourcesStore = db.createObjectStore("favResources", {
          keyPath: ["folder_id", "id"],
        });
        favResourcesStore.createIndex("id", "id", { unique: false });
        favResourcesStore.createIndex("folder_id", "folder_id", { unique: false });
        favResourcesStore.createIndex("fav_time", "fav_time", { unique: false });

        const subscribedCollectionsStore = db.createObjectStore("subscribedCollections", {
          keyPath: "id",
        });
        subscribedCollectionsStore.createIndex("mid", "mid", { unique: false });

        const subscribedCollectionResourcesStore = db.createObjectStore(
          "subscribedCollectionResources",
          { keyPath: "id" },
        );
        subscribedCollectionResourcesStore.createIndex("collection_id", "collection_id", {
          unique: false,
        });
        subscribedCollectionResourcesStore.createIndex("pubdate", "pubdate", { unique: false });

        console.log("首次创建数据库和所有表");
      }

      // 从版本1升级：重命名viewTime字段为view_at
      if (oldVersion >= 1 && oldVersion < 2) {
        console.log("开始迁移数据：viewTime -> view_at");

        const store = transaction.objectStore("history");

        if (store.indexNames.contains("viewTime")) {
          store.deleteIndex("viewTime");
          console.log("删除旧的viewTime索引");
        }

        if (!store.indexNames.contains("view_at")) {
          store.createIndex("view_at", "view_at", { unique: false });
          console.log("创建新的view_at索引");
        }
        if (!store.indexNames.contains("view_at_id")) {
          store.createIndex("view_at_id", ["view_at", "id"], { unique: false });
        }

        const getAllRequest = store.getAll();
        getAllRequest.onsuccess = () => {
          const allRecords = getAllRequest.result;
          console.log(`开始迁移 ${allRecords.length} 条记录`);

          allRecords.forEach((record: any) => {
            if (record.viewTime !== undefined) {
              record.view_at = record.viewTime;
              delete record.viewTime;
              store.put(record);
            }
          });

          console.log("数据迁移完成");
        };

        getAllRequest.onerror = () => {
          console.error("数据迁移失败:", getAllRequest.error);
        };
      }

      if (oldVersion >= 1 && oldVersion < 7 && db.objectStoreNames.contains("favResources")) {
        const oldStore = transaction.objectStore("favResources");
        const getAllRequest = oldStore.getAll();
        getAllRequest.onsuccess = () => {
          const resources = getAllRequest.result;
          db.deleteObjectStore("favResources");
          const newStore = db.createObjectStore("favResources", {
            keyPath: ["folder_id", "id"],
          });
          newStore.createIndex("id", "id", { unique: false });
          newStore.createIndex("folder_id", "folder_id", { unique: false });
          newStore.createIndex("fav_time", "fav_time", { unique: false });
          let skipped = 0;
          resources.forEach((resource) => {
            const folderId = Number(resource.folder_id);
            const id = Number(resource.id);
            if (
              Number.isSafeInteger(folderId) &&
              folderId > 0 &&
              Number.isSafeInteger(id) &&
              id > 0
            ) {
              newStore.put({ ...resource, folder_id: folderId, id });
            } else {
              skipped++;
            }
          });
          if (skipped > 0) {
            console.warn(`收藏资源迁移跳过 ${skipped} 条无效记录`);
          }
        };
        getAllRequest.onerror = () => transaction.abort();
      }

      if (oldVersion >= 1 && oldVersion < 8) {
        let historyEventsStore: IDBObjectStore;
        if (!db.objectStoreNames.contains("historyEvents")) {
          historyEventsStore = db.createObjectStore("historyEvents", { keyPath: "event_id" });
          historyEventsStore.createIndex("view_at", "view_at", { unique: false });
          historyEventsStore.createIndex("view_at_event_id", ["view_at", "event_id"], {
            unique: false,
          });
          historyEventsStore.createIndex("content_key", "content_key", { unique: false });
          historyEventsStore.createIndex("content_key_view_at", ["content_key", "view_at"], {
            unique: false,
          });
        } else {
          historyEventsStore = transaction.objectStore("historyEvents");
        }

        if (!db.objectStoreNames.contains("historyTombstones")) {
          const tombstonesStore = db.createObjectStore("historyTombstones", {
            keyPath: "tombstone_id",
          });
          tombstonesStore.createIndex("scope", "scope", { unique: false });
          tombstonesStore.createIndex("content_key", "content_key", { unique: false });
          tombstonesStore.createIndex("deleted_at", "deleted_at", { unique: false });
        }

        if (db.objectStoreNames.contains("history")) {
          const historyStore = transaction.objectStore("history");
          if (!historyStore.indexNames.contains("view_at_id")) {
            historyStore.createIndex("view_at_id", ["view_at", "id"], { unique: false });
          }
          let migrated = 0;
          let skipped = 0;
          const cursorRequest = historyStore.openCursor();
          cursorRequest.onsuccess = () => {
            const cursor = cursorRequest.result;
            if (!cursor) {
              migrationReport = {
                migrated,
                skipped,
                completed_at: Date.now(),
              };
              return;
            }
            const item = cursor.value as HistoryItem;
            const event = createHistoryEvent(item, "migration");
            if (event) {
              historyEventsStore.put(event);
              migrated++;
            } else {
              skipped++;
            }
            cursor.continue();
          };
        }
      }

      // v9：关注追踪与内容保全所需的新 store。
      // 覆盖两条路径：全新安装（oldVersion === 0）与从任意旧版本升级；
      // contains 判断使其具备幂等性，也顺带修补历史版本遗留的 store 缺失。
      if (oldVersion < 9) {
        if (!db.objectStoreNames.contains("following")) {
          const followingStore = db.createObjectStore("following", { keyPath: "mid" });
          followingStore.createIndex("status", "status", { unique: false });
        }

        if (!db.objectStoreNames.contains("followingEvents")) {
          const followingEventsStore = db.createObjectStore("followingEvents", {
            keyPath: "event_id",
          });
          followingEventsStore.createIndex("day", "day", { unique: false });
          followingEventsStore.createIndex("type", "type", { unique: false });
          followingEventsStore.createIndex("mid", "mid", { unique: false });
          followingEventsStore.createIndex("occurred_at", "occurred_at", { unique: false });
        }

        if (!db.objectStoreNames.contains("assets")) {
          const assetsStore = db.createObjectStore("assets", { keyPath: "id" });
          assetsStore.createIndex("kind", "kind", { unique: false });
        }

        if (!db.objectStoreNames.contains("vanishedFavResources")) {
          const vanishedStore = db.createObjectStore("vanishedFavResources", {
            keyPath: ["folder_id", "id"],
          });
          vanishedStore.createIndex("vanishedAt", "vanishedAt", { unique: false });
          vanishedStore.createIndex("vanishReason", "vanishReason", { unique: false });
        }

        console.log("v9: 已创建关注追踪与内容保全所需的 store");
      }

      // v10：点赞 / 投币互动记录。
      // 索引里刻意没有 `lastSeenOnlineAt`：它的用途是"按最近可见时间取出探测候选"，
      // 而候选集本身很小（只含掉出列表的条目），在内存里排一次足够，不值得多维护一个索引。
      if (oldVersion < 10) {
        if (!db.objectStoreNames.contains("interactions")) {
          const interactionsStore = db.createObjectStore("interactions", { keyPath: "id" });
          interactionsStore.createIndex("type", "type", { unique: false });
          interactionsStore.createIndex("bvid", "bvid", { unique: false });
          interactionsStore.createIndex("state", "state", { unique: false });
          interactionsStore.createIndex("observed_at", "lastSeenAt", { unique: false });
          interactionsStore.createIndex("type_observed_at", ["type", "lastSeenAt"], {
            unique: false,
          });
        }

        console.log("v10: 已创建点赞 / 投币互动记录所需的 store");
      }

      // v11：统一消失档案。收藏 / 订阅合集 / 关注 / 互动四处的"内容查不到了"统一存这里。
      // 保留 `vanishedFavResources` 不动（旧备份与旧版本仍要能读写），
      // 旧档案在页面首次打开时惰性迁入（见 `utils/vanishArchive.ts`）。
      if (oldVersion < 11) {
        if (!db.objectStoreNames.contains("vanishArchive")) {
          const archiveStore = db.createObjectStore("vanishArchive", { keyPath: "id" });
          archiveStore.createIndex("kind", "kind", { unique: false });
          archiveStore.createIndex("source", "source", { unique: false });
          archiveStore.createIndex("vanishedAt", "vanishedAt", { unique: false });
          archiveStore.createIndex("reason", "reason", { unique: false });
        }

        console.log("v11: 已创建统一消失档案所需的 store");
      }

      // v12：第三方曾用名独立存档。
      // 以前它存在 following 条目里，会随关注同步的整份快照 / WebDAV 合并被覆盖，
      // 查一次 1.5 秒的数据说没就没。这里独立成 store，升级时把旧数据搬过来。
      if (oldVersion < 12) {
        if (!db.objectStoreNames.contains("formerNames")) {
          const formerNamesStore = db.createObjectStore("formerNames", { keyPath: "mid" });
          formerNamesStore.createIndex("queriedAt", "queriedAt", { unique: false });
        }
        console.log("v12: 已创建第三方曾用名独立存档");
      }

      // v13：合集级消失档案。合集壳从订阅目录消失后，原来的名字/封面/UP
      // 需要单独留一份；视频条目仍留在 subscribedCollectionResources，详情页按 id 读取。
      if (oldVersion < 13) {
        if (!db.objectStoreNames.contains("collectionArchives")) {
          const collectionArchiveStore = db.createObjectStore("collectionArchives", {
            keyPath: "id",
          });
          collectionArchiveStore.createIndex("archivedAt", "archivedAt", { unique: false });
          collectionArchiveStore.createIndex("deletedAt", "deletedAt", { unique: false });
        }
        console.log("v13: 已创建合集级消失档案 store");
      }

      if (oldVersion > 0 && oldVersion < 12 && db.objectStoreNames.contains("following")) {
        const source = transaction.objectStore("following");
        const target = transaction.objectStore("formerNames");
        const cursorRequest = source.openCursor();
        let migratedFormerNames = 0;
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (!cursor) {
            console.log(`v12: 迁移曾用名存档 ${migratedFormerNames} 条`);
            return;
          }
          const item = cursor.value as FollowingItem;
          const hasNames = (item.thirdPartyNames?.length ?? 0) > 0;
          if (hasNames || item.thirdPartyQueriedAt || typeof item.formerNameDisplayIndex === "number") {
            target.put({
              mid: item.mid,
              names: item.thirdPartyNames ?? [],
              queriedAt: item.thirdPartyQueriedAt ?? 0,
              displayIndex: item.formerNameDisplayIndex,
              updatedAt: Date.now(),
            });
            migratedFormerNames++;
          }
          cursor.continue();
        };
      }

      if (!db.objectStoreNames.contains("vanishArchive")) {
        console.log("补创建vanishArchive表");
        const archiveStore = db.createObjectStore("vanishArchive", { keyPath: "id" });
        archiveStore.createIndex("kind", "kind", { unique: false });
        archiveStore.createIndex("source", "source", { unique: false });
        archiveStore.createIndex("vanishedAt", "vanishedAt", { unique: false });
        archiveStore.createIndex("reason", "reason", { unique: false });
      }

      // 兜底修复：检查并补创建所有缺失的 store
      // 修复旧版本 else-if 互斥导致部分 store 未创建的问题
      if (!db.objectStoreNames.contains("history")) {
        console.log("补创建history表");
        const historyStore = db.createObjectStore("history", { keyPath: "id" });
        historyStore.createIndex("view_at", "view_at", { unique: false });
        historyStore.createIndex("view_at_id", ["view_at", "id"], { unique: false });
      }

      if (!db.objectStoreNames.contains("historyEvents")) {
        const historyEventsStore = db.createObjectStore("historyEvents", {
          keyPath: "event_id",
        });
        historyEventsStore.createIndex("view_at", "view_at", { unique: false });
        historyEventsStore.createIndex("view_at_event_id", ["view_at", "event_id"], {
          unique: false,
        });
        historyEventsStore.createIndex("content_key", "content_key", { unique: false });
        historyEventsStore.createIndex("content_key_view_at", ["content_key", "view_at"], {
          unique: false,
        });
      }

      if (!db.objectStoreNames.contains("historyTombstones")) {
        const tombstonesStore = db.createObjectStore("historyTombstones", {
          keyPath: "tombstone_id",
        });
        tombstonesStore.createIndex("scope", "scope", { unique: false });
        tombstonesStore.createIndex("content_key", "content_key", { unique: false });
        tombstonesStore.createIndex("deleted_at", "deleted_at", { unique: false });
      }

      if (!db.objectStoreNames.contains("likedMusic")) {
        console.log("补创建likedMusic表");
        const likedMusicStore = db.createObjectStore("likedMusic", {
          keyPath: "bvid",
        });
        likedMusicStore.createIndex("added_at", "added_at", { unique: false });
      }

      if (!db.objectStoreNames.contains("favFolders")) {
        console.log("补创建favFolders表");
        const favFoldersStore = db.createObjectStore("favFolders", {
          keyPath: "id",
        });
        favFoldersStore.createIndex("mid", "mid", { unique: false });
      }

      if (!db.objectStoreNames.contains("favResources")) {
        console.log("补创建favResources表");
        const favResourcesStore = db.createObjectStore("favResources", {
          keyPath: ["folder_id", "id"],
        });
        favResourcesStore.createIndex("id", "id", { unique: false });
        favResourcesStore.createIndex("folder_id", "folder_id", { unique: false });
        favResourcesStore.createIndex("fav_time", "fav_time", { unique: false });
      }

      if (!db.objectStoreNames.contains("favMetadataSnapshots")) {
        console.log("补创建favMetadataSnapshots表");
        const snapshotStore = db.createObjectStore("favMetadataSnapshots", {
          keyPath: ["folder_id", "id"],
        });
        snapshotStore.createIndex("folder_id", "folder_id", { unique: false });
      }

      if (!db.objectStoreNames.contains("subscribedCollections")) {
        const subscribedCollectionsStore = db.createObjectStore("subscribedCollections", {
          keyPath: "id",
        });
        subscribedCollectionsStore.createIndex("mid", "mid", { unique: false });
      }

      if (!db.objectStoreNames.contains("subscribedCollectionResources")) {
        const subscribedCollectionResourcesStore = db.createObjectStore(
          "subscribedCollectionResources",
          { keyPath: "id" },
        );
        subscribedCollectionResourcesStore.createIndex("collection_id", "collection_id", {
          unique: false,
        });
        subscribedCollectionResourcesStore.createIndex("pubdate", "pubdate", { unique: false });
      }

      if (!db.objectStoreNames.contains("following")) {
        console.log("补创建following表");
        const followingStore = db.createObjectStore("following", { keyPath: "mid" });
        followingStore.createIndex("status", "status", { unique: false });
      }

      if (!db.objectStoreNames.contains("followingEvents")) {
        console.log("补创建followingEvents表");
        const followingEventsStore = db.createObjectStore("followingEvents", {
          keyPath: "event_id",
        });
        followingEventsStore.createIndex("day", "day", { unique: false });
        followingEventsStore.createIndex("type", "type", { unique: false });
        followingEventsStore.createIndex("mid", "mid", { unique: false });
        followingEventsStore.createIndex("occurred_at", "occurred_at", { unique: false });
      }

      if (!db.objectStoreNames.contains("assets")) {
        console.log("补创建assets表");
        const assetsStore = db.createObjectStore("assets", { keyPath: "id" });
        assetsStore.createIndex("kind", "kind", { unique: false });
      }

      if (!db.objectStoreNames.contains("vanishedFavResources")) {
        console.log("补创建vanishedFavResources表");
        const vanishedStore = db.createObjectStore("vanishedFavResources", {
          keyPath: ["folder_id", "id"],
        });
        vanishedStore.createIndex("vanishedAt", "vanishedAt", { unique: false });
        vanishedStore.createIndex("vanishReason", "vanishReason", { unique: false });
      }

      if (!db.objectStoreNames.contains("interactions")) {
        console.log("补创建interactions表");
        const interactionsStore = db.createObjectStore("interactions", { keyPath: "id" });
        interactionsStore.createIndex("type", "type", { unique: false });
        interactionsStore.createIndex("bvid", "bvid", { unique: false });
        interactionsStore.createIndex("state", "state", { unique: false });
        interactionsStore.createIndex("observed_at", "lastSeenAt", { unique: false });
        interactionsStore.createIndex("type_observed_at", ["type", "lastSeenAt"], {
          unique: false,
        });
      }

      if (!db.objectStoreNames.contains("formerNames")) {
        console.log("补创建formerNames表");
        const formerNamesStore = db.createObjectStore("formerNames", { keyPath: "mid" });
        formerNamesStore.createIndex("queriedAt", "queriedAt", { unique: false });
      }

      if (!db.objectStoreNames.contains("collectionArchives")) {
        console.log("补创建collectionArchives表");
        const collectionArchiveStore = db.createObjectStore("collectionArchives", {
          keyPath: "id",
        });
        collectionArchiveStore.createIndex("archivedAt", "archivedAt", { unique: false });
        collectionArchiveStore.createIndex("deletedAt", "deletedAt", { unique: false });
      }
    };
  });

  databasePromise = connectionPromise;
  return connectionPromise;
};

let legacyHistoryTombstoneMigration: Promise<void> | null = null;

export const ensureLegacyHistoryTombstonesMigrated = async (): Promise<void> => {
  if (legacyHistoryTombstoneMigration) return legacyHistoryTombstoneMigration;

  legacyHistoryTombstoneMigration = (async () => {
    const migrated = await getStorageValue(HISTORY_LEGACY_TOMBSTONES_MIGRATED, false);
    if (migrated) return;

    const deletedIds = await getStorageValue<number[]>(DELETED_HISTORY_IDS, []);
    if (deletedIds.length === 0) {
      await setStorageValue(HISTORY_LEGACY_TOMBSTONES_MIGRATED, true);
      return;
    }

    const db = await openDB();
    const readTx = db.transaction("history", "readonly");
    const historyStore = readTx.objectStore("history");
    const validIds = deletedIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0);
    const items = await Promise.all(
      validIds.map((id) => requestResult(historyStore.get(id)) as Promise<HistoryItem | undefined>),
    );
    const tx = db.transaction("historyTombstones", "readwrite");
    const tombstoneStore = tx.objectStore("historyTombstones");
    const migratedAt = Date.now();
    const migratedThrough = Math.floor(migratedAt / 1000);

    validIds.forEach((id, index) => {
      const item = items[index];
      if (item && HISTORY_BUSINESSES.has(item.business)) {
        const contentKey = getHistoryContentKey(item);
        tombstoneStore.put({
          tombstone_id: `content:${contentKey}`,
          scope: "content",
          content_key: contentKey,
          deleted_through_view_at: Number(item.view_at) || migratedThrough,
          deleted_at: migratedAt,
          source: "import",
        } satisfies HistoryTombstone);
      } else {
        tombstoneStore.put({
          tombstone_id: `legacy:${id}`,
          scope: "legacy-id",
          legacy_id: id,
          deleted_through_view_at: migratedThrough,
          deleted_at: migratedAt,
          source: "import",
        } satisfies HistoryTombstone);
      }
    });

    await transactionDone(tx);
    await setStorageValue(HISTORY_LEGACY_TOMBSTONES_MIGRATED, true);
  })().catch((error) => {
    legacyHistoryTombstoneMigration = null;
    throw error;
  });

  return legacyHistoryTombstoneMigration;
};

const isBlockedByTombstone = (
  tombstones: HistoryTombstone[],
  event: HistoryEvent,
  legacyDeletedIds?: ReadonlySet<number>,
): boolean => {
  if (legacyDeletedIds?.has(event.id)) return true;
  return eventMatchesTombstones(event, tombstones);
};

export const upsertHistorySnapshots = async (
  history: HistoryItem[],
  source: HistoryEventSource = "bilibili",
  legacyDeletedIds?: ReadonlySet<number>,
): Promise<{
  newEvents: number;
  updatedEvents: number;
  updatedLatest: number;
  skippedByTombstone: number;
}> => {
  if (history.length === 0) {
    return { newEvents: 0, updatedEvents: 0, updatedLatest: 0, skippedByTombstone: 0 };
  }

  await ensureLegacyHistoryTombstonesMigrated();
  const db = await openDB();
  const normalizedEvents = history
    .map((item) => createHistoryEvent(item, source))
    .filter((event): event is HistoryEvent => Boolean(event));
  const tombstones = await getAllHistoryTombstones();
  const acceptedEvents = normalizedEvents.filter(
    (event) => !isBlockedByTombstone(tombstones, event, legacyDeletedIds),
  );
  const skippedByTombstone = normalizedEvents.length - acceptedEvents.length;
  const invalidCount = history.length - normalizedEvents.length;
  if (invalidCount > 0) console.warn(`跳过 ${invalidCount} 条非法历史记录`);
  if (acceptedEvents.length === 0) {
    return {
      newEvents: 0,
      updatedEvents: 0,
      updatedLatest: 0,
      skippedByTombstone,
    };
  }

  const readTx = db.transaction(["history", "historyEvents"], "readonly");
  const readLatestStore = readTx.objectStore("history");
  const readEventStore = readTx.objectStore("historyEvents");
  const existingEventsPromise = Promise.all(
    acceptedEvents.map(
      (event) =>
        requestResult(readEventStore.get(event.event_id)) as Promise<HistoryEvent | undefined>,
    ),
  );
  const existingLatestPromise = Promise.all(
    acceptedEvents.map(
      (event) => requestResult(readLatestStore.get(event.id)) as Promise<HistoryItem | undefined>,
    ),
  );
  const [existingEvents, existingLatestItems] = await Promise.all([
    existingEventsPromise,
    existingLatestPromise,
  ]);

  const tx = db.transaction(["history", "historyEvents"], "readwrite");
  const latestStore = tx.objectStore("history");
  const eventStore = tx.objectStore("historyEvents");
  const done = transactionDone(tx);
  let newEvents = 0;
  let updatedEvents = 0;
  let updatedLatest = 0;

  try {
    acceptedEvents.forEach((event, index) => {
      const existingEvent = existingEvents[index];
      eventStore.put({
        ...event,
        observed_at: existingEvent?.observed_at ?? event.observed_at,
      });
      if (existingEvent) updatedEvents++;
      else newEvents++;
    });

    const newestBatchEventById = new Map<number, { event: HistoryEvent; index: number }>();
    acceptedEvents.forEach((event, index) => {
      const current = newestBatchEventById.get(event.id);
      if (!current || event.view_at >= current.event.view_at) {
        newestBatchEventById.set(event.id, { event, index });
      }
    });
    newestBatchEventById.forEach(({ event, index }) => {
      const existingLatest = existingLatestItems[index];
      if (!existingLatest || event.view_at >= Number(existingLatest.view_at)) {
        const {
          event_id: _eventId,
          content_key: _contentKey,
          observed_at: _observedAt,
          schema_version: _schemaVersion,
          ...latest
        } = event;
        latestStore.put({
          ...latest,
          uploaded:
            existingLatest && event.view_at === Number(existingLatest.view_at)
              ? existingLatest.uploaded === true
              : false,
        });
        updatedLatest++;
      }
    });

    await done;
    return { newEvents, updatedEvents, updatedLatest, skippedByTombstone };
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // The transaction may already have aborted.
    }
    void recordStorageWarning(error, "save-history-transaction");
    throw error;
  }
};

export const saveHistory = async (history: HistoryItem[]): Promise<void> => {
  await upsertHistorySnapshots(history, "legacy-import");
};

const matchCondition = (
  item: HistoryListItem,
  keyword: string,
  dateRange: { start: string; end: string } | null,
  businessType: string,
  searchType: "all" | "title" | "up" | "bvid" | "avid" = "all",
) => {
  return (
    matchKeyword(item, keyword, searchType) &&
    matchDate(item, dateRange) &&
    matchBusinessType(item, businessType)
  );
};

const matchBusinessType = (item: HistoryListItem, businessType: string) => {
  if (!businessType || businessType === "all") return true;
  // 专栏有两种类型：article 和 article-list，这里统一处理
  if (businessType === "article") {
    return item.business === "article" || item.business === "article-list";
  }
  return item.business === businessType;
};

const matchDate = (item: HistoryListItem, dateRange: { start: string; end: string } | null) => {
  if (!dateRange || !dateRange.start) {
    return true;
  }
  const ts = Number(item.view_at);
  const d = dayjs(ts * 1000);
  const dateStr = d.format("YYYY-MM-DD");

  if (dateRange.start && !dateRange.end) {
    return dateStr === dateRange.start;
  }
  if (dateRange.start && dateRange.end) {
    return dateStr >= dateRange.start && dateStr <= dateRange.end;
  }
  return true;
};

const matchKeyword = (
  item: HistoryListItem,
  keyword: string,
  searchType: "all" | "title" | "up" | "bvid" | "avid" = "all",
) => {
  if (!keyword) return true;
  const lowerKeyword = keyword.toLowerCase();

  switch (searchType) {
    case "title":
      return item.title.toLowerCase().includes(lowerKeyword);
    case "up":
      return (
        item.author_name.toLowerCase().includes(lowerKeyword) ||
        (item.author_mid && String(item.author_mid).toLowerCase().includes(lowerKeyword))
      );
    case "bvid":
      return item.bvid && item.bvid.toLowerCase().includes(lowerKeyword);
    case "avid":
      return item.id && String(item.id).includes(lowerKeyword);
    case "all":
    default:
      return (
        item.title.toLowerCase().includes(lowerKeyword) ||
        item.author_name.toLowerCase().includes(lowerKeyword) ||
        (item.bvid && item.bvid.toLowerCase().includes(lowerKeyword)) ||
        (item.author_mid && String(item.author_mid).toLowerCase().includes(lowerKeyword)) ||
        (item.id && String(item.id).includes(lowerKeyword))
      );
  }
};

export const getTotalHistoryCount = async (
  mode: HistoryDisplayMode = "content",
): Promise<number> => {
  const db = await openDB();
  const storeName = mode === "visit" ? "historyEvents" : "history";
  const tx = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);

  return new Promise<number>((resolve, reject) => {
    const request = store.count();

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      console.error("获取历史记录总数失败:", request.error);
      reject(request.error);
    };
  });
};

export const getHistory = async (
  cursor: HistoryCursor | null = null,
  pageSize: number = 20,
  keyword: string = "",
  dateRange: { start: string; end: string } | null = null,
  businessType: string = "",
  searchType: "all" | "title" | "up" | "bvid" | "avid" = "all",
  mode: HistoryDisplayMode = "content",
): Promise<{ items: HistoryListItem[]; hasMore: boolean }> => {
  const db = await openDB();
  const storeName = mode === "visit" ? "historyEvents" : "history";
  const tx = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);
  const index = store.index(mode === "visit" ? "view_at_event_id" : "view_at_id");

  const range = cursor
    ? mode === "visit"
      ? IDBKeyRange.upperBound([cursor.view_at, cursor.event_id || ""], true)
      : IDBKeyRange.upperBound([cursor.view_at, cursor.id || 0], true)
    : null;

  // 使用游标按view_at降序获取指定页的数据
  const request = index.openCursor(range, "prev");
  const items: HistoryListItem[] = [];
  let hasMore = false;

  return new Promise((resolve, reject) => {
    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result as IDBCursorWithValue;

      if (cursor) {
        const value = cursor.value as HistoryListItem;

        // 还没收集够一页：匹配的记录入列，继续扫描
        if (items.length < pageSize) {
          if (matchCondition(value, keyword, dateRange, businessType, searchType)) {
            items.push(value);
          }
          cursor.continue();
        } else if (matchCondition(value, keyword, dateRange, businessType, searchType)) {
          // 已收集够一页，但后面还有匹配项才算"还有更多"，避免被过滤项误报
          hasMore = true;
          resolve({
            items,
            hasMore,
          });
        } else {
          cursor.continue();
        }
      } else {
        // 没有更多数据了
        resolve({
          items,
          hasMore,
        });
      }
    };

    request.onerror = () => reject(request.error);
  });
};

// offset-based pagination for the history page: one cursor pass collects
// the requested page and counts all matched records for the paginator
export const getHistoryPage = async (
  page: number = 1,
  pageSize: number = 20,
  keyword: string = "",
  dateRange: { start: string; end: string } | null = null,
  businessType: string = "",
  searchType: "all" | "title" | "up" | "bvid" | "avid" = "all",
  mode: HistoryDisplayMode = "content",
): Promise<{ items: HistoryListItem[]; total: number }> => {
  const db = await openDB();
  const storeName = mode === "visit" ? "historyEvents" : "history";
  const tx = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);
  const index = store.index(mode === "visit" ? "view_at_event_id" : "view_at_id");

  const request = index.openCursor(null, "prev");
  const offset = (page - 1) * pageSize;
  const items: HistoryListItem[] = [];
  let total = 0;

  return new Promise((resolve, reject) => {
    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result as IDBCursorWithValue;

      if (cursor) {
        const value = cursor.value as HistoryListItem;
        if (matchCondition(value, keyword, dateRange, businessType, searchType)) {
          if (total >= offset && items.length < pageSize) {
            items.push(value);
          }
          total++;
        }
        cursor.continue();
      } else {
        resolve({ items, total });
      }
    };

    request.onerror = () => reject(request.error);
  });
};

/** 清空主数据库中的全部业务数据，保留数据库结构与其他 IndexedDB 数据库。 */
export const clearAllDatabaseTables = async (): Promise<void> => {
  const database = await openDB();
  const storeNames = Object.keys(DB_CONFIG.stores).filter((name) =>
    database.objectStoreNames.contains(name),
  );
  if (storeNames.length === 0) return;

  const transaction = database.transaction(storeNames, "readwrite");
  const done = transactionDone(transaction);
  storeNames.forEach((name) => transaction.objectStore(name).clear());
  await done;
};

export const getItem = async (store: IDBObjectStore, key: string): Promise<any> => {
  return new Promise((resolve) => {
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result);
  });
};

/** 获取本地已删除历史记录的墓碑 id 集合 */
export const getDeletedHistoryIds = async (): Promise<Set<number>> => {
  const ids = await getStorageValue<number[]>(DELETED_HISTORY_IDS, []);
  return new Set(ids.filter((id) => Number.isSafeInteger(id)));
};

/** 删除成功后记录墓碑，供 WebDAV 合并时剔除远端旧数据 */
export const addDeletedHistoryIds = async (ids: number[]): Promise<void> => {
  if (ids.length === 0) return;
  const current = await getDeletedHistoryIds();
  ids.forEach((id) => current.add(id));
  await setStorageValue(DELETED_HISTORY_IDS, [...current]);
};

export const clearHistory = async (): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction(["history", "historyEvents", "historyTombstones"], "readwrite");
  const stores = ["history", "historyEvents", "historyTombstones"].map((name) =>
    tx.objectStore(name),
  );

  return new Promise<void>((resolve, reject) => {
    stores.forEach((store) => store.clear());
    tx.oncomplete = () => {
      console.log("历史记录已清空");
      resolve();
    };
    tx.onerror = () => {
      console.error("清空历史记录失败:", tx.error);
      reject(tx.error);
    };
  });
};

export const deleteHistoryItem = async (id: number): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("history", "readonly");
  const item = (await requestResult(tx.objectStore("history").get(id))) as HistoryItem | undefined;
  if (!item) return;
  await deleteHistoryContent(item.business, id);
};

const historyEventToItem = (event: HistoryEvent, uploaded = false): HistoryItem => {
  const {
    event_id: _eventId,
    content_key: _contentKey,
    observed_at: _observedAt,
    schema_version: _schemaVersion,
    ...item
  } = event;
  return { ...item, uploaded };
};

export const deleteHistoryEvent = async (
  event: HistoryEvent,
  source: HistoryTombstone["source"] = "extension-ui",
): Promise<void> => {
  const db = await openDB();
  const readTx = db.transaction(["history", "historyEvents"], "readonly");
  const latestPromise = requestResult(readTx.objectStore("history").get(event.id)) as Promise<
    HistoryItem | undefined
  >;
  const contentEventsPromise = requestResult(
    readTx.objectStore("historyEvents").index("content_key").getAll(event.content_key),
  ) as Promise<HistoryEvent[]>;
  const [latest, contentEvents] = await Promise.all([latestPromise, contentEventsPromise]);
  const replacement = contentEvents
    .filter((item) => item.event_id !== event.event_id)
    .sort((left, right) => right.view_at - left.view_at)[0];

  const tx = db.transaction(["history", "historyEvents", "historyTombstones"], "readwrite");
  const latestStore = tx.objectStore("history");
  const eventStore = tx.objectStore("historyEvents");
  const tombstoneStore = tx.objectStore("historyTombstones");
  const done = transactionDone(tx);

  tombstoneStore.put({
    tombstone_id: `event:${event.event_id}`,
    scope: "event",
    content_key: event.content_key,
    event_id: event.event_id,
    deleted_through_view_at: event.view_at,
    deleted_at: Date.now(),
    source,
  } satisfies HistoryTombstone);
  eventStore.delete(event.event_id);

  if (latest && latest.business === event.business && Number(latest.view_at) === event.view_at) {
    if (replacement) {
      latestStore.put(historyEventToItem(replacement));
    } else {
      latestStore.delete(event.id);
    }
  }

  await done;
};

export const deleteHistoryContent = async (
  business: HistoryItem["business"],
  id: number,
  source: HistoryTombstone["source"] = "extension-ui",
): Promise<void> => {
  const contentKey = getHistoryContentKey({ business, id });
  const db = await openDB();
  const readTx = db.transaction(["history", "historyEvents"], "readonly");
  const range = IDBKeyRange.only(contentKey);
  const eventsPromise = requestResult(
    readTx.objectStore("historyEvents").index("content_key").getAll(range),
  ) as Promise<HistoryEvent[]>;
  const latestPromise = requestResult(readTx.objectStore("history").get(id)) as Promise<
    HistoryItem | undefined
  >;
  const [events, latest] = await Promise.all([eventsPromise, latestPromise]);
  const cutoff = Math.max(
    0,
    latest?.business === business ? Number(latest.view_at) || 0 : 0,
    ...events.map((item) => Number(item.view_at) || 0),
  );

  const tx = db.transaction(["history", "historyEvents", "historyTombstones"], "readwrite");
  const latestStore = tx.objectStore("history");
  const eventStore = tx.objectStore("historyEvents");
  const tombstoneStore = tx.objectStore("historyTombstones");
  const done = transactionDone(tx);

  tombstoneStore.put({
    tombstone_id: `content:${contentKey}`,
    scope: "content",
    content_key: contentKey,
    deleted_through_view_at: cutoff,
    deleted_at: Date.now(),
    source,
  } satisfies HistoryTombstone);
  events.forEach((item) => eventStore.delete(item.event_id));
  if (latest?.business === business) latestStore.delete(id);
  await done;
};

export interface HistoryCleanupPreview {
  events: number;
  contents: number;
  oldestViewAt: number | null;
  newestViewAt: number | null;
}

export const previewHistoryInRange = async (
  startSec: number,
  endSec: number,
): Promise<HistoryCleanupPreview> => {
  const events = await getHistoryEventsInRange(startSec, endSec);
  const contentKeys = new Set(events.map((event) => event.content_key));
  return {
    events: events.length,
    contents: contentKeys.size,
    oldestViewAt: events.length > 0 ? Math.min(...events.map((event) => event.view_at)) : null,
    newestViewAt: events.length > 0 ? Math.max(...events.map((event) => event.view_at)) : null,
  };
};

/**
 * 删除指定时间范围内的观看记录。
 *
 * 不能只删事件：`history` 里还存着每个内容的最新投影。这里先找出仍保留的
 * 最新事件，更新投影；同时给每条被删事件写 event tombstone，避免下次同步
 * 把同一批记录重新导回来。
 */
export const deleteHistoryInRange = async (
  startSec: number,
  endSec: number,
): Promise<{ eventsDeleted: number; contentsDeleted: number }> => {
  const events = await getHistoryEventsInRange(startSec, endSec);
  if (events.length === 0) return { eventsDeleted: 0, contentsDeleted: 0 };

  const deletedEventIds = new Set(events.map((event) => event.event_id));
  const affectedContentKeys = new Set(events.map((event) => event.content_key));
  const allEvents = await getAllHistoryEvents();
  const latestRemaining = new Map<string, HistoryEvent>();
  for (const event of allEvents) {
    if (deletedEventIds.has(event.event_id)) continue;
    if (!affectedContentKeys.has(event.content_key)) continue;
    const previous = latestRemaining.get(event.content_key);
    if (!previous || event.view_at > previous.view_at) {
      latestRemaining.set(event.content_key, event);
    }
  }

  const latestItems = await getAllHistory();
  const latestByContent = new Map(
    latestItems.map((item) => [
      getHistoryContentKey({ business: item.business, id: item.id }),
      item,
    ]),
  );

  const db = await openDB();
  const tx = db.transaction(["history", "historyEvents", "historyTombstones"], "readwrite");
  const latestStore = tx.objectStore("history");
  const eventStore = tx.objectStore("historyEvents");
  const tombstoneStore = tx.objectStore("historyTombstones");
  const done = transactionDone(tx);
  const now = Date.now();

  for (const event of events) {
    eventStore.delete(event.event_id);
    tombstoneStore.put({
      tombstone_id: `event:${event.event_id}`,
      scope: "event",
      content_key: event.content_key,
      event_id: event.event_id,
      deleted_through_view_at: event.view_at,
      deleted_at: now,
      source: "extension-ui",
    } satisfies HistoryTombstone);
  }

  for (const contentKey of affectedContentKeys) {
    const previousLatest = latestByContent.get(contentKey);
    const replacement = latestRemaining.get(contentKey);
    if (replacement) {
      latestStore.put(historyEventToItem(replacement));
    } else if (previousLatest) {
      latestStore.delete(previousLatest.id);
    }
  }

  await done;
  return { eventsDeleted: events.length, contentsDeleted: affectedContentKeys.size };
};

export const getAllHistory = async (limit?: number): Promise<HistoryItem[]> => {
  const db = await openDB();
  const tx = db.transaction("history", "readonly");
  const store = tx.objectStore("history");
  const index = store.index("view_at");

  return new Promise((resolve, reject) => {
    const request = index.openCursor(null, "prev");
    const items: HistoryItem[] = [];

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result as IDBCursorWithValue;

      if (cursor) {
        items.push(cursor.value as HistoryItem);
        if (limit && items.length >= limit) {
          resolve(items);
        } else {
          cursor.continue();
        }
      } else {
        resolve(items);
      }
    };

    request.onerror = () => reject(request.error);
  });
};

export const getAllHistoryEvents = async (limit?: number): Promise<HistoryEvent[]> => {
  const db = await openDB();
  const tx = db.transaction("historyEvents", "readonly");
  const index = tx.objectStore("historyEvents").index("view_at_event_id");

  return new Promise((resolve, reject) => {
    const request = index.openCursor(null, "prev");
    const items: HistoryEvent[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(items);
        return;
      }
      items.push(cursor.value as HistoryEvent);
      if (limit && items.length >= limit) resolve(items);
      else cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
};

/**
 * 按 `view_at` 索引读取时间区间内的观看事件（含两端）。
 *
 * 与 `getAllHistoryEvents` 的差别：这里走索引做区间游标，只把窗口内的记录读进内存。
 * 观看事件表通常比 `history` 投影大一个数量级，数据面板的按天统计必须先限定窗口。
 */
export const getHistoryEventsInRange = async (
  fromViewAt: number,
  toViewAt: number,
): Promise<HistoryEvent[]> => {
  const db = await openDB();
  const tx = db.transaction("historyEvents", "readonly");
  const index = tx.objectStore("historyEvents").index("view_at");

  return new Promise((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.bound(fromViewAt, toViewAt));
    const items: HistoryEvent[] = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(items);
        return;
      }
      items.push(cursor.value as HistoryEvent);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
};

/**
 * 库里最早一条观看事件的时间（秒级）；没有任何记录时返回 null。
 *
 * 这是"记录起点"的唯一来源：数据面板用它显示"记录自 X"，
 * 也用它判断报告是否已经攒够天数（周报 7 天 / 月报 30 天 / 年报 365 天）。
 * 取的是最早一条**任意类型**的记录——直播与文章虽然不进统计，
 * 但它们同样是"插件开始记录"的时间证据。
 */
export const getEarliestHistoryEventViewAt = async (): Promise<number | null> => {
  const db = await openDB();
  const tx = db.transaction("historyEvents", "readonly");
  const index = tx.objectStore("historyEvents").index("view_at");

  return new Promise((resolve, reject) => {
    const request = index.openCursor(null, "next");
    request.onsuccess = () => {
      const cursor = request.result;
      resolve(cursor ? Number((cursor.value as HistoryEvent).view_at) : null);
    };
    request.onerror = () => reject(request.error);
  });
};

export const getAllHistoryTombstones = async (): Promise<HistoryTombstone[]> => {
  const db = await openDB();
  const tx = db.transaction("historyTombstones", "readonly");
  return requestResult(tx.objectStore("historyTombstones").getAll()) as Promise<HistoryTombstone[]>;
};

export const getHistoryV2Backup = async (): Promise<HistoryV2Backup> => {
  await ensureLegacyHistoryTombstonesMigrated();
  const [events, tombstones] = await Promise.all([
    getAllHistoryEvents(),
    getAllHistoryTombstones(),
  ]);
  return { schemaVersion: 2, events, tombstones, updatedAt: Date.now() };
};

const eventMatchesTombstones = (event: HistoryEvent, tombstones: HistoryTombstone[]): boolean =>
  tombstones.some((tombstone) => {
    if (tombstone.scope === "event") return tombstone.event_id === event.event_id;
    if (event.view_at > Number(tombstone.deleted_through_view_at)) return false;
    if (tombstone.scope === "content") return tombstone.content_key === event.content_key;
    return tombstone.scope === "legacy-id" && tombstone.legacy_id === event.id;
  });

const applyAllHistoryTombstones = async (): Promise<number> => {
  const [events, tombstones, latestItems] = await Promise.all([
    getAllHistoryEvents(),
    getAllHistoryTombstones(),
    getAllHistory(),
  ]);
  const removedEvents = events.filter((event) => eventMatchesTombstones(event, tombstones));
  if (removedEvents.length === 0) return 0;
  const removedEventIds = new Set(removedEvents.map((event) => event.event_id));
  const remaining = events.filter((event) => !removedEventIds.has(event.event_id));
  const affectedIds = new Set(removedEvents.map((event) => event.id));

  const previousLatest = new Map(latestItems.map((item) => [item.id, item]));
  const latestById = new Map<number, HistoryEvent>();
  for (const event of remaining) {
    if (!affectedIds.has(event.id)) continue;
    const current = latestById.get(event.id);
    if (!current || event.view_at > current.view_at) latestById.set(event.id, event);
  }

  const db = await openDB();
  const tx = db.transaction(["history", "historyEvents"], "readwrite");
  const latestStore = tx.objectStore("history");
  const eventStore = tx.objectStore("historyEvents");
  const done = transactionDone(tx);
  removedEvents.forEach((event) => eventStore.delete(event.event_id));
  affectedIds.forEach((id) => {
    const event = latestById.get(id);
    const previous = previousLatest.get(id);
    if (event) {
      latestStore.put(
        historyEventToItem(
          event,
          Boolean(
            previous &&
            previous.business === event.business &&
            previous.view_at === event.view_at &&
            previous.uploaded,
          ),
        ),
      );
    } else if (previous) {
      const previousEvent = createHistoryEvent(previous, "migration");
      if (previousEvent && eventMatchesTombstones(previousEvent, tombstones)) {
        latestStore.delete(id);
      }
    }
  });
  await done;
  return removedEvents.length;
};

export const mergeHistoryV2Backup = async (
  backup: HistoryV2Backup,
): Promise<{ merged: number; skipped: number }> => {
  if (backup?.schemaVersion !== 2 || !Array.isArray(backup.events)) {
    throw new Error("无法识别的历史记录 v2 备份格式");
  }

  const db = await openDB();
  if (Array.isArray(backup.tombstones) && backup.tombstones.length > 0) {
    const existingTombstones = await getAllHistoryTombstones();
    const existingById = new Map(
      existingTombstones.map((tombstone) => [tombstone.tombstone_id, tombstone]),
    );
    const tx = db.transaction("historyTombstones", "readwrite");
    const store = tx.objectStore("historyTombstones");
    const done = transactionDone(tx);
    for (const rawTombstone of backup.tombstones) {
      const cutoff = Number(rawTombstone?.deleted_through_view_at);
      const deletedAt = Number(rawTombstone?.deleted_at);
      if (
        !rawTombstone?.tombstone_id ||
        !["event", "content", "legacy-id"].includes(rawTombstone.scope) ||
        !Number.isSafeInteger(cutoff) ||
        cutoff < 0 ||
        !Number.isFinite(deletedAt) ||
        deletedAt <= 0
      ) {
        continue;
      }
      if (rawTombstone.scope === "event" && !rawTombstone.event_id) continue;
      if (rawTombstone.scope === "content" && !rawTombstone.content_key) continue;
      if (
        rawTombstone.scope === "legacy-id" &&
        (!Number.isSafeInteger(rawTombstone.legacy_id) || Number(rawTombstone.legacy_id) <= 0)
      ) {
        continue;
      }
      const tombstone: HistoryTombstone = {
        ...rawTombstone,
        deleted_through_view_at: cutoff,
        deleted_at: deletedAt,
        source: "import",
      };
      const existing = existingById.get(tombstone.tombstone_id);
      if (!existing) {
        store.put(tombstone);
      } else {
        store.put({
          ...existing,
          ...tombstone,
          deleted_at: Math.max(existing.deleted_at, tombstone.deleted_at),
          deleted_through_view_at: Math.max(
            existing.deleted_through_view_at,
            tombstone.deleted_through_view_at,
          ),
        } satisfies HistoryTombstone);
      }
    }
    await done;
  }

  const removed = await applyAllHistoryTombstones();

  const snapshots = backup.events.map((event) => historyEventToItem(event));
  const result = await upsertHistorySnapshots(snapshots, "webdav");
  return {
    merged: result.newEvents + result.updatedEvents,
    skipped: result.skippedByTombstone + removed,
  };
};

export const getUnUploadedHistory = async (): Promise<HistoryItem[]> => {
  const db = await openDB();
  const tx = db.transaction("history", "readonly");
  const store = tx.objectStore("history");
  const index = store.index("view_at");

  return new Promise((resolve, reject) => {
    const request = index.openCursor(null, "prev");
    const items: HistoryItem[] = [];

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result as IDBCursorWithValue;

      if (cursor) {
        const item = cursor.value as HistoryItem;
        // 获取uploaded不为true的数据（包括undefined和false）
        if (item.uploaded !== true) {
          items.push(item);
        }
        cursor.continue();
      } else {
        resolve(items);
      }
    };

    request.onerror = () => reject(request.error);
  });
};

export const markHistoryAsUploaded = async (historyItems: HistoryItem[]): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("history", "readwrite");
  const store = tx.objectStore("history");

  return new Promise((resolve, reject) => {
    let operationsCompleted = 0;
    let operationsFailed = false;

    if (historyItems.length === 0) {
      resolve();
      return;
    }

    historyItems.forEach((item) => {
      if (operationsFailed) return;

      // 更新item的uploaded字段
      const updatedItem = { ...item, uploaded: true };
      const request = store.put(updatedItem);

      request.onsuccess = () => {
        operationsCompleted++;
      };

      request.onerror = () => {
        if (!operationsFailed) {
          operationsFailed = true;
          console.error("更新 IndexedDB 中项目的uploaded状态失败:", request.error, "项目:", item);
        }
      };
    });

    tx.oncomplete = () => {
      if (!operationsFailed) {
        console.log(`成功标记 ${historyItems.length} 条历史记录为已上传。`);
        resolve();
      } else {
        reject(new Error("部分或全部历史记录项更新失败，但事务意外完成。"));
      }
    };

    tx.onerror = () => {
      console.error("更新历史记录uploaded状态事务失败:", tx.error);
      reject(tx.error);
    };
  });
};

export const markAllHistoryAsUnuploaded = async (): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("history", "readwrite");
  const store = tx.objectStore("history");

  return new Promise<void>((resolve, reject) => {
    const request = store.openCursor();
    let updatedCount = 0;

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result as IDBCursorWithValue;

      if (cursor) {
        const item = cursor.value as HistoryItem;
        // 只有在尚未标记为未上传时才更新
        if (item.uploaded !== false) {
          const updatedItem = { ...item, uploaded: false };
          const updateRequest = cursor.update(updatedItem);
          updateRequest.onsuccess = () => {
            updatedCount++;
          };
        }
        cursor.continue();
      } else {
        // 游标完成，事务将自动完成。
      }
    };

    request.onerror = () => {
      console.error("在标记所有历史记录为未上传时发生错误:", request.error);
      reject(request.error);
    };

    tx.oncomplete = () => {
      console.log(`成功将 ${updatedCount} 条历史记录标记为未上传。`);
      resolve();
    };

    tx.onerror = () => {
      console.error("标记所有历史记录为未上传的事务失败:", tx.error);
      reject(tx.error);
    };
  });
};

// 喜欢音乐相关函数
export const saveLikedMusic = async (music: LikedMusic): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("likedMusic", "readwrite");
  const store = tx.objectStore("likedMusic");

  return new Promise((resolve, reject) => {
    const request = store.put(music);

    request.onsuccess = () => {
      console.log("喜欢的音乐已保存:", music.title);
      resolve();
    };

    request.onerror = () => {
      console.error("保存喜欢的音乐失败:", request.error);
      reject(request.error);
    };
  });
};

export const isLikedMusic = async (bvid: string): Promise<boolean> => {
  const db = await openDB();
  const tx = db.transaction("likedMusic", "readonly");
  const store = tx.objectStore("likedMusic");

  return new Promise((resolve, reject) => {
    const request = store.get(bvid);

    request.onsuccess = () => {
      resolve(!!request.result);
    };

    request.onerror = () => {
      console.error("检查音乐是否已喜欢失败:", request.error);
      reject(request.error);
    };
  });
};

export const getLikedMusic = async (
  lastAddedTime: number = Date.now(),
  pageSize: number = 20,
  keyword: string = "",
): Promise<{ items: LikedMusic[]; hasMore: boolean }> => {
  const db = await openDB();
  const tx = db.transaction("likedMusic", "readonly");
  const store = tx.objectStore("likedMusic");
  const index = store.index("added_at");

  const range = IDBKeyRange.upperBound(lastAddedTime, true);
  const request = index.openCursor(range, "prev");
  const items: LikedMusic[] = [];
  let hasMore = false;

  return new Promise((resolve, reject) => {
    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result as IDBCursorWithValue;

      if (cursor) {
        const value = cursor.value as LikedMusic;

        if (items.length < pageSize) {
          if (
            !keyword ||
            value.title.toLowerCase().includes(keyword.toLowerCase()) ||
            value.author.toLowerCase().includes(keyword.toLowerCase())
          ) {
            items.push(value);
          }
          cursor.continue();
        } else {
          hasMore = true;
          resolve({ items, hasMore });
        }
      } else {
        resolve({ items, hasMore });
      }
    };

    request.onerror = () => {
      console.error("获取喜欢音乐失败:", request.error);
      reject(request.error);
    };
  });
};

export const getAllLikedMusic = async (): Promise<LikedMusic[]> => {
  const db = await openDB();
  const tx = db.transaction("likedMusic", "readonly");
  const store = tx.objectStore("likedMusic");
  const index = store.index("added_at");

  return new Promise((resolve, reject) => {
    const request = index.openCursor(null, "prev");
    const items: LikedMusic[] = [];

    request.onsuccess = (event) => {
      const cursor = (event.target as IDBRequest).result as IDBCursorWithValue;

      if (cursor) {
        items.push(cursor.value as LikedMusic);
        cursor.continue();
      } else {
        resolve(items);
      }
    };

    request.onerror = () => {
      console.error("获取所有喜欢音乐失败:", request.error);
      reject(request.error);
    };
  });
};

export const getTotalLikedMusicCount = async (): Promise<number> => {
  const db = await openDB();
  const tx = db.transaction("likedMusic", "readonly");
  const store = tx.objectStore("likedMusic");

  return new Promise<number>((resolve, reject) => {
    const request = store.count();

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onerror = () => {
      console.error("获取喜欢音乐总数失败:", request.error);
      reject(request.error);
    };
  });
};

export const deleteLikedMusic = async (bvid: string): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("likedMusic", "readwrite");
  const store = tx.objectStore("likedMusic");

  return new Promise<void>((resolve, reject) => {
    const request = store.delete(bvid);

    request.onsuccess = () => {
      console.log("喜欢的音乐删除成功, bvid =", bvid);
      resolve();
    };

    request.onerror = () => {
      console.error("删除喜欢的音乐失败, bvid =", bvid, request.error);
      reject(request.error);
    };
  });
};

// deleteLikedMusicByBvid 现在与 deleteLikedMusic 功能相同，保留为别名
export const deleteLikedMusicByBvid = deleteLikedMusic;

export const clearLikedMusic = async (): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("likedMusic", "readwrite");
  const store = tx.objectStore("likedMusic");

  return new Promise<void>((resolve, reject) => {
    const request = store.clear();

    request.onsuccess = () => {
      console.log("喜欢的音乐已全部清空");
      resolve();
    };

    request.onerror = () => {
      console.error("清空喜欢的音乐失败:", request.error);
      reject(request.error);
    };
  });
};

export const importLikedMusic = async (musicList: LikedMusic[]): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("likedMusic", "readwrite");
  const store = tx.objectStore("likedMusic");

  return new Promise((resolve, reject) => {
    let operationsCompleted = 0;
    let operationsFailed = false;

    if (musicList.length === 0) {
      resolve();
      return;
    }

    musicList.forEach((music) => {
      if (operationsFailed) return;

      const request = store.put(music);
      request.onsuccess = () => {
        operationsCompleted++;
      };
      request.onerror = () => {
        if (!operationsFailed) {
          operationsFailed = true;
          console.error("向 IndexedDB 中 put 喜欢音乐项目失败:", request.error, "项目:", music);
        }
      };
    });

    tx.oncomplete = () => {
      if (!operationsFailed) {
        console.log("所有喜欢音乐已成功导入。");
        resolve();
      } else {
        reject(new Error("部分或全部喜欢音乐项目导入失败，但事务意外完成。"));
      }
    };

    tx.onerror = () => {
      console.error("导入喜欢音乐事务失败:", tx.error);
      reject(tx.error);
    };
  });
};

import { FavoriteFolder, FavoriteResource } from "./types";

// 收藏夹相关函数
export const saveFavFolders = async (folders: FavoriteFolder[]): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("favFolders", "readwrite");
  const store = tx.objectStore("favFolders");

  return new Promise((resolve, reject) => {
    let operationsCompleted = 0;
    let operationsFailed = false;

    if (folders.length === 0) {
      resolve();
      return;
    }

    folders.forEach((folder) => {
      if (operationsFailed) return;
      const request = store.put(folder);
      request.onsuccess = () => operationsCompleted++;
      request.onerror = () => {
        if (!operationsFailed) {
          operationsFailed = true;
          reject(request.error);
        }
      };
    });

    tx.oncomplete = () => {
      if (!operationsFailed) resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
};

export const replaceFavFolders = async (folders: FavoriteFolder[]): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("favFolders", "readwrite");
  const store = tx.objectStore("favFolders");

  return new Promise((resolve, reject) => {
    const clearRequest = store.clear();
    clearRequest.onsuccess = () => {
      folders.forEach((folder) => store.put(folder));
    };
    clearRequest.onerror = () => reject(clearRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

export const getFavFolders = async (mid?: number): Promise<FavoriteFolder[]> => {
  const db = await openDB();
  const tx = db.transaction("favFolders", "readonly");
  const store = tx.objectStore("favFolders");

  return new Promise((resolve, reject) => {
    let request;
    if (mid) {
      const index = store.index("mid");
      request = index.getAll(mid);
    } else {
      request = store.getAll();
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

/**
 * 写入第三方恢复来的数据。
 *
 * 刻意**绕开** `saveFavResources` 的占位保护：那里判断的是"新数据是不是失效内容"，
 * 而恢复场景写入的正是更好的数据，走保护逻辑反而会被拒。
 */
export const applyFavResourceRecovery = async (
  updates: FavoriteResource[],
): Promise<number> => {
  if (updates.length === 0) return 0;

  const db = await openDB();
  const tx = db.transaction("favResources", "readwrite");
  const store = tx.objectStore("favResources");

  for (const resource of updates) {
    store.put(resource);
  }

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  return updates.length;
};

/**
 * 写入订阅合集内容的封面归档结果。
 *
 * 与 `applyFavResourceRecovery` 同构，只是 store 与主键不同
 * （`subscribedCollectionResources` 用字符串 `id`）。
 */
export const applySubscribedCollectionCoverAssets = async (
  updates: SubscribedCollectionResource[],
): Promise<number> => {
  if (updates.length === 0) return 0;

  const db = await openDB();
  const tx = db.transaction("subscribedCollectionResources", "readwrite");
  const store = tx.objectStore("subscribedCollectionResources");

  for (const resource of updates) {
    store.put(resource);
  }

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  return updates.length;
};

export const saveFavResources = async (resources: FavoriteResource[]): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("favResources", "readwrite");
  const store = tx.objectStore("favResources");

  return new Promise((resolve, reject) => {
    let operationsCompleted = 0;
    let operationsFailed = false;

    if (resources.length === 0) {
      resolve();
      return;
    }

    // 递归处理每一个资源，因为我们需要在put之前可能进行get操作（异步）
    // 虽然可以在事务中并行发起请求，但为了逻辑清晰，我们使用 Promise.all 或者计数器

    // 这里我们直接发起所有请求，利用IndexedDB的事务特性
    resources.forEach((res) => {
      if (operationsFailed) return;

      // 失效判定：以 attr 为主、标题文案为兜底。
      // 原实现只查 title === "已失效视频"，一旦 B 站调整文案，失效保护就会失效并让元数据被占位内容覆盖。
      const invalidatedKind = resolveInvalidatedKind(res.attr);
      if (invalidatedKind !== null || INVALIDATED_TITLE_RE.test(res.title ?? "")) {
        const getReq = store.get([res.folder_id, res.id]);
        getReq.onsuccess = () => {
          const oldData = getReq.result as FavoriteResource | undefined;
          let dataToSave: FavoriteResource = {
            ...res,
            invalidatedKind: invalidatedKind ?? oldData?.invalidatedKind ?? "other",
            // 首次观测到失效的时间只记一次，后续同步不覆盖
            invalidatedAt: oldData?.invalidatedAt ?? Date.now(),
          };

          // 失效保护：本地已有有效数据（或第三方恢复来的数据）时保留其关键元数据。
          // 判定走 shouldPreserveLocalMetadata —— 它额外覆盖了 recoveredAt 的情况，
          // 否则每次同步都会把辛苦查回来的标题换回"已失效视频"。
          if (oldData && shouldPreserveLocalMetadata(oldData)) {
            // 标题/封面分别择优：旧记录可能只有其中一个是真的（比如只补了标题，
            // 封面还是占位），不能因为整体"可保护"就用占位字段盖掉新拿到的真实字段。
            const title =
              isPlaceholderTitle(oldData.title) && !isPlaceholderTitle(dataToSave.title)
                ? dataToSave.title
                : oldData.title;
            const cover =
              isPlaceholderImage(oldData.cover) && !isPlaceholderImage(dataToSave.cover)
                ? dataToSave.cover
                : oldData.cover;
            dataToSave = {
              ...dataToSave,
              title,
              cover,
              // 归档图片的 asset id 必须一起保留，否则封面字节还在 assets 里，
              // 记录却变成远程占位地址，档案页会显示不出图。
              coverAssetId: oldData.coverAssetId ?? dataToSave.coverAssetId,
              intro: oldData.intro ?? dataToSave.intro,
              upper: oldData.upper ?? dataToSave.upper,
              ctime: oldData.ctime || dataToSave.ctime, // 保持创建时间
              pubtime: oldData.pubtime || dataToSave.pubtime,
              bvid: oldData.bvid || oldData.bv_id || dataToSave.bvid,
              bv_id: oldData.bv_id || oldData.bvid || dataToSave.bv_id,
              // 时长必须在保留列表里：稿件失效后 B 站返回的 `duration` 是 0
              // （它自己也不记得这条视频多长了），于是本地那份**基本不变**的时长
              // 会被 0 覆盖掉，而且是不可逆的——再同步也拿不回来了。
              // 时长比标题更能说明"这是哪条内容"，标题会被占位文案顶掉，它不会。
              duration: oldData.duration || dataToSave.duration,
              // recoveredAt 是"这份数据是恢复来的"的保护标记。之前只保留了标题/
              // 封面却漏掉它，下一次同步 shouldPreserveLocalMetadata 就返回 false，
              // 真实元数据会被再次覆盖——这正是"恢复后又被覆盖"的根因。
              recoveredAt: oldData.recoveredAt ?? dataToSave.recoveredAt,
              recoverySource: oldData.recoverySource ?? dataToSave.recoverySource,
            };
            console.log(`[失效保护] 保留了视频 ${oldData.id} 的元数据: ${oldData.title}`);
          }

          const putReq = store.put(dataToSave);
          putReq.onsuccess = () => CheckComplete();
          putReq.onerror = HandleError;
        };
        getReq.onerror = HandleError;
      } else {
        // 正常视频也做一层封面保护：B站偶尔会在 attr 还没变成失效时，
        // 先把 cover 换成占位图。只有新封面是占位图时才读旧记录，
        // 正常封面保持原来的直接写入路径。
        if (isPlaceholderImage(res.cover)) {
          const getReq = store.get([res.folder_id, res.id]);
          getReq.onsuccess = () => {
            const oldData = getReq.result as FavoriteResource | undefined;
            let dataToSave = res;
            if (oldData?.cover && !isPlaceholderImage(oldData.cover)) {
              dataToSave = {
                ...res,
                cover: oldData.cover,
                coverAssetId: oldData.coverAssetId ?? res.coverAssetId,
              };
            }
            const putReq = store.put(dataToSave);
            putReq.onsuccess = () => CheckComplete();
            putReq.onerror = HandleError;
          };
          getReq.onerror = HandleError;
        } else {
          const putReq = store.put(res);
          putReq.onsuccess = () => CheckComplete();
          putReq.onerror = HandleError;
        }
      }

      function HandleError(e: Event) {
        if (!operationsFailed) {
          operationsFailed = true;
          reject((e.target as IDBRequest).error);
        }
      }

      function CheckComplete() {
        operationsCompleted++;
        if (operationsCompleted === resources.length && !operationsFailed) {
          // 此时不能resolve，因为外层还有tx.oncomplete
        }
      }
    });

    tx.oncomplete = () => {
      if (!operationsFailed) resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
};

export const checkIsFavorited = async (id: number): Promise<boolean> => {
  const db = await openDB();
  const tx = db.transaction("favResources", "readonly");
  const store = tx.objectStore("favResources");

  return new Promise((resolve) => {
    const request = store.index("id").count(id);
    request.onsuccess = () => {
      resolve(request.result > 0);
    };
    request.onerror = () => {
      resolve(false);
    };
  });
};

export const getFavResources = async (folderId?: number): Promise<FavoriteResource[]> => {
  const db = await openDB();
  const tx = db.transaction("favResources", "readonly");
  const store = tx.objectStore("favResources");

  return new Promise((resolve, reject) => {
    let request;
    if (folderId) {
      const index = store.index("folder_id");
      request = index.getAll(folderId);
    } else {
      request = store.getAll();
    }
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

/**
 * 全量同步前把本地真实收藏元数据写入安全快照。
 *
 * 同步接口对已删除稿件只返回占位标题/封面；即使下游保护逻辑出问题，
 * 下一次同步结束后也可以从这份快照把标题/封面补回来。
 */
export const saveFavoriteMetadataSnapshots = async (
  resources: FavoriteResource[],
): Promise<void> => {
  const candidates = resources.filter(
    (resource) => !isPlaceholderTitle(resource.title) || !isPlaceholderImage(resource.cover),
  );
  if (candidates.length === 0) return;

  const db = await openDB();
  const tx = db.transaction("favMetadataSnapshots", "readwrite");
  const store = tx.objectStore("favMetadataSnapshots");
  candidates.forEach((resource) => store.put(resource));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

/**
 * 同步结束后，把当前又被占位内容覆盖的收藏从安全快照恢复。
 * 当前字段仍为真实值时优先保留当前值（mergeRestoredFavorite 的规则）。
 */
export const restoreFavoriteMetadataSnapshots = async (folderId: number): Promise<number> => {
  const db = await openDB();
  const readTx = db.transaction(["favResources", "favMetadataSnapshots"], "readonly");
  const currentStore = readTx.objectStore("favResources");
  const snapshotStore = readTx.objectStore("favMetadataSnapshots");
  const [currentResources, snapshots] = await Promise.all([
    new Promise<FavoriteResource[]>((resolve, reject) => {
      const request = currentStore.index("folder_id").getAll(folderId);
      request.onsuccess = () => resolve(request.result as FavoriteResource[]);
      request.onerror = () => reject(request.error);
    }),
    new Promise<FavoriteResource[]>((resolve, reject) => {
      const request = snapshotStore.index("folder_id").getAll(folderId);
      request.onsuccess = () => resolve(request.result as FavoriteResource[]);
      request.onerror = () => reject(request.error);
    }),
  ]);

  const snapshotById = new Map(snapshots.map((snapshot) => [snapshot.id, snapshot]));
  const updates: FavoriteResource[] = [];
  for (const current of currentResources) {
    const snapshot = snapshotById.get(current.id);
    if (!snapshot) continue;
    const merged = mergeRestoredFavorite(snapshot, current);
    if (
      merged.title !== current.title ||
      merged.cover !== current.cover ||
      merged.coverAssetId !== current.coverAssetId
    ) {
      updates.push(merged);
    }
  }
  if (updates.length === 0) return 0;

  const writeTx = db.transaction("favResources", "readwrite");
  const store = writeTx.objectStore("favResources");
  updates.forEach((resource) => store.put(resource));
  await new Promise<void>((resolve, reject) => {
    writeTx.oncomplete = () => resolve();
    writeTx.onerror = () => reject(writeTx.error);
    writeTx.onabort = () => reject(writeTx.error);
  });
  return updates.length;
};

const isInvalidCollectionShell = (collection: SubscribedCollection): boolean => {
  const title = (collection.title || "").trim();
  return !title || title === "未命名合集" || /合集.*失效|已失效/.test(title);
};

/**
 * 合并合集壳。
 *
 * 线上接口对已失效合集返回的是「该合集已失效」这类占位标题和空封面；
 * 原实现直接 clear + put，会把本地保存的真实名称、封面、UP 一起覆盖。
 * 这里只保护"基本不变"的字段，media_count 仍取线上值（0 时回退本地，
 * 避免接口暂时异常把已有数量抹掉）。
 */
const mergeCollectionShell = (
  previous: SubscribedCollection | undefined,
  incoming: SubscribedCollection,
): SubscribedCollection => {
  if (!previous) return incoming;
  const incomingInvalid = isInvalidCollectionShell(incoming);
  const cover =
    isPlaceholderImage(incoming.cover) && !isPlaceholderImage(previous.cover)
      ? previous.cover
      : incoming.cover || previous.cover;
  return {
    ...incoming,
    title:
      incomingInvalid || !incoming.title || incoming.title === "未命名合集"
        ? previous.title || incoming.title
        : incoming.title,
    cover,
    intro: incoming.intro || previous.intro,
    media_count:
      incoming.media_count > 0 ? incoming.media_count : previous.media_count,
    upper: incoming.upper?.name ? incoming.upper : previous.upper,
  };
};

export interface ReplaceSubscribedCollectionsOptions {
  /** 查询确认合集已被 UP 删除/失效，可以恢复为本地合集。 */
  deletedCollectionIds?: Set<number>;
}

export const replaceSubscribedCollections = async (
  collections: SubscribedCollection[],
  options: ReplaceSubscribedCollectionsOptions = {},
): Promise<void> => {
  const db = await openDB();
  const previousCollections = await getAllSubscribedCollections();
  const previousArchives = await getAllCollectionArchives(true);
  const previousById = new Map(previousCollections.map((item) => [item.id, item]));
  const archiveById = new Map(previousArchives.map((item) => [item.id, item]));
  const incomingIds = new Set(collections.map((item) => item.id));

  const archivesToPut: CollectionArchive[] = [];
  const archiveIdsToDelete: number[] = [];
  const archiveFor = (
    collection: SubscribedCollection,
    reason: CollectionArchive["reason"],
    existing: CollectionArchive | undefined,
    localResourceCount: number,
  ): CollectionArchive => ({
    id: collection.id,
    title: existing?.title || collection.title,
    cover: existing?.cover || collection.cover,
    intro: existing?.intro || collection.intro,
    ctime: existing?.ctime || collection.ctime,
    mtime: existing?.mtime || collection.mtime,
    media_count: existing?.media_count || collection.media_count,
    upper: existing?.upper || collection.upper,
    index: existing?.index ?? collection.index,
    reason,
    archivedAt: existing?.archivedAt || Date.now(),
    deletedAt: existing?.deletedAt,
    resourceCount: Math.max(existing?.resourceCount ?? 0, localResourceCount),
    lastSyncedMediaCount: collection.media_count,
  });

  const nextCollections: SubscribedCollection[] = [];
  for (const incoming of collections) {
    const previous = previousById.get(incoming.id);
    const existingArchive = archiveById.get(incoming.id);
    const invalid = isInvalidCollectionShell(incoming);

    if (invalid) {
      // 线上只剩占位壳：这通常是 UP 删除了合集，而不是用户取消订阅。
      // 本地有内容时直接恢复成“仅本地”合集，放回原来的 index；
      // 这样用户还能按旧位置找到它，不必去档案里翻。
      if (previous) {
        const localResourceCount = await getSubscribedCollectionResourceCount(previous.id);
        if (localResourceCount > 0 && !existingArchive?.deletedAt) {
          nextCollections.push({ ...previous, localRestore: true });
          archiveIdsToDelete.push(previous.id);
        } else if (localResourceCount <= 0) {
          archiveIdsToDelete.push(previous.id);
        }
      }
      continue;
    }

    if (!invalid && existingArchive) {
      // 重新订阅或恢复有效：清掉删除标记，离开消失档案。
      archiveIdsToDelete.push(incoming.id);
    }

    nextCollections.push(previous ? mergeCollectionShell(previous, incoming) : incoming);
  }

  for (const previous of previousCollections) {
    if (incomingIds.has(previous.id)) continue;
    const existingArchive = archiveById.get(previous.id);
    // 用户主动删除过的合集，后续同步不能把它重新拉回来。
    if (existingArchive?.deletedAt) continue;
    const localResourceCount = await getSubscribedCollectionResourceCount(previous.id);
    // 没存过任何内容的合集只留一个空壳标题，没有恢复价值。
    if (localResourceCount <= 0) {
      archiveIdsToDelete.push(previous.id);
      continue;
    }

    // 已经是“仅本地”恢复的合集：B 站目录里当然没有它，继续留在原位。
    if (previous.localRestore) {
      nextCollections.push(previous);
      archiveIdsToDelete.push(previous.id);
      continue;
    }

    // B 站目录里没有它，需要区分：用户主动取消订阅 vs UP 删除。
    // 只有后台查询确认“合集本身已不存在”时才自动恢复；
    // 查不到/查询失败/确认仍存在，都继续走原来的归档逻辑。
    if (options.deletedCollectionIds?.has(previous.id)) {
      nextCollections.push({ ...previous, localRestore: true });
      archiveIdsToDelete.push(previous.id);
      continue;
    }

    archivesToPut.push(
      archiveFor(previous, "collection_gone", existingArchive, localResourceCount),
    );
  }

  // 按 B 站原来的 index 排序。自动恢复的合集不能因为是在循环末尾
  // push 进去就跑到列表底部，否则用户又要满列表找它。
  nextCollections.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  // 兼容旧版本留下的空档案：只保留本地确实有内容的合集。
  for (const archive of previousArchives) {
    if (archive.resourceCount <= 0) archiveIdsToDelete.push(archive.id);
  }

  const tx = db.transaction(
    ["subscribedCollections", "collectionArchives"],
    "readwrite",
  );
  const collectionStore = tx.objectStore("subscribedCollections");
  const archiveStore = tx.objectStore("collectionArchives");

  return new Promise((resolve, reject) => {
    const clearRequest = collectionStore.clear();
    clearRequest.onsuccess = () => {
      nextCollections.forEach((collection) => collectionStore.put(collection));
    };
    clearRequest.onerror = () => reject(clearRequest.error);

    archivesToPut.forEach((archive) => archiveStore.put(archive));
    archiveIdsToDelete.forEach((id) => archiveStore.delete(id));

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const getSubscribedCollections = async (): Promise<SubscribedCollection[]> => {
  const db = await openDB();
  const tx = db.transaction("subscribedCollections", "readonly");
  const store = tx.objectStore("subscribedCollections");

  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const replaceSubscribedCollectionResources = async (
  collectionId: number,
  resources: SubscribedCollectionResource[],
): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("subscribedCollectionResources", "readwrite");
  const store = tx.objectStore("subscribedCollectionResources");
  const collectionIndex = store.index("collection_id");

  return new Promise((resolve, reject) => {
    // 先 diff 再写：新数据先 put，只在最后删除本地有而远端没有的键。
    // 避免"先清空后写入"在失败时留下被清空的本地数据。
    //
    // 这里用 `getAll` 而不是 `getAllKeys`：除了 diff 键，还要拿到**旧记录本身**
    // 做失效保护（见下方 preserve）。
    const existingRequest = collectionIndex.getAll(collectionId);
    existingRequest.onsuccess = () => {
      const existingById = new Map(
        (existingRequest.result as SubscribedCollectionResource[]).map((item) => [item.id, item]),
      );
      const incomingKeys = new Set(resources.map((resource) => resource.id));

      resources.forEach((resource) => {
        const previous = existingById.get(resource.id);
        store.put(previous ? preserveCollectionMetadata(previous, resource) : resource);
      });

      existingRequest.result.forEach((existing) => {
        if (!incomingKeys.has(existing.id)) store.delete(existing.id);
      });
    };
    existingRequest.onerror = () => reject(existingRequest.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

/**
 * 合集资源的失效保护。
 *
 * 合集同步是**整夹替换**，而稿件失效后 B 站返回的是占位数据（标题变成
 * "已失效视频"、`duration` 变 0）。原实现直接 `put`，于是本地那份**失效前保存的**
 * 标题 / 封面 / 时长被永久覆盖——收藏早就有这层保护，合集一直漏着。
 *
 * 只保留"基本不变"的字段。播放量、点赞数这类会变的绝不保留，否则本地会显示
 * 一个过期数字，比没有更糟。
 */
const preserveCollectionMetadata = (
  previous: SubscribedCollectionResource,
  incoming: SubscribedCollectionResource,
): SubscribedCollectionResource => {
  const incomingInvalidated =
    resolveInvalidatedKind(incoming.attr) !== null ||
    INVALIDATED_TITLE_RE.test(incoming.title ?? "");
  const previousInvalidated =
    resolveInvalidatedKind(previous.attr) !== null ||
    INVALIDATED_TITLE_RE.test(previous.title ?? "");

  // 首次观测到失效的时间只写一次，沿用收藏侧的语义
  const invalidatedKind = resolveInvalidatedKind(incoming.attr) ?? previous.invalidatedKind;
  const invalidatedAt =
    previous.invalidatedAt ??
    (incomingInvalidated ? Date.now() : undefined);

  // 即使这次没有失效标记，也不要用占位封面覆盖本地真实封面。
  const cover =
    isPlaceholderImage(incoming.cover) && !isPlaceholderImage(previous.cover)
      ? previous.cover
      : incoming.cover || previous.cover;

  // 只有"本地有有效数据"时才保护。本地本身就是失效状态的话，
  // 保留占位数据毫无意义，让远端覆盖即可。
  if (!incomingInvalidated || previousInvalidated) {
    return {
      ...incoming,
      cover,
      coverAssetId: previous.coverAssetId ?? incoming.coverAssetId,
      invalidatedKind,
      invalidatedAt,
    };
  }

  return {
    ...incoming,
    title: previous.title || incoming.title,
    cover,
    duration: previous.duration || incoming.duration,
    pubdate: previous.pubdate || incoming.pubdate,
    author_name: previous.author_name || incoming.author_name,
    author_mid: previous.author_mid || incoming.author_mid,
    coverAssetId: previous.coverAssetId ?? incoming.coverAssetId,
    invalidatedKind,
    invalidatedAt,
  };
};

export const getSubscribedCollectionResources = async (
  collectionId: number,
): Promise<SubscribedCollectionResource[]> => {
  const db = await openDB();
  const tx = db.transaction("subscribedCollectionResources", "readonly");
  const store = tx.objectStore("subscribedCollectionResources");
  const collectionIndex = store.index("collection_id");

  return new Promise((resolve, reject) => {
    const request = collectionIndex.getAll(collectionId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

/** 获取所有订阅合集 */
export const getAllSubscribedCollections = async (): Promise<SubscribedCollection[]> => {
  return getSubscribedCollections();
};

/** 首屏 KPI 只需要合集内容条数；传入合集 id 时只统计仍然订阅的合集 */
export const countSubscribedCollectionResources = async (
  collectionIds?: number[],
): Promise<number> => {
  const db = await openDB();
  const tx = db.transaction("subscribedCollectionResources", "readonly");
  const store = tx.objectStore("subscribedCollectionResources");
  if (!collectionIds) return await requestResult(store.count());

  const index = store.index("collection_id");
  let total = 0;
  for (const id of collectionIds) {
    total += await requestResult(index.count(id));
  }
  return total;
};

/** 获取所有订阅合集资源 */
export const getAllSubscribedCollectionResources = async (): Promise<
  SubscribedCollectionResource[]
> => {
  const db = await openDB();
  const tx = db.transaction("subscribedCollectionResources", "readonly");
  const store = tx.objectStore("subscribedCollectionResources");

  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

/** 统计某个合集在本地保存了多少条内容，用于增量同步判断。 */
export const getSubscribedCollectionResourceCount = async (
  collectionId: number,
): Promise<number> => {
  const db = await openDB();
  const tx = db.transaction("subscribedCollectionResources", "readonly");
  const index = tx.objectStore("subscribedCollectionResources").index("collection_id");

  return new Promise((resolve, reject) => {
    const request = index.count(collectionId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

export const getAllCollectionArchives = async (
  includeDeleted = false,
): Promise<CollectionArchive[]> => {
  const db = await openDB();
  const tx = db.transaction("collectionArchives", "readonly");
  const store = tx.objectStore("collectionArchives");

  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => {
      const result = request.result as CollectionArchive[];
      resolve(includeDeleted ? result : result.filter((item) => !item.deletedAt));
    };
    request.onerror = () => reject(request.error);
  });
};

export const getCollectionArchive = async (
  id: number,
): Promise<CollectionArchive | undefined> => {
  const db = await openDB();
  const tx = db.transaction("collectionArchives", "readonly");
  const store = tx.objectStore("collectionArchives");

  return new Promise((resolve, reject) => {
    const request = store.get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

/**
 * 合并导入合集档案。用于 WebDAV / JSON 恢复。
 *
 * 合并原则：
 * - 本地有删除标记时，不被远端旧记录复活；
 * - 远端有删除标记时，删除动作可以覆盖本地未删除记录；
 * - 其余情况保留归档时间更晚的一份，避免旧备份覆盖新快照。
 */
export const importCollectionArchives = async (
  archives: CollectionArchive[],
): Promise<{ merged: number; skipped: number }> => {
  if (archives.length === 0) return { merged: 0, skipped: 0 };

  const db = await openDB();
  const readTx = db.transaction("collectionArchives", "readonly");
  const stored = (await requestResult(
    readTx.objectStore("collectionArchives").getAll(),
  )) as CollectionArchive[];
  const localById = new Map(stored.map((item) => [item.id, item]));

  const writeTx = db.transaction("collectionArchives", "readwrite");
  const store = writeTx.objectStore("collectionArchives");
  let merged = 0;
  let skipped = 0;

  for (const incoming of archives) {
    if (!incoming || typeof incoming.id !== "number") {
      skipped += 1;
      continue;
    }
    const local = localById.get(incoming.id);
    if (local) {
      const localDeletedAt = local.deletedAt ?? 0;
      const incomingDeletedAt = incoming.deletedAt ?? 0;
      const keepIncoming =
        incomingDeletedAt > localDeletedAt ||
        (incomingDeletedAt === localDeletedAt && incoming.archivedAt > local.archivedAt);
      if (!keepIncoming) {
        skipped += 1;
        continue;
      }
    }
    store.put(incoming);
    merged += 1;
  }

  await transactionDone(writeTx);
  return { merged, skipped };
};

/**
 * 删除合集档案（软删除）。保留视频条目与档案记录，5 秒内可撤销；
 * 真正跨过撤销窗口后由页面调用 `deleteCollectionArchiveResources` 清掉条目。
 */
export const deleteCollectionArchives = async (ids: number[]): Promise<void> => {
  if (ids.length === 0) return;
  const db = await openDB();
  const tx = db.transaction("collectionArchives", "readwrite");
  const store = tx.objectStore("collectionArchives");
  const deletedAt = Date.now();

  return new Promise((resolve, reject) => {
    ids.forEach((id) => {
      const request = store.get(id);
      request.onsuccess = () => {
        const archive = request.result as CollectionArchive | undefined;
        if (archive) store.put({ ...archive, deletedAt });
      };
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

/** 撤销删除：清掉 deletedAt 即可，视频条目本来就没删。 */
export const restoreCollectionArchives = async (ids: number[]): Promise<void> => {
  if (ids.length === 0) return;
  const db = await openDB();
  const tx = db.transaction("collectionArchives", "readwrite");
  const store = tx.objectStore("collectionArchives");

  return new Promise((resolve, reject) => {
    ids.forEach((id) => {
      const request = store.get(id);
      request.onsuccess = () => {
        const archive = request.result as CollectionArchive | undefined;
        if (!archive) return;
        const rest = { ...archive };
        delete rest.deletedAt;
        store.put(rest);
      };
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

/** 撤销窗口结束后真正清理归档视频条目（合集壳记录保留 deletedAt 作为 tombstone）。 */
export const deleteCollectionArchiveResources = async (
  collectionId: number,
): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("subscribedCollectionResources", "readwrite");
  const index = tx.objectStore("subscribedCollectionResources").index("collection_id");

  return new Promise((resolve, reject) => {
    const request = index.openKeyCursor(collectionId);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      tx.objectStore("subscribedCollectionResources").delete(cursor.primaryKey);
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

/** 同步队列写入本地条数，用于下一次只按 media_count 判断是否跳过。 */
export const updateCollectionArchiveSyncState = async (
  collectionId: number,
  resourceCount: number,
  lastSyncedMediaCount: number,
): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("collectionArchives", "readwrite");
  const store = tx.objectStore("collectionArchives");

  return new Promise((resolve, reject) => {
    const request = store.get(collectionId);
    request.onsuccess = () => {
      const archive = request.result as CollectionArchive | undefined;
      if (archive) store.put({ ...archive, resourceCount, lastSyncedMediaCount });
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

export const deleteFavResources = async (folderId: number, ids: number[]): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("favResources", "readwrite");
  const store = tx.objectStore("favResources");

  return new Promise((resolve, reject) => {
    let operationsCompleted = 0;
    let operationsFailed = false;

    if (ids.length === 0) {
      resolve();
      return;
    }

    ids.forEach((id) => {
      if (operationsFailed) return;
      const request = store.delete([folderId, id]);
      request.onsuccess = () => operationsCompleted++;
      request.onerror = () => {
        if (!operationsFailed) {
          operationsFailed = true;
          reject(request.error);
        }
      };
    });

    tx.oncomplete = () => {
      if (!operationsFailed) resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
};

export const clearFavResourcesByFolder = async (folderId: number): Promise<number> => {
  const db = await openDB();
  const tx = db.transaction("favResources", "readwrite");
  const store = tx.objectStore("favResources");
  const index = store.index("folder_id");

  return new Promise((resolve, reject) => {
    let deletedCount = 0;
    const request = index.openCursor(IDBKeyRange.only(folderId));

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;

      const deleteRequest = cursor.delete();
      deleteRequest.onsuccess = () => {
        deletedCount++;
      };
      deleteRequest.onerror = () => tx.abort();
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(deletedCount);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("清空收藏夹本地数据失败"));
  });
};

export const deleteFavFolderWithResources = async (folderId: number): Promise<number> => {
  const db = await openDB();
  const tx = db.transaction(["favFolders", "favResources"], "readwrite");
  const folderStore = tx.objectStore("favFolders");
  const resourceStore = tx.objectStore("favResources");
  const folderIndex = resourceStore.index("folder_id");

  return new Promise((resolve, reject) => {
    let deletedResourceCount = 0;
    const deleteFolderRequest = folderStore.delete(folderId);
    const resourceCursorRequest = folderIndex.openCursor(IDBKeyRange.only(folderId));

    deleteFolderRequest.onerror = () => tx.abort();
    resourceCursorRequest.onsuccess = () => {
      const cursor = resourceCursorRequest.result;
      if (!cursor) return;

      const deleteResourceRequest = cursor.delete();
      deleteResourceRequest.onsuccess = () => {
        deletedResourceCount++;
      };
      deleteResourceRequest.onerror = () => tx.abort();
      cursor.continue();
    };
    resourceCursorRequest.onerror = () => tx.abort();
    tx.oncomplete = () => resolve(deletedResourceCount);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("删除本地收藏夹失败"));
  });
};

// ========== 数据同步辅助函数 ==========

/**
 * 获取所有收藏夹文件夹
 */
export const getAllFavFolders = async (): Promise<FavoriteFolder[]> => {
  const db = await openDB();
  const tx = db.transaction("favFolders", "readonly");
  const store = tx.objectStore("favFolders");

  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

/** 只数收藏资源条数，首屏 KPI 不需要把 1300+ 条完整记录读进内存 */
export const countFavResources = async (): Promise<number> => {
  const db = await openDB();
  const tx = db.transaction("favResources", "readonly");
  return await requestResult(tx.objectStore("favResources").count());
};

/**
 * 获取所有收藏夹资源
 */
export const getAllFavResources = async (): Promise<FavoriteResource[]> => {
  const db = await openDB();
  const tx = db.transaction("favResources", "readonly");
  const store = tx.objectStore("favResources");

  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

/**
 * 批量导入收藏夹文件夹（直接 upsert，无时间戳字段）
 */
export const importFavFolders = async (folders: FavoriteFolder[]): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("favFolders", "readwrite");
  const store = tx.objectStore("favFolders");

  return new Promise((resolve, reject) => {
    if (folders.length === 0) {
      resolve();
      return;
    }

    folders.forEach((folder) => {
      store.put(folder);
    });

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

/**
 * 批量导入收藏夹资源。
 *
 * 不能无条件 put：旧备份可能只有占位标题/封面，直接覆盖会把当前已经恢复好的
 * 真实元数据重新打回「已失效视频」。这里与恢复链路一样做字段级合并，
 * 当前真实字段优先，备份只补缺失/占位字段。
 */
export const importFavResources = async (resources: FavoriteResource[]): Promise<void> => {
  if (resources.length === 0) return;

  const db = await openDB();
  const readTx = db.transaction("favResources", "readonly");
  const readStore = readTx.objectStore("favResources");
  const current = await Promise.all(
    resources.map(
      (res) =>
        new Promise<FavoriteResource | undefined>((resolve, reject) => {
          const request = readStore.get([res.folder_id, res.id]);
          request.onsuccess = () => resolve(request.result as FavoriteResource | undefined);
          request.onerror = () => reject(request.error);
        }),
    ),
  );

  const tx = db.transaction("favResources", "readwrite");
  const store = tx.objectStore("favResources");
  resources.forEach((res, index) => {
    store.put(mergeRestoredFavorite(res, current[index]));
  });

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
};

/** 批量导入订阅合集（直接 upsert，按合集信息覆盖） */
export const importSubscribedCollections = async (
  collections: SubscribedCollection[],
): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("subscribedCollections", "readwrite");
  const store = tx.objectStore("subscribedCollections");

  return new Promise((resolve, reject) => {
    if (collections.length === 0) {
      resolve();
      return;
    }

    collections.forEach((collection) => store.put(collection));
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

/**
 * 智能合并历史记录：按 view_at 时间戳比对，仅远端更新时覆盖。
 * 位于本地删除墓碑（DELETED_HISTORY_IDS）中的记录会被跳过，防止删除在
 * WebDAV 双向同步后复活。
 */
export const smartMergeHistory = async (
  remoteItems: HistoryItem[],
  deletedIds?: ReadonlySet<number>,
): Promise<{ merged: number; skipped: number }> => {
  const result = await upsertHistorySnapshots(remoteItems, "legacy-import", deletedIds);
  return {
    merged: result.newEvents + result.updatedEvents,
    skipped: result.skippedByTombstone,
  };
};

/**
 * 智能合并喜欢的音乐：按 added_at 时间戳比对
 */
export const smartMergeLikedMusic = async (
  remoteItems: LikedMusic[],
): Promise<{ merged: number; skipped: number }> => {
  const db = await openDB();
  const tx = db.transaction("likedMusic", "readwrite");
  const store = tx.objectStore("likedMusic");
  let merged = 0;
  let skipped = 0;

  return new Promise((resolve, reject) => {
    if (remoteItems.length === 0) {
      resolve({ merged: 0, skipped: 0 });
      return;
    }

    let processed = 0;
    const total = remoteItems.length;

    remoteItems.forEach((remoteItem) => {
      const getReq = store.get(remoteItem.bvid);
      getReq.onsuccess = () => {
        const localItem = getReq.result as LikedMusic | undefined;

        if (!localItem || remoteItem.added_at >= localItem.added_at) {
          store.put(remoteItem);
          merged++;
        } else {
          skipped++;
        }

        processed++;
      };
      getReq.onerror = () => {
        store.put(remoteItem);
        merged++;
        processed++;
      };
    });

    tx.oncomplete = () => resolve({ merged, skipped });
    tx.onerror = () => reject(tx.error);
  });
};

/**
 * 智能合并收藏夹资源：按 fav_time 时间戳比对
 */
export const smartMergeFavResources = async (
  remoteItems: FavoriteResource[],
): Promise<{ merged: number; skipped: number }> => {
  const db = await openDB();

  // 先取消失档案的键：远端备份里仍留有已消失的记录，若不拦住就会把它们"复活"回 favResources，
  // 使消失档案失去意义。仓库已有的 historyTombstones 处理的是同类问题。
  const vanishedKeys = new Set(
    (await getAllVanishedFavResources()).map((item) => `${item.folder_id}:${item.id}`),
  );

  const tx = db.transaction("favResources", "readwrite");
  const store = tx.objectStore("favResources");
  let merged = 0;
  let skipped = 0;

  return new Promise((resolve, reject) => {
    if (remoteItems.length === 0) {
      resolve({ merged: 0, skipped: 0 });
      return;
    }

    let processed = 0;
    const total = remoteItems.length;

    remoteItems.forEach((remoteItem) => {
      const vanishedKey = `${remoteItem.folder_id}:${remoteItem.id}`;
      const getReq = store.get([remoteItem.folder_id, remoteItem.id]);
      getReq.onsuccess = () => {
        const localItem = getReq.result as FavoriteResource | undefined;

        // 已经在消失档案里、且当前收藏夹没有这条记录：跳过，绝不复活。
        // 但如果 favResources 里仍有这条记录，它只是元数据被占位内容覆盖，
        // 这里应该做字段级恢复，而不是因为“档案里也有”就整条跳过。
        if (!localItem) {
          if (vanishedKeys.has(vanishedKey)) {
            skipped++;
          } else {
            store.put(remoteItem);
            merged++;
          }
          processed++;
          return;
        }

        const mergedItem = mergeRestoredFavorite(remoteItem, localItem);
        const changed =
          mergedItem.title !== localItem.title ||
          mergedItem.cover !== localItem.cover ||
          mergedItem.coverAssetId !== localItem.coverAssetId ||
          mergedItem.fav_time !== localItem.fav_time ||
          mergedItem.recoveredAt !== localItem.recoveredAt ||
          mergedItem.recoverySource !== localItem.recoverySource ||
          mergedItem.invalidatedKind !== localItem.invalidatedKind ||
          mergedItem.invalidatedAt !== localItem.invalidatedAt;

        if (changed) {
          store.put(mergedItem);
          merged++;
        } else {
          skipped++;
        }
        processed++;
      };
      getReq.onerror = () => {
        store.put(remoteItem);
        merged++;
        processed++;
      };
    });

    tx.oncomplete = () => resolve({ merged, skipped });
    tx.onerror = () => reject(tx.error);
  });
};

/**
 * 智能合并订阅合集资源：按视频发布时间比对。
 * 视频发布时间通常不可变；时间相同则以远端数据为准，补齐可能更新的标题或封面。
 */
export const smartMergeSubscribedCollectionResources = async (
  remoteItems: SubscribedCollectionResource[],
): Promise<{ merged: number; skipped: number }> => {
  const db = await openDB();
  const tx = db.transaction("subscribedCollectionResources", "readwrite");
  const store = tx.objectStore("subscribedCollectionResources");
  let merged = 0;
  let skipped = 0;

  return new Promise((resolve, reject) => {
    if (remoteItems.length === 0) {
      resolve({ merged: 0, skipped: 0 });
      return;
    }

    remoteItems.forEach((remoteItem) => {
      const getReq = store.get(remoteItem.id);
      getReq.onsuccess = () => {
        const localItem = getReq.result as SubscribedCollectionResource | undefined;

        if (!localItem || remoteItem.pubdate >= localItem.pubdate) {
          store.put(remoteItem);
          merged++;
        } else {
          skipped++;
        }
      };
      getReq.onerror = () => {
        store.put(remoteItem);
        merged++;
      };
    });

    tx.oncomplete = () => resolve({ merged, skipped });
    tx.onerror = () => reject(tx.error);
  });
};

// ---------------------------------------------------------------------------
// v9 新增 store 的读写：关注追踪 / 图片字节归档 / 收藏消失档案
//
// 本层只做存取，不包含任何判定逻辑。改名/取关/注销的判定放在
// utils/followingDiff.ts 等纯函数模块里，以便在不依赖 IndexedDB 的前提下做单元测试。
// ---------------------------------------------------------------------------

/** 把独立存档里的曾用名叠加回关注条目；两边都有时取并集，查询时间取更晚的 */
const mergeFormerNameRecord = (
  item: FollowingItem,
  record: FormerNameRecord | undefined,
): FollowingItem => {
  if (!record) return item;
  const itemQueriedAt = item.thirdPartyQueriedAt ?? 0;
  const recordQueriedAt = record.queriedAt ?? 0;
  const names = [...new Set([...(record.names ?? []), ...(item.thirdPartyNames ?? [])])];
  const itemIsNewer = itemQueriedAt > recordQueriedAt;
  return {
    ...item,
    thirdPartyNames: names,
    thirdPartyQueriedAt: Math.max(itemQueriedAt, recordQueriedAt) || undefined,
    formerNameDisplayIndex: itemIsNewer
      ? (item.formerNameDisplayIndex ?? record.displayIndex)
      : (record.displayIndex ?? item.formerNameDisplayIndex),
  };
};

/** 从关注条目生成独立存档记录；没有可存内容时返回 null */
const toFormerNameRecord = (item: FollowingItem): FormerNameRecord | null => {
  const names = item.thirdPartyNames ?? [];
  if (names.length === 0 && !item.thirdPartyQueriedAt && item.formerNameDisplayIndex === undefined) {
    return null;
  }
  return {
    mid: item.mid,
    names,
    queriedAt: item.thirdPartyQueriedAt ?? 0,
    displayIndex: item.formerNameDisplayIndex,
    updatedAt: Date.now(),
  };
};

/** 读取全部关注快照，按 UID 升序 */
export const getAllFollowing = async (): Promise<FollowingItem[]> => {
  const db = await openDB();
  const tx = db.transaction(["following", "formerNames"], "readonly");
  // 同步发起两个请求，避免事务因为 await 而提前提交
  const itemsRequest = requestResult(tx.objectStore("following").getAll());
  const recordsRequest = requestResult(tx.objectStore("formerNames").getAll());
  const [items, records] = (await Promise.all([itemsRequest, recordsRequest])) as [
    FollowingItem[],
    FormerNameRecord[],
  ];
  const recordByMid = new Map(records.map((record) => [record.mid, record]));
  return items
    .map((item) => mergeFormerNameRecord(item, recordByMid.get(item.mid)))
    .sort((a, b) => a.mid - b.mid);
};

export const getFollowingItem = async (mid: number): Promise<FollowingItem | undefined> => {
  const db = await openDB();
  const tx = db.transaction(["following", "formerNames"], "readonly");
  const itemRequest = requestResult(tx.objectStore("following").get(mid));
  const recordRequest = requestResult(tx.objectStore("formerNames").get(mid));
  const [item, record] = (await Promise.all([itemRequest, recordRequest])) as [
    FollowingItem | undefined,
    FormerNameRecord | undefined,
  ];
  if (!item) return undefined;
  return mergeFormerNameRecord(item, record);
};

/** 读取全部曾用名独立存档。关注列表之外（已取关/已注销）的名字也在这里。 */
export const getAllFormerNames = async (): Promise<FormerNameRecord[]> => {
  const db = await openDB();
  const tx = db.transaction("formerNames", "readonly");
  return (await requestResult(tx.objectStore("formerNames").getAll())) as FormerNameRecord[];
};

/**
 * 合并导入曾用名存档。
 *
 * `formerNames` 是独立 store：只备份 following 条目会漏掉已取关账号的名字。
 * 名字只增不减，查询时间取较大值；展示下标以 `updatedAt` 较新的一份为准。
 */
export const importFormerNames = async (
  records: FormerNameRecord[],
): Promise<{ merged: number; skipped: number }> => {
  if (records.length === 0) return { merged: 0, skipped: 0 };

  const db = await openDB();
  const readTx = db.transaction("formerNames", "readonly");
  const stored = (await requestResult(
    readTx.objectStore("formerNames").getAll(),
  )) as FormerNameRecord[];
  const localByMid = new Map(stored.map((item) => [item.mid, item]));

  const writeTx = db.transaction("formerNames", "readwrite");
  const store = writeTx.objectStore("formerNames");
  let merged = 0;
  let skipped = 0;

  for (const incoming of records) {
    if (!incoming || typeof incoming.mid !== "number" || !Array.isArray(incoming.names)) {
      skipped += 1;
      continue;
    }
    const local = localByMid.get(incoming.mid);
    if (!local) {
      store.put(incoming);
      merged += 1;
      continue;
    }

    const names = Array.from(new Set([...(local.names ?? []), ...incoming.names]));
    const incomingIsNewer = (incoming.updatedAt ?? 0) >= (local.updatedAt ?? 0);
    store.put({
      mid: incoming.mid,
      names,
      queriedAt: Math.max(local.queriedAt ?? 0, incoming.queriedAt ?? 0),
      displayIndex: incomingIsNewer
        ? (incoming.displayIndex ?? local.displayIndex)
        : local.displayIndex,
      updatedAt: Date.now(),
    });
    merged += 1;
  }

  await transactionDone(writeTx);
  return { merged, skipped };
};

export const countFollowing = async (): Promise<number> => {
  const db = await openDB();
  const tx = db.transaction("following", "readonly");
  return await requestResult(tx.objectStore("following").count());
};

/** 批量写入关注快照。不做 diff，调用方负责传入已经算好的最终状态。 */
export const putFollowingItems = async (items: FollowingItem[]): Promise<void> => {
  if (items.length === 0) return;
  const db = await openDB();
  // 刻意不碰 formerNames：这里的快照可能是在查询之前读出来的旧数据，
  // 拿它去覆盖独立存档会把新查到的曾用名打回去。
  const tx = db.transaction("following", "readwrite");
  const store = tx.objectStore("following");
  for (const item of items) store.put(item);
  await transactionDone(tx);
};

/**
 * 对指定 UID 批量打补丁（用于回填 avatarAssetId、status、第三方曾用名等）。
 *
 * 注意：读与写分两个事务。同一事务里 await 每次 get，会让事务在没有待处理请求时
 * 自动提交，后续 put 会抛 TransactionInactiveError。
 */
export const patchFollowingItems = async (
  mids: number[],
  patch: Partial<FollowingItem>,
): Promise<number> => {
  if (mids.length === 0) return 0;

  const touchesFormerNames =
    "thirdPartyNames" in patch ||
    "thirdPartyQueriedAt" in patch ||
    "formerNameDisplayIndex" in patch;

  const db = await openDB();
  const storeNames = touchesFormerNames ? ["following", "formerNames"] : ["following"];
  const readTx = db.transaction(storeNames, "readonly");
  const readStore = readTx.objectStore("following");
  const formerReadStore = touchesFormerNames ? readTx.objectStore("formerNames") : null;
  // 同步发起全部 get，保持事务存活
  const current = (await Promise.all(
    mids.map((mid) => requestResult(readStore.get(mid)) as Promise<FollowingItem | undefined>),
  )) as Array<FollowingItem | undefined>;
  const records = formerReadStore
    ? ((await Promise.all(
        mids.map(
          (mid) => requestResult(formerReadStore.get(mid)) as Promise<FormerNameRecord | undefined>,
        ),
      )) as Array<FormerNameRecord | undefined>)
    : [];

  const writeTx = db.transaction(storeNames, "readwrite");
  const writeStore = writeTx.objectStore("following");
  const formerWriteStore = touchesFormerNames ? writeTx.objectStore("formerNames") : null;
  let changed = 0;
  current.forEach((item, index) => {
    if (!item) return;
    const merged = { ...mergeFormerNameRecord(item, records[index]), ...patch };
    writeStore.put(merged);
    if (formerWriteStore) {
      const record = toFormerNameRecord(merged);
      if (record) formerWriteStore.put(record);
    }
    changed++;
  });
  await transactionDone(writeTx);
  return changed;
};

export const deleteFollowingItems = async (mids: number[]): Promise<void> => {
  if (mids.length === 0) return;
  const db = await openDB();
  const tx = db.transaction("following", "readwrite");
  const store = tx.objectStore("following");
  for (const mid of mids) store.delete(mid);
  await transactionDone(tx);
};

/** 读取全部关注事件，按发生时间升序 */
export const getAllFollowingEvents = async (): Promise<FollowingEvent[]> => {
  const db = await openDB();
  const tx = db.transaction("followingEvents", "readonly");
  const items = (await requestResult(
    tx.objectStore("followingEvents").getAll(),
  )) as FollowingEvent[];
  return items.sort((a, b) => a.occurred_at - b.occurred_at);
};

export const getFollowingEventsByDay = async (day: string): Promise<FollowingEvent[]> => {
  const db = await openDB();
  const tx = db.transaction("followingEvents", "readonly");
  const items = (await requestResult(
    tx.objectStore("followingEvents").index("day").getAll(day),
  )) as FollowingEvent[];
  return items.sort((a, b) => a.occurred_at - b.occurred_at);
};

/** 批量写入关注事件。event_id 为 `type:mid:day`，同日重复同步自然幂等。 */
export const putFollowingEvents = async (events: FollowingEvent[]): Promise<void> => {
  if (events.length === 0) return;
  const db = await openDB();
  const tx = db.transaction("followingEvents", "readwrite");
  const store = tx.objectStore("followingEvents");
  for (const event of events) store.put(event);
  await transactionDone(tx);
};

/** 写入关注快照与事件共用一个事务，避免只落其一 */
export const applyFollowingSync = async (
  items: FollowingItem[],
  events: FollowingEvent[],
): Promise<void> => {
  if (items.length === 0 && events.length === 0) return;
  const db = await openDB();
  const tx = db.transaction(["following", "followingEvents"], "readwrite");
  const itemStore = tx.objectStore("following");
  const eventStore = tx.objectStore("followingEvents");
  for (const item of items) itemStore.put(item);
  for (const event of events) eventStore.put(event);
  await transactionDone(tx);
};

export const putAsset = async (asset: AssetRecord): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("assets", "readwrite");
  tx.objectStore("assets").put(asset);
  await transactionDone(tx);
};

export const getAsset = async (id: string): Promise<AssetRecord | undefined> => {
  const db = await openDB();
  const tx = db.transaction("assets", "readonly");
  return (await requestResult(tx.objectStore("assets").get(id))) as AssetRecord | undefined;
};

export const deleteAsset = async (id: string): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("assets", "readwrite");
  tx.objectStore("assets").delete(id);
  await transactionDone(tx);
};

// ---------------------------------------------------------------------------
// WebDAV 双向同步的合并基元（fork 新增的三个 store）
//
// 三个都用**并集**语义，保证不丢数据。图片字节（assets）刻意不参与备份：
// 它是纯缓存，内容还在时随时能重抓，不该让备份体积膨胀几十 MB。
// ---------------------------------------------------------------------------

/**
 * 关注快照合并：按 `mid` 取并集。
 *
 * 冲突时保留「最近一次被观测到」的那条（`lastSeenAt` 更大者），
 * 因为状态与昵称都随时间演进，更晚的观测更准。
 * `nameHistory` 另做并集——否则会把另一台机器观测到的旧名丢掉。
 */
export const smartMergeFollowing = async (
  remoteItems: FollowingItem[],
): Promise<{ merged: number; skipped: number }> => {
  if (remoteItems.length === 0) return { merged: 0, skipped: 0 };

  const existing = await getAllFollowing();
  const byMid = new Map(existing.map((item) => [item.mid, item]));

  const db = await openDB();
  const tx = db.transaction(["following", "formerNames"], "readwrite");
  const store = tx.objectStore("following");
  const formerStore = tx.objectStore("formerNames");
  let merged = 0;
  let skipped = 0;

  for (const remote of remoteItems) {
    const local = byMid.get(remote.mid);
    if (!local) {
      store.put(remote);
      const record = toFormerNameRecord(remote);
      if (record) formerStore.put(record);
      merged += 1;
      continue;
    }

    const remoteIsNewer = (remote.lastSeenAt ?? 0) > (local.lastSeenAt ?? 0);
    const base = remoteIsNewer ? remote : local;
    const names = [...(local.nameHistory ?? [])];
    for (const record of remote.nameHistory ?? []) {
      if (!names.some((item) => item.name === record.name)) names.push(record);
    }

    // 曾用名不参与「哪边更新」的判断：两台机器各自查到的名字都要保留，
    // 查询时间取更晚的，展示下标优先本地（用户手动选过）。
    const thirdPartyNames = [
      ...new Set([...(local.thirdPartyNames ?? []), ...(remote.thirdPartyNames ?? [])]),
    ];
    const thirdPartyQueriedAt = Math.max(
      local.thirdPartyQueriedAt ?? 0,
      remote.thirdPartyQueriedAt ?? 0,
    );
    const mergedItem: FollowingItem = {
      ...base,
      nameHistory: names,
      thirdPartyNames,
      thirdPartyQueriedAt: thirdPartyQueriedAt || undefined,
      formerNameDisplayIndex: local.formerNameDisplayIndex ?? remote.formerNameDisplayIndex,
    };
    store.put(mergedItem);
    const record = toFormerNameRecord(mergedItem);
    if (record) formerStore.put(record);
    if (remoteIsNewer) merged += 1;
    else skipped += 1;
  }

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  return { merged, skipped };
};

/** 关注变动事件合并：按 `event_id` 取并集。事件是只增不改的，天然可并 */
export const smartMergeFollowingEvents = async (
  remoteItems: FollowingEvent[],
): Promise<{ merged: number; skipped: number }> => {
  if (remoteItems.length === 0) return { merged: 0, skipped: 0 };

  const existingIds = new Set((await getAllFollowingEvents()).map((event) => event.event_id));

  const db = await openDB();
  const tx = db.transaction("followingEvents", "readwrite");
  const store = tx.objectStore("followingEvents");
  let merged = 0;
  let skipped = 0;

  for (const event of remoteItems) {
    if (existingIds.has(event.event_id)) {
      skipped += 1;
      continue;
    }
    store.put(event);
    merged += 1;
  }

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  return { merged, skipped };
};

/**
 * 消失档案合并：按 `[folder_id, id]` 取并集。
 *
 * 冲突时保留**更早**的 `vanishedAt`——首次消失的时间才是真相，
 * 后来的同步只会把它往后推。
 */
export const smartMergeVanishedFavResources = async (
  remoteItems: VanishedFavResource[],
): Promise<{ merged: number; skipped: number }> => {
  if (remoteItems.length === 0) return { merged: 0, skipped: 0 };

  const existing = await getAllVanishedFavResources();
  const byKey = new Map(existing.map((item) => [`${item.folder_id}:${item.id}`, item]));

  const db = await openDB();
  const tx = db.transaction("vanishedFavResources", "readwrite");
  const store = tx.objectStore("vanishedFavResources");
  let merged = 0;
  let skipped = 0;

  for (const remote of remoteItems) {
    const local = byKey.get(`${remote.folder_id}:${remote.id}`);
    if (!local) {
      store.put(remote);
      merged += 1;
      continue;
    }
    if (remote.vanishedAt < local.vanishedAt) {
      store.put(remote);
      merged += 1;
    } else {
      skipped += 1;
    }
  }

  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

  return { merged, skipped };
};

export const countAssets = async (kind?: AssetKind): Promise<number> => {
  const db = await openDB();
  const tx = db.transaction("assets", "readonly");
  const store = tx.objectStore("assets");
  if (!kind) return await requestResult(store.count());
  return await requestResult(store.index("kind").count(kind));
};

/**
 * 取出各 store 的判重键集合，供导入前的预览统计使用。
 *
 * `history` 刻意**不在这里**——它可能有几万条，为了预览全读一遍不值得；
 * 预览时用 `getTotalHistoryCount()` 的总数代替。
 */
export const getBackupLocalIds = async (): Promise<Record<string, Set<string>>> => {
  const [
    liked,
    folders,
    resources,
    collections,
    collectionResources,
    collectionArchives,
    following,
    formerNames,
    events,
    vanished,
    interactions,
    vanishArchive,
  ] = await Promise.all([
    getAllLikedMusic(),
    getAllFavFolders(),
    getAllFavResources(),
    getAllSubscribedCollections(),
    getAllSubscribedCollectionResources(),
    getAllCollectionArchives(true),
    getAllFollowing(),
    getAllFormerNames(),
    getAllFollowingEvents(),
    getAllVanishedFavResources(),
    getAllInteractions(),
    getAllVanishArchive(),
  ]);

  return {
    likedMusic: new Set(liked.map((item) => String(item.bvid))),
    favFolders: new Set(folders.map((item) => String(item.id))),
    favResources: new Set(resources.map((item) => `${item.folder_id}:${item.id}`)),
    subscribedCollections: new Set(collections.map((item) => String(item.id))),
    subscribedCollectionResources: new Set(
      collectionResources.map((item) => String(item.id)),
    ),
    collectionArchives: new Set(collectionArchives.map((item) => String(item.id))),
    following: new Set(following.map((item) => String(item.mid))),
    formerNames: new Set(formerNames.map((item) => String(item.mid))),
    followingEvents: new Set(events.map((event) => String(event.event_id))),
    vanishedFavResources: new Set(vanished.map((item) => `${item.folder_id}:${item.id}`)),
    interactions: new Set(interactions.map((item) => String(item.id))),
    vanishArchive: new Set(vanishArchive.map((item) => item.id)),
  };
};

/**
 * 读取全部归档图片字节。用于本地目录备份把它们写成 `images/` 下的独立文件。
 *
 * 一次全读进内存（约 1900 张 × 5KB ≈ 10MB）——备份是低频操作，可以接受。
 */
export const getAllAssets = async (): Promise<AssetRecord[]> => {
  const db = await openDB();
  const tx = db.transaction("assets", "readonly");
  return (await requestResult(tx.objectStore("assets").getAll())) as AssetRecord[];
};

export const getAllAssetIds = async (): Promise<string[]> => {
  const db = await openDB();
  const tx = db.transaction("assets", "readonly");
  return (await requestResult(tx.objectStore("assets").getAllKeys())) as string[];
};

export const clearAssets = async (): Promise<void> => {
  const db = await openDB();
  const tx = db.transaction("assets", "readwrite");
  tx.objectStore("assets").clear();
  await transactionDone(tx);
  void appendDataSafetyEvent({
    at: Date.now(),
    kind: "asset-delete",
    message: "清空全部图片归档",
  });
};

/**
 * 收集仍被记录引用的封面字节 ID。
 *
 * 记录里的 `coverAssetId` 只是指针，真正的字在 `assets` 表里。清图片时如果
 * 不检查引用，就会把“唯一一份封面”删掉，留下一个永远解析失败的 ID。这里把
 * 可能引用封面的 store 全部扫一遍，清理时跳过这些 ID。
 */
const collectReferencedCoverAssetIds = async (): Promise<Set<string>> => {
  const db = await openDB();
  const storeNames = [
    "favResources",
    "vanishArchive",
    "subscribedCollectionResources",
    "collectionArchives",
    "interactions",
  ] as const;
  const tx = db.transaction(storeNames, "readonly");
  const referenced = new Set<string>();

  for (const storeName of storeNames) {
    const rows = (await requestResult(tx.objectStore(storeName).getAll())) as Array<{
      coverAssetId?: string;
    }>;
    for (const row of rows) {
      if (row?.coverAssetId) referenced.add(row.coverAssetId);
    }
  }

  await transactionDone(tx);
  return referenced;
};

/**
 * 按类型清空图片归档，返回删掉的条数、释放的字节数，以及因仍被记录引用而
 * 跳过的条数。
 *
 * 用 `kind` 索引走游标逐个删，而不是 `getAll()` 后再删：
 * `assets` 里是真实图片字节，一次全读进内存在大库上会明显卡顿甚至爆内存。
 *
 * 注意：不要在这里用 `setTimeout(() => cursor.continue(), 0)` 分批让出事件循环。
 * IndexedDB 事务一旦回到事件循环且没有挂起请求就会自动提交，下一帧再
 * `cursor.continue()` 会抛 `TransactionInactiveError`；而这个异常发生在
 * timeout 回调里，外层 Promise 永远不会 settle，界面就会一直卡在「正在清理」。
 * 游标本身的 success 回调已经是异步任务，浏览器有机会在两次回调之间渲染，
 * 直接同步 `continue()` 即可。
 */
export const clearAssetsByKind = async (
  kind: AssetKind,
): Promise<{ deleted: number; freedBytes: number; skipped: number }> => {
  const protectedIds = kind === "cover" ? await collectReferencedCoverAssetIds() : new Set<string>();
  const db = await openDB();
  const tx = db.transaction("assets", "readwrite");
  const index = tx.objectStore("assets").index("kind");
  let deleted = 0;
  let freedBytes = 0;
  let skipped = 0;

  await new Promise<void>((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only(kind));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const record = cursor.value as AssetRecord;
      if (protectedIds.has(record.id)) {
        skipped += 1;
        cursor.continue();
        return;
      }
      freedBytes += record?.blob?.size ?? 0;
      deleted += 1;
      try {
        cursor.delete();
        cursor.continue();
      } catch (cursorError) {
        // 事务已结束时 cursor.continue() 会同步抛错；必须 reject，否则外层
        // Promise 永远不 settle，界面会卡在「正在清理」。
        reject(cursorError);
      }
    };
    request.onerror = () => reject(request.error);
    tx.onabort = () => reject(tx.error);
    tx.onerror = () => reject(tx.error);
  });

  await transactionDone(tx);
  if (deleted > 0 || skipped > 0) {
    void appendDataSafetyEvent({
      at: Date.now(),
      kind: "asset-delete",
      message: kind === "cover" ? "清理封面图片归档" : "清理头像图片归档",
      detail: { deleted, skipped, freedBytes },
    });
  }
  return { deleted, freedBytes, skipped };
};

/**
 * 统计某类图片归档的条数与字节数。
 *
 * 字节数取 `blob.size`，是**精确值**（不是估算）：图片归档是本扩展里唯一
 * 存真实二进制的部分，也是占用的大头，所以它的数字必须可信。
 */
export const measureAssets = async (
  kind: AssetKind,
): Promise<{ count: number; bytes: number }> => {
  const db = await openDB();
  const tx = db.transaction("assets", "readonly");
  const index = tx.objectStore("assets").index("kind");
  let count = 0;
  let bytes = 0;

  return await new Promise<{ count: number; bytes: number }>((resolve, reject) => {
    const request = index.openCursor(IDBKeyRange.only(kind));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve({ count, bytes });
        return;
      }
      const record = cursor.value as AssetRecord;
      count += 1;
      bytes += record?.blob?.size ?? 0;
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
  });
};

/**
 * 结构化 store 的体积估算。
 *
 * 只读最多 `limit` 条算平均行大小再乘以总数——为了量体积把几万条观看事件
 * 全读一遍不值得。因此结果**是估算**，界面必须如实标注。
 *
 * 每行按字符类别计费（ASCII 1 字节、其余 2 字节，见 `estimateJsonBytes`），
 * 不再一律按 2 字节——那会让估算值大到超过浏览器报的整站用量。
 */
export const estimateStoreSize = async (
  storeName: string,
  limit = 50,
): Promise<{ count: number; bytes: number }> => {
  const db = await openDB();
  const tx = db.transaction(storeName, "readonly");
  const store = tx.objectStore(storeName);
  const count = await requestResult(store.count());
  if (count === 0) return { count: 0, bytes: 0 };

  const samples = await requestResult(store.getAll(undefined, limit));
  let sampleBytes = 0;
  let sampled = 0;
  for (const record of samples) {
    try {
      sampleBytes += estimateJsonBytes(JSON.stringify(record) ?? "");
    } catch {
      // 含循环引用的记录不该出现；真出现了就不计入样本，别让它把估算带崩
      continue;
    }
    sampled += 1;
  }
  if (sampled === 0) return { count, bytes: 0 };

  return { count, bytes: Math.round((sampleBytes / sampled) * count) };
};

/** 读取全部消失档案，按消失时间倒序（最近消失的在前） */
export const getAllVanishedFavResources = async (): Promise<VanishedFavResource[]> => {
  const db = await openDB();
  const tx = db.transaction("vanishedFavResources", "readonly");
  const items = (await requestResult(
    tx.objectStore("vanishedFavResources").getAll(),
  )) as VanishedFavResource[];
  return items.sort((a, b) => b.vanishedAt - a.vanishedAt);
};

export const countVanishedFavResources = async (): Promise<number> => {
  const db = await openDB();
  const tx = db.transaction("vanishedFavResources", "readonly");
  return await requestResult(tx.objectStore("vanishedFavResources").count());
};

// ---------------------------------------------------------------------------
// 统一消失档案（vanishArchive，v11）
//
// 旧的 `vanishedFavResources` 保持原样可读写（旧备份、旧版本兼容），
// 页面读的是两者合并后的结果，旧数据在首次打开页面时惰性迁入。
// ---------------------------------------------------------------------------

export const getAllVanishArchive = async (): Promise<VanishArchiveItem[]> => {
  const db = await openDB();
  const tx = db.transaction("vanishArchive", "readonly");
  return (await requestResult(tx.objectStore("vanishArchive").getAll())) as VanishArchiveItem[];
};

export const countVanishArchive = async (): Promise<number> => {
  const db = await openDB();
  const tx = db.transaction("vanishArchive", "readonly");
  return await requestResult(tx.objectStore("vanishArchive").count());
};

/**
 * 批量写入档案条目。
 *
 * 用 `put` 而不是 `add`：同一条内容每轮同步都会被重新判定一次，
 * 重复归档要幂等覆盖（`vanishedAt` 由纯函数保留最早值，不会被刷成新时间）。
 */
export const putVanishArchive = async (items: VanishArchiveItem[]): Promise<void> => {
  if (items.length === 0) return;
  // 先和已有档案按字段择优合并，再写回。
  // 同步拿到的资源可能已经被占位文案污染（标题「已失效视频」、封面空），
  // 直接 put 会把上次存下的真实标题/封面/coverAssetId 覆盖掉，而且不可逆。
  const existing = await getAllVanishArchive();
  const merged = mergeVanishArchive(existing, items);
  const db = await openDB();
  const tx = db.transaction("vanishArchive", "readwrite");
  const store = tx.objectStore("vanishArchive");
  for (const item of merged) store.put(item);
  await transactionDone(tx);
};

export const deleteVanishArchiveItems = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) return;
  const db = await openDB();
  const tx = db.transaction("vanishArchive", "readwrite");
  const store = tx.objectStore("vanishArchive");
  for (const id of ids) store.delete(id);
  await transactionDone(tx);
};

/**
 * 把档案条目**恢复到原来的 store 与原来的位置**。
 *
 * 这是"消失档案"存在的根本目的：归档的 `item` 是消失那一刻的完整快照，
 * 直接原样写回对应 store 即可让收藏夹 / 订阅合集 / 关注列表 / 互动记录页
 * 重新看到这条内容。没有它，档案就只是"一个只读的汇总列表"——
 * 清空浏览器数据后能靠备份把档案读回来，却回不到任何一个功能页面上。
 *
 * 刻意的行为：
 * - 只恢复**有快照**的条目。历史遗留档案没有 `item` 时跳过并在结果里说明，
 *   不猜、不伪造记录。
 * - **不删除档案条目**：恢复后档案仍保留，用户可以按需再删。
 *   档案只增不删这条原则不因为"恢复"而破例。
 * - 一个事务写多个 store：任一条错就整体回滚，避免"恢复了一半"。
 */
export const restoreVanishArchiveItems = async (
  items: VanishArchiveItem[],
): Promise<{ restored: number; skipped: number }> => {
  const restorable = items.filter(
    (item) => item && typeof item.id === "string" && item.item && typeof item.item === "object",
  );
  const skipped = items.length - restorable.length;
  if (restorable.length === 0) return { restored: 0, skipped };

  const db = await openDB();
  const storeNames = [
    "favResources",
    "subscribedCollectionResources",
    "following",
    "interactions",
  ] as const;

  const storeNameOf = (kind: VanishArchiveItem["kind"]): (typeof storeNames)[number] => {
    if (kind === "favorite") return "favResources";
    if (kind === "collection") return "subscribedCollectionResources";
    if (kind === "following") return "following";
    return "interactions";
  };

  const keyOf = (entry: VanishArchiveItem): IDBValidKey | undefined => {
    const snapshot = entry.item as Record<string, unknown>;
    if (entry.kind === "favorite") {
      return typeof snapshot.folder_id === "number" && typeof snapshot.id === "number"
        ? [snapshot.folder_id, snapshot.id]
        : undefined;
    }
    if (entry.kind === "following") {
      return typeof snapshot.mid === "number" ? snapshot.mid : undefined;
    }
    return typeof snapshot.id === "number" || typeof snapshot.id === "string"
      ? (snapshot.id as IDBValidKey)
      : undefined;
  };

  // 先一次性读出同主键的当前记录：恢复不能无条件覆盖它们，需要字段级合并。
  const currentByIndex = new Map<number, unknown>();
  const readTx = db.transaction(storeNames, "readonly");
  await Promise.all(
    restorable.map(async (entry, index) => {
      const key = keyOf(entry);
      if (key === undefined) return;
      const store = readTx.objectStore(storeNameOf(entry.kind)) as IDBObjectStore;
      currentByIndex.set(index, await requestResult(store.get(key)));
    }),
  );

  const tx = db.transaction(storeNames, "readwrite");
  let restored = 0;
  restorable.forEach((entry, index) => {
    const snapshot = entry.item as Record<string, unknown>;
    if (!snapshot || snapshot.id === undefined) return;
    const current = currentByIndex.get(index);
    const store = tx.objectStore(storeNameOf(entry.kind));
    if (entry.kind === "favorite") {
      store.put(
        mergeRestoredFavorite(
          snapshot as unknown as FavoriteResource,
          current as FavoriteResource | undefined,
        ),
      );
    } else {
      // 合集/关注/互动没有收藏那套字段级规则：快照补缺失，当前记录优先，
      // 避免恢复动作把后来更新的状态（如关注已注销）回退。
      store.put({
        ...snapshot,
        ...(current && typeof current === "object" ? current : {}),
      });
    }
    restored += 1;
  });

  await transactionDone(tx);
  return { restored, skipped };
};

/** 批量写入消失档案。档案只增不删，除非用户主动清理。 */
export const putVanishedFavResources = async (items: VanishedFavResource[]): Promise<void> => {
  if (items.length === 0) return;
  const db = await openDB();
  const tx = db.transaction("vanishedFavResources", "readwrite");
  const store = tx.objectStore("vanishedFavResources");
  for (const item of items) store.put(item);
  await transactionDone(tx);
};

export const deleteVanishedFavResources = async (keys: Array<[number, number]>): Promise<void> => {
  if (keys.length === 0) return;
  const db = await openDB();
  const tx = db.transaction("vanishedFavResources", "readwrite");
  const store = tx.objectStore("vanishedFavResources");
  for (const key of keys) store.delete(key);
  await transactionDone(tx);
};

/**
 * 从 favResources 移入消失档案：同一事务内写入档案并删除原记录。
 * 保证不会出现"已从收藏夹移除、但档案没写成功"的证据丢失。
 */
export const moveFavResourcesToVanished = async (
  folderId: number,
  items: VanishedFavResource[],
): Promise<void> => {
  if (items.length === 0) return;
  const db = await openDB();
  const tx = db.transaction(["favResources", "vanishedFavResources"], "readwrite");
  const favStore = tx.objectStore("favResources");
  const vanishedStore = tx.objectStore("vanishedFavResources");
  for (const item of items) {
    vanishedStore.put(item);
    favStore.delete([folderId, item.id]);
  }
  await transactionDone(tx);
};

// ---------------------------------------------------------------------------
// v10 新增：点赞 / 投币互动记录（interactions）
//
// 与关注模块同样的分工：本层只做存取，判定逻辑全在 utils/interactionDiff.ts 的纯函数里。
// 主键是字符串 `${type}:${bvid}`，所以同一条视频的点赞与投币互不覆盖。
// ---------------------------------------------------------------------------

/** 读取全部互动记录，按最近一次被同步扫到的时间倒序 */
export const getAllInteractions = async (): Promise<InteractionItem[]> => {
  const db = await openDB();
  const tx = db.transaction("interactions", "readonly");
  const items = (await requestResult(tx.objectStore("interactions").getAll())) as
    | InteractionItem[]
    | undefined;
  return (items ?? []).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
};

/** 按类型读取互动记录。同步只关心同一类型的既有记录 */
export const getInteractionsByType = async (
  type: InteractionType,
): Promise<InteractionItem[]> => {
  const db = await openDB();
  const tx = db.transaction("interactions", "readonly");
  const items = (await requestResult(
    tx.objectStore("interactions").index("type").getAll(type),
  )) as InteractionItem[] | undefined;
  return (items ?? []).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
};

export const countInteractions = async (type?: InteractionType): Promise<number> => {
  const db = await openDB();
  const tx = db.transaction("interactions", "readonly");
  const store = tx.objectStore("interactions");
  if (!type) return await requestResult(store.count());
  return await requestResult(store.index("type").count(type));
};

/** 批量写入互动记录。不做判定，调用方负责传入已经算好的最终状态 */
export const putInteractionItems = async (items: InteractionItem[]): Promise<void> => {
  if (items.length === 0) return;
  const db = await openDB();
  const tx = db.transaction("interactions", "readwrite");
  const store = tx.objectStore("interactions");
  for (const item of items) store.put(item);
  await transactionDone(tx);
};

/**
 * 按 id 删除互动记录（用户主动清理）。
 *
 * **这是互动记录唯一的删除入口**，只由用户在界面上触发。
 * 同步流程永远不删——掉出 20 条窗口、探测失败、判定为"赞已消失"的条目都保留，
 * 因为 `relation` 接口只反映近期状态，"查不到"不等于"用户取消了"。
 *
 * 注意一个已知后果：删掉的条目如果仍在 B 站列表里，下次同步会**重新抓回来**；
 * 已经从列表掉出去的（窗口外）才会真正消失。界面文案必须说清这一点。
 */
export const deleteInteractionItems = async (ids: string[]): Promise<void> => {
  if (ids.length === 0) return;
  const db = await openDB();
  const tx = db.transaction("interactions", "readwrite");
  const store = tx.objectStore("interactions");
  for (const id of ids) store.delete(id);
  await transactionDone(tx);
};

/**
 * 按 id 批量打补丁（回填 coverAssetId 等）。
 *
 * 读与写必须分成两个事务：同一事务里 await 每次 get，一旦没有待处理请求事务就会自动提交，
 * 后续 put 会抛 TransactionInactiveError。这一点与 `patchFollowingItems` 完全一致。
 */
export const patchInteractionItems = async (
  ids: string[],
  patch: Partial<InteractionItem>,
): Promise<number> => {
  if (ids.length === 0) return 0;

  const db = await openDB();
  const readTx = db.transaction("interactions", "readonly");
  const readStore = readTx.objectStore("interactions");
  const current = (await Promise.all(
    ids.map((id) => requestResult(readStore.get(id)) as Promise<InteractionItem | undefined>),
  )) as Array<InteractionItem | undefined>;

  const writeTx = db.transaction("interactions", "readwrite");
  const writeStore = writeTx.objectStore("interactions");
  let changed = 0;
  for (const item of current) {
    if (!item) continue;
    writeStore.put({ ...item, ...patch });
    changed++;
  }
  await transactionDone(writeTx);
  return changed;
};

/** 写入封面归档结果。与 `applyFavResourceRecovery` 同构，只是 store 不同 */
export const applyInteractionCoverAssets = async (
  updates: InteractionItem[],
): Promise<number> => {
  if (updates.length === 0) return 0;
  await putInteractionItems(updates);
  return updates.length;
};

const earlierOf = (a: number | undefined, b: number | undefined): number | undefined => {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
};

/**
 * 互动记录合并：按 `id` 取并集。
 *
 * 冲突时逐字段取更可信的一方，而不是整条二选一：
 * - `lastSeenAt` 更大者作基（状态与标题都随时间演进，更晚的观测更准）
 * - `firstSeenAt` / `firstTitle` 取**更早**的一方：首次观测才是"我当时点的是什么"的真相
 * - `unlistedDetectedAt` / `endedDetectedAt` 取**更早**的一方：首次发现消失的时间才有意义
 * - `interactedAt` 优先保留有接口时间戳（exact）的那一方
 */
export const smartMergeInteractions = async (
  remoteItems: InteractionItem[],
): Promise<{ merged: number; skipped: number }> => {
  if (remoteItems.length === 0) return { merged: 0, skipped: 0 };

  const existing = await getAllInteractions();
  const byId = new Map(existing.map((item) => [item.id, item]));

  const db = await openDB();
  const tx = db.transaction("interactions", "readwrite");
  const store = tx.objectStore("interactions");
  let merged = 0;
  let skipped = 0;

  for (const remote of remoteItems) {
    if (!remote || typeof remote.id !== "string" || !remote.id) continue;
    const local = byId.get(remote.id);
    if (!local) {
      store.put(remote);
      merged += 1;
      continue;
    }

    const remoteIsNewer = (remote.lastSeenAt ?? 0) > (local.lastSeenAt ?? 0);
    const base = remoteIsNewer ? remote : local;
    const other = remoteIsNewer ? local : remote;
    const firstIsRemote =
      (remote.firstSeenAt ?? Number.MAX_SAFE_INTEGER) <
      (local.firstSeenAt ?? Number.MAX_SAFE_INTEGER);

    const interactedSource =
      remote.interactedAtExact && !local.interactedAtExact
        ? remote
        : local.interactedAtExact && !remote.interactedAtExact
          ? local
          : base;

    store.put({
      ...base,
      firstSeenAt: Math.min(local.firstSeenAt ?? 0, remote.firstSeenAt ?? 0) || base.firstSeenAt,
      firstTitle: firstIsRemote ? remote.firstTitle : local.firstTitle,
      interactedAt: interactedSource.interactedAt,
      interactedAtExact: interactedSource.interactedAtExact,
      unlistedDetectedAt: earlierOf(local.unlistedDetectedAt, remote.unlistedDetectedAt),
      endedDetectedAt: earlierOf(local.endedDetectedAt, remote.endedDetectedAt),
      probeAttemptedAt:
        Math.max(local.probeAttemptedAt ?? 0, remote.probeAttemptedAt ?? 0) || undefined,
      probeError: base.probeError ?? other.probeError,
      coverAssetId: local.coverAssetId ?? remote.coverAssetId,
    });
    if (remoteIsNewer) merged += 1;
    else skipped += 1;
  }

  await transactionDone(tx);
  return { merged, skipped };
};

/**
 * 消失档案合并：按 `id` 取并集，同一条冲突时**保留消失时间更早的一版**。
 *
 * 理由：`vanishedAt` 回答的是"它什么时候没的"，两端都记过同一条时，
 * 更早那个才是真相；后面的观测只是重复判定。其余字段取更晚的一次观测
 * （`probeAttemptedAt` / `reason` / 快照），因为那是最新掌握的信息。
 */
export const smartMergeVanishArchive = async (
  remoteItems: VanishArchiveItem[],
): Promise<{ merged: number; skipped: number }> => {
  if (remoteItems.length === 0) return { merged: 0, skipped: 0 };

  const existing = await getAllVanishArchive();
  const byId = new Map(existing.map((item) => [item.id, item]));

  const db = await openDB();
  const tx = db.transaction("vanishArchive", "readwrite");
  const store = tx.objectStore("vanishArchive");
  let merged = 0;
  let skipped = 0;

  for (const remote of remoteItems) {
    if (!remote || typeof remote.id !== "string" || !remote.id) continue;
    const local = byId.get(remote.id);
    if (!local) {
      store.put(remote);
      merged += 1;
      continue;
    }

    const remoteIsNewer = (remote.probeAttemptedAt ?? 0) > (local.probeAttemptedAt ?? 0);
    const mergedArchive = mergeVanishArchive([local], [remote])[0];
    store.put({
      ...mergedArchive,
      // 探测时间取两边较新的，避免旧备份让已核查状态回退
      probeAttemptedAt: Math.max(local.probeAttemptedAt ?? 0, remote.probeAttemptedAt ?? 0),
      // 封面归档指针是本地资产，优先保留已有的
      coverAssetId: local.coverAssetId ?? remote.coverAssetId,
    });
    if (remoteIsNewer) merged += 1;
    else skipped += 1;
  }

  await transactionDone(tx);
  return { merged, skipped };
};

