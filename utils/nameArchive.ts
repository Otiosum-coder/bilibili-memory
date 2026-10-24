import { NAME_ARCHIVE_DATA } from "./constants";
import { isGoneName } from "./followingDiff";
import { getStorageValue, removeStorageValue, setStorageValue } from "./storage";
import type { FollowingItem } from "./types";

/**
 * 本地曾用名存档（只在本地构建启用）。
 *
 * 数据形态：离线脚本 `tools/hname-build.mjs` 从 aicu 快照里切出的 JSON，
 * 只包含关注列表里那些 UID 的名字，体积约几十 KB。导入后存在
 * `browser.storage.local` 的一个键里——**不进 IndexedDB、不进备份、不上传、
 * 不参与 WebDAV 同步**。
 *
 * 展示规则（与 `NameHistoryPopover` 的既有设计保持一致）：
 * - 第三方存档没有时间戳、顺序不可信，所以只作为"独立区块"展示，
 *   绝不并入 `nameHistory` 那条带时间的时间轴；
 * - 空结果不代表没改过名（可能只是未收录），UI 不得下结论。
 */

export const NAME_ARCHIVE_FORMAT_VERSION = 1;

/** 与切片脚本保持一致：超过这个长度基本是脏数据（评论正文等） */
const MAX_NAME_LENGTH = 30;
const MAX_NAMES_PER_UID = 500;

export interface NameArchiveMeta {
  formatVersion: number;
  source: string;
  generatedAt: string;
  /** 生成切片时关注列表的 UID 总数 */
  followingCount: number;
  /** 其中在快照里查到的 UID 数 */
  matchedUids: number;
  /** 名字总条数 */
  totalNames: number;
}

export interface ParsedNameArchive {
  meta: NameArchiveMeta;
  entries: Map<number, string[]>;
}

const toCount = (value: unknown): number | null => {
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) return null;
  return Math.floor(num);
};

/** 解析并校验切片；任何结构问题都抛错，避免把坏数据写进 storage */
export const parseNameArchive = (text: string): ParsedNameArchive => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("不是合法的 JSON 文件");
  }
  if (!raw || typeof raw !== "object") throw new Error("切片格式错误：根节点不是对象");
  const record = raw as Record<string, unknown>;
  if (toCount(record.formatVersion) !== NAME_ARCHIVE_FORMAT_VERSION) {
    throw new Error(`切片版本不受支持：${String(record.formatVersion)}`);
  }
  const entriesRaw = record.entries;
  if (!entriesRaw || typeof entriesRaw !== "object" || Array.isArray(entriesRaw)) {
    throw new Error("切片格式错误：缺少 entries 对象");
  }

  const entries = new Map<number, string[]>();
  for (const [key, namesRaw] of Object.entries(entriesRaw as Record<string, unknown>)) {
    const mid = Number(key);
    if (!Number.isFinite(mid) || mid <= 0 || !Array.isArray(namesRaw)) continue;
    const names: string[] = [];
    for (const value of namesRaw) {
      if (typeof value !== "string") continue;
      const name = value.trim();
      if (!name || name.length > MAX_NAME_LENGTH || isGoneName(name)) continue;
      if (names.includes(name)) continue;
      names.push(name);
      if (names.length >= MAX_NAMES_PER_UID) break;
    }
    if (names.length > 0) entries.set(Math.floor(mid), names);
  }

  const totalNames =
    toCount(record.totalNames) ??
    [...entries.values()].reduce((sum, names) => sum + names.length, 0);

  return {
    meta: {
      formatVersion: NAME_ARCHIVE_FORMAT_VERSION,
      source: typeof record.source === "string" ? record.source : "unknown",
      generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : "",
      followingCount: toCount(record.followingCount) ?? 0,
      matchedUids: toCount(record.matchedUids) ?? entries.size,
      totalNames,
    },
    entries,
  };
};

/**
 * 把存档里的名字合并成"可展示的曾用名"。
 *
 * 过滤掉：空值、占位文案、超长脏数据、与当前昵称相同的名字、
 * 本地时间轴里已经出现过的名字（避免两块重复），以及重复项。
 */
export const mergeFormerNames = (
  item: Pick<FollowingItem, "name" | "nameHistory" | "thirdPartyNames">,
  archiveNames: readonly string[] | undefined,
): string[] => {
  const candidates = [...(item.thirdPartyNames ?? []), ...(archiveNames ?? [])];
  if (candidates.length === 0) return [];

  const localNames = new Set((item.nameHistory ?? []).map((record) => record.name));
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const candidate of candidates) {
    const name = (candidate ?? "").trim();
    if (!name || name.length > MAX_NAME_LENGTH) continue;
    if (isGoneName(name)) continue;
    if (name === item.name) continue;
    if (localNames.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    merged.push(name);
  }
  return merged;
};

/**
 * 渲染前给关注项叠加存档名字。没有可展示的名字时**原样返回**，
 * 避免无谓地复制对象（列表可能有上千项）。
 */
export const applyArchiveNames = (
  item: FollowingItem,
  archiveNames?: readonly string[],
): FollowingItem => {
  const thirdPartyNames = mergeFormerNames(item, archiveNames);
  if (thirdPartyNames.length === 0) return item;
  return { ...item, thirdPartyNames };
};

// ---------------------------------------------------------------------------
// 存储（只在本地构建启用）
// ---------------------------------------------------------------------------

let cache: ParsedNameArchive | null | undefined;

/**
 * 是否启用本地曾用名存档（构建期语义见 types/name-archive.d.ts）。
 * - dev server / development 构建：true；
 * - 商店构建：false，面板不会渲染、切片不会被读取。
 */
export const NAME_ARCHIVE_ENABLED: boolean =
  import.meta.env.DEV || import.meta.env.VITE_NAME_ARCHIVE_LOCAL === "1";

export const isNameArchiveEnabled = (): boolean => NAME_ARCHIVE_ENABLED;

/** 读取本机存档；未导入或关闭该功能时返回 null */
export const loadNameArchive = async (): Promise<ParsedNameArchive | null> => {
  if (!NAME_ARCHIVE_ENABLED) return null;
  if (cache !== undefined) return cache;
  const raw = await getStorageValue<string | null>(NAME_ARCHIVE_DATA, null);
  if (!raw) {
    cache = null;
    return null;
  }
  try {
    cache = parseNameArchive(raw);
  } catch (error) {
    console.warn("曾用名存档解析失败，已按未导入处理:", error);
    cache = null;
  }
  return cache;
};

/** 导入切片。校验通过才写入，写失败不会留下半份数据 */
export const saveNameArchive = async (text: string): Promise<ParsedNameArchive> => {
  const parsed = parseNameArchive(text);
  if (parsed.entries.size === 0) {
    throw new Error("切片里没有任何可用名字");
  }
  await setStorageValue(NAME_ARCHIVE_DATA, text);
  cache = parsed;
  return parsed;
};

export const clearNameArchive = async (): Promise<void> => {
  await removeStorageValue(NAME_ARCHIVE_DATA);
  cache = null;
};
