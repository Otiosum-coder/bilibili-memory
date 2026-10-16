import { isInvalidatedResource } from "./favVanishedDiff";
import { isPlaceholderImage } from "./imageUrl";
import type { FavoriteResource, FavRecoverySource } from "./types";

/**
 * 收藏失效内容的恢复判定（纯函数，可单测）。
 *
 * ## Phase 4 实测确定的能力边界
 *
 * 用一个**真实的**失效稿件（`avid 116704059399752`，`attr 1`）实测四个来源：
 *
 * | 来源 | 结果 |
 * | --- | --- |
 * | B站 `x/web-interface/view` | ❌ `-404 啥都木有` |
 * | biliplus `/api/aidinfo` | ✅ 真实标题 + 真实封面 + UP 名 |
 * | biliplus `/api/view` | ✅ 同上，另含简介、分区、统计 |
 * | jijidown `/api/v1/video/get_info` | ✅ 真实标题 + 封面 |
 *
 * **注意一段被推翻的结论**：早先曾用 av1000 / av5000 这类 2009 年远古稿件当"已删除"
 * 样本，得出「`attr 1` 的条目第三方也查不到」，并据此给 `attr` 分类排了恢复优先级。
 * 那是**错误的取样**——远古未索引稿件与近期被删稿件完全不是一回事。用真实样本复测后
 * 证明 `attr 1` 同样可以被 biliplus / jijidown 恢复，因此**不再按 `attr` 排优先级**。
 *
 * biliplus 的 `author` 可能是快照值、与 B站 当前显示不同（实测同一 mid 下名字不一致），
 * 所以只在本地 UP 名为空或"账号已注销"时才用它覆盖。
 *
 * `xbeibeix` 实测 20 秒超时（等效下线），不纳入来源列表。
 */

/** B站 对失效稿件返回的占位标题 */
export const PLACEHOLDER_TITLE = "已失效视频";

export const RECOVERY_SOURCE_LABEL: Record<FavRecoverySource, string> = {
  biliplus: "biliplus",
  jijidown: "jijidown",
  bilibili_pages: "B站 分P标题",
  bilibili_public: "B站 公开收藏夹接口",
  local_history: "本地观看历史",
  local_liked: "本地喜欢的音乐",
  local_collection: "本地订阅合集",
};

/** 分P标题还原出的标题会追加此后缀，标明这是**推测**而非官方标题 */
export const TITLE_GUESS_SUFFIX = "（视频投稿上传时的标题）";

export const isPlaceholderTitle = (title: string | undefined | null): boolean => {
  const trimmed = (title ?? "").trim();
  return trimmed === "" || trimmed === PLACEHOLDER_TITLE;
};

/** biliplus `aidinfo` 返回的单条结构 */
export interface BiliplusAidInfo {
  title?: string;
  pic?: string;
  author?: string;
  mid?: number;
  created?: number;
}

/**
 * 是否需要恢复：标题或封面仍是占位内容。
 *
 * 本地可能已经有更好的数据——`saveFavResources` 的失效保护会在失效前同步过的情况下
 * 保留旧元数据。那种条目不需要恢复，`buildRecoveryCandidates` 会过滤掉。
 *
 * **刻意不检查 `recoveredAt`**：它只表示"曾经恢复过一部分"。分P标题还原只能补标题，
 * 封面还得靠第三方；若在这里提前返回，那些只补了标题的条目会永远失去补封面的机会。
 * 判断依据始终是"现在缺什么"，而不是"有没有补过"。
 */
export const needsRecovery = (resource: FavoriteResource): boolean => {
  if (!isInvalidatedResource(resource)) return false;
  return isPlaceholderTitle(resource.title) || isPlaceholderImage(resource.cover);
};

/**
 * aid 必须是正整数。
 *
 * 混进 `0` / `NaN` / `undefined` / 字符串会让第三方接口整批失败——
 * biliplus 报「cid无记录」时，很可能就是批里混了非法值。
 */
export const isValidAid = (aid: unknown): aid is number =>
  typeof aid === "number" && Number.isInteger(aid) && aid > 0;

/** 取出可查询的 aid，非法则返回 null */
export const toValidAid = (resource: FavoriteResource): number | null => {
  const aid = Number(resource.id);
  return isValidAid(aid) ? aid : null;
};

/**
 * 待恢复条目，保持调用方给定的顺序（收藏夹顺序，结果稳定可测）。
 *
 * 曾按 `invalidatedKind` 排优先级，依据是"`attr 9` 在 biliplus 命中率更高"。
 * **该依据已被真实样本推翻**（见文件头），所以不再做优先级假设。
 *
 * aid 非法的记录直接排除——它们无法被查询，留在候选里只会拖垮整批请求。
 */
