import { useEffect, useRef } from "react";
import { ExternalLink, X } from "lucide-react";
import {
  buildLocalNameTimeline,
  buildThirdPartyNames,
  followTimeOf,
  resolveDisplayName,
  statusChangedAt,
  FOLLOWING_STATUS_LABEL,
} from "../utils/followingQuery";
import { CHANGE_TYPE_COLOR, CHANGE_TYPE_LABEL } from "../utils/followingStats";
import type { FollowingEvent, FollowingItem } from "../utils/types";

const pad = (value: number) => `${value}`.padStart(2, "0");

/** 精确到秒。这是"检测到变动"的时刻，不是对面操作的时刻——见下文的说明 */
const formatDateTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const formatDate = (timestamp: number): string => {
  const date = new Date(timestamp);
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
};

const statusBadgeClass = (status: FollowingItem["status"]): string => {
  if (status === "following") return "bg-green-50 text-green-600 dark:bg-green-500/10 dark:text-green-400";
  if (status === "unfollowed") return "bg-amber-50 text-amber-600 dark:bg-amber-500/10 dark:text-amber-400";
  return "bg-gray-100 text-gray-500 dark:bg-neutral-800 dark:text-neutral-400";
};

interface FollowingChangeDetailModalProps {
  open: boolean;
  event: FollowingEvent | null;
  /** 变动对应的 UP 主快照。取关 / 注销后本地仍保留该条记录，通常都能取到 */
  item: FollowingItem | null;
  onClose: () => void;
}

/**
 * 「最近变动」的明细弹窗。
 *
 * 三条口径（不要随手改回去）：
 *
 * 1. **名称链路一律以 `nameHistory` 为准**，不用事件表拼。事件主键是
 *    `${type}:${mid}:${day}`、按天幂等，同一天改两次名只会留下第一条事件，
 *    用事件拼会显示出一条缺了一环的链路；而 `nameHistory` 是纯追加的，不会丢。
 * 2. **时间必须说成"检测到"**。B 站不提供改名历史，`seenAt` 只是"某次同步
 *    看到它叫这个名字"的时刻，真实改名时间落在区间内的某个点。写成"改名于 X"
 *    是在造一个并不存在的精度。
 * 3. **工具类事件（取关 / 注销）也能打开**：取关与注销之后 `following` 里仍保留
 *    该条记录（`status` 变为 `unfollowed` / `gone`），所以快照正常可读；
 *    万一取不到，就退回只用事件本身的信息，绝不显示空白。
 */
