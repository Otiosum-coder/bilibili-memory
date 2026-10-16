/**
 * 备份导入预览（纯函数）。
 *
 * 现状是「导入完只报一个数字」，用户点之前完全不知道会发生什么——
 * 一次误操作可能覆盖掉本地更新的数据。所以导入前先算清楚：
 * 文件里有多少条、本地已有多少、真正会新增多少。
 *
 * 这里只做**判重统计**，不涉及任何写库，也不模拟合并规则
 * （各 store 的合并策略不同，见 `utils/db.ts` 的 `smartMerge*`）。
 */

export interface BackupKeySpec {
  key: string;
  label: string;
  /** 从一条记录里取出判重键。取不到返回 null（该条不计入统计） */
  idOf: (item: any) => string | null;
}

export const BACKUP_KEY_SPECS: BackupKeySpec[] = [
  { key: "history", label: "历史记录", idOf: (item) => (item?.id != null ? String(item.id) : null) },
  { key: "favFolders", label: "收藏夹", idOf: (item) => (item?.id != null ? String(item.id) : null) },
  {
    key: "favResources",
    label: "收藏资源",
    idOf: (item) =>
      item?.id != null && item?.folder_id != null ? `${item.folder_id}:${item.id}` : null,
  },
  {
    key: "subscribedCollections",
    label: "订阅合集",
    idOf: (item) => (item?.id != null ? String(item.id) : null),
  },
  {
    key: "subscribedCollectionResources",
    label: "合集视频",
    idOf: (item) => (item?.id != null ? String(item.id) : null),
  },
  { key: "following", label: "关注的 UP 主", idOf: (item) => (item?.mid != null ? String(item.mid) : null) },
  {
    key: "followingEvents",
    label: "关注变动",
    idOf: (item) => (item?.event_id ? String(item.event_id) : null),
  },
  {
    key: "vanishedFavResources",
    label: "消失档案",
    idOf: (item) =>
      item?.id != null && item?.folder_id != null ? `${item.folder_id}:${item.id}` : null,
  },
  {
    key: "interactions",
    label: "点赞与投币",
    // 主键本身就是 `${type}:${bvid}`，直接拿它判重；缺 id 的旧数据按 type+bvid 兜底
    idOf: (item) =>
      item?.id != null
        ? String(item.id)
        : item?.type != null && item?.bvid != null
          ? `${item.type}:${item.bvid}`
          : null,
  },
];

export interface BackupPreviewRow {
  key: string;
  label: string;
  /** 文件里这一项的条数 */
  incoming: number;
  /** 与本地判重键重合的条数（会被合并/跳过） */
  existing: number;
  /** 本地没有的条数（真正会新增的） */
  isNew: number;
}

/**
 * 统计每一项的新增/重复情况。
 *
 * `localIdsByKey` 只对**能列出全部判重键**的 store 提供；`history` 数据量太大，
 * 用总数代替（见 `historyLocalCount`），否则导入前的预览本身就要读几万条记录。
 */
export const buildBackupPreview = (
  payload: Record<string, unknown>,
  localIdsByKey: Record<string, Set<string>>,
  historyLocalCount = 0,
): BackupPreviewRow[] => {
  const rows: BackupPreviewRow[] = [];

  for (const spec of BACKUP_KEY_SPECS) {
    const raw = payload[spec.key];
    if (!Array.isArray(raw)) continue;

    if (spec.key === "history") {
      rows.push({
        key: spec.key,
        label: spec.label,
        incoming: raw.length,
        existing: Math.min(historyLocalCount, raw.length),
        isNew: Math.max(0, raw.length - historyLocalCount),
      });
      continue;
    }

    const localIds = localIdsByKey[spec.key] ?? new Set<string>();
    let existing = 0;

    for (const item of raw) {
      const id = spec.idOf(item);
      if (id === null) continue;
      if (localIds.has(id)) existing += 1;
    }

    rows.push({
      key: spec.key,
      label: spec.label,
      incoming: raw.length,
      existing,
      isNew: raw.length - existing,
    });
  }

  return rows;
};

/** 组装成人能读的多行文本，供确认对话框展示 */
export const formatBackupPreview = (rows: BackupPreviewRow[]): string => {
  if (rows.length === 0) return "文件里没有可识别的数据项。";

  const lines = rows.map((row) => {
    if (row.isNew === 0) {
      return `${row.label}：${row.incoming} 条，本地都已有`;
    }
    return `${row.label}：${row.incoming} 条，其中 ${row.isNew} 条是新的，${row.existing} 条本地已有`;
  });

  const totalNew = rows.reduce((sum, row) => sum + row.isNew, 0);
  lines.push("");
  lines.push(`合计新增约 ${totalNew} 条。本地更新的数据不会被覆盖。`);

  return lines.join("\n");
};
