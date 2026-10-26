import type { BiliplusAidInfo } from "./favRecovery";

/**
 * biliplus 客户端。
 *
 * ## Phase 4 实测确定的行为（这一段是踩坑换来的，别想当然）
 *
 * | 返回 | 含义 | 正确处理 |
 * | --- | --- | --- |
 * | `code 0` | 正常，`data` 只包含命中的 aid | 直接用 |
 * | `code -404` `cid无记录` | **本批全部没有记录** —— 这是正常结果，**不是错误** | 当作 0 命中，继续下一批 |
 * | `code -503` `停一下！旁友！` | **限流**，等待 30–45 秒即恢复 | **退避后重试同一批**，不能丢弃 |
 * | 网络/超时/非 JSON | 环境问题 | 重试少量次数后放弃，交给降级来源 |
 *
 * **批量大小不是问题**：20 条一批完全正常，`1 命中 + 19 无记录` 也返回 `code 0`。
 * 早先误判为"批次太大导致整批失败"，据此实现了二分降级——那是错的，
 * 二分只会让限流更严重。已移除。
 *
 * 限流阈值很低（连续约 3–6 次请求即触发），所以批间必须留足间隔，
 * 并且**必须**对 -503 做退避重试。
 *
 * jijidown 可用（约 800ms–1.1s/条，仅单条），作为降级来源。
 * xbeibeix 实测 20 秒超时（等效下线），不纳入。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const REQUEST_TIMEOUT_MS = 15_000;

/** 单请求里拼多少个 aid。实测 20 条没问题 */
export const BILIPLUS_BATCH_SIZE = 20;
/** 批间间隔。限流阈值低，必须留足 */
export const BILIPLUS_BATCH_DELAY_MS = 3_000;
/** 触发限流后的退避基数，按次数线性递增 */
export const BILIPLUS_RATE_LIMIT_BACKOFF_MS = 20_000;
/** 网络失败后的退避基数 */
export const BILIPLUS_NETWORK_BACKOFF_MS = 3_000;
/** 单批最多重试几次 */
export const BILIPLUS_MAX_RETRIES = 3;
/** jijidown 只支持单条，逐条查询时的间隔 */
export const JIJIDOWN_ITEM_DELAY_MS = 1_500;
/** jijidown 触发限流后的退避基数，按轮次线性递增 */
export const JIJIDOWN_BACKOFF_BASE_MS = 15_000;
/** jijidown 最多跑几轮（每轮只重试上一轮被限流的条目） */
export const JIJIDOWN_MAX_PASSES = 3;

export const BILIPLUS_CODE_ALL_MISSING = -404;
export const BILIPLUS_CODE_RATE_LIMITED = -503;

export type BiliplusBatchStatus =
  | "ok"
  | "all_missing"
  | "rate_limited"
  | "network"
  | "error";

/** 把 biliplus 的返回码映射为可处理的状态。纯函数，便于单测 */
export const classifyBiliplusResponse = (
  code: number | null,
  dataCount: number,
): BiliplusBatchStatus => {
  if (code === null) return "network";
  if (code === 0) return dataCount > 0 ? "ok" : "all_missing";
  if (code === BILIPLUS_CODE_ALL_MISSING) return "all_missing";
  if (code === BILIPLUS_CODE_RATE_LIMITED) return "rate_limited";
  return "error";
};

export interface BiliplusBatchResult {
  status: BiliplusBatchStatus;
  data: Record<string, BiliplusAidInfo>;
  code: number | null;
  message?: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const readJson = async (
  url: string,
): Promise<{ http: number | null; json: any; error?: string }> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: controller.signal,
    });
    if (!response.ok) return { http: response.status, json: null };
    const text = await response.text();
    try {
      return { http: response.status, json: JSON.parse(text) };
    } catch {
      return { http: response.status, json: null, error: "返回的不是合法 JSON" };
    }
  } catch (error) {
    const message =
      error instanceof DOMException && error.name === "AbortError"
        ? "请求超时"
        : error instanceof Error
          ? error.message
          : String(error);
    return { http: null, json: null, error: message };
  } finally {
    clearTimeout(timer);
  }
};

const parseAidInfo = (raw: unknown): Record<string, BiliplusAidInfo> => {
  const data: Record<string, BiliplusAidInfo> = {};
  if (!raw || typeof raw !== "object") return data;
  for (const [key, value] of Object.entries(raw)) {
    const info = value as BiliplusAidInfo;
    if (!info || typeof info !== "object") continue;
    data[key] = {
      title: typeof info.title === "string" ? info.title : undefined,
      pic: typeof info.pic === "string" ? info.pic : undefined,
      author: typeof info.author === "string" ? info.author : undefined,
      mid: typeof info.mid === "number" ? info.mid : undefined,
      created: typeof info.created === "number" ? info.created : undefined,
    };
  }
  return data;
};

