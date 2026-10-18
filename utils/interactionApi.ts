import type { InteractionProbeResult } from "./interactionDiff";
import type { InteractionType, RawInteractionEntry } from "./types";

// 登录态（SESSDATA）与自己的 mid 由 background 通过 utils/followingApi.ts 的
// getBilibiliSessdata / getCurrentBilibiliMid 取得后传进来，本模块保持"只发请求"，
// 不自己读 Cookie，也不重复一份登录态解析逻辑。

/**
 * 点赞 / 投币列表与探测的接口层。
 *
 * ## 实测结论（匿名可复现）
 *
 * - `x/space/like/video` 返回 `data.list`，元素是完整稿件详情；
 *   `x/space/coin/video` 的 `data` **直接是数组**。两者形状不同，本层负责抹平。
 * - 两个接口固定只返回 **20 条**，`pn` / `ps` / `p` 全部被忽略。
 *   分页参数照发不误：万一 B 站放开了分页，翻页循环会自动多抓几页，不需要改代码。
 * - 投币条目带 `coins`（投币枚数）与 `time`（真实投币时间）；点赞条目**没有点赞时间**。
 * - 隐私未公开时返回 `53013`。
 */

export type InteractionRequestErrorKind =
  | "rate_limited"
  | "auth"
  | "network"
  | "data"
  | "unknown";

export class InteractionRequestError extends Error {
  readonly kind: InteractionRequestErrorKind;
  readonly status?: number;

  constructor(message: string, kind: InteractionRequestErrorKind, status?: number) {
    super(message);
    this.name = "InteractionRequestError";
    this.kind = kind;
    this.status = status;
  }
}

/** 每页请求的条数。实测服务端固定返回 20，这里保持一致 */
export const INTERACTION_PAGE_SIZE = 20;
const REQUEST_TIMEOUT_MS = 30_000;

const kindFromStatus = (status: number): InteractionRequestErrorKind => {
  if (status === 412 || status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status >= 500) return "unknown";
  if (status >= 400) return "network";
  return "unknown";
};

const fetchJsonWithTimeout = async (
  url: string,
  sessdata: string,
): Promise<{ status: number; json: any }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Cookie: `SESSDATA=${sessdata}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new InteractionRequestError(
        `HTTP ${response.status}`,
        kindFromStatus(response.status),
        response.status,
      );
    }
    const json = await response.json();
    return { status: response.status, json };
  } catch (error) {
    if (error instanceof InteractionRequestError) throw error;
    const message =
      error instanceof DOMException && error.name === "AbortError"
        ? "请求超时"
        : error instanceof Error
          ? error.message
          : String(error);
    throw new InteractionRequestError(message, "network");
  } finally {
    clearTimeout(timer);
  }
};

/** 把接口的错误码翻译成调用方能处理的错误。风控必须冷却重试，不能当普通失败 */
const throwForCode = (code: number, message: string | undefined, type: InteractionType): never => {
  if (code === -352) {
    throw new InteractionRequestError(message || "B 站接口触发访问风控", "rate_limited", 412);
  }
  if (code === -101) {
    throw new InteractionRequestError(message || "账号未登录", "auth");
  }
  if (code === 53013) {
    throw new InteractionRequestError(
      message ||
        `B 站没有公开「最近${
          type === "like" ? "点赞" : "投币"
        }的视频」，请在 B 站隐私设置里把该板块设为公开`,
      "data",
    );
  }
  throw new InteractionRequestError(message || "获取互动列表失败", "unknown");
};

const listUrl = (type: InteractionType, vmid: number, page: number, pageSize: number): string => {
  const path = type === "like" ? "like" : "coin";
  return (
    `https://api.bilibili.com/x/space/${path}/video` +
    `?vmid=${vmid}&pn=${page}&ps=${pageSize}`
  );
};

export interface InteractionPageResult {
  items: RawInteractionEntry[];
}

/**
 * 抓取一页互动列表。
 *
 * 两种返回形状都在这里抹平：点赞是 `data.list`，投币是 `data` 数组。
 * 形状对不上时报 "data" 错误，不猜、不吞。
 */
