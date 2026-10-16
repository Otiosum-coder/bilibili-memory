import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import {
  CheckSquare,
  ChevronDown,
  Heart,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  ThumbsUp,
  X,
} from "lucide-react";
import { Pagination } from "../components/Pagination";
import { createAssetObjectUrl } from "../utils/assetArchive";
import { INTERACTIONS_LAST_SYNC, INTERACTIONS_SYNC_PROGRESS } from "../utils/constants";
import { deleteInteractionItems, getAllInteractions } from "../utils/db";
import { PLACEHOLDER_COVER_PATH } from "../utils/imageUrl";
import {
  INTERACTION_FILTER_OPTIONS,
  INTERACTION_STATE_HINT,
  INTERACTION_STATE_LABEL,
  INTERACTION_TYPE_LABEL,
  buildInteractionDetail,
  buildInteractionStats,
  formatInteractionDuration,
  formatFullDateTime,
  interactionAuthorUrl,
  interactionVideoUrl,
  isInteractionContentGone,
  paginateInteractions,
  queryInteractions,
  type InteractionFilter,
  type InteractionSort,
} from "../utils/interactionQuery";
import { getStorageValue } from "../utils/storage";
import type { InteractionItem, InteractionState, InteractionType } from "../utils/types";
import type { InteractionSyncProgress } from "../utils/interactionSync";

const PAGE_SIZE = 24;

const SORTS: Array<{ value: InteractionSort; label: string; hint?: string }> = [
  { value: "date_desc", label: "日期新→旧" },
  { value: "date_asc", label: "日期旧→新" },
  {
    value: "duration_desc",
    label: "时长长→短",
    hint: "时长未知的记录（早期抓到的）统一排在最后。",
  },
  {
    value: "duration_asc",
    label: "时长短→长",
    hint: "时长未知的记录（早期抓到的）统一排在最后。",
  },
];

/**
 * 类型图标一律照 B 站自己的设计来（这版是第三次改，前两版的教训都记在这）：
 *
 * - **点赞 = 描边大拇指**。B 站点赞用的就是大拇指，不是心形（心形在 B 站是"收藏/喜欢"的语义）。
 * - **投币 = 描边圆 + 「币」字**。B 站投币按钮和"1 硬币 / 2 硬币"提示里都是"圆里一个币字"，
 *   这里用描边圆实现同一造型（CJK 字形交给系统字体渲染，比手画路径可靠）。
 * - **不带底色**：图标直接贴在封面上，靠一层投影保证在亮/暗封面上都看得清。
 *   前两版分别用过「色块角标」和「白圆挖币字」，都被否掉了——色块太重，喧宾夺主。
 * - lucide 的 `Coins`（两枚叠着的硬币）已弃用：既不忠于 B 站设计，也容易被读成"投了两枚"。
 */
const CoinIcon = () => (
  <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border-2 border-current text-[9px] font-semibold leading-none">
    币
  </span>
);

/** 封面左上角的类型图标。不上底色，颜色即语义：点赞粉、投币琥珀 */
const TYPE_ICON_CLASS: Record<InteractionType, string> = {
  like: "text-pink-400",
  coin: "text-amber-400",
};

/** 封面右上角的状态角标。**只在异常时出现**：「仍在列表」是默认态，不该占任何位置 */
const STATE_BADGE_CLASS: Partial<Record<InteractionState, string>> = {
  retained: "bg-sky-500/90",
  unlisted: "bg-gray-500/90",
  ended: "bg-amber-500/90",
  content_deleted: "bg-gray-500/90",
  content_hidden: "bg-amber-500/90",
};

const formatDateTime = (timestamp?: number): string => {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
};

const formatDate = (timestamp?: number): string =>
  timestamp ? new Date(timestamp).toLocaleDateString() : "";

/**
 * 封面：优先用本地归档的字节，其次回退 B 站原地址，最后回退占位图。
 *
 * 互动记录的价值恰恰在于"稿件以后可能没了"，所以归档字节必须优先于网络地址。
 */
