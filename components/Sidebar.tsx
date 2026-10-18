import { useLocation } from "react-router-dom";
import { useMemo, useState, useEffect } from "react";
import {
  Star,
  HistoryIcon,
  InfoIcon,
  MessageCircleIcon,
  SettingsIcon,
  HardDriveDownload,
  Sun,
  Moon,
  LibraryBig,
  Users,
  LayoutDashboard,
  Heart,
  Archive as ArchiveIcon,
} from "lucide-react";
import { UserInfo } from "./UserInfo";
import ExpandableMenu from "./ExpandableMenu";
import {
  UPDATE_HISTORY,
  HIDE_USER_INFO,
  HIDDEN_MENUS,
  SIDEBAR_MENU_ORDER,
  THEME_MODE,
} from "../utils/constants";
import { getStorageValue } from "../utils/storage";
import { setTheme, type ThemeMode } from "../utils/theme";

const menuList = [
  {
    // 首页：总览（App.tsx 里 "/" 指向 Dashboard）
    title: "总览",
    icon: <LayoutDashboard className="w-4 h-4" />,
    to: "/",
  },
  {
    title: "历史记录",
    icon: <HistoryIcon className="w-4 h-4" />,
    to: "/history",
    tourId: "history-menu",
  },
  {
    title: "收藏夹",
    icon: <Star className="w-4 h-4" />,
    to: "/favorites",
  },
  {
    title: "订阅合集",
    icon: <LibraryBig className="w-4 h-4" />,
    to: "/collections",
  },
  {
    title: "关注列表",
    icon: <Users className="w-4 h-4" />,
    to: "/following",
  },
  {
    title: "互动记录",
    icon: <Heart className="w-4 h-4" />,
    to: "/interactions",
  },
  {
    // 侧边栏只有 w-40（160px），标题必须短：用「消失档案」四个字
    title: "消失档案",
    icon: <ArchiveIcon className="w-4 h-4" />,
    to: "/vanished",
  },
  {
    title: "关于",
    icon: <InfoIcon className="w-4 h-4" />,
    to: "/about",
  },
  {
    title: "反馈",
    icon: <MessageCircleIcon className="w-4 h-4" />,
    to: "/feedback",
  },
  {
    title: "数据备份",
    icon: <HardDriveDownload className="w-4 h-4" />,
    to: "/webdav-sync",
    tourId: "backup-menu",
  },
  {
    title: "设置",
    icon: <SettingsIcon className="w-4 h-4" />,
    to: "/settings",
  },
];

/**
 * 侧边栏菜单标题。设置页的「侧边栏菜单管理」从这里生成选项，
 * 避免两处各写一份硬编码——之前那份列了 3 个已删除的页面，
 * 又漏了 4 个真实菜单。
 */
export const SIDEBAR_MENU_TITLES: string[] = menuList.map((item) => item.title);

/**
 * 不允许隐藏「设置」：隐藏后用户没有任何界面入口把它改回来，
 * 只能清空扩展存储。其余菜单都可以隐藏。
 */
export const HIDEABLE_MENU_TITLES: string[] = SIDEBAR_MENU_TITLES.filter(
  (title) => title !== "设置",
);

