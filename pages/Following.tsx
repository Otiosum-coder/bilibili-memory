import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { BadgeCheck, ChevronDown, RefreshCw, Search, Users, X } from "lucide-react";
import { Pagination } from "../components/Pagination";
import { NameHistoryPopover } from "../components/NameHistoryPopover";
import { createAssetObjectUrl } from "../utils/assetArchive";
import { FOLLOWING_LAST_SYNC, FOLLOWING_SYNC_PROGRESS } from "../utils/constants";
import { getAllFollowing } from "../utils/db";
import { applyArchiveNames, loadNameArchive, NAME_ARCHIVE_ENABLED } from "../utils/nameArchive";
import {
  FOLLOWING_STATUS_LABEL,
  buildFollowingStats,
  buildLocalNameTimeline,
  buildThirdPartyNames,
  followTimeOf,
  hasFormerNames,
  isDeemphasized,
  paginateFollowing,
  queryFollowing,
  resolveDisplayName,
  statusChangedAt,
  type FollowingFilter,
  type FollowingSort,
} from "../utils/followingQuery";
import { getStorageValue } from "../utils/storage";
import type { FollowingItem } from "../utils/types";
import type { FollowingSyncProgress } from "../utils/followingSync";

const PAGE_SIZE = 48;

/** UP 主没写简介时的占位文案。固定文案 + 固定两行高度，保证所有卡片的行位对齐 */
const DEFAULT_SIGN = "这个人很神秘，什么都没有写";

const SORTS: Array<{ value: FollowingSort; label: string }> = [
  { value: "followed_desc", label: "最近关注" },
  { value: "followed_asc", label: "最早关注" },
  { value: "name_asc", label: "按昵称" },
  { value: "uid_desc", label: "UID 大→小" },
  { value: "uid_asc", label: "UID 小→大" },
];