const InteractionCover = ({ item }: { item: InteractionItem }) => {
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
  const duration = formatInteractionDuration(item.duration);
  const gone = item.state !== "listed";

  return (
    <div className="relative aspect-video w-full shrink-0 overflow-hidden bg-gray-100 dark:bg-neutral-800">
      <img
        src={assetUrl ?? (remote || `https://i0.hdslb.com${PLACEHOLDER_COVER_PATH}`)}
        alt=""
        loading="lazy"
        className="h-full w-full object-cover"
        onError={(event) => {
          const image = event.currentTarget;
          const fallback = `https://i0.hdslb.com${PLACEHOLDER_COVER_PATH}`;
          if (!image.src.startsWith(fallback)) image.src = fallback;
        }}
      />

      {/* 类型图标：直接贴在封面左上角，无底色；投影保证在亮封面上也不会糊掉 */}
      <span
        className={`absolute left-2 top-2 inline-flex items-center justify-center drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)] ${TYPE_ICON_CLASS[item.type]}`}
        title={INTERACTION_TYPE_LABEL[item.type]}
      >
        {item.type === "like" ? (
          <ThumbsUp className="h-[18px] w-[18px]" />
        ) : (
          <CoinIcon />
        )}
      </span>

      {/* 状态角标只在本条记录出问题时出现 */}
      {gone ? (
        <span
          className={`absolute right-2 top-2 rounded px-1.5 py-0.5 text-xs text-white ${
            STATE_BADGE_CLASS[item.state] ?? STATE_BADGE_CLASS.unlisted
          }`}
          title={`${INTERACTION_STATE_HINT[item.state]}${
            item.unlistedDetectedAt
              ? ` 首次发现它不在 B 站列表：${formatDate(item.unlistedDetectedAt)}`
              : ""
          }${
            // 「未判定」必须能自证进度：否则用户无从判断它是卡住了还是正要重试
            item.probeAttemptedAt
              ? ` 上次核查：${formatFullDateTime(item.probeAttemptedAt)}${
                  item.probeError ? `（失败：${item.probeError}）` : ""
                }`
              : " 尚未核查，下一轮定时同步会检查"
          }`}
        >
          {INTERACTION_STATE_LABEL[item.state]}
        </span>
      ) : null}

      {duration ? (
        <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-xs text-white tabular-nums">
          {duration}
        </span>
      ) : null}
    </div>
  );
};

/**
 * 一张卡 = 一条互动记录。排版与收藏页保持一致：
 * 封面（含类型角标）、标题固定两行高、页脚左作者右日期，中间不加分割线。
 * 类型由左侧的「点赞 / 投币」入口决定，正文区不再重复写类型文字。
 */
