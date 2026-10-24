/**
 * 「本地曾用名存档」的构建期开关，取值见 utils/nameArchive.ts 的 `NAME_ARCHIVE_ENABLED`。
 *
 * 判定顺序：
 * - dev server / development 构建：`import.meta.env.DEV === true`，功能启用；
 * - 商店构建（`pnpm zip`，mode=production）：DEV 为 false、且没有下面这个变量，功能关闭，
 *   设置页不渲染导入面板、关注列表不读取本机切片；
 * - 想让本地 production 构建也带：构建时设 `VITE_NAME_ARCHIVE_LOCAL=1`。
 */
interface ImportMetaEnv {
  readonly VITE_NAME_ARCHIVE_LOCAL?: string;
}
