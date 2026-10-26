import type {
  FavoriteResource,
  FollowingItem,
  InteractionItem,
  SubscribedCollectionResource,  VanishArchiveItem,
  VanishArchiveKind,
  VanishArchiveReason,
  VanishArchiveSource,
  VanishedFavResource,
} from "./types";
import { INVALIDATED_TITLE_RE, resolveInvalidatedKind } from "./favVanishedDiff";
import { isPlaceholderImage } from "./imageUrl";

/**
 * 统一消失档案的**纯逻辑**（可单测，不碰 IndexedDB）。
 *
 * 背景：原先只有收藏做了"先留档再移除"（`vanishedFavResources`）。
 * 订阅合集是整夹替换（`replaceSubscribedCollectionResources`），
 * 消失的视频连 BV 号都不剩；关注与互动虽然从不删数据，但也没有统一的查看入口。
 * 这里定义四类内容共用的档案条目构造与检索。
 *
 * 两条硬约束：
 * 1. **失败也留档**。探测失败只说明"不知道原因"，不等于"没消失"。
 * 2. **绝不因为探测失败就丢掉条目**——档案的价值是把当时的样子留下来。
 */

export const VANISH_KIND_LABEL: Record<VanishArchiveKind, string> = {
  favorite: "收藏",
  collection: "合集",
  following: "关注",
  like: "点赞",
  coin: "投币",
};

export const VANISH_SOURCE_LABEL: Record<VanishArchiveSource, string> = {
  favorites: "收藏夹",
  collections: "订阅合集",
  following: "关注列表",
  interactions: "互动记录",
};

export const VANISH_ARCHIVE_REASON_LABEL: Record<VanishArchiveReason, string> = {
  unfavorited: "已取消收藏",
  content_deleted: "内容已被删除",
  content_hidden: "内容已不可见",
  unknown: "原因不明",
  collection_removed: "已移出合集",
  removed_by_uploader: "UP 主删除/退回",
  removed_by_other: "其他原因删除",
  renamed: "改过曾用名",
  account_gone: "账号注销",
};

/**
 * 历史数据归一化：早期版本把已注销账号的 reason 写成 `unknown`，
 * 读取时统一改成 `account_gone`，避免被算进「原因不明」。
 * 只影响展示，不重写数据库。
 */
export const normalizeArchiveReasons = (items: VanishArchiveItem[]): VanishArchiveItem[] =>
  items.map((item) =>
    item.kind === "following" && item.reason === "unknown"
      ? { ...item, reason: "account_gone" }
      : item,
  );

/** 档案条目的稳定主键 */
export const vanishArchiveId = (kind: VanishArchiveKind, sourceId: string): string =>
  `${kind}:${sourceId}`;

export interface BuildArchiveInput {
  kind: VanishArchiveKind;
  source: VanishArchiveSource;
  sourceId: string;
  title: string;
  cover: string;
  coverAssetId?: string;
  bvid?: string;
  aid?: number;
  authorName?: string;
  authorMid?: number;
  duration?: number;
  reason: VanishArchiveReason;
  now: number;
  probeError?: string;
  /** 消失那一刻的完整原始记录 */
  item: unknown;
}

/**
 * 组装档案条目。
 *
 * `vanishedAt` 只写第一次：同一条内容被反复判定消失（每轮同步都会重新判定一次）时，
 * 应该保留**最早**那次的时间，否则"它是什么时候消失的"会一路往后漂。
 */
export const buildVanishArchiveItem = (
  input: BuildArchiveInput,
  previous?: VanishArchiveItem,
): VanishArchiveItem => {
  const record: VanishArchiveItem = {
    id: vanishArchiveId(input.kind, input.sourceId),
    kind: input.kind,
    source: input.source,
    sourceId: input.sourceId,
    title: input.title,
    cover: input.cover,
    reason: input.reason,
    vanishedAt: previous?.vanishedAt ?? input.now,
    probeAttemptedAt: input.now,
    item: input.item,
  };

  if (input.coverAssetId ?? previous?.coverAssetId) {
    record.coverAssetId = input.coverAssetId ?? previous?.coverAssetId;
  }
  if (input.bvid) record.bvid = input.bvid;
  if (Number.isSafeInteger(input.aid) && (input.aid ?? 0) > 0) record.aid = input.aid;
  if (input.authorName) record.authorName = input.authorName;
  if (Number.isSafeInteger(input.authorMid) && (input.authorMid ?? 0) > 0) {
    record.authorMid = input.authorMid;
  }
  // 时长：优先本次传入的值，取不到就沿用上一次的——它基本不变，
  // 一旦拿到过就不该因为某次同步没带上而丢掉
  const duration = input.duration ?? previous?.duration;
  if (Number.isFinite(duration) && (duration ?? 0) > 0) record.duration = duration;
  if (input.probeError) record.probeError = input.probeError;
  return record;
};

