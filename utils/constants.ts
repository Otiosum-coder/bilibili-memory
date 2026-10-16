export const IS_SYNC_DELETE = "isSyncDelete";
export const IS_SYNC_DELETE_FROM_BILIBILI = "isSyncDeleteFromBilibili";

/**
 * 注入脚本 <-> content script 的页面级 window 消息类型。
 *
 * 必须带项目前缀：页面上的 window.postMessage 对所有扩展的 content script 可见，
 * 若沿用上游的 `DELETE_HISTORY_FROM_INJECT`，当本扩展与上游扩展同时安装时，
 * 一份消息会被两个扩展各处理一次，造成串台。
 */
export const PAGE_MESSAGE_DELETE_HISTORY = "BILIMEMORY_DELETE_HISTORY";

/** 注入脚本的防重复包装标志，同样带项目前缀以免与其它扩展互相误判 */
export const INJECTED_FETCH_GUARD_KEY = "__BILIMEMORY_FETCH_INTERCEPTED__";

export const HAS_FULL_SYNC = "hasFullSync";
export const HAS_FULL_FAV_SYNC = "hasFullFavSync";

export const HISTORY_LAST_SYNC = "lastSync";

export const SYNC_INTERVAL = "syncInterval";

export const SYNC_TIME_REMAIN = "syncTimeRemain";

export const FAV_AUTO_SYNC_ENABLED = "favAutoSyncEnabled"; // auto favorites sync switch, default false
export const FAV_SYNC_INTERVAL = "favSyncInterval"; // 单位：分钟，默认 60*24 (1天)
export const FAV_SYNC_TIME_REMAIN = "favSyncTimeRemain"; // 单位：分钟
export const FAVORITE_FOLDER_SYNC_PROGRESS = "favoriteFolderSyncProgress";
export const ALL_FAVORITE_FOLDERS_SYNC_PROGRESS = "allFavoriteFoldersSyncProgress";

export const HIDE_USER_INFO = "hideUserInfo";
export const HIDDEN_MENUS = "hiddenMenus"; // Array of hidden titles
export const SIDEBAR_MENU_ORDER = "sidebarMenuOrder"; // Array of titles, 侧边栏显示顺序
export const GRID_COLUMNS = "gridColumns";
// history page load mode: "pagination" | "scroll", default "pagination"
export const HISTORY_LOAD_MODE = "history_load_mode";
// page size for the history page pagination mode, default 100
export const HISTORY_PAGE_SIZE = "history_page_size";
// history list semantics: "content" keeps one latest row per item; "visit" shows observed views
export const HISTORY_DISPLAY_MODE = "history_display_mode";
// whether the history page search and filter row is expanded, default true
export const HISTORY_TOOLBAR_EXPANDED = "history_toolbar_expanded";
// newest API view_at from the last complete history sync
export const HISTORY_SYNC_WATERMARK_VIEW_AT = "history_sync_watermark_view_at";
export const HISTORY_EVENT_MIGRATION_REPORT = "history_event_migration_report";
export const HISTORY_LEGACY_TOMBSTONES_MIGRATED = "history_legacy_tombstones_migrated";
export const LAST_SEEN_UPDATE_VERSION = "lastSeenUpdateVersion";
export const STORAGE_LAST_WARNING = "storageLastWarning";
export const BACKUP_REMINDER_LAST_DISMISSED_AT = "backupReminderLastDismissedAt";
export const BACKUP_LAST_EXPORT_AT = "backupLastExportAt";
export const MANUAL_BACKUP_ITEMS = "manualBackupItems";
export const FIRST_RUN_GUIDE_COMPLETED = "firstRunGuideCompleted";

