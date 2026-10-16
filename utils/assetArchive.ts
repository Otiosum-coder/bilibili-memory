import { getAsset, putAsset } from "./db";
import {
  AVATAR_THUMB_SIZE,
  COVER_THUMB_SIZE,
  buildAssetId,
  buildThumbUrl,
  isPlaceholderImage,
  normalizeImageUrl,
  type ImageSize,
} from "./imageUrl";
import type { AssetKind, AssetRecord } from "./types";

/**
 * 图片字节归档：关注头像与收藏封面共用。
 *
 * 关键背景（Phase 1b / Phase 2 实测）：
 * - 视频失效后封面会被 B站 统一替换为占位图，账号注销后头像会被替换为 noface.jpg。
 *   所以归档**必须在图片还正常时做**，"等发现消失再抓"只会抓到占位图。
 * - 接口返回的是**原图**，实测 71.5 KB。若不使用缩略参数，1142 个头像约占 80 MB。
 *   因此默认抓缩略图；缩略参数被服务端忽略时回退原图，并记录实际使用的 URL。
 * - 字节只存本地 IndexedDB，不进 WebDAV 与本地目录备份。
 *
 * 纯 URL 工具在 `imageUrl.ts`，这里只保留需要 IndexedDB 的部分；
 * 同时把它们重新导出，保持既有导入路径可用。
 */

export * from "./imageUrl";

export interface ArchiveImageResult {
  assetId: string;
  /** 实际抓取到的地址（可能是缩略图，也可能是回退的原图） */
  usedUrl: string;
  mimeType: string;
  byteSize: number;
}

/**
 * 抓取并归档一张图片。
 *
 * - 已存在且来源一致时直接复用，不重复下载。
 * - 先试缩略地址，失败则回退原图（应对缩略参数不被支持的情况）。
 * - 网络失败会抛错，由调用方决定是否重试；**不做静默吞错**，避免"以为归档了其实没有"。
 */
export const archiveImage = async (
  kind: AssetKind,
  raw: string | undefined | null,
  size: ImageSize,
): Promise<ArchiveImageResult | null> => {
  const base = normalizeImageUrl(raw);
  const assetId = buildAssetId(kind, raw);
  if (!base || !assetId) return null;

  const thumbUrl = buildThumbUrl(base, size);
  const candidates = thumbUrl && thumbUrl !== base ? [thumbUrl, base] : [base];

  const existing = await getAsset(assetId);
  if (existing && existing.blob.size > 0 && candidates.includes(existing.sourceUrl)) {
    return {
      assetId,
      usedUrl: existing.sourceUrl,
      mimeType: existing.mimeType,
      byteSize: existing.blob.size,
    };
  }

  let lastError: Error | null = null;
  for (const url of candidates) {
    try {
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) {
        lastError = new Error(`图片下载失败 HTTP ${response.status}`);
        continue;
      }
      const blob = await response.blob();
      if (blob.size === 0) {
        lastError = new Error("图片内容为空");
        continue;
      }

      const record: AssetRecord = {
        id: assetId,
        kind,
        mimeType: blob.type || "image/jpeg",
        blob,
        sourceUrl: url,
        createdAt: Date.now(),
      };
      await putAsset(record);
      return { assetId, usedUrl: url, mimeType: record.mimeType, byteSize: blob.size };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("图片归档失败");
};

/** 读取归档字节并生成可供 <img> 使用的对象地址。调用方负责在卸载时 URL.revokeObjectURL */
export const createAssetObjectUrl = async (assetId?: string): Promise<string | null> => {
  if (!assetId) return null;
  const asset = await getAsset(assetId);
  if (!asset || asset.blob.size === 0) return null;
  return URL.createObjectURL(asset.blob);
};

/** 归档头像的便捷入口（跳过占位图） */
export const archiveAvatar = async (
  face: string | undefined | null,
): Promise<ArchiveImageResult | null> => {
  if (isPlaceholderImage(face)) return null;
  return await archiveImage("avatar", face, AVATAR_THUMB_SIZE);
};

/** 归档收藏/合集封面的便捷入口（跳过占位图） */
export const archiveCover = async (
  cover: string | undefined | null,
): Promise<ArchiveImageResult | null> => {
  if (isPlaceholderImage(cover)) return null;
  return await archiveImage("cover", cover, COVER_THUMB_SIZE);
};