/** 关注时间精确到秒，与 B 站官方关注页一致 */
const formatDateTime = (timestamp?: number): string => {
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const formatDate = (timestamp?: number): string =>
  timestamp ? new Date(timestamp).toLocaleDateString() : "";

const statusBadgeClass = (status: FollowingItem["status"]): string => {
  if (status === "gone") {
    return "bg-gray-100 text-gray-500 dark:bg-neutral-800 dark:text-neutral-400";
  }
  if (status === "unfollowed") {
    return "bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400";
  }
  return "bg-green-50 text-green-600 dark:bg-green-500/10 dark:text-green-400";
};

/**
 * 头像：优先用本地归档的字节，其次回退原始 URL，最后回退占位图。
 * UP 主注销后 B 站会把头像换成 noface.jpg，届时归档的字节仍然可用。
 */
const FollowingAvatar = ({ item, size = 64 }: { item: FollowingItem; size?: number }) => {
  const [assetUrl, setAssetUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let created: string | null = null;

    if (item.avatarAssetId) {
      createAssetObjectUrl(item.avatarAssetId)
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
  }, [item.avatarAssetId]);

  const fallback = item.face ? item.face.replace(/^http:/, "https:") : "/noface.jpg";

  return (
    /* 悬停放大：外层 div 保持原始尺寸，所以卡片排版不会跳动；
       放大只发生在这个 div 内部的 img 上（transform 不参与布局）。
       z-index 只在悬停时抬起，否则放大后的头像会被相邻卡片盖住。 */
    <div className="group/avatar relative shrink-0" style={{ width: size, height: size }}>
      <img
        src={assetUrl ?? fallback}
        alt=""
        loading="lazy"
        style={{ width: size, height: size }}
        className={`relative z-0 block rounded-full object-cover transition-transform duration-200 ease-out group-hover/avatar:z-20 group-hover/avatar:scale-150 group-hover/avatar:shadow-lg group-hover/avatar:ring-2 group-hover/avatar:ring-pink-300 motion-reduce:transition-none dark:group-hover/avatar:ring-pink-500/60 ${
          isDeemphasized(item) ? "grayscale" : ""
        }`}
        onError={(event) => {
          const image = event.currentTarget;
          if (!image.src.endsWith("noface.jpg")) image.src = "/noface.jpg";
        }}
      />
    </div>
  );
};

// `NameHistoryPopover`（曾用名徽章 + 点击展开浮层）已抽到
// components/NameHistoryPopover.tsx —— 消失档案页也用同一份，
// 避免同一份 nameHistory 在两个页面出现两种交互。

const FollowingCard = ({ item }: { item: FollowingItem }) => {
  const displayName = resolveDisplayName(item);
  const spaceUrl = `https://space.bilibili.com/${item.mid}`;
  const disabled = item.status === "gone";
  const changedAt = statusChangedAt(item);

  /**
   * 复制 UID。
   *
   * UID 是账号唯一且**不会变**的标识：昵称会改、账号会注销，而 mid 永远指向同一个人。
   * 所以它既显示出来，也允许一键复制，方便外部核对与检索。
   */
  const handleCopyUid = async () => {
    try {
      await navigator.clipboard.writeText(String(item.mid));
      toast.success(`已复制 UID ${item.mid}`);
    } catch (error) {
      console.error("复制 UID 失败:", error);
      toast.error("复制失败，请检查剪贴板权限");
    }
  };

  const nameNode = disabled ? (
    <span className="truncate text-sm font-medium text-gray-700 dark:text-neutral-200">
      {displayName}
    </span>
  ) : (
    <a
      href={spaceUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="truncate text-sm font-medium text-gray-900 hover:text-pink-600 dark:text-neutral-100 dark:hover:text-pink-400"
      title={`打开 ${displayName} 的 B 站空间`}
    >
      {displayName}
    </a>
  );

  return (
    <article
      className={`flex gap-4 rounded-lg border border-gray-200 bg-white p-4 transition-shadow dark:border-neutral-800 dark:bg-neutral-900 ${
        isDeemphasized(item) ? "opacity-60" : "hover:shadow-md"
      }`}
    >
      {/* 头像列：头像 + 下面的「复制 UID」按钮。
          按钮放在这里而不是文本列，是因为文本列只有约 240px，而 UID 位数不固定
          （8～16 位），塞进去不是把徽章挤走就是换行；头像列宽 64px 且本来就短，
          放这里既不占正文空间，也不会把卡片撑高。 */}
      <div className="flex w-16 shrink-0 flex-col items-center gap-2">
        <FollowingAvatar item={item} />
        <button
          type="button"
          onClick={() => void handleCopyUid()}
          title={`复制 UID ${item.mid}`}
          aria-label={`复制 UID ${item.mid}`}
          className="inline-flex w-full items-center justify-center rounded-md border border-gray-200 px-1 py-0.5 text-[10px] leading-4 whitespace-nowrap text-gray-500 transition-colors hover:border-pink-300 hover:text-pink-500 dark:border-neutral-700 dark:text-neutral-400 dark:hover:border-pink-500/50 dark:hover:text-pink-400"
        >
          复制 UID
        </button>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {nameNode}
          <span className={`rounded-full px-2 py-0.5 text-xs ${statusBadgeClass(item.status)}`}>
            {FOLLOWING_STATUS_LABEL[item.status]}
          </span>
          {item.attribute === 6 ? (
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-600 dark:bg-blue-500/10 dark:text-blue-400">
              互关
            </span>
          ) : null}
          {item.special === 1 ? (
            <span className="rounded-full bg-pink-50 px-2 py-0.5 text-xs text-pink-600 dark:bg-pink-500/10 dark:text-pink-400">
              特别关注
            </span>
          ) : null}
          {/* 认证头衔只用一个小图标表示，完整文字放悬停提示。
              试过独立文本行、也试过文字徽章，都不行：头衔长度不可控，
              要么留出空行、要么被挤到第二行，两种排版都比它传达的信息更碍眼。
              图标固定 14px，永远不会换行。 */}
          {item.officialVerifyDesc ? (
            <span className="shrink-0 leading-none" title={item.officialVerifyDesc}>
              <BadgeCheck className="h-3.5 w-3.5 text-blue-500" aria-hidden="true" />
            </span>
          ) : null}
          {/* 曾用名徽章放昵称行：它讲的是"名字"，跟昵称是一件事。
              曾经它在卡片底部单独占一行，那是第 4 行孤岛，下面还会留一截空白。
              数量型文案保证行高恒定，具体名字在点击后的浮层里。 */}
          <NameHistoryPopover item={item} />
        </div>

        {/* 简介：没有简介时用默认文案，保证每张卡片都有这一行内容。
            但**不固定行数高度**——固定两行会给单行简介留出一行空白。 */}
        <p
          className={`mt-1.5 line-clamp-2 text-xs leading-5 ${
            item.sign
              ? "text-gray-500 dark:text-neutral-400"
              : "text-gray-300 dark:text-neutral-600"
          }`}
          title={item.sign || undefined}
        >
          {item.sign || DEFAULT_SIGN}
        </p>

        <p className="mt-1.5 text-xs text-gray-400 dark:text-neutral-500">
          {changedAt
            ? `${formatDateTime(changedAt)} ${item.status === "gone" ? "检测到注销" : "检测到取关"}`
            : `你关注 Ta 的时间: ${formatDateTime(followTimeOf(item))}`}
        </p>
      </div>
    </article>
  );
};

export const Following = () => {
  const [items, setItems] = useState<FollowingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState("");
  const [filter, setFilter] = useState<FollowingFilter>("all");
  const [sort, setSort] = useState<FollowingSort>("followed_desc");
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [syncing, setSyncing] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [progress, setProgress] = useState<FollowingSyncProgress | null>(null);
  /**
   * 本地曾用名存档（只有本地构建会加载）。导入后：
   * - 卡片上的「曾用名 N」徽章与浮层的「第三方存档」区块自动出现；
   * - 搜索框按旧名也能搜到人（queryFollowing 本来就匹配 thirdPartyNames）。
   */
  const [archiveEntries, setArchiveEntries] = useState<Map<number, string[]> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [list, savedLastSync, savedProgress] = await Promise.all([
        getAllFollowing(),
        getStorageValue<number | null>(FOLLOWING_LAST_SYNC, null),
        getStorageValue<FollowingSyncProgress | null>(FOLLOWING_SYNC_PROGRESS, null),
      ]);
      setItems(list);
      setLastSyncAt(savedLastSync);
      setProgress(savedProgress);
    } catch (error) {
      console.error("加载关注列表失败:", error);
      toast.error("加载关注列表失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!NAME_ARCHIVE_ENABLED) return;
    let cancelled = false;
    void loadNameArchive()
      .then((archive) => {
        if (!cancelled) setArchiveEntries(archive?.entries ?? null);
      })
      .catch((error) => {
        console.warn("加载曾用名存档失败:", error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * 把存档名字叠加到渲染用的数据上。没有存档时直接用原数组，
   * 避免对上千条记录做无意义的复制。
   */
  const displayItems = useMemo(
    () =>
      archiveEntries
        ? items.map((item) => applyArchiveNames(item, archiveEntries.get(item.mid)))
        : items,
    [items, archiveEntries],
  );

  const stats = useMemo(() => buildFollowingStats(displayItems), [displayItems]);

  const filterOptions = useMemo(
    () => [
      { value: "all" as FollowingFilter, label: "全部关注", count: stats.total },
      { value: "following" as FollowingFilter, label: "仍关注", count: stats.following },
      { value: "unfollowed" as FollowingFilter, label: "已取关", count: stats.unfollowed },
      { value: "gone" as FollowingFilter, label: "已注销", count: stats.gone },
    ],
    [stats],
  );

  const filtered = useMemo(
    () => queryFollowing({ items: displayItems, keyword, filter, sort }),
    [displayItems, keyword, filter, sort],
  );

  const page = useMemo(
    () => paginateFollowing(filtered, currentPage, PAGE_SIZE),
    [filtered, currentPage],
  );

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const response = await browser.runtime.sendMessage({ action: "syncFollowing" });
      if (!response?.success) {
        throw new Error(response?.error || "关注同步失败");
      }
      toast.success(response.message ?? "关注同步完成");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "关注同步失败");
    } finally {
      setSyncing(false);
    }
  }, [load]);

  const syncHealth = (() => {
    if (!progress) return "尚未同步过";
    if (progress.status === "auth_invalid") return "未登录 B 站，同步已停止";
    if (progress.status === "rate_limited") return "触发 B 站风控，将在下次重试";
    if (!progress.fullScanCompleted) return "上次同步不完整，已跳过取关判定";
    return "";
  })();

  const sortLabel = SORTS.find((option) => option.value === sort)?.label ?? "";
  const activeFilterLabel =
    filterOptions.find((option) => option.value === filter)?.label ?? "全部关注";

  return (
    <div className="flex h-screen">
      {/* 左侧筛选面板 */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-gray-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 p-4 dark:border-neutral-800">
          <h2 className="flex min-w-0 items-center gap-2 text-lg font-bold text-gray-900 dark:text-neutral-100">
            <Users className="h-5 w-5 shrink-0 text-pink-500" />
            <span className="truncate">关注列表</span>
          </h2>
          <button
            type="button"
            title="立即同步关注列表"
            aria-label="立即同步关注列表"
            onClick={handleSync}
            disabled={syncing}
            className="shrink-0 rounded-md p-2 text-gray-500 transition-colors hover:bg-gray-100 hover:text-pink-500 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-pink-400"
          >
            <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-2">
          {filterOptions.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => {
                setFilter(option.value);
                setCurrentPage(1);
              }}
              className={`mb-1 w-full rounded-lg p-3 text-left transition-colors ${
                filter === option.value
                  ? "bg-pink-50 text-pink-600 dark:bg-pink-500/10 dark:text-pink-400"
                  : "hover:bg-gray-100 dark:hover:bg-neutral-800"
              }`}
            >
              <div className="truncate font-medium">{option.label}</div>
              <div className="mt-1 text-xs text-gray-400 dark:text-neutral-500">
                {option.count} 位 UP 主
              </div>
            </button>
          ))}
        </nav>

        <div className="border-t border-gray-200 p-3 text-xs leading-relaxed text-gray-400 dark:border-neutral-800 dark:text-neutral-500">
          <p>{lastSyncAt ? `上次同步 ${formatDate(lastSyncAt)}` : "尚未同步过"}</p>
          {syncHealth ? <p className="mt-1 text-amber-500 dark:text-amber-400">{syncHealth}</p> : null}
        </div>
      </aside>

      {/* 主区域 */}
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1500px] px-6 py-5 lg:px-10">
          <div className="mb-6 flex flex-col justify-between gap-4 rounded-xl border border-gray-100 bg-white p-4 shadow-sm md:flex-row md:items-center dark:border-neutral-800 dark:bg-neutral-900">
            <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900 dark:text-neutral-100">
              {activeFilterLabel}
              <span className="whitespace-nowrap rounded-full border border-gray-100 bg-gray-50 px-2 py-1 text-sm font-normal text-gray-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400">
                {filtered.length}
              </span>
            </h1>

            <div className="flex flex-wrap items-center gap-3">
              {/* w-64 放不下占位文案「搜索昵称、UID、签名或曾用名…」，会被截断成「…签名或曾用」。
                  加宽到 w-80（320px）后完整显示，同时用 max-w-full 防止窄窗口溢出。 */}
              <div className="relative flex w-80 max-w-full items-center rounded-full border border-gray-200 bg-gray-50 transition-all focus-within:border-pink-400 focus-within:bg-white dark:border-neutral-700 dark:bg-neutral-800 dark:focus-within:bg-neutral-800">
                <Search className="ml-3.5 h-4 w-4 shrink-0 text-gray-400 dark:text-neutral-500" />
                <input
                  type="text"
                  value={keyword}
                  onChange={(event) => {
                    setKeyword(event.target.value);
                    setCurrentPage(1);
                  }}
                  placeholder="搜索昵称、UID、签名或曾用名…"
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
                    <div className="absolute right-0 top-full z-20 mt-2 w-40 overflow-hidden rounded-lg border border-gray-100 bg-white py-1 shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
                      {SORTS.map((option) => (
                        <button
                          key={option.value}
                          type="button"
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

          {loading ? (
            <div className="py-20 text-center text-sm text-gray-400 dark:text-neutral-500">
              加载中…
            </div>
          ) : items.length === 0 ? (
            <div className="py-20 text-center text-sm text-gray-400 dark:text-neutral-500">
              <p>还没有关注数据。</p>
              <p className="mt-2">
                点上面的「立即同步」抓取一次。首次同步会建立基线，从第二次开始才会产生变动记录。
              </p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-20 text-center text-sm text-gray-400 dark:text-neutral-500">
              没有匹配的记录
            </div>
          ) : (
            <>
              {/* items-start：不让网格把卡片拉到同一行最高那张的高度。
                  否则简介只有一行、又没有「曾用名」的卡片会被拉伸，
                  多出来的高度全堆在底部，看起来就是"底下留白太多"。 */}
              <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] items-start gap-6">
                {page.items.map((item) => (
                  <FollowingCard key={item.mid} item={item} />
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
    </div>
  );
};

export default Following;