// 历史记录本地目录自动备份
export const LOCAL_HISTORY_BACKUP_ALARM = "localHistoryBackup";
export const LOCAL_HISTORY_BACKUP_ENABLED = "localHistoryBackupEnabled";
export const LOCAL_HISTORY_BACKUP_ITEMS = "localHistoryBackupItems";
export const LOCAL_HISTORY_BACKUP_INTERVAL_HOURS = "localHistoryBackupIntervalHours";
export const LOCAL_HISTORY_BACKUP_RETENTION_COUNT = "localHistoryBackupRetentionCount";
export const LOCAL_HISTORY_BACKUP_DIRECTORY_NAME = "localHistoryBackupDirectoryName";
export const LOCAL_HISTORY_BACKUP_LAST_ATTEMPT_AT = "localHistoryBackupLastAttemptAt";
export const LOCAL_HISTORY_BACKUP_LAST_SUCCESS_AT = "localHistoryBackupLastSuccessAt";
export const LOCAL_HISTORY_BACKUP_LAST_FILE_NAME = "localHistoryBackupLastFileName";
export const LOCAL_HISTORY_BACKUP_LAST_RECORD_COUNT = "localHistoryBackupLastRecordCount";
export const LOCAL_HISTORY_BACKUP_LAST_ERROR = "localHistoryBackupLastError";
export const LOCAL_HISTORY_BACKUP_LAST_CLEANUP_WARNING = "localHistoryBackupLastCleanupWarning";
export const LOCAL_HISTORY_BACKUP_NEEDS_PERMISSION = "localHistoryBackupNeedsPermission";
export const DEFAULT_LOCAL_HISTORY_BACKUP_INTERVAL_HOURS = 24;
export const DEFAULT_LOCAL_HISTORY_BACKUP_RETENTION_COUNT = 30;

// 关注 UP 主追踪（following / followingEvents）
export const HAS_FULL_FOLLOWING_SYNC = "hasFullFollowingSync"; // 首次基线是否已建立
export const FOLLOWING_LAST_SYNC = "followingLastSync"; // 上次成功同步完成时间
export const FOLLOWING_AUTO_SYNC_ENABLED = "followingAutoSyncEnabled"; // 默认 true
export const FOLLOWING_SYNC_INTERVAL = "followingSyncInterval"; // 单位：分钟，默认 60*24
export const FOLLOWING_SYNC_PROGRESS = "followingSyncProgress"; // 游标与进度
export const DEFAULT_FOLLOWING_SYNC_INTERVAL_MINUTES = 60 * 24;
export const DEFAULT_FOLLOWING_AUTO_SYNC_ENABLED = true;

// 收藏夹自动同步（favFolders / favResources）
//
// 与关注/互动不同，收藏**一直只有手动同步**。补上定时任务，但默认关闭：
// 收藏的全量同步才会做"消失判定"（增量不判，见 buildVanishCandidates 的护栏），
// 而全量会翻完整个收藏夹并对消失条目逐条探测——开销明显大于增量，不该悄悄默认跑。
//
// 日常自动同步走**增量**（拉到本地边界就停），只有到 `FAV_FULL_SYNC_INTERVAL`
// 才做一次全量，用来发现"视频从收藏夹消失"。
export const FAVORITES_AUTO_SYNC_ENABLED = "favAutoSyncEnabled"; // 默认 false
export const FAVORITES_SYNC_INTERVAL = "favSyncInterval"; // 单位：分钟，默认 12 小时
export const FAVORITES_LAST_SYNC = "favLastSync"; // 上次成功同步完成时间
export const FAVORITES_LAST_FULL_SYNC = "favLastFullSync"; // 上次全量同步完成时间（只有全量做消失判定）
export const FAVORITES_FULL_SYNC_INTERVAL = "favFullSyncInterval"; // 单位：分钟，默认 7 天
export const DEFAULT_FAV_AUTO_SYNC_ENABLED = false;
export const DEFAULT_FAV_SYNC_INTERVAL_MINUTES = 60 * 12;
export const DEFAULT_FAV_FULL_SYNC_INTERVAL_MINUTES = 60 * 24 * 7;

// 注销前名字：第三方曾用名查询（aicu.cc）。
// 默认关闭、仅用户主动触发、仅限名字已是占位文案的账号。见 docs/following-tracker-design.md 4.1
export const THIRD_PARTY_NAME_LOOKUP_ENABLED = "thirdPartyNameLookupEnabled";
export const DEFAULT_THIRD_PARTY_NAME_LOOKUP_ENABLED = false;

