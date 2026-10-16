import { useState } from "react";
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
 */
const formatDate = (timestamp?: number): string =>
  timestamp
    ? `${new Date(timestamp).getFullYear()}/${new Date(timestamp).getMonth() + 1}/${new Date(
        timestamp,
      ).getDate()}`
    : "";

export const NameHistoryPopover = ({ item }: { item: FollowingItem }) => {
  const [open, setOpen] = useState(false);

  if (!hasFormerNames(item)) return null;

  const timeline = buildLocalNameTimeline(item);
  const thirdParty = buildThirdPartyNames(item);
  const formerCount = Math.max(0, timeline.length - 1) + thirdParty.length;

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={(event) => {
          // 卡片本身可能是个链接（点名字跳空间），浮层按钮不能触发它
          event.preventDefault();
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        className="shrink-0 rounded-full border border-pink-200 bg-pink-50/70 px-1.5 py-0.5 text-[11px] leading-4 text-pink-600 transition-colors hover:border-pink-300 hover:bg-pink-50 dark:border-pink-500/30 dark:bg-pink-500/10 dark:text-pink-400 dark:hover:border-pink-500/50"
        aria-expanded={open}
        aria-label={`曾用名 ${formerCount} 个，点击查看`}
      >
        曾用名 {formerCount}
      </button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="关闭曾用名"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-full z-20 mt-2 w-72 rounded-lg border border-gray-100 bg-white p-3 text-xs shadow-lg dark:border-neutral-800 dark:bg-neutral-900">
            {timeline.length > 1 ? (
              <div className={thirdParty.length > 0 ? "mb-3" : ""}>
                <p className="mb-2 font-medium text-gray-700 dark:text-neutral-200">
                  本地观测到的改名
                </p>
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
                  {thirdParty.map((name) => (
                    <span
                      key={name}
                      className="rounded border border-gray-200 px-1.5 py-0.5 text-gray-600 dark:border-neutral-700 dark:text-neutral-300"
                    >
                      {name}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
                  来自第三方存档，无时间信息、顺序不保证，仅供参考
                </p>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
};

export default NameHistoryPopover;