export const buildRecoveryCandidates = (
  resources: FavoriteResource[],
  limit = Number.POSITIVE_INFINITY,
): FavoriteResource[] =>
  resources.filter((resource) => needsRecovery(resource) && toValidAid(resource) !== null)
    .slice(0, Math.max(0, limit));

/** biliplus 支持一次查多个 aid，但 URL 不宜过长 */
export const chunkAids = (aids: number[], size: number): number[][] => {
  const chunkSize = Math.max(1, Math.floor(size));
  const chunks: number[][] = [];
  for (let index = 0; index < aids.length; index += chunkSize) {
    chunks.push(aids.slice(index, index + chunkSize));
  }
  return chunks;
};

/** 新标题是否比旧标题更有价值 */
export const isBetterTitle = (oldTitle: string | undefined, newTitle: string | undefined): boolean => {
  const next = (newTitle ?? "").trim();
  if (!next || next === PLACEHOLDER_TITLE) return false;
  const current = (oldTitle ?? "").trim();
  return current === "" || current === PLACEHOLDER_TITLE;
};

/** 新封面是否比旧封面更有价值（占位图不算） */
export const isBetterCover = (oldCover: string | undefined, newCover: string | undefined): boolean => {
  if (!newCover || isPlaceholderImage(newCover)) return false;
  if (!oldCover || oldCover.trim() === "") return true;
  return isPlaceholderImage(oldCover);
};

/** UP 主名是否值得替换 */
export const isBetterUpperName = (oldName: string | undefined, newName: string | undefined): boolean => {
  const next = (newName ?? "").trim();
  if (!next || next === "账号已注销") return false;
  const current = (oldName ?? "").trim();
  return current === "" || current === "账号已注销";
};

export interface RecoveryOutcome {
  resource: FavoriteResource;
  changed: boolean;
  /** 实际被写入的字段，便于日志与界面展示 */
  fields: string[];
}

/**
 * 把 biliplus 的结果合并进本地记录。
 *
 * **只在确实更优时才覆盖**：本地可能已经在失效前保存了真实元数据，
 * 无脑覆盖会把好的数据换成占位内容。
 */
export const applyRecoveryResult = (
  resource: FavoriteResource,
  info: BiliplusAidInfo | undefined,
  source: FavRecoverySource,
  now: number,
): RecoveryOutcome => {
  if (!info) return { resource, changed: false, fields: [] };

  const next: FavoriteResource = { ...resource };
  const fields: string[] = [];

  if (isBetterTitle(next.title, info.title)) {
    next.title = (info.title ?? "").trim();
    fields.push("title");
  }
  if (isBetterCover(next.cover, info.pic)) {
    next.cover = info.pic!.trim();
    fields.push("cover");
  }
  if (isBetterUpperName(next.upper?.name, info.author)) {
    next.upper = { ...next.upper, name: info.author!.trim() };
    fields.push("upper.name");
  }
  if (info.mid && !next.upper?.mid) {
    next.upper = { ...next.upper, mid: info.mid };
    fields.push("upper.mid");
  }

  if (fields.length === 0) return { resource, changed: false, fields: [] };

  next.recoveredAt = now;
  next.recoverySource = source;
  return { resource: next, changed: true, fields };
};

/**
 * 从分P 信息还原标题。
 *
 * B站 对失效稿件会把 `title` 换成「已失效视频」，但 `pages[0].title`（第一P 标题）
 * 往往还保留着。稿件**只有一个分P**时，该分P标题即稿件标题，可直接还原。
 * 多个分P 时不采用——那时第一P 标题是子标题，还原出来的是错的。
 *
 * 这是**免费**路径：`pages` 本来就在收藏夹接口的返回里，不需要任何额外请求。
 * 策略来自社区脚本的实测经验；追加后缀以标明是推测而非官方标题。
 */
export const resolveGuessedTitle = (resource: FavoriteResource): string | null => {
  const pages = resource.pages;
  if (!Array.isArray(pages) || pages.length !== 1) return null;
  const partTitle = (pages[0]?.title ?? "").trim();
  if (!partTitle || partTitle === PLACEHOLDER_TITLE) return null;
  return `${partTitle}${TITLE_GUESS_SUFFIX}`;
};

/**
 * 用分P标题还原失效标题。仅当本地标题仍是占位内容时才动手。
 *
 * 与第三方恢复的区别在于**没有网络请求**，所以它在恢复流程里排在最前面，
 * 能本地解决的就不要去麻烦外部站点。
 */
export const applyGuessedTitle = (resource: FavoriteResource, now: number): RecoveryOutcome => {
  if (!isPlaceholderTitle(resource.title)) return { resource, changed: false, fields: [] };
  const guessed = resolveGuessedTitle(resource);
  if (!guessed) return { resource, changed: false, fields: [] };

  return {
    resource: { ...resource, title: guessed, recoveredAt: now, recoverySource: "bilibili_pages" },
    changed: true,
    fields: ["title"],
  };
};

