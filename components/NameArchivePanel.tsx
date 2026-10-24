import { useCallback, useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import { Archive, LoaderCircle, Trash2, Upload } from "lucide-react";
import {
  clearNameArchive,
  loadNameArchive,
  saveNameArchive,
  type NameArchiveMeta,
} from "../utils/nameArchive";

/**
 * 「曾用名存档」导入面板。**只在本地构建里渲染**（见 `NAME_ARCHIVE_ENABLED`）。
 *
 * 数据来自离线切片脚本，只写进 `browser.storage.local`：
 * 不上传、不进备份、不参与 WebDAV 同步，也不会随扩展包分发。
 */
const MAX_FILE_BYTES = 20 * 1024 * 1024;

const formatTime = (iso: string): string => {
  if (!iso) return "未知";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "未知" : date.toLocaleString();
};

export const NameArchivePanel = () => {
  const [meta, setMeta] = useState<NameArchiveMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const refresh = useCallback(async () => {
    try {
      const archive = await loadNameArchive();
      setMeta(archive?.meta ?? null);
    } catch (error) {
      console.warn("读取曾用名存档失败:", error);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleFile = useCallback(async (file: File) => {
    if (file.size > MAX_FILE_BYTES) {
      toast.error("文件超过 20 MB，请确认选的是切片 JSON 而不是原始 TSV");
      return;
    }
    setBusy(true);
    try {
      const text = await file.text();
      const parsed = await saveNameArchive(text);
      setMeta(parsed.meta);
      toast.success(`已导入 ${parsed.meta.matchedUids} 个 UID 的曾用名`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "导入曾用名存档失败");
    } finally {
      setBusy(false);
    }
  }, []);

  const handleClear = useCallback(async () => {
    if (!window.confirm("确定清除本机导入的曾用名存档吗？原始数据文件不受影响。")) return;
    setBusy(true);
    try {
      await clearNameArchive();
      setMeta(null);
      toast.success("已清除曾用名存档");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "清除失败");
    } finally {
      setBusy(false);
    }
  }, []);

  return (
    <section className="overflow-hidden rounded-2xl border border-gray-200 bg-white dark:border-neutral-800 dark:bg-neutral-900">
      <div className="border-b border-gray-100 px-5 py-4 dark:border-neutral-800">
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-pink-50 text-pink-600 dark:bg-pink-500/10 dark:text-pink-400">
            <Archive className="h-4.5 w-4.5" />
          </div>
          <div>
            <h3 className="font-semibold text-gray-950 dark:text-neutral-100">曾用名存档（本地）</h3>
            <p className="mt-1 text-sm text-gray-500 dark:text-neutral-400">
              导入本机切片后，关注列表的卡片会显示曾用名。数据只存在本机，不上传、不进备份。
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-5">
        {loading ? (
          <p className="flex items-center gap-2 text-sm text-gray-500 dark:text-neutral-400">
            <LoaderCircle className="h-4 w-4 animate-spin" />
            正在读取存档…
          </p>
        ) : meta ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {[
              { label: "已收录 UID", value: `${meta.matchedUids} / ${meta.followingCount}` },
              { label: "名字条数", value: String(meta.totalNames) },
              { label: "生成时间", value: formatTime(meta.generatedAt) },
              { label: "来源", value: meta.source },
            ].map((item) => (
              <div
                key={item.label}
                className="rounded-xl bg-gray-50 px-4 py-3 dark:bg-neutral-800/70"
              >
                <p className="text-xs text-gray-500 dark:text-neutral-400">{item.label}</p>
                <p className="mt-1 truncate text-sm font-medium text-gray-800 dark:text-neutral-100">
                  {item.value}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-gray-300 px-4 py-4 text-sm text-gray-500 dark:border-neutral-700 dark:text-neutral-400">
            尚未导入。先在项目里运行切片脚本生成
            <code className="mx-1 rounded bg-gray-100 px-1 py-0.5 text-xs dark:bg-neutral-800">
              local-data/hname-slice.json
            </code>
            ，再导入。
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void handleFile(file);
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-pink-600 px-3 text-xs font-medium text-white transition-colors hover:bg-pink-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:focus-visible:ring-offset-neutral-800"
          >
            {busy ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Upload className="h-3.5 w-3.5" />
            )}
            {meta ? "替换切片文件" : "选择切片文件"}
          </button>
          {meta ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleClear()}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-xs font-medium text-gray-700 transition-colors hover:bg-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800 dark:focus-visible:ring-offset-neutral-800"
            >
              <Trash2 className="h-3.5 w-3.5" />
              清除
            </button>
          ) : null}
        </div>

        <p className="text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
          数据来自第三方存档快照，没有时间戳、顺序不保证、也可能不完整；「查不到」不等于「没改过名」。
          该面板只出现在本地构建里，商店构建会把它整段裁掉。
        </p>
      </div>
    </section>
  );
};
