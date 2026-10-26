export interface HistoryItem {
  bvid: string;
  title: string;
  cover: string;
  tag_name?: string;
  business: "archive" | "pgc" | "article" | "article-list" | "live" | "cheese";
  view_at: number;
  id: number;
  cid?: string;
  author_name: string;
  author_mid: number;
  uri?: string;
  uploaded?: boolean;
  progress?: number;
  duration?: number;
  is_fav?: boolean;
}

export type HistoryDisplayMode = "content" | "visit";

export type HistoryEventSource = "bilibili" | "legacy-import" | "webdav" | "migration";

export interface HistoryEvent extends Omit<HistoryItem, "uploaded"> {
  event_id: string;
  content_key: string;
  observed_at: number;
  schema_version: 1;
}

export interface HistoryTombstone {
  tombstone_id: string;
  scope: "event" | "content" | "legacy-id";
  content_key?: string;
  event_id?: string;
  legacy_id?: number;
  deleted_through_view_at: number;
  deleted_at: number;
  source: "extension-ui" | "bilibili-page" | "import";
}

export type HistoryListItem = HistoryItem | HistoryEvent;

export interface HistoryCursor {
  view_at: number;
  event_id?: string;
  id?: number;
}

export interface HistoryV2Backup {
  schemaVersion: 2;
  events: HistoryEvent[];
  tombstones: HistoryTombstone[];
  updatedAt: number;
}

export interface LikedMusic {
  bvid: string;
  title: string;
  author: string;
  mid: number;
  pic: string;
  added_at: number;
}

export interface DBConfig {
  name: string;
  version: number;
  stores: {
    history: {
      keyPath: string;
      indexes: string[];
    };
    historyEvents: {
      keyPath: string;
      indexes: string[];
    };
    historyTombstones: {
      keyPath: string;
      indexes: string[];
    };
    likedMusic: {
      keyPath: string;
      indexes: string[];
    };
    favFolders: {
      keyPath: string;
      indexes: string[];
    };
    favResources: {
      keyPath: string | string[];
      indexes: string[];
    };
    subscribedCollections: {
      keyPath: string;
      indexes: string[];
    };
    subscribedCollectionResources: {
      keyPath: string;
      indexes: string[];
    };
    following: {
      keyPath: string;
      indexes: string[];
    };
    followingEvents: {
      keyPath: string;
      indexes: string[];
    };
    assets: {
      keyPath: string;
      indexes: string[];
    };
    vanishedFavResources: {
      keyPath: string | string[];
      indexes: string[];
    };
    interactions: {
      keyPath: string;
      indexes: string[];
    };
    /** 统一消失档案（v11）：收藏 / 订阅合集 / 关注 / 互动四处的"内容查不到了"都存这里 */
    vanishArchive: {
      keyPath: string;
      indexes: string[];
    };
  };
}

export interface SyncResponse {
  code: number;
  message: string;
  data: {
    list: HistoryItem[];
    has_more: boolean;
  };
}

export interface SyncHistoryRequest {
  action: "syncHistory";
  isFullSync: boolean;
}

export type SyncHistoryResponse =
  { success: true; message: string } | { success: false; error: string };

export type LocalHistoryBackupErrorCode =
  | "NOT_ENABLED"
  | "NO_DIRECTORY"
  | "PERMISSION_REQUIRED"
  | "EMPTY_HISTORY_ANOMALY"
  | "READ_FAILED"
  | "WRITE_FAILED";

export interface LocalHistoryBackupRequest {
  action: "runLocalHistoryBackup";
  allowEmpty?: boolean;
}

export interface LocalHistoryBackupResult {
  success: boolean;
  fileName?: string;
  recordCount?: number;
  contentCount?: number;
  eventCount?: number;
  summary?: string;
  completedAt?: number;
  cleanupWarning?: string;
  errorCode?: LocalHistoryBackupErrorCode;
  error?: string;
}

export interface SyncFavoriteFolderRequest {
  action: "syncFavoriteFolder";
  folderId: number;
  folderTitle?: string;
  isFullSync: boolean;
}

