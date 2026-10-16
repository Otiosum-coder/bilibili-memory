import { useEffect, useRef, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { formatStorageSize } from "../utils/storageHealth";
import {
  sumSelectedAssetBytes,
  type AssetKindSummary,
  type StorageBreakdown,
} from "../utils/storageBreakdown";
import type { AssetKind } from "../utils/types";

const formatCount = (value: number): string => value.toLocaleString("zh-CN");

interface StorageBreakdownModalProps {
  open: boolean;
  breakdown: StorageBreakdown | null;
  loading: boolean;
  error: string;
  /** 执行清理，返回每个类别的实际结果 */
  onCleanup: (
    kinds: AssetKind[],
  ) => Promise<Array<{ kind: AssetKind; deleted: number; freedBytes: number }>>;
  onClose: () => void;
  /** 清理完成后通知外部刷新统计 */
  onCleaned: () => void;
}

type CleanupStep = "overview" | "confirm" | "running" | "done";

/**
 * 存储明细弹窗。
 *
 * 三条设计约束：
 *
 * 1. **精确与估算必须分开标**。图片字节取 `blob.size`，是精确值；结构化数据是
 *    采样估算。给估算值加个"约"字，比让它看起来像精确值重要得多。
 * 2. **破坏性操作先看后果再确认**。勾选阶段只说"将释放 X"，点确认后额外一屏
 *    写清"清掉后回退到 B 站地址、失效则显示占位图"，再点一次才真删。
 * 3. **不提供"全选"以外的危险默认**。默认一个都不勾——用户是来看占用构成的，
 *    顺手把默认勾上导致误删，代价太大。
 */
export const StorageBreakdownModal = ({
  open,
  breakdown,
  loading,
  error,
  onCleanup,
  onClose,
  onCleaned,
}: StorageBreakdownModalProps) => {
  const [selected, setSelected] = useState<AssetKind[]>([]);
  const [step, setStep] = useState<CleanupStep>("overview");
  const [result, setResult] = useState<string>("");
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setSelected([]);
    setStep("overview");
    setResult("");
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const handleKeyDown = (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key !== "Escape") return;
      if (step === "running") return;
      if (step === "confirm") {
        setStep("overview");
        return;
      }
      onClose();
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open, step]);

  if (!open) return null;

  const assets = breakdown?.assets ?? [];
  const stores = breakdown?.stores ?? [];
  const selectedBytes = sumSelectedAssetBytes(assets, selected);
  const selectedCount = assets
    .filter((entry) => selected.includes(entry.kind))
    .reduce((total, entry) => total + entry.count, 0);

  const toggle = (kind: AssetKind) => {
    setSelected((current) =>
      current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind],
    );
  };

  const runCleanup = async () => {
    setStep("running");
    try {
      const outcome = await onCleanup(selected);
      const freed = outcome.reduce((total, entry) => total + entry.freedBytes, 0);
      const deleted = outcome.reduce((total, entry) => total + entry.deleted, 0);
      setResult(`已清理 ${formatCount(deleted)} 张图片，释放约 ${formatStorageSize(freed)}。`);
      setSelected([]);
      setStep("done");
      onCleaned();
    } catch (cleanupError) {
      setResult(
        cleanupError instanceof Error ? `清理失败：${cleanupError.message}` : "清理失败，请重试。",
      );
      setStep("done");
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm animate-in fade-in duration-200"
      onMouseDown={(mouseEvent) => {
        if (mouseEvent.target !== mouseEvent.currentTarget) return;
        if (step === "running") return;
        onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="storage-breakdown-title"
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-xl border border-transparent bg-white shadow-xl dark:border-neutral-800 dark:bg-neutral-900"
      >
        <div className="flex items-start justify-between gap-3 border-b border-gray-100 p-5 dark:border-neutral-800">
          <div>
            <h2
              id="storage-breakdown-title"
              className="text-lg font-bold text-gray-900 dark:text-neutral-100"
            >
              存储明细
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
              图片字节是精确值；结构化数据按采样估算，仅供参考。
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={step === "running"}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:opacity-30 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            aria-label="关闭存储明细"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {loading ? (
            <p className="py-10 text-center text-sm text-gray-400 dark:text-neutral-500">
              正在统计…
            </p>
          ) : error ? (
            <p className="py-10 text-center text-sm text-red-500">{error}</p>
          ) : step === "confirm" ? (
            <div>
              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <div>
                  <p className="font-medium">确认清理这 {selected.length} 类图片存档？</p>
                  <p className="mt-1 text-xs leading-relaxed">
                    将删除 {formatCount(selectedCount)} 张图片、释放约{" "}
                    {formatStorageSize(selectedBytes)}。
                    <strong>此操作不可撤销</strong>，且这些字节没有进过任何备份
                    （备份只保存图片地址，不存图片本身），删掉后只能重新联网归档。
                  </p>
                </div>
              </div>

              <ul className="mt-4 space-y-2">
                {assets
                  .filter((entry) => selected.includes(entry.kind))
                  .map((entry) => (
                    <li
                      key={entry.kind}
                      className="rounded-lg border border-gray-100 p-3 text-sm dark:border-neutral-800"
                    >
                      <p className="font-medium text-gray-800 dark:text-neutral-200">
                        {entry.title}
                      </p>
                      <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-neutral-400">
                        {entry.description}
                      </p>
                    </li>
                  ))}
              </ul>
            </div>
          ) : step === "running" ? (
            <p className="py-10 text-center text-sm text-gray-400 dark:text-neutral-500">
              正在清理…
            </p>
          ) : step === "done" ? (
            <div>
              <p className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700 dark:border-green-500/20 dark:bg-green-500/10 dark:text-green-300">
                {result}
              </p>
              <p className="mt-3 text-xs leading-relaxed text-gray-500 dark:text-neutral-400">
                页面上的封面与头像已回退到 B 站地址。若某张图已失效，会显示占位图；
                下一次归档任务会把还能抓到的图片重新存下来。
              </p>
            </div>
          ) : (
            <>
              {/* 图片归档：唯一可清理的部分，因为它是"删了还能再抓"的缓存 */}
              <section>
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-sm font-semibold text-gray-800 dark:text-neutral-200">
                    图片字节归档
                  </h3>
                  <span className="text-xs font-medium tabular-nums text-gray-500 dark:text-neutral-400">
                    {formatStorageSize(breakdown?.assetBytes ?? 0)}
                  </span>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
                  本扩展里唯一存真实图片字节的部分，也是占用大头。它不进任何备份
                  （备份只保存图片地址），属于本地缓存——是目前最值得清理的对象。
                </p>

                <ul className="mt-3 space-y-2">
                  {assets.map((entry) => (
                    <li
                      key={entry.kind}
                      className="rounded-lg border border-gray-100 p-3 dark:border-neutral-800"
                    >
                      <label className="flex cursor-pointer items-start gap-2.5">
                        <input
                          type="checkbox"
                          checked={selected.includes(entry.kind)}
                          onChange={() => toggle(entry.kind)}
                          className="mt-0.5 h-4 w-4 cursor-pointer rounded border-gray-300 text-pink-600 focus:ring-pink-500 dark:border-neutral-600"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-3">
                            <span className="text-sm font-medium text-gray-800 dark:text-neutral-200">
                              {entry.title}
                            </span>
                            <span className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-neutral-400">
                              {formatCount(entry.count)} 张 · {formatStorageSize(entry.bytes)}
                            </span>
                          </span>
                          <span className="mt-1 block text-xs leading-relaxed text-gray-500 dark:text-neutral-400">
                            {entry.description}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="mt-6">
                <h3 className="text-sm font-semibold text-gray-800 dark:text-neutral-200">
                  结构化数据（估算）
                </h3>
                <ul className="mt-2 divide-y divide-gray-100 dark:divide-neutral-800">
                  {stores.map((entry) => (
                    <li key={entry.label} className="flex items-baseline gap-3 py-1.5 text-sm">
                      <span className="min-w-0 flex-1 text-gray-700 dark:text-neutral-300">
                        {entry.label}
                        {entry.note ? (
                          <span className="mt-0.5 block text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
                            {entry.note}
                          </span>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-xs tabular-nums text-gray-500 dark:text-neutral-400">
                        {formatCount(entry.count)} 条
                      </span>
                      <span className="w-20 shrink-0 text-right text-xs tabular-nums text-gray-500 dark:text-neutral-400">
                        约 {formatStorageSize(entry.bytes)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="mt-6 rounded-lg bg-gray-50 p-3 text-xs leading-relaxed text-gray-500 dark:bg-neutral-800/60 dark:text-neutral-400">
                <p>
                  本扩展业务数据合计约{" "}
                  <strong className="text-gray-700 dark:text-neutral-200">
                    {formatStorageSize(breakdown?.businessBytes ?? 0)}
                  </strong>
                  ；浏览器报的整个站点用量是{" "}
                  {formatStorageSize(breakdown?.originUsage ?? 0)}
                  （还含缓存、站点设置等不属于本扩展的数据），配额{" "}
                  {formatStorageSize(breakdown?.originQuota ?? 0)}。
                </p>
                <p className="mt-1">
                  结构化数据的字节数是抽样估算（按 JSON 序列化体积推算，通常略偏大），
                  行大小随内容浮动，不要当成精确值。
                </p>
              </section>
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-gray-100 p-4 dark:border-neutral-800">
          <span className="text-xs text-gray-500 dark:text-neutral-400">
            {step === "overview" && selected.length > 0
              ? `已选 ${selected.length} 类 · 将释放约 ${formatStorageSize(selectedBytes)}`
              : ""}
          </span>
          <div className="flex gap-2">
            {step === "confirm" ? (
              <>
                <button
                  type="button"
                  onClick={() => setStep("overview")}
                  className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  返回
                </button>
                <button
                  type="button"
                  onClick={() => void runCleanup()}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700"
                >
                  确认清理
                </button>
              </>
            ) : step === "done" ? (
              <button
                type="button"
                onClick={onClose}
                className="rounded-lg bg-pink-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-pink-700"
              >
                完成
              </button>
            ) : (
              <>
                <button
                  type="button"
                  onClick={onClose}
                  disabled={step === "running"}
                  className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
                >
                  关闭
                </button>
                <button
                  type="button"
                  onClick={() => setStep("confirm")}
                  disabled={selected.length === 0 || step === "running" || loading}
                  className="rounded-lg bg-pink-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-pink-700 disabled:cursor-not-allowed disabled:bg-pink-300 dark:disabled:bg-pink-500/40"
                >
                  清理选中
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default StorageBreakdownModal;
