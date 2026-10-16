import { FOLLOWING_STATUS_LABEL, resolveDisplayName, followTimeOf } from "./followingQuery";
import {
  INTERACTION_STATE_LABEL,
  INTERACTION_TYPE_LABEL,
  interactionTimeLabel,
} from "./interactionQuery";
import { VANISH_REASON_LABEL } from "./favVanishedDiff";
import { formatDateTime, formatDuration } from "./format";
import type {
  FavoriteResource,
  FollowingItem,
  InteractionItem,
  VanishedFavResource,
} from "./types";

/**
 * 通用格式导出（CSV / Markdown）。
 *
 * 目的：**万一哪天不用这个插件了，数据还能用。**
 * JSON 备份只对本插件有意义；CSV 能进 Excel，Markdown 能直接看。
 *
 * 两个容易踩的坑，这里都处理了：
 *
 * 1. **CSV 必须带 UTF-8 BOM**。否则 Excel 打开中文会乱码——这是"导出能用"
 *    与"导出看着像乱码"的区别。
 * 2. **字段里的逗号、引号、换行必须转义**。B 站标题里带逗号非常常见。
 */

/** Excel 需要 BOM 才能正确识别 UTF-8 */
export const UTF8_BOM = "\uFEFF";

/** 按 RFC 4180 转义单个字段 */
export const escapeCsvField = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
};

/** 把二维数组转成 CSV 文本（含 BOM，供 Excel 直接打开） */
export const toCsv = (headers: string[], rows: Array<Array<unknown>>): string => {
  const lines = [headers.map(escapeCsvField).join(",")];
  for (const row of rows) {
    lines.push(row.map(escapeCsvField).join(","));
  }
  return `${UTF8_BOM}${lines.join("\r\n")}\r\n`;
};

/** Markdown 表格单元里的竖线必须转义，否则会把表格拆散 */
const escapeMarkdownCell = (value: unknown): string =>
  String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ");

const toMarkdownTable = (headers: string[], rows: Array<Array<unknown>>): string => {
  const head = `| ${headers.map(escapeMarkdownCell).join(" | ")} |`;
  const divider = `| ${headers.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${row.map(escapeMarkdownCell).join(" | ")} |`);
  return [head, divider, ...body].join("\n");
};

// ---------------------------------------------------------------------------
// 收藏
// ---------------------------------------------------------------------------

const FAVORITE_HEADERS = [
  "AV号",
  "BV号",
  "标题",
  "UP主",
  "UID",
  "时长",
  "播放数",
  "收藏数",
  "收藏时间",
  "失效原因",
  "信息来源",
];

const favoriteRow = (resource: FavoriteResource): unknown[] => [
  resource.id,
  resource.bvid || resource.bv_id || "",
  resource.title,
  resource.upper?.name ?? "",
  resource.upper?.mid ?? "",
  formatDuration(resource.duration),
  resource.cnt_info?.play ?? 0,
  resource.cnt_info?.collect ?? 0,
  resource.fav_time ? formatDateTime(resource.fav_time * 1000) : "",
  resource.attr ? String(resource.attr) : "",
  resource.recoverySource ?? (resource.recoveredAt ? "" : "本地原有"),
];

export const buildFavoritesCsv = (resources: FavoriteResource[]): string =>
  toCsv(FAVORITE_HEADERS, resources.map(favoriteRow));

// ---------------------------------------------------------------------------
// 关注
// ---------------------------------------------------------------------------

const FOLLOWING_HEADERS = ["UID", "昵称", "状态", "关注时间", "签名", "曾用名"];

const followingRow = (item: FollowingItem): unknown[] => [
  item.mid,
  resolveDisplayName(item),
  FOLLOWING_STATUS_LABEL[item.status],
  formatDateTime(followTimeOf(item)),
  item.sign ?? "",
  (item.nameHistory ?? [])
    .map((record) => record.name)
    .filter((name) => name !== item.name)
    .join(" / "),
];

export const buildFollowingCsv = (items: FollowingItem[]): string =>
  toCsv(FOLLOWING_HEADERS, items.map(followingRow));

// ---------------------------------------------------------------------------
// 消失档案
// ---------------------------------------------------------------------------

const VANISHED_HEADERS = ["AV号", "BV号", "消失前标题", "UP主", "消失原因", "消失时间"];

const vanishedRow = (record: VanishedFavResource): unknown[] => [
  record.id,
  record.bvid || record.bv_id || "",
  record.lastKnownTitle || record.title,
  record.upper?.name ?? "",
  VANISH_REASON_LABEL[record.vanishReason],
  formatDateTime(record.vanishedAt),
];

export const buildVanishedCsv = (records: VanishedFavResource[]): string =>
  toCsv(VANISHED_HEADERS, records.map(vanishedRow));