/** 单次批量查询。**从不抛错**，结果通过 `status` 表达 */
export const fetchBiliplusAidInfo = async (aids: number[]): Promise<BiliplusBatchResult> => {
  if (aids.length === 0) return { status: "all_missing", data: {}, code: 0 };

  const result = await readJson(`https://www.biliplus.com/api/aidinfo?aid=${aids.join(",")}`);

  if (!result.json) {
    return {
      status: "network",
      data: {},
      code: null,
      message: result.error ?? `HTTP ${result.http ?? "无响应"}`,
    };
  }

  const code = typeof result.json.code === "number" ? result.json.code : null;
  const data = parseAidInfo(result.json.data);

  return {
    status: classifyBiliplusResponse(code, Object.keys(data).length),
    data,
    code,
    message: typeof result.json.message === "string" ? result.json.message : undefined,
  };
};

export interface BiliplusRetryOptions {
  maxRetries?: number;
  /** 每次退避等待时回调，便于打日志让用户知道在等 */
  onWait?: (waitMs: number, status: BiliplusBatchStatus) => void;
}

/**
 * 带退避重试的批量查询。
 *
 * 只对**限流**与**网络失败**重试——`all_missing` 是正常结果，重试没有意义。
 */
export const fetchBiliplusAidInfoWithRetry = async (
  aids: number[],
  options: BiliplusRetryOptions = {},
): Promise<BiliplusBatchResult> => {
  const maxRetries = options.maxRetries ?? BILIPLUS_MAX_RETRIES;
  let last: BiliplusBatchResult = { status: "network", data: {}, code: null };

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    last = await fetchBiliplusAidInfo(aids);
    if (last.status !== "rate_limited" && last.status !== "network") return last;
    if (attempt === maxRetries) break;

    // 限流要等得久；网络抖动则短一点
    const base =
      last.status === "rate_limited"
        ? BILIPLUS_RATE_LIMIT_BACKOFF_MS
        : BILIPLUS_NETWORK_BACKOFF_MS;
    const waitMs = base * (attempt + 1);
    options.onWait?.(waitMs, last.status);
    await sleep(waitMs);
  }

  return last;
};

/**
 * jijidown 的返回语义。**这一段是从社区脚本的真实判断逻辑反推的，必须严格照搬**：
 *
 * ```js
 * } else if (json.code == 0 || json.upid == undefined) {  // 大概率是请求过快
 *     setTitleRetry(...)   // 提示"请求过快，请点击手动加载"
 * } else if (json.upid == -1 || json.upid == 0 || json.title == "视频去哪了呢？" ...) {
 *     // 确实查不到
 * ```
 *
 * 早先把 `upid` 缺失当成"没有数据"直接丢弃，**把限流误判成了查无此片**——
 * 这是真实数据里 71 条只恢复 25 条的直接原因。
 */
export type JijidownStatus = "ok" | "not_found" | "rate_limited" | "network";

export interface JijidownResult {
  status: JijidownStatus;
  info?: BiliplusAidInfo;
  message?: string;
}

const JIJIDOWN_MISS_TITLES = ["视频去哪了呢？", "该视频或许已经被删除了"];

/** 把 jijidown 的 JSON 体映射为状态。纯函数，便于单测 */
export const classifyJijidownResponse = (json: any): JijidownStatus => {
  if (!json || typeof json !== "object") return "network";

  const upid = json.upid;

  // 先判命中：有合法 upid 就是拿到了记录，避免把成功响应当成限流
  if (typeof upid === "number" && upid > 0) {
    if (JIJIDOWN_MISS_TITLES.includes(json.title)) return "not_found";
    return "ok";
  }

  // 限流：upid 缺失，或显式 code === 0（成功响应里并没有 code 字段）
  if (upid === undefined || upid === null || json.code === 0) return "rate_limited";

  // upid 为 -1 / 0 表示确实没有这条记录
  return "not_found";
};

/**
 * jijidown 单条查询。**从不抛错**，通过 `status` 表达结果。
 *
 * HTTP 502 / 503 也是限流信号——社区脚本正是把这两个状态码映射成 `{code: 0}` 的。
 */
export const fetchJijidownInfo = async (aid: number): Promise<JijidownResult> => {
  const result = await readJson(`https://www.jijidown.com/api/v1/video/get_info?id=${aid}`);

  // 502 / 503 是 jijidown 的限流表现
  if (result.http === 502 || result.http === 503) {
    return { status: "rate_limited", message: `HTTP ${result.http}` };
  }

  if (!result.json) {
    return { status: "network", message: result.error ?? `HTTP ${result.http ?? "无响应"}` };
  }

  const status = classifyJijidownResponse(result.json);
  if (status !== "ok") return { status };

  const json = result.json;
  return {
    status: "ok",
    info: {
      title: typeof json.title === "string" ? json.title : undefined,
      pic: typeof json.img === "string" ? json.img : undefined,
      author: typeof json.up?.author === "string" ? json.up.author : undefined,
    },
  };
};
