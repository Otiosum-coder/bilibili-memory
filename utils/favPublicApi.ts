import type { FavoriteResource } from "./types";

/**
 * B站 **非鉴权**公开收藏夹接口客户端。
 *
 * ## 为什么需要它
 *
 * 实测确认：鉴权接口 `x/v3/fav/resource/list` **不返回分P 数组 `pages`**，
 * 只有非鉴权接口 `medialist/gateway/base/spaceDetail` 才返回。
 * 而"分P标题还原"正是靠 `pages[0].title` 把失效稿件的标题救回来（见 favRecovery）。
 *
 * 真实诊断证据：
 *
 * ```
 * 样本记录诊断：aid=13452520 page=1 pages=无
 * 样本记录实际字段：... page, duration, upper, attr, cnt_info ... （有 page，无 pages）
 * ```
 *
 * 公开接口的同一批字段：`... page, pages, pubtime, rights ...`（**有 pages**，实测 3/3 条）。
 *
 * ## 两个硬约束（实测）
 *
 * 1. **`ps` 上限是 20**：传 30 / 50 / 100 时接口返回 `code 0` 但 **0 条数据**——
 *    静默失败，不是报错。所以每页只能取 20 条。
 * 2. 只能读**公开**收藏夹（`attr % 2 === 0`）。私密收藏夹需要鉴权接口，而鉴权接口没有 `pages`。
 *
 * ## 用 index 定位页码，避免翻整个收藏夹
 *
 * 收藏夹 814 条时按 `ps=20` 要翻 41 页。但记录的 `index`（在收藏夹中的位置）**已经存在库里**，
 * 因此可以直接算出它落在第几页，只请求那几页——把 41 次请求降到个位数。
 *
 * 前提是两次请求使用相同的 `order`。所以这里显式传 `order=mtime`，
 * 与收藏夹同步使用的排序保持一致。若排序不一致会匹配不到，但不会写错数据
 * （匹配失败就跳过，见 `buildPublicMediaMap`）。
 */

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const HEADERS = {
  "User-Agent": UA,
  Referer: "https://space.bilibili.com/",
  Origin: "https://space.bilibili.com",
};

const REQUEST_TIMEOUT_MS = 15_000;

/** 服务端硬上限，传更大值会静默返回 0 条 */
export const PUBLIC_FAV_PAGE_SIZE = 20;
/** 翻页之间的间隔 */
export const PUBLIC_FAV_PAGE_DELAY_MS = 2_500;
/** 单次恢复最多请求多少页，防止意外翻完整个收藏夹。
 *  40 页 × 2.5s 会让恢复末尾静默等 100 秒，降到 20 页（500 条覆盖）后仍有兜底作用 */
export const PUBLIC_FAV_MAX_PAGES_PER_RUN = 20;

export interface PublicFavMedia {
  id: number;
  title?: string;
  cover?: string;
  bvid?: string;
  page?: number;
  pages?: Array<{ title?: string }>;
  attr?: number;
}

export interface PublicFavPageResult {
  ok: boolean;
  medias: PublicFavMedia[];
  code: number | null;
  message?: string;
}

/** 由记录在收藏夹中的位置推出它落在第几页（1 起） */
export const derivePublicPage = (index: number | undefined): number => {
  const safe = typeof index === "number" && Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0;
  return Math.floor(safe / PUBLIC_FAV_PAGE_SIZE) + 1;
};

export interface PublicPageTask {
  folderId: number;
  page: number;
  /** 该页上属于我们候选集的 aid */
  aids: Set<number>;
}

/**
 * 把候选按「收藏夹 + 页码」分组，求出**只需请求哪几页**。
 *
 * 同一个文件夹的同一页只会出现一次，即使页上有多个候选。
 */
export const groupCandidatesByPage = (
  resources: FavoriteResource[],
): PublicPageTask[] => {
  const tasks = new Map<string, PublicPageTask>();

  for (const resource of resources) {
    const folderId = Number(resource.folder_id);
    if (!Number.isInteger(folderId)) continue;

    const page = derivePublicPage(resource.index);
    const key = `${folderId}:${page}`;
    const existing = tasks.get(key);
    if (existing) {
      existing.aids.add(resource.id);
    } else {
      tasks.set(key, { folderId, page, aids: new Set([resource.id]) });
    }
  }

  // 同一收藏夹内按页码升序，减少来回跳页
  return [...tasks.values()].sort(
    (a, b) => a.folderId - b.folderId || a.page - b.page,
  );
};

const parseMedia = (raw: any): PublicFavMedia | null => {
  if (!raw || typeof raw !== "object") return null;
  const id = Number(raw.id);
  if (!Number.isInteger(id) || id <= 0) return null;

  return {
    id,
    title: typeof raw.title === "string" ? raw.title : undefined,
    cover: typeof raw.cover === "string" ? raw.cover : undefined,
    bvid: typeof raw.bvid === "string" ? raw.bvid : undefined,
    page: typeof raw.page === "number" ? raw.page : undefined,
    pages: Array.isArray(raw.pages)
      ? raw.pages.map((part: any) => ({
          title: typeof part?.title === "string" ? part.title : undefined,
        }))
      : undefined,
    attr: typeof raw.attr === "number" ? raw.attr : undefined,
  };
};

/** 取公开收藏夹的某一页。**从不抛错** */
export const fetchPublicFavPage = async (
  folderId: number,
  page: number,
): Promise<PublicFavPageResult> => {
  const url =
    `https://api.bilibili.com/medialist/gateway/base/spaceDetail?media_id=${folderId}` +
    `&pn=${page}&ps=${PUBLIC_FAV_PAGE_SIZE}&keyword=&order=mtime&type=0&tid=0&jsonp=jsonp`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { headers: HEADERS, signal: controller.signal });
    if (!response.ok) {
      return { ok: false, medias: [], code: null, message: `HTTP ${response.status}` };
    }

    const json = await response.json();
    const code = typeof json?.code === "number" ? json.code : null;
    if (code !== 0) {
      return {
        ok: false,
        medias: [],
        code,
        message: typeof json?.message === "string" ? json.message : "公开接口未返回成功",
      };
    }

    const rawMedias = Array.isArray(json?.data?.medias) ? json.data.medias : [];
    return {
      ok: true,
      medias: rawMedias.map(parseMedia).filter(Boolean) as PublicFavMedia[],
      code,
    };
  } catch (error) {
    const message =
      error instanceof DOMException && error.name === "AbortError"
        ? "请求超时"
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, medias: [], code: null, message };
  } finally {
    clearTimeout(timer);
  }
};
