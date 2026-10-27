import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownUp,
  BadgeCheck,
  Check,
  CheckSquare,
  ChevronDown,
  ExternalLink,
  Inbox,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  Trash2,
  X,
} from "lucide-react";
import toast from "react-hot-toast";
import { createAssetObjectUrl } from "../utils/assetArchive";
import {
  deleteVanishArchiveItems,
  deleteVanishedFavResources,
  getAllFavFolders,
  getAllFavResources,
  getAllFollowing,
  getAllInteractions,
  getAllVanishArchive,
  getAllVanishedFavResources,
  patchFollowingItems,
  restoreVanishArchiveItems,
} from "../utils/db";
import { isInvalidatedResource } from "../utils/favVanishedDiff";
import { formatInteractionDuration } from "../utils/interactionQuery";
import { NameHistoryPopover } from "../components/NameHistoryPopover";
import { PLACEHOLDER_COVER_PATH } from "../utils/imageUrl";
import {
  FOLLOWING_STATUS_LABEL,
  buildLocalNameTimeline,
  resolveDisplayNameInfo,
} from "../utils/followingQuery";
import {
  VANISH_ARCHIVE_REASON_LABEL,
  VANISH_KIND_LABEL,
  VANISH_SOURCE_LABEL,
  buildVanishArchiveStats,
  collectLiveVanishArchive,
  enrichArchiveFromLive,
  mergeArchiveWithLegacy,
  mergeVanishArchive,
  normalizeArchiveReasons,
  queryVanishArchive,
  type VanishArchiveFilter,
} from "../utils/vanishArchive";
import type {
  FavoriteFolder,
  FollowingItem,
  VanishArchiveItem,
  VanishArchiveReason,
  VanishArchiveSource,
} from "../utils/types";

const SOURCES: VanishArchiveSource[] = ["favorites", "collections", "following", "interactions"];

/** 原因筛选项顺序：先"内容真的没了"，再"只是不再属于你"，最后"人还在但改过名" */
const REASONS: VanishArchiveReason[] = [
  "removed_by_uploader",
  "removed_by_other",
  "content_deleted",
  "content_hidden",
  "collection_removed",
  "unfavorited",
  "account_gone",
  "renamed",
  "unknown",
];

/**
 * 原因角标配色。
 *
 * 每个原因一个语义色，而不是"内容类一个灰、其余一个蓝"——后者会让
 * 「UP 主删除」和「其他原因删除」在页面上完全分不出来，而这两件事性质不同。
 * 冷色＝内容消失，暖色＝归属变化或无从判定。
 */
const REASON_BADGE_CLASS: Record<VanishArchiveReason, string> = {
  removed_by_uploader: "bg-rose-600/90 text-white",
  removed_by_other: "bg-orange-600/90 text-white",
  content_deleted: "bg-gray-800/90 text-white",
  content_hidden: "bg-slate-600/90 text-white",
  collection_removed: "bg-sky-600/90 text-white",
  unfavorited: "bg-teal-600/90 text-white",
  unknown: "bg-amber-500/90 text-white",
  // 改过曾用名 ≠ 消失。用中性灰蓝，避免和"内容没了"的暖色混淆
  renamed: "bg-indigo-500/90 text-white",
  // 账号注销也是明确状态，用中性灰，与「原因不明」的琥珀色区分
  account_gone: "bg-gray-500/90 text-white",
};

/**
 * 内容**可能仍然可访问**的原因。
 *
 * 决定标题要不要给链接：档案里大部分条目已经查不到了，点开只会看到一个错误页，
 * 那种链接是纯噪音。只有这几类有理由仍然可访问——「已移出合集」探测证明稿件还在、
 * 「已取消收藏」是你自己取消的、以及标题占位但 B 站没给删除标记的。
 */
const POSSIBLY_REACHABLE: ReadonlySet<VanishArchiveReason> = new Set([
  "collection_removed",
  "unfavorited",
]);

const formatDateTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
};

const formatDate = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
};

/**
 * 档案卡片上显示的“内容自身时间”。
 *
 * 卡片原来显示 `vanishedAt`（首次判定消失时间），但同一批归档的条目会全部相同，
 * 看起来就是“日期都一样、顺序乱了”。这里改用快照里的 `pubtime`（发布时间），
 * 退而求其次用 `fav_time`；两者都没有才显示「时间未知」。
 * 归档时间仍保留在 tooltip / 详情里。
 */
const getArchiveDisplayTime = (
  item: VanishArchiveItem,
): { at: number; label: "发布时间" | "收藏时间" } | null => {
  const snapshot =
    item.item && typeof item.item === "object" && !Array.isArray(item.item)
      ? (item.item as Record<string, unknown>)
      : null;
  if (!snapshot) return null;

  const pubtime = Number(snapshot.pubtime ?? snapshot.pubdate);
  if (Number.isFinite(pubtime) && pubtime > 0) {
    return { at: pubtime * 1000, label: "发布时间" };
  }
  const favTime = Number(snapshot.fav_time);
  if (Number.isFinite(favTime) && favTime > 0) {
    return { at: favTime * 1000, label: "收藏时间" };
  }
  return null;
};

/**
 * 快照字段的中文名。
 *
 * 详情默认只展示这张表里认识的字段——直接把整个对象 `JSON.stringify` 摊给用户，
 * 结果是一屏 `"ogv": null`、`"ugc": {...}`、`media_list_link: "bilibili://..."`，
 * 用户看完也不知道这条档案到底存了什么。原始 JSON 仍然保留，但收进可展开区。
 */
const SNAPSHOT_FIELD_LABELS: Record<string, string> = {
  title: "标题",
  firstTitle: "首次记录的标题",
  bvid: "BV 号",
  bv_id: "BV 号",
  aid: "AV 号",
  id: "内容 ID",
  mid: "UID",
  uname: "昵称",
  name: "昵称",
  sign: "签名",
  author_name: "UP 主",
  authorName: "UP 主",
  author_mid: "UP 主 UID",
  authorMid: "UP 主 UID",
  duration: "时长",
  pubdate: "投稿时间",
  pubtime: "发布时间",
  fav_time: "收藏时间",
  interactedAt: "互动时间",
  firstSeenAt: "首次记录时间",
  lastSeenAt: "最近观测时间",
  lastSeenOnlineAt: "最后一次出现在列表",
  unlistedDetectedAt: "发现掉出列表",
  endedDetectedAt: "判定互动结束",
  collection_id: "合集 ID",
  folder_id: "收藏夹 ID",
  index: "在列表中的位置",
  collectionName: "合集名称",
  folderName: "收藏夹名称",
  attr: "失效标记",
  invalidatedKind: "失效类型",
  invalidatedAt: "首次观测到失效",
  recoverdAt: "恢复时间",
  recoveredAt: "恢复时间",
  recoverySource: "恢复来源",
  status: "关注状态",
  coins: "投币数",
  state: "互动状态",
  type: "互动类型",
  cover: "封面地址",
  coverAssetId: "封面归档 ID",
  face: "头像地址",
  avatarAssetId: "头像归档 ID",
  media_count: "收藏夹内数量",
};

/** 这些字段是内部实现细节，对用户没有意义，即使有值也不展示 */
const SNAPSHOT_FIELD_HIDDEN = new Set([
  "ogv",
  "ugc",
  "season",
  "media_list_link",
  "cnt_info",
  "upper",
  "is_invalid",
  "goto",
  "ctime",
  "mtime",
  "pubtime_show",
  "fav_state",
  "media_id",
  "link",
  "jump_link",
]);

/** 看起来像时间戳的字段：值是秒或毫秒级整数时按日期渲染 */
const TIME_FIELD_RE = /(_time|At|pubdate|pubtime)$/;

const isTimestampField = (key: string): boolean =>
  TIME_FIELD_RE.test(key) || key === "pubdate";

const formatSnapshotValue = (key: string, value: unknown): string => {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "number") {
    // 时长单独格式化：原始秒数对用户没有意义
    if (key === "duration") return formatInteractionDuration(value);
    if (isTimestampField(key) && value > 1_000_000_000) {
      // 秒级时间戳需要先乘 1000；毫秒级已经够大，直接格式化
      const ms = value < 1_000_000_000_000 ? value * 1000 : value;
      return formatDateTime(ms);
    }
    return String(value);
  }
  if (typeof value === "string") {
    if (isTimestampField(key) && /^\d{10,13}$/.test(value)) {
      const num = Number(value);
      const ms = num < 1_000_000_000_000 ? num * 1000 : num;
      return formatDateTime(ms);
    }
    return value;
  }
  if (Array.isArray(value)) return `${value.length} 项`;
  return "";
};