/** 公开接口返回的 media 里我们关心的字段。与 `favPublicApi.PublicFavMedia` 结构一致 */
export interface PublicMediaLike {
  title?: string;
  cover?: string;
  page?: number;
  pages?: Array<{ title?: string }>;
}

/**
 * 用 B站 **非鉴权**公开接口返回的 media 补全记录。
 *
 * 鉴权接口不返回分P 数组，所以这是拿到 `pages` 的唯一途径，也正因如此它排在
 * biliplus 之后、jijidown 之前——前者批量便宜但常常没货，后者逐条昂贵。
 *
 * 三步：补 `pages` → 采用更优的标题/封面 → 若标题仍是占位就用分P标题就地还原。
 *
 * 注意：**只有 pages 变化时不算「已恢复」**。分P 信息本身不是内容，
 * 打上恢复标记会让界面谎报"已找回"，而标题封面其实还是占位。
 */
export const applyPublicMedia = (
  resource: FavoriteResource,
  media: PublicMediaLike | undefined,
  now: number,
): RecoveryOutcome => {
  if (!media) return { resource, changed: false, fields: [] };

  let next: FavoriteResource = { ...resource };
  const fields: string[] = [];

  if ((!next.pages || next.pages.length === 0) && Array.isArray(media.pages) && media.pages.length > 0) {
    next = { ...next, pages: media.pages, page: media.page ?? media.pages.length };
    fields.push("pages");
  }

  if (isBetterTitle(next.title, media.title)) {
    next = { ...next, title: (media.title ?? "").trim() };
    fields.push("title");
  }

  if (isBetterCover(next.cover, media.cover)) {
    next = { ...next, cover: (media.cover ?? "").trim() };
    fields.push("cover");
  }

  // 标题仍是占位但刚补到了分P → 就地还原（内部会打上 bilibili_pages 来源）
  if (isPlaceholderTitle(next.title)) {
    const guessed = applyGuessedTitle(next, now);
    if (guessed.changed) {
      next = guessed.resource;
      fields.push("title_by_pages");
    }
  }

  if (fields.length === 0) return { resource, changed: false, fields: [] };

  const improvedContent = fields.some(
    (field) => field === "title" || field === "cover" || field === "title_by_pages",
  );
  if (improvedContent && !next.recoveredAt) {
    next = { ...next, recoveredAt: now, recoverySource: "bilibili_public" };
  }

  return { resource: next, changed: true, fields };
};

/**
 * 本地元数据是否应被保护、不被同步回来的占位内容覆盖。
 *
 * 两种情况都要保护：
 * 1. 本地仍是有效元数据（失效前同步过，`saveFavResources` 已保留）
 * 2. 本地是第三方恢复来的数据（`recoveredAt` 有值）——**这条是恢复功能的关键**，
 *    否则每次同步都会把辛苦查回来的标题换回"已失效视频"
 */
export const shouldPreserveLocalMetadata = (
  local: FavoriteResource | undefined,
): boolean => {
  if (!local) return false;
  if (local.recoveredAt) return true;
  return !isInvalidatedResource(local);
};

export interface RecoveryStats {
  /** 收藏夹条目总数 */
  total: number;
  /** 失效条目数（`attr !== 0` 或标题是占位文案） */
  invalid: number;
  /** 失效、但本地已有真实元数据（失效保护保住或第三方恢复来的）——无需查询 */
  intact: number;
  /** 失效、且标题或封面仍是占位内容——**这才是真正需要恢复的** */
  pending: number;
}

export const buildRecoveryStats = (resources: FavoriteResource[]): RecoveryStats => {
  let invalid = 0;
  let intact = 0;
  let pending = 0;
  for (const resource of resources) {
    if (!isInvalidatedResource(resource)) continue;
    invalid += 1;
    if (needsRecovery(resource)) pending += 1;
    else intact += 1;
  }
  return { total: resources.length, invalid, intact, pending };
};

/** 单次恢复的条数上限。按每 20 条一批、批间 800ms 估算，300 条约 15 秒 */
export const DEFAULT_RECOVERY_LIMIT = 300;

export interface FavRecoveryOutcome {
  /** 扫描的收藏条目总数 */
  scanned: number;
  /** 其中失效的条数 */
  invalid: number;
  /** 本次开始前待恢复的条数（已排除本地已有真实数据的） */
  pending: number;
  /** 本次实际发起第三方查询的条数 */
  attempted: number;
  /** 成功写回本地并触发恢复流程的条数 */
  recovered: number;
  /** 其中靠分P标题在**本地**还原的条数（零请求） */
  recoveredLocal: number;
  /** 失败的批次数。连续失败通常意味着被风控 */
  failedBatches: number;
  /** 各来源的命中数 */
  sources: Partial<Record<FavRecoverySource, number>>;
  /** 跑完之后仍待恢复的条数 */
  remaining: number;
}
