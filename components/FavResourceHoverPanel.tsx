import { useEffect } from "react";
import { createPortal } from "react-dom";
import { buildResourceCopyText, resolveFavResourceHint } from "../utils/favResourceInfo";
import type { FavoriteResource } from "../utils/types";

/**
 * 失效收藏卡片的悬停详情浮层。
 *
 * 背景：卡片上的标题/封面失效后会只剩占位内容，但本地其实还保存着完整信息
 * （AV/BV、UP 主、简介、时长、发布/收藏时间、播放/收藏/弹幕、失效原因……）。
 * 悬停封面时把这些"能回忆起原内容"的字段一次性摊开，比点进详情更顺手。
 *
 * 用 portal + fixed 定位：卡片本身 `overflow-hidden`（封面裁角），
 * 浮层若留在卡片内会被裁掉；同时按视口夹取位置，右侧/底部放不下时自动换边。
 * `pointer-events-none`：纯展示，不抢鼠标，移出封面即消失。
 */

const PANEL_WIDTH = 380;
const VIEWPORT_MARGIN = 12;
const ANCHOR_GAP = 8;
/** 浮层估算高度，用于决定向上还是向下展开 */
const ESTIMATED_HEIGHT = 320;

interface RawFavExtras {
  rights?: { autoplay?: number };
  cnt_info?: { thumb_up?: number; coin?: number; reply?: number; share?: number };
}

const buildExtraLines = (resource: FavoriteResource): string[] => {
  const raw = resource as FavoriteResource & RawFavExtras;
  const lines: string[] = [];
  const thumbUp = raw.cnt_info?.thumb_up;
  const coin = raw.cnt_info?.coin;
  const reply = raw.cnt_info?.reply;
  if (typeof thumbUp === "number" && thumbUp > 0) lines.push(`点赞数：${thumbUp}`);
  if (typeof coin === "number" && coin > 0) lines.push(`投币数：${coin}`);
  if (typeof reply === "number" && reply > 0) lines.push(`回复数：${reply}`);
  if (raw.rights?.autoplay === 0) lines.push("状态：UP 主设为「仅自己可见」（隐藏）");
  return lines;
};

export const FavResourceHoverPanel = ({
  resource,
  anchor,
  onClose,
}: {
  resource: FavoriteResource;
  anchor: DOMRect;
  onClose: () => void;
}) => {
  // 位置是悬停瞬间算的：滚动/缩放后不跟随，直接关掉，避免浮层和卡片错位
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [onClose]);

  const width = Math.min(PANEL_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, anchor.left),
    window.innerWidth - width - VIEWPORT_MARGIN,
  );
  const spaceBelow = window.innerHeight - anchor.bottom - ANCHOR_GAP - VIEWPORT_MARGIN;
  const spaceAbove = anchor.top - ANCHOR_GAP - VIEWPORT_MARGIN;
  const openUp = spaceBelow < ESTIMATED_HEIGHT && spaceAbove > spaceBelow;
  const maxHeight = Math.max(160, Math.min(560, openUp ? spaceAbove : spaceBelow));

  const text = [
    ...buildResourceCopyText(resource).split("\n"),
    ...buildExtraLines(resource),
  ].join("\n");
  const hint = resolveFavResourceHint(resource);

  return createPortal(
    <div
      style={{
        left,
        top: openUp ? undefined : anchor.bottom + ANCHOR_GAP,
        bottom: openUp ? window.innerHeight - anchor.top + ANCHOR_GAP : undefined,
        width,
        maxHeight,
      }}
      className="pointer-events-none fixed z-[70] select-text overflow-y-auto rounded-xl border border-gray-200 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900"
    >
      <pre className="m-0 whitespace-pre-wrap break-words font-sans text-xs leading-relaxed text-gray-700 dark:text-neutral-200">
        {text}
      </pre>
      {hint ? (
        <p className="mt-2 border-t border-gray-100 pt-2 text-[11px] leading-relaxed text-gray-400 dark:border-neutral-800 dark:text-neutral-500">
          {hint}
        </p>
      ) : null}
    </div>,
    document.body,
  );
};

export default FavResourceHoverPanel;
