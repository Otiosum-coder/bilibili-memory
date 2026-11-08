import { getStorageValue, setStorageValue } from "./storage";

/**
 * 数据安全日志。
 *
 * 之前封面/标题被清掉后只能靠猜：是同步覆盖、清理图片，还是浏览器清缓存。
 * 这里把“可能造成不可逆损失”的动作记下来，保留最近 100 条，方便事后定位。
 *
 * 只记录元信息，不记录图片、标题正文或账号信息。
 */
export type DataSafetyEventKind = "asset-delete" | "metadata-preserve";

export interface DataSafetyEvent {
  at: number;
  kind: DataSafetyEventKind;
  message: string;
  detail?: Record<string, string | number | boolean | undefined>;
}

export const DATA_SAFETY_LOG_KEY = "DATA_SAFETY_LOG";
const MAX_EVENTS = 100;

export const appendDataSafetyEvent = async (event: DataSafetyEvent): Promise<void> => {
  try {
    const current = (await getStorageValue<DataSafetyEvent[]>(DATA_SAFETY_LOG_KEY, [])) ?? [];
    const next = [event, ...current].slice(0, MAX_EVENTS);
    await setStorageValue(DATA_SAFETY_LOG_KEY, next);
  } catch {
    // 日志失败不能影响主流程
  }
};

export const getDataSafetyLog = async (): Promise<DataSafetyEvent[]> => {
  const current = await getStorageValue<DataSafetyEvent[]>(DATA_SAFETY_LOG_KEY, []);
  return Array.isArray(current) ? current : [];
};