export type SyncFavoriteFolderResponse =
  | {
      success: true;
      message: string;
      folderId: number;
      mode: "incremental" | "full";
    }
  | {
      success: false;
      error: string;
      status?: "paused" | "interrupted" | "error";
      nextPage?: number;
      retryAfter?: number;
    };

export interface SyncAllFavoriteFoldersRequest {
  action: "syncAllFavoriteFolders";
  folders: { id: number; title: string }[];
  isFullSync: boolean;
}

export type SyncAllFavoriteFoldersResponse =
  | {
      success: true;
      message: string;
      mode: "incremental" | "full";
    }
  | {
      success: false;
      error: string;
      status?: "paused" | "interrupted" | "error";
      currentFolderIndex?: number;
      currentFolderId?: number | null;
      nextPage?: number;
      retryAfter?: number;
    };

export type AllFavoriteFoldersSyncProgressStatus =
  "syncing" | "paused" | "interrupted" | "success" | "error";

export interface AllFavoriteFoldersSyncProgress {
  status: AllFavoriteFoldersSyncProgressStatus;
  mode: "full" | "incremental";
  currentFolderIndex: number;
  currentFolderId: number | null;
  currentFolderTitle: string;
  completedCount: number;
  totalFolders: number;
  failedFolders: { id: number; title: string; error: string }[];
  folderIds: number[];
  currentPage: number;
  nextPage: number;
  processedItems: number;
  totalItems: number;
  onlineResourceIds: number[];
  startedAt: number;
  updatedAt: number;
  message?: string;
  errorKind?: FavoriteFolderSyncErrorKind;
  retryAfter?: number;
  rateLimitCount?: number;
}

export type FavoriteFolderSyncProgressStatus =
  "syncing" | "paused" | "interrupted" | "success" | "error";

export type FavoriteFolderSyncErrorKind =
  "rate_limited" | "auth" | "network" | "server" | "data" | "unknown";

export interface FavoriteFolderSyncProgress {
  folderId: number;
  folderTitle: string;
  mode: "incremental" | "full";
  status: FavoriteFolderSyncProgressStatus;
  currentPage: number;
  nextPage: number;
  processedItems: number;
  totalItems: number;
  onlineResourceIds: number[];
  startedAt: number;
  updatedAt: number;
  message?: string;
  errorKind?: FavoriteFolderSyncErrorKind;
  retryAfter?: number;
  rateLimitCount?: number;
}

export interface RefreshFavoriteFoldersRequest {
  action: "refreshFavoriteFolders";
}

export type RefreshFavoriteFoldersResponse =
  { success: true; folderCount: number } | { success: false; error: string };

export interface FavoriteFolder {
  id: number;
  fid: number;
  mid: number;
  attr: number;
  title: string;
  fav_state: number;
  media_count: number;
  index: number; // API返回的顺序
}

export interface FavoriteResource {
  id: number; // 收藏夹内的资源ID
  type: number;
  title: string;
  cover: string;
  intro: string;
  duration: number;
  upper: {
    mid: number;
    name: string;
    face: string;
  };
  cnt_info: {
    collect: number;
    play: number;
    danmaku: number;
  };
  link: string;
  ctime: number;
  pubtime: number;
  fav_time: number;
  bv_id: string; // 有时候是 bvid
  bvid: string;
  folder_id: number; // 关联的收藏夹ID
  index: number; // 在收藏夹中的顺序
  /**
   * fav 接口返回的 attr 字段。语义（来自社区脚本标注，未经官方确认）：
   * `0` 正常、`1` 其他原因删除/退回、`9` **UP 主自己删除**。
   * Phase 1b 实测与之吻合：`attr 1` → view 接口 `-404`，`attr 9` → `62002 稿件不可见`。
   */
  attr?: number;
  /** 首次观测到该收藏失效的时间。用于统计与界面展示 */
  invalidatedAt?: number;
  invalidatedKind?: FavInvalidatedKind;
  /**
   * 第三方恢复成功的时间。一旦有值，后续同步**不得**再用占位内容覆盖 title / cover，
   * 否则恢复成果会在下一次同步时被抹掉。
   */
  recoveredAt?: number;
  recoverySource?: FavRecoverySource;
  /**
   * 分P 信息。B站 收藏夹接口本来就返回，但上游从未声明也从未使用。
   *
   * 关键价值：稿件失效后 `title` 会被换成「已失效视频」，但 `pages[0].title`
   * （第一P 的标题）往往还保留着。当稿件只有一个分P时，该分P标题就等于稿件标题，
   * 可以据此**免费**还原失效标题——不需要任何第三方请求。
   */
  page?: number;
  pages?: Array<{ title?: string; page?: number; duration?: number }>;
  /**
   * 指向 `assets` store 的封面字节归档。
   *
   * 这是唯一"防患于未然"的手段：封面还正常时就把字节存下来，
   * 之后无论 B站 换 URL、换占位图还是内容被删，手里那份永远在。
   * 其余恢复途径（公开接口 / biliplus / 本地交叉引用）都是**事后**找回。
   */
  coverAssetId?: string;
}

