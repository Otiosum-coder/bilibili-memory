import { useEffect, useState } from "react";

interface BilibiliAccount {
  mid: number;
  uname: string;
  face: string;
  level: number;
  isVip: boolean;
  isSeniorMember: boolean;
  vipLabel: string;
  vipBgColor: string;
  vipTextColor: string;
}

/**
 * 侧边栏的账号卡片。
 *
 * 上游实现读取的是云服务的登录态（会请求 bilibilihistory.com）。云同步已随本 fork
 * 移除，这里改为直接读本地 B 站的登录态，不再联系任何第三方服务。
 *
 * 展示上不显示昵称和 UID：头像靠左、放大到 48px 作为视觉锚点，
 * 身份标签整体靠右，等级牌在会员牌正下方居中。
 * 硬核会员会替换等级牌（B 站规则：硬核会员本身就是 LV6 身份）；
 * 大会员/年度大会员的文字和配色交给接口的 vip_label 决定。
 * 完整昵称放在 title 里，悬停可看。
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
            level: Number(data.data.level_info?.current_level) || 0,
            isVip: data.data.vipStatus === 1 || data.data.vip?.status === 1,
            isSeniorMember: Number(data.data.is_senior_member) === 1,
            vipLabel:
              data.data.vip_label?.text ||
              data.data.vip?.label?.text ||
              "大会员",
            vipBgColor: data.data.vip_label?.bg_color || "#fb7299",
            vipTextColor: data.data.vip_label?.text_color || "#ffffff",
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

  const profileUrl = account?.mid
    ? `https://space.bilibili.com/${account.mid}`
    : "https://www.bilibili.com";
  const label = account ? `打开 ${account.uname} 的 B 站空间` : "打开 B 站";

  return (
    <div className="mx-2 mb-1 mt-2 flex items-center gap-2 rounded-lg bg-gray-50/80 px-1.5 py-1.5 dark:bg-neutral-900/60">
      <a
        href={profileUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={account?.uname || "未登录 B 站"}
        aria-label={label}
        className="shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-pink-300 dark:focus-visible:ring-pink-500/50"
      >
        <span className="block h-[42px] w-[42px] overflow-hidden rounded-full bg-gray-300 ring-1 ring-black/5 shadow-sm transition-shadow hover:ring-2 hover:ring-pink-300 dark:bg-neutral-700 dark:ring-white/10 dark:hover:ring-pink-500/60">
          {loading ? (
            <span className="block h-full w-full animate-pulse bg-gray-200 dark:bg-neutral-700" />
          ) : (
            <img
              src={
                account?.face
                  ? account.face.replace(/^http:/, "https:")
                  : "/noface.jpg"
              }
              alt="B 站头像"
              className="h-full w-full object-cover"
            />
          )}
        </span>
      </a>

      {!loading && account ? (
        <div className="ml-auto mr-[9px] flex min-w-0 flex-col items-center gap-0.5">
          {account.isVip ? (
            <span
              className="inline-flex h-[18px] shrink-0 items-center justify-center whitespace-nowrap rounded-[3px] px-1.5 text-[11px] font-semibold leading-none"
              style={{
                backgroundColor: account.vipBgColor,
                color: account.vipTextColor,
              }}
            >
              {account.vipLabel}
            </span>
          ) : null}
          {account.isSeniorMember ? (
            <span
              title="硬核会员（已通过 LV6 硬核试炼）"
              className="inline-flex h-[18px] shrink-0 items-center justify-center whitespace-nowrap rounded-[3px] bg-[#f04b4b] px-1.5 text-[10px] font-semibold leading-none text-white"
            >
              硬核会员
            </span>
          ) : account.level > 0 ? (
            <span className="inline-flex h-[18px] shrink-0 items-center justify-center whitespace-nowrap rounded-[3px] bg-[#ff6b4a] px-1.5 text-[10px] font-bold leading-none text-white">
              LV{account.level}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