// 图片字节归档（头像 / 收藏封面）。字节只存本地，不进 WebDAV 与本地目录备份
export const FOLLOWING_AVATAR_ARCHIVE_PROGRESS = "followingAvatarArchiveProgress";
export const FAV_COVER_ARCHIVE_PROGRESS = "favCoverArchiveProgress";
/** 订阅合集内容的封面归档进度。与收藏封面共用 `assets` 的 cover 类型 */
export const COLLECTION_COVER_ARCHIVE_PROGRESS = "collectionCoverArchiveProgress";
/** 关注/收藏发生变动时是否弹系统通知。默认开启 */
export const CHANGE_NOTIFICATION_ENABLED = "changeNotificationEnabled";

// 点赞 / 投币互动记录（interactions）
//
// 间隔刻意比关注同步短得多：B 站的「最近点赞的视频」/「最近投币的视频」都是滚动窗口，
// 匿名实测固定只返回 20 条。间隔太长会让新点赞在两次同步之间就被挤出窗口，永久丢失。
export const INTERACTIONS_LAST_SYNC = "interactionsLastSync"; // 上次同步完成时间
export const INTERACTIONS_AUTO_SYNC_ENABLED = "interactionsAutoSyncEnabled"; // 默认 true
export const INTERACTIONS_SYNC_INTERVAL = "interactionsSyncInterval"; // 单位：分钟，默认 3 小时
export const INTERACTIONS_SYNC_PROGRESS = "interactionsSyncProgress";
export const INTERACTIONS_COVER_ARCHIVE_PROGRESS = "interactionsCoverArchiveProgress";
export const DEFAULT_INTERACTIONS_AUTO_SYNC_ENABLED = true;
export const DEFAULT_INTERACTIONS_SYNC_INTERVAL_MINUTES = 60 * 3;
/**
 * 访问 B 站个人主页（space.bilibili.com）时顺带补一次同步的最小间隔。
 *
 * 这么做的唯一理由是那 20 条滚动窗口：定时同步要 3 小时才跑一次，中间点赞多了，
 * 早的那几条就被挤出窗口、永久丢失。用户正在浏览 B 站时顺手抓一把最划算。
 * 这类补充同步**不做消失判定**（不探测，见 background 的 maxProbesPerRun: 0）——
 * 判定交给定时任务，避免浏览页面时反复对接口发探测请求。
 */
export const INTERACTIONS_PAGE_TRIGGER_LAST_AT = "interactionsPageTriggerLastAt";
/**
 * 互动记录是否已经完成过第一次同步。
 *
 * 首轮抓到的记录只能说明"在你开始记录之前就已经点过赞/投过币"，
 * 界面据此显示「早期」而不是把同步时刻伪装成互动时间。
 */
export const INTERACTIONS_FIRST_SYNC_AT = "interactionsFirstSyncAt";
export const DEFAULT_INTERACTIONS_PAGE_TRIGGER_GAP_MINUTES = 30;

// WebDAV 同步相关
export const WEBDAV_CONFIG = "webdavConfig";
export const WEBDAV_LAST_SYNC = "webdavLastSync";
export const WEBDAV_AUTO_SYNC_ENABLED = "webdavAutoSyncEnabled";
export const WEBDAV_AUTO_SYNC_INTERVAL = "webdavAutoSyncInterval"; // 单位：分钟，默认 30
export const WEBDAV_SYNC_ITEMS = "webdavSyncItems"; // 勾选的同步数据项，页面与后台自动同步共用

/**
 * 各数据项是否参与备份，新配置默认全部选中。
 *
 * 注意：**「喜欢的音乐」刻意不在备份范围内**——对应页面在 fork 中已移除。
 * 它的 store 与读取接口仍然保留，因为「恢复失效收藏」的本地交叉引用要拿它当封面来源
 * （见 background 的 buildLocalCoverIndex），只是不再写进任何备份文件。
 */