/** 恢复数据的来源。`local_*` 是本地交叉引用（零请求），其余是外部来源 */
export type FavRecoverySource =
  | "biliplus"
  | "jijidown"
  | "bilibili_pages"
  | "bilibili_public"
  | "local_history"
  | "local_liked"
  | "local_collection";

/** 失效类型。来自 `attr`，比"失效/未失效"的布尔判断更有信息量 */
export type FavInvalidatedKind = "removed_by_other" | "removed_by_uploader" | "other";

export interface SubscribedCollection {
  id: number;
  mid: number;
  title: string;
  cover: string;
  intro: string;
  ctime: number;
  mtime: number;
  media_count: number;
  upper: {
    mid: number;
    name: string;
    face: string;
  };
  index: number;
}

export interface SubscribedCollectionResource {
  id: string;
  collection_id: number;
  aid: number;
  bvid: string;
  title: string;
  cover: string;
  /** 指向 `assets` store 的封面字节归档 */
  coverAssetId?: string;
  duration: number;
  author_name: string;
  author_mid: number;
  pubdate: number;
  index: number;
  /**
   * 失效标记。与收藏资源的 `attr` 同义（`9` = UP 主自己删除/退回，`1` = 其他原因删除）。
   *
   * 合集原先**完全不记录失效状态**，于是整夹替换时失效视频的标题、封面、时长
   * 会被 B 站返回的占位数据覆盖且不可逆。补上它才能做和收藏一样的失效保护。
   */
  attr?: number;
  /** 由 `attr` 解析出的失效类型，同步时写入。见 `resolveInvalidatedKind` */
  invalidatedKind?: "removed_by_uploader" | "removed_by_other" | "other";
  /** 首次观测到失效的时间。只写一次，后续同步不覆盖 */
  invalidatedAt?: number;
}

// ---------------------------------------------------------------------------
// 关注追踪（following / followingEvents）
// ---------------------------------------------------------------------------

/**
 * 关注关系状态。单枚举，`gone` 为终态（不被 `unfollowed` 覆盖）。
 * 依据：Phase 1 实测，已注销账号仍留在关注列表中且 `uname` 为字面量占位文案。
 */
export type FollowingStatus = "following" | "unfollowed" | "gone";

/** 一个被观测到的名字。纯追加，展示时由相邻两条推算时间区间。 */
export interface FollowingNameRecord {
  name: string;
  seenAt: number;
}

/** `name` 的来源。第三方存档不写入 `name`，只进 `thirdPartyNames`。 */
export type FollowingNameSource = "api" | "local_backfill";