/** 从收藏资源构造档案条目（供旧 `vanishedFavResources` 惰性迁入时使用） */
export const buildFavoriteArchiveItem = (
  resource: FavoriteResource,
  reason: VanishArchiveReason,
  now: number,
  probeError?: string,
): VanishArchiveItem =>
  buildVanishArchiveItem({
    kind: "favorite",
    source: "favorites",
    sourceId: `${resource.folder_id}:${resource.id}`,
    title: resource.title,
    cover: resource.cover,
    coverAssetId: resource.coverAssetId,
    bvid: resource.bvid || resource.bv_id,
    aid: resource.id,
    authorName: resource.upper?.name,
    authorMid: resource.upper?.mid,
    duration: resource.duration,
    reason,
    now,
    probeError,
    item: resource,
  });

/** 从订阅合集资源构造档案条目 */
export const buildCollectionArchiveItem = (
  resource: SubscribedCollectionResource,
  reason: VanishArchiveReason,
  now: number,
  probeError?: string,
): VanishArchiveItem =>
  buildVanishArchiveItem({
    kind: "collection",
    source: "collections",
    sourceId: resource.id,
    title: resource.title,
    cover: resource.cover,
    coverAssetId: resource.coverAssetId,
    bvid: resource.bvid,
    aid: resource.aid,
    authorName: resource.author_name,
    authorMid: resource.author_mid,
    duration: resource.duration,
    reason,
    now,
    probeError,
    item: resource,
  });

/**
 * 从关注记录构造档案条目。
 *
 * 关注没有"稿件"概念，`sourceId` 用 mid（唯一且永不变），标题取昵称。
 * 昵称可能是空的（注销且从未知道真名），交给界面用 `resolveDisplayName` 兜底。
 */
export const buildFollowingArchiveItem = (
  item: FollowingItem,
  reason: VanishArchiveReason,
  now: number,
): VanishArchiveItem =>
  buildVanishArchiveItem({
    kind: "following",
    source: "following",
    sourceId: String(item.mid),
    title: item.name,
    cover: item.face,
    coverAssetId: item.avatarAssetId,
    authorName: item.name,
    authorMid: item.mid,
    reason,
    now,
    item,
  });

/**
 * 从互动记录构造档案条目。
 *
 * **只对"稿件本身查不到"的两种情况归档**（`content_deleted` / `content_hidden`）。
 * `retained`（只是掉出 20 条窗口、赞还在）和 `unlisted`（还没核查出来）都不算消失，
 * 它们留在 `interactions` store 里即可——那本来就不删数据。
 */
export const buildInteractionArchiveItem = (
  item: InteractionItem,
  reason: VanishArchiveReason,
  now: number,
): VanishArchiveItem =>
  buildVanishArchiveItem({
    kind: item.type,
    source: "interactions",
    sourceId: item.id,
    title: item.firstTitle || item.title,
    cover: item.cover,
    coverAssetId: item.coverAssetId,
    bvid: item.bvid,
    aid: item.aid,
    authorName: item.authorName,
    authorMid: item.authorMid,
    duration: item.duration,
    reason,
    now,
    probeError: item.probeError,
    item,
  });

/** 互动记录是否该进档案：只有稿件本身查不到才算 */
export const shouldArchiveInteraction = (item: InteractionItem): boolean =>
  item.state === "content_deleted" || item.state === "content_hidden";

/** 把互动状态映射为档案原因；非"查不到"的状态返回 null */
export const resolveInteractionArchiveReason = (
  item: InteractionItem,
): VanishArchiveReason | null => {
  if (item.state === "content_deleted") return "content_deleted";
  if (item.state === "content_hidden") return "content_hidden";
  return null;
};

