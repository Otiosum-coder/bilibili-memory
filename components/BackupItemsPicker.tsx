import { type BackupItemKey, type BackupItems } from "../utils/constants";

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
}

interface BackupGroup {
  label: string;
  hint: string;
  keys: BackupItemKey[];
}

/**
 * 面向用户的分类。用户不需要理解底层 store 怎么拆，只需要知道
 * “备份哪一类东西”。一个分类会同时勾选/取消组内所有键。
 *
 * 注意：这里只是把多个键绑定到同一个勾选框，底层 `BackupItems` 仍然逐键保存，
 * 因此旧配置、导入导出和后台自动同步都不需要迁移。
 */
const BACKUP_GROUPS: BackupGroup[] = [
  {
    label: "历史记录",
    hint: "观看历史、观看事件与删除墓碑",
    keys: ["history"],
  },
  {
    label: "收藏夹",
    hint: "收藏夹本身，以及夹里的视频",
    keys: ["favFolders", "favResources"],
  },
  {
    label: "订阅合集",
    hint: "合集、合集视频，以及已消失合集的档案",
    keys: ["subscribedCollections", "subscribedCollectionResources", "collectionArchives"],
  },
  {
    label: "关注",
    hint: "关注列表、关注变动与曾用名存档",
    keys: ["following", "formerNames", "followingEvents"],
  },
  {
    label: "消失档案",
    hint: "收藏、合集、关注、互动中已查不到的内容快照",
    keys: ["vanishArchive", "vanishedFavResources"],
  },
  {
    label: "点赞与投币",
    hint: "点赞和投币的互动记录",
    keys: ["interactions"],
  },
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

/**
 * 备份内容选择器：按分类勾选，不展开子项。
 *
 * 默认配置里的所有键仍然逐项写回 `onChange`，所以本地目录、WebDAV 和 JSON
 * 三套备份各自保存自己的 `BackupItems`，互不影响。
 */
export const BackupItemsPicker = ({
  options,
  value,
  onChange,
  scopeHint,
  disabled = false,
  accent = "pink",
}: BackupItemsPickerProps) => {
  const groups: BackupGroup[] = [
    ...BACKUP_GROUPS,
    // 未来新增 store 如果忘了归组，也至少还能显示出来，不会静默消失。
    ...options
      .filter((option) => !BACKUP_GROUPS.some((group) => group.keys.includes(option.key)))
      .map((option) => ({ label: option.label, hint: "", keys: [option.key] })),
  ];
  const allKeys = groups.flatMap((group) => group.keys);
  const totalSelected = allKeys.filter((key) => value[key]).length;
  const accentStyles = ACCENT[accent];

  const toggleGroup = (group: BackupGroup) => {
    const hasSelected = group.keys.some((key) => value[key]);
    const next = { ...value };
    for (const key of group.keys) {
      next[key] = !hasSelected;
    }
    onChange(next);
  };

  return (
    <div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {groups.map((group) => {
          const selectedCount = group.keys.filter((key) => value[key]).length;
          const checked = selectedCount > 0;
          // 只剩这一类时不允许再取消，否则备份会静默地什么都不做。
          const isOnlySelection = checked && selectedCount === totalSelected;
          const hint = group.hint;

          return (
            <label
              key={group.label}
              className={`flex min-h-12 cursor-pointer items-start gap-2 rounded-lg border px-3 py-2.5 text-sm transition-colors ${
                checked ? accentStyles.active : IDLE
              } has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60`}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled || isOnlySelection}
                title={isOnlySelection ? "至少要保留一类备份内容" : undefined}
                onChange={() => toggleGroup(group)}
                className={`mt-0.5 h-4 w-4 shrink-0 focus:ring-2 focus:ring-offset-1 ${accentStyles.accentClass}`}
              />
              <span className="min-w-0">
                <span className="font-medium">{group.label}</span>
                {hint ? (
                  <span className="mt-0.5 block text-[11px] font-normal leading-4 text-gray-400 dark:text-neutral-500">
                    {hint}
                  </span>
                ) : null}
              </span>
            </label>
          );
        })}
      </div>

      <p className="mt-2 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
        {scopeHint}
      </p>
    </div>
  );
};
