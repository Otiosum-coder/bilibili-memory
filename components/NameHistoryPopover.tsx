import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  buildLocalNameTimeline,
  buildThirdPartyNames,
  hasFormerNames,
} from "../utils/followingQuery";
import type { FollowingItem } from "../utils/types";

/**
 * 「曾用名 N」徽章 + 点击展开的浮层。
 *
 * **这个组件是从 `pages/Following.tsx` 抽出来的共享件**，不是复制品。
 *
 * 抽出来的原因：消失档案原先自己写了一套"曾用名"展示（先是直接铺在卡片上、
 * 后来是只能用详情弹窗看），结果同一份 `nameHistory` 在两个页面有两种交互，
 * 改一边就会分叉。共享一份代码才能保证"关注列表怎么显示，消失档案就怎么显示"。
 *
 * 浮层而不是详情弹窗：看曾用名的动作是"瞄一眼"，为它打开一个全屏弹窗
 * 属于把小信息放进大容器。
 *
 * 为什么用 portal + fixed 定位，而不是卡片内的 absolute：
 * - 已注销卡片带 `opacity-60`，opacity 会创建层叠上下文，卡片内的浮层 z-index
 *   再高也压不过后面的卡片（会被下一张卡盖住、还会跟着变半透明）；
 * - 最右列的卡片向右展开会顶出视口。
 * 挂到 `document.body` 后就不受卡片层叠上下文影响，位置按徽章的视口坐标夹取：
 * 右边放不下时自动向左移，下面放不下时改为向上展开，并限制最大高度内部滚动。
 */
const formatDate = (timestamp?: number): string =>
  timestamp
    ? `${new Date(timestamp).getFullYear()}/${new Date(timestamp).getMonth() + 1}/${new Date(
        timestamp,
      ).getDate()}`
    : "";

/**
 * 第三方存档里名字可能很多（本地实测一个账号有 231 个），
 * 全部铺开会把浮层撑得比屏幕还高，所以默认只显示前 12 个。
 */
const MAX_VISIBLE_THIRD_PARTY_NAMES = 12;

/** 与面板宽度类 `w-72` 保持一致 */
const POPOVER_WIDTH = 288;
/** 内容最多撑到这么高，超出后面板内部滚动。仅用于估算展开方向 */
const POPOVER_MAX_HEIGHT = 320;
const VIEWPORT_MARGIN = 12;
/** 浮层与徽章之间的间距 */
const ANCHOR_GAP = 6;

interface PopoverPosition {
  left: number;
  width: number;
  maxHeight: number;
  /** 向下展开时设置；向上展开时用 bottom */
  top?: number;
  bottom?: number;
}