export const DEFAULT_WEBDAV_SYNC_ITEMS = {
  history: true,
  favFolders: true,
  favResources: true,
  subscribedCollections: true,
  subscribedCollectionResources: true,
  following: true,
  followingEvents: true,
  vanishedFavResources: true,
  interactions: true,
  /** 统一消失档案（v11）。**必须进备份**：它是"内容已经查不到"的唯一留档，
   *  本地丢失就等于永久丢失，与图片字节那种可再抓的缓存完全不同 */
  vanishArchive: true,
};

export type BackupItems = typeof DEFAULT_WEBDAV_SYNC_ITEMS;
export type BackupItemKey = keyof BackupItems;
export type WebDavSyncItems = BackupItems;
export type WebDavSyncKey = BackupItemKey;

/** 本地目录备份默认仅包含历史记录，用户可在备份页调整 */
export const DEFAULT_LOCAL_HISTORY_BACKUP_ITEMS: BackupItems = {
  history: true,
  favFolders: false,
  favResources: false,
  subscribedCollections: false,
  subscribedCollectionResources: false,
  following: false,
  followingEvents: false,
  vanishedFavResources: false,
  interactions: false,
  /**
   * 消失档案默认**包含**。
   *
   * 与其他项不同，它不是"能重新同步回来"的数据——内容已经查不到了，
   * 本地那份是唯一副本。默认排除等于让用户在一次盘崩里永久失去它。
   * （`vanishedFavResources` 是它的旧前身，保持默认排除以免改变既有行为。）
   */
  vanishArchive: true,
};

/**
 * 图片字节（`assets` store）**刻意不进任何备份**。
 *
 * 理由：它是纯缓存——内容还在时随时能重新抓；真要防丢失，靠的是本地归档任务，
 * 而不是让备份体积膨胀几十 MB 并拖慢 WebDAV 同步。
 */
export const BLOB_ASSET_ITEMS: readonly BackupItemKey[] = [];

export const OPENAI_API_KEY = "openaiApiKey";
export const OPENAI_BASE_URL = "openaiBaseUrl";
export const OPENAI_MODEL = "openaiModel";
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const AI_SEARCH_HISTORY = "aiSearchHistory";

// WebDAV 双向同步时本地已删除历史记录的墓碑集合，用于阻止远端旧数据复活
export const DELETED_HISTORY_IDS = "deletedHistoryIds";

// "light" | "dark"
export const THEME_MODE = "themeMode";