/** 把旧收藏档案条目转成统一格式 */
export const fromVanishedFavResource = (item: VanishedFavResource): VanishArchiveItem => {
  const archiveItem = buildFavoriteArchiveItem(
    item,
    item.vanishReason,
    item.vanishedAt,
    item.probeError,
  );
  // 旧档案用 lastKnownTitle / lastKnownCover 保存"消失前的样子"，
  // 那才是档案的价值所在，优先于可能已被占位内容覆盖的 title / cover
  return {
    ...archiveItem,
    title: item.lastKnownTitle ?? archiveItem.title,
    cover: item.lastKnownCover ?? archiveItem.cover,
    coverAssetId: item.coverAssetId ?? archiveItem.coverAssetId,
  };
};

/**
 * 合并"新档案 + 旧收藏档案"。
 *
 * 旧 store 保持原样可读写（旧备份与旧版本兼容），页面读的是两者合并的结果。
 * 这条路刻意**不做一次性迁移**：迁移要写库，而写库失败会留下"迁了一半"的状态；
 * 读时合并是幂等的，代价只是每次多读一个 store。
 * 同 id 时以新档案为准（它的字段更全，且带 probeError 等新信息）。
 */
export const mergeArchiveWithLegacy = (
  archive: VanishArchiveItem[],
  legacy: VanishedFavResource[],
): VanishArchiveItem[] => {
  const converted = legacy.map(fromVanishedFavResource);
  return mergeVanishArchive(converted, archive);
};

/**
 * 这条关注记录是否**值得进档案**。
 *
 * 判据：有没有留下"有效信息"。只有 UID 的已注销账号**不进档案**——
 *
 * - `name` 为空只说明 B 站返回了占位文案，插件故意不把占位当名字存（`name` 保持空），
 *   于是界面只能显示 `UID xxxxx`；
 * - 这类账号在关注列表里本来就能查到（状态「已注销」），档案再收一份**不增加任何信息**，
 *   只是把档案页刷成一片没有头像的白卡；
 * - 档案的价值是"消失前它长什么样"。连名字都没观测到，就没有"什么样"可留。
 *
 * 一旦拿到过真名 / 头像 / 签名 / 改名链路中的任何一项，就值得留——那才是不可再得的信息。
 */
export const isWorthArchiving = (item: FollowingItem): boolean =>
  Boolean(
    (item.name ?? "").trim() ||
      (item.sign ?? "").trim() ||
      item.avatarAssetId ||
      (item.nameHistory?.length ?? 0) > 1 ||
      (item.thirdPartyNames?.length ?? 0) > 0,
  );

/**
 * 从**当前的源记录**里汇出"已经查不到"的内容。
 *
 * 为什么需要这一步：档案页原先只读 `vanishArchive` 与旧的 `vanishedFavResources` 两个 store，
 * 结果用户本地明明有已失效的收藏、已注销的关注、稿件已删的互动，页面却显示"共 0 条"——
 * 因为这些内容从没被写进档案，它们只是各自记录上的一个状态字段
 * （收藏的 `attr`、关注的 `status`、互动的 `state`）。
 *
 * 所以页面每次打开都做一次汇出：**读时派生**，不依赖"等下一次同步把它写进档案"。
 * 与已持久化的条目合并时按 id 去重，`mergeVanishArchive` 保留更早的消失时间。
 *
 * 时间戳取"首次判定消失"的时间（`*DetectedAt`），取不到才退回"最后观测时间"——
 * 派生条目没有精确的消失时刻，硬塞一个当前时间会让倒序排列看起来像"今天刚消失"。
 */
