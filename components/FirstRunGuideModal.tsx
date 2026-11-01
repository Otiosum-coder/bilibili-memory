import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DatabaseBackup, Heart, History, RotateCcw, Users, Wand2, X } from "lucide-react";

interface FirstRunGuideModalProps {
  open: boolean;
  onComplete: () => void;
  onNavigate?: (path: string) => void;
}

interface GuideStep {
  title: string;
  description: string;
  icon: typeof History;
  accent: string;
  target: string | null;
  path: string | null;
}

const steps: GuideStep[] = [
  {
    title: "欢迎使用哔哩哔哩记忆",
    description: "接下来用几步认识收藏夹、关注列表和备份。每一步都会指向真实功能，也可以随时跳过。",
    icon: History,
    accent: "bg-pink-50 text-pink-600 dark:bg-pink-500/10 dark:text-pink-400",
    target: null,
    path: null,
  },
  {
    title: "历史记录入口",
    description: "从这里进入历史记录。扩展会在本地保存你看过的视频，支持搜索、筛选和分页浏览。",
    icon: History,
    accent: "bg-pink-50 text-pink-600 dark:bg-pink-500/10 dark:text-pink-400",
    target: "[data-tour='history-menu']",
    path: "/history",
  },
  {
    title: "收藏夹页面",
    description:
      "左侧是收藏夹目录，右侧是本地保存的收藏内容。可以按收藏夹查看、搜索，也能看到在线收藏夹比本地多出的条数。",
    icon: Heart,
    accent: "bg-pink-50 text-pink-600 dark:bg-pink-500/10 dark:text-pink-400",
    target: "[data-tour='favorites-toolbar']",
    path: "/favorites",
  },
  {
    title: "恢复失效内容",
    description:
      "收藏的视频失效后，标题和封面可能被 B 站替换成占位内容。点「恢复失效内容」，会用本地记录和第三方档案尝试找回；需要手动触发，不会自动运行。",
    icon: RotateCcw,
    accent: "bg-orange-50 text-orange-600 dark:bg-orange-500/10 dark:text-orange-400",
    target: "[data-tour='favorites-recover']",
    path: "/favorites",
  },
  {
    title: "关注列表",
    description:
      "这里保存你关注的 UP 主，以及取关、改名、账号注销等变化。第一次同步会建立基线；B 站不提供历史变化，因此变化记录只能从建立基线之后开始累积。",
    icon: Users,
    accent: "bg-blue-50 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400",
    target: "[data-tour='following-toolbar']",
    path: "/following",
  },
  {
    title: "查询曾用名",
    description:
      "在设置中开启第三方曾用名查询后，关注列表右上角会出现「补全曾用名」。数据来自 aicu.cc，默认关闭，需要先同意；只查询关注列表，不提供任意 UID 查询。",
    icon: Wand2,
    accent: "bg-purple-50 text-purple-600 dark:bg-purple-500/10 dark:text-purple-400",
    target: "[data-tour='following-toolbar']",
    path: "/following",
  },
  {
    title: "数据备份",
    description:
      "数据默认只保存在浏览器本地。想换设备或防止浏览器数据丢失，可以在这里导出 JSON，或配置 WebDAV / 本地目录备份。",
    icon: DatabaseBackup,
    accent: "bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400",
    target: "[data-tour='backup-menu']",
    path: "/webdav-sync",
  },
];

const TARGET_PADDING = 8;
const POPOVER_WIDTH = 440;
const POPOVER_GAP = 16;
const VIEWPORT_MARGIN = 16;

