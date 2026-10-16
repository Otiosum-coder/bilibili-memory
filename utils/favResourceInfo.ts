import { INVALIDATED_KIND_LABEL, isInvalidatedResource, resolveInvalidatedKind } from "./favVanishedDiff";
import { needsRecovery } from "./favRecovery";
import { formatDateTime, formatDuration } from "./format";
import type { FavoriteResource, FavRecoverySource } from "./types";

/**
 * 收藏条目的展示状态与信息导出。
 *
 * ## 三种状态（用户可感知的区分）
 *
 * | 状态 | 含义 | 表现 |
 * | --- | --- | --- |
 * | `normal` | 一直正常，从未失效 | 无徽章、无删除线 |
 * | `repaired` | 已失效，但**本地留有真实信息**（失效前同步过 / 第三方恢复） | 绿色徽章「已保留」+ 删除线标题 |
 * | `broken` | 已失效，且标题封面仍是占位内容 | 灰色徽章「已失效」+ 删除线 + 更浅的灰色标题 |
 *
 * 删除线沿用社区脚本的约定：**内容确实没了，只是我们还知道它是什么**。
 * 所以"已失效"这件事始终可见，不用颜色去掩盖。
 */

export type FavResourceState = "normal" | "repaired" | "broken";

/** 信息来源的中文说明。区分 B站 自身接口与第三方档案，避免把推测说成官方数据 */
export const RECOVERY_SOURCE_TEXT: Partial<Record<FavRecoverySource, string>> = {
  biliplus: "第三方档案 biliplus",
  jijidown: "第三方档案 jijidown",
  bilibili_pages: "B站 分P标题推测",
  bilibili_public: "B站 公开收藏夹接口",
  local_history: "本地观看历史",
  local_liked: "本地喜欢的音乐",
  local_collection: "本地订阅合集",
};

export const FAV_RESOURCE_STATE_LABEL: Record<FavResourceState, string> = {
  normal: "",
  repaired: "已保留",
  broken: "已失效",
};

export const FAV_RESOURCE_STATE_HINT: Record<FavResourceState, string> = {
  normal: "",
  repaired: "内容已失效，但本地保存了它的标题与封面",
  broken: "内容已失效，标题与封面仍是占位信息，可尝试「恢复失效内容」",
};

export const resolveFavResourceState = (resource: FavoriteResource): FavResourceState => {
  if (!isInvalidatedResource(resource)) return "normal";
  return needsRecovery(resource) ? "broken" : "repaired";
};

/**
 * 徽章文案。`repaired` 再细分两种来源，因为对用户来说含义不同：
 * - 「已保留」——失效**前**就同步过，信息一直在本地
 * - 「已恢复」——失效后才从第三方档案找回来的
 */
export const resolveFavResourceBadge = (resource: FavoriteResource): string => {
  const state = resolveFavResourceState(resource);
  if (state === "normal") return "";
  if (state === "broken") return FAV_RESOURCE_STATE_LABEL.broken;
  return resource.recoveredAt ? "已恢复" : "已保留";
};

export const resolveFavResourceHint = (resource: FavoriteResource): string => {
  const state = resolveFavResourceState(resource);
  if (state === "normal") return "";
  if (state === "broken") return FAV_RESOURCE_STATE_HINT.broken;
  return resource.recoveredAt
    ? "内容已失效，标题与封面来自第三方档案"
    : "内容已失效，但本地保存了它的标题与封面";
};

/**
 * 生成可复制的完整信息。
 *
 * 只输出**本地真正持有的字段**——不编造、不留空行。分区与点赞/投币/回复数
 * 我们的 `FavoriteResource` 并未存储（第三方 `/api/view` 才有），所以不列出来，
 * 避免用户复制到一行"未知"。
 */
export const buildResourceCopyText = (resource: FavoriteResource): string => {
  const lines: string[] = [
    `AV号：${resource.id}`,
    `BV号：${resource.bvid || resource.bv_id || "（无）"}`,
    `标题：${resource.title}`,
    `UP主：${resource.upper?.name || "未知"}（https://space.bilibili.com/${resource.upper?.mid ?? ""}）`,
  ];

  if (resource.intro) lines.push(`简介：${resource.intro}`);
  if (resource.duration > 0) lines.push(`时长：${formatDuration(resource.duration)}`);
  if (resource.pubtime) lines.push(`发布时间：${formatDateTime(resource.pubtime * 1000)}`);
  if (resource.fav_time) lines.push(`收藏时间：${formatDateTime(resource.fav_time * 1000)}`);

  lines.push(`播放数：${resource.cnt_info?.play ?? 0}`);
  lines.push(`收藏数：${resource.cnt_info?.collect ?? 0}`);
  lines.push(`弹幕数：${resource.cnt_info?.danmaku ?? 0}`);

  const kind = resolveInvalidatedKind(resource.attr);
  if (kind) lines.push(`失效原因：${INVALIDATED_KIND_LABEL[kind]}（attr=${resource.attr}）`);
  if (resource.recoveredAt) {
    lines.push(`信息来源：${RECOVERY_SOURCE_TEXT[resource.recoverySource ?? "biliplus"] ?? "第三方档案"}`);
  } else if (isInvalidatedResource(resource)) {
    lines.push("信息来源：失效前本地保存");
  }

  return lines.join("\n");
};