export const fetchInteractionPage = async (
  type: InteractionType,
  vmid: number,
  page: number,
  sessdata: string,
  pageSize: number = INTERACTION_PAGE_SIZE,
): Promise<InteractionPageResult> => {
  const { json } = await fetchJsonWithTimeout(listUrl(type, vmid, page, pageSize), sessdata);
  const code = Number(json?.code);
  if (code !== 0) throwForCode(code, json?.message, type);

  const data = json?.data;
  const list = Array.isArray(data) ? data : Array.isArray(data?.list) ? data.list : null;
  if (!Array.isArray(list)) {
    throw new InteractionRequestError("互动列表数据格式异常", "data");
  }
  return { items: list as RawInteractionEntry[] };
};

export interface ContentProbeResult {
  /** 稿件是否还在 */
  content: "ok" | "deleted" | "hidden" | "unknown";
  /** 请求本身是否成功（网络层） */
  ok: boolean;
  error?: string;
}

/**
 * 稿件二次探测。复用收藏消失判定已经实测过的结论：
 * `x/web-interface/view` 不需要 WBI 签名，`0` / `-404` / `62002` 三者可区分。
 *
 * 与 `probeFavoriteResource` 同构，但本函数**从不抛错**：任何失败都归一成
 * `content: "unknown"`，由调用方按"判定不了"处理——探测失败绝不能被当作"互动消失了"。
 */
export const probeInteractionContent = async (
  bvid: string,
  sessdata: string,
): Promise<ContentProbeResult> => {
  if (!bvid) return { content: "unknown", ok: false, error: "缺少 BV 号，无法探测" };

  try {
    const { json } = await fetchJsonWithTimeout(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      sessdata,
    );
    const code = Number(json?.code);
    if (code === 0) return { content: "ok", ok: true };
    if (code === -404) return { content: "deleted", ok: true };
    if (code === 62002) return { content: "hidden", ok: true };
    return { content: "unknown", ok: false, error: json?.message || `code ${code}` };
  } catch (error) {
    return {
      content: "unknown",
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/**
 * 互动状态探测。
 *
 * `x/web-interface/archive/relation` 一个请求同时回答"点赞还在不在"（`data.like`）
 * 与"我投了几个币"（`data.coin`），播放器就是用它在渲染点赞/投币按钮的状态。
 * 它需要登录，匿名请求返回 `-101`。
 *
 * 注意：`has/like` 这类接口社区文档明确说**只反映近期状态**（半年前点赞的会变成 0），
 * 所以"探测到没有" ≠ "你取消了"——两者在接口上无法区分，界面文案必须留有余地。
 */
export const probeInteractionState = async (
  type: InteractionType,
  bvid: string,
  sessdata: string,
): Promise<{ retained: boolean | null; error?: string }> => {
  if (!bvid) return { retained: null, error: "缺少 BV 号，无法探测" };

  try {
    const { json } = await fetchJsonWithTimeout(
      `https://api.bilibili.com/x/web-interface/archive/relation?bvid=${encodeURIComponent(bvid)}`,
      sessdata,
    );
    const code = Number(json?.code);
    if (code !== 0) {
      return { retained: null, error: json?.message || `code ${code}` };
    }
    const data = json?.data ?? {};
    if (type === "like") return { retained: data.like === true };
    const coin = Number(data.coin);
    return { retained: Number.isFinite(coin) && coin > 0 };
  } catch (error) {
    return {
      retained: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

/** 完整探测：先看稿件在不在，稿件还在再问互动还在不在 */
export const probeInteraction = async (
  type: InteractionType,
  bvid: string,
  sessdata: string,
): Promise<InteractionProbeResult> => {
  const content = await probeInteractionContent(bvid, sessdata);
  if (content.content !== "ok") {
    return { content: content.content, retained: null, error: content.error };
  }

  const state = await probeInteractionState(type, bvid, sessdata);
  return { content: "ok", retained: state.retained, error: state.error };
};
