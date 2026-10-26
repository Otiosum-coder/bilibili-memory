import { isGoneName } from "./followingDiff";
import type { FollowingItem } from "./types";

/**
 * 第三方曾用名查询（aicu.cc）。
 *
 * 只有「关注列表」里的人才查，而且**只在用户主动点击时**发请求：
 * 不是定时任务、不做任意 UID 查询、不批量自动跑。返回的 `hname` 没有时间戳、
 * 顺序不保证、也可能混入占位文案，所以只作为「第三方存档」独立展示，
 * 绝不并入本地 `nameHistory` 那条带时间的时间轴。
 */

export const THIRD_PARTY_NAME_ENDPOINT = "https://api.aicu.cc/api/v4/user/getusermark";

/** 单次请求超时。接口无文档，超时就当失败，绝不重试到天荒地老 */
export const THIRD_PARTY_LOOKUP_TIMEOUT_MS = 15_000;

/**
 * 两次查询之间的间隔。目标是人家的第三方站点，不是 B 站官方接口：
 * 比收藏夹探测（600ms）保守得多，先按 1.5s 跑，实测有问题再调。
 */
export const THIRD_PARTY_LOOKUP_INTERVAL_MS = 1_500;

/** 单次批量最多查多少人（约 5 分钟）。跑完可再点一次继续，天然断点续查 */
export const THIRD_PARTY_LOOKUP_BATCH_LIMIT = 200;

/** 连续失败这么多次就停：接口变了/被限流了，继续打只会更糟 */
export const THIRD_PARTY_LOOKUP_MAX_CONSECUTIVE_FAILURES = 3;

/**
 * 页面判断「后台任务是不是已经死了」的阈值。
 *
 * MV3 的 Service Worker 可能被浏览器休眠/重启，任务没了但 storage 里的进度还停在
 * `running`。后台每查一个人都会刷新 `updatedAt`，所以超过这个时间没更新就按中断处理，
 * 避免页面永远卡在「查询中」。
 */
export const THIRD_PARTY_LOOKUP_STALE_MS = 60_000;

const MAX_NAME_LENGTH = 30;
const MAX_NAMES_PER_USER = 200;

export interface ThirdPartyLookupResult {
  ok: boolean;
  /** 清洗后的曾用名（可能是空数组：接口正常返回但未收录） */
  names: string[];
  message?: string;
}

export interface FormerNameBatchResult {
  /** 关注总数 */
  scanned: number;
  /** 本轮计划查询的人数 */
  total: number;
  /** 本轮实际完成的人数 */
  done: number;
  /** 其中查到曾用名的人数 */
  found: number;
  /** 请求失败的人数（不写 `thirdPartyQueriedAt`，下次还能重试） */
  failed: number;
  cancelled: boolean;
}

export type FormerNameLookupStatus = "running" | "completed" | "cancelled" | "failed";

/** 页面轮询这个结构来显示「已查 X / 共 Y」 */
export interface FormerNameLookupProgress {
  status: FormerNameLookupStatus;
  total: number;
  done: number;
  found: number;
  failed: number;
  startedAt: number;
  /** 最近一次心跳时间。页面据此判断任务是活着还是已经中断 */
  updatedAt: number;
  completedAt?: number;
  message?: string;
}

/**
 * 清洗接口返回的名字：去空白、去占位文案、去超长脏数据、去重、限量。
 * 与 `buildThirdPartyNames` 的展示过滤保持一致，避免存进去的脏数据需要二次清理。
 */
export const sanitizeFormerNames = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const names: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const name = value.trim();
    if (!name || name.length > MAX_NAME_LENGTH) continue;
    if (isGoneName(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= MAX_NAMES_PER_USER) break;
  }
  return names;
};

/**
 * 解析 `getusermark` 响应。任何结构问题都归一成 `ok: false`，绝不抛错——
 * 调用方（批量任务）需要区分「查到了」「这个账号没收录」「接口挂了」。
 */
export const parseUserMarkPayload = (payload: unknown): ThirdPartyLookupResult => {
  if (!payload || typeof payload !== "object") {
    return { ok: false, names: [], message: "响应不是对象" };
  }
  const record = payload as Record<string, unknown>;
  const code = Number(record.code);
  if (!Number.isFinite(code) || code !== 0) {
    const message = typeof record.message === "string" && record.message ? record.message : `接口返回 code=${String(record.code)}`;
    return { ok: false, names: [], message };
  }
  const data = record.data;
  if (!data || typeof data !== "object") {
    return { ok: false, names: [], message: "响应缺少 data" };
  }
  // hname 缺失/不是数组时按「未收录」处理，而不是失败：
  // 接口对没有存档的账号也可能返回空对象。
  return { ok: true, names: sanitizeFormerNames((data as Record<string, unknown>).hname) };
};

/** 这个账号是否值得在卡片上直接给「查曾用名」入口：已注销 / 名字未知 / 占位文案 */
export const isSuspiciousFormerNameTarget = (item: FollowingItem): boolean =>
  item.status === "gone" || !item.name || isGoneName(item.name);

/**
 * 挑选本轮要查的人：
 * - 只查还没有 `thirdPartyQueriedAt` 的人（已查过的不重复请求）；
 * - 「可疑账号」（已注销 / 名字未知）排前面，普通关注排后面；
 * - 最多取 `limit` 个。
 */
export const pickFormerNameCandidates = (
  items: FollowingItem[],
  limit: number = THIRD_PARTY_LOOKUP_BATCH_LIMIT,
): FollowingItem[] => {
  const pending = items.filter((item) => !item.thirdPartyQueriedAt);
  pending.sort((left, right) => {
    const leftRank = isSuspiciousFormerNameTarget(left) ? 0 : 1;
    const rightRank = isSuspiciousFormerNameTarget(right) ? 0 : 1;
    if (leftRank !== rightRank) return leftRank - rightRank;
    return left.mid - right.mid;
  });
  return pending.slice(0, Math.max(0, Math.floor(limit)));
};

/** 单次查询。永远不抛错：超时 / 网络错误 / 接口变更都归一成 `ok: false` */
export const fetchThirdPartyFormerNames = async (uid: number): Promise<ThirdPartyLookupResult> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), THIRD_PARTY_LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetch(`${THIRD_PARTY_NAME_ENDPOINT}?uid=${encodeURIComponent(uid)}`, {
      method: "GET",
      signal: controller.signal,
    });
    if (!response.ok) {
      return { ok: false, names: [], message: `HTTP ${response.status}` };
    }
    const payload = await response.json();
    return parseUserMarkPayload(payload);
  } catch (error) {
    const message =
      error instanceof DOMException && error.name === "AbortError"
        ? "查询超时"
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, names: [], message };
  } finally {
    clearTimeout(timer);
  }
};
