import { CHANGE_NOTIFICATION_ENABLED } from "./constants";
import { VANISH_REASON_LABEL } from "./favVanishedDiff";
import { getStorageValue } from "./storage";
import type { FollowingEvent, VanishedFavResource } from "./types";

/**
 * 变动通知。
 *
 * 存在的理由是最初的诉求：「我总是会因为不知道这些丢失的内容是什么而苦恼」。
 * 内容消失的那一刻就该让人知道，而不是等某天自己打开插件才发现。
 *
 * 两条刻意的设计约束：
 *
 * 1. **合并成一条**。一天可能有几十条变动，逐条弹通知会变成骚扰，
 *    结果就是用户直接关掉通知权限——那比不通知更糟。
 * 2. **通知失败绝不影响同步**。这只是个出口，不该成为同步链路的新故障点。
 */

/** 名称列表里最多展开几个，其余用「等 N 个」概括 */
const MAX_NAMES = 3;

export interface ChangeNotification {
  title: string;
  message: string;
}

const summarizeNames = (names: string[]): string => {
  if (names.length === 0) return "";
  const shown = names.slice(0, MAX_NAMES).join("、");
  const rest = names.length - MAX_NAMES;
  return rest > 0 ? `${shown} 等 ${names.length} 个` : shown;
};

const nameOfEvent = (event: FollowingEvent): string =>
  (event.type === "account_gone" || event.type === "renamed"
    ? event.previous_name || event.name
    : event.name) || `UID ${event.mid}`;

/**
 * 把一次同步产生的事件汇总成一条通知。没有值得通知的内容时返回 null。
 *
 * **只通知「UP 主改名」与「账号注销」这两种。**
 *
 * 新增关注与取关是用户自己在 B 站点的操作，心里有数，通知它们纯属噪音；
 * 而噪音的代价是用户干脆关掉通知权限——那样真正重要的改名与注销也就通知不到了。
 * 所以这里宁可少报，也不能把信号淹掉。
 */
export const buildFollowingNotification = (
  events: FollowingEvent[],
): ChangeNotification | null => {
  if (events.length === 0) return null;

  const gone = events.filter((event) => event.type === "account_gone");
  const renamed = events.filter((event) => event.type === "renamed");

  // 只有新增关注 / 取关时不通知
  if (gone.length === 0 && renamed.length === 0) return null;

  const lines: string[] = [];

  if (gone.length === 1) {
    lines.push(`「${nameOfEvent(gone[0])}」已注销，本地记录已保留`);
  } else if (gone.length > 1) {
    lines.push(`${summarizeNames(gone.map(nameOfEvent))} 已注销，记录已保留`);
  }

  if (renamed.length === 1) {
    const event = renamed[0];
    lines.push(`「${event.previous_name ?? "原名未知"}」改名为「${event.name}」`);
  } else if (renamed.length > 1) {
    lines.push(`${renamed.length} 位 UP 主改了名（旧名已存档）`);
  }

  return {
    title: gone.length > 0 ? "关注的 UP 主有变动" : "UP 主改名了",
    message: lines.join("\n"),
  };
};

/**
 * 收藏消失的通知。
 *
 * **只在内容真的丢了时才通知**（`content_deleted` / `content_hidden`）；
 * 单纯取消收藏是你自己的操作，不必打扰。
 */
export const buildVanishedNotification = (
  records: VanishedFavResource[],
): ChangeNotification | null => {
  if (records.length === 0) return null;

  const lost = records.filter(
    (record) => record.vanishReason === "content_deleted" || record.vanishReason === "content_hidden",
  );
  if (lost.length === 0) return null;

  const titleOf = (record: VanishedFavResource): string =>
    record.lastKnownTitle || record.title || `BV ${record.bvid || record.bv_id || "未知"}`;

  const deleted = lost.filter((record) => record.vanishReason === "content_deleted");
  const hidden = lost.filter((record) => record.vanishReason === "content_hidden");

  const lines: string[] = [];
  if (lost.length === 1) {
    const record = lost[0];
    lines.push(`「${titleOf(record)}」${VANISH_REASON_LABEL[record.vanishReason]}`);
    lines.push("消失前的内容已存入消失档案");
  } else {
    lines.push(`${lost.length} 条收藏的内容消失了，记录已存档`);
    if (deleted.length > 0) lines.push(`其中 ${deleted.length} 条已被删除`);
    if (hidden.length > 0) lines.push(`其中 ${hidden.length} 条已不可见`);
    lines.push(`例如「${titleOf(lost[0])}」`);
  }

  return {
    title: "收藏内容消失",
    message: lines.join("\n"),
  };
};

/** 通知是否启用。默认开启 */
export const isChangeNotificationEnabled = async (): Promise<boolean> =>
  await getStorageValue<boolean>(CHANGE_NOTIFICATION_ENABLED, true);

/**
 * 发送系统通知。
 *
 * **永不抛错**：通知只是输出通道，失败不该影响同步。
 * 缺少权限、被用户拒绝、平台不支持，都只记日志。
 */
export const sendChangeNotification = async (
  notification: ChangeNotification,
): Promise<void> => {
  try {
    if (!(await isChangeNotificationEnabled())) return;
    if (!browser.notifications?.create) {
      console.warn("当前环境不支持通知，已跳过");
      return;
    }

    await browser.notifications.create(`bilimemory-${Date.now()}`, {
      type: "basic",
      iconUrl: browser.runtime.getURL("/icon/96.png"),
      title: notification.title,
      message: notification.message,
    });
  } catch (error) {
    console.error("发送变动通知失败（已忽略，不影响同步）:", error);
  }
};
