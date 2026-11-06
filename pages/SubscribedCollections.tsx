import { useEffect, useRef, useState } from "react";
import toast from "react-hot-toast";
import {
  deleteCollectionArchiveResources,
  deleteCollectionArchives,
  getAllCollectionArchives,
  getSubscribedCollectionResources,
  getSubscribedCollections,
  restoreCollectionArchives,
} from "../utils/db";
import {
  CollectionArchive,
  SubscribedCollection,
  SubscribedCollectionResource,
} from "../utils/types";
import {
  Archive as ArchiveIcon,
  ChevronDownIcon,
  LibraryBig,
  RefreshCw,
  RotateCcw,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { Pagination } from "../components/Pagination";
import { formatInteractionDuration } from "../utils/interactionQuery";

type SearchType = "all" | "title" | "up" | "bvid" | "avid";

const SEARCH_OPTIONS: { value: SearchType; label: string }[] = [
  { value: "all", label: "综合搜索" },
  { value: "title", label: "视频标题" },
  { value: "up", label: "UP 主" },
  { value: "bvid", label: "视频 BV 号" },
  { value: "avid", label: "视频 AV 号" },
];

export const SubscribedCollections = () => {
  const [collections, setCollections] = useState<SubscribedCollection[]>([]);
  const [selectedCollectionId, setSelectedCollectionId] = useState<number | null>(null);
  const [resources, setResources] = useState<SubscribedCollectionResource[]>([]);
  const [isSyncingCollections, setIsSyncingCollections] = useState(false);
  const [isSyncingResources, setIsSyncingResources] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [keyword, setKeyword] = useState("");
  const [searchType, setSearchType] = useState<SearchType>("all");
  const [isSearchKindDropdownOpen, setIsSearchKindDropdownOpen] = useState(false);
  const [collectionArchives, setCollectionArchives] = useState<CollectionArchive[]>([]);
  const [archiveDetail, setArchiveDetail] = useState<CollectionArchive | null>(null);
  const [archiveResources, setArchiveResources] = useState<SubscribedCollectionResource[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [archiveDeleteConfirm, setArchiveDeleteConfirm] = useState(false);
  const [archiveDeleting, setArchiveDeleting] = useState(false);
  const [archiveUndo, setArchiveUndo] = useState<{
    item: CollectionArchive;
    remaining: number;
  } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const hasRefreshedCollectionDirectoryRef = useRef(false);
  const pendingArchiveRef = useRef<CollectionArchive | null>(null);
  const archiveUndoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const archiveUndoIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pageSize = 50;

  const clearArchiveUndoTimers = () => {
    if (archiveUndoTimerRef.current) {
      clearTimeout(archiveUndoTimerRef.current);
      archiveUndoTimerRef.current = null;
    }
    if (archiveUndoIntervalRef.current) {
      clearInterval(archiveUndoIntervalRef.current);
      archiveUndoIntervalRef.current = null;
    }
  };

  const loadArchives = async () => {
    const list = await getAllCollectionArchives();
    setCollectionArchives(list.sort((a, b) => b.archivedAt - a.archivedAt));
  };

  const openArchiveDetail = async (archive: CollectionArchive) => {
    setArchiveDetail(archive);
    setArchiveDeleteConfirm(false);
    setArchiveLoading(true);
    try {
      const list = await getSubscribedCollectionResources(archive.id);
      setArchiveResources(list.sort((a, b) => a.index - b.index));
    } catch {
      setArchiveResources([]);
      toast.error("加载合集备份内容失败");
    } finally {
      setArchiveLoading(false);
    }
  };

  const finalizeArchiveDeletion = async () => {
    const pending = pendingArchiveRef.current;
    clearArchiveUndoTimers();
    pendingArchiveRef.current = null;
    setArchiveUndo(null);
    if (!pending) return;
    try {
      await deleteCollectionArchiveResources(pending.id);
    } catch (error) {
      console.warn("清理合集备份内容失败", error);
    }
  };

  const handleArchiveDelete = async () => {
    if (!archiveDetail || archiveDeleting) return;
    setArchiveDeleting(true);
    try {
      await deleteCollectionArchives([archiveDetail.id]);
      pendingArchiveRef.current = archiveDetail;
      setCollectionArchives((current) =>
        current.filter((item) => item.id !== archiveDetail.id),
      );
      setArchiveDeleteConfirm(false);
      setArchiveDetail(null);
      setArchiveResources([]);
      setArchiveUndo({ item: archiveDetail, remaining: 5 });
      clearArchiveUndoTimers();
      archiveUndoTimerRef.current = setTimeout(() => {
        void finalizeArchiveDeletion();
      }, 5000);
      archiveUndoIntervalRef.current = setInterval(() => {
        setArchiveUndo((current) => {
          if (!current) return null;
          if (current.remaining <= 1) return { ...current, remaining: 0 };
          return { ...current, remaining: current.remaining - 1 };
        });
      }, 1000);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "删除合集备份失败");
    } finally {
      setArchiveDeleting(false);
    }
  };

  const handleArchiveUndo = async () => {
    if (!archiveUndo) return;
    const item = archiveUndo.item;
    clearArchiveUndoTimers();
    pendingArchiveRef.current = null;
    try {
      await restoreCollectionArchives([item.id]);
      setCollectionArchives((current) =>
        [item, ...current].sort((a, b) => b.archivedAt - a.archivedAt),
      );
      setArchiveUndo(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "撤销删除失败");
    }
  };

  useEffect(() => {
    return () => {
      const pending = pendingArchiveRef.current;
      clearArchiveUndoTimers();
      if (pending) void deleteCollectionArchiveResources(pending.id);
    };
  }, []);

  const formatArchiveDate = (value: number) =>
    new Date(value).toLocaleString("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });

  const selectedCollection = collections.find(
    (collection) => collection.id === selectedCollectionId,
  );

  const loadCollections = async () => {
    const list = await getSubscribedCollections();
    const sortedList = list.sort((a, b) => a.index - b.index);
    setCollections(sortedList);
    setSelectedCollectionId((currentId) => {
      if (currentId && sortedList.some((collection) => collection.id === currentId))
        return currentId;
      return sortedList[0]?.id ?? null;
    });
  };

  const loadResources = async (collectionId: number) => {
    const list = await getSubscribedCollectionResources(collectionId);
    setResources(list.sort((a, b) => a.index - b.index));
    setCurrentPage(1);
    setKeyword("");
  };

  const refreshCollections = async () => {
    setIsSyncingCollections(true);
    try {
      const response = await browser.runtime.sendMessage({ action: "syncSubscribedCollections" });
      if (!response?.success) throw new Error(response?.error || "同步订阅合集失败");
      await loadCollections();
      await loadArchives();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "同步订阅合集失败");
    } finally {
      setIsSyncingCollections(false);
    }
  };

  const refreshResources = async (collection: SubscribedCollection) => {
    setIsSyncingResources(true);
    try {
      const response = await browser.runtime.sendMessage({
        action: "syncSubscribedCollectionResources",
        collectionId: collection.id,
        mid: collection.mid,
      });
      if (!response?.success) throw new Error(response?.error || "同步合集内容失败");
      await loadResources(collection.id);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "同步合集内容失败");
    } finally {
      setIsSyncingResources(false);
    }
  };

  useEffect(() => {
    if (hasRefreshedCollectionDirectoryRef.current) return;
    hasRefreshedCollectionDirectoryRef.current = true;

    const initializeCollections = async () => {
      // 与收藏夹保持一致：先展示本地缓存，再从网络刷新目录。
      await loadCollections().catch(() => toast.error("加载订阅合集缓存失败"));
      await loadArchives().catch(() => toast.error("加载合集备份失败"));
      await refreshCollections();
    };

    void initializeCollections();
  }, []);

  useEffect(() => {
    if (!selectedCollection) {
      setResources([]);
      return;
    }

    loadResources(selectedCollection.id).catch(() => toast.error("加载合集内容缓存失败"));
    refreshResources(selectedCollection);
  }, [selectedCollectionId]);

  const filteredResources = resources.filter((item) => {
    if (!keyword) return true;
    const lowerKeyword = keyword.toLowerCase();

    switch (searchType) {
      case "title":
        return item.title.toLowerCase().includes(lowerKeyword);
      case "up":
        return item.author_name.toLowerCase().includes(lowerKeyword);
      case "bvid":
        return item.bvid.toLowerCase().includes(lowerKeyword);
      case "avid":
        return String(item.aid).includes(lowerKeyword);
      case "all":
      default:
        return (
          item.title.toLowerCase().includes(lowerKeyword) ||
          item.author_name.toLowerCase().includes(lowerKeyword) ||
          item.bvid.toLowerCase().includes(lowerKeyword) ||
          String(item.aid).includes(lowerKeyword)
        );
    }
  });

  const startIndex = (currentPage - 1) * pageSize;
  const currentResources = filteredResources.slice(startIndex, startIndex + pageSize);
  const searchLabel =
    SEARCH_OPTIONS.find((option) => option.value === searchType)?.label || "综合搜索";

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-[#0a0a0a]">
      <aside className="w-64 bg-white dark:bg-neutral-900 border-r border-gray-200 dark:border-neutral-800 overflow-y-auto flex-shrink-0">
        <div className="p-4 border-b border-gray-200 dark:border-neutral-800 flex items-center justify-between gap-3">
          <h2 className="text-lg font-bold flex items-center gap-2 min-w-0">
            <LibraryBig className="w-5 h-5 shrink-0" />
            <span className="truncate">订阅合集</span>
          </h2>
          <button
            type="button"
            title="同步订阅合集目录并补全内容"
            aria-label="同步订阅合集目录并补全内容"
            onClick={refreshCollections}
            disabled={isSyncingCollections}
            className="p-2 rounded-md text-gray-500 hover:bg-gray-100 hover:text-pink-500 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-pink-400 transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${isSyncingCollections ? "animate-spin" : ""}`} />
          </button>
        </div>

        <div className="p-2">
          {collections.map((collection) => (
            <button
              key={collection.id}
              type="button"
              onClick={() => setSelectedCollectionId(collection.id)}
              className={`w-full p-3 rounded-lg text-left mb-1 transition-colors ${
                selectedCollectionId === collection.id
                  ? "bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400"
                  : "hover:bg-gray-100 dark:hover:bg-neutral-800"
              }`}
            >
              <div className="font-medium truncate">{collection.title}</div>
              <div className="text-xs text-gray-400 dark:text-neutral-500 mt-1 truncate">
                {collection.upper?.name || "未知 UP 主"} · {collection.media_count} 个视频
              </div>
            </button>
          ))}

          {collectionArchives.map((archive) => (
            <button
              key={archive.id}
              type="button"
              onClick={() => void openArchiveDetail(archive)}
              className="mb-1 w-full rounded-lg p-3 text-left transition-colors hover:bg-amber-50 dark:hover:bg-amber-500/10"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-medium text-gray-700 dark:text-neutral-300">
                  {archive.title || `合集 ${archive.id}`}
                </span>
                <span className="shrink-0 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:bg-amber-500/10 dark:text-amber-400">
                  本地备份
                </span>
              </div>
              <div className="mt-1 truncate text-xs text-gray-400 dark:text-neutral-500">
                {archive.reason === "collection_gone" ? "已离开订阅" : "合集已失效"} ·{" "}
                {archive.resourceCount} 条
              </div>
            </button>
          ))}

          {!isSyncingCollections && collections.length === 0 && collectionArchives.length === 0 && (
            <div className="p-5 text-center text-sm text-gray-400 dark:text-neutral-500">
              暂无订阅合集
            </div>
          )}
        </div>
      </aside>

      <main className="flex-1 overflow-y-auto" ref={contentRef}>
        <div className="p-6">
          {selectedCollection ? (
            <>
              <section className="mb-6 flex flex-col md:flex-row justify-between md:items-center gap-4 bg-white dark:bg-neutral-900 p-4 rounded-xl shadow-sm border border-gray-100 dark:border-neutral-800">
                <div className="min-w-0">
                  <h1 className="text-xl font-bold flex items-center gap-2 min-w-0">
                    <span className="truncate">{selectedCollection.title}</span>
                    <span className="shrink-0 text-sm font-normal text-gray-500 dark:text-neutral-400 bg-gray-50 dark:bg-neutral-800 px-2 py-1 rounded-full border border-gray-100 dark:border-neutral-700">
                      {filteredResources.length} 个视频
                    </span>
                  </h1>
                  {selectedCollection.intro && (
                    <p className="mt-2 text-sm text-gray-500 dark:text-neutral-400 line-clamp-1">
                      {selectedCollection.intro}
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-3 w-full md:w-auto">
                  <div className="relative flex-1 md:w-[32rem] group flex items-center bg-gray-50 dark:bg-neutral-800 border border-gray-200 dark:border-neutral-700 rounded-full transition-all duration-300 shadow-sm hover:shadow-md focus-within:bg-white dark:focus-within:bg-neutral-800 focus-within:ring-2 focus-within:ring-blue-100 dark:focus-within:ring-blue-500/20 focus-within:border-blue-400 dark:focus-within:border-blue-500">
                    <div className="relative">
                      <button
                        type="button"
                        className="pl-4 pr-3 py-2 text-sm text-gray-600 dark:text-neutral-300 font-medium border-r border-gray-200 dark:border-neutral-700 hover:text-blue-600 dark:hover:text-blue-400 flex items-center gap-1 transition-colors whitespace-nowrap"
                        onClick={() => setIsSearchKindDropdownOpen((open) => !open)}
                      >
                        <span>{searchLabel}</span>
                        <ChevronDownIcon className="w-3 h-3 text-gray-400 dark:text-neutral-500" />
                      </button>

                      {isSearchKindDropdownOpen && (
                        <>
                          <button
                            type="button"
                            aria-label="关闭搜索类型菜单"
                            className="fixed inset-0 z-10 cursor-default"
                            onClick={() => setIsSearchKindDropdownOpen(false)}
                          />
                          <div className="absolute top-full left-0 mt-2 w-32 bg-white dark:bg-neutral-900 rounded-lg shadow-lg border border-gray-100 dark:border-neutral-800 py-1 z-20 overflow-hidden">
                            {SEARCH_OPTIONS.map((option) => (
                              <button
                                key={option.value}
                                type="button"
                                className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                                  searchType === option.value
                                    ? "bg-blue-50 dark:bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium"
                                    : "text-gray-600 dark:text-neutral-300 hover:bg-gray-50 dark:hover:bg-neutral-800"
                                }`}
                                onClick={() => {
                                  setSearchType(option.value);
                                  setIsSearchKindDropdownOpen(false);
                                  setCurrentPage(1);
                                }}
                              >
                                {option.label}
                              </button>
                            ))}
                          </div>
                        </>
                      )}
                    </div>

                    <input
                      type="text"
                      className="flex-1 min-w-0 bg-transparent border-none focus:ring-0 pl-4 pr-10 py-2 text-sm text-gray-700 dark:text-neutral-100 placeholder-gray-400 dark:placeholder-neutral-500 focus:outline-none"
                      placeholder="搜索..."
                      value={keyword}
                      onChange={(event) => {
                        setKeyword(event.target.value);
                        setCurrentPage(1);
                      }}
                    />
                    {keyword ? (
                      <button
                        type="button"
                        aria-label="清空搜索"
                        onClick={() => {
                          setKeyword("");
                          setCurrentPage(1);
                        }}
                        className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 dark:text-neutral-500 hover:text-gray-600 dark:hover:text-neutral-300 transition-colors"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    ) : (
                      <div className="absolute inset-y-0 right-0 pr-3 flex items-center pointer-events-none">
                        <Search className="h-4 w-4 text-gray-400 dark:text-neutral-500" />
                      </div>
                    )}
                  </div>

                  {isSyncingResources && (
                    <span className="flex items-center gap-1.5 whitespace-nowrap text-xs text-gray-400 dark:text-neutral-500">
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      同步中
                    </span>
                  )}
                </div>
              </section>

              {isSyncingResources && resources.length === 0 ? (
                <div className="text-center py-10 text-gray-500 dark:text-neutral-400">
                  正在同步合集内容...
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-6">
                    {currentResources.map((item) => (
                      <a
                        key={item.id}
                        href={`https://www.bilibili.com/video/${item.bvid}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="border border-gray-200 dark:border-neutral-800 rounded-lg overflow-hidden flex flex-col bg-white dark:bg-neutral-900 hover:shadow-md transition-shadow no-underline text-inherit"
                      >
                        <div className="relative w-full aspect-video bg-gray-100 dark:bg-neutral-800">
                          {item.cover ? (
                            <img
                              src={`${item.cover.replace("http:", "https:")}@760w_428h_1c.avif`}
                              alt={item.title}
                              className="w-full h-full object-cover"
                              loading="lazy"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center text-gray-400 dark:text-neutral-500">
                              <LibraryBig className="w-8 h-8" />
                            </div>
                          )}
                          {/* 时长压在封面右下角。它是"基本不变"的元数据，
                              比标题更能说明这是哪条内容——标题会被占位文案顶掉 */}
                          {formatInteractionDuration(item.duration) ? (
                            <span className="absolute bottom-1.5 right-1.5 rounded bg-black/70 px-1.5 py-0.5 text-xs tabular-nums text-white">
                              {formatInteractionDuration(item.duration)}
                            </span>
                          ) : null}
                        </div>
                        <div className="p-3 flex-1 flex flex-col">
                          <h3
                            className="m-0 text-sm leading-[1.4] h-10 overflow-hidden line-clamp-2"
                            title={item.title}
                          >
                            {item.title}
                          </h3>
                          <div className="flex justify-between items-center text-gray-500 dark:text-neutral-400 text-xs mt-2 gap-2">
                            <button
                              type="button"
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                window.open(
                                  `https://space.bilibili.com/${item.author_mid}`,
                                  "_blank",
                                );
                              }}
                              className="hover:text-[#fb7299] transition-colors cursor-pointer truncate text-left"
                            >
                              {item.author_name}
                            </button>
                            <span className="shrink-0">
                              {item.pubdate
                                ? new Date(item.pubdate * 1000).toLocaleDateString()
                                : ""}
                            </span>
                          </div>
                        </div>
                      </a>
                    ))}
                  </div>

                  {currentResources.length === 0 && (
                    <div className="text-center py-16 text-gray-400 dark:text-neutral-500">
                      这个合集暂时没有可显示的视频
                    </div>
                  )}

                  <div className="mt-8">
                    <Pagination
                      currentPage={currentPage}
                      totalItems={filteredResources.length}
                      pageSize={pageSize}
                      onPageChange={(page) => {
                        setCurrentPage(page);
                        contentRef.current?.scrollTo({ top: 0, behavior: "smooth" });
                      }}
                    />
                  </div>
                </>
              )}
            </>
          ) : (
            <div className="h-full min-h-[24rem] flex flex-col items-center justify-center text-gray-400 dark:text-neutral-500">
              <LibraryBig className="w-12 h-12 mb-4" />
              <p>
                {isSyncingCollections
                  ? "正在同步订阅合集..."
                  : collectionArchives.length > 0
                    ? "当前没有活跃的订阅合集，左侧「本地备份」仍保留。"
                    : "还没有订阅任何合集"}
              </p>
            </div>
          )}
        </div>
      </main>

      {archiveDetail ? (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setArchiveDetail(null);
          }}
        >
          <div className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl dark:bg-neutral-900">
            <div className="flex items-start gap-4 border-b border-gray-100 p-5 dark:border-neutral-800">
              <div className="flex h-16 w-28 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-gray-100 dark:bg-neutral-800">
                {archiveDetail.cover ? (
                  <img
                    src={archiveDetail.cover.replace("http:", "https:")}
                    alt={archiveDetail.title}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <ArchiveIcon className="h-7 w-7 text-gray-400" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="truncate text-lg font-bold">
                    {archiveDetail.title || `合集 ${archiveDetail.id}`}
                  </h2>
                  <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-600 dark:bg-amber-500/10 dark:text-amber-400">
                    本地备份
                  </span>
                  <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-neutral-800 dark:text-neutral-400">
                    {archiveDetail.reason === "collection_gone" ? "已离开订阅" : "合集已失效"}
                  </span>
                </div>
                <div className="mt-1 text-sm text-gray-500 dark:text-neutral-400">
                  {archiveDetail.upper?.name || "未知 UP 主"} · 合集 ID {archiveDetail.id}
                </div>
                <div className="mt-1 text-xs text-gray-400 dark:text-neutral-500">
                  归档于 {formatArchiveDate(archiveDetail.archivedAt)} · 本地保存{" "}
                  {archiveDetail.resourceCount || archiveResources.length} 条
                </div>
              </div>
              <button
                type="button"
                aria-label="关闭合集备份详情"
                onClick={() => setArchiveDetail(null)}
                className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-300"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex items-center justify-between gap-3 border-b border-gray-100 px-5 py-3 dark:border-neutral-800">
              <p className="text-xs text-gray-400 dark:text-neutral-500">
                删除只清理本地备份，不会取消 B 站订阅；5 秒内可撤销。
              </p>
              <button
                type="button"
                onClick={() => setArchiveDeleteConfirm(true)}
                className="flex shrink-0 items-center gap-1.5 rounded-lg border border-red-200 px-3 py-1.5 text-sm text-red-500 transition-colors hover:bg-red-50 dark:border-red-500/30 dark:hover:bg-red-500/10"
              >
                <Trash2 className="h-4 w-4" />
                删除备份
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              {archiveLoading ? (
                <div className="py-10 text-center text-sm text-gray-400 dark:text-neutral-500">
                  正在加载备份内容...
                </div>
              ) : archiveResources.length === 0 ? (
                <div className="py-10 text-center text-sm text-gray-400 dark:text-neutral-500">
                  本地没有保存到这个合集的内容
                </div>
              ) : (
                <div className="space-y-2">
                  {archiveResources.map((resource) => (
                    <a
                      key={resource.id}
                      href={`https://www.bilibili.com/video/${resource.bvid}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-3 rounded-lg border border-gray-100 p-3 text-inherit no-underline transition-colors hover:bg-gray-50 dark:border-neutral-800 dark:hover:bg-neutral-800/60"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {resource.title || "已失效视频"}
                      </span>
                      <span className="shrink-0 font-mono text-xs text-gray-400 dark:text-neutral-500">
                        {resource.bvid}
                      </span>
                      <span className="shrink-0 text-xs text-gray-400 dark:text-neutral-500">
                        {resource.pubdate
                          ? new Date(resource.pubdate * 1000).toLocaleDateString()
                          : ""}
                      </span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {archiveDeleteConfirm && archiveDetail ? (
        <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl dark:bg-neutral-900">
            <h3 className="text-lg font-bold">删除这个合集备份？</h3>
            <p className="mt-2 text-sm leading-6 text-gray-500 dark:text-neutral-400">
              「{archiveDetail.title || `合集 ${archiveDetail.id}`}」的本地备份和已保存的{" "}
              {archiveDetail.resourceCount || archiveResources.length} 条内容会被清理。
              不会取消 B 站订阅，5 秒内可以撤销。
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                disabled={archiveDeleting}
                onClick={() => setArchiveDeleteConfirm(false)}
                className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
              >
                取消
              </button>
              <button
                type="button"
                disabled={archiveDeleting}
                onClick={() => void handleArchiveDelete()}
                className="rounded-lg bg-red-500 px-4 py-2 text-sm font-medium text-white hover:bg-red-600 disabled:opacity-50"
              >
                {archiveDeleting ? "删除中..." : "确认删除"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {archiveUndo ? (
        <div className="fixed bottom-6 left-1/2 z-[90] flex -translate-x-1/2 items-center gap-4 rounded-xl bg-neutral-900 px-5 py-3 text-sm text-white shadow-2xl dark:bg-white dark:text-neutral-900">
          <span>已删除「{archiveUndo.item.title || `合集 ${archiveUndo.item.id}`}」的本地备份</span>
          <button
            type="button"
            onClick={() => void handleArchiveUndo()}
            className="flex items-center gap-1 font-medium text-amber-400 hover:text-amber-300 dark:text-amber-600 dark:hover:text-amber-500"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            撤销 {archiveUndo.remaining}s
          </button>
        </div>
      ) : null}
    </div>
  );
};

export default SubscribedCollections;
