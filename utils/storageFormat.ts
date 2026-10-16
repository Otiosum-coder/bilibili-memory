import type { AssetKind } from "./types";

/**
 * 存储明细的**纯计算部分**。
 *
 * 刻意与 `storageBreakdown.ts` 分开：那边要 import `db.ts`（依赖 wxt 的全局 `browser`
 * 与 IndexedDB），在 node 环境的 vitest 里跑不起来。这里只有排序与求和，
 * 可以干净地进单测。
 */

export interface AssetKindSummary {
  kind: AssetKind;
  title: string;
  /** 这些图片是什么、清掉之后会退化成什么 */
  description: string;
  count: number;
  bytes: number;
}

export interface StoreSizeSummary {
  label: string;
  count: number;
  /** 结构化数据的字节数是采样估算，条数才是精确值 */
  bytes: number;
  note?: string;
}

/** 图片归档的类别。文案要说清"清掉会怎样"——这是破坏性操作的判断依据 */
export const ASSET_KIND_META: Record<AssetKind, { title: string; description: string }> = {
  cover: {
    title: "封面图片存档",
    description:
      "收藏、订阅合集与互动记录的封面。清掉后回退到 B 站图片地址；原图已失效时显示占位图。",
  },
  avatar: {
    title: "UP 主头像存档",
    description:
      "关注列表的头像。清掉后回退到 B 站头像地址；账号注销或换过头像后无法还原。",
  },
};

/**
 * 字符串按 V8 实际存储估算字节数。
 *
 * 不能一律按 2 字节算：V8 里只有含非 Latin-1 字符的字符串才升为 two-byte，
 * 纯 ASCII（URL、bvid、时间戳那些）实际只占 1 字节。之前一律按 2 算，
 * 曾导致"本扩展业务数据合计"反而**大于**浏览器报的整站用量——那是数学上不可能的事。
 * 这里按字符类别分别计费，配合 `JSON.stringify` 的序列化开销（括号、引号、键名），
 * 已经很接近 IndexedDB 的结构化克隆结果。
 */
export const estimateJsonBytes = (json: string): number => {
  let ascii = 0;
  let wide = 0;
  for (let index = 0; index < json.length; index += 1) {
    if (json.charCodeAt(index) < 0x80) ascii += 1;
    else wide += 1;
  }
  return ascii + wide * 2;
};

/**
 * 图片按类型汇总，**按占用从大到小**排。
 * 用户是来看"谁占地方"的，排最前面的必须是最大的那个。
 */
export const summarizeAssets = (
  measured: Array<{ kind: AssetKind; count: number; bytes: number }>,
): AssetKindSummary[] =>
  measured
    .map((entry) => ({
      kind: entry.kind,
      title: ASSET_KIND_META[entry.kind].title,
      description: ASSET_KIND_META[entry.kind].description,
      count: entry.count,
      bytes: entry.bytes,
    }))
    .sort((a, b) => b.bytes - a.bytes);

/** 业务数据总量 = 图片归档 + 结构化数据 */
export const sumBreakdownBytes = (assets: AssetKindSummary[], stores: StoreSizeSummary[]): number =>
  assets.reduce((total, entry) => total + entry.bytes, 0) +
  stores.reduce((total, entry) => total + entry.bytes, 0);

/** 选中的图片类别能释放多少字节（用于"将释放 X"） */
export const sumSelectedAssetBytes = (
  assets: AssetKindSummary[],
  selected: AssetKind[],
): number =>
  assets
    .filter((entry) => selected.includes(entry.kind))
    .reduce((total, entry) => total + entry.bytes, 0);