export interface FollowingItem {
  /** UID，关注列表接口返回的 `mid` */
  mid: number;
  /** 最后一次已知的真实昵称；**永不写入空值或平台占位文案** */
  name: string;
  face: string;
  /** 指向 assets store 的头像字节归档 */
  avatarAssetId?: string;
  sign: string;
  /** 关注时间（接口字段，秒级时间戳）。注意：互关后会被刷新，不是稳定的关注时间 */
  mtime: number;
  /** 2 已关注 / 6 已互粉 / 128 已拉黑 */
  attribute: number;
  /** 1 表示特别关注 */
  special: number;
  /** 认证信息描述，改名后识别身份的第二锚点 */
  officialVerifyDesc?: string;
  status: FollowingStatus;
  firstSeenAt: number;
  lastSeenAt: number;
  /** 本条目最后一次出现在完整关注同步中的时间（用于判定取关） */
  lastSeenInSyncAt?: number;
  unfollowedDetectedAt?: number;
  goneDetectedAt?: number;
  /** 本地观测到的改名记录，按 seenAt 升序。首次基线的名字也计入 */
  nameHistory: FollowingNameRecord[];
  nameSource?: FollowingNameSource;
  /**
   * 第三方存档（aicu.cc）返回的曾用名列表。
   * **无时间戳、顺序不保证、可能混入占位文案**，因此与 nameHistory 分开存放，绝不合并。
   */
  thirdPartyNames?: string[];
  thirdPartyQueriedAt?: number;
  /**
   * 用户在卡片上手动切换后，希望优先展示的 `thirdPartyNames` 下标。
   * 缺省时展示最后一个（最可能的注销前名字）；第三方存档顺序不保证，
   * 所以允许用户自己挑一个熟悉的名字。只用于展示，不影响数据本身。
   */
  formerNameDisplayIndex?: number;
}

export type FollowingEventType = "followed" | "unfollowed" | "renamed" | "account_gone";

export interface FollowingEvent {
  /** `${type}:${mid}:${day}`，保证同日重复同步幂等 */
  event_id: string;
  type: FollowingEventType;
  mid: number;
  /** YYYY-MM-DD，本地时区 */
  day: string;
  occurred_at: number;
  /** 变动后的名称；account_gone 时为注销前名称 */
  name: string;
  /** 仅 renamed / account_gone 有值 */
  previous_name?: string;
}

// ---------------------------------------------------------------------------
// 图片字节归档（assets）——关注头像与收藏封面共用
// ---------------------------------------------------------------------------

export type AssetKind = "avatar" | "cover";

