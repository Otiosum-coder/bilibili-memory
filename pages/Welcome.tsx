import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowRight,
  CheckCircle2,
  Circle,
  DatabaseBackup,
  ExternalLink,
  HardDriveDownload,
  Loader2,
  RefreshCw,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import {
  ALL_FAVORITE_FOLDERS_SYNC_PROGRESS,
  FAVORITES_LAST_SYNC,
  FOLLOWING_LAST_SYNC,
  FOLLOWING_SYNC_PROGRESS,
  HAS_FULL_FAV_SYNC,
  HAS_FULL_FOLLOWING_SYNC,
  HAS_FULL_SYNC,
  HISTORY_LAST_SYNC,
  INTERACTIONS_LAST_SYNC,
  INTERACTIONS_SYNC_PROGRESS,
} from "../utils/constants";
import { getStorageValue } from "../utils/storage";
import {
  getAllFavResources,
  getAllFollowing,
  getAllInteractions,
  getTotalHistoryCount,
} from "../utils/db";
import type { AllFavoriteFoldersSyncProgress } from "../utils/types";
import type { FollowingSyncProgress } from "../utils/followingSync";
import type { InteractionSyncProgress } from "../utils/interactionSync";

type LoginState = "checking" | "logged-in" | "logged-out" | "unknown";
type ItemState = "waiting" | "running" | "done" | "error";

interface SyncItem {
  key: string;
  label: string;
  description: string;
  count: number;
  state: ItemState;
}

interface NavResponse {
  data?: {
    isLogin?: boolean;
    uname?: string;
  };
}

const STEP_ITEMS = [
  { id: 1, label: "登录" },
  { id: 2, label: "首次同步" },
  { id: 3, label: "备份" },
] as const;

const countLabel = (count: number): string => {
  if (count <= 0) return "暂无本地记录";
  return `本地已有 ${count.toLocaleString("zh-CN")} 条`;
};