export const NameHistoryPopover = ({ item }: { item: FollowingItem }) => {
  const [open, setOpen] = useState(false);
  const [showAllNames, setShowAllNames] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 滚动时关闭浮层：位置是打开瞬间算的，滚动后不跟随（跟随要监听所有滚动容器，
  // 代价远大于价值；这个浮层本来就是"瞄一眼"的交互）。面板内部滚动不算。
  useEffect(() => {
    if (!open) return;
    const handleScroll = (event: Event) => {
      const panel = panelRef.current;
      if (panel && event.target instanceof Node && panel.contains(event.target)) return;
      setOpen(false);
    };
    const handleResize = () => setOpen(false);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("scroll", handleScroll, true);
    window.addEventListener("resize", handleResize);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("scroll", handleScroll, true);
      window.removeEventListener("resize", handleResize);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  if (!hasFormerNames(item)) return null;

  const timeline = buildLocalNameTimeline(item);
  const thirdParty = buildThirdPartyNames(item);
  const visibleThirdParty = showAllNames
    ? thirdParty
    : thirdParty.slice(0, MAX_VISIBLE_THIRD_PARTY_NAMES);
  const hiddenThirdPartyCount = thirdParty.length - visibleThirdParty.length;
  const formerCount = Math.max(0, timeline.length - 1) + thirdParty.length;

  /** 打开时按徽章的视口坐标算位置：右侧放不下就向左移，下方放不下就向上展开 */
  const openAt = (button: HTMLButtonElement) => {
    const rect = button.getBoundingClientRect();
    const width = Math.min(POPOVER_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
    const maxLeft = Math.max(VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN);
    const left = Math.min(Math.max(VIEWPORT_MARGIN, rect.left), maxLeft);

    const spaceBelow = window.innerHeight - rect.bottom - ANCHOR_GAP - VIEWPORT_MARGIN;
    const spaceAbove = rect.top - ANCHOR_GAP - VIEWPORT_MARGIN;
    const openUp = spaceBelow < Math.min(POPOVER_MAX_HEIGHT, 200) && spaceAbove > spaceBelow;
    const available = Math.max(140, openUp ? spaceAbove : spaceBelow);
    const maxHeight = Math.min(POPOVER_MAX_HEIGHT, available);

    setPosition({
      left,
      width,
      maxHeight,
      top: openUp ? undefined : rect.bottom + ANCHOR_GAP,
      bottom: openUp ? window.innerHeight - rect.top + ANCHOR_GAP : undefined,
    });
    setOpen(true);
  };

  const close = () => setOpen(false);

  const panel =
    open && position ? (
      <>
        <button
          type="button"
          aria-label="关闭曾用名"
          className="fixed inset-0 z-40 cursor-default"
          onClick={close}
        />
        <div
          ref={panelRef}
          style={{
            left: position.left,
            top: position.top,
            bottom: position.bottom,
            width: position.width,
            maxHeight: position.maxHeight,
          }}
          className="fixed z-50 overflow-y-auto rounded-lg border border-gray-100 bg-white p-3 text-xs shadow-lg dark:border-neutral-800 dark:bg-neutral-900"
        >
          {timeline.length > 1 ? (
            <div className={thirdParty.length > 0 ? "mb-3" : ""}>
              <p className="mb-2 font-medium text-gray-700 dark:text-neutral-200">本地观测到的改名</p>
              <ul className="space-y-1.5">
                {timeline.map((segment) => (
                  <li key={`${segment.name}-${segment.from}`} className="flex justify-between gap-3">
                    <span
                      className={
                        segment.isCurrent
                          ? "truncate font-medium text-pink-600 dark:text-pink-400"
                          : "truncate text-gray-600 dark:text-neutral-300"
                      }
                      title={segment.name}
                    >
                      {segment.name}
                    </span>
                    <span className="shrink-0 text-gray-400 dark:text-neutral-500">
                      {formatDate(segment.from)}
                      {segment.to ? ` ~ ${formatDate(segment.to)}` : " 起"}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {thirdParty.length > 0 ? (
            <div>
              <p className="mb-2 font-medium text-gray-700 dark:text-neutral-200">第三方存档</p>
              <div className="flex flex-wrap gap-1">
                {visibleThirdParty.map((name) => (
                  <span
                    key={name}
                    className="rounded border border-gray-200 px-1.5 py-0.5 text-gray-600 dark:border-neutral-700 dark:text-neutral-300"
                  >
                    {name}
                  </span>
                ))}
                {hiddenThirdPartyCount > 0 || showAllNames ? (
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setShowAllNames((value) => !value);
                    }}
                    className="rounded border border-dashed border-gray-300 px-1.5 py-0.5 text-gray-500 transition-colors hover:border-gray-400 hover:text-gray-600 dark:border-neutral-600 dark:text-neutral-400 dark:hover:border-neutral-500 dark:hover:text-neutral-300"
                  >
                    {showAllNames ? "收起" : `还有 ${hiddenThirdPartyCount} 个`}
                  </button>
                ) : null}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
                来自第三方存档，无时间信息、顺序不保证，仅供参考
              </p>
            </div>
          ) : null}
        </div>
      </>
    ) : null;

  return (
    <div className="inline-block">
      <button
        type="button"
        onClick={(event) => {
          // 卡片本身可能是个链接（点名字跳空间），浮层按钮不能触发它
          event.preventDefault();
          event.stopPropagation();
          if (open) close();
          else openAt(event.currentTarget);
        }}
        className="shrink-0 rounded-full border border-pink-200 bg-pink-50/70 px-1.5 py-0.5 text-[11px] leading-4 text-pink-600 transition-colors hover:border-pink-300 hover:bg-pink-50 dark:border-pink-500/30 dark:bg-pink-500/10 dark:text-pink-400 dark:hover:border-pink-500/50"
        aria-expanded={open}
        aria-label={`曾用名 ${formerCount} 个，点击查看`}
      >
        曾用名 {formerCount}
      </button>

      {panel ? createPortal(panel, document.body) : null}
    </div>
  );
};

export default NameHistoryPopover;
