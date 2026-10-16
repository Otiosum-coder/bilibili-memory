import type { FavoriteResource } from "./types";
import type { ViewProbeResult } from "./favVanishedDiff";

/**
 * 收藏资源的二次探测：对"在线消失"的条目查一次视频详情，尽力区分
 * "你取消了收藏"与"内容被删除/隐藏"。
 *
 * Phase 1b / Phase 2 实测：
 * - `x/web-interface/view` **不需要 WBI 签名**，扩展内可直接调用
 * - `aid` 与 `bvid` 两种参数结果完全一致
 * - 返回码 `0` / `-404` / `62002` 三者可区分
 *
 * 本函数**从不抛错**：任何失败都归一成 `ok: false`，由调用方按"原因不明"留档。
 * 探测失败绝不能被当作"可以安全删除"。
 */

const PROBE_TIMEOUT_MS = 20_000;

/**
 * 逐条探测之间的间隔。探测是"在线消失"才触发的低频路径，但仍要给接口留余地，
 * 避免一次全量同步后集中探测触发风控。
 */
export const VANISH_PROBE_DELAY_MS = 600;

/** 取出可用于探测的 BV 号。`bv_id` 与 `bvid` 在不同接口版本里互相缺省 */
export const resolveProbeBvid = (resource: FavoriteResource): string =>
  (resource.bvid || resource.bv_id || "").trim();

export const probeFavoriteResource = async (
  resource: FavoriteResource,
  sessdata: string,
): Promise<ViewProbeResult> => {
  const bvid = resolveProbeBvid(resource);
  if (!bvid) return { ok: false, code: null, message: "缺少 BV 号，无法探测" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      {
        headers: { Cookie: `SESSDATA=${sessdata}` },
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      return { ok: false, code: null, message: `HTTP ${response.status}` };
    }

    const data = await response.json();
    const code = Number(data?.code);
    return {
      ok: true,
      code: Number.isFinite(code) ? code : null,
      message: typeof data?.message === "string" ? data.message : null,
    };
  } catch (error) {
    const message =
      error instanceof DOMException && error.name === "AbortError"
        ? "探测超时"
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, code: null, message };
  } finally {
    clearTimeout(timer);
  }
};
