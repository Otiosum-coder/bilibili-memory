import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import {
  CHANGE_TYPE_COLOR,
  CHANGE_TYPE_LABEL,
  FOLLOWING_CHANGE_FILTERS,
  buildRecentEvents,
  countEventsByType,
  type FollowingChangeFilter,
} from "../utils/followingStats";
import type { FollowingEvent } from "../utils/types";

/** 每次追加的条数 */
const PAGE_SIZE = 30;

const formatRelativeDay = (day: string): string => {
  const target = new Date(`${day}T00:00:00`);
  if (Number.isNaN(target.getTime())) return day;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((today.getTime() - target.getTime()) / 86_400_000);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays === 2) return "前天";
  if (diffDays <= 7) return `${diffDays} 天前`;
  return day;
};

interface FollowingChangeListModalProps {
  open: boolean;
  events: FollowingEvent[];
  onClose: () => void;
  /** 点某一行 → 再打开单条明细 */
  onSelectEvent: (event: FollowingEvent) => void;
}

/**
 * 「最近变动」的全部变动弹窗。
 *
 * 为什么要有它：面板里那一小块**不可能**把几十上百条变动铺出来。面板只负责
 * "扫一眼最近发生了什么"，完整列表、类型筛选、以及继续翻更多都收在这里，
 * 这样面板本身可以保持克制（固定 8 条 + 一个入口）。
 *
 * 翻页用**滚动到底自动追加**，并在末尾保留一个可见的按钮兜底：
 * 数据少到没有滚动条时，观察者永远不会触发，只靠滚动加载会卡在原地。
 */
export const FollowingChangeListModal = ({
  open,
  events,
  onClose,
  onSelectEvent,
}: FollowingChangeListModalProps) => {
  const [filter, setFilter] = useState<FollowingChangeFilter>("all");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // 每次打开都回到初始状态：筛选复位、滚动回顶部
    setFilter("all");
    setVisibleCount(PAGE_SIZE);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key !== "Escape") return;
      onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  const counts = useMemo(() => countEventsByType(events), [events]);
  const matches = useMemo(
    () => (filter === "all" ? events : events.filter((event) => event.type === filter)),
    [events, filter],
  );
  const visible = useMemo(
    () => buildRecentEvents(matches, visibleCount),
    [matches, visibleCount],
  );
  const total = matches.length;
  const hasMore = total > visible.length;

  const filterOptions = useMemo(
    () =>
      FOLLOWING_CHANGE_FILTERS.map((value) => ({
        value,
        label: value === "all" ? "全部" : CHANGE_TYPE_LABEL[value],
        count: value === "all" ? events.length : counts[value],
      })),
    [counts, events.length],
  );

  // 滚到底自动追加。依赖里带上 hasMore：追加后需要重新挂观察者，
  // 否则哨兵一直在视口里却不会再触发。
  useEffect(() => {
    if (!open || !hasMore) return;
    const sentinel = sentinelRef.current;
    const root = scrollRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        setVisibleCount((count) => count + PAGE_SIZE);
      },
      { root, rootMargin: "120px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, open, visible.length]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm animate-in fade-in duration-200"
      onMouseDown={(mouseEvent) => {
        if (mouseEvent.target === mouseEvent.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="following-change-list-title"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-transparent bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 p-5 dark:border-neutral-800">
          <div>
            <h2
              id="following-change-list-title"
              className="text-lg font-bold text-gray-900 dark:text-neutral-100"
            >
              全部变动
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
              共 {events.length} 条记录。改名的具体时间 B 站不提供，这里的时间是本地**首次观测到**的时刻。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            aria-label="关闭全部变动"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 类型筛选。计数必须有：不显示数量时用户不知道点下去有没有内容 */}
        <div className="flex flex-wrap items-center gap-1 border-b border-gray-100 px-5 py-3 dark:border-neutral-800">
          {filterOptions.map((option) => {
            const active = filter === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  setFilter(option.value);
                  setVisibleCount(PAGE_SIZE);
                  if (scrollRef.current) scrollRef.current.scrollTop = 0;
                }}
                aria-pressed={active}
                className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
                  active
                    ? "bg-pink-50 font-medium text-pink-600 dark:bg-pink-500/10 dark:text-pink-400"
                    : "text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                }`}
              >
                {option.label}
                <span className="ml-1 tabular-nums opacity-60">{option.count}</span>
              </button>
            );
          })}
        </div>

        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
          {total === 0 ? (
            <p className="py-10 text-center text-sm text-gray-400 dark:text-neutral-500">
              这一类暂时没有变动
            </p>
          ) : (
            <ul className="space-y-1">
              {visible.map((event) => (
                <li key={event.event_id}>
                  <button
                    type="button"
                    onClick={() => onSelectEvent(event)}
                    title="查看这次变动的明细"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 dark:hover:bg-neutral-800/70"
                  >
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 text-xs text-white"
                      style={{ backgroundColor: CHANGE_TYPE_COLOR[event.type] }}
                    >
                      {CHANGE_TYPE_LABEL[event.type]}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-neutral-200">
                      {event.previous_name && event.type === "renamed"
                        ? `${event.previous_name} → ${event.name}`
                        : event.name || `UID ${event.mid}`}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-gray-400 dark:text-neutral-500">
                      {formatRelativeDay(event.day)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {/* 哨兵 + 兜底按钮。数据少到没有滚动条时只有按钮能继续加载 */}
          {hasMore ? (
            <div ref={sentinelRef} className="px-2 py-3">
              <button
                type="button"
                onClick={() => setVisibleCount((count) => count + PAGE_SIZE)}
                className="w-full rounded-md border border-gray-200 px-3 py-2 text-xs text-gray-600 transition-colors hover:border-pink-300 hover:text-pink-500 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-pink-500/50 dark:hover:text-pink-400"
              >
                加载更多（还有 {total - visible.length} 条）
              </button>
            </div>
          ) : (
            <p className="px-2 py-3 text-center text-xs text-gray-400 dark:text-neutral-500">
              已显示全部 {total} 条
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

export default FollowingChangeListModal;