export const FollowingChangeDetailModal = ({
  open,
  event,
  item,
  onClose,
}: FollowingChangeDetailModalProps) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousActiveElementRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    previousActiveElementRef.current = document.activeElement as HTMLElement | null;
    const frameId = window.requestAnimationFrame(() => dialogRef.current?.focus());

    return () => {
      window.cancelAnimationFrame(frameId);
      previousActiveElementRef.current?.focus();
    };
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

  if (!open || !event) return null;

  const timeline = item ? buildLocalNameTimeline(item) : [];
  const thirdParty = item ? buildThirdPartyNames(item) : [];
  const displayName = item ? resolveDisplayName(item) : event.name || `UID ${event.mid}`;
  const spaceUrl = `https://space.bilibili.com/${event.mid}`;
  const changedAt = item ? statusChangedAt(item) : undefined;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm animate-in fade-in duration-200"
      onMouseDown={(mouseEvent) => {
        if (mouseEvent.target === mouseEvent.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="following-change-detail-title"
        tabIndex={-1}
        className="relative max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border border-transparent bg-white p-6 shadow-xl outline-none dark:border-neutral-800 dark:bg-neutral-900"
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-4 top-4 inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          aria-label="关闭变动明细"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="flex items-center gap-2 pr-10">
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-xs text-white"
            style={{ backgroundColor: CHANGE_TYPE_COLOR[event.type] }}
          >
            {CHANGE_TYPE_LABEL[event.type]}
          </span>
          <h2
            id="following-change-detail-title"
            className="min-w-0 truncate text-lg font-bold text-gray-900 dark:text-neutral-100"
            title={displayName}
          >
            {displayName}
          </h2>
        </div>

        <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
          检测到变动的时间：{formatDateTime(event.occurred_at)}（{event.day}）
        </p>

        {/* 改名：把完整链路摊开。事件的 previous_name → name 只是"那次同步看到的新旧名" */}
        {event.type === "renamed" && (event.previous_name || timeline.length > 1) ? (
          <section className="mt-5">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-neutral-200">名称变化</h3>
            {timeline.length > 1 ? (
              <ul className="mt-2 space-y-1.5">
                {timeline.map((segment) => (
                  <li key={`${segment.name}-${segment.from}`} className="flex justify-between gap-3 text-sm">
                    <span
                      className={
                        segment.isCurrent
                          ? "min-w-0 truncate font-medium text-pink-600 dark:text-pink-400"
                          : "min-w-0 truncate text-gray-600 dark:text-neutral-300"
                      }
                      title={segment.name}
                    >
                      {segment.name}
                    </span>
                    <span className="shrink-0 text-xs tabular-nums text-gray-400 dark:text-neutral-500">
                      {formatDate(segment.from)}
                      {segment.to ? ` ~ ${formatDate(segment.to)}` : " 起"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-gray-600 dark:text-neutral-300">
                {event.previous_name} → {event.name}
              </p>
            )}
            <p className="mt-2 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
              B 站不提供改名历史。上面的时间是我们**首次看到它叫这个名字**的时刻，
              真实改名发生在上一段的结束与本段的开始之间。
            </p>
          </section>
        ) : null}

        {/* 档案摘要。取关 / 注销后快照仍在，所以这一段通常都有 */}
        {item ? (
          <section className="mt-5">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-neutral-200">档案</h3>
            <dl className="mt-2 space-y-1.5 text-sm">
              <div className="flex items-start justify-between gap-3">
                <dt className="shrink-0 text-gray-500 dark:text-neutral-400">状态</dt>
                <dd>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${statusBadgeClass(item.status)}`}>
                    {FOLLOWING_STATUS_LABEL[item.status]}
                  </span>
                </dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="shrink-0 text-gray-500 dark:text-neutral-400">UID</dt>
                <dd className="tabular-nums text-gray-700 dark:text-neutral-200">{item.mid}</dd>
              </div>
              <div className="flex items-start justify-between gap-3">
                <dt className="shrink-0 text-gray-500 dark:text-neutral-400">
                  {changedAt ? "状态变更时间" : "关注时间"}
                </dt>
                <dd className="tabular-nums text-gray-700 dark:text-neutral-200">
                  {formatDateTime(changedAt ?? followTimeOf(item))}
                  {changedAt ? (item.status === "gone" ? "（检测到注销）" : "（检测到取关）") : ""}
                </dd>
              </div>
              {item.sign ? (
                <div className="flex items-start justify-between gap-3">
                  <dt className="shrink-0 text-gray-500 dark:text-neutral-400">简介</dt>
                  <dd className="min-w-0 text-right text-gray-600 dark:text-neutral-300">
                    {item.sign}
                  </dd>
                </div>
              ) : null}
            </dl>
          </section>
        ) : null}

        {thirdParty.length > 0 ? (
          <section className="mt-5">
            <h3 className="text-sm font-semibold text-gray-800 dark:text-neutral-200">
              第三方存档的曾用名
            </h3>
            <div className="mt-2 flex flex-wrap gap-1">
              {thirdParty.map((name) => (
                <span
                  key={name}
                  className="rounded border border-gray-200 px-1.5 py-0.5 text-xs text-gray-600 dark:border-neutral-700 dark:text-neutral-300"
                >
                  {name}
                </span>
              ))}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
              来自第三方存档，无时间信息、顺序不保证，仅供参考。
            </p>
          </section>
        ) : null}

        {!item ? (
          <p className="mt-5 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
            本地已经没有这位 UP 主的档案（可能被重置或从未完整同步过），
            因此只能显示这次变动本身的信息。
          </p>
        ) : null}

        <a
          href={spaceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-6 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-pink-500 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition-colors hover:bg-pink-600 dark:bg-pink-600 dark:hover:bg-pink-500"
        >
          <ExternalLink className="h-4 w-4" />
          打开 B 站空间
        </a>
      </div>
    </div>
  );
};

export default FollowingChangeDetailModal;
