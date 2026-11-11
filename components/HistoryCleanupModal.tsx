import React, { useEffect, useMemo, useState } from "react";
import { AlertTriangle, LoaderCircle, Trash2, X } from "lucide-react";
import {
  deleteHistoryInRange,
  previewHistoryInRange,
  type HistoryCleanupPreview,
} from "../utils/db";
import { DateRangePicker } from "./DateRangePicker";

type RangeKey = "week" | "month" | "year" | "all" | "custom";

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string; days?: number }> = [
  { key: "week", label: "一周前", days: 7 },
  { key: "month", label: "一个月前", days: 30 },
  { key: "year", label: "一年前", days: 365 },
  { key: "all", label: "全部" },
  { key: "custom", label: "自定义日期" },
];

const formatDate = (seconds: number | null) => {
  if (!seconds) return "—";
  return new Date(seconds * 1000).toLocaleDateString("zh-CN");
};

interface HistoryCleanupModalProps {
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
}

export const HistoryCleanupModal: React.FC<HistoryCleanupModalProps> = ({
  open,
  onClose,
  onDeleted,
}) => {
  const [rangeKey, setRangeKey] = useState<RangeKey>("month");
  const [customStart, setCustomStart] = useState("");
  const [customEnd, setCustomEnd] = useState("");
  const [preview, setPreview] = useState<HistoryCleanupPreview | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<{ events: number; contents: number } | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const range = useMemo(() => {
    const now = Math.floor(Date.now() / 1000);
    if (rangeKey === "custom") {
      if (!customStart) return null;
      const start = new Date(`${customStart}T00:00:00`);
      const end = new Date(`${customEnd || customStart}T23:59:59`);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
      return {
        start: Math.floor(start.getTime() / 1000),
        end: Math.floor(end.getTime() / 1000),
      };
    }
    if (rangeKey === "all") return { start: 0, end: now };
    const option = RANGE_OPTIONS.find((item) => item.key === rangeKey);
    return { start: 0, end: now - (option?.days ?? 30) * 24 * 60 * 60 };
  }, [rangeKey, customStart, customEnd]);

  useEffect(() => {
    if (!open) return;
    setRangeKey("month");
    setCustomStart("");
    setCustomEnd("");
    setPreview(null);
    setError("");
    setResult(null);
    setIsDeleting(false);
    setAcknowledged(false);
  }, [open]);

  useEffect(() => {
    if (!open || !range) {
      setPreview(null);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setPreview(null);
    setError("");
    void previewHistoryInRange(range.start, range.end)
      .then((next) => {
        if (!cancelled) setPreview(next);
      })
      .catch(() => {
        if (!cancelled) setError("读取可删除记录失败，请重试。");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, range]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isDeleting) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, isDeleting, onClose]);

  if (!open) return null;

  const handleDelete = async () => {
    if (!preview || preview.events === 0 || !range) return;
    setIsDeleting(true);
    setError("");
    try {
      const next = await deleteHistoryInRange(range.start, range.end);
      setResult({ events: next.eventsDeleted, contents: next.contentsDeleted });
      setPreview(null);
      onDeleted();
    } catch {
      setError("删除失败，未写入任何记录。请重试。");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="关闭清理历史弹窗"
        className="absolute inset-0 bg-black/40 backdrop-blur-[1px]"
        onClick={() => {
          if (!isDeleting) onClose();
        }}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-cleanup-title"
        className="relative flex max-h-[90vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
      >
        <div className="flex shrink-0 items-start justify-between border-b border-gray-100 px-5 py-4 dark:border-neutral-800">
          <div>
            <h2
              id="history-cleanup-title"
              className="text-base font-semibold text-gray-900 dark:text-neutral-100"
            >
              清理历史记录
            </h2>
            <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
              只删除观看历史和观看事件，不影响收藏、关注、互动与档案。
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!isDeleting) onClose();
            }}
            className="rounded-lg p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {result ? (
          <div className="space-y-4 px-5 py-6">
            <div className="rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:bg-emerald-500/10 dark:text-emerald-300">
              已删除 {result.events.toLocaleString()} 条观看记录、{result.contents.toLocaleString()}{" "}
              个内容的旧记录。
            </div>
            <p className="text-xs leading-5 text-gray-500 dark:text-neutral-400">
              已写入删除标记，后续同步不会把这些旧记录重新导回来。统计和年报会按剩余数据重新计算。
            </p>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-10 items-center rounded-lg bg-pink-500 px-4 text-sm font-medium text-white transition-colors hover:bg-pink-600"
              >
                知道了
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
              <div>
                <p className="text-xs font-medium text-gray-700 dark:text-neutral-300">删除范围</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {RANGE_OPTIONS.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      disabled={isDeleting}
                      onClick={() => setRangeKey(option.key)}
                      className={`rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                        rangeKey === option.key
                          ? "border-pink-300 bg-pink-50 font-medium text-pink-700 dark:border-pink-500/40 dark:bg-pink-500/10 dark:text-pink-300"
                          : "border-gray-200 bg-white text-gray-600 hover:border-pink-200 hover:text-pink-600 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {rangeKey === "custom" && (
                  <div className="mt-3">
                    <DateRangePicker
                      startDate={customStart}
                      endDate={customEnd}
                      onChange={(start, end) => {
                        setCustomStart(start);
                        setCustomEnd(end);
                      }}
                      dialog
                    />
                  </div>
                )}
              </div>

              <div className="rounded-xl border border-gray-100 bg-gray-50/80 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-950/60">
                {isLoading ? (
                  <p className="flex items-center gap-2 text-sm text-gray-500 dark:text-neutral-400">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    正在统计…
                  </p>
                ) : preview ? (
                  <div className="space-y-1 text-sm text-gray-700 dark:text-neutral-300">
                    <p>
                      将删除{" "}
                      <strong className="tabular-nums text-gray-900 dark:text-neutral-100">
                        {preview.events.toLocaleString()}
                      </strong>{" "}
                      条观看记录，涉及{" "}
                      <strong className="tabular-nums text-gray-900 dark:text-neutral-100">
                        {preview.contents.toLocaleString()}
                      </strong>{" "}
                      个内容
                    </p>
                    <p className="text-xs text-gray-500 dark:text-neutral-400">
                      实际记录日期：{formatDate(preview.oldestViewAt)}
                      {preview.newestViewAt !== preview.oldestViewAt
                        ? ` ~ ${formatDate(preview.newestViewAt)}`
                        : ""}
                    </p>
                  </div>
                ) : !range ? (
                  <p className="text-sm text-gray-500 dark:text-neutral-400">请选择日期范围。</p>
                ) : (
                  <p className="text-sm text-gray-500 dark:text-neutral-400">没有可删除的记录。</p>
                )}
              </div>

              <div className="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-3 text-xs leading-5 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  删除后无法撤销，观看统计、热力图和年报会同步变化。删除标记会阻止后续同步重新导入这些旧记录。
                </p>
              </div>

              <label className="flex cursor-pointer items-start gap-2 text-xs text-gray-600 dark:text-neutral-300">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                  disabled={isDeleting}
                  className="mt-0.5 h-4 w-4 rounded border-gray-300 text-rose-500 focus:ring-rose-500"
                />
                <span>我已知晓删除后无法恢复，并确认只清理观看历史。</span>
              </label>

              {error && <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p>}
            </div>

            <div className="flex shrink-0 items-center justify-end gap-2 border-t border-gray-100 px-5 py-4 dark:border-neutral-800">
              <button
                type="button"
                onClick={() => {
                  if (!isDeleting) onClose();
                }}
                className="inline-flex h-10 items-center rounded-lg border border-gray-200 bg-white px-4 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
              >
                取消
              </button>
              <button
                type="button"
                disabled={
                  isDeleting ||
                  isLoading ||
                  !acknowledged ||
                  !preview ||
                  preview.events === 0 ||
                  !range
                }
                onClick={() => void handleDelete()}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-rose-500 px-4 text-sm font-medium text-white transition-colors hover:bg-rose-600 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isDeleting ? (
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                ) : (
                  <Trash2 className="h-4 w-4" />
                )}
                {isDeleting ? "删除中…" : "确认删除"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