export const collectLiveVanishArchive = (input: {
  favorites: FavoriteResource[];
  collections: SubscribedCollectionResource[];
  following: FollowingItem[];
  interactions: InteractionItem[];
  /** 判断收藏是否已失效（`attr` 为主、标题文案兜底），由调用方注入避免重复依赖 */
  isInvalidated: (resource: FavoriteResource) => boolean;
}): VanishArchiveItem[] => {
  const items: VanishArchiveItem[] = [];

  // 收藏：`attr` 标记失效、或标题已是「已失效视频」这类占位文案。
  //
  // 原因判定优先用同步时写下的 `invalidatedKind`，它比 `attr` 更完整
  // （兼容历史数据、且 `other` 也带信息），拿不到才退回 `attr`。
  for (const resource of input.favorites) {
    if (!input.isInvalidated(resource)) continue;
    const kind = resource.invalidatedKind ?? resolveInvalidatedKind(resource.attr);
    const reason: VanishArchiveReason =
      kind === "removed_by_uploader"
        ? "removed_by_uploader"
        : kind === "removed_by_other"
          ? "removed_by_other"
          : "unknown";
    const archiveItem = buildFavoriteArchiveItem(
      resource,
      reason,
      // 优先用"首次观测到失效"的时间；取不到才退回收藏时间
      // （收藏时间只是"你什么时候收的"，不是"它什么时候没的"）
      resource.invalidatedAt ?? (resource.fav_time > 0 ? resource.fav_time * 1000 : 0),
    );
    // 只有标题占位文案命中、`attr` 与 `invalidatedKind` 都说不出所以然的，
    // 标成"未经证实"——这类记录仍保留，但界面要如实说明我们没有证据
    if (kind === null || kind === "other") archiveItem.invalidationUnproven = true;
    items.push({ ...archiveItem, liveDerived: true });
  }

  // 订阅合集：资源本身不带失效标记，能进档案的都在同步时留档，这里无需派生

  // 关注：`gone` 是终态（账号注销）。取关**不算消失**——人还在 B 站，只是你不再关注。
  // 另外只收"留下过有效信息"的账号，见 isWorthArchiving 的说明。
  for (const item of input.following) {
    if (item.status === "gone") {
      if (!isWorthArchiving(item)) continue;
      items.push({
        ...buildFollowingArchiveItem(item, "account_gone", item.goneDetectedAt ?? item.lastSeenAt),
        liveDerived: true,
      });
      continue;
    }

    // 仍在关注、但改过名：曾用名是不可再得的信息（B 站不提供历史昵称查询），
    // 所以要留档。用独立原因 `renamed` 与"内容消失"区分开，界面不能混为一谈。
    const history = item.nameHistory ?? [];
    if (history.length > 1) {
      const lastRenameAt = history[history.length - 1]?.seenAt ?? item.lastSeenAt;
      items.push({ ...buildFollowingArchiveItem(item, "renamed", lastRenameAt), liveDerived: true });
    }
  }

  // 互动：只有"稿件本身查不到"才汇入。掉出 20 条窗口（`retained`）
  // 与尚未核查（`unlisted`）的内容都还在，不该进档案
  for (const item of input.interactions) {
    const reason = resolveInteractionArchiveReason(item);
    if (!reason) continue;
    items.push({
      ...buildInteractionArchiveItem(item, reason, item.endedDetectedAt ?? item.lastSeenAt),
      liveDerived: true,
    });
  }

  return items;
};

// ---------------------------------------------------------------------------
// 检索与统计
// ---------------------------------------------------------------------------

export interface VanishArchiveFilter {
  keyword?: string;
  /** `all` 或不传表示不过滤 */
  kind?: VanishArchiveKind | "all";
  source?: VanishArchiveSource | "all";
  reason?: VanishArchiveReason | "all";
}

/**
 * 档案检索，按消失时间倒序。
 *
 * 检索范围包含 `bvid` 与 `authorName`：档案的典型用法是"我记得这个 BV 号/这个 UP，
 * 想确认它是不是真没了"。
 */