export const UPDATE_HISTORY = [
  {
    date: "2026-10-15",
    version: "0.3.0",
    changes: [
      "新增「消失档案」页面：收藏、订阅合集、关注、互动四处的「内容已查不到」统一汇总，可搜索、按来源与原因筛选、导出",
      "修复订阅合集会丢数据：合集同步原先整夹替换，视频从合集移出就永久消失、连 BV 号都不剩；现在改为**先留档再替换**，消失前先做稿件探测区分「已移出合集 / 稿件被删 / 不可见」",
      "互动记录里「稿件被删 / 不可见」的条目自动汇入消失档案；只是掉出 20 条窗口或尚未核查的**不进档案**（内容还在）",
      "关注账号注销时把快照汇入消失档案，改名链路与现有状态一并展示",
      "消失档案纳入 WebDAV / 本地目录 / JSON 备份默认范围——它是内容消失后的唯一副本，与可再抓的图片缓存不同",
      "数据库结构升级到 v11，新增统一消失档案存储；旧版收藏档案保持可读，页面合并展示",
      "设置页新增「存储明细」：按类别列出占用，图片字节为精确值、结构化数据为采样估算，并可分类清理图片归档",
      "互动记录排序重做为四档（日期新→旧 / 旧→新、时长长→短 / 短→长），排序改为按真实日期并修正约 20 条并列记录的次序颠倒问题",
      "互动记录卡片：失效内容改用标题删除线（与收藏页一致），不再整卡加透明度；状态文案改为「点赞过 / 取消点赞 / 未判定」",
      "设置页移除「历史记录加载方式」与「日期选择方式」：加载方式统一收在历史页的「历史视图设置」弹窗，日期只保留范围选择",
      "修复分页模式改每页条数、切换加载方式后未回到第一页，以及下拉加载重复请求的问题",
    ],
  },
  {
    date: "2026-10-13",
    version: "0.2.0",
    changes: [
      "新增「互动记录」页面：永久保存你点赞过与投币过的视频，B 站只保留最近 20 条、超出就再也查不到",
      "列表里消失的条目绝不删除：先留档，再用稿件详情与互动状态二次探测，尽力区分「你取消了」「稿件被删」「稿件不可见」",
      "探测到「B 站列表不再展示、但点赞/投币其实还在」的条目会单独标记——这条信息只有本地副本才有",
      "投币记录保留接口给的真实投币时间与投币枚数；点赞接口不返回点赞时间，界面如实标注为「首次记录时间」",
      "首次观测到的视频标题单独存档、永不被后续覆盖，稿件改名或被删后仍能看到当时点的是什么",
      "互动记录的封面纳入字节归档，封面被换成占位图后仍可追溯",
      "互动记录默认参与 WebDAV、本地目录与 JSON 备份，导入前预览与合并策略均已覆盖",
      "数据库结构升级到 v10，新增点赞/投币记录存储",
      "接口能力边界已对照同类项目 BilibiliHistoryFetcher 复核：点赞与投币都只有「最近列表」、点赞没有时间字段，历史记录无法找回",
      "数据来源就是个人主页的两个模块；翻页参数已穷举验证全部无效，因此改为「访问个人主页时顺手补抓一次」（半小时最多一次、只抓不判定）",
      "互动记录页的状态筛选收敛为三档（全部 / 仍在列表 / 已不在列表），精确原因只在卡片上显示，不再铺一屏的 0",
      "互动记录不设「全部」页：点赞与投币各自一个 tab，卡片上不再重复写类型，也不再出现两张几乎一样的卡",
      "互动记录卡片去掉图标与「首次记录时间」：只留必要的一格日期，投币显示真实时间（三天内相对、更早绝对），点赞卡不显示日期（悬停里说明）",
      "互动记录页改为一屏四列；卡片页脚左作者、右日期，与仓库其它页面保持同一套排版",
      "互动记录卡片与收藏页对齐：类型入口回到左侧栏、类型图标放进封面、页脚左作者右完整日期",
      "互动记录不再显示投币枚数（仍照常记录进数据与备份），投币角标改用单枚硬币图标",
      "互动记录卡片不再显示 BV 号与复制按钮",
      "总览页与周报/月报里的「星期分布」改为「时段分布」：24 小时每小时一根柱子，横轴每 3 小时标一个 H:00——周几看得多对回顾没有指导意义，「几点看得多」才有",
      "总览页构成面板改为等宽两列：「变动构成」与「每日变动趋势」是同一份数据的两种画法，已删除；互动记录构成改按类型拆（点赞 / 投币分色），状态改为圆点小结",
      "互动记录的封面图标改为描边样式且不再带底色：点赞是描边大拇指（保持粉色），投币是描边圆加「币」字",
      "总览页的日趋势图支持在柱状 / 折线 / 热力图之间切换；时段分布的柱子改成跨 24 小时连续渐变（蓝→绿→黄→橙→粉），每根柱子另有上浅下深的渐变",
      "「最爱时段」并入时段分布图（图表占满整行，24 根柱子不再被挤扁），并照 B 站「观看时间分析」加上 Y 轴刻度与网格线",
      "周报 / 月报 / 年报新增「本期关注变动」：新增关注多少、取关多少（另有改名与账号注销）",
      "时段分布与「最爱时段」改为跟随所选时间窗口（近 7 天 / 30 天 / 90 天 / 一年），此前无论怎么选都吃全量数据",
      "热力图的分档改成按具体数量区间（图例直接写「1–10 / 11–20 …」），不再用相对四分位",
      "年度报告里「看得最多的 UP 主」扩到 10 位并加占比条，右侧补上「视频时长分布」扇形图（缺时长的单列一档）",

    ],
  },
  {
    date: "2026-10-07",
    version: "0.1.0",
    changes: [
      "项目更名为「哔哩哔哩记忆」并更换图标，与上游 bilibili-history-wxt 区分",
      "移除上游作者的官网、微信、交流群与赞赏入口，改为标明出处与上游仓库地址",
      "移除会把历史数据发往第三方服务器的「云同步」功能，用户身份改为读取本地 B 站登录态",
      "数据库结构升级到 v9，新增关注追踪、消失档案与图片归档所需的存储",
      "新增「关注」页面：记录关注的 UP 主，每天统计新增关注、取关、改名与账号注销",
      "新增「数据面板」：汇总各模块数据量、关注变动趋势与数据健康度",
      "新增「消失档案」：收藏内容消失时不再直接删除本地记录，先留档再移除，避免证据被自己抹掉",
      "新增失效内容恢复：通过公开收藏夹接口、第三方档案与本地交叉引用找回已失效视频的标题与封面",
      "收藏夹卡片区分三种状态：正常、已失效但信息已保留、已失效且信息缺失，并支持一键复制完整信息",
      "新增封面字节归档：在封面还正常时把图片存到本地，防止内容被删或被替换为占位图后无从追溯",
      "备份范围扩展到关注列表、关注变动与消失档案，WebDAV 自动同步、本地目录备份与 JSON 导出导入均已覆盖",
      "移除「AI探索」与「听歌」两个功能，以及「消失档案」查看页面（档案机制本身保留，数据不会被硬删除）",
      "新增变动通知：UP 主注销、改名、取关或收藏内容消失时主动弹系统通知，不再需要自己打开插件才发现",
      "订阅合集的封面也纳入字节归档；恢复失效内容时顺手把封面字节存下来",
      "数据面板的归档进度改为实时更新，长任务不再只能干等",
      "本地目录备份新增 images/ 子目录，把归档的图片字节一图一文件写出来；此前这些字节不在任何备份里",
      "JSON 导入前先预览：列出每一项会新增多少、本地已有多少，确认后才写入",
      "新增通用格式导出：收藏、关注、消失档案可导出为 CSV（带 BOM，Excel 不乱码）或 Markdown",
      "关注头像与收藏封面开始归档图片字节，防止账号注销或视频失效后被替换为占位图",
    ],
  },
  {
    date: "2026-09-13",
    version: "2.2.3",
    changes: ["修复历史记录页面的分类筛选和日期选择弹层无法显示的问题"],
  },
  {
    date: "2026-09-12",
    version: "2.2.2",
    changes: [
      "修复删除页面中下部历史记录后自动回到顶部的问题，连续删除时无需反复滚动",
      "优化历史记录页面的视觉层级与交互体验，完善加载、错误、空状态、分页和日期筛选操作",
      "历史记录页新增搜索与筛选区域折叠功能，并自动记住上次的展开状态",
      "优化数据备份页面的视觉层级与交互状态，统一本地目录、WebDAV 和 JSON 备份体验",
      "本地目录自动备份支持自由选择历史记录、音乐、收藏和合集数据，默认仅备份历史记录",
      "完善备份文件兼容性，支持恢复任意数据组合，并修复恢复出厂设置后历史页面卡在加载状态的问题",
      "恢复出厂设置改为清空业务数据和本地配置，同时保留本地备份目录授权及已有备份文件",
      "更新赞赏名单",
    ],
  },
  {
    date: "2026-09-09",
    version: "2.2.1",
    changes: [
      "移除按视频删除历史记录时的二次确认弹窗，恢复快捷删除体验",
      "修复订阅合集首次同步未发起请求、导致合集列表为空的问题，并优化本地缓存加载逻辑",
    ],
  },
  {
    date: "2026-09-08",
    version: "2.2.0",
    changes: [
      "历史记录支持在“按视频”和“按观看次数”之间切换，支持了同一视频在不同时间观看算作多条记录",
      "优化增量同步边界判断，使用观看时间水位跨页扫描，避免重看已有视频时漏记新的观看记录",
      "完善历史删除语义，可单独删除某次本地观看，并通过删除墓碑防止备份同步后旧记录复活",
      "升级 JSON、本地目录和 WebDAV 历史备份格式，完整保留多次观看记录并兼容旧版数据",
    ],
  },
  {
    date: "2026-08-20",
    version: "2.1.5",
    changes: [
      "统一将“自动/手动备份”更名为“数据备份”，并修复本地备份周期和保留份数下拉列表被裁切、无法滚动的问题",
      "统一视频时长格式，听歌搜索结果中的时长支持补齐前导零显示",
      "设置页面新增隐藏 AI 探索选项，支持控制侧边栏 AI 探索菜单的显示状态",
    ],
  },
  {
    date: "2026-08-16",
    version: "2.1.4",
    changes: [
      "优化收藏夹同步与管理：支持清空本地收藏、删除本地收藏夹，并增强全部收藏夹同步进度、失败重试及中断续传",
      "单个收藏夹触发 B 站访问风控后支持保存进度、显示冷却倒计时并从断点继续同步",
      "历史记录和收藏夹页面的主题强调色调整为粉色，统一相关弹窗与操作反馈样式",
      "修复历史记录同步循环和分页异常；WebDAV 使用删除墓碑阻止已删记录复活，并加密保存连接凭据",
      "完善 WebDAV、本地目录和 JSON 备份中心，支持选择备份数据范围并新增首次使用引导",
      "AI 语义探索支持自定义 OpenAI 兼容接口和模型，并兼容流式与非流式响应",
      "增强订阅合集、云同步、恢复出厂设置及听歌登录态等功能的稳定性",
    ],
  },
  {
    date: "2026-08-04",
    version: "2.1.3",
    changes: ["修复同步历史记录一直卡在同步进行中的bug"],
  },
  {
    date: "2026-08-03",
    version: "2.1.2",
    changes: [
      "设置页面新增历史记录本地自动备份：支持选择备份目录、设置备份周期和保留份数，并可随时立即备份",
    ],
  },
  {
    date: "2026-08-03",
    version: "2.1.1",
    changes: ["优化数据备份提醒：改为每 7 天显示一次，并支持在弹窗中直接导出历史记录 JSON"],
  },
  {
    date: "2026-08-02",
    version: "2.1.0",
    changes: [
      "精简同步状态界面，优化历史记录同步响应处理",
      "历史记录页面新增手动增量/全量同步，并将加载方式和每行列数整合至视图设置",
      "收藏夹支持按文件夹手动增量/全量同步",
      "增强 IndexedDB 存储保护，新增存储状态、容量与写入异常提示",
      "收藏夹支持一键增量/全量同步全部文件夹，并展示各文件夹同步结果",
      "默认关闭“B站删除记录时同步删除本地记录”，降低本地历史记录误删风险",
      "后台同步去掉自动同步收藏夹的逻辑",
      "定期弹出数据备份提示，提醒用户备份历史记录，防止丢失",
    ],
  },
  {
    date: "2026-07-20",
    version: "2.0.0",
    changes: [
      "历史记录页面支持分页加载和下拉加载，支持切换",
      "新增订阅合集管理",
      "优化webdav数据管理",
    ],
  },
  {
    date: "2026-07-08",
    version: "1.9.9",
    changes: [
      "增加赞赏名单",
      "为 DNR 规则 8 增加 initiatorDomains 限制发起方, 避免误伤 www 页搜索 API",
      "设置页增加自动同步收藏夹控制开关，开启以后插件才会在后台定时自动同步收藏夹数据",
    ],
  },
  {
    date: "2026-05-03",
    version: "1.9.8",
    changes: ["增加白天/黑夜模式", "增加更新特性的弹窗", "增加赞赏入口"],
  },
  {
    date: "2026-03-14",
    version: "1.9.7",
    changes: [
      "新增 AI语义探索 功能，输入API Key即可模糊寻找遗忘历史记录",
      "优化收藏夹同步机制为增量同步（按需重试机制），大幅减少API请求",
      "新增收藏夹界面专属深度搜索栏，支持实时检索（标题、UP主、AV/BV号等）",
      "优化标签UI：添加“已收藏”标志并重构历史徽章位置",
    ],
  },
  {
    date: "2026-03-02",
    version: "1.9.6",
    changes: ["新增WebDAV同步功能", "优化部分UI"],
  },
  {
    date: "2026-02-26",
    version: "1.9.5",
    changes: ["修复搜索音乐时搜索失败的问题"],
  },
  {
    date: "2026-02-23",
    version: "1.9.4",
    changes: [
      "修复更新插件后历史记录丢失的问题",
      "新增历史记录列数自定义调节功能",
      "修复多个TypeScript类型错误",
      "修复HMR 重载后就会复现历史记录页面无法滚动的bug",
    ],
  },
  {
    date: "2026-02-23",
    version: "1.9.3",
    changes: ["修复滚动加载更多却没有加载更多的bug", "历史记录的列数根据屏幕适配"],
  },
  {
    date: "2026-02-14",
    version: "1.9.2",
    changes: [
      "历史记录页面支持AV号搜索",
      "新增日期选择模式（范围选择/单日点击）",
      "修复切换筛选时无法刷新的问题",
      "添加观看进度显示",
      "添加搜索选项选择",
    ],
  },
  {
    date: "2026-02-05",
    version: "1.9.1",
    changes: [
      "历史记录搜索支持BV号搜索",
      "优化部分UI",
      "新增可隐藏并禁用侧边栏功能",
      "新增可视化同步进度条",
    ],
  },
  {
    date: "2026-02-02",
    version: "1.9.0beta",
    changes: [
      "历史记录支持按类型筛选",
      "收藏夹支持自动清理已取消收藏的内容",
      "收藏夹支持保留已失效视频的元数据",
      "收藏夹增加分页功能",
      "优化UI界面",
    ],
  },
  {
    date: "2025-11-10",
    version: "1.8.8",
    changes: ["同步删除：插件 -> B站, 不需要打开b站标签页"],
  },
  {
    date: "2025-10-22",
    version: "1.8.7",
    changes: ["修复播放模式的bug"],
  },
  {
    date: "2025-10-21",
    version: "1.8.6",
    changes: ["听歌页面增加随机播放和单曲循环功能"],
  },
  {
    date: "2025-10-16",
    version: "1.8.5",
    changes: ["修复了部分歌不能听的问题"],
  },
  {
    date: "2025-09-18",
    version: "1.8.4",
    changes: ["修复了部分歌不能听的问题"],
  },
  {
    date: "2025-09-16",
    version: "1.8.3",
    changes: ["修复了不能上传b站视频的bug"],
  },
  {
    date: "2025-09-14",
    version: "1.8.0",
    changes: ["增加听歌功能，超级棒！！！"],
  },
  {
    date: "2025-07-09",
    version: "1.7.2",
    changes: [
      "支持在B站网页端删除历史记录时同步删除插件历史记录",
      "修复刷新按钮不刷新总记录数的bug",
    ],
  },
  {
    date: "2025-06-28",
    version: "1.7.1",
    changes: ["优化云同步功能(正式启用)", "显示历史记录总数", "优化关于和反馈页面"],
  },
  {
    date: "2025-06-15",
    version: "1.7.0",
    changes: ["增加云同步功能(测试阶段)", "pop中可选择增量同步或者全量同步", "优化菜单项"],
  },
  {
    date: "2025-05-30",
    version: "1.6.2",
    changes: ["修复了旧版本专栏的跳转", "间隔时间可以手动输入"],
  },
  {
    date: "2025-05-28",
    version: "1.6.1",
    changes: ["日期选择增加+、-按钮"],
  },
  {
    date: "2025-05-24",
    version: "1.6.0",
    changes: ["代码开源", "增加设置自动同步时间间隔功能"],
  },
  {
    date: "2025-05-22",
    version: "1.5.0",
    changes: ["修改导出功能，增加导入功能"],
  },
  {
    date: "2025-05-18",
    version: "1.4.2",
    changes: ["修复了打开浏览器历史页面跳转到插件页面的问题"],
  },
  {
    date: "2025-05-18",
    version: "1.4.1",
    changes: ["修复了1.4.0版本引入的视频跳转的bug"],
  },
  {
    date: "2025-05-18",
    version: "1.4.0",
    changes: ["修复了番剧和课堂的跳转", "侧边栏添加了更新日志和反馈"],
  },
] as const;
