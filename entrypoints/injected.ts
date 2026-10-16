import {
  INJECTED_FETCH_GUARD_KEY,
  PAGE_MESSAGE_DELETE_HISTORY,
} from "../utils/constants";

export default defineUnlistedScript(() => {
  const pageWindow = window as unknown as Record<string, unknown>;

  // 防重复包装：SPA 导航或扩展重载可能让本脚本在同一页面执行多次。
  // 标志带项目前缀，避免与同时安装的上游扩展互相误判。
  if (pageWindow[INJECTED_FETCH_GUARD_KEY]) return;
  pageWindow[INJECTED_FETCH_GUARD_KEY] = true;

  const setupFetchInterceptor = () => {
    const originalFetch = window.fetch;
    window.fetch = async function (input, init) {
      const isHistoryDelete =
        typeof input === "string" && input.includes("api.bilibili.com/x/v2/history/delete");
      const targets: { business: string; id: number }[] = [];
      if (isHistoryDelete && init?.body && typeof init.body === "string") {
        const params = new URLSearchParams(init.body);
        const kid = params.get("kid") || "";
        for (const target of kid.split(",")) {
          const match = target.match(/^([a-z-]+)_(\d+)$/i);
          if (!match) continue;
          const business = match[1];
          const id = Number(match[2]);
          if (!Number.isSafeInteger(id) || id <= 0) continue;
          targets.push({ business, id });
        }
      }

      const response = await originalFetch.call(window, input, init);
      if (isHistoryDelete && response.ok && targets.length > 0) {
        void response
          .clone()
          .json()
          .then((data) => {
            if (data?.code !== 0) return;
            targets.forEach(({ business, id }) => {
              window.postMessage(
                {
                  type: PAGE_MESSAGE_DELETE_HISTORY,
                  action: "deleteHistoryItem",
                  business,
                  id,
                },
                "*",
              );
            });
          })
          .catch(() => undefined);
      }
      return response;
    };
  };
  setupFetchInterceptor();
});
