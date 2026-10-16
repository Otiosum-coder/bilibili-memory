import type { AssetKind } from "./types";

/**
 * 图片地址的纯工具：归一化、占位图识别、缩略地址与 asset id 派生。
 *
 * 刻意与 `assetArchive.ts` 分开：这些是纯函数，不应因为 `assetArchive` 依赖 IndexedDB
 * 而被拖进 `db.ts` 的模块图，否则纯逻辑单测会被迫加载整个数据层。
 */

/** 头像缩略尺寸。原图 180×180，取 160 足够列表与卡片展示 */
export const AVATAR_THUMB_SIZE = { w: 160, h: 160 } as const;
/** 封面缩略尺寸。沿用仓库既有的 `@<w>w_<h>h_1c.<ext>` 写法 */
export const COVER_THUMB_SIZE = { w: 320, h: 200 } as const;

/** 注销账号的默认头像。Phase 1b 实测：15 个已注销账号全部指向该路径 */
export const NOFACE_PATH = "/bfs/face/member/noface.jpg";
/** 失效视频的默认封面。Phase 1b 实测：6 个采样全部指向该路径 */
export const PLACEHOLDER_COVER_PATH =
  "/bfs/archive/be27fd62c99036dce67efface486fb0a88ffed06.jpg";

export interface ImageSize {
  w: number;
  h: number;
}

/**
 * 归一化图片地址：补 https、去掉已有的 `@缩略参数` 后缀。
 * 无法解析时返回 null。
 */
export const normalizeImageUrl = (raw: string | undefined | null): string | null => {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;

  let url = trimmed;
  if (url.startsWith("//")) url = `https:${url}`;
  url = url.replace(/^http:\/\//i, "https://");
  // 去掉 `@160w_160h_1c.webp` 这类已存在的缩略参数
  url = url.replace(/@[^/@]*$/, "");

  try {
    const parsed = new URL(url);
    if (!parsed.hostname) return null;
    return url;
  } catch {
    return null;
  }
};

const pathnameOf = (raw: string | undefined | null): string | null => {
  const base = normalizeImageUrl(raw);
  if (!base) return null;
  try {
    return new URL(base).pathname;
  } catch {
    return null;
  }
};

/** 是否是平台占位图（注销头像 / 失效封面）。调用方仍应以 `attr !== 0` 作为主判定。 */
export const isPlaceholderImage = (raw: string | undefined | null): boolean => {
  const pathname = pathnameOf(raw);
  if (!pathname) return true;
  return pathname === NOFACE_PATH || pathname === PLACEHOLDER_COVER_PATH;
};

/** 构造带尺寸参数的缩略地址 */
export const buildThumbUrl = (
  raw: string | undefined | null,
  size: ImageSize,
  format = "webp",
): string | null => {
  const base = normalizeImageUrl(raw);
  if (!base) return null;
  return `${base}@${size.w}w_${size.h}h_1c.${format}`;
};

/**
 * 由图片地址派生稳定的 asset id。
 *
 * 用路径而非完整 URL：hdslb 的路径本身带内容哈希，天然唯一；
 * 且同一张图即使被不同尺寸参数引用也会命中同一条记录（自动去重）。
 */
export const buildAssetId = (kind: AssetKind, raw: string | undefined | null): string | null => {
  const pathname = pathnameOf(raw);
  if (!pathname) return null;
  return `${kind}:${pathname}`;
};

/**
 * 由 asset id 派生本地备份文件名。
 *
 * `cover:/bfs/archive/abc.jpg` → `cover__bfs_archive_abc.jpg`
 *
 * 放在这个纯模块而不是 `assetArchive.ts`：后者依赖 IndexedDB，
 * 会让这个映射无法被单测覆盖。映射是确定性的，所以还原时不需要额外映射表；
 * 同时保留了扩展名，文件在资源管理器里能正常预览。
 */
export const assetFileName = (assetId: string): string => assetId.replace(/[:/\\]/g, "_");