const InteractionCardView = ({
  item,
  now,
  managing,
  selected,
  onToggleSelect,
}: {
  item: InteractionItem;
  now: number;
  managing: boolean;
  selected: boolean;
  onToggleSelect: () => void;
}) => {
  const detail = buildInteractionDetail(item, now);
  const gone = item.state !== "listed";
  const renamed = Boolean(item.firstTitle) && item.firstTitle !== item.title;
  /** 稿件本身查不到了（被删/转私密）→ 标题加删除线；取消点赞不算 */
  const contentGone = isInteractionContentGone(item);

  const hoverTitle = [
    detail.title,
    gone ? INTERACTION_STATE_HINT[item.state] : "",
    // 核查诊断：`probeAttemptedAt` / `probeError` 一直写进了库却从没露出来，
    // 于是用户只看到「未判定」，分不清是"还没查"还是"查了但失败"。
    // 必须给出可自证的线索，否则这个状态就是个黑盒。
    gone
      ? item.probeAttemptedAt
        ? `上次核查：${formatFullDateTime(item.probeAttemptedAt)}${
            item.probeError ? `\n核查失败：${item.probeError}` : ""
          }`
        : "尚未核查（下一轮定时同步会检查）"
      : "",
    `BV ${item.bvid}`,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <article
      title={hoverTitle}
      className={`relative flex flex-col overflow-hidden rounded-lg border bg-white transition-shadow hover:shadow-md dark:bg-neutral-900 ${
        selected
          ? "border-pink-400 ring-2 ring-pink-400/40 dark:border-pink-500"
          : "border-gray-200 dark:border-neutral-800"
      }`}
    >
      <InteractionCover item={item} />

      {/* 管理模式下的勾选框。放在封面上方是因为卡片内容区已经很满 */}
      {managing ? (
        <button
          type="button"
          onClick={onToggleSelect}
          aria-pressed={selected}
          aria-label={selected ? "取消选中" : "选中这条记录"}
          className="absolute left-2 top-2 z-10 flex items-center gap-1 rounded-md bg-white/95 px-1.5 py-1 text-xs font-medium text-gray-700 shadow-sm backdrop-blur-sm dark:bg-neutral-900/95 dark:text-neutral-200"
        >
          {selected ? (
            <CheckSquare className="h-4 w-4 text-pink-600 dark:text-pink-400" />
          ) : (
            <Square className="h-4 w-4" />
          )}
          选中
        </button>
      ) : null}

      <div className="flex flex-1 flex-col p-3">
        {/* 稿件被删 / 转私密时标题加删除线 + 灰字，与收藏页对已失效收藏的处理一致。
            **「取消点赞」不加删除线**：稿件仍能正常打开，变的只是互动状态。
            **也不给整卡加透明度**：那会连封面和作者一起压暗，
            而「点赞过」「未判定」其实都是有效记录。 */}
        <h3
          className={`m-0 h-10 overflow-hidden text-sm leading-[1.4] line-clamp-2 ${
            contentGone
              ? "line-through text-gray-400 dark:text-neutral-500"
              : gone
                ? "text-gray-600 dark:text-neutral-400"
                : "text-gray-900 dark:text-neutral-100"
          }`}
          title={item.title}
        >
          <a
            href={interactionVideoUrl(item)}
            target="_blank"
            rel="noopener noreferrer"
            className="no-underline text-inherit hover:text-pink-600 dark:hover:text-pink-400"
          >
            {item.title || "（标题未知）"}
          </a>
        </h3>

        {/* 只在与首次记录不同时出现：说明这条稿件后来改过名 */}
        {renamed ? (
          <p
            className="mt-1 line-clamp-1 text-xs text-gray-400 dark:text-neutral-500"
            title={`首次记录到它时的标题：${item.firstTitle}`}
          >
            原名 {item.firstTitle}
          </p>
        ) : null}

        {/* 页脚：左作者 / 右日期。与收藏页同一套排版，中间不加分割线 */}
        <div className="mt-2 flex items-center justify-between text-xs text-gray-500 dark:text-neutral-400">
          <a
            href={interactionAuthorUrl(item)}
            target="_blank"
            rel="noopener noreferrer"
            className="mr-2 truncate transition-colors hover:text-pink-600 dark:hover:text-pink-400"
            title={item.authorName}
          >
            {item.authorName || `UP ${item.authorMid}`}
          </a>
          {detail.date ? (
            <span className="shrink-0 tabular-nums" title={detail.title}>
              {detail.date}
            </span>
          ) : null}
        </div>
      </div>
    </article>
  );
};