export const FirstRunGuideModal = ({ open, onComplete, onNavigate }: FirstRunGuideModalProps) => {
  const [step, setStep] = useState(0);
  const [targetRect, setTargetRect] = useState<DOMRect | null>(null);
  const [popoverPosition, setPopoverPosition] = useState({ left: 0, top: 0 });
  const [isPositionReady, setIsPositionReady] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const current = steps[step];

  useEffect(() => {
    if (!open) return;
    setStep(0);
    setTargetRect(null);
    setIsPositionReady(false);
  }, [open]);

  const goToStep = (nextStep: number) => {
    const next = steps[nextStep];
    if (next.path) onNavigate?.(next.path);
    setTargetRect(null);
    setIsPositionReady(false);
    setStep(nextStep);
  };

  const nextStep = () => {
    if (step === steps.length - 1) onComplete();
    else goToStep(step + 1);
  };

  const previousStep = () => {
    if (step > 0) goToStep(step - 1);
  };

  useEffect(() => {
    if (!open) return;

    let target: HTMLElement | null = null;
    let retryTimer = 0;
    let retryCount = 0;
    const updateTarget = () => {
      if (!current.target) {
        setTargetRect(null);
        setIsPositionReady(true);
        return;
      }
      target = document.querySelector<HTMLElement>(current.target);
      if (!target) {
        retryCount += 1;
        if (retryCount >= 20) {
          const dialogHeight = dialogRef.current?.offsetHeight ?? 390;
          const dialogWidth = dialogRef.current?.offsetWidth ?? POPOVER_WIDTH;
          setPopoverPosition({
            left: Math.max(VIEWPORT_MARGIN, (window.innerWidth - dialogWidth) / 2),
            top: Math.max(VIEWPORT_MARGIN, (window.innerHeight - dialogHeight) / 2),
          });
          setIsPositionReady(true);
          return;
        }
        retryTimer = window.setTimeout(updateTarget, 80);
        return;
      }
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.setAttribute("data-tour-active", "true");
      window.setTimeout(() => setTargetRect(target?.getBoundingClientRect() ?? null), 120);
    };

    updateTarget();
    const handleViewportChange = () => setTargetRect(target?.getBoundingClientRect() ?? null);
    window.addEventListener("resize", handleViewportChange);
    window.addEventListener("scroll", handleViewportChange, true);
    return () => {
      target?.removeAttribute("data-tour-active");
      window.clearTimeout(retryTimer);
      window.removeEventListener("resize", handleViewportChange);
      window.removeEventListener("scroll", handleViewportChange, true);
    };
  }, [current, open]);

  useLayoutEffect(() => {
    if (!open) return;
    const dialogHeight = dialogRef.current?.offsetHeight ?? 390;
    const dialogWidth = dialogRef.current?.offsetWidth ?? POPOVER_WIDTH;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    if (!targetRect) {
      if (current.target) return;
      setPopoverPosition({
        left: Math.max(VIEWPORT_MARGIN, (viewportWidth - dialogWidth) / 2),
        top: Math.max(VIEWPORT_MARGIN, (viewportHeight - dialogHeight) / 2),
      });
      setIsPositionReady(true);
      return;
    }

    const rightSpace = viewportWidth - targetRect.right;
    const leftSpace = targetRect.left;
    let left: number;
    let top: number;

    if (rightSpace >= dialogWidth + POPOVER_GAP + VIEWPORT_MARGIN) {
      left = targetRect.right + POPOVER_GAP;
      top = targetRect.top + targetRect.height / 2 - dialogHeight / 2;
    } else if (leftSpace >= dialogWidth + POPOVER_GAP + VIEWPORT_MARGIN) {
      left = targetRect.left - dialogWidth - POPOVER_GAP;
      top = targetRect.top + targetRect.height / 2 - dialogHeight / 2;
    } else if (viewportHeight - targetRect.bottom >= dialogHeight + POPOVER_GAP) {
      left = targetRect.left + targetRect.width / 2 - dialogWidth / 2;
      top = targetRect.bottom + POPOVER_GAP;
    } else {
      left = targetRect.left + targetRect.width / 2 - dialogWidth / 2;
      top = targetRect.top - dialogHeight - POPOVER_GAP;
    }

    setPopoverPosition({
      left: Math.max(
        VIEWPORT_MARGIN,
        Math.min(left, viewportWidth - dialogWidth - VIEWPORT_MARGIN),
      ),
      top: Math.max(
        VIEWPORT_MARGIN,
        Math.min(top, viewportHeight - dialogHeight - VIEWPORT_MARGIN),
      ),
    });
    setIsPositionReady(true);
  }, [current.target, open, step, targetRect]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onComplete();
      if (event.key === "ArrowRight") nextStep();
      if (event.key === "ArrowLeft") previousStep();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, step]);

  if (!open) return null;
  const Icon = current.icon;
  const isLast = step === steps.length - 1;
  const hole = targetRect
    ? {
        left: Math.max(0, targetRect.left - TARGET_PADDING),
        top: Math.max(0, targetRect.top - TARGET_PADDING),
        right: Math.min(window.innerWidth, targetRect.right + TARGET_PADDING),
        bottom: Math.min(window.innerHeight, targetRect.bottom + TARGET_PADDING),
      }
    : null;

  return (
    <div className="fixed inset-0 z-[60]" aria-live="polite">
      {hole ? (
        <>
          <div className="fixed left-0 right-0 top-0 bg-black/60" style={{ height: hole.top }} />
          <div
            className="fixed left-0 bg-black/60"
            style={{ top: hole.top, width: hole.left, height: hole.bottom - hole.top }}
          />
          <div
            className="fixed right-0 bg-black/60"
            style={{ top: hole.top, left: hole.right, height: hole.bottom - hole.top }}
          />
          <div className="fixed bottom-0 left-0 right-0 bg-black/60" style={{ top: hole.bottom }} />
        </>
      ) : (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
      )}

      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="first-run-guide-title"
        tabIndex={-1}
        style={{ left: popoverPosition.left, top: popoverPosition.top, width: POPOVER_WIDTH }}
        className={`fixed z-[63] flex max-h-[calc(100vh-2rem)] max-w-[calc(100vw-2rem)] flex-col rounded-xl border border-gray-200 bg-white shadow-2xl outline-none dark:border-neutral-700 dark:bg-neutral-900 ${
          isPositionReady ? "visible opacity-100" : "invisible opacity-0"
        }`}
      >
        {/* 只有内容区滚动，「跳过 / 上一步 / 下一步」这一行固定在底部。
            之前整卡 overflow-y-auto，内容一长按钮就被滚出视口。 */}
        <div className="min-h-0 flex-1 overflow-y-auto border-b border-gray-100 p-5 dark:border-neutral-800">
          <button
            type="button"
            onClick={onComplete}
            className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            aria-label="跳过首次引导"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="flex items-center gap-3 pr-8">
            <div
              className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${current.accent}`}
            >
              <Icon className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs font-medium text-blue-600 dark:text-blue-400">首次引导</p>
              <h1
                id="first-run-guide-title"
                className="mt-0.5 text-lg font-bold text-gray-900 dark:text-neutral-100"
              >
                {current.title}
              </h1>
            </div>
          </div>
          <p className="mt-4 text-sm leading-relaxed text-gray-600 dark:text-neutral-300">
            {current.description}
          </p>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-3 bg-gray-50 px-5 py-4 dark:bg-neutral-950/50">
          <span className="text-xs text-gray-500 dark:text-neutral-400">
            {step + 1} / {steps.length}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onComplete}
              className="rounded-md px-3 py-2 text-sm text-gray-500 hover:bg-gray-200 dark:text-neutral-400 dark:hover:bg-neutral-800"
            >
              跳过
            </button>
            {step > 0 && (
              <button
                type="button"
                onClick={previousStep}
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
              >
                上一步
              </button>
            )}
            <button
              type="button"
              onClick={nextStep}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              {isLast ? "完成" : "下一步"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
