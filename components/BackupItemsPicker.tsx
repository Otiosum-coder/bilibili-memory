import { useState } from "react";
import { ChevronDown } from "lucide-react";
import {
  DEFAULT_LOCAL_HISTORY_BACKUP_ITEMS,
  DEFAULT_WEBDAV_SYNC_ITEMS,
  type BackupItemKey,
  type BackupItems,
} from "../utils/constants";

export interface BackupItemOption {
  key: BackupItemKey;
  label: string;
}

interface BackupItemsPickerProps {
  options: BackupItemOption[];
  value: BackupItems;
  onChange: (next: BackupItems) => void;
  /**
   * 这套选择影响的范围。备份内容在页面里有三套互不相通的配置
   * （本地目录 / WebDAV / JSON 文件），必须逐处写清，否则用户会以为改一处就够了。
   */
  scopeHint: string;
  disabled?: boolean;
  accent?: "pink" | "emerald";
  /** 个别项目的补充说明，直接显示在名称下方。用于那些名字本身说明不了作用的数据项 */
  hints?: Partial<Record<BackupItemKey, string>>;
}

/**
 * 备份内容的预设按钮。两个预设正好对应两处默认值：
 * 全部数据 = WebDAV 默认；仅历史记录 = 本地目录默认（见 constants 里的 DEFAULT_*）。
 */
const PRESETS: Array<{ key: string; label: string; items: BackupItems }> = [
  { key: "all", label: "全部数据", items: DEFAULT_WEBDAV_SYNC_ITEMS },
  { key: "history", label: "仅历史记录", items: DEFAULT_LOCAL_HISTORY_BACKUP_ITEMS },
];

const ACCENT = {
  pink: {
    active:
      "border-pink-300 bg-pink-50 text-pink-700 dark:border-pink-500/30 dark:bg-pink-500/10 dark:text-pink-200",
    accentClass: "accent-pink-600 dark:accent-pink-500",
  },
  emerald: {
    active:
      "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/10 dark:text-emerald-200",
    accentClass: "accent-emerald-600 dark:accent-emerald-500",
  },
} as const;

const IDLE =
  "border-gray-200 text-gray-700 hover:bg-gray-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800";

const matches = (value: BackupItems, preset: BackupItems, keys: BackupItemKey[]): boolean =>
  keys.every((key) => value[key] === preset[key]);

/**
 * 备份内容选择器（方案 B：默认只给两个预设，需要时才展开 9 个复选框）。
 *
 * 只改呈现方式：选中状态仍然写回调用方给的同一份 BackupItems，
 * 因此不涉及任何 storage 键或数据语义变化。
 */
export const BackupItemsPicker = ({
  options,
  value,
  onChange,
  scopeHint,
  disabled = false,
  accent = "pink",
  hints,
}: BackupItemsPickerProps) => {
  const keys = options.map((option) => option.key);
  const activePreset = PRESETS.find((preset) => matches(value, preset.items, keys))?.key;
  const [manualOpen, setManualOpen] = useState(false);
  const showGrid = manualOpen || activePreset === undefined;
  const accentStyles = ACCENT[accent];
  /**
   * 至少保留一项。原本取消勾选的实现里有这条保护（toast 提示），
   * 改成折叠式之后容易漏掉——一旦允许 0 项，备份会静默地什么也不做。
   */
  const checkedCount = keys.filter((key) => value[key]).length;

  const buttonClass = (active: boolean) => {
    const base =
      "inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50";
    if (!active) return base + " " + IDLE;
    return base + " font-medium " + accentStyles.active;
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {PRESETS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            disabled={disabled}
            aria-pressed={activePreset === preset.key}
            onClick={() => {
              onChange({ ...preset.items });
              setManualOpen(false);
            }}
            className={buttonClass(activePreset === preset.key)}
          >
            {preset.label}
          </button>
        ))}

        <button
          type="button"
          disabled={disabled}
          aria-expanded={showGrid}
          onClick={() => setManualOpen((open) => !open)}
          className={buttonClass(activePreset === undefined)}
        >
          自定义
          <ChevronDown
            className={`h-3 w-3 transition-transform ${showGrid ? "rotate-180" : ""}`}
          />
        </button>
      </div>

      {showGrid ? (
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
          {options.map((option) => (
            <label
              key={option.key}
              className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors ${
                value[option.key] ? accentStyles.active : IDLE
              } has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60`}
            >
              <input
                type="checkbox"
                checked={value[option.key]}
                disabled={disabled || (value[option.key] && checkedCount === 1)}
                title={
                  value[option.key] && checkedCount === 1 ? "至少要保留一项备份内容" : undefined
                }
                onChange={() => onChange({ ...value, [option.key]: !value[option.key] })}
                className={`h-4 w-4 focus:ring-2 focus:ring-offset-1 ${accentStyles.accentClass}`}
              />
              <span className="min-w-0">
                {option.label}
                {hints?.[option.key] ? (
                  <span className="mt-0.5 block text-[10px] leading-4 text-gray-400 dark:text-neutral-500">
                    {hints[option.key]}
                  </span>
                ) : null}
              </span>
            </label>
          ))}
        </div>
      ) : null}

      <p className="mt-2 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
        {checkedCount === 1 ? "至少要保留一项备份内容。" : null}
        {scopeHint}
      </p>
    </div>
  );
};
