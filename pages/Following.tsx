import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import toast from "react-hot-toast";
import { BadgeCheck, ChevronDown, RefreshCw, Search, Users, Wand2, X } from "lucide-react";
import { Pagination } from "../components/Pagination";
import { NameHistoryPopover } from "../components/NameHistoryPopover";
import { createAssetObjectUrl } from "../utils/assetArchive";
import {
  DEFAULT_THIRD_PARTY_NAME_LOOKUP_ENABLED,
  FOLLOWING_LAST_SYNC,
  FOLLOWING_SYNC_PROGRESS,
  THIRD_PARTY_NAME_LOOKUP_ENABLED,
  THIRD_PARTY_NAME_LOOKUP_PROGRESS,
  THIRD_PARTY_NAME_LOOKUP_PROMPTED,
} from "../utils/constants";
import { getAllFollowing, patchFollowingItems } from "../utils/db";
import {
  fetchThirdPartyFormerNames,
  isSuspiciousFormerNameTarget,
  THIRD_PARTY_LOOKUP_BATCH_LIMIT,
  THIRD_PARTY_LOOKUP_INTERVAL_MS,
  THIRD_PARTY_LOOKUP_STALE_MS,
  type FormerNameLookupProgress,
} from "../utils/thirdPartyNameLookup";
import {
  FOLLOWING_STATUS_LABEL,
  buildFollowingStats,
  followTimeOf,
  paginateFollowing,
  queryFollowing,
  resolveDisplayNameInfo,
  statusChangedAt,
  type FollowingFilter,
  type FollowingSort,
} from "../utils/followingQuery";
import { getStorageValue, setStorageValue } from "../utils/storage";
import type { FollowingItem } from "../utils/types";
import type { FollowingSyncProgress } from "../utils/followingSync";

const PAGE_SIZE = 48;

/** 后台任务是否已经失联：`running` 但超过阈值没有心跳（Service Worker 被休眠） */
const isStaleLookupProgress = (progress: FormerNameLookupProgress | null): boolean =>
  !!progress &&
  progress.status === "running" &&
  Date.now() - (progress.updatedAt ?? progress.startedAt) > THIRD_PARTY_LOOKUP_STALE_MS;

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
        className="relative z-0 block rounded-full object-cover transition-transform duration-200 ease-out group-hover/avatar:z-20 group-hover/avatar:scale-150 group-hover/avatar:shadow-lg group-hover/avatar:ring-2 group-hover/avatar:ring-pink-300 motion-reduce:transition-none dark:group-hover/avatar:ring-pink-500/60"
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