const Welcome = () => {
  const navigate = useNavigate();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [loginState, setLoginState] = useState<LoginState>("checking");
  const [userName, setUserName] = useState("");
  const [syncItems, setSyncItems] = useState<SyncItem[]>([]);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [syncRequested, setSyncRequested] = useState(false);
  const syncRequestedRef = useRef(false);

  const checkLogin = useCallback(async () => {
    setLoginState("checking");
    try {
      const response = await fetch("https://api.bilibili.com/x/web-interface/nav", {
        credentials: "include",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as NavResponse;
      const loggedIn = Boolean(payload?.data?.isLogin);
      setLoginState(loggedIn ? "logged-in" : "logged-out");
      setUserName(payload?.data?.uname || "");
    } catch (error) {
      console.warn("检查 B 站登录状态失败:", error);
      setLoginState("unknown");
      setUserName("");
    }
  }, []);

  useEffect(() => {
    void checkLogin();
  }, [checkLogin]);

  useEffect(() => {
    if (step !== 1) return;
    const handleFocus = () => {
      if (loginState !== "logged-in") void checkLogin();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [checkLogin, loginState, step]);

  const loadSyncStatus = useCallback(async () => {
    setIsLoadingStatus(true);
    try {
      const [
        historyCount,
        favorites,
        following,
        interactions,
        hasFullSync,
        historyLastSync,
        hasFullFavSync,
        favoritesLastSync,
        hasFullFollowingSync,
        followingLastSync,
        interactionsLastSync,
        favoriteProgress,
        followingProgress,
        interactionProgress,
      ] = await Promise.all([
        getTotalHistoryCount(),
        getAllFavResources(),
        getAllFollowing(),
        getAllInteractions(),
        getStorageValue(HAS_FULL_SYNC, false),
        getStorageValue<number>(HISTORY_LAST_SYNC, 0),
        getStorageValue(HAS_FULL_FAV_SYNC, false),
        getStorageValue<number | null>(FAVORITES_LAST_SYNC, null),
        getStorageValue(HAS_FULL_FOLLOWING_SYNC, false),
        getStorageValue<number | null>(FOLLOWING_LAST_SYNC, null),
        getStorageValue<number | null>(INTERACTIONS_LAST_SYNC, null),
        getStorageValue<AllFavoriteFoldersSyncProgress | null>(
          ALL_FAVORITE_FOLDERS_SYNC_PROGRESS,
          null,
        ),
        getStorageValue<FollowingSyncProgress | null>(FOLLOWING_SYNC_PROGRESS, null),
        getStorageValue<InteractionSyncProgress | null>(INTERACTIONS_SYNC_PROGRESS, null),
      ]);

      const favoriteRunning = favoriteProgress?.status === "syncing";
      const followingRunning = followingProgress?.status === "completed" ? false : Boolean(followingProgress);
      const interactionRunning = interactionProgress?.status === "completed"
        ? false
        : Boolean(interactionProgress);

      const favoriteFailed =
        favoriteProgress?.status === "error" || favoriteProgress?.status === "interrupted";
      const followingFailed =
        followingProgress?.status === "failed" ||
        followingProgress?.status === "auth_invalid" ||
        followingProgress?.status === "rate_limited";
      const interactionFailed =
        interactionProgress?.status === "failed" ||
        interactionProgress?.status === "auth_invalid" ||
        interactionProgress?.status === "rate_limited";

      const baseItem = (
        key: string,
        label: string,
        description: string,
        count: number,
        done: boolean,
        running: boolean,
        failed: boolean,
      ): SyncItem => ({
        key,
        label,
        description,
        count,
        state: done ? "done" : failed ? "error" : running || syncRequestedRef.current ? "running" : "waiting",
      });

      setSyncItems([
        baseItem(
          "history",
          "观看历史",
          "建立本地历史基线，之后会自动增量更新",
          historyCount,
          Boolean(hasFullSync) || Boolean(historyLastSync),
          syncRequestedRef.current && !historyLastSync,
          false,
        ),
        baseItem(
          "favorites",
          "收藏夹",
          "同步收藏夹目录和夹内视频",
          favorites.length,
          Boolean(hasFullFavSync) || Boolean(favoritesLastSync),
          favoriteRunning || (syncRequestedRef.current && !favoritesLastSync),
          favoriteFailed,
        ),
        baseItem(
          "following",
          "关注列表",
          "记录当前关注，之后才能追踪改名、取关和注销",
          following.length,
          Boolean(hasFullFollowingSync) || Boolean(followingLastSync),
          followingRunning || (syncRequestedRef.current && !followingLastSync),
          followingFailed,
        ),
        baseItem(
          "interactions",
          "点赞与投币",
          "B 站只保留最近 20 条，本地会持续留存",
          interactions.length,
          Boolean(interactionsLastSync),
          interactionRunning || (syncRequestedRef.current && !interactionsLastSync),
          interactionFailed,
        ),
      ]);
    } catch (error) {
      console.error("读取首次同步状态失败:", error);
    } finally {
      setIsLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    if (step !== 2) return;
    void loadSyncStatus();
    const timerId = window.setInterval(() => void loadSyncStatus(), 2500);
    return () => window.clearInterval(timerId);
  }, [loadSyncStatus, step]);

  const doneCount = useMemo(
    () => syncItems.filter((item) => item.state === "done").length,
    [syncItems],
  );
  const anySyncing = useMemo(
    () => syncItems.some((item) => item.state === "running"),
    [syncItems],
  );
  const allDone = syncItems.length > 0 && doneCount === syncItems.length;

  const startSync = useCallback(() => {
    if (syncRequestedRef.current) return;
    syncRequestedRef.current = true;
    setSyncRequested(true);
    setSyncItems((items) =>
      items.map((item) => (item.state === "done" ? item : { ...item, state: "running" })),
    );

    const requests = [
      { action: "syncHistory", isFullSync: true },
      { action: "syncAllFavoriteFolders" },
      { action: "syncFollowing" },
      { action: "syncInteractions" },
    ];

    for (const request of requests) {
      void browser.runtime.sendMessage(request).catch((error) => {
        console.warn("首次同步请求失败:", request.action, error);
      });
    }
    void loadSyncStatus();
  }, [loadSyncStatus]);

  const goNext = () => {
    if (step === 1) {
      setStep(2);
      return;
    }
    if (step === 2) {
      setStep(3);
      return;
    }
    navigate("/");
  };

  const handleSyncButton = () => {
    if (anySyncing) return;
    if (allDone) {
      goNext();
      return;
    }
    // 上一次请求已经发出但状态仍是等待/失败时，允许重新发起。
    if (syncRequestedRef.current) {
      syncRequestedRef.current = false;
      setSyncRequested(false);
    }
    startSync();
  };

  const goBack = () => {
    if (step === 1) return;
    setStep((current) => (current === 3 ? 2 : 1));
  };

  const handleLogin = () => {
    void browser.tabs.create({ url: "https://www.bilibili.com" });
  };

  const loginMessage = () => {
    if (loginState === "checking") {
      return (
        <span className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-neutral-400">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在检查 B 站登录状态…
        </span>
      );
    }
    if (loginState === "logged-in") {
      return (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-emerald-600 dark:text-emerald-400">
          <CheckCircle2 className="h-4 w-4" />
          已登录{userName ? `：${userName}` : ""}
        </span>
      );
    }
    if (loginState === "logged-out") {
      return (
        <span className="inline-flex items-center gap-1.5 text-sm font-medium text-amber-600 dark:text-amber-400">
          <Circle className="h-4 w-4" />
          未登录 B 站网页版
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-sm text-gray-500 dark:text-neutral-400">
        <Circle className="h-4 w-4" />
        无法自动检测登录状态
      </span>
    );
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-8 dark:bg-[#0a0a0a]">
      <div className="w-full max-w-[760px]">
        <div className="mb-5 flex flex-col items-center text-center">
          <img
            src="/brand/lockup.png"
            alt="哔哩哔哩记忆"
            className="mb-4 w-full max-w-[340px]"
          />
          <p className="text-sm text-gray-500 dark:text-neutral-400">
            第一次使用，先花一分钟准备好。
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm sm:p-8 dark:border-neutral-800 dark:bg-neutral-900">
          <div className="mb-7 flex items-center justify-between gap-3">
            {STEP_ITEMS.map((item) => {
              const active = step === item.id;
              const completed = step > item.id;
              return (
                <div key={item.id} className="flex flex-1 items-center gap-2">
                  <span
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                      active
                        ? "bg-pink-500 text-white"
                        : completed
                          ? "bg-pink-100 text-pink-600 dark:bg-pink-500/20 dark:text-pink-300"
                          : "bg-gray-100 text-gray-400 dark:bg-neutral-800 dark:text-neutral-500"
                    }`}
                  >
                    {completed ? <CheckCircle2 className="h-4 w-4" /> : item.id}
                  </span>
                  <span
                    className={`hidden text-xs font-medium sm:inline ${
                      active
                        ? "text-gray-900 dark:text-neutral-100"
                        : "text-gray-400 dark:text-neutral-500"
                    }`}
                  >
                    {item.label}
                  </span>
                  {item.id < STEP_ITEMS.length && (
                    <span
                      className={`ml-auto hidden h-px flex-1 sm:block ${
                        completed ? "bg-pink-200 dark:bg-pink-500/30" : "bg-gray-100 dark:bg-neutral-800"
                      }`}
                    />
                  )}
                </div>
              );
            })}
          </div>

          {step === 1 && (
            <div>
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-pink-50 text-pink-600 dark:bg-pink-500/10 dark:text-pink-400">
                  <UserRound className="h-5 w-5" />
                </div>
                <div>
                  <h1 className="text-xl font-bold text-gray-900 dark:text-neutral-100">
                    先确认 B 站登录
                  </h1>
                  <p className="mt-1 text-sm leading-relaxed text-gray-500 dark:text-neutral-400">
                    扩展需要读取你在 B 站网页版的登录状态，才能同步历史、收藏和关注。
                  </p>
                </div>
              </div>

              <div className="mt-6 rounded-xl border border-gray-100 bg-gray-50 px-4 py-4 dark:border-neutral-800 dark:bg-neutral-950/60">
                {loginMessage()}
                <p className="mt-2 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
                  如果没有登录，会跳转到 B 站网页版。登录完成后回到这里，状态会自动更新。
                </p>
              </div>

              <div className="mt-5 flex items-start gap-2 rounded-lg bg-emerald-50 px-3 py-2.5 text-xs leading-relaxed text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <span>所有同步数据只保存在你的浏览器本地，不会上传到任何服务器。</span>
              </div>

              <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => navigate("/")}
                  className="text-sm text-gray-400 hover:text-gray-600 dark:text-neutral-500 dark:hover:text-neutral-300"
                >
                  先进入，稍后再说
                </button>
                <div className="flex items-center gap-2">
                  {loginState === "logged-out" && (
                    <button
                      type="button"
                      onClick={handleLogin}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
                    >
                      去登录 B 站
                      <ExternalLink className="h-3.5 w-3.5" />
                    </button>
                  )}
                  {loginState === "unknown" && (
                    <button
                      type="button"
                      onClick={() => void checkLogin()}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      重新检测
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={goNext}
                    disabled={loginState === "logged-out" || loginState === "checking"}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-pink-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-pink-600 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    下一步
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === 2 && (
            <div>
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-pink-50 text-pink-600 dark:bg-pink-500/10 dark:text-pink-400">
                  <RefreshCw className={`h-5 w-5 ${anySyncing ? "animate-spin" : ""}`} />
                </div>
                <div>
                  <h1 className="text-xl font-bold text-gray-900 dark:text-neutral-100">
                    建立第一次同步
                  </h1>
                  <p className="mt-1 text-sm leading-relaxed text-gray-500 dark:text-neutral-400">
                    先同步一次，建立本地基线。之后会自动增量更新，不需要每次手动点。
                  </p>
                </div>
              </div>

              <div className="mt-6 space-y-2">
                {syncItems.map((item) => {
                  const status =
                    item.state === "done"
                      ? countLabel(item.count)
                      : item.state === "running"
                        ? "同步中…"
                        : item.state === "error"
                          ? "同步失败，可重试"
                          : "等待同步";
                  return (
                    <div
                      key={item.key}
                      className="flex items-center gap-3 rounded-lg border border-gray-100 px-3.5 py-3 dark:border-neutral-800"
                    >
                      <span className="shrink-0">
                        {item.state === "done" ? (
                          <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                        ) : item.state === "running" ? (
                          <Loader2 className="h-5 w-5 animate-spin text-pink-500" />
                        ) : item.state === "error" ? (
                          <Circle className="h-5 w-5 text-amber-500" />
                        ) : (
                          <Circle className="h-5 w-5 text-gray-300 dark:text-neutral-600" />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium text-gray-800 dark:text-neutral-200">
                          {item.label}
                        </p>
                        <p className="mt-0.5 text-xs text-gray-400 dark:text-neutral-500">
                          {item.description}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 text-xs ${
                          item.state === "done"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : item.state === "error"
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-gray-400 dark:text-neutral-500"
                        }`}
                      >
                        {isLoadingStatus && item.state === "waiting" ? "读取中…" : status}
                      </span>
                    </div>
                  );
                })}
              </div>

              <p className="mt-4 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
                首次同步可能需要 1–3 分钟，取决于你的收藏和关注数量。同步期间可以先进入，后台会继续。
              </p>

              <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => navigate("/")}
                  className="text-sm text-gray-400 hover:text-gray-600 dark:text-neutral-500 dark:hover:text-neutral-300"
                >
                  先进入，后台继续同步
                </button>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={goBack}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
                  >
                    上一步
                  </button>
                  <button
                    type="button"
                    onClick={handleSyncButton}
                    disabled={anySyncing}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-pink-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-pink-600 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {anySyncing ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" />
                        同步中…
                      </>
                    ) : allDone ? (
                      <>
                        下一步
                        <ArrowRight className="h-4 w-4" />
                      </>
                    ) : syncRequested ? (
                      "重新同步"
                    ) : (
                      "开始同步"
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div>
              <div className="flex items-start gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">
                  <DatabaseBackup className="h-5 w-5" />
                </div>
                <div>
                  <h1 className="text-xl font-bold text-gray-900 dark:text-neutral-100">
                    要不要顺便设置备份？
                  </h1>
                  <p className="mt-1 text-sm leading-relaxed text-gray-500 dark:text-neutral-400">
                    数据只存在这台电脑的浏览器里。卸载扩展、清理浏览器数据或换电脑时，需要备份才能带走。
                  </p>
                </div>
              </div>

              <div className="mt-6 rounded-xl border border-gray-100 bg-gray-50 p-4 text-sm leading-relaxed text-gray-600 dark:border-neutral-800 dark:bg-neutral-950/60 dark:text-neutral-300">
                可以导出 JSON 手动保存，也可以配置本地目录或 WebDAV 自动备份。现在不设置也没关系，之后在「数据备份」页随时可以开启。
              </div>

              <div className="mt-7 flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={goBack}
                  className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
                >
                  上一步
                </button>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => navigate("/webdav-sync")}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:bg-neutral-800"
                  >
                    <HardDriveDownload className="h-4 w-4" />
                    去配置备份
                  </button>
                  <button
                    type="button"
                    onClick={() => navigate("/")}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-pink-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-pink-600"
                  >
                    先进入首页
                    <ArrowRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        <p className="mt-4 text-center text-xs text-gray-400 dark:text-neutral-500">
          数据只保存在本地 · 不会上传到服务器
        </p>
      </div>
    </div>
  );
};

export default Welcome;