const Interactions = () => {
  const [items, setItems] = useState<InteractionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [type, setType] = useState<InteractionType>("like");
  const [state, setState] = useState<InteractionFilter>("all");
  const [keyword, setKeyword] = useState("");
  // 排序偏好刻意不持久化：这页的默认视角就是"最相关的那批排前面"，
  // 每次进来都从日期新→旧开始，避免上一次的时长排序把新记录压到看不见的地方。
  const [sort, setSort] = useState<InteractionSort>("date_desc");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [progress, setProgress] = useState<InteractionSyncProgress | null>(null);
  /** 管理/删除模式。互动记录是"纯记录"，用户要能自己清掉不要的条目 */
  const [managing, setManaging] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [deletePending, setDeletePending] = useState<InteractionItem[] | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, syncAt, storedProgress] = await Promise.all([
        getAllInteractions(),
        getStorageValue<number | null>(INTERACTIONS_LAST_SYNC, null),
        getStorageValue<InteractionSyncProgress | null>(INTERACTIONS_SYNC_PROGRESS, null),
      ]);
      setItems(list);
      setLastSyncAt(syncAt);
      setProgress(storedProgress);
    } catch (error) {
      console.error("读取互动记录失败:", error);
      toast.error("读取互动记录失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => buildInteractionStats(items), [items]);

  /** 相对时间只用于悬停说明，这里取一次"现在"即可 */
  const now = useMemo(() => Date.now(), [items]);

  const typeOptions = useMemo(
    () => [
      { value: "like" as const, label: INTERACTION_TYPE_LABEL.like, count: stats.like },
      { value: "coin" as const, label: INTERACTION_TYPE_LABEL.coin, count: stats.coin },
    ],
    [stats],
  );

  const stateCounts = useMemo(() => {
    const base = { items, type, keyword };
    return {
      all: queryInteractions(base).length,
      listed: queryInteractions({ ...base, state: "listed" }).length,
      gone: queryInteractions({ ...base, state: "gone" }).length,
    };
  }, [items, type, keyword]);

  const filtered = useMemo(
    () => queryInteractions({ items, keyword, type, state, sort }),
    [items, keyword, type, state, sort],
  );

  /**
   * 「未判定」的核查进度诊断。
   *
   * 这个状态最招人烦的地方是**不知道要等什么**：是还没轮到我，还是查了但一直失败？
   * 数据早就在库里（`probeAttemptedAt` / `probeError`），只是从来没露出来。
   * 这里把三类分开计数，并在页面上给一句能自证的说明。
   */
  const probeDiagnostics = useMemo(() => {
    const pending = filtered.filter((entry) => entry.state === "unlisted");
    return {
      pending: pending.length,
      neverProbed: pending.filter((entry) => !entry.probeAttemptedAt).length,
      failed: pending.filter((entry) => entry.probeAttemptedAt && entry.probeError).length,
      lastAttemptAt: pending.reduce<number | undefined>(
        (latest, entry) =>
          entry.probeAttemptedAt && (!latest || entry.probeAttemptedAt > latest)
            ? entry.probeAttemptedAt
            : latest,
        undefined,
      ),
    };
  }, [filtered]);

  const page = useMemo(
    () => paginateInteractions(filtered, currentPage, PAGE_SIZE),
    [filtered, currentPage],
  );

  /**
   * 删除选中的互动记录。
   *
   * 互动记录与消失档案不同：它是"纯记录"，B 站那边本来也会滚走，删掉不涉及留档损失。
   * 但有一个后果必须在确认框里说清：**仍在 B 站列表里的条目，下次同步会重新抓回来**，
   * 只有已经掉出窗口的才会真正消失——否则用户会以为删除失效了。
   */
  const handleDeleteConfirmed = async (targets: InteractionItem[]) => {
    if (targets.length === 0) return;
    setIsDeleting(true);
    try {
      await deleteInteractionItems(targets.map((entry) => entry.id));
      setItems((current) =>
        current.filter((entry) => !targets.some((target) => target.id === entry.id)),
      );
      toast.success(`已删除 ${targets.length} 条互动记录`);
      setSelected([]);
      setManaging(false);
      setDeletePending(null);
    } catch (error) {
      console.error("删除互动记录失败:", error);
      toast.error("删除失败");
    } finally {
      setIsDeleting(false);
    }
  };

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const response = await browser.runtime.sendMessage({ action: "syncInteractions" });
      if (!response?.success) {
        throw new Error(response?.error || "互动记录同步失败");
      }
      toast.success(response.message ?? "互动记录同步完成");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "互动记录同步失败");
    } finally {
      setSyncing(false);
    }
  }, [load]);

  const syncHealth = (() => {
    if (!progress) return "";
    if (progress.status === "auth_invalid") return "未登录 B 站，同步已停止";
    if (progress.status === "rate_limited") return "触发 B 站风控，将在下次重试";
    const authFailed = progress.types.find((item) => item.status === "auth_invalid");
    if (authFailed) return "未登录 B 站，同步已停止";
    const degraded = progress.types.find((item) => item.status === "failed");
    if (degraded) return "上次同步有请求失败，未做消失判定";
    return "";
  })();

  const activeFilterLabel =
    INTERACTION_FILTER_OPTIONS.find((option) => option.value === state)?.label ?? "全部记录";
  const sortLabel = SORTS.find((option) => option.value === sort)?.label ?? "";

  return (
    <div className="flex h-screen">
      {/* 左侧：类型切换放在这里（用户一开始没找到顶部的 tab，左侧才是本仓库的惯例位置） */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-gray-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 p-4 dark:border-neutral-800">
          <h2 className="flex min-w-0 items-center gap-2 text-lg font-bold text-gray-900 dark:text-neutral-100">
            <Heart className="h-5 w-5 shrink-0 text-pink-500" />
            <span className="truncate">互动记录</span>
          </h2>
          <button
            type="button"
            title="立即同步点赞与投币记录"
            aria-label="立即同步点赞与投币记录"
            onClick={handleSync}
            disabled={syncing}
            className="shrink-0 rounded-md p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-pink-500 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-pink-400"
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-2">
          {items.length === 0 ? (
            <div className="px-3 py-4 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
              <p>还没有任何记录。</p>
              <p className="mt-2">点上方或右上角的「立即同步」抓一次即可。</p>
            </div>
          ) : (
            <>
              <p className="px-3 pb-1 pt-2 text-xs font-medium text-gray-400 dark:text-neutral-500">
                类型
              </p>
              {typeOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => {
                    setType(option.value);
                    setCurrentPage(1);
                  }}
                  className={`mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                    type === option.value
                      ? "bg-pink-50 text-pink-600 dark:bg-pink-500/10 dark:text-pink-400"
                      : "text-gray-600 hover:bg-gray-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  }`}
                >
                  <span>{option.label}</span>
                  <span className="text-xs text-gray-400 dark:text-neutral-500">
                    {option.count}
                  </span>
                </button>
              ))}

              {/* 状态只给三档。内部判定有六个取值，但那是封面角标的事：
                  把六个状态平铺成筛选项，结果就是一屏的 0。 */}
              <p className="px-3 pb-1 pt-3 text-xs font-medium text-gray-400 dark:text-neutral-500">
                状态
              </p>
              {INTERACTION_FILTER_OPTIONS.map((option) => {
                const count =
                  option.value === "all"
                    ? stateCounts.all
                    : option.value === "listed"
                      ? stateCounts.listed
                      : stateCounts.gone;
                return (
                  <button
                    key={option.value}
                    type="button"
                    title={option.hint}
                    onClick={() => {
                      setState(option.value);
                      setCurrentPage(1);
                    }}
                    className={`mb-1 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                      state === option.value
                        ? "bg-pink-50 text-pink-600 dark:bg-pink-500/10 dark:text-pink-400"
                        : "text-gray-600 hover:bg-gray-100 dark:text-neutral-300 dark:hover:bg-neutral-800"
                    }`}
                  >
                    <span className="truncate">{option.label}</span>
                    <span className="shrink-0 text-xs text-gray-400 dark:text-neutral-500">
                      {count}
                    </span>
                  </button>
                );
              })}
            </>
          )}
        </nav>

        <div className="border-t border-gray-200 p-3 text-xs leading-relaxed text-gray-400 dark:border-neutral-800 dark:text-neutral-500">
          <p>
            {lastSyncAt ? `上次同步 ${formatDateTime(lastSyncAt)}` : "尚未同步过"}
            {progress?.trigger === "page" ? "（主页访问补抓）" : ""}
          </p>
          {syncHealth ? (
            <p className="mt-1 text-amber-500 dark:text-amber-400">{syncHealth}</p>
          ) : null}
        </div>
      </aside>

      {/* 主区域 */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1500px] px-6 py-5 lg:px-10">
          {/* 这个页面存在的理由，必须写清楚：不写用户不知道 B 站那边已经把数据删了 */}
          <div className="mb-5 flex items-start gap-3 rounded-xl border border-pink-100 bg-pink-50/60 p-4 text-xs leading-relaxed text-pink-700 dark:border-pink-500/20 dark:bg-pink-500/5 dark:text-pink-200">
            <Sparkles className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-medium">
                B 站只保留最近 20 条点赞与投币记录，超出的部分在 B 站上再也查不到。
              </p>
              <p className="mt-1 text-pink-600/90 dark:text-pink-200/80">
                本页是这些记录的本地永久副本。封面左上角的图标表示类型，右上角只在真出问题时才出现状态角标；
                掉出列表的条目不会被删除，判定不了就如实显示为「未判定」。
              </p>
              <p className="mt-1 text-pink-600/90 dark:text-pink-200/80">
                右下角是日期：投币用 B 站接口给的真实投币时间（接口偶尔不返回 time，
                那种情况只能退回本地首次记录时间）；点赞接口不返回点赞时间，所以首轮记录标「早期」，
                之后出现的显示本地首次记录日期。日期排序就用这一格，鼠标移到卡片上看完整说明。
              </p>
            </div>
          </div>

          <div className="mb-6 flex flex-col justify-between gap-4 rounded-xl border border-gray-100 bg-white p-4 shadow-sm md:flex-row md:items-center dark:border-neutral-800 dark:bg-neutral-900">
            <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900 dark:text-neutral-100">
              {INTERACTION_TYPE_LABEL[type]}
              <span className="whitespace-nowrap rounded-full border border-gray-100 bg-gray-50 px-2 py-1 text-sm font-normal text-gray-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400">
                {activeFilterLabel} {filtered.length} 个视频
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
                    setCurrentPage(1);
                  }}
                  placeholder="搜索标题、原名或 UP 主…"
                  className="min-w-0 flex-1 bg-transparent py-1.5 pl-2.5 pr-8 text-sm text-gray-700 placeholder-gray-400 focus:outline-none dark:text-neutral-100 dark:placeholder-neutral-500"
                />
                {keyword ? (
                  <button
                    type="button"
                    aria-label="清空搜索"
                    onClick={() => {
                      setKeyword("");
                      setCurrentPage(1);
                    }}
                    className="absolute inset-y-0 right-0 flex items-center pr-3 text-gray-400 hover:text-gray-600 dark:text-neutral-500 dark:hover:text-neutral-300"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>

              <div className="relative">
                <button
                  type="button"
                  onClick={() => setSortMenuOpen((open) => !open)}
                  className="flex items-center gap-1 rounded-full border border-gray-200 bg-gray-50 px-3.5 py-1.5 text-sm text-gray-600 transition-colors hover:text-pink-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-300"
                >
                  {sortLabel}
                  <ChevronDown className="h-3 w-3" />
                </button>
                {sortMenuOpen ? (
                  <>
                    <button
                      type="button"
                      aria-label="关闭排序菜单"
                      className="fixed inset-0 z-10 cursor-default"
                      onClick={() => setSortMenuOpen(false)}
                    />
                    <div className="absolute right-0 top-full z-20 mt-2 w-44 overflow-hidden rounded-lg border border-gray-100 bg-white py-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
                      {SORTS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          title={option.hint}
                          onClick={() => {
                            setSort(option.value);
                            setSortMenuOpen(false);
                            setCurrentPage(1);
                          }}
                          className={`w-full px-4 py-2 text-left text-sm transition-colors ${
                            sort === option.value
                              ? "bg-pink-50 font-medium text-pink-600 dark:bg-pink-500/10 dark:text-pink-400"
                              : "text-gray-600 hover:bg-gray-50 dark:text-neutral-300 dark:hover:bg-neutral-800"
                          }`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>

              {/* 管理入口放在「立即同步」旁边：侧边栏底部那个位置在长列表里
                  根本看不到，用户找不到删除功能。 */}
              <button
                type="button"
                onClick={() => {
                  setManaging((value) => !value);
                  setSelected([]);
                }}
                className={`rounded-full border px-4 py-1.5 text-sm transition-colors ${
                  managing
                    ? "border-pink-300 bg-pink-50 text-pink-600 dark:border-pink-500/40 dark:bg-pink-500/10 dark:text-pink-400"
                    : "border-gray-200 text-gray-600 hover:border-pink-300 hover:text-pink-500 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-pink-500/50 dark:hover:text-pink-400"
                }`}
              >
                {managing ? "退出管理" : "管理记录"}
              </button>

              <button
                type="button"
                onClick={handleSync}
                disabled={syncing}
                className="inline-flex items-center gap-1.5 rounded-full bg-pink-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-pink-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
                {syncing ? "同步中…" : "立即同步"}
              </button>
            </div>
          </div>

          {/* 「未判定」的核查进度。只在真的有未判定条目时出现——
              没有这一条时，用户看到「未判定」会以为功能卡死了 */}
          {probeDiagnostics.pending > 0 ? (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50/70 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
              有 <strong className="tabular-nums">{probeDiagnostics.pending}</strong> 条尚未判定：
              {probeDiagnostics.neverProbed > 0
                ? `${probeDiagnostics.neverProbed} 条还没核查过（下一轮定时同步会检查）`
                : ""}
              {probeDiagnostics.neverProbed > 0 && probeDiagnostics.failed > 0 ? "；" : ""}
              {probeDiagnostics.failed > 0
                ? `${probeDiagnostics.failed} 条上次核查失败（失败后 24 小时内会重试）`
                : ""}
              {probeDiagnostics.lastAttemptAt
                ? `。最近一次核查：${formatFullDateTime(probeDiagnostics.lastAttemptAt)}`
                : ""}
              。鼠标移到卡片上看单条的核查结果。
            </div>
          ) : null}

          {loading ? (
            <div className="py-20 text-center text-sm text-gray-400 dark:text-neutral-500">
              加载中…
            </div>
          ) : items.length === 0 ? (
            <div className="py-20 text-center text-sm text-gray-400 dark:text-neutral-500">
              <p>还没有互动记录。</p>
              <p className="mt-2">
                数据来源就是你个人主页上的「最近点赞的视频」与「最近投币的视频」两个模块，
                点上面的「立即同步」即可抓取；之后每次访问 B 站个人主页（半小时最多一次）
                也会自动补抓一把。
              </p>
              <p className="mt-2">B 站只保留最近 20 条，越早开始记录，能留住的越多。</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-20 text-center text-sm text-gray-400 dark:text-neutral-500">
              没有匹配的记录
            </div>
          ) : (
            <>
              {/* 与收藏页同一套网格：auto-fill + 240px 起，窗口够宽自然排出四列 */}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-6">
                {page.items.map((item) => (
                  <InteractionCardView
                    key={item.id}
                    item={item}
                    now={now}
                    managing={managing}
                    selected={selected.includes(item.id)}
                    onToggleSelect={() =>
                      setSelected((current) =>
                        current.includes(item.id)
                          ? current.filter((value) => value !== item.id)
                          : [...current, item.id],
                      )
                    }
                  />
                ))}
              </div>

              <div className="mt-8">
                <Pagination
                  currentPage={page.page}
                  totalItems={page.total}
                  pageSize={PAGE_SIZE}
                  onPageChange={(next) => {
                    setCurrentPage(next);
                    window.scrollTo({ top: 0, behavior: "smooth" });
                  }}
                />
              </div>
            </>
          )}
        </div>
      </main>

      {/* 管理模式的操作条吸附在底部 */}
      {managing ? (
        <div className="pointer-events-none fixed inset-x-0 bottom-6 z-30 flex justify-center px-6">
          <div className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-2.5 shadow-lg dark:border-neutral-700 dark:bg-neutral-900">
            <button
              type="button"
              onClick={() =>
                setSelected(
                  page.items.length > 0 && page.items.every((entry) => selected.includes(entry.id))
                    ? []
                    : page.items.map((entry) => entry.id),
                )
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:border-neutral-700 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              {page.items.length > 0 && page.items.every((entry) => selected.includes(entry.id)) ? (
                <CheckSquare className="h-4 w-4" />
              ) : (
                <Square className="h-4 w-4" />
              )}
              全选本页（{page.items.length}）
            </button>
            <p className="text-sm text-gray-600 dark:text-neutral-300">
              已选 <span className="font-semibold tabular-nums">{selected.length}</span> 条
            </p>
            <button
              type="button"
              onClick={() =>
                setDeletePending(items.filter((entry) => selected.includes(entry.id)))
              }
              disabled={selected.length === 0 || isDeleting}
              className="rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-red-500/30 dark:text-red-400 dark:hover:bg-red-500/10"
            >
              {isDeleting ? "删除中…" : "删除所选"}
            </button>
          </div>
        </div>
      ) : null}

      {/* 删除确认。必须说清"仍在列表里的条目会被下次同步抓回来"，
          否则用户会以为删除没生效 */}
      {deletePending ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !isDeleting) setDeletePending(null);
          }}
        >
          <div className="w-full max-w-md rounded-xl bg-white shadow-xl dark:bg-neutral-900">
            <div className="p-5">
              <h3 className="text-base font-bold text-gray-900 dark:text-neutral-100">
                确认删除这 {deletePending.length} 条互动记录？
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-gray-500 dark:text-neutral-400">
                互动记录是纯记录，删除后不会影响消失档案。
              </p>
              <p className="mt-2 rounded-lg bg-amber-50 p-2.5 text-xs leading-relaxed text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                注意：**仍在 B 站点赞/投币列表**里的条目，下次同步会重新抓回来；
                已经掉出列表（窗口外）的才会真正消失。所以删「取消点赞」这类窗口外的记录才会彻底清掉。
              </p>
              <ul className="mt-3 max-h-40 space-y-1 overflow-y-auto rounded-lg bg-gray-50 p-2 text-xs dark:bg-neutral-800/60">
                {deletePending.slice(0, 8).map((entry) => (
                  <li key={entry.id} className="truncate text-gray-700 dark:text-neutral-200">
                    <span className="mr-1.5 rounded bg-white px-1.5 py-0.5 text-gray-500 dark:bg-neutral-800 dark:text-neutral-400">
                      {entry.type === "like" ? "点赞" : "投币"}
                    </span>
                    {entry.title || entry.bvid}
                  </li>
                ))}
                {deletePending.length > 8 ? (
                  <li className="pt-1 text-gray-400 dark:text-neutral-500">
                    还有 {deletePending.length - 8} 条…
                  </li>
                ) : null}
              </ul>
            </div>
            <div className="flex justify-end gap-2 border-t border-gray-100 p-4 dark:border-neutral-800">
              <button
                type="button"
                onClick={() => setDeletePending(null)}
                disabled={isDeleting}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void handleDeleteConfirmed(deletePending)}
                disabled={isDeleting}
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
              >
                {isDeleting ? "删除中…" : `确认删除 ${deletePending.length} 条`}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

export default Interactions;
