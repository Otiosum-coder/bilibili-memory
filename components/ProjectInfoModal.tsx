import { useEffect } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import toast from "react-hot-toast";
import { Copy, ExternalLink, MessageCircle, X } from "lucide-react";

interface ProjectInfoModalProps {
  open: boolean;
  onClose: () => void;
  version: string;
}

const GITHUB_REPO_URL = "https://github.com/Otiosum-coder/bilibili-memory";
const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;

/**
 * 侧边栏品牌位点击后的项目信息弹窗。
 *
 * 之前是贴着侧边栏向上弹的浮层，但侧边栏只有 152px，卡片会盖到正文、
 * 地址也被截断。改成居中弹窗后可以放下横版 logo 和完整 GitHub 地址，
 * 也不受侧边栏宽度限制。
 */
export const ProjectInfoModal = ({ open, onClose, version }: ProjectInfoModalProps) => {
  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const handleCopyGithubUrl = async () => {
    try {
      await navigator.clipboard.writeText(GITHUB_REPO_URL);
      toast.success("GitHub 地址已复制");
    } catch {
      toast.error("复制失败，请手动选择地址");
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="项目信息"
        className="relative max-h-[82vh] w-full max-w-[440px] overflow-y-auto rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭项目信息"
          className="absolute right-3 top-3 z-10 inline-flex h-8 w-8 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="px-5 pb-3 pt-5 text-center">
          <img
            src="/brand/lockup.png"
            alt="哔哩哔哩记忆"
            className="mx-auto w-full max-w-[260px]"
          />
        </div>

        <div className="border-t border-gray-100 px-5 py-3.5 dark:border-neutral-800">
          <p className="mb-1.5 text-[10px] font-medium tracking-wide text-gray-400 dark:text-neutral-500">
            GitHub
          </p>
          <a
            href={GITHUB_REPO_URL}
            target="_blank"
            rel="noreferrer"
            title={GITHUB_REPO_URL}
            className="flex items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 transition-colors hover:border-pink-200 hover:bg-pink-50/40 dark:border-neutral-700 dark:bg-neutral-800 dark:hover:border-pink-900 dark:hover:bg-neutral-700/60"
          >
            <span className="min-w-0 flex-1 break-all font-mono text-[11px] leading-relaxed text-gray-600 dark:text-neutral-300">
              github.com/Otiosum-coder/bilibili-memory
            </span>
            <ExternalLink className="h-3.5 w-3.5 shrink-0 text-gray-400 dark:text-neutral-500" />
          </a>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleCopyGithubUrl}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-600 transition-colors hover:bg-gray-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <Copy className="h-3.5 w-3.5" />
              复制链接
            </button>
            <a
              href={GITHUB_ISSUES_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-gray-200 px-3 py-2 text-xs text-gray-600 transition-colors hover:bg-gray-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
            >
              <MessageCircle className="h-3.5 w-3.5" />
              问题反馈
            </a>
          </div>
        </div>

        <div className="border-t border-gray-100 px-6 py-3.5 dark:border-neutral-800">
          <Link
            to="/about"
            onClick={onClose}
            className="flex items-center justify-between rounded-lg px-1 py-1 text-sm text-pink-600 transition-colors hover:bg-pink-50 dark:text-pink-400 dark:hover:bg-pink-950/30"
          >
            <span>关于与更新日志</span>
            <span aria-hidden="true">→</span>
          </Link>
          <div className="mt-2 flex items-start justify-between gap-3 px-1">
            <p className="text-[11px] leading-relaxed text-gray-400 dark:text-neutral-500">
              数据只存本地，不接入你的账号。
            </p>
            {version ? (
              <span className="shrink-0 text-[11px] text-gray-400 dark:text-neutral-500">
                v{version}
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
};
