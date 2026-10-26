import { useState, useEffect } from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  HardDrive,
  RefreshCw,
} from "lucide-react";
import { clearAllDatabaseTables, clearAssetsByKind, getTotalHistoryCount } from "../utils/db";
import type { AssetKind } from "../utils/types";
import { getStorageValue, setStorageValue } from "../utils/storage";
import {
  IS_SYNC_DELETE,
  SYNC_INTERVAL,
  IS_SYNC_DELETE_FROM_BILIBILI,
  HIDE_USER_INFO,
  HIDDEN_MENUS,
  SIDEBAR_MENU_ORDER,
  HISTORY_EVENT_MIGRATION_REPORT,
  FOLLOWING_AUTO_SYNC_ENABLED,
  FOLLOWING_SYNC_INTERVAL,
  FAVORITES_AUTO_SYNC_ENABLED,
  FAVORITES_SYNC_INTERVAL,
  DEFAULT_FAV_AUTO_SYNC_ENABLED,
  DEFAULT_FAV_SYNC_INTERVAL_MINUTES,
  DEFAULT_FOLLOWING_AUTO_SYNC_ENABLED,
  DEFAULT_FOLLOWING_SYNC_INTERVAL_MINUTES,
  INTERACTIONS_AUTO_SYNC_ENABLED,
  INTERACTIONS_SYNC_INTERVAL,
  DEFAULT_INTERACTIONS_AUTO_SYNC_ENABLED,
  DEFAULT_INTERACTIONS_SYNC_INTERVAL_MINUTES,
  THIRD_PARTY_NAME_LOOKUP_ENABLED,
  DEFAULT_THIRD_PARTY_NAME_LOOKUP_ENABLED,
  THIRD_PARTY_NAME_LOOKUP_CONSENT,
} from "../utils/constants";
import toast from "react-hot-toast";
import { Checkbox } from "../components/Checkbox";
import { Select } from "../components/Select";
import { HIDEABLE_MENU_TITLES, SIDEBAR_MENU_TITLES } from "../components/Sidebar";
import { checkStorageHealth, formatStorageSize, StorageHealthReport } from "../utils/storageHealth";
import { buildStorageBreakdown, type StorageBreakdown } from "../utils/storageBreakdown";
import { StorageBreakdownModal } from "../components/StorageBreakdownModal";

/**
 * 危险操作的反悔窗口（秒）。
 *
 * 重置扩展会清空整个 IndexedDB 与全部配置，没法"做完了再撤销"——
 * 真撤销就得先把几十 MB 数据快照下来，既慢又脆。所以改成**推迟执行**：
 * 确认后先走倒计时，这段时间里点「撤销」就当作没发生过。
 * 同样思路也适用于删记录时同步删 B站 记录（B站 没有"加回历史"的接口，删了就没了）。
 */
const RESET_UNDO_SECONDS = 5;

/**
 * 历史记录同步间隔预设。
 *
 * 标签写成"1 小时"而不是"60 分钟"——用户判断"多久一次"比换算分钟更直接；
 * 1 分钟是旧默认值，保留但不再让它当唯一的主控件。
 */
const SYNC_INTERVAL_PRESETS = [
  { minutes: 1, label: "1 分钟" },
  { minutes: 5, label: "5 分钟" },
  { minutes: 15, label: "15 分钟" },
  { minutes: 30, label: "30 分钟" },
  { minutes: 60, label: "1 小时" },
];

/** 关注列表同步间隔预设（分钟） */
const FOLLOWING_INTERVAL_PRESETS = [360, 720, 1440, 4320];
const FOLLOWING_INTERVAL_LABELS: Record<number, string> = {
  360: "每 6 小时",
  720: "每 12 小时",
  1440: "每天",
  4320: "每 3 天",
};

/**
 * 收藏夹自动同步间隔预设（分钟）。
 *
 * 比关注列表稀：收藏夹的增量同步很便宜（拉到本地边界就停），
 * 但**全量**要翻完整个收藏夹并逐条探测消失条目，所以只在 7 天一次的全量里做判定。
 */
const FAV_INTERVAL_PRESETS = [360, 720, 1440, 4320, 10080];
const FAV_INTERVAL_LABELS: Record<number, string> = {
  360: "每 6 小时",
  720: "每 12 小时",
  1440: "每天",
  4320: "每 3 天",
  10080: "每 7 天",
};

/**
 * 互动记录（点赞 / 投币）同步间隔预设（分钟）。
 *
 * 刻意比关注列表密得多：B 站只保留最近 20 条，两次同步之间新增的点赞一旦把旧条目挤出窗口，
 * 那条记录就永远拿不回来了。所以默认 3 小时，而不是每天。
 */
const INTERACTION_INTERVAL_PRESETS = [60, 180, 360, 720, 1440];
const INTERACTION_INTERVAL_LABELS: Record<number, string> = {
  60: "每 1 小时",
  180: "每 3 小时",
  360: "每 6 小时",
  720: "每 12 小时",
  1440: "每天",
};

/**
 * 把存下来的顺序补齐成"当前全部菜单"的顺序。
 *
 * 用户存过顺序之后，版本更新可能新增或改名菜单：仍然存在的按用户顺序排前，
 * 没出现在顺序里的（新增的）按默认顺序追加到末尾——否则新页面会凭空消失。
 */
const normalizeMenuOrder = (stored: string[]): string[] => {
  const kept = stored.filter((title) => SIDEBAR_MENU_TITLES.includes(title));
  const missing = SIDEBAR_MENU_TITLES.filter((title) => !kept.includes(title));
  return [...kept, ...missing];
};