export const Sidebar = () => {
  const location = useLocation();

  const [version, setVersion] = useState<string>(UPDATE_HISTORY[0]?.version || "");
  const [hideUserInfo, setHideUserInfo] = useState(false);
  const [hiddenMenus, setHiddenMenus] = useState<string[]>([]);
  const [menuOrder, setMenuOrder] = useState<string[]>([]);
  const [themeMode, setThemeMode] = useState<ThemeMode>("light");

  useEffect(() => {
    getStorageValue(HIDE_USER_INFO, false).then(setHideUserInfo);
    getStorageValue<string[]>(HIDDEN_MENUS, []).then((menus) => {
      // 菜单改名后，把旧标题的隐藏状态迁移到新标题，否则隐藏设置会静默失效。
      const migrations: Array<[string, string]> = [
        ["WebDAV", "数据备份"],
        ["关注", "关注列表"],
        ["合集", "订阅合集"],
        ["数据面板", "总览"],
      ];
      setHiddenMenus(
        migrations.reduce((acc, [oldTitle, newTitle]) => {
          if (acc.includes(oldTitle) && !acc.includes(newTitle)) {
            // 旧标题保留在数组里（里面可能还有 "WebDAV" 这类历史值），只做追加。
            return [...acc, newTitle];
          }
          return acc;
        }, menus),
      );
    });
    getStorageValue<string[]>(SIDEBAR_MENU_ORDER, []).then(setMenuOrder);
    getStorageValue<ThemeMode>(THEME_MODE, "light").then((m) =>
      setThemeMode(m === "dark" ? "dark" : "light"),
    );

    const handleStorageChange = (
      changes: { [key: string]: Browser.storage.StorageChange },
      areaName: string,
    ) => {
      if (areaName === "local") {
        if (changes[HIDE_USER_INFO]) {
          setHideUserInfo(changes[HIDE_USER_INFO].newValue as boolean);
        }
        if (changes[HIDDEN_MENUS]) {
          setHiddenMenus((changes[HIDDEN_MENUS].newValue as string[]) || []);
        }
        if (changes[SIDEBAR_MENU_ORDER]) {
          setMenuOrder((changes[SIDEBAR_MENU_ORDER].newValue as string[]) || []);
        }
        if (changes[THEME_MODE]) {
          const next = changes[THEME_MODE].newValue as ThemeMode | undefined;
          setThemeMode(next === "dark" ? "dark" : "light");
        }
      }
    };

    browser.storage.onChanged.addListener(handleStorageChange);
    return () => {
      browser.storage.onChanged.removeListener(handleStorageChange);
    };
  }, []);

  /**
   * 按用户自定义顺序排列菜单。
   *
   * 没出现在顺序里的标题（比如新版本新增的页面）排到末尾，并保持默认相对顺序——
   * Array.prototype.sort 是稳定排序，所以这里返回 0 即可。
   */
  const orderedMenus = useMemo(() => {
    if (menuOrder.length === 0) return menuList;
    return [...menuList].sort((a, b) => {
      const indexA = menuOrder.indexOf(a.title);
      const indexB = menuOrder.indexOf(b.title);
      if (indexA === -1 && indexB === -1) return 0;
      if (indexA === -1) return 1;
      if (indexB === -1) return -1;
      return indexA - indexB;
    });
  }, [menuOrder]);

  const handleToggleTheme = () => {
    setTheme(themeMode === "dark" ? "light" : "dark");
  };

  const isDark = themeMode === "dark";

  return (
    <div className="fixed top-0 left-0 w-40 bg-gray-100 dark:bg-[#141414] dark:text-neutral-100 flex-shrink-0 h-full">
      {!hideUserInfo && <UserInfo />}

      <nav className="space-y-2 p-4">
        {orderedMenus
          .filter((item) => !hiddenMenus.includes(item.title))
          .map((item) => (
            <ExpandableMenu key={item.title} {...item} />
          ))}
      </nav>

      <div className="absolute bottom-3 left-2 right-2 flex flex-col gap-2">
        {/* 主题切换：整行按钮 + 右侧开关。
            原来只是一个孤零零的图标靠右，左边空一大块；而且和品牌位挤在同一行时
            两者都被压小。做成占满宽度的行，既是明确的可点击区域，也不再留空白。 */}
        <button
          type="button"
          onClick={handleToggleTheme}
          title={isDark ? "切换到白天模式" : "切换到黑夜模式"}
          aria-label={isDark ? "切换到白天模式" : "切换到黑夜模式"}
          className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-sm text-gray-600 transition-colors hover:bg-gray-200 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <span className="flex min-w-0 items-center gap-2">
            {isDark ? (
              <Sun className="h-4 w-4 shrink-0" />
            ) : (
              <Moon className="h-4 w-4 shrink-0" />
            )}
            <span className="truncate">{isDark ? "浅色模式" : "深色模式"}</span>
          </span>
          <span
            className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${
              isDark ? "bg-pink-500" : "bg-gray-300"
            }`}
          >
            <span
              className={`absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all ${
                isDark ? "left-3.5" : "left-0.5"
              }`}
            />
          </span>
        </button>

        {/* 品牌位：图标 + 名称/版本两行，占满宽度。
            侧边栏只有 160px，放不下右侧艺术字，所以这里只用图标；完整 lockup 在关于页与欢迎页。 */}
        <div className="flex items-center gap-2 px-1">
          <img
            src="/icon/96.png"
            alt="哔哩哔哩记忆"
            className="h-8 w-8 shrink-0 rounded-lg"
          />
          <div className="min-w-0">
            <p className="truncate text-xs font-medium leading-tight text-gray-700 dark:text-neutral-200">
              哔哩哔哩记忆
            </p>
            <p className="text-[11px] leading-tight text-gray-500 dark:text-neutral-400">
              {version ? `v${version}` : ""}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
