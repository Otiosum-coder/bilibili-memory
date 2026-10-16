import { useEffect, useState } from "react";

interface BilibiliAccount {
  mid: number;
  uname: string;
  face: string;
}

/**
 * 侧边栏的账号卡片。
 *
 * 上游实现读取的是云服务的登录态（会请求 bilibilihistory.com）。云同步已随本 fork
 * 移除，这里改为直接读本地 B 站的登录态，不再联系任何第三方服务。
 */
export const UserInfo = () => {
  const [account, setAccount] = useState<BilibiliAccount | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    const load = async () => {
      try {
        const cookies = await browser.cookies.getAll({ domain: "bilibili.com" });
        const sessdata = cookies.find((cookie) => cookie.name === "SESSDATA")?.value;
        if (!sessdata) {
          if (active) setAccount(null);
          return;
        }

        const response = await fetch("https://api.bilibili.com/x/web-interface/nav", {
          headers: { Cookie: `SESSDATA=${sessdata}` },
        });
        const data = await response.json();
        if (!active) return;

        if (data?.code === 0 && data.data?.mid) {
          setAccount({
            mid: data.data.mid,
            uname: data.data.uname ?? "",
            face: data.data.face ?? "",
          });
        } else {
          setAccount(null);
        }
      } catch {
        if (active) setAccount(null);
      } finally {
        if (active) setLoading(false);
      }
    };

    void load();
    return () => {
      active = false;
    };
  }, []);

  const handleClick = () => {
    const url = account?.mid
      ? `https://space.bilibili.com/${account.mid}`
      : "https://www.bilibili.com";
    window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="py-2 px-4">
      <div className="flex items-center space-x-3">
        <div className="w-10 h-10 rounded-full overflow-hidden bg-gray-300 dark:bg-neutral-700">
          {account?.face ? (
            <img
              src={account.face.replace(/^http:/, "https:")}
              alt="B 站头像"
              className="w-full h-full object-cover"
            />
          ) : (
            <img src="/noface.jpg" alt="用户头像" className="w-full h-full object-cover" />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p
            className="text-sm font-medium text-gray-900 dark:text-neutral-100 truncate cursor-pointer hover:text-pink-400"
            onClick={handleClick}
            title={account ? `打开 ${account.uname} 的 B 站空间` : "打开 B 站"}
          >
            {loading ? "加载中..." : account ? account.uname : "未登录 B 站"}
          </p>
        </div>
      </div>
    </div>
  );
};