export interface AssetRecord {
  id: string;
  kind: AssetKind;
  mimeType: string;
  blob: Blob;
  sourceUrl: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// 收藏内容保全（vanishedFavResources）
// ---------------------------------------------------------------------------

export type FavVanishReason =
  | "unfavorited"
  | "content_deleted"
  | "content_hidden"
  | "unknown";

/**
 * 统一消失档案的消失原因。
 *
 * 刻意**不复用 `FavVanishReason`**（虽然三者同名同义）：那个枚举是收藏模块的既有契约，
 * 往里加值会波及它的穷尽性检查与旧数据。这里独立一份，把影响面限制在新功能内；
 * 两者的公共取值保持一致，将来要合并也只是类型层面的别名。
 */
export type VanishArchiveReason =
  | "unfavorited"
  | "content_deleted"
  | "content_hidden"
  | "unknown"
  /**
   * 合集同步会整夹替换：视频从合集里移出、或用户退订了整个合集。
   *
   * 与 `unfavorited` 分开是因为**语义不同**：收藏是你取消了收藏，合集是内容
   * 不再属于这个合集。混成一个值会让档案里看不出到底发生了什么。
   */
  | "collection_removed"
  /** B 站 `attr` 明确标注"UP 主自己删除/退回" */
  | "removed_by_uploader"
  /** B 站 `attr` 明确标注"其他原因删除" */
  | "removed_by_other"
  /**
   * 关注账号**已注销**（空间 404）。
   *
   * 与 `unknown` 分开：注销是明确状态，不是"原因不明"，侧栏统计与详情
   * 都应该显示「账号注销」，否则会被误算进"原因不明"。
   */
  | "account_gone"
  /**
   * 关注账号**改过名**（人还在，内容没消失）。
   *
   * 单列一个原因是因为它和"消失"不是一回事：账号好好地在 B 站，只是曾用名变了。
   * 之所以仍然留档，是因为**曾用名是不可再得的信息**——B 站不提供历史昵称查询，
   * 改名之后就再也查不到它以前叫什么了。界面必须把这一类和"内容消失"区分开。
   */
  | "renamed";

/**
 * 消失档案。只增不删。
 * 字段在 FavoriteResource 基础上补充消失信息；消失前的元数据冗余保存，防止被后续覆盖。
 */
export interface VanishedFavResource extends FavoriteResource {
  vanishedAt: number;
  vanishReason: FavVanishReason;
  probeAttemptedAt?: number;
  probeError?: string;
  lastKnownTitle?: string;
  lastKnownCover?: string;
  /** 指向 assets store 的封面字节归档 */
  coverAssetId?: string;
}

/**
 * 统一消失档案条目。
 *
 * 为什么要有它：`vanishedFavResources` 只覆盖收藏，而"内容查不到了"这件事发生在
 * 四个地方（收藏 / 订阅合集 / 关注 / 互动），原先只有收藏做了"先留档再移除"。
 * 订阅合集尤其严重——同步是整夹替换（`replaceSubscribedCollectionResources`），
 * 消失的视频直接没了，连 BV 号都不剩。
 *
 * 设计取舍：
 * - **冻结快照**：`item` 存消失那一刻的完整记录。上游记录可能被后续同步覆盖或删除，
 *   档案的价值恰恰是"消失前它长什么样"，不能依赖上游字段以后还在。
 * - **自带标题字段**：`title` 从 `item` 冗余出来，检索不必知道每种 kind 的结构，
 *   这与收藏档案用 `lastKnownTitle` 的理由一致。
 * - **`reason` 复用 `FavVanishReason`**：四种原因的语义与收藏完全一致，
 *   没必要再造一套枚举让界面分两处判断。
 */
export type VanishArchiveKind = "favorite" | "collection" | "following" | "like" | "coin";

/** 条目来自哪个数据源，用于界面分组与"回源"提示 */
export type VanishArchiveSource = "favorites" | "collections" | "following" | "interactions";

export interface VanishArchiveItem {
  /** `${kind}:${sourceId}`，同一条内容重复归档时幂等覆盖 */
  id: string;
  kind: VanishArchiveKind;
  source: VanishArchiveSource;
  /** 源记录的主键（收藏是 `${folder_id}:${id}`，合集是资源 id，关注是 mid，互动是 `${type}:${bvid}`） */
  sourceId: string;
  /** 消失前的标题/昵称（冗余出来供检索与列表展示） */
  title: string;
  /** 封面或头像 URL（消失前的） */
  cover: string;
  /** 指向 `assets` 的图片字节归档 */
  coverAssetId?: string;
  /** 稿件标识；关注类没有 */
  bvid?: string;
  aid?: number;
  authorName?: string;
  authorMid?: number;
  /**
   * 时长（秒）。**提为一等字段**，不让界面去快照里挖。
   *
   * 时长"基本不变"，比标题更可靠（标题会被占位文案顶掉）。但快照形状随来源而异，
   * 且历史快照里的 duration 可能已被 B 站返回的 0 覆盖——放顶层才能稳定读到，
   * 也能在合并时按"哪边有值"择优。
   */
  duration?: number;
  /** 消失原因 */
  reason: VanishArchiveReason;
  /** 首次判定消失的时间 */
  vanishedAt: number;
  /** 最近一次探测/复核时间，以及失败原因（失败也留档，绝不因为探测失败就不记） */
  probeAttemptedAt?: number;
  probeError?: string;
  /**
   * 失效**未经证实**：只靠标题里的占位文案判断，`attr` 与 `invalidatedKind` 都没有
   * 给出明确结论（`invalidatedKind === "other"`，或压根没有这个字段）。
   *
   * 这类记录依然保留（宁可多留也不少留），但界面必须标出来——
   * 因为收藏夹会话在稿件仍可访问时也返回「已失效视频」占位标题，
   * 把它当成"内容已消失"就是在说一件我们并没证实的事。
   */
  invalidationUnproven?: boolean;
  /**
   * 本地仍能查到同 id 的源记录 → 说明它其实没消失，属于误归档。
   * 只用于界面折叠（"已恢复"），不删除档案；由页面读时计算，不持久化。
   */
  resolvedLocally?: boolean;
  /** 读时从源记录临时派生的条目（不是持久档案）。误归档检测只针对持久档案 */
  liveDerived?: boolean;
  /** 消失那一刻的完整原始记录。只读快照，不要再依赖它以外的上游数据 */
  item: unknown;
}

// ---------------------------------------------------------------------------
// 点赞 / 投币互动记录（interactions）
//
// B 站的「最近点赞的视频」与「最近投币的视频」都是**滚动窗口**（匿名实测固定 20 条，
// 分页参数被忽略），条目会自己掉出去，且接口不告诉调用方原因。所以本地必须永久留档，
// 且**绝不能因为"不在列表里"就删除记录**。
// ---------------------------------------------------------------------------

export type InteractionType = "like" | "coin";

/**
 * 一条互动记录的生命周期状态。
 *
 * 刻意做成单枚举而不是"是否还在"的布尔值：判定要区分「B 站列表不展示了」、
 * 「互动真的没了」与「稿件本身没了」三件完全不同的事，布尔值表达不了。
 */
export type InteractionState =
  | "listed" // 最近一次同步仍能在 B 站列表里看到
  | "unlisted" // 已不在列表，但尚未判定（探测未做或探测失败）
  | "retained" // 已不在列表，但探测证明互动仍在（B 站只是不再展示）
  | "ended" // 已不在列表，稿件仍在，但探测显示互动已不存在
  | "content_deleted" // 稿件不存在
  | "content_hidden"; // 稿件不可见（转私密 / 被限制）

/** 探测脚本与接口层共用的原始条目形状（只声明真正用到的字段） */
export interface RawInteractionEntry {
  aid?: number;
  bvid?: string;
  title?: string;
  pic?: string;
  duration?: number;
  pubdate?: number;
  owner?: { mid?: number; name?: string; face?: string };
  /** 仅投币接口：你给这条稿件投的币数 */
  coins?: number;
  /** 仅投币接口：投币时间（秒级时间戳） */
  time?: number;
}

export interface InteractionItem {
  /** `${type}:${bvid}`。同一条视频可能既被点赞又被投币，两者必须是两条独立记录 */
  id: string;
  type: InteractionType;
  bvid: string;
  aid?: number;
  /** 最新一次已知的真实标题；**永不写入"已失效视频"这类占位文案** */
  title: string;
  /** **首次**观测到的标题，只写一次、之后永不覆盖——回答"我当时点的是哪条视频" */
  firstTitle: string;
  cover: string;
  /** 指向 assets store 的封面字节归档。字节只存本地，不进任何备份 */
  coverAssetId?: string;
  /** 时长（秒） */
  duration: number;
  authorName: string;
  authorMid: number;
  /** 稿件发布时间（秒级时间戳） */
  pubdate: number;
  /** 互动时间（毫秒）。投币用接口给的真实 `time`；点赞接口不返回，只能用首次观测时间 */
  interactedAt: number;
  /** `interactedAt` 是接口给的真实时间（true）还是首次观测到的近似值（false） */
  interactedAtExact: boolean;
  /**
   * 是否在插件**首次同步**时就已经在列表里。
   *
   * 这批记录只能说明"在你开始记录之前就点过赞"，具体时间无从得知。
   * 界面据此显示「早期」，而不是把一个"其实是我们第一次同步的时刻"伪装成点赞时间。
   */
  caughtInBaseline?: boolean;
  /** 最近一次在线列表中的位置（0 起，越小越新） */
  listRank?: number;
  /** 仅投币：投币枚数 */
  coins?: number;
  state: InteractionState;
  firstSeenAt: number;
  /** 最后一次被同步扫到的时间（无论在线与否） */
  lastSeenAt: number;
  /** 最后一次出现在在线列表里的时间 */
  lastSeenOnlineAt: number;
  /** 首次判定"已不在在线列表"的时间 */
  unlistedDetectedAt?: number;
  /** 首次判定"互动已结束 / 内容已消失"的时间 */
  endedDetectedAt?: number;
  /** 最近一次探测时间。未设置表示还没探测过 */
  probeAttemptedAt?: number;
  probeError?: string;
}