// ---------------------------------------------------------------------------
// 点赞 / 投币互动记录
// ---------------------------------------------------------------------------

const INTERACTION_HEADERS = [
  "类型",
  "BV号",
  "标题",
  "首次记录标题",
  "UP主",
  "UID",
  "时长",
  "状态",
  "互动时间",
  "时间是否精确",
  "首次记录时间",
  "投币数",
];

/**
 * 注意 `互动时间` 与 `时间是否精确` 两列必须分开：
 * 投币接口给真实的投币时间，点赞接口不返回点赞时间，本地只有"首次看到它"的时刻。
 * 把两者混成一列会让导出文件看起来像是有准确点赞时间——那是在编造数据。
 */
const interactionRow = (item: InteractionItem): unknown[] => [
  INTERACTION_TYPE_LABEL[item.type],
  item.bvid,
  item.title,
  item.firstTitle,
  item.authorName,
  item.authorMid,
  formatDuration(item.duration),
  INTERACTION_STATE_LABEL[item.state],
  formatDateTime(item.interactedAt),
  item.interactedAtExact ? "是" : `否（${interactionTimeLabel(item)}）`,
  formatDateTime(item.firstSeenAt),
  item.coins ?? "",
];

export const buildInteractionsCsv = (items: InteractionItem[]): string =>
  toCsv(INTERACTION_HEADERS, items.map(interactionRow));

export const buildInteractionsMarkdown = (items: InteractionItem[]): string => {
  const lines = [
    "# 点赞与投币记录",
    "",
    `导出时间：${formatDateTime(Date.now())}　共 ${items.length} 条`,
    "",
    "> B 站只保留最近 20 条点赞与投币记录。本文件是本地留存的副本；",
    "> 「互动时间」对点赞而言是首次记录时间（B 站不提供点赞时间），以「时间是否精确」列为准。",
    "",
    toMarkdownTable(
      ["类型", "标题", "UP主", "状态", "互动时间", "首次记录时间"],
      items.map((item) => [
        INTERACTION_TYPE_LABEL[item.type],
        item.title,
        item.authorName,
        INTERACTION_STATE_LABEL[item.state],
        formatDateTime(item.interactedAt),
        formatDateTime(item.firstSeenAt),
      ]),
    ),
    "",
  ];
  return lines.join("\n");
};

// ---------------------------------------------------------------------------
// Markdown（概览用，适合直接阅读）
// ---------------------------------------------------------------------------

export const buildFavoritesMarkdown = (
  resources: FavoriteResource[],
  folderTitles: Record<number, string> = {},
): string => {
  const lines = [
    "# 收藏内容",
    "",
    `导出时间：${formatDateTime(Date.now())}　共 ${resources.length} 条`,
    "",
  ];

  const byFolder = new Map<number, FavoriteResource[]>();
  for (const resource of resources) {
    const list = byFolder.get(resource.folder_id) ?? [];
    list.push(resource);
    byFolder.set(resource.folder_id, list);
  }

  for (const [folderId, list] of byFolder) {
    lines.push(`## ${folderTitles[folderId] ?? `收藏夹 ${folderId}`}（${list.length} 条）`);
    lines.push("");
    lines.push(
      toMarkdownTable(
        ["标题", "UP主", "时长", "收藏时间"],
        list.map((resource) => [
          resource.title,
          resource.upper?.name ?? "",
          formatDuration(resource.duration),
          resource.fav_time ? formatDateTime(resource.fav_time * 1000) : "",
        ]),
      ),
    );
    lines.push("");
  }

  return lines.join("\n");
};

export const buildFollowingMarkdown = (items: FollowingItem[]): string => {
  const lines = [
    "# 关注的 UP 主",
    "",
    `导出时间：${formatDateTime(Date.now())}　共 ${items.length} 位`,
    "",
    toMarkdownTable(
      ["UID", "昵称", "状态", "关注时间", "曾用名"],
      items.map((item) => [
        item.mid,
        resolveDisplayName(item),
        FOLLOWING_STATUS_LABEL[item.status],
        formatDateTime(followTimeOf(item)),
        (item.nameHistory ?? [])
          .map((record) => record.name)
          .filter((name) => name !== item.name)
          .join(" / "),
      ]),
    ),
    "",
  ];
  return lines.join("\n");
};

/** 供界面复用的导出规格，避免在页面里重复写表头与文件名 */
export const HUMAN_READABLE_EXPORTS = [
  { key: "favoritesCsv", label: "收藏内容 CSV", build: buildFavoritesCsv },
  { key: "followingCsv", label: "关注列表 CSV", build: buildFollowingCsv },
  { key: "vanishedCsv", label: "消失档案 CSV", build: buildVanishedCsv },
  { key: "interactionsCsv", label: "点赞与投币 CSV", build: buildInteractionsCsv },
] as const;