const FollowingCard = ({
  item,
  lookupEnabled,
  lookupBusy,
  onLookupFormerName,
  onSelectFormerName,
}: {
  item: FollowingItem;
  lookupEnabled: boolean;
  lookupBusy: boolean;
  onLookupFormerName: (item: FollowingItem) => void;
  onSelectFormerName: (item: FollowingItem, index: number) => void;
}) => {
  const displayInfo = resolveDisplayNameInfo(item);
  const displayName = displayInfo.name;
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
      className={`flex gap-4 rounded-lg border border-gray-200 bg-white p-4 transition-shadow hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900 ${
        item.status === "following" ? "" : "opacity-60"
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
          <NameHistoryPopover
            item={item}
            selectedFormerNameIndex={
              displayInfo.inferred ? displayInfo.candidateIndex : undefined
            }
            onSelectFormerName={
              item.status === "gone" ? (index) => onSelectFormerName(item, index) : undefined
            }
          />
          {/*
            名字来自第三方存档时明确标出来，且放在昵称行最后，避免挤在名字和状态之间。
            aicu 的 hname 没有时间戳、顺序不保证，这只是"最可能的注销前名字"。
          */}
          {displayInfo.inferred ? (
            <span
              className="shrink-0 rounded-full bg-gray-50 px-2 py-0.5 text-[11px] leading-4 text-gray-400 dark:bg-neutral-800/60 dark:text-neutral-500"
              title="来自第三方存档（aicu.cc），无时间信息、顺序不保证，可能是曾用名之一"
            >
              第三方存档
            </span>
          ) : null}
          {/*
            按需查询入口只给「可疑账号」：已注销 / 名字未知 / 占位文案。
            普通关注的查询走页面顶部的批量按钮，不在每张卡片上堆按钮。
          */}
          {lookupEnabled && isSuspiciousFormerNameTarget(item) && !item.thirdPartyQueriedAt && (item.thirdPartyNames?.length ?? 0) === 0 ? (
            <button
              type="button"
              disabled={lookupBusy}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onLookupFormerName(item);
              }}
              title="把该 UID 发送到第三方站点 aicu.cc 查询曾用名"
              className="shrink-0 rounded-full border border-dashed border-gray-300 px-1.5 py-0.5 text-[11px] leading-4 text-gray-500 transition-colors hover:border-pink-300 hover:text-pink-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-600 dark:text-neutral-400 dark:hover:border-pink-500/50 dark:hover:text-pink-400"
            >
              {lookupBusy ? "查询中…" : "查曾用名"}
            </button>
          ) : null}
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
  /** 第三方曾用名查询（aicu.cc）：开关来自设置页，默认关闭 */
  const [lookupEnabled, setLookupEnabled] = useState(DEFAULT_THIRD_PARTY_NAME_LOOKUP_ENABLED);
  /** 首次同步后的批量提示是否已经关掉 */
  const [lookupPrompted, setLookupPrompted] = useState(true);
  const [lookupRunning, setLookupRunning] = useState(false);
  const [lookupProgress, setLookupProgress] = useState<FormerNameLookupProgress | null>(null);
  /** 卡片级单查的 loading：同一时间只允许点一个 */
  const [lookupBusyMid, setLookupBusyMid] = useState<number | null>(null);
  /** 本页发起的批量任务：由 sendMessage 的返回负责收尾，轮询不重复弹 toast */
  const lookupStartedHereRef = useRef(false);
  /** 本页发起查询的时间点：轮询据此忽略上一轮遗留的旧进度 */
  const lookupStartRef = useRef(0);

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

  // 读取第三方查询的开关 / 首次提示状态 / 上次进度
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [enabled, prompted, storedProgress] = await Promise.all([
        getStorageValue(THIRD_PARTY_NAME_LOOKUP_ENABLED, DEFAULT_THIRD_PARTY_NAME_LOOKUP_ENABLED),
        getStorageValue(THIRD_PARTY_NAME_LOOKUP_PROMPTED, false),
        getStorageValue<FormerNameLookupProgress | null>(THIRD_PARTY_NAME_LOOKUP_PROGRESS, null),
      ]);

      if (cancelled) return;
      setLookupEnabled(Boolean(enabled));
      setLookupPrompted(Boolean(prompted));
      if (storedProgress?.status === "running") {
        if (isStaleLookupProgress(storedProgress)) {
          // 后台 Service Worker 可能已经被浏览器休眠：任务没了，进度还停在 running。
          // 直接把残留进度收尾，否则页面会永远显示「查询中」。
          const now = Date.now();
          await setStorageValue(THIRD_PARTY_NAME_LOOKUP_PROGRESS, {
            ...storedProgress,
            status: "failed",
            completedAt: now,
            updatedAt: now,
            message: "后台任务已中断（浏览器可能休眠了扩展）",
          }).catch(() => undefined);
          if (!cancelled) {
            toast("上次曾用名查询已中断，已查完的结果已保留，可重新开始");
          }
        } else {
          // storage 里的 running 可能是上一轮遗留的僵尸记录：先问后台任务是否真实存在
          let actuallyRunning = false;
          try {
            const state = await browser.runtime.sendMessage({ action: "getFormerNameTaskState" });
            actuallyRunning = Boolean(state?.running);
          } catch {
            actuallyRunning = false;
          }
          if (actuallyRunning) {
            setLookupRunning(true);
            setLookupProgress(storedProgress);
          } else {
            const now = Date.now();
            await setStorageValue(THIRD_PARTY_NAME_LOOKUP_PROGRESS, {
              ...storedProgress,
              status: "failed",
              completedAt: now,
              updatedAt: now,
              message: "上次查询已中断（后台任务已不存在）",
            }).catch(() => undefined);
          }
        }
      }
    })().catch((error) => console.warn("读取曾用名查询配置失败:", error));
    return () => {
      cancelled = true;
    };
  }, []);

  // 批量查询期间轮询进度；不是本页发起的任务（例如刷新页面回来）由这里收尾
  useEffect(() => {
    if (!lookupRunning) return;
    let active = true;
    const tick = async () => {
      const stored = await getStorageValue<FormerNameLookupProgress | null>(
        THIRD_PARTY_NAME_LOOKUP_PROGRESS,
        null,
      );
      if (!active || !stored) return;
      // 本页刚发起：忽略上一轮遗留的旧进度，否则点击瞬间就会被判"已完成"、
      // 进度条一闪而过（表现就是"点击没反应、刷新后才看到进度"）。
      if (
        lookupStartedHereRef.current &&
        typeof stored.startedAt === "number" &&
        stored.startedAt < lookupStartRef.current - 1000
      ) {
        return;
      }
      setLookupProgress(stored);
      if (stored.status === "running") {
        if (isStaleLookupProgress(stored)) {
          active = false;
          const now = Date.now();
          await setStorageValue(THIRD_PARTY_NAME_LOOKUP_PROGRESS, {
            ...stored,
            status: "failed",
            completedAt: now,
            updatedAt: now,
            message: "后台任务已中断（浏览器可能休眠了扩展）",
          }).catch(() => undefined);
          setLookupRunning(false);
          await load();
          if (!lookupStartedHereRef.current) {
            toast.error("曾用名查询已中断；已查完的结果已保留，可重新开始");
          }
        }
        return;
      }
      active = false;
      setLookupRunning(false);
      await load();
      if (lookupStartedHereRef.current) return; // 本页发起的任务由 sendMessage 返回收尾
      if (stored.status === "completed") {
        toast.success(`曾用名查询完成：${stored.done} 人，${stored.found} 人有曾用名`);
      } else if (stored.status === "cancelled") {
        toast("已停止曾用名查询");
      } else if (stored.status === "failed") {
        toast.error(`曾用名查询中断：${stored.message ?? "接口异常"}`);
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [lookupRunning, load]);

  const stats = useMemo(() => buildFollowingStats(items), [items]);

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
    () => queryFollowing({ items, keyword, filter, sort }),
    [items, keyword, filter, sort],
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

  /**
   * 批量查询只针对「当前列表」：左侧筛选 + 搜索关键词之后的结果，
   * 而不是全部关注。这样用户只想查「已注销」时不会把 1000+ 个关注都打一遍第三方接口。
   */
  const pendingLookupMids = useMemo(
    () => filtered.filter((item) => !item.thirdPartyQueriedAt).map((item) => item.mid),
    [filtered],
  );
  const pendingLookupCount = pendingLookupMids.length;

  const dismissLookupPrompt = useCallback(() => {
    setLookupPrompted(true);
    void setStorageValue(THIRD_PARTY_NAME_LOOKUP_PROMPTED, true).catch(() => undefined);
  }, []);

  /** 批量查询：交给后台跑（单飞、限速、可中断），页面只负责进度和收尾 */
  const startLookupBatch = useCallback(async () => {
    // 点按钮至少要有反馈：早期版本这里直接 return，用户会以为"点了没反应"
    if (lookupRunning) {
      toast("查询正在进行中，请稍候");
      return;
    }
    // 关注同步会整体重写 following 记录，和批量查询并发可能互相覆盖，先避开
    if (syncing) {
      toast("关注列表正在同步，请同步完成后再查询");
      return;
    }
    if (pendingLookupCount === 0) {
      toast("当前列表没有待查询的账号");
      return;
    }
    lookupStartRef.current = Date.now();
    dismissLookupPrompt();
    lookupStartedHereRef.current = true;
    setLookupRunning(true);
    // 立即给一份"启动中"的进度：第一次点击后、后台还没回写 storage 时，
    // 进度面板也要马上出现，而不是看起来像没反应。
    setLookupProgress({
      status: "running",
      total: Math.min(pendingLookupCount, THIRD_PARTY_LOOKUP_BATCH_LIMIT),
      done: 0,
      found: 0,
      failed: 0,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    });
    let attachedToRunningTask = false;
    try {
      const response = await browser.runtime.sendMessage({
        action: "lookupFormerNames",
        mids: pendingLookupMids,
      });
      if (!response?.success) throw new Error(response?.error || "曾用名查询失败");
      toast.success(response.message ?? "曾用名查询完成");
      await load();
    } catch (error) {
      const message = error instanceof Error ? error.message : "曾用名查询失败";
      // 后台已经有任务在跑（页面刷新/重开过）：附加上去，而不是把进度藏起来。
      // 之前的 bug 就是这里直接报错 + finally 关掉 running，用户既看不到进度、也点不动。
      const stored = await getStorageValue<FormerNameLookupProgress | null>(
        THIRD_PARTY_NAME_LOOKUP_PROGRESS,
        null,
      );
      if (stored?.status === "running" && !isStaleLookupProgress(stored)) {
        let actuallyRunning = false;
        try {
          const state = await browser.runtime.sendMessage({ action: "getFormerNameTaskState" });
          actuallyRunning = Boolean(state?.running);
        } catch {
          actuallyRunning = false;
        }
        if (actuallyRunning) {
          lookupStartRef.current = 0;
          setLookupProgress(stored);
          lookupStartedHereRef.current = false;
          attachedToRunningTask = true;
          toast("查询已在后台进行，已显示进度");
          return;
        }
        // 僵尸进度：后台根本没有任务，清掉它，别让页面永远挂着「查询中」
        await setStorageValue(THIRD_PARTY_NAME_LOOKUP_PROGRESS, {
          ...stored,
          status: "failed",
          completedAt: Date.now(),
          updatedAt: Date.now(),
          message: "上次查询已中断（后台任务已不存在）",
        }).catch(() => undefined);
        toast("上次查询已中断，进度已重置，可重新开始");
        return;
      }
      toast.error(message);
    } finally {
      // 附加模式保持 running，让轮询继续收尾；本页发起的任务才在结束时关掉
      if (!attachedToRunningTask) {
        lookupStartedHereRef.current = false;
        setLookupRunning(false);
      }
    }
  }, [dismissLookupPrompt, load, lookupRunning, pendingLookupCount, pendingLookupMids, syncing]);

  const cancelLookupBatch = useCallback(async () => {
    try {
      await browser.runtime.sendMessage({ action: "cancelFormerNames" });
      toast("正在停止查询…");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "停止查询失败");
    }
  }, []);

  /** 卡片上的单查：只查这一个人，结果直接写进 following 记录 */
  const handleLookupFormerName = useCallback(
    async (item: FollowingItem) => {
      if (lookupBusyMid !== null) return;
      setLookupBusyMid(item.mid);
      try {
        const result = await fetchThirdPartyFormerNames(item.mid);
        if (!result.ok) throw new Error(result.message ?? "查询失败");
        const queriedAt = Date.now();
        await patchFollowingItems([item.mid], {
          thirdPartyNames: result.names,
          thirdPartyQueriedAt: queriedAt,
        });
        setItems((previous) =>
          previous.map((current) =>
            current.mid === item.mid
              ? { ...current, thirdPartyNames: result.names, thirdPartyQueriedAt: queriedAt }
              : current,
          ),
        );
        if (result.names.length > 0) {
          toast.success(`查到 ${result.names.length} 个曾用名`);
        } else {
          toast("aicu 未收录该用户的曾用名");
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "查询曾用名失败");
      } finally {
        setLookupBusyMid(null);
      }
    },
    [lookupBusyMid],
  );

  /**
   * 在浮层里点选某个第三方名字，作为卡片上显示的名字。
   * 只有「已注销」账号会传这个回调（名字不会再变）；选择写进 `formerNameDisplayIndex`，
   * 不影响存档数据本身，同步时也会保留。
   */
  const handleSelectFormerName = useCallback(
    async (item: FollowingItem, index: number) => {
      const info = resolveDisplayNameInfo(item);
      if (!info.inferred || index < 0 || index >= info.candidateCount) return;
      try {
        await patchFollowingItems([item.mid], { formerNameDisplayIndex: index });
        setItems((previous) =>
          previous.map((current) =>
            current.mid === item.mid ? { ...current, formerNameDisplayIndex: index } : current,
          ),
        );
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "切换显示名字失败");
      }
    },
    [],
  );

  const syncHealth = (() => {
    if (!progress) return "尚未同步过";
    if (progress.status === "auth_invalid") return "未登录 B 站，同步已停止";
    if (progress.status === "rate_limited") return "触发 B 站风控，将在下次重试";
    if (!progress.fullScanCompleted) return "上次同步不完整，已跳过取关判定";
    return "";
  })();

  const lookupPercent =
    lookupProgress && lookupProgress.total > 0
      ? Math.min(100, Math.round((lookupProgress.done / lookupProgress.total) * 100))
      : 0;
  const lookupRemainingMinutes = lookupProgress
    ? Math.max(
        0,
        Math.ceil(
          ((lookupProgress.total - lookupProgress.done) * THIRD_PARTY_LOOKUP_INTERVAL_MS) / 60_000,
        ),
      )
    : null;

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

              {lookupEnabled ? (
                lookupRunning ? (
                  <button
                    type="button"
                    onClick={() => void cancelLookupBatch()}
                    title="停止查询（已查完的人不会丢）"
                    className="inline-flex items-center gap-1.5 rounded-full border border-pink-300 bg-pink-50 px-3.5 py-1.5 text-sm font-medium text-pink-600 transition-colors hover:bg-pink-100 dark:border-pink-500/40 dark:bg-pink-500/10 dark:text-pink-300"
                  >
                    <Wand2 className="h-3.5 w-3.5 animate-pulse" />
                    {lookupProgress
                      ? `查询中 ${lookupProgress.done}/${lookupProgress.total}`
                      : "查询中…"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void startLookupBatch()}
                    disabled={pendingLookupCount === 0 || syncing}
                    title="把关注用户的 UID 发送到第三方站点 aicu.cc 查询曾用名；逐条限速，可随时停止"
                    className="inline-flex items-center gap-1.5 rounded-full border border-pink-300 bg-pink-50 px-3.5 py-1.5 text-sm font-medium text-pink-600 transition-colors hover:bg-pink-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-pink-500/40 dark:bg-pink-500/10 dark:text-pink-300 dark:hover:bg-pink-500/20"
                  >
                    <Wand2 className="h-3.5 w-3.5" />
                    {pendingLookupCount > 0 ? `补全曾用名 ${pendingLookupCount}` : "曾用名已查完"}
                  </button>
                )
              ) : null}

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

          {/*
            批量查询进度。和收藏夹恢复保持一致：进度条 + 统计文案 + 停止按钮，
            而不是只在工具栏按钮里塞一个数字。离开页面再回来也能从 storage 恢复。
          */}
          {lookupRunning ? (
            <div className="mb-5 rounded-xl border border-pink-200 bg-white p-4 dark:border-pink-500/30 dark:bg-neutral-900">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm font-medium text-gray-800 dark:text-neutral-100">
                  正在查询曾用名（来源 aicu.cc）
                </p>
                <button
                  type="button"
                  onClick={() => void cancelLookupBatch()}
                  className="rounded-full border border-pink-300 bg-pink-50 px-3 py-1 text-xs font-medium text-pink-600 transition-colors hover:bg-pink-100 dark:border-pink-500/40 dark:bg-pink-500/10 dark:text-pink-300 dark:hover:bg-pink-500/20"
                >
                  停止查询
                </button>
              </div>
              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-neutral-700">
                <div
                  className="h-full rounded-full bg-pink-500 transition-[width] duration-300"
                  style={{ width: `${Math.max(5, lookupPercent)}%` }}
                />
              </div>
              <p className="mt-2 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
                {lookupProgress
                  ? `已查询 ${lookupProgress.done}/${lookupProgress.total} 条 · ${lookupProgress.found} 人有曾用名 · ${lookupProgress.failed} 人失败${
                      lookupRemainingMinutes !== null
                        ? ` · 剩余约 ${lookupRemainingMinutes} 分钟`
                        : ""
                    }`
                  : "正在准备…"}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-gray-400 dark:text-neutral-500">
                本轮上限 200 人，逐条 1.5 秒；已查完的结果会立即保存，中途停止不会丢。
              </p>
            </div>
          ) : null}

          {lookupEnabled && !lookupPrompted && !lookupRunning && pendingLookupCount > 0 ? (
            <div className="mb-5 flex flex-col justify-between gap-3 rounded-xl border border-pink-200 bg-pink-50/60 p-4 md:flex-row md:items-center dark:border-pink-500/30 dark:bg-pink-500/10">
              <div className="text-sm text-gray-700 dark:text-neutral-200">
                <p className="font-medium">可以为关注列表查询曾用名</p>
                <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-neutral-400">
                  来自第三方站点 aicu.cc：只查询当前列表（左侧筛选 + 搜索词）里的用户，
                  查询会把关注用户的 UID 发送给该站点，逐条限速、随时可停。
                  当前列表还有 {pendingLookupCount} 人未查询，预计约{" "}
                  {Math.max(
                    1,
                    Math.ceil((pendingLookupCount * THIRD_PARTY_LOOKUP_INTERVAL_MS) / 60_000),
                  )}{" "}
                  分钟。
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <button
                  type="button"
                  onClick={dismissLookupPrompt}
                  className="rounded-full px-3 py-1.5 text-xs text-gray-500 transition-colors hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                >
                  稍后
                </button>
                <button
                  type="button"
                  onClick={() => void startLookupBatch()}
                  disabled={syncing}
                  className="rounded-full bg-pink-500 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-pink-600 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  开始查询
                </button>
              </div>
            </div>
          ) : null}

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
                  <FollowingCard
                    key={item.mid}
                    item={item}
                    lookupEnabled={lookupEnabled}
                    lookupBusy={lookupBusyMid === item.mid}
                    onLookupFormerName={(target) => void handleLookupFormerName(target)}
                    onSelectFormerName={(target, index) => void handleSelectFormerName(target, index)}
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
    </div>
  );
};

export default Following;