/**
 * 把快照整理成"认识且非空"的字段列表。
 *
 * 返回空数组说明快照为空或全是未知字段——调用方据此退回原始 JSON 展示。
 */
const buildSnapshotRows = (snapshot: unknown): Array<{ label: string; value: string }> => {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return [];
  const rows: Array<{ label: string; value: string }> = [];
  for (const [key, raw] of Object.entries(snapshot as Record<string, unknown>)) {
    const label = SNAPSHOT_FIELD_LABELS[key];
    if (!label || SNAPSHOT_FIELD_HIDDEN.has(key)) continue;
    const value = formatSnapshotValue(key, raw);
    if (!value) continue;
    // 同名字段可能以不同 key 出现（如 bvid / bv_id），保持首次出现的顺序即可
    rows.push({ label, value });
  }
  return rows;
};

const copyBvid = async (item: VanishArchiveItem): Promise<void> => {
  if (!item.bvid) {
    toast.error("这条档案没有 BV 号");
    return;
  }
  try {
    await navigator.clipboard.writeText(item.bvid);
    toast.success(`已复制 ${item.bvid}`);
  } catch (error) {
    console.error("复制 BV 号失败:", error);
    toast.error("复制失败，请检查剪贴板权限");
  }
};

/**
 * 档案配图。
 *
 * 视频类用 16:9 封面；关注类用**居中的圆形头像**——账号头像本身是方的，
 * 硬塞进 16:9 里会被裁掉大半张脸（用户反馈"头像显示不完整、不好看"）。
 */
const ArchiveCover = ({ item, avatar = false }: { item: VanishArchiveItem; avatar?: boolean }) => {
  const [assetUrl, setAssetUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let created: string | null = null;

    if (item.coverAssetId) {
      createAssetObjectUrl(item.coverAssetId)
        .then((url) => {
          if (!url) return;
          if (!active) {
            URL.revokeObjectURL(url);
            return;
          }
          created = url;
          setAssetUrl(url);
        })
        .catch(() => undefined);
    } else {
      setAssetUrl(null);
    }

    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [item.coverAssetId]);

  const remote = item.cover ? item.cover.replace(/^http:/, "https:") : "";
  const source = assetUrl ?? (remote || `https://i0.hdslb.com${PLACEHOLDER_COVER_PATH}`);
  const onError = (event: React.SyntheticEvent<HTMLImageElement>) => {
    const image = event.currentTarget;
    const fallback = `https://i0.hdslb.com${PLACEHOLDER_COVER_PATH}`;
    if (!image.src.startsWith(fallback)) image.src = fallback;
  };

  if (avatar) {
    return (
      <div className="flex h-40 w-full shrink-0 items-center justify-center bg-gradient-to-b from-gray-50 to-gray-100 dark:from-neutral-800 dark:to-neutral-900">
        <img
          src={source}
          alt=""
          loading="lazy"
          className="h-24 w-24 rounded-full object-cover ring-2 ring-white dark:ring-neutral-700"
          onError={onError}
        />
      </div>
    );
  }

  return (
    <div className="aspect-video w-full shrink-0 overflow-hidden bg-gray-100 dark:bg-neutral-800">
      <img
        src={source}
        alt=""
        loading="lazy"
        className="h-full w-full object-cover"
        onError={onError}
      />
    </div>
  );
};

