import { useState, useEffect, useLayoutEffect, useRef } from "react";
import {
  Check,
  ChevronDown,
  GripVertical,
  HardDrive,
  LoaderCircle,
  RotateCcw,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import {
  clearAllDatabaseTables,
  clearAssetsByKind,
  getAllFavFolders,
  getTotalHistoryCount,
} from "../utils/db";
import type { AssetKind } from "../utils/types";
import { getStorageValue, setStorageValue } from "../utils/storage";
import {
  SYNC_INTERVAL,
  HIDE_USER_INFO,
  HIDDEN_MENUS,
  SIDEBAR_MENU_ORDER,
  HISTORY_EVENT_MIGRATION_REPORT,
  HISTORY_LAST_SYNC,
  FOLLOWING_LAST_SYNC,
  FAVORITES_LAST_SYNC,
  INTERACTIONS_LAST_SYNC,
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
import { HIDEABLE_MENU_TITLES, SIDEBAR_MENU_TITLES } from "../components/Sidebar";
import { checkStorageHealth, formatStorageSize, StorageHealthReport } from "../utils/storageHealth";
import { buildStorageBreakdown, type StorageBreakdown } from "../utils/storageBreakdown";
import { StorageBreakdownModal } from "../components/StorageBreakdownModal";
import { Checkbox } from "../components/Checkbox";

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

type SettingsSyncKey = "history" | "following" | "favorites" | "interactions";
type DangerAction = "defaults" | "data" | "reset";

const DANGER_COPY: Record<
  DangerAction,
  { title: string; description: string; confirmWord: string; button: string }
> = {
  defaults: {
    title: "恢复默认设置",
    description:
      "只清空偏好设置：同步间隔、第三方查询开关、侧边栏顺序、WebDAV 凭据等。历史记录、收藏、关注等本地数据不会删除。",
    confirmWord: "恢复",
    button: "恢复默认设置",
  },
  data: {
    title: "清除全部本地数据",
    description:
      "清空 IndexedDB 中的历史记录、收藏、关注、消失档案和图片归档。偏好设置会保留，操作不可撤销。",
    confirmWord: "清除",
    button: "清除本地数据",
  },
  reset: {
    title: "彻底重置扩展",
    description:
      "清空全部本地数据和偏好设置，包括 WebDAV 凭据。已授权的本地备份目录本身会保留，但需要重新配置。",
    confirmWord: "重置",
    button: "彻底重置",
  },
};

const formatSyncTime = (timestamp: number | null): string => {
  if (!timestamp) return "尚未同步";
  return new Date(timestamp).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
};

const formatNextSync = (
  timestamp: number | null,
  intervalMinutes: number,
  enabled = true,
): string => {
  if (!enabled) return "自动同步已关闭";
  if (!timestamp || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return "等待首次同步";
  return `约 ${new Date(timestamp + intervalMinutes * 60_000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })}`;
};

const Settings = () => {
  const [dangerAction, setDangerAction] = useState<DangerAction | null>(null);
  const [dangerConfirmText, setDangerConfirmText] = useState("");
  const [syncBusy, setSyncBusy] = useState<Record<SettingsSyncKey, boolean>>({
    history: false,
    following: false,
    favorites: false,
    interactions: false,
  });
  const [lastSyncMap, setLastSyncMap] = useState<Record<SettingsSyncKey, number | null>>({
    history: null,
    following: null,
    favorites: null,
    interactions: null,
  });
  const [isHideUserInfo, setIsHideUserInfo] = useState(false);
  const [hiddenMenus, setHiddenMenus] = useState<string[]>([]);
  const [menuOrder, setMenuOrder] = useState<string[]>(SIDEBAR_MENU_TITLES);
  const [draggedMenu, setDraggedMenu] = useState<string | null>(null);
  const menuItemRefs = useRef<Map<string, HTMLLIElement>>(new Map());
  const previousMenuRects = useRef<Map<string, number>>(new Map());
  const menuOrderRef = useRef(menuOrder);
  const menuOrderDirtyRef = useRef(false);

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
      const [historyLast, followingLast, favoritesLast, interactionsLast] = await Promise.all([
        getStorageValue<number | null>(HISTORY_LAST_SYNC, null),
        getStorageValue<number | null>(FOLLOWING_LAST_SYNC, null),
        getStorageValue<number | null>(FAVORITES_LAST_SYNC, null),
        getStorageValue<number | null>(INTERACTIONS_LAST_SYNC, null),
      ]);
      setLastSyncMap({
        history: historyLast,
        following: followingLast,
        favorites: favoritesLast,
        interactions: interactionsLast,
      });
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

  useEffect(() => {
    // 加载设置
    const loadSettings = async () => {
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

  useEffect(() => {
    menuOrderRef.current = menuOrder;
  }, [menuOrder]);

  /** 记录重排前每一行的布局位置，供下方的 FLIP 动画计算位移 */
  const captureMenuRects = () => {
    const positions = new Map<string, number>();
    menuItemRefs.current.forEach((element, title) => {
      // offsetTop 不受正在进行的 transform 影响，连续拖动时不会把动画中途位置当成起点。
      positions.set(title, element.offsetTop);
    });
    previousMenuRects.current = positions;
  };

  /**
   * FLIP：重排后先让每行瞬间回到旧位置，再用 transform 动画滑到新位置。
   * 这样拖动时其他行会真实地上下让位，而不是只画一个目标高亮。
   */
  useLayoutEffect(() => {
    const previous = previousMenuRects.current;
    if (previous.size === 0) return;
    previousMenuRects.current = new Map();

    const timers: number[] = [];
    menuItemRefs.current.forEach((element, title) => {
      const before = previous.get(title);
      if (before === undefined) return;
      const after = element.offsetTop;
      const offset = before - after;
      if (Math.abs(offset) < 1) return;

      element.style.transition = "none";
      element.style.transform = `translateY(${offset}px)`;
      // 强制读取一次布局，确保浏览器把旧位置作为动画起点。
      void element.offsetHeight;
      element.style.transition = "transform 180ms cubic-bezier(0.2, 0, 0, 1)";
      element.style.transform = "";

      timers.push(
        window.setTimeout(() => {
          element.style.transition = "";
          element.style.transform = "";
        }, 220),
      );
    });

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [menuOrder]);

  const persistMenuOrder = (next: string[]) => {
    menuOrderRef.current = next;
    void setStorageValue(SIDEBAR_MENU_ORDER, next);
  };

  const handleMenuDragStart = (event: React.DragEvent<HTMLElement>, title: string) => {
    const row = menuItemRefs.current.get(title);
    if (row) {
      // 用原行做拖动图，但把抓取点换算成行内坐标：
      // 手抓在右侧手柄时，拖动图仍然从原来的左边缘开始，而不是跳到鼠标右侧。
      const rect = row.getBoundingClientRect();
      const grabX = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
      const grabY = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
      event.dataTransfer.setDragImage(row, grabX, grabY);
    }
    setDraggedMenu(title);
    menuOrderDirtyRef.current = false;
    captureMenuRects();
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", title);
  };

  const handleMenuDragOver = (event: React.DragEvent<HTMLElement>, title: string) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (!draggedMenu || draggedMenu === title) return;

    const target = menuItemRefs.current.get(title);
    if (!target) return;

    const rect = target.getBoundingClientRect();
    const dropAfter = event.clientY > rect.top + rect.height / 2;
    const from = menuOrderRef.current.indexOf(draggedMenu);
    const over = menuOrderRef.current.indexOf(title);
    if (from < 0 || over < 0) return;

    let insertAt = dropAfter ? over + 1 : over;
    if (insertAt > from) insertAt -= 1;
    if (insertAt === from) return;

    captureMenuRects();
    const next = [...menuOrderRef.current];
    const [moved] = next.splice(from, 1);
    next.splice(insertAt, 0, moved);
    menuOrderRef.current = next;
    menuOrderDirtyRef.current = true;
    setMenuOrder(next);
  };

  const handleMenuDrop = (event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    if (menuOrderDirtyRef.current) {
      persistMenuOrder(menuOrderRef.current);
      menuOrderDirtyRef.current = false;
    }
    setDraggedMenu(null);
  };

  const handleMenuDragEnd = () => {
    if (menuOrderDirtyRef.current) {
      persistMenuOrder(menuOrderRef.current);
      menuOrderDirtyRef.current = false;
    }
    setDraggedMenu(null);
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

  const runManualSync = async (key: SettingsSyncKey) => {
    if (syncBusy[key]) return;
    setSyncBusy((current) => ({ ...current, [key]: true }));
    try {
      let response: { success?: boolean; error?: string; message?: string } | undefined;
      if (key === "history") {
        response = await browser.runtime.sendMessage({ action: "syncHistory", isFullSync: false });
      } else if (key === "following") {
        response = await browser.runtime.sendMessage({ action: "syncFollowing" });
      } else if (key === "interactions") {
        response = await browser.runtime.sendMessage({ action: "syncInteractions" });
      } else {
        const folders = await getAllFavFolders();
        if (folders.length === 0) {
          toast.error("还没有收藏夹，请先在收藏夹页同步一次");
          return;
        }
        response = await browser.runtime.sendMessage({
          action: "syncAllFavoriteFolders",
          folders: folders.map((folder) => ({ id: folder.id, title: folder.title })),
          isFullSync: false,
        });
      }

      if (response?.success === false) {
        throw new Error(response.error || "同步失败");
      }

      const now = Date.now();
      setLastSyncMap((current) => ({ ...current, [key]: now }));
      const storageKey =
        key === "history"
          ? HISTORY_LAST_SYNC
          : key === "following"
            ? FOLLOWING_LAST_SYNC
            : key === "favorites"
              ? FAVORITES_LAST_SYNC
              : INTERACTIONS_LAST_SYNC;
      await setStorageValue(storageKey, now);
      toast.success(response?.message || "同步完成");
    } catch (error) {
      console.error("手动同步失败:", error);
      toast.error(error instanceof Error ? error.message : "同步失败，请稍后重试");
    } finally {
      setSyncBusy((current) => ({ ...current, [key]: false }));
    }
  };

  const executeDangerAction = async () => {
    if (!dangerAction) return;
    const copy = DANGER_COPY[dangerAction];
    if (dangerConfirmText.trim() !== copy.confirmWord) return;

    try {
      setIsResetLoading(true);
      setResetSucceeded(false);

      if (dangerAction === "defaults") {
        setResetStatus("正在恢复默认设置...");
        await browser.storage.local.clear();
        setResetResult("默认设置已恢复，本地数据没有删除。");
      } else if (dangerAction === "data") {
        setResetStatus("正在清除本地数据...");
        await clearAllDatabaseTables();
        setResetResult("本地数据已清除，偏好设置保留。");
      } else {
        setResetStatus("正在清除本地数据...");
        await clearAllDatabaseTables();
        setResetStatus("正在清理偏好设置...");
        await browser.storage.local.clear();
        setResetResult("彻底重置完成，本地数据与设置已清空。");
      }

      setResetSucceeded(true);
      setDangerAction(null);
      setDangerConfirmText("");
    } catch (error) {
      console.error("执行清理操作失败:", error);
      setResetSucceeded(false);
      setResetResult(error instanceof Error ? error.message : "操作失败，请重试");
    } finally {
      setIsResetLoading(false);
      setResetStatus("");
      setShowResetResultDialog(true);
    }
  };

  return (
    <div className="p-6 pb-20 min-h-screen bg-gray-50/30 dark:bg-[#0a0a0a] text-gray-900 dark:text-neutral-100 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-xl font-bold text-gray-900 dark:text-neutral-100">设置</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-neutral-400">
          数据、同步与界面偏好。改动会立即生效，不需要保存。
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 items-start lg:grid-cols-2">
        <div className="space-y-6">
          <div className="border-b border-gray-200 pb-2 dark:border-neutral-800">
            <h2 className="flex items-center gap-2 text-base font-bold text-gray-800 dark:text-neutral-200">
              <HardDrive className="h-5 w-5 text-blue-500" />
              数据与存储
            </h2>
          </div>

          <div className="w-full rounded-xl border border-gray-100 bg-gray-50 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <div className="p-5">
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-base font-bold text-gray-800 dark:text-neutral-100">
                    本地存储保护
                  </h3>
                  <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
                    检查 IndexedDB 持久化状态和浏览器可用容量
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void refreshStorageHealth(true)}
                  disabled={isCheckingStorage}
                  className="rounded-lg p-2 text-gray-500 transition-colors hover:bg-blue-50 hover:text-blue-600 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-blue-500/10 dark:hover:text-blue-400"
                  title="刷新存储保护状态"
                >
                  <RefreshCw className={`h-4 w-4 ${isCheckingStorage ? "animate-spin" : ""}`} />
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

                  <p className="border-t border-gray-100 pt-3 text-xs leading-relaxed text-gray-500 dark:border-neutral-800 dark:text-neutral-400">
                    「当前使用量」是浏览器统计的整个扩展占用，包含数据库和文件开销；
                    本扩展业务数据的估算请查看「存储明细」。
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleOpenBreakdown()}
                    className="w-full rounded-lg border border-gray-200 px-3 py-2 text-sm text-gray-700 transition-colors hover:border-pink-300 hover:text-pink-600 dark:border-neutral-700 dark:text-neutral-200 dark:hover:border-pink-500/50 dark:hover:text-pink-300"
                  >
                    查看存储明细
                  </button>

                  {storageHealth.unlimitedStorageGranted && !storageHealth.persisted ? (
                    <p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-700 dark:border-blue-500/20 dark:bg-blue-500/10 dark:text-blue-300">
                      unlimitedStorage 权限已生效；浏览器未单独标记持久化存储不影响扩展存储保护。
                    </p>
                  ) : null}
                  {!storageHealth.storageProtected ? (
                    <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                      未检测到 unlimitedStorage 权限或持久化存储，请重新加载扩展，并定期备份。
                    </p>
                  ) : null}
                  {(storageHealth.errors.length > 0 || storageHealthError) && (
                    <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
                      存储状态检测异常：
                      {storageHealthError ||
                        storageHealth.errors.map((error) => error.name).join("、")}
                    </p>
                  )}
                  {storageHealth.lastWarning ? (
                    <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300">
                      最近一次写入异常：{storageHealth.lastWarning.name}（
                      {new Date(storageHealth.lastWarning.timestamp).toLocaleString()}）
                    </p>
                  ) : null}
                  {historyMigrationSkipped > 0 ? (
                    <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-300">
                      数据升级时有 {historyMigrationSkipped} 条历史记录字段不完整，原始记录仍保留。
                    </p>
                  ) : null}
                </div>
              ) : (
                <p className="text-sm text-gray-500 dark:text-neutral-400">
                  {isCheckingStorage ? "正在检查存储状态..." : storageHealthError || "暂无存储信息"}
                </p>
              )}
            </div>
          </div>

          <div className="w-full rounded-xl border border-red-200 bg-red-50/40 dark:border-red-500/30 dark:bg-red-500/5">
            <div className="border-b border-red-100 p-5 dark:border-red-500/20">
              <h3 className="flex items-center gap-2 text-base font-bold text-red-700 dark:text-red-300">
                <ShieldAlert className="h-4 w-4" />
                高级操作
              </h3>
              <p className="mt-1 text-xs leading-relaxed text-red-600/90 dark:text-red-300/80">
                这些操作会清空本地数据或设置，执行后不能撤销，需要手动输入确认。
              </p>
            </div>
            <div className="divide-y divide-red-100/80 dark:divide-red-500/20">
              <div className="flex items-start justify-between gap-4 p-5">
                <div>
                  <p className="text-sm font-medium text-gray-800 dark:text-neutral-100">
                    恢复默认设置
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-neutral-400">
                    只清空同步、界面与备份配置，本地记录保留。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setDangerAction("defaults");
                    setDangerConfirmText("");
                  }}
                  className="shrink-0 rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-sm text-gray-700 transition-colors hover:bg-gray-50 dark:border-neutral-600 dark:bg-transparent dark:text-neutral-200 dark:hover:bg-neutral-800"
                >
                  重置设置
                </button>
              </div>
              <div className="flex items-start justify-between gap-4 p-5">
                <div>
                  <p className="text-sm font-medium text-gray-800 dark:text-neutral-100">
                    清除全部本地数据
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-neutral-400">
                    清空历史、收藏、关注、档案和图片归档，偏好设置保留。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setDangerAction("data");
                    setDangerConfirmText("");
                  }}
                  className="shrink-0 rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm text-red-600 transition-colors hover:bg-red-50 dark:border-red-500/40 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-500/10"
                >
                  清除数据
                </button>
              </div>
              <div className="flex items-start justify-between gap-4 p-5">
                <div>
                  <p className="text-sm font-medium text-gray-800 dark:text-neutral-100">
                    彻底重置
                  </p>
                  <p className="mt-1 text-xs leading-relaxed text-gray-500 dark:text-neutral-400">
                    清空全部数据和设置，包括 WebDAV 凭据；本地备份目录授权仍在。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setDangerAction("reset");
                    setDangerConfirmText("");
                  }}
                  className="shrink-0 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-red-700"
                >
                  彻底重置
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="border-b border-gray-200 pb-2 dark:border-neutral-800">
            <h2 className="flex items-center gap-2 text-base font-bold text-gray-800 dark:text-neutral-200">
              <RefreshCw className="h-5 w-5 text-fuchsia-500" />
              自动同步
            </h2>
          </div>

          <div className="w-full rounded-xl border border-gray-100 bg-gray-50 p-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-base font-medium text-gray-800 dark:text-neutral-100">
                  历史记录
                </h3>
                <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
                  每隔多久自动拉取一次观看历史
                </p>
              </div>
              <button
                type="button"
                onClick={() => void runManualSync("history")}
                disabled={syncBusy.history}
                className="inline-flex items-center gap-1.5 rounded-lg bg-fuchsia-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-fuchsia-600 disabled:opacity-60"
              >
                {syncBusy.history ? (
                  <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {syncBusy.history ? "同步中…" : "立即同步"}
              </button>
            </div>

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
                  className={`h-3 w-3 transition-transform ${showCustomInterval ? "rotate-180" : ""}`}
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
              </div>
            ) : null}

            <div className="mt-4 grid grid-cols-2 gap-2 rounded-lg bg-white/70 px-3 py-2 text-xs dark:bg-neutral-950/50">
              <span className="text-gray-500 dark:text-neutral-400">
                上次：{formatSyncTime(lastSyncMap.history)}
              </span>
              <span className="text-right text-gray-500 dark:text-neutral-400">
                下次：{formatNextSync(lastSyncMap.history, Number(syncInterval))}
              </span>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
              间隔越短，重复观看越不容易漏记，但请求 B站 也越频繁。后台每分钟检查一次，到点才抓取。
            </p>
          </div>

          <div className="w-full rounded-xl border border-gray-100 bg-gray-50 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <div className="border-b border-gray-100 p-5 dark:border-neutral-800">
              <h3 className="text-base font-medium text-gray-800 dark:text-neutral-100">
                其他自动同步
              </h3>
              <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
                关闭自动同步后仍可在对应页面手动同步；这里也可以直接立即同步。
              </p>
            </div>

            <div className="divide-y divide-gray-100 dark:divide-neutral-800">
              <div className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-gray-800 dark:text-neutral-100">关注列表</p>
                    <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
                      取关、改名、注销只在同步时才会被发现
                    </p>
                  </div>
                  <label className="relative mt-0.5 inline-flex shrink-0 cursor-pointer items-center">
                    <input
                      type="checkbox"
                      className="peer sr-only"
                      checked={followingAutoSync}
                      onChange={handleFollowingAutoSyncChange}
                    />
                    <div className="h-6 w-11 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:after:translate-x-full peer-checked:after:border-white peer-checked:bg-blue-600 dark:bg-neutral-700 dark:after:border-neutral-600"></div>
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {FOLLOWING_INTERVAL_PRESETS.map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      disabled={!followingAutoSync}
                      onClick={() => void handleFollowingIntervalChange(minutes)}
                      className={`rounded-full px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        followingIntervalMinutes === minutes
                          ? "bg-blue-50 font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-300"
                          : "text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                      }`}
                    >
                      {FOLLOWING_INTERVAL_LABELS[minutes]}
                    </button>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500 dark:text-neutral-400">
                  <span>
                    上次：{formatSyncTime(lastSyncMap.following)} · 下次：
                    {formatNextSync(lastSyncMap.following, followingIntervalMinutes, followingAutoSync)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void runManualSync("following")}
                    disabled={syncBusy.following}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1 text-xs text-gray-600 transition-colors hover:border-blue-300 hover:text-blue-600 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-blue-500/40"
                  >
                    {syncBusy.following ? (
                      <LoaderCircle className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    {syncBusy.following ? "同步中…" : "立即同步"}
                  </button>
                </div>
              </div>

              <div className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-gray-800 dark:text-neutral-100">收藏夹</p>
                    <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
                      日常增量，每 7 天一次全量来发现消失内容
                    </p>
                  </div>
                  <label className="relative mt-0.5 inline-flex shrink-0 cursor-pointer items-center">
                    <input
                      type="checkbox"
                      className="peer sr-only"
                      checked={favAutoSync}
                      onChange={handleFavAutoSyncChange}
                    />
                    <div className="h-6 w-11 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:after:translate-x-full peer-checked:after:border-white peer-checked:bg-blue-600 dark:bg-neutral-700 dark:after:border-neutral-600"></div>
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {FAV_INTERVAL_PRESETS.map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      disabled={!favAutoSync}
                      onClick={() => void handleFavIntervalChange(minutes)}
                      className={`rounded-full px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        favIntervalMinutes === minutes
                          ? "bg-blue-50 font-medium text-blue-600 dark:bg-blue-500/10 dark:text-blue-300"
                          : "text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                      }`}
                    >
                      {FAV_INTERVAL_LABELS[minutes]}
                    </button>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500 dark:text-neutral-400">
                  <span>
                    上次：{formatSyncTime(lastSyncMap.favorites)} · 下次：
                    {formatNextSync(lastSyncMap.favorites, favIntervalMinutes, favAutoSync)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void runManualSync("favorites")}
                    disabled={syncBusy.favorites}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1 text-xs text-gray-600 transition-colors hover:border-blue-300 hover:text-blue-600 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-blue-500/40"
                  >
                    {syncBusy.favorites ? (
                      <LoaderCircle className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    {syncBusy.favorites ? "同步中…" : "立即同步"}
                  </button>
                </div>
              </div>

              <div className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-medium text-gray-800 dark:text-neutral-100">点赞与投币</p>
                    <p className="mt-1 text-xs text-gray-500 dark:text-neutral-400">
                      B站 只保留最近 20 条，间隔太长会永久漏记
                    </p>
                  </div>
                  <label className="relative mt-0.5 inline-flex shrink-0 cursor-pointer items-center">
                    <input
                      type="checkbox"
                      className="peer sr-only"
                      checked={interactionAutoSync}
                      onChange={handleInteractionAutoSyncChange}
                    />
                    <div className="h-6 w-11 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:after:translate-x-full peer-checked:after:border-white peer-checked:bg-pink-500 dark:bg-neutral-700 dark:after:border-neutral-600"></div>
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {INTERACTION_INTERVAL_PRESETS.map((minutes) => (
                    <button
                      key={minutes}
                      type="button"
                      disabled={!interactionAutoSync}
                      onClick={() => void handleInteractionIntervalChange(minutes)}
                      className={`rounded-full px-3 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        interactionIntervalMinutes === minutes
                          ? "bg-pink-50 font-medium text-pink-600 dark:bg-pink-500/10 dark:text-pink-300"
                          : "text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                      }`}
                    >
                      {INTERACTION_INTERVAL_LABELS[minutes]}
                    </button>
                  ))}
                </div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500 dark:text-neutral-400">
                  <span>
                    上次：{formatSyncTime(lastSyncMap.interactions)} · 下次：
                    {formatNextSync(lastSyncMap.interactions, interactionIntervalMinutes, interactionAutoSync)}
                  </span>
                  <button
                    type="button"
                    onClick={() => void runManualSync("interactions")}
                    disabled={syncBusy.interactions}
                    className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-2.5 py-1 text-xs text-gray-600 transition-colors hover:border-pink-300 hover:text-pink-600 disabled:opacity-60 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-pink-500/40"
                  >
                    {syncBusy.interactions ? (
                      <LoaderCircle className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    {syncBusy.interactions ? "同步中…" : "立即同步"}
                  </button>
                </div>
              </div>
            </div>
          </div>

      <div className="border-b border-gray-200 pb-2 dark:border-neutral-800">
        <h2 className="flex items-center gap-2 text-base font-bold text-gray-800 dark:text-neutral-200">
          <ShieldAlert className="h-5 w-5 text-pink-500" />
          隐私与第三方
            </h2>
          </div>

          <div className="w-full rounded-xl border border-gray-100 bg-gray-50 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
            <div className="flex items-center justify-between p-5">
              <div className="pr-4">
                <h3 className="text-base font-medium text-gray-800 dark:text-neutral-100">
                  关注列表曾用名查询（第三方）
                </h3>
                <p className="mt-1 text-xs text-gray-400 dark:text-neutral-500">
                  默认关闭。开启后手动查询时，会把关注用户的 UID 发送给 aicu.cc，逐条限速、可随时停止。
                  <a
                    className="ml-1 text-blue-500 hover:underline dark:text-blue-400"
                    href="https://www.aicu.cc/"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    前往 aicu.cc
                  </a>
                </p>
              </div>
              <label className="relative inline-flex shrink-0 cursor-pointer items-center">
                <input
                  type="checkbox"
                  className="peer sr-only"
                  checked={thirdPartyLookupEnabled}
                  onChange={handleThirdPartyLookupChange}
                />
                <div className="h-6 w-11 rounded-full bg-gray-200 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:border after:border-gray-300 after:bg-white after:transition-all after:content-[''] peer-checked:after:translate-x-full peer-checked:after:border-white peer-checked:bg-blue-600 dark:bg-neutral-700 dark:after:border-neutral-600"></div>
              </label>
            </div>

            {showThirdPartyConsent ? (
              <div className="border-t border-pink-200 bg-pink-50/60 px-5 py-4 dark:border-pink-500/30 dark:bg-pink-500/10">
                <p className="text-xs leading-relaxed text-gray-600 dark:text-neutral-300">
                  启用后，查询某个用户的曾用名时会把该用户的 UID 发送给第三方站点 aicu.cc。
                  该站点由第三方维护、可能随时失效；返回的名字没有时间信息，顺序也不保证。
                  所有查询都由你手动触发，不会自动运行。
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

      <div>
        <div className="border-b border-gray-200 pb-2 dark:border-neutral-800">
          <h2 className="flex items-center gap-2 text-base font-bold text-gray-800 dark:text-neutral-200">
            <RotateCcw className="h-5 w-5 text-emerald-500" />
            界面
          </h2>
        </div>

        <div className="mt-4 w-full rounded-xl border border-gray-100 bg-gray-50 shadow-sm dark:border-neutral-800 dark:bg-neutral-900">
          <div className="p-5">
            <h3 className="mb-1 text-base font-bold text-gray-800 dark:text-neutral-100">
              侧边栏与用户信息
            </h3>
            <p className="mb-4 text-xs text-gray-500 dark:text-neutral-400">
              勾选要显示的菜单项，拖拽右侧手柄调整顺序；「设置」不可隐藏。
            </p>

            <ul className="space-y-1">
              {menuOrder.map((title) => {
                const hideable = HIDEABLE_MENU_TITLES.includes(title);
                const shown = !hiddenMenus.includes(title);
                const isDragging = draggedMenu === title;
                return (
                  <li
                    key={title}
                    ref={(element) => {
                      if (element) {
                        menuItemRefs.current.set(title, element);
                      } else {
                        menuItemRefs.current.delete(title);
                      }
                    }}
                    onDragOver={(event) => handleMenuDragOver(event, title)}
                    onDrop={handleMenuDrop}
                    className={`flex items-center gap-2 rounded-lg border bg-white px-3 py-2 transition-colors dark:bg-neutral-900 ${
                      isDragging
                        ? "border-dashed border-pink-200 opacity-0 dark:border-pink-500/40"
                        : "border-gray-200 dark:border-neutral-700"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={shown}
                      disabled={!hideable}
                      onChange={(event) => void toggleHiddenMenu(title, !event.target.checked)}
                      aria-label={`显示「${title}」`}
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
                    <span
                      draggable
                      onDragStart={(event) => handleMenuDragStart(event, title)}
                      onDragEnd={handleMenuDragEnd}
                      title={`拖拽调整「${title}」的顺序`}
                      aria-label={`拖拽调整「${title}」的顺序`}
                      className="inline-flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 active:cursor-grabbing dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
                    >
                      <GripVertical className="h-4 w-4" />
                    </span>
                  </li>
                );
              })}
            </ul>

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
      </div>


      {dangerAction ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-xl border border-transparent bg-white p-6 shadow-xl dark:border-neutral-800 dark:bg-neutral-900">
            <h3 className="text-lg font-bold text-gray-900 dark:text-neutral-100">
              {DANGER_COPY[dangerAction].title}
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-gray-600 dark:text-neutral-300">
              {DANGER_COPY[dangerAction].description}
            </p>
            <p className="mt-4 text-xs text-gray-500 dark:text-neutral-400">
              请输入「
              <span className="font-semibold text-red-600 dark:text-red-300">
                {DANGER_COPY[dangerAction].confirmWord}
              </span>
              」确认：
            </p>
            <input
              type="text"
              value={dangerConfirmText}
              onChange={(event) => setDangerConfirmText(event.target.value)}
              autoFocus
              className="mt-2 w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-800 outline-none transition-colors focus:border-red-400 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
            />
            {isResetLoading ? (
              <p className="mt-3 animate-pulse text-xs text-blue-600">{resetStatus}</p>
            ) : null}
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => {
                  setDangerAction(null);
                  setDangerConfirmText("");
                }}
                disabled={isResetLoading}
                className="rounded-lg px-4 py-2 text-sm text-gray-600 transition-colors hover:bg-gray-100 disabled:opacity-50 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void executeDangerAction()}
                disabled={
                  isResetLoading ||
                  dangerConfirmText.trim() !== DANGER_COPY[dangerAction].confirmWord
                }
                className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {DANGER_COPY[dangerAction].button}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {showResetResultDialog ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-sm rounded-xl border border-transparent bg-white p-6 text-center shadow-xl dark:border-neutral-800 dark:bg-neutral-900">
            <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-blue-100 text-blue-600 dark:bg-blue-500/10 dark:text-blue-400">
              <Check size={24} />
            </div>
            <p className="mb-6 text-base font-medium text-gray-800 dark:text-neutral-100">
              {resetResult}
            </p>
            <button
              type="button"
              onClick={() => {
                setShowResetResultDialog(false);
                if (resetSucceeded) window.location.reload();
              }}
              className="w-full rounded-lg bg-blue-600 px-4 py-2.5 font-medium text-white transition-colors hover:bg-blue-700"
            >
              {resetSucceeded ? "确定并重新加载" : "确定"}
            </button>
          </div>
        </div>
      ) : null}

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
