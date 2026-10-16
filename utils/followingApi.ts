import type { RawFollowingEntry } from "./followingDiff";

/**
 * 关注列表接口层。
 *
 * Phase 2 实测结论：
 * - 扩展内直接 fetch 关注接口可以正常工作，**不需要补充 DNR Referer 规则**
 *   （加了与不加结果一致，均为 code 0）。
 * - Cookie 采用手动 `Cookie: SESSDATA=...` 头（上游已在生产验证）。
 *   虽然 `credentials: include` 也能用，但它依赖浏览器把 bilibili.com 的 Cookie
 *   当第三方 Cookie 发送，而 Chrome 正在逐步收紧该策略，故不采用。
 */

export type FollowingRequestErrorKind = "rate_limited" | "auth" | "network" | "data" | "unknown";

export class FollowingRequestError extends Error {
  readonly kind: FollowingRequestErrorKind;
  readonly status?: number;

  constructor(message: string, kind: FollowingRequestErrorKind, status?: number) {
    super(message);
    this.name = "FollowingRequestError";
    this.kind = kind;
    this.status = status;
  }
}

export const FOLLOWING_PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 30_000;

const kindFromStatus = (status: number): FollowingRequestErrorKind => {
  if (status >= 500) return "unknown";
  if (status >= 400) return "network";
  return "unknown";
};

const fetchWithTimeout = async (url: string, init: RequestInit): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw new FollowingRequestError(
      error instanceof Error ? error.message : "网络请求失败",
      "network",
    );
  } finally {
    clearTimeout(timeoutId);
  }
};

/** 读取 B 站登录态。缺 SESSDATA 视为鉴权失败，调用方应提示用户登录 */
export const getBilibiliSessdata = async (): Promise<string> => {
  const cookies = await browser.cookies.getAll({ domain: "bilibili.com" });
  const sessdata = cookies.find((cookie) => cookie.name === "SESSDATA")?.value;
  if (!sessdata) {
    throw new FollowingRequestError("未找到 B 站登录信息，请先登录 B 站", "auth");
  }
  return sessdata;
};

/** 取自己的 mid。关注接口需要 vmid 参数 */
export const getCurrentBilibiliMid = async (sessdata: string): Promise<number> => {
  const response = await fetchWithTimeout("https://api.bilibili.com/x/web-interface/nav", {
    headers: { Cookie: `SESSDATA=${sessdata}` },
  });

  if (response.status === 412 || response.status === 429) {
    throw new FollowingRequestError(`HTTP ${response.status}`, "rate_limited", response.status);
  }
  if (!response.ok) {
    throw new FollowingRequestError(
      `获取账号信息失败 HTTP ${response.status}`,
      kindFromStatus(response.status),
      response.status,
    );
  }

  const data = await response.json();
  if (data?.code !== 0 || !data?.data?.mid) {
    const kind: FollowingRequestErrorKind = data?.code === -101 ? "auth" : "unknown";
    throw new FollowingRequestError(data?.message || "获取账号信息失败", kind);
  }
  return Number(data.data.mid);
};

export interface FollowingPageResult {
  list: RawFollowingEntry[];
  /** 接口返回的关注总数。取关判定的完整性护栏以此为准，而不是页数 */
  total: number;
}

/**
 * 抓取一页关注列表。
 * 只有登录自己才可查看全部；接口要求 Referer 在 bilibili.com 域下且 UA 不含 python，
 * 扩展请求（`host_permissions: <all_urls>`）实测可直接通过。
 */
export const fetchFollowingPage = async (
  vmid: number,
  page: number,
  sessdata: string,
  pageSize: number = FOLLOWING_PAGE_SIZE,
): Promise<FollowingPageResult> => {
  const url =
    `https://api.bilibili.com/x/relation/followings?vmid=${vmid}` +
    `&pn=${page}&ps=${pageSize}&order_type=`;

  const response = await fetchWithTimeout(url, {
    headers: { Cookie: `SESSDATA=${sessdata}` },
  });

  if (response.status === 412 || response.status === 429) {
    throw new FollowingRequestError(`HTTP ${response.status}`, "rate_limited", response.status);
  }
  if (response.status === 401 || response.status === 403) {
    throw new FollowingRequestError(
      `登录状态无效（HTTP ${response.status}）`,
      "auth",
      response.status,
    );
  }
  if (!response.ok) {
    throw new FollowingRequestError(
      `HTTP ${response.status}`,
      kindFromStatus(response.status),
      response.status,
    );
  }

  const data = await response.json();

  // -352 是 B 站风控，必须冷却后重试，不能当作普通失败
  if (data?.code === -352) {
    throw new FollowingRequestError(data.message || "B 站接口触发访问风控", "rate_limited", 412);
  }
  if (data?.code === -101) {
    throw new FollowingRequestError(data.message || "账号未登录", "auth");
  }
  if (data?.code !== 0) {
    throw new FollowingRequestError(data?.message || "获取关注列表失败", "unknown");
  }

  const list = data.data?.list;
  const total = Number(data.data?.total);

  if (list != null && !Array.isArray(list)) {
    throw new FollowingRequestError("关注列表数据格式异常", "data");
  }
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new FollowingRequestError("关注总数格式异常", "data");
  }

  return { list: (list ?? []) as RawFollowingEntry[], total };
};