const VanishedCard = ({
  item,
  following,
  folderLabel,
  selected,
  managing,
  onToggleSelect,
  onOpen,
  onRestore,
}: {
  item: VanishArchiveItem;
  following?: FollowingItem;
  /** 「收藏夹：xxx」，仅收藏类条目有值；同一 BV 在多个夹子时用来区分重复条目 */
  folderLabel?: string | null;
  selected: boolean;
  managing: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onRestore: () => void;
}) => {
  // 关注类通常不给"原因"角标（注销本身就是状态，硬套一个「原因不明」是噪音）。
  // 但 `renamed` 例外：那个账号**还在**，不给角标用户会以为它注销了。
  const showReason = item.kind !== "following" || item.reason === "renamed";
  const isFollowing = item.kind === "following";
  const displayTitle = item.title?.trim() || (isFollowing ? `UID ${item.sourceId}` : "（标题未知）");
  // 卡片上的"改过 N 次名"同样要能从快照回退——源记录不在时它仍然是有效信息
  const nameSource = following ?? snapshotAsFollowing(item) ?? undefined;
  const formerNames = Math.max(0, (nameSource?.nameHistory?.length ?? 0) - 1);
  // 时长优先读顶层字段（v11 起提为一等字段），读不到才回退快照——
  // 历史档案的快照里 duration 可能已被 B 站返回的 0 覆盖
  const duration = isFollowing
    ? ""
    : formatInteractionDuration(item.duration ?? snapshotDuration(item));
  // 卡片右下角展示内容自身时间（发布时间 → 收藏时间），归档时间放进 tooltip
  const displayTime = isFollowing ? null : getArchiveDisplayTime(item);

  // 只有"可能仍然可访问"的条目才给链接：其余点开只会看到错误页
  const reachable =
    POSSIBLY_REACHABLE.has(item.reason) ||
    item.reason === "renamed" ||
    item.invalidationUnproven === true;
  const link = isFollowing
    ? reachable
      ? `https://space.bilibili.com/${item.sourceId}`
      : ""
    : reachable && item.bvid
      ? `https://www.bilibili.com/video/${item.bvid}`
      : "";

  const titleNode = (
    <h3
      className={`m-0 line-clamp-2 min-h-10 text-sm leading-[1.4] ${
        item.title?.trim() || !isFollowing
          ? "text-gray-900 dark:text-neutral-100"
          : "text-gray-400 dark:text-neutral-500"
      }`}
      title={displayTitle}
    >
      {link ? (
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="text-inherit no-underline hover:text-pink-600 dark:hover:text-pink-400"
          title="B 站上仍可访问，点击打开"
        >
          {displayTitle}
        </a>
      ) : (
        displayTitle
      )}
    </h3>
  );

  return (
    <article
      className={`group flex flex-col overflow-hidden rounded-xl border bg-white transition-shadow hover:shadow-md dark:bg-neutral-900 ${
        selected
          ? "border-pink-400 ring-2 ring-pink-400/40 dark:border-pink-500"
          : "border-gray-200 dark:border-neutral-800"
      }`}
    >
      <div className="relative">
        <button
          type="button"
          onClick={onOpen}
          className="block w-full text-left"
          title="查看存了什么 · 可恢复"
        >
          <ArchiveCover item={item} avatar={isFollowing} />
        </button>

        {showReason ? (
          <span
            className={`absolute left-2 top-2 rounded px-1.5 py-0.5 text-xs font-medium ${
              REASON_BADGE_CLASS[item.reason] ?? REASON_BADGE_CLASS.unknown
            }`}
            title={`判定时间：${formatDateTime(item.probeAttemptedAt ?? item.vanishedAt)}${
              item.probeError ? `\n探测失败：${item.probeError}` : ""
            }`}
          >
            {VANISH_ARCHIVE_REASON_LABEL[item.reason]}
          </span>
        ) : null}

        {/* 失效未经证实的标记：只用标题占位文案判断出来的条目。
            它们仍然保留（宁可多留），但必须让用户知道"这条没证据"。 */}
        {item.invalidationUnproven ? (
          <span
            className={`absolute left-2 rounded bg-amber-400/95 px-1.5 py-0.5 text-xs font-medium text-amber-950 ${
              showReason ? "top-8" : "top-2"
            }`}
            title="只凭标题里的「已失效/已被删除」等占位文案判定，B 站没有给出明确的删除标记。稿件可能仍然可访问。"
          >
            未证实
          </span>
        ) : null}

        {managing ? (
          <button
            type="button"
            onClick={onToggleSelect}
            aria-pressed={selected}
            className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-white/95 px-1.5 py-1 text-xs font-medium text-gray-700 shadow-sm backdrop-blur-sm dark:bg-neutral-900/95 dark:text-neutral-200"
          >
            {selected ? (
              <CheckSquare className="h-4 w-4 text-pink-600 dark:text-pink-400" />
            ) : (
              <Square className="h-4 w-4" />
            )}
            选中
          </button>
        ) : null}

        {/* 时长压在封面右下角，与「互动记录」的卡片位置一致。
            时长基本不会变，比标题更能说明"这是哪条内容"——标题会被占位文案覆盖。 */}
        {duration ? (
          <span className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-xs tabular-nums text-white">
            {duration}
          </span>
        ) : null}

        {/* 悬浮只留「详情」一个动作。
            「恢复」不在每张卡片上摆按钮——那是低频动作，它在详情弹窗和
            管理模式里都有入口，铺满整屏只会让列表变吵。 */}
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-end bg-gradient-to-t from-black/75 via-black/40 to-transparent p-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex items-center gap-1 rounded-md bg-white/95 px-2 py-1 text-xs font-medium text-gray-700 shadow-sm backdrop-blur-sm transition-colors hover:bg-white hover:text-pink-600 dark:bg-neutral-900/95 dark:text-neutral-200 dark:hover:bg-neutral-900 dark:hover:text-pink-400"
          >
            详情
          </button>
        </div>
      </div>

      <div className="flex flex-1 flex-col p-3">
        {isFollowing ? (
          <>
            {titleNode}
            <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
              <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-600 dark:bg-neutral-800 dark:text-neutral-300">
                {following ? FOLLOWING_STATUS_LABEL[following.status] : "已注销"}
              </span>
              <a
                href={`https://space.bilibili.com/${item.sourceId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="tabular-nums text-gray-400 no-underline hover:text-pink-600 dark:text-neutral-500 dark:hover:text-pink-400"
              >
                UID {item.sourceId}
              </a>
              {formerNames > 0 ? (
                <span className="text-gray-400 dark:text-neutral-500">改过 {formerNames} 次名</span>
              ) : null}
            </div>
          </>
        ) : (
          <>
            {titleNode}
            {item.authorName ? (
              item.authorMid ? (
                <a
                  href={`https://space.bilibili.com/${item.authorMid}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1.5 line-clamp-1 text-xs text-gray-500 no-underline transition-colors hover:text-pink-600 dark:text-neutral-400 dark:hover:text-pink-400"
                  title={`打开 ${item.authorName} 的 B 站空间`}
                >
                  {item.authorName}
                </a>
              ) : (
                <p className="mt-1.5 line-clamp-1 text-xs text-gray-500 dark:text-neutral-400">
                  {item.authorName}
                </p>
              )
            ) : null}
            {folderLabel ? (
              <p
                className="mt-1 line-clamp-1 text-[11px] text-gray-400 dark:text-neutral-500"
                title={folderLabel}
              >
                {folderLabel}
              </p>
            ) : null}
          </>
        )}

        <div className="mt-auto flex items-center justify-between gap-2 border-t border-gray-100 pt-2 text-xs text-gray-500 dark:border-neutral-800 dark:text-neutral-400">
          {isFollowing ? (
            <>
              {/* 关注类的左下角是「访问空间」而不是归档时间——
                  用户看到一张头像时想做的事就是去他的空间，而不是读时间 */}
              <a
                href={`https://space.bilibili.com/${item.sourceId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-pink-600 no-underline transition-colors hover:bg-pink-50 dark:text-pink-400 dark:hover:bg-pink-500/10"
                title={`打开 UID ${item.sourceId} 的空间`}
              >
                <ExternalLink className="h-3 w-3 shrink-0" />
                <span className="truncate">访问空间</span>
              </a>
              <span
                className="shrink-0 tabular-nums text-gray-400 dark:text-neutral-500"
                title={
                  item.reason === "renamed"
                    ? `最近一次改名：${formatDateTime(item.vanishedAt)}`
                    : `归档时间：${formatDateTime(item.vanishedAt)}`
                }
              >
                {item.reason === "renamed" ? "改名 " : ""}
                {formatDate(item.vanishedAt)}
              </span>
            </>
          ) : (
            <>
              {item.bvid ? (
                <button
                  type="button"
                  onClick={() => void copyBvid(item)}
                  className="min-w-0 truncate rounded px-1 py-0.5 text-left tabular-nums transition-colors hover:bg-gray-100 hover:text-pink-600 dark:hover:bg-neutral-800 dark:hover:text-pink-400"
                  title={`复制 BV 号 ${item.bvid}`}
                  aria-label={`复制 BV 号 ${item.bvid}`}
                >
                  {item.bvid}
                </button>
              ) : (
                <span className="truncate text-gray-400 dark:text-neutral-500">无 BV 号</span>
              )}
              <span
                className="shrink-0 tabular-nums text-gray-400 dark:text-neutral-500"
                title={
                  displayTime
                    ? `${displayTime.label}：${formatDateTime(displayTime.at)} ｜ 归档时间：${formatDateTime(item.vanishedAt)}`
                    : `内容时间未知 ｜ 归档时间：${formatDateTime(item.vanishedAt)}`
                }
              >
                {displayTime ? formatDate(displayTime.at) : "时间未知"}
              </span>
            </>
          )}
        </div>
      </div>
    </article>
  );
};

/** 关注类档案的改名链路。账号注销后这是唯一的追溯途径 */
const NameTimeline = ({ following }: { following: FollowingItem }) => {
  const timeline = useMemo(() => buildLocalNameTimeline(following), [following]);
  if (timeline.length === 0) return null;

  return (
    <section>
      <h3 className="text-sm font-semibold text-gray-800 dark:text-neutral-200">改名链路</h3>
      <p className="mt-1 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
        本地观测到的名字变化。账号注销后这是唯一的追溯途径。
      </p>
      <ol className="mt-2 space-y-1">
        {timeline.map((segment, index) => (
          <li
            key={`${segment.name}-${segment.from}-${index}`}
            className="flex items-baseline justify-between gap-3 rounded-md bg-gray-50 px-2.5 py-1.5 text-xs dark:bg-neutral-800/60"
          >
            <span
              className={
                segment.isCurrent
                  ? "min-w-0 truncate font-medium text-gray-800 dark:text-neutral-100"
                  : "min-w-0 truncate text-gray-600 dark:text-neutral-300"
              }
              title={segment.name}
            >
              {segment.name}
              {segment.isCurrent ? (
                <span className="ml-1.5 text-pink-600 dark:text-pink-400">当前</span>
              ) : null}
            </span>
            <span className="shrink-0 tabular-nums text-gray-400 dark:text-neutral-500">
              {formatDate(segment.from)}
              {segment.to ? ` – ${formatDate(segment.to)}` : " 起"}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
};

/**
 * 从快照里取出时长（秒）。
 *
 * 时长是**基本不变**的元数据，比标题更可靠（标题会被换成"已失效视频"占位文案），
 * 所以它值得直接显示在封面上——收藏夹与订阅合集的数据里一直有这个字段。
 */
const snapshotDuration = (item: VanishArchiveItem): number => {
  const snapshot = item.item;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return 0;
  const value = Number((snapshot as Record<string, unknown>).duration);
  return Number.isFinite(value) && value > 0 ? value : 0;
};

/**
 * 从档案快照里取回关注记录，用于渲染改名链路。
 *
 * 为什么需要它：`nameHistory` 一直存在快照的 `item` 里，但页面原先只从**实时
 * `following` store** 里查改名记录。一旦源记录不在（比如清空浏览器数据后从备份
 * 恢复档案、或导入了别人的档案），改名链路就整段消失——而这恰恰是"最需要它"的场景：
 * 账号注销后，快照是唯一的追溯来源。所以实时查不到时必须回退到快照。
 */
const snapshotAsFollowing = (item: VanishArchiveItem): FollowingItem | null => {
  const snapshot = item.item;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const record = snapshot as Record<string, unknown>;
  if (!Array.isArray(record.nameHistory)) return null;
  return snapshot as FollowingItem;
};

/**
 * 关注类档案的**行式**布局，与「关注列表」页保持一致的视觉语言。
 *
 * 为什么不用视频那种网格卡片：账号是"人"，不是"封面"。头像塞进 16:9 会被裁脸，
 * 而用户看一条关注记录时想知道的顺序是：这是谁 → 什么状态 → 简介 → 什么时候变的。
 * 横排一行正好承载这个顺序，也和关注列表页对得上。
 */
const VanishedFollowingRow = ({
  item,
  following,
  managing,
  selected,
  selectedFormerNameIndex,
  onSelectFormerName,
  onToggleSelect,
  onOpen,
}: {
  item: VanishArchiveItem;
  following?: FollowingItem;
  managing: boolean;
  selected: boolean;
  /** 卡片当前展示第几个曾用名（仅已注销账号可切换） */
  selectedFormerNameIndex?: number;
  onSelectFormerName?: (index: number) => void;
  onToggleSelect: () => void;
  onOpen: () => void;
}) => {
  const [assetUrl, setAssetUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let created: string | null = null;
    if (item.coverAssetId) {
      createAssetObjectUrl(item.coverAssetId)
        .then((url) => {
          if (!url) return;
          if (!active) {
            URL.revokeObjectURL(url);
            return;
          }
          created = url;
          setAssetUrl(url);
        })
        .catch(() => undefined);
    } else {
      setAssetUrl(null);
    }
    return () => {
      active = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [item.coverAssetId]);

  const source = following ?? snapshotAsFollowing(item) ?? undefined;
  const formerNames = Math.max(0, (source?.nameHistory?.length ?? 0) - 1);
  const status = source?.status ?? "gone";
  // 名字和关注列表页用同一套解析：当前名 → 第三方曾用名 → UID 兜底。
  // 之前直接用归档时的 `item.title`，注销账号常常是空的，才会显示「（从未记到昵称）」。
  const displayInfo = source ? resolveDisplayNameInfo(source) : null;
  const name = displayInfo?.name || item.title?.trim() || `UID ${item.sourceId}（名字未知）`;
  const sign = (source?.sign ?? "").trim();
  const avatar = assetUrl ?? (item.cover ? item.cover.replace(/^http:/, "https:") : "");
  // 曾用名**直接铺在卡片上**，不做浮层也不要点详情——
  // 用户点开一条关注记录就是想知道"它以前叫什么"，多一步点击就失去意义
  const formerNameList = Array.from(
    new Set(
      (source?.nameHistory ?? [])
        .map((record) => (record.name ?? "").trim())
        .filter((value) => value && value !== name),
    ),
  );
  // 账号注销后空间页是 404，所以名字只在账号还在时给链接
  const spaceUrl = status === "gone" ? "" : `https://space.bilibili.com/${item.sourceId}`;
  const reachable = Boolean(spaceUrl);

  const copyUid = async () => {
    try {
      await navigator.clipboard.writeText(item.sourceId);
      toast.success(`已复制 UID ${item.sourceId}`);
    } catch (error) {
      console.error("复制 UID 失败:", error);
      toast.error("复制失败，请检查剪贴板权限");
    }
  };

  return (
    <article
      className={`relative flex gap-3 rounded-xl border bg-white p-3 transition-shadow hover:shadow-md dark:bg-neutral-900 ${
        selected
          ? "border-pink-400 ring-2 ring-pink-400/40 dark:border-pink-500"
          : "border-gray-200 dark:border-neutral-800"
      }`}
    >
      {managing ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggleSelect();
          }}
          aria-pressed={selected}
          aria-label={selected ? "取消选中" : "选中这条档案"}
          className="absolute right-2 top-2 flex items-center gap-1 rounded-md bg-white/95 px-1.5 py-1 text-xs font-medium text-gray-700 shadow-sm backdrop-blur-sm dark:bg-neutral-900/95 dark:text-neutral-200"
        >
          {selected ? (
            <CheckSquare className="h-4 w-4 text-pink-600 dark:text-pink-400" />
          ) : (
            <Square className="h-4 w-4" />
          )}
          选中
        </button>
      ) : null}

      {/* 头像列：头像 + 「复制 UID」按钮。与关注列表页同一套排布理由——
          UID 位数不固定（8~16 位），放正文列不是挤走徽章就是换行 */}
      <div className="flex w-16 shrink-0 flex-col items-center gap-2">
        <img
          src={avatar || `https://i0.hdslb.com${PLACEHOLDER_COVER_PATH}`}
          alt=""
          loading="lazy"
          className="h-16 w-16 rounded-full object-cover"
          onError={(event) => {
            const image = event.currentTarget;
            const fallback = `https://i0.hdslb.com${PLACEHOLDER_COVER_PATH}`;
            if (!image.src.startsWith(fallback)) image.src = fallback;
          }}
        />
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            void copyUid();
          }}
          title={`复制 UID ${item.sourceId}`}
          className="inline-flex w-full items-center justify-center rounded-md border border-gray-200 px-1 py-0.5 text-[10px] leading-4 whitespace-nowrap text-gray-500 transition-colors hover:border-pink-300 hover:text-pink-500 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-pink-500/50 dark:hover:text-pink-400"
        >
          复制 UID
        </button>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {/* 名字就是入口：和「关注列表」页一致，点名字直接跳空间。
              注销账号的空间是 404，那种情况退回纯文本，不给死链。 */}
          {reachable ? (
            <a
              href={spaceUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 truncate text-sm font-medium text-gray-900 no-underline transition-colors hover:text-pink-600 dark:text-neutral-100 dark:hover:text-pink-400"
              title={`打开 ${name} 的空间`}
            >
              {name}
            </a>
          ) : (
            <span
              className="min-w-0 truncate text-sm font-medium text-gray-900 dark:text-neutral-100"
              title={name}
            >
              {name}
            </span>
          )}
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${
              item.reason === "renamed"
                ? "bg-indigo-50 text-indigo-600 dark:bg-indigo-500/10 dark:text-indigo-400"
                : "bg-gray-100 text-gray-600 dark:bg-neutral-800 dark:text-neutral-300"
            }`}
          >
            {item.reason === "renamed" ? "改过曾用名" : FOLLOWING_STATUS_LABEL[status]}
          </span>
          {/* 曾用名用**与关注列表页同一个组件**：只显示数量，点击展开浮层看名字。
              已注销账号可以直接在浮层里点选，把卡片名字切换成曾用名。 */}
          {source ? (
            <NameHistoryPopover
              item={source}
              selectedFormerNameIndex={
                selectedFormerNameIndex ??
                (displayInfo?.inferred ? displayInfo.candidateIndex : undefined)
              }
              onSelectFormerName={status === "gone" ? onSelectFormerName : undefined}
            />
          ) : null}
          {/* 认证图标：与关注列表页一致，用一个固定 14px 的图标表示，
              完整头衔放悬停提示（文字长度不可控，放徽章会把整行挤换行） */}
          {source?.officialVerifyDesc ? (
            <span className="shrink-0 leading-none" title={source.officialVerifyDesc}>
              <BadgeCheck className="h-3.5 w-3.5 text-blue-500" aria-hidden="true" />
            </span>
          ) : null}
        </div>

        <p
          className={`mt-1.5 line-clamp-2 text-xs leading-5 ${
            sign ? "text-gray-500 dark:text-neutral-400" : "text-gray-300 dark:text-neutral-600"
          }`}
          title={sign || undefined}
        >
          {sign || "这个人很神秘，什么都没有写"}
        </p>

        {/* 时间行的位置、字号、句式都与「关注列表」页一致（`日期 + 说明`，左对齐）。
            之前放在右下角、还按类型换文案，同一列里会同时出现三种写法。 */}
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <p className="text-xs text-gray-400 dark:text-neutral-500">
            {formatDateTime(item.vanishedAt)}{" "}
            {item.reason === "renamed" ? "最近改名" : "检测到注销"}
          </p>
          <button
            type="button"
            onClick={onOpen}
            className="shrink-0 rounded-md border border-gray-200 px-2 py-0.5 text-[11px] text-gray-500 transition-colors hover:border-pink-300 hover:text-pink-500 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-pink-500/50 dark:hover:text-pink-400"
          >
            查看详情
          </button>
        </div>
      </div>
    </article>
  );
};

const VANISH_PAGE_SIZE = 48;

/**
 * 删除确认的强制等待秒数。
 *
 * 档案是内容消失后的唯一副本，误点一次就是永久损失。让"确认删除"按钮先冷却几秒，
 * 是为了打断"看到弹窗就条件反射点右边那个按钮"的动作——这几秒足够看清上面写的是什么。
 */
const DELETE_CONFIRM_WAIT_SECONDS = 5;

type SortKey =
  | "pubtime_desc"
  | "pubtime_asc"
  | "vanished_desc"
  | "vanished_asc"
  | "title_asc";

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: "pubtime_desc", label: "发布时间 新→旧" },
  { key: "pubtime_asc", label: "发布时间 旧→新" },
  { key: "vanished_desc", label: "最近消失" },
  { key: "vanished_asc", label: "最早消失" },
  { key: "title_asc", label: "标题 A→Z" },
];

const Vanished = () => {
  const [archive, setArchive] = useState<VanishArchiveItem[]>([]);
  const [following, setFollowing] = useState<FollowingItem[]>([]);
  const [folders, setFolders] = useState<FavoriteFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  // 「全部」视图会同时渲染关注卡片与视频卡片（两套排版），已移除；默认只看收藏夹。
  const [source, setSource] = useState<VanishArchiveSource>("favorites");
  const [reason, setReason] = useState<VanishArchiveReason | "all">("all");
  const [sort, setSort] = useState<SortKey>("pubtime_desc");
  /** 自定义排序下拉：原生 select 的菜单样式在不同浏览器里差异太大 */
  const [isSortOpen, setIsSortOpen] = useState(false);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const initialSourcePickedRef = useRef(false);
  /** 档案快照里没有对应关注记录时，名字切换只在本地生效（key = 档案 id） */
  const [archiveNameOverrides, setArchiveNameOverrides] = useState<Record<string, number>>({});
  const [visibleCount, setVisibleCount] = useState(VANISH_PAGE_SIZE);
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [detailItem, setDetailItem] = useState<VanishArchiveItem | null>(null);
  /** 删除二次确认。档案是内容消失后的唯一副本，误删不可恢复，必须挡一道 */
  const [deleteConfirm, setDeleteConfirm] = useState<VanishArchiveItem[] | null>(null);
  /** 确认按钮的冷却倒计时（秒）。归零前不允许点击 */
  const [deleteWait, setDeleteWait] = useState(0);

  // 打开确认框即开始冷却；每秒减 1，靠 deleteWait 自身驱动，避免计时器泄漏
  useEffect(() => {
    if (!deleteConfirm) {
      setDeleteWait(0);
      return;
    }
    setDeleteWait(DELETE_CONFIRM_WAIT_SECONDS);
  }, [deleteConfirm]);

  useEffect(() => {
    if (deleteWait <= 0) return;
    const timer = window.setTimeout(() => setDeleteWait((value) => value - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [deleteWait]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [stored, legacy, followingList, favorites, interactions, folderList] =
        await Promise.all([
          getAllVanishArchive(),
          getAllVanishedFavResources(),
          getAllFollowing(),
          getAllFavResources(),
          getAllInteractions(),
          getAllFavFolders(),
        ]);

      // 两层来源合并。第二层是"读时派生"：源记录里已经查不到、但还没写进档案的内容。
      // 没有它，用户本地明明有已失效收藏 / 已注销关注 / 稿件已删的互动，页面却是空的。
      const persisted = mergeArchiveWithLegacy(stored, legacy);
      const merged = normalizeArchiveReasons(
        enrichArchiveFromLive(
          mergeVanishArchive(
            persisted,
            collectLiveVanishArchive({
              favorites,
              collections: [],
              following: followingList,
              interactions,
              isInvalidated: isInvalidatedResource,
            }),
          ),
          favorites,
        ),
      );
      setArchive(merged);

      // 默认只看收藏夹；若收藏夹档案为空，自动切到第一个有内容的来源
      if (!initialSourcePickedRef.current) {
        initialSourcePickedRef.current = true;
        if (!merged.some((item) => item.source === "favorites")) {
          const first = SOURCES.find((value) => merged.some((item) => item.source === value));
          if (first) setSource(first);
        }
      }
      setFollowing(followingList);
      setFolders(folderList);
    } catch (error) {
      console.error("读取消失档案失败:", error);
      toast.error("读取消失档案失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!isSortOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (sortMenuRef.current && !sortMenuRef.current.contains(event.target as Node)) {
        setIsSortOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isSortOpen]);

  const stats = useMemo(() => buildVanishArchiveStats(archive), [archive]);
  const followingByMid = useMemo(
    () => new Map(following.map((item) => [item.mid, item])),
    [following],
  );

  /** 收藏夹 id → 名称：档案按「收藏夹 + 视频」存条目，同一条 BV 在多个夹子里会出现多条 */
  const folderLabelFor = (item: VanishArchiveItem): string | null => {
    if (item.kind !== "favorite") return null;
    const snapshot = item.item as { folder_id?: unknown } | null | undefined;
    const rawFolderId = snapshot?.folder_id ?? item.sourceId.split(":")[0];
    const folderId = Number(rawFolderId);
    if (!Number.isFinite(folderId) || folderId <= 0) return null;
    const title = folders.find((folder) => folder.id === folderId)?.title;
    return title ? `收藏夹：${title}` : `收藏夹 ID ${folderId}`;
  };

  /**
   * 在曾用名浮层里点选名字，切换卡片显示名。
   * - 还有当前关注记录：写回 `formerNameDisplayIndex`（和关注列表页一致）；
   * - 只剩档案快照：只更新本页状态，不伪造关注记录。
   */
  const handleSelectArchiveFormerName = async (item: VanishArchiveItem, index: number) => {
    const mid = Number(item.sourceId);
    const live = followingByMid.get(mid);
    if (!live) {
      setArchiveNameOverrides((current) => ({ ...current, [item.id]: index }));
      return;
    }
    try {
      await patchFollowingItems([mid], { formerNameDisplayIndex: index });
      setFollowing((current) =>
        current.map((entry) =>
          entry.mid === mid ? { ...entry, formerNameDisplayIndex: index } : entry,
        ),
      );
    } catch (error) {
      console.error("切换显示名失败:", error);
      toast.error("切换显示名失败");
    }
  };

  const filtered = useMemo(() => {
    const filter: VanishArchiveFilter = { keyword, source, reason };
    const result = queryVanishArchive(archive, filter);
    // 卡片显示的是"内容自身时间"（发布时间 → 收藏时间），排序就必须用它；
    // 之前默认按 vanishedAt 排，而批量归档的 vanishedAt 几乎相同，看起来就是乱序。
    const displayTimeOf = (item: VanishArchiveItem) => getArchiveDisplayTime(item)?.at ?? 0;
    const byDisplayTime = (a: VanishArchiveItem, b: VanishArchiveItem, asc: boolean) => {
      const ta = displayTimeOf(a);
      const tb = displayTimeOf(b);
      if (ta === 0 && tb === 0) return b.vanishedAt - a.vanishedAt;
      if (ta === 0) return 1;
      if (tb === 0) return -1;
      return asc ? ta - tb : tb - ta;
    };

    if (sort === "pubtime_desc") {
      return result.slice().sort((a, b) => byDisplayTime(a, b, false));
    }
    if (sort === "pubtime_asc") {
      return result.slice().sort((a, b) => byDisplayTime(a, b, true));
    }
    if (sort === "vanished_asc") {
      return result
        .slice()
        .sort((a, b) => a.vanishedAt - b.vanishedAt || byDisplayTime(a, b, false));
    }
    if (sort === "title_asc") {
      return result
        .slice()
        .sort((a, b) => (a.title || a.sourceId).localeCompare(b.title || b.sourceId, "zh-CN"));
    }
    return result
      .slice()
      .sort((a, b) => b.vanishedAt - a.vanishedAt || byDisplayTime(a, b, false));
  }, [archive, keyword, reason, sort, source]);

  const visible = useMemo(() => filtered.slice(0, visibleCount), [filtered, visibleCount]);

  const resetPaging = () => setVisibleCount(VANISH_PAGE_SIZE);

  const toggleSelect = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );

  const handleExport = () => {
    try {
      const payload = {
        exportedAt: new Date().toISOString(),
        total: filtered.length,
        items: filtered,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `vanish-archive-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.click();
      URL.revokeObjectURL(url);
      toast.success(`已导出 ${filtered.length} 条`);
    } catch (error) {
      console.error("导出消失档案失败:", error);
      toast.error("导出失败");
    }
  };

  /**
   * 恢复到原来的 store（收藏夹 / 订阅合集 / 关注列表 / 互动记录）。
   *
   * 这是这个功能存在的根本目的：清空浏览器数据后，光有档案看不了，
   * 得能把它写回功能页面才算真的"备份住了"。档案条目本身不删除。
   */
  const restoreItems = useCallback(
    async (targets: VanishArchiveItem[]) => {
      if (targets.length === 0) return;
      const result = await restoreVanishArchiveItems(targets);
      if (result.restored === 0) {
        toast.error("这些档案没有可用的快照，无法恢复");
        return;
      }
      toast.success(
        `已恢复 ${result.restored} 条到原页面${
          result.skipped > 0 ? `；${result.skipped} 条没有快照，已跳过` : ""
        }`,
      );
      await load();
    },
    [load],
  );

  const handleRestoreSelected = async () => {
    if (selected.length === 0) return;
    setIsRestoring(true);
    try {
      await restoreItems(archive.filter((item) => selected.includes(item.id)));
      setSelected([]);
      setManaging(false);
    } catch (error) {
      console.error("恢复档案失败:", error);
      toast.error("恢复失败");
    } finally {
      setIsRestoring(false);
    }
  };

  /**
   * 删除选中的档案。只删**持久化**的那部分；
   * 读时派生的条目删不掉——源记录一旦恢复（比如稿件重新可见）它们会自己消失。
   *
   * 调用前必须先经过 `deleteConfirm` 二次确认。
   */
  const handleDeleteSelected = async (targets: VanishArchiveItem[]) => {
    if (targets.length === 0) return;
    setIsDeleting(true);
    try {
      const ids = targets.map((item) => item.id);
      await deleteVanishArchiveItems(ids);
      // 旧收藏档案用复合主键，单独按 `${folder_id}:${id}` 反解删除
      const legacyKeys = ids
        .filter((id) => id.startsWith("favorite:"))
        .map((id) => {
          const parts = id.slice("favorite:".length).split(":");
          return [Number(parts[0]), Number(parts[1])] as [number, number];
        })
        .filter(
          ([folderId, resourceId]) => Number.isFinite(folderId) && Number.isFinite(resourceId),
        );
      if (legacyKeys.length > 0) await deleteVanishedFavResources(legacyKeys);

      toast.success(`已删除 ${ids.length} 条档案`);
      setSelected([]);
      setManaging(false);
      setDeleteConfirm(null);
      await load();
    } catch (error) {
      console.error("删除档案失败:", error);
      toast.error("删除失败");
    } finally {
      setIsDeleting(false);
    }
  };

  const hasFilter = reason !== "all" || keyword.trim() !== "";
  const clearFilters = () => {
    setKeyword("");
    setReason("all");
    resetPaging();
  };

  const allVisibleSelected = visible.length > 0 && visible.every((item) => selected.includes(item.id));
  // 关注类**始终**走行式布局（与关注列表页一致），不管当前筛选是什么。
  // 之前只在"来源=关注列表"时走行式，混合视图下同一类记录会突然换成网格卡片，
  // 那是两套逻辑——用户明确反对这种做法。
  const followingVisible = visible.filter((item) => item.kind === "following");
  const mediaVisible = visible.filter((item) => item.kind !== "following");
  const detailFollowing =
    detailItem && detailItem.kind === "following"
      ? (followingByMid.get(Number(detailItem.sourceId)) ??
        snapshotAsFollowing(detailItem) ??
        undefined)
      : undefined;
  const detailRows = detailItem ? buildSnapshotRows(detailItem.item) : [];
  const detailFolderLabel = detailItem ? folderLabelFor(detailItem) : null;

  /** 侧栏筛选按钮：与「互动记录」「关注列表」保持同一套样式与计数位置 */
  const filterButtonClass = (active: boolean) =>
    `mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
      active
        ? "bg-pink-50 text-pink-600 dark:bg-pink-500/10 dark:text-pink-400"
        : "text-gray-600 hover:bg-gray-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
    }`;

  return (
    <div className="flex h-screen">
      {/* 左侧筛选栏：本仓库的惯例位置，与其他页面一致 */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-gray-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 p-4 dark:border-neutral-800">
          <h2 className="flex min-w-0 items-center gap-2 text-lg font-bold text-gray-900 dark:text-neutral-100">
            <Trash2 className="h-5 w-5 shrink-0 text-pink-500" />
            <span className="truncate">消失档案</span>
          </h2>
          <button
            type="button"
            title="重新读取档案"
            aria-label="重新读取档案"
            onClick={() => void load()}
            className="shrink-0 rounded-md p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-pink-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-pink-400"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-2">
          <p className="px-3 pb-1 pt-2 text-xs font-medium text-gray-400 dark:text-neutral-500">
            来源
          </p>
          {SOURCES.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setSource(value);
                resetPaging();
              }}
              className={filterButtonClass(source === value)}
            >
              <span>{VANISH_SOURCE_LABEL[value]}</span>
              <span className="text-xs text-gray-400 dark:text-neutral-500">
                {stats.bySource[value]}
              </span>
            </button>
          ))}

          {/* 原因只列出真实存在的，避免一屏的 0 */}
          {REASONS.some((value) => stats.byReason[value] > 0) ? (
            <>
              <p className="px-3 pb-1 pt-3 text-xs font-medium text-gray-400 dark:text-neutral-500">
                原因
              </p>
              <button
                type="button"
                onClick={() => {
                  setReason("all");
                  resetPaging();
                }}
                className={filterButtonClass(reason === "all")}
              >
                <span>全部原因</span>
                <span className="text-xs text-gray-400 dark:text-neutral-500">
                  {stats.total}
                </span>
              </button>
              {REASONS.map((value) => {
                const count = stats.byReason[value];
                if (count === 0) return null;
                return (
                  <button
                    key={value}
                    type="button"
                    onClick={() => {
                      setReason(value);
                      resetPaging();
                    }}
                    className={filterButtonClass(reason === value)}
                  >
                    <span className="truncate">{VANISH_ARCHIVE_REASON_LABEL[value]}</span>
                    <span className="ml-2 shrink-0 text-xs text-gray-400 dark:text-neutral-500">
                      {count}
                    </span>
                  </button>
                );
              })}
            </>
          ) : null}
        </nav>

        <div className="border-t border-gray-200 p-3 text-xs leading-relaxed text-gray-400 dark:border-neutral-800 dark:text-neutral-500">
          <p>找到内容消失时先存一份当时的完整快照，可随时恢复到原来的页面。</p>
          <p className="mt-1">条目只增不删，已默认纳入「数据备份」。</p>
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1500px] px-6 py-5 lg:px-10">
          {/* 这个页面存在的理由必须写清楚：不写用户不知道它是干什么用的 */}
          <div className="mb-5 flex items-start gap-3 rounded-xl border border-pink-100 bg-pink-50/60 p-4 text-xs leading-relaxed text-pink-700 dark:border-pink-500/20 dark:bg-pink-500/5 dark:text-pink-200">
            <Inbox className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">
                档案是内容消失后的唯一副本，图片字节只有「本地目录备份」才会一起保存。
              </p>
              <p className="mt-1 text-pink-600/90 dark:text-pink-200/80">
                收藏、订阅合集、关注与互动四处的内容一旦在 B 站查不到，快照就会留在这里；
                点「恢复」可以把快照写回收藏夹 / 关注列表等原来的页面，档案条目本身保留。
              </p>
              <p className="mt-1 text-pink-600/90 dark:text-pink-200/80">
                标「未证实」的条目只凭标题里的占位文案判定，B 站没有给出明确的删除标记，稿件可能仍然可访问。
                标「改过曾用名」的关注**并没有消失**——它进档案是因为曾用名在 B 站查不到，只有本地留了这一份。
              </p>
            </div>
          </div>

          <div className="mb-6 flex flex-col justify-between gap-4 rounded-xl border border-gray-100 bg-white p-4 shadow-sm md:flex-row md:items-center dark:border-neutral-800 dark:bg-neutral-900">
            <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900 dark:text-neutral-100">
              {VANISH_SOURCE_LABEL[source]}
              <span className="whitespace-nowrap rounded-full border border-gray-100 bg-gray-50 px-2 py-1 text-sm font-normal text-gray-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400">
                {filtered.length} 条
              </span>
            </h1>

            <div className="flex flex-wrap items-center gap-3">
              <div className="relative flex w-72 max-w-full items-center rounded-full border border-gray-200 bg-gray-50 transition-all focus-within:border-pink-400 focus-within:bg-white dark:border-neutral-700 dark:bg-neutral-800 dark:focus-within:bg-neutral-800">
                <Search className="ml-3.5 h-4 w-4 shrink-0 text-gray-400 dark:text-neutral-500" />
                <input
                  type="text"
                  value={keyword}
                  onChange={(event) => {
                    setKeyword(event.target.value);
                    resetPaging();
                  }}
                  placeholder="搜索标题、UP 主、BV 号…"
                  className="min-w-0 flex-1 bg-transparent py-1.5 pl-2.5 pr-8 text-sm text-gray-700 placeholder-gray-400 focus:outline-none dark:text-neutral-100 dark:placeholder-neutral-500"
                />
                {keyword ? (
                  <button
                    type="button"
                    aria-label="清空搜索"
                    onClick={() => {
                      setKeyword("");
                      resetPaging();
                    }}
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 hover:text-gray-600 dark:text-neutral-500 dark:hover:text-neutral-300"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>

              <div className="relative" ref={sortMenuRef}>
                <button
                  type="button"
                  onClick={() => setIsSortOpen((open) => !open)}
                  aria-haspopup="listbox"
                  aria-expanded={isSortOpen}
                  className={`flex items-center gap-1.5 rounded-full border bg-gray-50 py-1.5 pl-2.5 pr-2.5 text-sm transition-colors focus:outline-none dark:bg-neutral-800 ${
                    isSortOpen
                      ? "border-pink-400 text-pink-600 dark:border-pink-500/50 dark:text-pink-400"
                      : "border-gray-200 text-gray-700 hover:border-pink-300 dark:border-neutral-700 dark:text-neutral-100 dark:hover:border-pink-500/50"
                  }`}
                >
                  <ArrowDownUp className="h-3.5 w-3.5 text-gray-400 dark:text-neutral-500" />
                  <span className="whitespace-nowrap">
                    {SORTS.find((option) => option.key === sort)?.label ?? "排序"}
                  </span>
                  <ChevronDown
                    className={`h-3.5 w-3.5 text-gray-400 transition-transform dark:text-neutral-500 ${
                      isSortOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {isSortOpen ? (
                  <div
                    role="listbox"
                    aria-label="排序方式"
                    className="absolute right-0 z-40 mt-1.5 w-44 overflow-hidden rounded-xl border border-gray-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
                  >
                    {SORTS.map((option) => (
                      <button
                        key={option.key}
                        type="button"
                        role="option"
                        aria-selected={option.key === sort}
                        onClick={() => {
                          setSort(option.key);
                          setIsSortOpen(false);
                          resetPaging();
                        }}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm transition-colors ${
                          option.key === sort
                            ? "bg-pink-50 font-medium text-pink-600 dark:bg-pink-500/10 dark:text-pink-400"
                            : "text-gray-700 hover:bg-gray-50 dark:text-neutral-300 dark:hover:bg-neutral-800"
                        }`}
                      >
                        <span>{option.label}</span>
                        {option.key === sort ? <Check className="h-4 w-4" /> : null}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>

              {stats.total > 0 ? (
                <button
                  type="button"
                  onClick={() => {
                    setManaging((value) => !value);
                    setSelected([]);
                  }}
                  className={`rounded-full border px-3 py-1.5 text-xs transition-colors ${
                    managing
                      ? "border-pink-300 bg-pink-50 text-pink-600 dark:border-pink-500/40 dark:bg-pink-500/10 dark:text-pink-400"
                      : "border-gray-200 text-gray-600 hover:border-pink-300 hover:text-pink-500 dark:border-neutral-700 dark:text-neutral-300"
                  }`}
                >
                  {managing ? "退出管理" : "管理档案"}
                </button>
              ) : null}
              <button
                type="button"
                onClick={handleExport}
                disabled={filtered.length === 0}
                className="rounded-full border border-gray-200 px-3 py-1.5 text-xs text-gray-600 transition-colors hover:border-pink-300 hover:text-pink-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-pink-500/50 dark:hover:text-pink-400"
              >
                导出当前结果
              </button>
            </div>
          </div>

          {loading ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-5">
              {Array.from({ length: 8 }).map((_, index) => (
                <div
                  key={index}
                  className="h-64 animate-pulse rounded-xl bg-gray-100 dark:bg-neutral-800/60"
                />
              ))}
            </div>
          ) : stats.total === 0 ? (
            <div className="mx-auto max-w-xl py-20 text-center">
              <Inbox className="mx-auto h-10 w-10 text-gray-300 dark:text-neutral-600" />
              <p className="mt-4 text-sm font-medium text-gray-600 dark:text-neutral-300">
                还没有任何消失档案
              </p>
              <p className="mt-2 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
                当收藏、订阅合集里的内容在 B 站查不到时，插件会在移除本地记录之前先留档到这里；
                关注账号注销、点赞过的稿件被删也一并收入。开启对应的自动同步后，它会自己攒起来。
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-20 text-center text-sm text-gray-400 dark:text-neutral-500">
              没有匹配的记录
              <button
                type="button"
                onClick={clearFilters}
                className="ml-2 text-pink-600 underline underline-offset-4 dark:text-pink-400"
              >
                清除筛选
              </button>
            </div>
          ) : (
            <>
              {/* 关注类用行式布局（与「关注列表」页一致），视频类用网格卡片 */}
              {followingVisible.length > 0 ? (
                // 与「关注列表」页同一个网格：多列、每列最小 320px。
                // 之前写成整宽单列，一条记录只占左边一小块、右边全空，很难看。
                <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] items-start gap-4">
                  {followingVisible.map((item) => (
                    <VanishedFollowingRow
                      key={item.id}
                      item={item}
                      managing={managing}
                      selected={selected.includes(item.id)}
                      selectedFormerNameIndex={archiveNameOverrides[item.id]}
                      onSelectFormerName={(index) =>
                        void handleSelectArchiveFormerName(item, index)
                      }
                      onToggleSelect={() => toggleSelect(item.id)}
                      onOpen={() => setDetailItem(item)}
                      following={followingByMid.get(Number(item.sourceId))}
                    />
                  ))}
                </div>
              ) : null}

              {mediaVisible.length > 0 ? (
                <div
                  className={`grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-5 ${
                    followingVisible.length > 0 ? "mt-5" : ""
                  }`}
                >
                  {mediaVisible.map((item) => (
                    <VanishedCard
                      key={item.id}
                      item={item}
                      folderLabel={folderLabelFor(item)}
                      selected={selected.includes(item.id)}
                      managing={managing}
                      onToggleSelect={() => toggleSelect(item.id)}
                      onOpen={() => setDetailItem(item)}
                      onRestore={() => {
                        void restoreItems([item]).catch((error) => {
                          console.error("恢复失败:", error);
                          toast.error("恢复失败");
                        });
                      }}
                    />
                  ))}
                </div>
              ) : null}

              {filtered.length > visible.length ? (
                <button
                  type="button"
                  onClick={() => setVisibleCount((count) => count + VANISH_PAGE_SIZE)}
                  className="mx-auto mt-6 block rounded-full border border-gray-200 px-5 py-2 text-sm text-gray-600 transition-colors hover:border-pink-300 hover:text-pink-500 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-pink-500/50 dark:hover:text-pink-400"
                >
                  加载更多（还有 {filtered.length - visible.length} 条）
                </button>
              ) : (
                <p className="mt-6 text-center text-xs text-gray-400 dark:text-neutral-500">
                  已显示全部 {filtered.length} 条
                </p>
              )}
            </>
          )}
        </div>
      </main>

      {/* 管理模式的操作条吸附在底部，长列表里不用上下找按钮 */}
      {managing ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center px-6">
          <div className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-2.5 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
            <button
              type="button"
              onClick={() => setSelected(allVisibleSelected ? [] : visible.map((item) => item.id))}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              {allVisibleSelected ? (
                <CheckSquare className="h-4 w-4" />
              ) : (
                <Square className="h-4 w-4" />
              )}
              {allVisibleSelected ? "取消全选" : `全选本页（${visible.length}）`}
            </button>
            <p className="text-sm text-gray-600 dark:text-neutral-300">
              已选 <span className="font-semibold tabular-nums">{selected.length}</span> 条
            </p>
            <button
              type="button"
              onClick={() => void handleRestoreSelected()}
              disabled={selected.length === 0 || isRestoring || isDeleting}
              className="inline-flex items-center gap-1.5 rounded-lg bg-pink-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-pink-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RotateCcw className="h-4 w-4" />
              {isRestoring ? "恢复中…" : "恢复到原页面"}
            </button>
            <button
              type="button"
              onClick={() =>
                setDeleteConfirm(archive.filter((item) => selected.includes(item.id)))
              }
              disabled={selected.length === 0 || isDeleting || isRestoring}
              className="rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
            >
              {isDeleting ? "删除中…" : "删除所选"}
            </button>
          </div>
        </div>
      ) : null}

      {/* 删除二次确认。档案是内容消失后的唯一副本，一次误点就是永久损失，
          所以这里必须挡一道，并明确告知"不可撤销"。 */}
      {deleteConfirm ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isDeleting) setDeleteConfirm(null);
          }}
        >
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl dark:bg-neutral-900">
            <div className="p-5">
              <h3 className="text-base font-bold text-gray-900 dark:text-neutral-100">
                确认删除这 {deleteConfirm.length} 条档案？
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-500 dark:text-neutral-400">
                档案是内容消失后的唯一副本，删除后无法撤销、也无法从 B 站重新同步回来。
                如果只是想让它从列表里消失，可以先用「导出当前结果」留一份。
              </p>
              <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-lg bg-gray-50 p-2 text-xs dark:bg-neutral-800/60">
                {deleteConfirm.slice(0, 8).map((item) => (
                  <li key={item.id} className="flex items-center gap-2">
                    <span className="shrink-0 rounded bg-white px-1.5 py-0.5 text-gray-500 dark:bg-neutral-800 dark:text-neutral-400">
                      {VANISH_SOURCE_LABEL[item.source]}
                    </span>
                    <span className="min-w-0 truncate text-gray-700 dark:text-neutral-200">
                      {item.title?.trim() || item.bvid || item.sourceId}
                    </span>
                  </li>
                ))}
                {deleteConfirm.length > 8 ? (
                  <li className="pt-1 text-gray-400 dark:text-neutral-500">
                    还有 {deleteConfirm.length - 8} 条…
                  </li>
                ) : null}
              </ul>
              <p className="mt-3 text-xs leading-relaxed text-amber-600 dark:text-amber-400">
                提示：从收藏 / 关注 / 互动当前状态实时派生的条目删掉后会再次出现——
                只要源记录仍是"已失效"状态。这是预期行为。
              </p>
              {deleteWait > 0 ? (
                <p className="mt-2 text-xs text-gray-400 dark:text-neutral-500">
                  「确认删除」按钮将在 {deleteWait} 秒后可点击。
                </p>
              ) : null}
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 p-4 dark:border-neutral-800">
              <button
                type="button"
                onClick={() => setDeleteConfirm(null)}
                disabled={isDeleting}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteSelected(deleteConfirm)}
                disabled={isDeleting || deleteWait > 0}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isDeleting
                  ? "删除中…"
                  : deleteWait > 0
                    ? `请稍候 ${deleteWait} 秒…`
                    : `确认删除 ${deleteConfirm.length} 条`}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {detailItem ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDetailItem(null);
          }}
        >
          <div className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl dark:bg-neutral-900">
            <div className="flex items-start justify-between gap-3 border-b border-gray-100 p-5 dark:border-neutral-800">
              <div className="min-w-0">
                <h2 className="line-clamp-2 text-lg font-bold text-gray-900 dark:text-neutral-100">
                  {detailItem.title?.trim() || "（无标题）"}
                </h2>
                <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
                  {VANISH_SOURCE_LABEL[detailItem.source]} ·{" "}
                  {VANISH_KIND_LABEL[detailItem.kind]} ·{" "}
                  {VANISH_ARCHIVE_REASON_LABEL[detailItem.reason]}
                  {detailItem.bvid ? ` · ${detailItem.bvid}` : ""}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDetailItem(null)}
                className="shrink-0 rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 dark:hover:bg-neutral-800"
                aria-label="关闭详情"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-3">
                  <dt className="text-gray-500 dark:text-neutral-400">判定消失时间</dt>
                  <dd className="tabular-nums text-gray-700 dark:text-neutral-200">
                    {formatDateTime(detailItem.vanishedAt)}
                  </dd>
                </div>
                {detailFolderLabel ? (
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500 dark:text-neutral-400">所属收藏夹</dt>
                    <dd className="min-w-0 break-all text-right text-gray-700 dark:text-neutral-200">
                      {detailFolderLabel.replace(/^收藏夹：/, "")}
                    </dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-3">
                  <dt className="text-gray-500 dark:text-neutral-400">最近一次核查</dt>
                  <dd className="text-right tabular-nums text-gray-700 dark:text-neutral-200">
                    {detailItem.probeAttemptedAt
                      ? formatDateTime(detailItem.probeAttemptedAt)
                      : "从未记到"}
                    {detailItem.probeError ? (
                      <span className="ml-2 text-red-500">失败：{detailItem.probeError}</span>
                    ) : null}
                  </dd>
                </div>
                {detailItem.invalidationUnproven ? (
                  <div className="flex justify-between gap-3">
                    <dt className="text-gray-500 dark:text-neutral-400">失效判定</dt>
                    <dd className="text-amber-600 dark:text-amber-400">
                      未经证实（仅凭标题占位文案）
                    </dd>
                  </div>
                ) : null}
              </dl>

              {detailFollowing ? <NameTimeline following={detailFollowing} /> : null}

              <section>
                <h3 className="text-sm font-semibold text-gray-800 dark:text-neutral-200">
                  存档内容
                </h3>
                <p className="mt-1 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
                  消失那一刻记录下来的字段。这些就是「恢复」要写回原页面的内容。
                </p>

                {detailRows.length > 0 ? (
                  <dl className="mt-2 divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-100 dark:divide-neutral-800 dark:border-neutral-800">
                    {detailRows.map((row) => (
                      <div
                        key={row.label}
                        className="flex items-start justify-between gap-4 px-3 py-2 text-xs"
                      >
                        <dt className="shrink-0 text-gray-500 dark:text-neutral-400">
                          {row.label}
                        </dt>
                        <dd
                          className="min-w-0 break-all text-right text-gray-700 dark:text-neutral-200"
                          title={row.value}
                        >
                          {row.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}

                {/* 原始 JSON 保留但折叠起来：默认摊开会让用户淹没在 ogv/ugc 这类字段里 */}
                <details className="group mt-3">
                  <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs text-gray-400 transition-colors hover:text-pink-500 dark:text-neutral-500 dark:hover:text-pink-400">
                    <ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />
                    {detailRows.length > 0 ? "查看完整原始快照" : "查看原始快照"}
                  </summary>
                  <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-gray-50 p-3 text-xs leading-relaxed text-gray-600 dark:bg-neutral-800/60 dark:text-neutral-300">
                    {JSON.stringify(detailItem.item ?? null, null, 2)}
                  </pre>
                </details>
              </section>
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-gray-100 p-4 dark:border-neutral-800">
              {/* 左下角按类型给最有用的动作：关注类是「访问空间」，视频类是「复制 BV 号」。
                  注销账号的空间是 404，那种情况退回复制 UID。 */}
              {detailItem.kind === "following" ? (
                (detailFollowing?.status ?? "gone") === "gone" ? (
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(detailItem.sourceId);
                        toast.success(`已复制 UID ${detailItem.sourceId}`);
                      } catch (error) {
                        console.error("复制 UID 失败:", error);
                        toast.error("复制失败");
                      }
                    }}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    复制 UID
                  </button>
                ) : (
                  <a
                    href={`https://space.bilibili.com/${detailItem.sourceId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 no-underline transition-colors hover:bg-gray-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    访问空间
                  </a>
                )
              ) : (
                <button
                  type="button"
                  onClick={() => void copyBvid(detailItem)}
                  disabled={!detailItem.bvid}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  复制 BV 号
                </button>
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setDetailItem(null)}
                  className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  关闭
                </button>
                <button
                  type="button"
                  onClick={async () => {
                    const target = detailItem;
                    setIsRestoring(true);
                    try {
                      await restoreItems([target]);
                      setDetailItem(null);
                    } catch (error) {
                      console.error("恢复失败:", error);
                      toast.error("恢复失败");
                    } finally {
                      setIsRestoring(false);
                    }
                  }}
                  disabled={isRestoring || !detailItem.item}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-pink-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-pink-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <RotateCcw className="h-4 w-4" />
                  {isRestoring ? "恢复中…" : "恢复到原页面"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default Vanished;