export const queryVanishArchive = (
  items: VanishArchiveItem[],
  filter: VanishArchiveFilter = {},
): VanishArchiveItem[] => {
  const keyword = (filter.keyword ?? "").trim().toLowerCase();
  const kind = filter.kind ?? "all";
  const source = filter.source ?? "all";
  const reason = filter.reason ?? "all";

  return items
    .filter((item) => {
      if (kind !== "all" && item.kind !== kind) return false;
      if (source !== "all" && item.source !== source) return false;
      if (reason !== "all" && item.reason !== reason) return false;
      if (!keyword) return true;
      const haystack = [
        item.title ?? "",
        item.authorName ?? "",
        item.bvid ?? "",
        item.sourceId,
        String(item.aid ?? ""),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(keyword);
    })
    .sort((a, b) => b.vanishedAt - a.vanishedAt);
};

export interface VanishArchiveStats {
  total: number;
  byKind: Record<VanishArchiveKind, number>;
  byReason: Record<VanishArchiveReason, number>;
  /** 按来源计数。页面用它渲染筛选器上的数字，避免在组件里重复 filter */
  bySource: Record<VanishArchiveSource, number>;
}

const emptyKindCounts = (): Record<VanishArchiveKind, number> => ({
  favorite: 0,
  collection: 0,
  following: 0,
  like: 0,
  coin: 0,
});

const emptySourceCounts = (): Record<VanishArchiveSource, number> => ({
  favorites: 0,
  collections: 0,
  following: 0,
  interactions: 0,
});

const emptyReasonCounts = (): Record<VanishArchiveReason, number> => ({
  unfavorited: 0,
  content_deleted: 0,
  content_hidden: 0,
  unknown: 0,
  collection_removed: 0,
  removed_by_uploader: 0,
  removed_by_other: 0,
  renamed: 0,
  account_gone: 0,
});

export const buildVanishArchiveStats = (items: VanishArchiveItem[]): VanishArchiveStats => {
  const byKind = emptyKindCounts();
  const byReason = emptyReasonCounts();
  const bySource = emptySourceCounts();
  for (const item of items) {
    if (byKind[item.kind] === undefined) byKind.favorite += 1;
    else byKind[item.kind] += 1;
    if (byReason[item.reason] === undefined) byReason.unknown += 1;
    else byReason[item.reason] += 1;
    if (bySource[item.source] === undefined) bySource.favorites += 1;
    else bySource[item.source] += 1;
  }
  return { total: items.length, byKind, byReason, bySource };
};

/**
 * 合并两批档案条目，同 id 保留 `vanishedAt` 更早的那条。
 *
 * 用途：旧 `vanishedFavResources` 惰性迁入时与新档案合并，
 * 以及 WebDAV / 备份还原时把远端档案并进本地——两端都记过同一条时，
 * 应该保留更早的消失时间。
 */
/** 快照里的时长。合并时用它判断"哪边的快照更有内容" */
const snapshotDurationOf = (snapshot: unknown): number => {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return 0;
  const value = Number((snapshot as Record<string, unknown>).duration);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

/**
 * 合并两批档案条目，同 id 保留 `vanishedAt` 更早的那条。
 *
 * 冲突时逐字段取更可信的一方，而不是整条二选一：
 * - `vanishedAt` 取更早的：它回答"什么时候没的"，后面的观测只是重复判定
 * - `duration` / `coverAssetId` 取**有值**的一边：时长基本不变，
 *   一旦拿到过就不该因为另一边是 0（B 站失效后返回 0）而丢掉
 * - `item`（快照）取**内容更丰富**的一边：持久化条目可能是早期写入的残缺快照，
 *   读时派生的那份才是完整的
 * - `invalidationUnproven` 有一边为真就为真：警示信息不能被较新的观测抹掉
 */
/**
 * 快照质量评分：**标题/封面是否真实内容**远比时长重要。
 *
 * 之前按 duration 选"更丰富"的一边，结果"有时长但标题是占位"的旧快照会盖掉
 * "标题真实但时长为 0"的新记录——档案里显示「已失效视频」，收藏夹里却是正常标题。
 */
const snapshotQuality = (snapshot: unknown): number => {
  if (!snapshot || typeof snapshot !== "object") return 0;
  const record = snapshot as Partial<FavoriteResource>;
  let score = 0;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  if (title && !INVALIDATED_TITLE_RE.test(title)) score += 4;
  if (typeof record.cover === "string" && record.cover.trim() && !isPlaceholderImage(record.cover)) {
    score += 2;
  }
  if (typeof record.duration === "number" && record.duration > 0) score += 1;
  return score;
};

const isRealTitle = (title: string | undefined | null): boolean =>
  Boolean(title && title.trim() && !INVALIDATED_TITLE_RE.test(title));

const isRealCover = (cover: string | undefined | null): boolean =>
  Boolean(cover && cover.trim() && !isPlaceholderImage(cover));

export const mergeVanishArchive = (
  base: VanishArchiveItem[],
  incoming: VanishArchiveItem[],
): VanishArchiveItem[] => {
  const merged = new Map<string, VanishArchiveItem>();
  for (const item of [...base, ...incoming]) {
    const existing = merged.get(item.id);
    if (!existing) {
      merged.set(item.id, item);
      continue;
    }
    const earlier = item.vanishedAt < existing.vanishedAt ? item : existing;
    const later = item.vanishedAt < existing.vanishedAt ? existing : item;
    // **按字段分别择优**：标题和封面可能分别存在于两边。
    // 之前整份挑"更丰富的一边"，会出现"选中真实标题那一边 → 封面被换成空"，
    // 表现就是有些封面丢失（老记录尤其明显，因为另一边才有封面）。
    const titleSource = isRealTitle(later.title)
      ? later
      : isRealTitle(earlier.title)
        ? earlier
        : later;
    const coverSource = isRealCover(later.cover)
      ? later
      : isRealCover(earlier.cover)
        ? earlier
        : titleSource;
    const richerSnapshot = snapshotQuality(later.item) >= snapshotQuality(earlier.item)
      ? later.item
      : earlier.item;
    merged.set(item.id, {
      ...later,
      title: titleSource.title,
      cover: coverSource.cover,
      bvid: titleSource.bvid ?? later.bvid,
      aid: titleSource.aid ?? later.aid,
      authorName: titleSource.authorName ?? later.authorName,
      authorMid: titleSource.authorMid ?? later.authorMid,
      vanishedAt: earlier.vanishedAt,
      item: richerSnapshot,
      duration:
        earlier.duration ??
        later.duration ??
        snapshotDurationOf(richerSnapshot) ??
        undefined,
      coverAssetId: earlier.coverAssetId ?? later.coverAssetId,
      invalidationUnproven: earlier.invalidationUnproven || later.invalidationUnproven,
      resolvedLocally: earlier.resolvedLocally || later.resolvedLocally,
      liveDerived: Boolean(earlier.liveDerived && later.liveDerived),
    });
  }
  return [...merged.values()];
};

/**
 * 标记"本地仍存在"的档案条目：同 id 的源记录还在本地库里，说明它并没有真的消失，
 * 属于误归档。页面据此把条目标签成「已恢复」并默认折叠，但不删除档案。
 */
export const markLocallyResolved = (
  items: VanishArchiveItem[],
  input: {
    favorites: FavoriteResource[];
    collections: SubscribedCollectionResource[];
    following: FollowingItem[];
    interactions: InteractionItem[];
  },
): VanishArchiveItem[] => {
  const favoriteKeys = new Set(input.favorites.map((item) => `${item.folder_id}:${item.id}`));
  const collectionIds = new Set(input.collections.map((item) => String(item.id)));
  const followingMids = new Set(input.following.map((item) => String(item.mid)));
  const interactionIds = new Set(input.interactions.map((item) => item.id));

  return items.map((item) => {
    // 读时派生的条目本来就和源记录同时存在，不能据此判成"误归档"
    if (item.liveDerived) return item;
    let resolved = false;
    if (item.kind === "favorite") resolved = favoriteKeys.has(item.sourceId);
    else if (item.kind === "collection") resolved = collectionIds.has(item.sourceId);
    else if (item.kind === "following") resolved = followingMids.has(item.sourceId);
    else resolved = interactionIds.has(item.sourceId);
    return resolved ? { ...item, resolvedLocally: true } : item;
  });
};

/**
 * 用本地收藏记录补全档案条目的展示字段（**只用本地数据，不请求 B 站**）。
 *
 * 误归档的条目可能同时还在 `favResources` 里且带着真实标题/封面，但档案里的
 * 持久快照是占位文案。这里在读取时把真实字段补到顶层展示字段上，
 * 不写库、不删除档案。
 */
export const enrichArchiveFromLive = (
  items: VanishArchiveItem[],
  favorites: FavoriteResource[],
): VanishArchiveItem[] => {
  const byKey = new Map(favorites.map((item) => [`${item.folder_id}:${item.id}`, item]));
  return items.map((item) => {
    if (item.kind !== "favorite") return item;
    const live = byKey.get(item.sourceId);
    if (!live) return item;
    // 同样按字段补：本地记录可能只有封面、档案快照只有标题（或反过来）。
    const title = isRealTitle(live.title) ? live.title : item.title;
    const cover = isRealCover(live.cover) ? live.cover : item.cover;
    const snapshot = snapshotQuality(live) > snapshotQuality(item.item) ? live : item.item;
    if (title === item.title && cover === item.cover && snapshot === item.item) return item;
    return {
      ...item,
      title,
      cover,
      bvid: live.bvid || live.bv_id || item.bvid,
      aid: live.id ?? item.aid,
      authorName: live.upper?.name ?? item.authorName,
      authorMid: live.upper?.mid ?? item.authorMid,
      item: snapshot,
    };
  });
};