const Settings = () => {
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [resetCountdown, setResetCountdown] = useState<number | null>(null);
  const [isSyncDelete, setIsSyncDelete] = useState(false);
  const [isSyncDeleteFromBilibili, setIsSyncDeleteFromBilibili] = useState(false);
  const [isHideUserInfo, setIsHideUserInfo] = useState(false);
  const [hiddenMenus, setHiddenMenus] = useState<string[]>([]);
  const [menuOrder, setMenuOrder] = useState<string[]>(SIDEBAR_MENU_TITLES);

  const [favAutoSync, setFavAutoSync] = useState<boolean>(DEFAULT_FAV_AUTO_SYNC_ENABLED);
  const [favIntervalMinutes, setFavIntervalMinutes] = useState<number>(
    DEFAULT_FAV_SYNC_INTERVAL_MINUTES,
  );

  const [showResetResultDialog, setShowResetResultDialog] = useState(false);
  const [resetResult, setResetResult] = useState("");
  const [resetSucceeded, setResetSucceeded] = useState(false);
  const [isResetLoading, setIsResetLoading] = useState(false);
  const [resetStatus, setResetStatus] = useState("");

  const [syncInterval, setSyncInterval] = useState<number | string>(1);
  const [customIntervalOpen, setCustomIntervalOpen] = useState(false);
  const [storageHealth, setStorageHealth] = useState<StorageHealthReport | null>(null);
  const [isCheckingStorage, setIsCheckingStorage] = useState(false);
  const [storageHealthError, setStorageHealthError] = useState("");
  /** 存储明细弹窗：明细数据在打开时才采集，避免每次进设置页都扫一遍库 */
  const [breakdownOpen, setBreakdownOpen] = useState(false);
  const [breakdown, setBreakdown] = useState<StorageBreakdown | null>(null);
  const [isBreakdownLoading, setIsBreakdownLoading] = useState(false);
  const [breakdownError, setBreakdownError] = useState("");
  const [historyCounts, setHistoryCounts] = useState({ content: 0, visit: 0 });
  const [followingAutoSync, setFollowingAutoSync] = useState<boolean>(
    DEFAULT_FOLLOWING_AUTO_SYNC_ENABLED,
  );
  const [followingIntervalMinutes, setFollowingIntervalMinutes] = useState<number>(
    DEFAULT_FOLLOWING_SYNC_INTERVAL_MINUTES,
  );
  const [interactionAutoSync, setInteractionAutoSync] = useState<boolean>(
    DEFAULT_INTERACTIONS_AUTO_SYNC_ENABLED,
  );
  const [interactionIntervalMinutes, setInteractionIntervalMinutes] = useState<number>(
    DEFAULT_INTERACTIONS_SYNC_INTERVAL_MINUTES,
  );
  const [historyMigrationSkipped, setHistoryMigrationSkipped] = useState(0);
  /** 第三方曾用名查询（aicu.cc）。默认关闭，首次开启要用户确认 */
  const [thirdPartyLookupEnabled, setThirdPartyLookupEnabled] = useState(
    DEFAULT_THIRD_PARTY_NAME_LOOKUP_ENABLED,
  );
  const [thirdPartyConsentGiven, setThirdPartyConsentGiven] = useState(false);
  const [showThirdPartyConsent, setShowThirdPartyConsent] = useState(false);

  const isPresetInterval = SYNC_INTERVAL_PRESETS.some(
    (option) => option.minutes === Number(syncInterval),
  );
  /** 自定义输入框：手动展开，或当前值本来就不在预设里（例如旧配置写了 7 分钟） */
  const showCustomInterval = customIntervalOpen || !isPresetInterval;

  const refreshStorageHealth = async (showSuccess = false) => {
    setIsCheckingStorage(true);
    setStorageHealthError("");
    try {
      const [report, contentCount, visitCount] = await Promise.all([
        checkStorageHealth(true),
        getTotalHistoryCount("content"),
        getTotalHistoryCount("visit"),
      ]);
      setStorageHealth(report);
      setHistoryCounts({ content: contentCount, visit: visitCount });
      const migrationReport = await getStorageValue<{ skipped?: number }>(
        HISTORY_EVENT_MIGRATION_REPORT,
        {},
      );
      setHistoryMigrationSkipped(Number(migrationReport.skipped) || 0);
      if (showSuccess) toast.success("存储保护状态已刷新");
    } catch (error) {
      console.error("检查存储保护状态失败:", error);
      setStorageHealthError(error instanceof Error ? error.message : "未知错误");
      if (showSuccess) toast.error("存储保护状态检查失败");
    } finally {
      setIsCheckingStorage(false);
    }
  };

  /**
   * 采集存储明细。
   *
   * 不在进页面时自动跑：它要遍历 assets 的 kind 索引并采样十几个 store，
   * 大库上是明显的一次 IO。改成点开「存储明细」时才采。
   */
  const loadBreakdown = async (health = storageHealth) => {
    setIsBreakdownLoading(true);
    setBreakdownError("");
    try {
      setBreakdown(await buildStorageBreakdown(health));
    } catch (error) {
      console.error("统计存储明细失败:", error);
      setBreakdownError(error instanceof Error ? error.message : "统计失败，请重试");
    } finally {
      setIsBreakdownLoading(false);
    }
  };

  const handleOpenBreakdown = async () => {
    setBreakdownOpen(true);
    // 顺手刷新一次总量，保证明细里的 origin 用量不是几小时前的旧值
    const report = await checkStorageHealth(false);
    setStorageHealth(report);
    await loadBreakdown(report);
  };

  /**
   * 清理选中的图片归档。
   *
   * 图片字节没有进过任何备份（备份只存图片地址），所以这一步是不可逆的；
   * 清理完必须**重新采集明细**，否则弹窗还显示着旧数字。
   */
  const handleCleanupAssets = async (kinds: AssetKind[]) => {
    const outcome: Array<{ kind: AssetKind; deleted: number; freedBytes: number }> = [];
    for (const kind of kinds) {
      const result = await clearAssetsByKind(kind);
      outcome.push({ kind, ...result });
    }
    await loadBreakdown(storageHealth);
    return outcome;
  };

  // 倒计时：每秒减一，归零才真正执行
  useEffect(() => {
    if (resetCountdown === null) return;
    if (resetCountdown <= 0) {
      void executeReset();
      return;
    }
    const timer = window.setTimeout(
      () => setResetCountdown((current) => (current === null ? null : current - 1)),
      1000,
    );
    return () => window.clearTimeout(timer);
  }, [resetCountdown]);

  useEffect(() => {
    // 加载设置
    const loadSettings = async () => {
      const syncDelete = await getStorageValue(IS_SYNC_DELETE, false);
      const syncDeleteFromBilibili = await getStorageValue(IS_SYNC_DELETE_FROM_BILIBILI, false);
      const hideUserInfo = await getStorageValue(HIDE_USER_INFO, false);
      const menus = await getStorageValue<string[]>(HIDDEN_MENUS, []);
      const storedOrder = await getStorageValue<string[]>(SIDEBAR_MENU_ORDER, []);
      const storedSyncInterval = await getStorageValue(SYNC_INTERVAL, 1);
      const storedFavAuto = await getStorageValue<boolean>(
        FAVORITES_AUTO_SYNC_ENABLED,
        DEFAULT_FAV_AUTO_SYNC_ENABLED,
      );
      const storedFavInterval = await getStorageValue<number>(
        FAVORITES_SYNC_INTERVAL,
        DEFAULT_FAV_SYNC_INTERVAL_MINUTES,
      );
      const storedFollowingAuto = await getStorageValue<boolean>(
        FOLLOWING_AUTO_SYNC_ENABLED,
        DEFAULT_FOLLOWING_AUTO_SYNC_ENABLED,
      );
      const storedFollowingInterval = await getStorageValue<number>(
        FOLLOWING_SYNC_INTERVAL,
        DEFAULT_FOLLOWING_SYNC_INTERVAL_MINUTES,
      );
      const storedInteractionAuto = await getStorageValue<boolean>(
        INTERACTIONS_AUTO_SYNC_ENABLED,
        DEFAULT_INTERACTIONS_AUTO_SYNC_ENABLED,
      );
      const storedInteractionInterval = await getStorageValue<number>(
        INTERACTIONS_SYNC_INTERVAL,
        DEFAULT_INTERACTIONS_SYNC_INTERVAL_MINUTES,
      );
      const migrationReport = await getStorageValue<{ skipped?: number }>(
        HISTORY_EVENT_MIGRATION_REPORT,
        {},
      );

      setIsSyncDelete(syncDelete);
      setIsSyncDeleteFromBilibili(syncDeleteFromBilibili);
      setIsHideUserInfo(hideUserInfo);
      setHiddenMenus(
        menus.includes("WebDAV") && !menus.includes("数据备份") ? [...menus, "数据备份"] : menus,
      );
      setMenuOrder(normalizeMenuOrder(storedOrder));
      setSyncInterval(storedSyncInterval);
      setFavAutoSync(storedFavAuto);
      setFavIntervalMinutes(
        Number(storedFavInterval) > 0 ? Number(storedFavInterval) : DEFAULT_FAV_SYNC_INTERVAL_MINUTES,
      );
      setFollowingAutoSync(storedFollowingAuto);
      setFollowingIntervalMinutes(
        Number(storedFollowingInterval) > 0
          ? Number(storedFollowingInterval)
          : DEFAULT_FOLLOWING_SYNC_INTERVAL_MINUTES,
      );
      setInteractionAutoSync(storedInteractionAuto);
      setInteractionIntervalMinutes(
        Number(storedInteractionInterval) > 0
          ? Number(storedInteractionInterval)
          : DEFAULT_INTERACTIONS_SYNC_INTERVAL_MINUTES,
      );
      setHistoryMigrationSkipped(Number(migrationReport.skipped) || 0);
      const thirdPartyEnabled = await getStorageValue<boolean>(
        THIRD_PARTY_NAME_LOOKUP_ENABLED,
        DEFAULT_THIRD_PARTY_NAME_LOOKUP_ENABLED,
      );
      const thirdPartyConsent = await getStorageValue<boolean>(
        THIRD_PARTY_NAME_LOOKUP_CONSENT,
        false,
      );
      setThirdPartyLookupEnabled(thirdPartyEnabled);
      setThirdPartyConsentGiven(thirdPartyConsent);
    };
    loadSettings();
    void refreshStorageHealth();
  }, []);

  const handleSyncDeleteChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.checked;
    setIsSyncDelete(newValue);
    await setStorageValue(IS_SYNC_DELETE, newValue);
  };

  const handleSyncDeleteFromBilibiliChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.checked;
    setIsSyncDeleteFromBilibili(newValue);
    await setStorageValue(IS_SYNC_DELETE_FROM_BILIBILI, newValue);
  };

  /** 上移 / 下移一位并落盘。侧边栏订阅了 storage 变化，所以立即生效、无需刷新 */
  const moveMenuItem = async (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= menuOrder.length) return;
    const next = [...menuOrder];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    setMenuOrder(next);
    await setStorageValue(SIDEBAR_MENU_ORDER, next);
  };

  const handleFollowingAutoSyncChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked;
    setFollowingAutoSync(next);
    await setStorageValue(FOLLOWING_AUTO_SYNC_ENABLED, next);
  };

  const handleFollowingIntervalChange = async (minutes: number) => {
    setFollowingIntervalMinutes(minutes);
    await setStorageValue(FOLLOWING_SYNC_INTERVAL, minutes);
  };

  /**
   * 第三方曾用名查询开关。开启前必须有知情同意：
   * 查询会把关注用户的 UID 发送给 aicu.cc，这和项目"数据不出本机"的默认承诺不同，
   * 所以不能只靠一个静默复选框。
   */
  const handleThirdPartyLookupChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked;
    if (!next) {
      setThirdPartyLookupEnabled(false);
      setShowThirdPartyConsent(false);
      await setStorageValue(THIRD_PARTY_NAME_LOOKUP_ENABLED, false);
      return;
    }
    if (!thirdPartyConsentGiven) {
      setShowThirdPartyConsent(true);
      return;
    }
    setThirdPartyLookupEnabled(true);
    await setStorageValue(THIRD_PARTY_NAME_LOOKUP_ENABLED, true);
  };

  const confirmThirdPartyConsent = async () => {
    setThirdPartyConsentGiven(true);
    setShowThirdPartyConsent(false);
    setThirdPartyLookupEnabled(true);
    await Promise.all([
      setStorageValue(THIRD_PARTY_NAME_LOOKUP_CONSENT, true),
      setStorageValue(THIRD_PARTY_NAME_LOOKUP_ENABLED, true),
    ]);
    toast.success("已开启关注列表曾用名查询");
  };

  const handleInteractionAutoSyncChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked;
    setInteractionAutoSync(next);
    await setStorageValue(INTERACTIONS_AUTO_SYNC_ENABLED, next);
  };

  const handleInteractionIntervalChange = async (minutes: number) => {
    setInteractionIntervalMinutes(minutes);
    await setStorageValue(INTERACTIONS_SYNC_INTERVAL, minutes);
  };

  const handleFavAutoSyncChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = e.target.checked;
    setFavAutoSync(next);
    await setStorageValue(FAVORITES_AUTO_SYNC_ENABLED, next);
  };

  const handleFavIntervalChange = async (minutes: number) => {
    setFavIntervalMinutes(minutes);
    await setStorageValue(FAVORITES_SYNC_INTERVAL, minutes);
  };

  const handleHideUserInfoChange = async (checked: boolean) => {
    setIsHideUserInfo(checked);
    await setStorageValue(HIDE_USER_INFO, checked);
  };

  const toggleHiddenMenu = async (title: string, checked: boolean) => {
    let newMenus;
    if (!checked) {
      // if unchecked, remove from hidden (show it)
      // logic: hiddenMenus contains items to HIDE.
      // Checkbox "Hide XXX". Checked = Included in hiddenMenus.
      // So if checkbox says "Hide Favorites" is checked, we add to list.
      // Wait, toggleHiddenMenu logic was:
      // if includes -> remove. else -> add.
      // Checkbox onChange gives NEW checked state.
      // If checked=true (user wants to Hide), we Add to list.
      // If checked=false (user wants to Show), we Remove from list.
      newMenus = hiddenMenus.filter((t) => t !== title);
    } else {
      newMenus = [...hiddenMenus, title];
    }
    // Correct logic re-check:
    // If we receive `checked` as true, it means "Hide this menu". So title should be in hiddenMenus.
    if (checked) {
      if (!hiddenMenus.includes(title)) newMenus = [...hiddenMenus, title];
      else newMenus = hiddenMenus;
    } else {
      newMenus = hiddenMenus.filter((t) => t !== title);
    }

    setHiddenMenus(newMenus);
    await setStorageValue(HIDDEN_MENUS, newMenus);
  };

  const handleSyncIntervalChange = async (val: string | number) => {
    setSyncInterval(val);
    const num = Number(val);
    if (!isNaN(num) && num >= 1) {
      await setStorageValue(SYNC_INTERVAL, num);
    }
  };

  /** 确认后不立刻执行，先给一个可反悔的倒计时窗口 */
  const startResetCountdown = () => {
    setShowConfirmDialog(false);
    setResetCountdown(RESET_UNDO_SECONDS);
  };

  const cancelReset = () => {
    setResetCountdown(null);
    toast.success("已撤销，数据没有任何变化");
  };

  const executeReset = async () => {
    setResetCountdown(null);
    try {
      setIsResetLoading(true);
      setResetSucceeded(false);
      setResetStatus("正在清空本地数据...");
      await clearAllDatabaseTables();
      setResetStatus("正在清理偏好设置...");
      await browser.storage.local.clear();
      setResetStatus("正在完成重置...");
      setResetSucceeded(true);
      setResetResult("重置完成，本地数据与设置已清空。");
    } catch (error) {
      console.error("重置扩展失败:", error);
      setResetSucceeded(false);
      setResetResult(error instanceof Error ? error.message : "重置失败，请重试！");
    } finally {
      setIsResetLoading(false);
      setResetStatus("");
      setShowResetResultDialog(true);
      setShowConfirmDialog(false);
    }
  };

  return (
    <div className="p-6 pb-20 min-h-screen bg-gray-50/30 dark:bg-[#0a0a0a] text-gray-900 dark:text-neutral-100 max-w-7xl mx-auto">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
        {/* 左列：数据与存储管理 */}
        <div className="space-y-6">
          <div className="border-b border-gray-200 dark:border-neutral-800 pb-2 mb-4">
            <h2 className="text-base font-bold text-gray-800 dark:text-neutral-200 flex items-center gap-2">
              <HardDrive className="w-5 h-5 text-blue-500" />
              数据与存储管理
            </h2>
          </div>

          {/* Edge/Chromium 存储保护 */}
          <div className="w-full rounded-xl bg-gray-50 dark:bg-neutral-900 shadow-sm border border-gray-100 dark:border-neutral-800">
            <div className="p-5">
              <div className="flex items-start justify-between gap-4 mb-5">
                <div className="flex items-start gap-3">
                  <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400">
                    <HardDrive className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-lg font-bold text-gray-800 dark:text-neutral-100 mb-1">
                      本地存储保护
                    </h3>
                    <p className="text-sm text-gray-500 dark:text-neutral-400">
                      检查 IndexedDB 持久化状态和可用容量
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void refreshStorageHealth(true)}
                  disabled={isCheckingStorage}
                  className="p-2 rounded-lg text-gray-500 dark:text-neutral-400 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-500/10 transition-colors disabled:opacity-50"
                  title="刷新存储保护状态"
                >
                  <RefreshCw className={`w-4 h-4 ${isCheckingStorage ? "animate-spin" : ""}`} />
                </button>
              </div>

              {storageHealth ? (
                <div className="space-y-3 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500 dark:text-neutral-400">扩展存储保护</span>
                    <span
                      className={
                        storageHealth.storageProtected
                          ? "font-medium text-green-600 dark:text-green-400"
                          : "font-medium text-amber-600 dark:text-amber-400"
                      }
                    >
                      {storageHealth.storageProtected ? "已启用" : "未启用"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-gray-500 dark:text-neutral-400">保护方式</span>
                    <span className="text-right font-medium text-gray-700 dark:text-neutral-200">
                      {storageHealth.unlimitedStorageGranted
                        ? "unlimitedStorage 权限"
                        : storageHealth.persisted
                          ? "浏览器持久化存储"
                          : "无"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500 dark:text-neutral-400">当前使用量</span>
                    <span className="font-medium text-gray-700 dark:text-neutral-200">
                      {formatStorageSize(storageHealth.usage)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500 dark:text-neutral-400">历史记录</span>
                    <span className="font-medium text-gray-700 dark:text-neutral-200">
                      {historyCounts.content} 个内容 · {historyCounts.visit} 条观看记录
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-gray-500 dark:text-neutral-400">估算配额</span>
                    <span className="font-medium text-gray-700 dark:text-neutral-200">
                      {formatStorageSize(storageHealth.quota)}
                    </span>
                  </div>

                  {/* 明细入口。上面的"当前使用量"是整个站点的总量（含缓存等），
                      看不出本扩展到底把空间花在哪，所以单给一个按类别拆开的入口。 */}
                  <div className="flex items-center justify-between gap-3 border-t border-gray-100 pt-3 dark:border-neutral-800">
                    <span className="min-w-0 text-xs leading-relaxed text-gray-500 dark:text-neutral-400">
                      「当前使用量」是整个站点的总量，含不属于本扩展的缓存。
                      想看本扩展的空间花在哪、以及清理图片归档，点右侧。
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleOpenBreakdown()}
                      className="shrink-0 rounded-full border border-gray-200 px-3 py-1 text-xs text-gray-600 transition-colors hover:border-pink-300 hover:text-pink-500 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-pink-500/50 dark:hover:text-pink-400"
                    >
                      查看存储明细
                    </button>
                  </div>

                  {storageHealth.unlimitedStorageGranted && !storageHealth.persisted && (
                    <div className="rounded-lg border border-blue-200 dark:border-blue-500/20 bg-blue-50 dark:bg-blue-500/10 px-3 py-2 text-blue-700 dark:text-blue-300">
                      unlimitedStorage
                      权限已生效。浏览器未单独标记持久化存储不影响扩展存储保护，无需手动授权。
                    </div>
                  )}

                  {!storageHealth.storageProtected && (
                    <div className="rounded-lg border border-amber-200 dark:border-amber-500/20 bg-amber-50 dark:bg-amber-500/10 px-3 py-2 text-amber-700 dark:text-amber-300">
                      未检测到 unlimitedStorage
                      权限或浏览器持久化存储。请先重新加载扩展，并建议定期导出 JSON 或配置 WebDAV
                      备份。
                    </div>
                  )}

                  {(storageHealth.errors.length > 0 || storageHealthError) && (
                    <div className="rounded-lg border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-red-700 dark:text-red-300">
                      存储状态检测出现异常：
                      {storageHealthError ||
                        storageHealth.errors.map((error) => error.name).join("、")}
                      。建议立即导出 JSON 或检查 WebDAV 备份。
                    </div>
                  )}

                  {storageHealth.lastWarning && (
                    <div className="rounded-lg border border-red-200 dark:border-red-500/20 bg-red-50 dark:bg-red-500/10 px-3 py-2 text-red-700 dark:text-red-300">
                      最近一次存储写入异常：{storageHealth.lastWarning.name}（
                      {new Date(storageHealth.lastWarning.timestamp).toLocaleString()}
                      ）。建议立即检查备份。
                    </div>
                  )}

                  {historyMigrationSkipped > 0 && (
                    <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                      数据升级时有 {historyMigrationSkipped}
                      条历史记录因字段不完整未转换为观看事件。原始记录仍保留，建议先导出备份。
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-sm text-gray-500 dark:text-neutral-400">
                  {isCheckingStorage ? "正在检查存储状态..." : storageHealthError || "暂无存储信息"}
                </p>
              )}
            </div>
          </div>

          {/* 危险区：把不可逆操作集中隔离。
              此前「同步删除」排在右栏「同步与界面偏好」里、只有一行小字说明，
              而它实际会调用 B站 接口永久删掉账号里的观看记录；重置扩展同样不可逆。 */}
          <div className="w-full rounded-xl border border-red-200 bg-red-50/40 dark:border-red-500/30 dark:bg-red-500/5">
            <div className="border-b border-red-100 p-5 dark:border-red-500/20">
              <h3 className="flex items-center gap-2 text-base font-bold text-red-700 dark:text-red-300">
                <AlertTriangle className="h-4 w-4" />
                危险操作
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-red-600/90 dark:text-red-300/80">
                下面这些操作不可逆。重置有 {RESET_UNDO_SECONDS} 秒反悔时间，删除类操作请确认后再开启。
              </p>
            </div>

            <div className="space-y-5 p-5">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800 dark:text-neutral-100">
                    删除本地记录时，同时删除 B站 上的记录
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-neutral-400">
                    开启后，在「历史记录」页删除一条记录会调用 B站 接口，把这条记录从你的 B站
                    账号里删掉，
                    <span className="font-medium text-red-600 dark:text-red-300">无法恢复</span>
                    。默认关闭。
                  </p>
                </div>
                <label className="relative mt-1 inline-flex shrink-0 cursor-pointer items-center">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={isSyncDelete}
                    onChange={handleSyncDeleteChange}
                  />
                  <div className="h-6 w-11 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer peer-checked:after:translate-x-full peer-checked:after:border-white peer-checked:bg-red-600 peer-focus:outline-none dark:bg-neutral-700 dark:after:border-neutral-600"></div>
                </label>
              </div>

              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800 dark:text-neutral-100">
                    B站 上删除记录时，同时删除本地记录
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-neutral-400">
                    你在 B站 网页端删掉一条观看记录后，本地该内容的全部观看记录也会被删除。
                    默认关闭。
                  </p>
                </div>
                <label className="relative mt-1 inline-flex shrink-0 cursor-pointer items-center">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={isSyncDeleteFromBilibili}
                    onChange={handleSyncDeleteFromBilibiliChange}
                  />
                  <div className="h-6 w-11 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer peer-checked:after:translate-x-full peer-checked:after:border-white peer-checked:bg-red-600 peer-focus:outline-none dark:bg-neutral-700 dark:after:border-neutral-600"></div>
                </label>
              </div>

              <div className="flex items-start justify-between gap-4 border-t border-red-100 pt-5 dark:border-red-500/20">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800 dark:text-neutral-100">重置扩展</p>
                  <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-neutral-400">
                    清空全部本地数据与设置：历史记录、收藏、关注，以及 WebDAV 凭据。
                    仅保留本地备份目录授权。确认后有 {RESET_UNDO_SECONDS} 秒可以撤销。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setShowConfirmDialog(true)}
                  disabled={isResetLoading}
                  className="shrink-0 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-500/40 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-500/10"
                >
                  重置扩展
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* 右列：同步与界面偏好 */}
        <div className="space-y-6">
          <div className="border-b border-gray-200 dark:border-neutral-800 pb-2 mb-4">
            <h2 className="text-base font-bold text-gray-800 dark:text-neutral-200 flex items-center gap-2">
              <RefreshCw className="w-5 h-5 text-fuchsia-500" />
              同步与界面偏好
            </h2>
          </div>

          {/* 历史记录同步间隔。
              旧版把 ± 步进器当主控件：一次只走 1 分钟（设 30 分钟要点 29 次）、
              "单位：分钟"孤零零挂在标题下、预设还挤在底部一条浅色横条里。
              新版：预设胶囊为主（语义化标签 + 明确的选中态），自定义才展开输入框。 */}
          <div className="w-full rounded-xl border border-gray-100 bg-gray-50 p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <h3 className="text-base font-medium text-gray-800 dark:text-neutral-100">
              历史记录同步间隔
            </h3>
            <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
              每隔多久自动拉取一次你的 B站 观看历史
            </p>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              {SYNC_INTERVAL_PRESETS.map((option) => {
                const active = Number(syncInterval) === option.minutes;
                return (
                  <button
                    key={option.minutes}
                    type="button"
                    aria-pressed={active}
                    onClick={() => void handleSyncIntervalChange(option.minutes)}
                    className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                      active
                        ? "border-fuchsia-300 bg-fuchsia-50 font-medium text-fuchsia-700 dark:border-fuchsia-500/40 dark:bg-fuchsia-500/10 dark:text-fuchsia-300"
                        : "border-gray-200 text-gray-600 hover:border-fuchsia-200 hover:text-fuchsia-600 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-fuchsia-500/30 dark:hover:text-fuchsia-300"
                    }`}
                  >
                    {option.label}
                  </button>
                );
              })}

              <button
                type="button"
                aria-pressed={showCustomInterval}
                aria-expanded={showCustomInterval}
                onClick={() => setCustomIntervalOpen((open) => !open)}
                className={`inline-flex items-center gap-1 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
                  showCustomInterval
                    ? "border-fuchsia-300 bg-fuchsia-50 font-medium text-fuchsia-700 dark:border-fuchsia-500/40 dark:bg-fuchsia-500/10 dark:text-fuchsia-300"
                    : "border-gray-200 text-gray-600 hover:border-fuchsia-200 hover:text-fuchsia-600 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-fuchsia-500/30 dark:hover:text-fuchsia-300"
                }`}
              >
                自定义
                <ChevronDown
                  className={`h-3 w-3 transition-transform ${
                    showCustomInterval ? "rotate-180" : ""
                  }`}
                />
              </button>
            </div>

            {showCustomInterval ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <input
                  type="number"
                  min={1}
                  aria-label="自定义同步间隔（分钟）"
                  value={syncInterval}
                  onChange={(e) => handleSyncIntervalChange(e.target.value)}
                  className="w-24 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm tabular-nums text-gray-800 outline-none transition-colors focus:border-fuchsia-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
                />
                <span className="text-sm text-gray-500 dark:text-neutral-400">分钟</span>
                {Number(syncInterval) === 1 ? (
                  <span className="text-xs text-amber-600 dark:text-amber-400">
                    每分钟一次，对 B站 的请求最频繁
                  </span>
                ) : null}
              </div>
            ) : null}

            <p className="mt-4 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
              间隔越短，同一视频的重复观看越不容易漏记，但请求 B站 也越频繁。
              后台每分钟检查一次任务，到点才真正抓取。
            </p>
          </div>

          {/* 关注列表自动同步。后台早就在读这两个键了（默认开启 / 每天一次），
              只是界面上一直没有入口——想关掉自动请求 B站 都做不到。 */}
          <div className="w-full rounded-xl bg-gray-50 dark:bg-neutral-900 shadow-sm border border-gray-100 dark:border-neutral-800">
            <div className="flex items-center justify-between p-5">
              <div className="pr-4">
                <h3 className="text-base font-medium text-gray-800 dark:text-neutral-100">
                  关注列表自动同步
                </h3>
                <p className="mt-1 text-xs text-gray-400 dark:text-neutral-500">
                  关闭后不再自动抓取关注变化，仍可在「关注列表」页手动同步
                </p>
              </div>
              <label className="relative inline-flex shrink-0 cursor-pointer items-center">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={followingAutoSync}
                  onChange={handleFollowingAutoSyncChange}
                />
                <div className="w-11 h-6 bg-gray-200 dark:bg-neutral-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 dark:after:border-neutral-600 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            <div className="border-t border-gray-100 px-5 py-4 dark:border-neutral-800">
              <p className="text-xs text-gray-500 dark:text-neutral-400">同步间隔</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {FOLLOWING_INTERVAL_PRESETS.map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    disabled={!followingAutoSync}
                    onClick={() => void handleFollowingIntervalChange(minutes)}
                    className={`rounded-full px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      followingIntervalMinutes === minutes
                        ? "bg-blue-50 font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-300"
                        : "text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                    }`}
                  >
                    {FOLLOWING_INTERVAL_LABELS[minutes]}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
                关注变动（取关 / 改名 / 注销）只在同步时才会被发现，间隔越长越可能漏掉中间变化。
              </p>
            </div>
          </div>

          {/* 第三方曾用名查询（aicu.cc）。默认关闭，首次开启必须知情同意：
              这是本扩展唯一会把数据发到本机之外的功能（只发关注用户的 UID）。 */}
          <div className="w-full rounded-xl bg-gray-50 dark:bg-neutral-900 shadow-sm border border-gray-100 dark:border-neutral-800">
            <div className="flex items-center justify-between p-5">
              <div className="pr-4">
                <h3 className="text-base font-medium text-gray-800 dark:text-neutral-100">
                  关注列表曾用名查询（第三方）
                </h3>
                <p className="mt-1 text-xs text-gray-400 dark:text-neutral-500">
                  默认关闭。开启后可在「关注列表」页手动查询曾用名；查询会把该关注用户的 UID
                  发送给第三方站点 aicu.cc，逐条限速、可随时停止，查到的名字只存本机。
                  <a
                    className="ml-1 text-blue-500 hover:underline dark:text-blue-400"
                    href="https://www.aicu.cc/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    前往 aicu.cc 查看更多
                  </a>
                </p>
              </div>
              <label className="relative inline-flex shrink-0 cursor-pointer items-center">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={thirdPartyLookupEnabled}
                  onChange={handleThirdPartyLookupChange}
                />
                <div className="w-11 h-6 bg-gray-200 dark:bg-neutral-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 dark:after:border-neutral-600 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            {showThirdPartyConsent ? (
              <div className="border-t border-pink-200 bg-pink-50/60 px-5 py-4 dark:border-pink-500/30 dark:bg-pink-500/10">
                <p className="text-xs leading-relaxed text-gray-600 dark:text-neutral-300">
                  启用后，你在关注列表里查询某个用户的曾用名时，会把该用户的 UID 发送给第三方站点
                  aicu.cc。该站点由第三方维护、可能随时失效；返回的名字没有时间信息，顺序也不保证，
                  「未收录」不代表没改过名。所有查询都由你手动触发，不会自动运行。
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setShowThirdPartyConsent(false)}
                    className="rounded-full border border-gray-300 bg-white px-3 py-1.5 text-xs text-gray-600 transition-colors hover:bg-gray-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
                  >
                    取消
                  </button>
                  <button
                    type="button"
                    onClick={() => void confirmThirdPartyConsent()}
                    className="rounded-full bg-pink-500 px-3.5 py-1.5 text-xs font-medium text-white transition-colors hover:bg-pink-600"
                  >
                    我已了解，启用
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {/* 收藏夹自动同步。与关注/互动同一套交互，但**默认关闭**：
              只有全量同步才会做消失判定，而全量要翻完整个收藏夹并对消失条目逐条探测。
              日常走增量（拉到本地边界就停），定期才全量一次。 */}
          <div className="w-full rounded-xl bg-gray-50 dark:bg-neutral-900 shadow-sm border border-gray-100 dark:border-neutral-800">
            <div className="flex items-center justify-between p-5">
              <div className="pr-4">
                <h3 className="text-base font-medium text-gray-800 dark:text-neutral-100">
                  收藏夹自动同步
                </h3>
                <p className="mt-1 text-xs text-gray-400 dark:text-neutral-500">
                  默认关闭。开启后按间隔自动抓取收藏夹变化，仍可在「收藏夹」页手动同步。
                  日常只拉最新几页；每 7 天做一次全量，用来发现从收藏夹消失的视频。
                </p>
              </div>
              <label className="relative inline-flex shrink-0 cursor-pointer items-center">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={favAutoSync}
                  onChange={handleFavAutoSyncChange}
                />
                <div className="w-11 h-6 bg-gray-200 dark:bg-neutral-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 dark:after:border-neutral-600 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-blue-600"></div>
              </label>
            </div>

            <div className="border-t border-gray-100 px-5 py-4 dark:border-neutral-800">
              <p className="text-xs text-gray-500 dark:text-neutral-400">同步间隔</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {FAV_INTERVAL_PRESETS.map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    disabled={!favAutoSync}
                    onClick={() => void handleFavIntervalChange(minutes)}
                    className={`rounded-full px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      favIntervalMinutes === minutes
                        ? "bg-blue-50 font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-300"
                        : "text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                    }`}
                  >
                    {FAV_INTERVAL_LABELS[minutes]}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
                视频从收藏夹消失（你取消收藏、或内容被删）只在同步时才会被发现；
                间隔越长越可能漏掉中间变化。全量同步每 7 天自动跑一次。
              </p>
            </div>
          </div>

          {/* 点赞 / 投币互动记录自动同步。B 站只给最近 20 条，掉出窗口就永远拿不回来，
              所以默认间隔比关注列表密得多。 */}
          <div className="w-full rounded-xl bg-gray-50 dark:bg-neutral-900 shadow-sm border border-gray-100 dark:border-neutral-800">
            <div className="flex items-center justify-between p-5">
              <div className="pr-4">
                <h3 className="text-base font-medium text-gray-800 dark:text-neutral-100">
                  点赞与投币自动同步
                </h3>
                <p className="mt-1 text-xs text-gray-400 dark:text-neutral-500">
                  B 站只保留最近 20 条点赞与投币记录，掉出这个窗口的条目在 B 站上再也查不到。
                  关闭后不再自动抓取，仍可在「互动记录」页手动同步
                </p>
              </div>
              <label className="relative inline-flex shrink-0 cursor-pointer items-center">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={interactionAutoSync}
                  onChange={handleInteractionAutoSyncChange}
                />
                <div className="w-11 h-6 bg-gray-200 dark:bg-neutral-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 dark:after:border-neutral-600 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-pink-500"></div>
              </label>
            </div>

            <div className="border-t border-gray-100 px-5 py-4 dark:border-neutral-800">
              <p className="text-xs text-gray-500 dark:text-neutral-400">同步间隔</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {INTERACTION_INTERVAL_PRESETS.map((minutes) => (
                  <button
                    key={minutes}
                    type="button"
                    disabled={!interactionAutoSync}
                    onClick={() => void handleInteractionIntervalChange(minutes)}
                    className={`rounded-full px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      interactionIntervalMinutes === minutes
                        ? "bg-pink-50 font-medium text-pink-600 dark:bg-pink-500/10 dark:text-pink-300"
                        : "text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                    }`}
                  >
                    {INTERACTION_INTERVAL_LABELS[minutes]}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
                间隔越长，新点赞越可能在两次同步之间被挤出 20 条窗口，那条记录就永久丢失了。
                同步时会顺带对掉出列表的条目做二次探测，因此间隔也不是越短越好。
                另外，每次你访问 B 站个人主页（space.bilibili.com）时会顺手补抓一次
                （半小时最多一次、只抓不判定），以降低窗口滑走导致丢记录的概率。
              </p>
            </div>
          </div>

          {/* 这里曾有「历史记录加载方式」与「界面管理（日期选择方式）」两张卡片。
              两者都已删除：加载方式与每行列数属于**每次浏览历史时才会调整**的设置，
              已经收在历史页工具栏的「历史视图设置」弹窗里（同一个 HISTORY_LOAD_MODE /
              GRID_COLUMNS，两处入口只会互相打架：这边即时生效，那边草稿后保存）。
              日期也只保留范围选择一种，`DATE_SELECTION_MODE` 连同单日分支一并移除。
              设置页因此变短，留下的都是"装完一次就不动"的配置。 */}

          {/* 侧边栏菜单管理：一行管一个菜单（显示开关 + 上下移动）。
              原来拆成「显示」和「顺序」两张列表，同一个菜单出现两次，
              卡片被撑到近千像素——合并后高度直接减半，也更符合"每行管一个菜单"的直觉。 */}
          <div className="w-full rounded-xl border border-gray-100 bg-gray-50 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <div className="p-5">
              <h3 className="mb-1 text-lg font-bold text-gray-800 dark:text-neutral-100">
                侧边栏菜单管理
              </h3>
              <p className="mb-4 text-sm text-gray-500 dark:text-neutral-400">
                勾选要显示的菜单项，用箭头调整顺序
              </p>

              <ul className="space-y-1">
                {menuOrder.map((title, index) => {
                  const hideable = HIDEABLE_MENU_TITLES.includes(title);
                  const shown = !hiddenMenus.includes(title);
                  return (
                    <li
                      key={title}
                      className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-1.5 dark:border-neutral-700 dark:bg-neutral-900"
                    >
                      <input
                        type="checkbox"
                        checked={shown}
                        disabled={!hideable}
                        onChange={(event) => void toggleHiddenMenu(title, !event.target.checked)}
                        aria-label={`显示「${title}」`}
                        title={hideable ? undefined : "「设置」不允许隐藏：隐藏后就没有入口改回来了"}
                        className="h-4 w-4 shrink-0 accent-pink-600 disabled:opacity-40 dark:accent-pink-500"
                      />
                      <span
                        className={`min-w-0 flex-1 truncate text-sm ${
                          shown
                            ? "text-gray-700 dark:text-neutral-200"
                            : "text-gray-400 line-through dark:text-neutral-500"
                        }`}
                      >
                        {title}
                      </span>
                      {!hideable ? (
                        <span className="shrink-0 text-[10px] text-gray-400 dark:text-neutral-500">
                          不可隐藏
                        </span>
                      ) : null}
                      <button
                        type="button"
                        disabled={index === 0}
                        onClick={() => void moveMenuItem(index, -1)}
                        title={`把「${title}」上移`}
                        aria-label={`把「${title}」上移`}
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-100 disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-neutral-800"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        disabled={index === menuOrder.length - 1}
                        onClick={() => void moveMenuItem(index, 1)}
                        title={`把「${title}」下移`}
                        aria-label={`把「${title}」下移`}
                        className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-gray-500 transition-colors hover:bg-gray-100 disabled:opacity-30 dark:text-neutral-400 dark:hover:bg-neutral-800"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                    </li>
                  );
                })}
              </ul>

              {/* 用户信息不是侧边栏菜单项（它固定在顶部），所以只有开关、没有排序 */}
              <div className="mt-4 border-t border-gray-200 pt-4 dark:border-neutral-800">
                <Checkbox
                  label="隐藏用户信息"
                  checked={isHideUserInfo}
                  onChange={handleHideUserInfoChange}
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* 确认弹窗 */}
      {/* ... (Dialog code) ... */}
      {/* 反悔窗口：危险操作先走倒计时，这几秒内点「撤销」＝什么都没发生 */}
      {resetCountdown !== null ? (
        <div className="fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-red-200 bg-white px-5 py-3 shadow-xl dark:border-red-500/40 dark:bg-neutral-900">
            <p className="text-sm text-gray-800 dark:text-neutral-100">
              将在{" "}
              <span className="font-semibold tabular-nums text-red-600 dark:text-red-300">
                {resetCountdown}
              </span>{" "}
              秒后重置扩展，届时全部本地数据与设置会被清空。
            </p>
            <button
              type="button"
              onClick={cancelReset}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-800"
            >
              撤销
            </button>
            <button
              type="button"
              onClick={() => void executeReset()}
              className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-700"
            >
              立即重置
            </button>
          </div>
        </div>
      ) : null}

      {showConfirmDialog && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 animate-in fade-in duration-200">
          <div className="bg-white dark:bg-neutral-900 p-6 rounded-xl shadow-xl max-w-sm w-full mx-4 border border-transparent dark:border-neutral-800">
            <h3 className="text-lg font-bold text-gray-900 dark:text-neutral-100 mb-2">
              确认重置扩展？
            </h3>
            <div className="mb-6 space-y-2 text-sm leading-relaxed text-gray-600 dark:text-neutral-300">
              <p>
                此操作将<span className="font-medium text-red-600 dark:text-red-400">永久删除</span>
                本地保存的全部数据：历史记录、收藏夹与收藏资源、订阅合集与合集视频、关注的 UP
                主与关注变动、消失档案、点赞与投币记录，以及全部设置和 WebDAV 凭据。
              </p>
              <p className="text-gray-500 dark:text-neutral-400">
                已选择的本地备份目录授权和目录中的备份文件会保留。
              </p>
              <p className="text-gray-500 dark:text-neutral-400">
                确认后还有 {RESET_UNDO_SECONDS} 秒可以撤销。
              </p>
            </div>
            {isResetLoading && (
              <p className="text-blue-600 mb-4 text-sm animate-pulse">{resetStatus}</p>
            )}
            <div className="flex justify-end space-x-3">
              <button
                onClick={() => setShowConfirmDialog(false)}
                className="px-4 py-2 text-sm text-gray-600 dark:text-neutral-300 hover:bg-gray-100 dark:hover:bg-neutral-800 rounded-lg transition-colors"
                disabled={isResetLoading}
              >
                取消
              </button>
              <button
                onClick={startResetCountdown}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors shadow-sm"
                disabled={isResetLoading}
              >
                确认重置
              </button>
            </div>
          </div>
        </div>
      )}

      {showResetResultDialog && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white dark:bg-neutral-900 p-6 rounded-xl shadow-xl max-w-sm w-full mx-4 text-center border border-transparent dark:border-neutral-800">
            <div className="w-12 h-12 bg-blue-100 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 rounded-full flex items-center justify-center mx-auto mb-4">
              <Check size={24} />
            </div>
            <p className="text-lg text-gray-800 dark:text-neutral-100 mb-6 font-medium">
              {resetResult}
            </p>
            <button
              onClick={() => {
                setShowResetResultDialog(false);
                if (resetSucceeded) window.location.reload();
              }}
              className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors font-medium"
            >
              {resetSucceeded ? "确定并重新加载" : "确定"}
            </button>
          </div>
        </div>
      )}
      <StorageBreakdownModal
        open={breakdownOpen}
        breakdown={breakdown}
        loading={isBreakdownLoading}
        error={breakdownError}
        onCleanup={handleCleanupAssets}
        onCleaned={() => toast.success("图片归档已清理")}
        onClose={() => setBreakdownOpen(false)}
      />
    </div>
  );
};

export default Settings;
