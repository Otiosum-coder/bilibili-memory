import { useCallback, useEffect, useMemo, useState } from "react";
import toast from "react-hot-toast";
import { FileText, LayoutDashboard, RefreshCw, X } from "lucide-react";
import {
  FOLLOWING_LAST_SYNC,
  FOLLOWING_SYNC_INTERVAL,
  FOLLOWING_SYNC_PROGRESS,
  FOLLOWING_AVATAR_ARCHIVE_PROGRESS,
  FAV_COVER_ARCHIVE_PROGRESS,
  COLLECTION_COVER_ARCHIVE_PROGRESS,
  HAS_FULL_FOLLOWING_SYNC,
  DEFAULT_FOLLOWING_SYNC_INTERVAL_MINUTES,
} from "../utils/constants";
import {
  countAssets,
  getAllFavFolders,
  getAllFavResources,
  getAllFollowing,
  getAllFollowingEvents,
  getAllInteractions,
  getAllSubscribedCollectionResources,
  getAllSubscribedCollections,
  getEarliestHistoryEventViewAt,
  getHistoryEventsInRange,
  getTotalHistoryCount,
} from "../utils/db";
import {
  CHANGE_TYPE_COLOR,
  CHANGE_TYPE_LABEL,
  buildDailyChangeSeries,
  buildDashboardMetrics,
  buildRecentEvents,
  earliestEventDay,
  summarizeEventTypes,
  type DailyChangePoint,
  type EventTypeTotals,
} from "../utils/followingStats";
import { buildFollowingStats } from "../utils/followingQuery";
import {
  INTERACTION_TYPE_LABEL,
  buildInteractionStats,
} from "../utils/interactionQuery";
import {
  REPORT_KINDS,
  REPORT_KIND_LABEL,
  REQUIRED_COVERAGE_DAYS,
  buildDailyViewSeries,
  buildHistoryReport,
  buildHourHistogram,
  buildHourAxisLabels,
  buildReportAvailability,
  buildTopAuthors,
  findPeakDay,
  findPeakHourWindow,
  filterEventsInRange,
  formatHourWindow,
  resolvePeriodStartMs,
  startOfLocalDaySec,
  summarizeViewCounts,
  toDayKey,
  toStatsEvents,
  type DailyViewPoint,
  type DurationBucket,
  type HistoryReport,
  type ReportKind,
} from "../utils/historyStats";
import { getStorageValue, setStorageValue } from "../utils/storage";
import type { FollowingEvent, FollowingItem, HistoryEvent } from "../utils/types";
import type { FollowingSyncProgress } from "../utils/followingSync";
import type { AvatarArchiveProgress } from "../utils/followingAssetArchive";
import type { CoverArchiveProgress } from "../utils/favCoverArchive";
import { FollowingChangeDetailModal } from "../components/FollowingChangeDetailModal";
import { FollowingChangeListModal } from "../components/FollowingChangeListModal";

/** 「最近变动」面板里直接展示的预览条数；更早的在「查看更多」弹窗里 */
const CHANGE_PREVIEW_SIZE = 8;

const RANGES = [
  { days: 7, label: "近 7 天" },
  { days: 30, label: "近 30 天" },
  { days: 90, label: "近 90 天" },
] as const;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 观看统计的窗口选项。上限就是年报需要的天数（365），
 * 这样"本年"始终落在已加载的窗口内，不必再查一次库。
 */
const VIEW_WINDOW_OPTIONS = [
  { days: 7, label: "近 7 天" },
  { days: 30, label: "近 30 天" },
  { days: 90, label: "近 90 天" },
  { days: 365, label: "近一年" },
] as const;

const MAX_VIEW_WINDOW_DAYS = 365;

/** 「最近在看的 UP 主」用的近期窗口 */
const AUTHOR_RECENT_OPTIONS = [
  { days: 7, label: "近 7 天" },
  { days: 30, label: "近 30 天" },
  { days: 90, label: "近 90 天" },
] as const;

// 星期分布已废弃：周几看得多对回顾没有指导意义，改画"时段分布"

/** "2026-10-08" → "10/8" */
const formatDayLabel = (day: string): string => {
  const [, month, date] = day.split("-");
  return `${Number(month)}/${Number(date)}`;
};

/** 记录起点只展示日期，不展示时分 */
const formatRecordStart = (timestampSec: number): string =>
  new Date(timestampSec * 1000).toLocaleDateString();

const formatDay = (day: string): string => day.slice(5);

const formatDateTime = (timestamp?: number): string => {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  const pad = (value: number) => `${value}`.padStart(2, "0");
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`;
};

const formatRelativeDay = (day: string): string => {
  const today = new Date();
  const todayDay = `${today.getFullYear()}-${`${today.getMonth() + 1}`.padStart(2, "0")}-${`${today.getDate()}`.padStart(2, "0")}`;
  return day === todayDay ? "今天" : day;
};

const STACK_ORDER = ["followed", "unfollowed", "renamed", "accountGone"] as const;
const STACK_TYPE = {
  followed: "followed",
  unfollowed: "unfollowed",
  renamed: "renamed",
  accountGone: "account_gone",
} as const;

/** 手写 SVG 堆叠柱状图：不引入图表库，保持扩展体积可控 */
const DailyChangeChart = ({ points }: { points: DailyChangePoint[] }) => {
  const width = 760;
  const height = 220;
  const padLeft = 34;
  const padRight = 6;
  const padTop = 10;
  const padBottom = 24;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const max = Math.max(1, ...points.map((point) => point.total));
  const slot = plotWidth / Math.max(1, points.length);
  const barWidth = Math.max(2, Math.min(24, slot * 0.66));
  const tickStep = Math.max(1, Math.ceil(points.length / 6));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full text-gray-500 dark:text-neutral-400"
      role="img"
      aria-label="每日关注变动趋势"
    >
      {[0, 0.5, 1].map((ratio) => {
        const y = padTop + plotHeight * (1 - ratio);
        return (
          <g key={ratio}>
            <line
              x1={padLeft}
              x2={width - padRight}
              y1={y}
              y2={y}
              stroke="currentColor"
              strokeOpacity={0.15}
              strokeWidth={1}
            />
            <text x={padLeft - 6} y={y + 3} textAnchor="end" fontSize={10} fill="currentColor" opacity={0.6}>
              {Math.round(max * ratio)}
            </text>
          </g>
        );
      })}

      {points.map((point, index) => {
        const x = padLeft + index * slot + (slot - barWidth) / 2;
        let cursorY = padTop + plotHeight;
        return (
          <g key={point.day}>
            {STACK_ORDER.map((key) => {
              const value = point[key];
              if (!value) return null;
              const segmentHeight = (value / max) * plotHeight;
              cursorY -= segmentHeight;
              return (
                <rect
                  key={key}
                  x={x}
                  y={cursorY}
                  width={barWidth}
                  height={segmentHeight}
                  fill={CHANGE_TYPE_COLOR[STACK_TYPE[key]]}
                  rx={1}
                />
              );
            })}
            <title>
              {`${point.day}　新增 ${point.followed} · 取关 ${point.unfollowed} · 改名 ${point.renamed} · 注销 ${point.accountGone}`}
            </title>
          </g>
        );
      })}

      {points.map((point, index) => {
        if (index % tickStep !== 0 && index !== points.length - 1) return null;
        const x = padLeft + index * slot + slot / 2;
        return (
          <text
            key={point.day}
            x={x}
            y={height - 6}
            textAnchor="middle"
            fontSize={10}
            fill="currentColor"
            opacity={0.6}
          >
            {formatDayLabel(point.day)}
          </text>
        );
      })}
    </svg>
  );
};

/**
 * 手写 SVG 柱状图：每日看过的视频数。没有观看的日子保留 0 高度槽位，日期轴保持连续。
 *
 * 柱子用**不同视频数**而不是记录条数：B 站会在播放过程中反复刷新 view_at，
 * 一次连续观看可能留下几十条记录，用它当柱高会显得"一天看了几十个视频"。
 */
const DailyViewChart = ({ points }: { points: DailyViewPoint[] }) => {
  const width = 760;
  const height = 190;
  const padLeft = 30;
  const padRight = 6;
  const padTop = 10;
  const padBottom = 22;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const max = Math.max(1, ...points.map((point) => point.uniqueContents));
  const slot = plotWidth / Math.max(1, points.length);
  const barWidth = Math.max(1, Math.min(18, slot * 0.7));
  const tickStep = Math.max(1, Math.ceil(points.length / 7));

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full text-gray-400 dark:text-neutral-500"
      role="img"
      aria-label="每日观看的视频数"
    >
      <defs>
        <linearGradient id="dailyBarGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f472b6" />
          <stop offset="100%" stopColor="#db2777" />
        </linearGradient>
      </defs>

      {[0, 0.5, 1].map((ratio) => {
        const y = padTop + plotHeight * (1 - ratio);
        return (
          <g key={ratio}>
            <line
              x1={padLeft}
              x2={width - padRight}
              y1={y}
              y2={y}
              stroke="currentColor"
              strokeOpacity={0.15}
              strokeWidth={1}
            />
            <text
              x={padLeft - 6}
              y={y + 3}
              textAnchor="end"
              fontSize={10}
              fill="currentColor"
              opacity={0.6}
            >
              {Math.round(max * ratio)}
            </text>
          </g>
        );
      })}

      {points.map((point, index) => {
        const barHeight = (point.uniqueContents / max) * plotHeight;
        const x = padLeft + index * slot + (slot - barWidth) / 2;
        // 只报"多少个视频"。不报记录条数：两个时期的口径不同（早期是迁移快照，
        // 每个视频仅一条；之后是实时同步，每次观测一条），放一起会让人以为观看行为突变。
        const label = `${point.day} · ${point.uniqueContents} 个视频`;
        return (
          <g key={point.day}>
            <rect
              x={x}
              y={padTop + plotHeight - barHeight}
              width={barWidth}
              height={point.uniqueContents > 0 ? Math.max(barHeight, 2) : 0}
              rx={1}
              fill="url(#dailyBarGradient)"
            />
            {/* 柱身只有几像素宽时鼠标很难命中，用整列透明热区承载原生提示 */}
            <rect
              x={padLeft + index * slot}
              y={padTop}
              width={slot}
              height={plotHeight}
              fill="transparent"
            >
              <title>{label}</title>
            </rect>
          </g>
        );
      })}

      {points.map((point, index) =>
        index % tickStep === 0 || index === points.length - 1 ? (
          <text
            key={`tick-${point.day}`}
            x={padLeft + index * slot + slot / 2}
            y={height - 6}
            textAnchor="middle"
            fontSize={10}
            fill="currentColor"
            opacity={0.6}
          >
            {formatDayLabel(point.day)}
          </text>
        ) : null,
      )}
    </svg>
  );
};

/** 日趋势的三种画法。柱状看单日高低，折线看走向，热力图看长期规律（配合"近一年"最合适） */
type TrendChartKind = "bar" | "line" | "heatmap";

const TREND_CHARTS: Array<{ value: TrendChartKind; label: string }> = [
  { value: "bar", label: "柱状" },
  { value: "line", label: "折线" },
  { value: "heatmap", label: "热力" },
];

/** 折线图：与柱状图共用同一套坐标轴算法，只是把柱子换成折线 + 面积渐变 */
const DailyViewLineChart = ({ points }: { points: DailyViewPoint[] }) => {
  const width = 760;
  const height = 190;
  const padLeft = 30;
  const padRight = 6;
  const padTop = 10;
  const padBottom = 22;
  const plotWidth = width - padLeft - padRight;
  const plotHeight = height - padTop - padBottom;
  const max = Math.max(1, ...points.map((point) => point.uniqueContents));
  const step = plotWidth / Math.max(1, points.length - 1);
  const tickStep = Math.max(1, Math.ceil(points.length / 7));
  const coords = points.map((point, index) => ({
    day: point.day,
    value: point.uniqueContents,
    x: padLeft + index * step,
    y: padTop + plotHeight * (1 - point.uniqueContents / max),
  }));
  const line = coords.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
  const area = `${padLeft},${padTop + plotHeight} ${line} ${
    padLeft + Math.max(0, points.length - 1) * step
  },${padTop + plotHeight}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="w-full text-gray-400 dark:text-neutral-500"
      role="img"
      aria-label="每日观看的视频数（折线）"
    >
      <defs>
        <linearGradient id="dailyLineArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#ec4899" stopOpacity={0.32} />
          <stop offset="100%" stopColor="#ec4899" stopOpacity={0.02} />
        </linearGradient>
      </defs>

      {[0, 0.5, 1].map((ratio) => {
        const y = padTop + plotHeight * (1 - ratio);
        return (
          <g key={ratio}>
            <line
              x1={padLeft}
              x2={width - padRight}
              y1={y}
              y2={y}
              stroke="currentColor"
              strokeOpacity={0.15}
              strokeWidth={1}
            />
            <text
              x={padLeft - 6}
              y={y + 3}
              textAnchor="end"
              fontSize={10}
              fill="currentColor"
              opacity={0.6}
            >
              {Math.round(max * ratio)}
            </text>
          </g>
        );
      })}

      <polygon points={area} fill="url(#dailyLineArea)" />
      <polyline
        points={line}
        fill="none"
        stroke="#ec4899"
        strokeWidth={2}
        strokeLinejoin="round"
        strokeLinecap="round"
      />

      {coords.map((point) => (
        <g key={point.day}>
          <circle cx={point.x} cy={point.y} r={2.5} fill="#ec4899" />
          {/* 命中区：点太小时用一整列承载原生提示 */}
          <rect
            x={point.x - step / 2}
            y={padTop}
            width={Math.max(1, step)}
            height={plotHeight}
            fill="transparent"
          >
            <title>{`${point.day} · ${point.value} 个视频`}</title>
          </rect>
        </g>
      ))}

      {points.map((point, index) =>
        index % tickStep === 0 || index === points.length - 1 ? (
          <text
            key={`tick-${point.day}`}
            x={padLeft + index * step}
            y={height - 6}
            textAnchor="middle"
            fontSize={10}
            fill="currentColor"
            opacity={0.6}
          >
            {formatDayLabel(point.day)}
          </text>
        ) : null,
      )}
    </svg>
  );
};

/** 热力图的 5 档配色。0 档是"当天没有记录"，用中性色避免被误读成"很少" */
const HEAT_LEVEL_CLASS = [
  "fill-gray-100 dark:fill-neutral-800",
  "fill-pink-100 dark:fill-pink-900",
  "fill-pink-200 dark:fill-pink-800",
  "fill-pink-400 dark:fill-pink-600",
  "fill-pink-600 dark:fill-pink-400",
  "fill-pink-800 dark:fill-pink-300",
];

/** 档位数（不含"无记录"）。评审结论：5 档 + 无记录 = 6 个色块，再多深浅就分不出来了 */
const HEAT_BUCKET_COUNT = 5;
const WEEKDAY_SHORT = ["一", "二", "三", "四", "五", "六", "日"];

/** 分档步长的候选值，取第一个满足「4 档装得下最大值」的 */
const HEAT_STEP_CANDIDATES = [1, 2, 5, 10, 20, 25, 50, 100, 200, 500, 1000];

/**
 * 热力图的分档：**按具体数量区间**分，而不是按百分比排名。
 *
 * 参考图（GitHub / B 站贡献图）的图例写的是 "1-10 / 11-50 / 51-100 …"——
 * 用户看到的应该是"那天看了 37 个视频落在哪一档"，而不是"落在第 3 个四分位"。
 * 步长从候选值里挑一个能把最大值装进 4 档的，图例因此永远是人能读的整数。
 */
const buildHeatStep = (max: number): number =>
  HEAT_STEP_CANDIDATES.find((step) => step * HEAT_BUCKET_COUNT >= max) ??
  Math.max(1, Math.ceil(max / HEAT_BUCKET_COUNT));

const heatLevelOf = (value: number, step: number): number =>
  value <= 0 ? 0 : Math.min(HEAT_BUCKET_COUNT, Math.ceil(value / step));

/** 第 i 档的数量区间文案；0 档是"无记录"，最后一档是开区间 */
const heatLevelLabel = (index: number, step: number): string => {
  if (index === 0) return "无记录";
  if (index === HEAT_BUCKET_COUNT) return `${step * (HEAT_BUCKET_COUNT - 1) + 1}+`;
  return `${step * (index - 1) + 1}–${step * index}`;
};

/**
 * 热力图（仿 GitHub 贡献图）：列 = 周，行 = 周一…周日。
 *
 * 数据就是当前的日序列，所以**配合"近一年"窗口才有意义**；短窗口会是一条窄条，
 * 这是刻意的——不为了好看而偷偷换一套数据口径。
 */
const DailyViewHeatmap = ({ points }: { points: DailyViewPoint[] }) => {
  const width = 760;
  const padLeft = 22;
  const padTop = 16;
  const padRight = 6;
  const max = Math.max(1, ...points.map((point) => point.uniqueContents));
  const step = buildHeatStep(max);

  // 第一天是周几 → 前面补几个空格，让每一列都对齐到自然周
  const firstDate = new Date(`${points[0]?.day ?? "1970-01-01"}T00:00:00`);
  const lead = (firstDate.getDay() + 6) % 7;
  const total = lead + points.length;
  const cols = Math.max(1, Math.ceil(total / 7));
  const gap = 2;
  const cell = Math.max(8, Math.min(16, Math.floor((width - padLeft - padRight) / cols) - gap));
  const height = padTop + 7 * (cell + gap) + 16;

  // 月份标签：某列的起始日进入新月份时标一次，太挤就跳过
  const monthLabels: Array<{ col: number; text: string }> = [];
  let lastMonth = -1;
  for (let col = 0; col < cols; col += 1) {
    const firstIndex = col * 7 - lead;
    const point = points[Math.max(0, firstIndex)];
    if (!point) continue;
    const month = new Date(`${point.day}T00:00:00`).getMonth();
    if (month !== lastMonth && firstIndex >= 0) {
      lastMonth = month;
      if (monthLabels.length === 0 || col - monthLabels[monthLabels.length - 1].col >= 3) {
        monthLabels.push({ col, text: `${month + 1} 月` });
      }
    }
  }

  return (
    <div>
      {/* 图例直接写数量区间：颜色深浅对应"那天看了多少个视频"，不是相对排名 */}
      <div className="flex flex-wrap justify-end gap-x-3 gap-y-1 pb-1 text-[10px] text-gray-400 dark:text-neutral-500">
        {HEAT_LEVEL_CLASS.map((className, index) => (
          <span key={className} className="flex items-center gap-1">
            <span className={`h-2.5 w-2.5 rounded-[2px] ${className.replace("fill-", "bg-")}`} />
            {heatLevelLabel(index, step)}
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        role="img"
        aria-label="每日观看热度"
      >
        {monthLabels.map((label) => (
          <text
            key={`${label.col}-${label.text}`}
            x={padLeft + label.col * (cell + gap)}
            y={10}
            fontSize={10}
            className="fill-gray-400 dark:fill-neutral-500"
          >
            {label.text}
          </text>
        ))}

        {WEEKDAY_SHORT.map((label, row) =>
          row % 2 === 0 ? (
            <text
              key={label}
              x={padLeft - 6}
              y={padTop + row * (cell + gap) + cell * 0.8}
              textAnchor="end"
              fontSize={9}
              className="fill-gray-400 dark:fill-neutral-500"
            >
              {label}
            </text>
          ) : null,
        )}

        {points.map((point, index) => {
          const position = lead + index;
          const col = Math.floor(position / 7);
          const row = position % 7;
          return (
            <rect
              key={point.day}
              x={padLeft + col * (cell + gap)}
              y={padTop + row * (cell + gap)}
              width={cell}
              height={cell}
              rx={2}
              className={HEAT_LEVEL_CLASS[heatLevelOf(point.uniqueContents, step)]}
            >
              <title>{`${point.day} · ${point.uniqueContents} 个视频`}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
};

/** 时长档位的配色：粉→深紫的连续阶，最后一档给「无时长信息」留灰色 */
const DURATION_DONUT_COLORS = ["#f9a8d4", "#f472b6", "#ec4899", "#db2777", "#9d174d", "#cbd5e1"];

/**
 * 视频时长分布（环形图）。
 *
 * 用环形而不是条形：这是"构成"问题（我偏好哪种长度），扇形一眼能看出主次；
 * 而「什么时候看」那种带时间轴的才适合柱状。
 *
 * 两个实现要点：
 * - 环用 `stroke-dasharray` 画，而不是拼 arc 路径——单一档位占满 100% 时路径要特判整圆，
 *   dasharray 天然没有这个问题；
 * - 占比**直接标在环上**（≥5% 的档才标，否则文字会叠在一起），颜色到档位的对应关系
 *   交给下方图例。图例不再用 `truncate`：之前窄栏里标签被截成「15…」，
 *   正是"看不出怎么分的"的根因。
 */
const DurationDonut = ({ buckets }: { buckets: DurationBucket[] }) => {
  const shown = buckets.filter((bucket) => bucket.contents > 0);
  const total = shown.reduce((sum, bucket) => sum + bucket.contents, 0);
  const known = shown
    .filter((bucket) => bucket.label !== "无时长信息")
    .reduce((sum, bucket) => sum + bucket.contents, 0);

  if (total === 0) {
    return <p className="text-sm text-gray-400 dark:text-neutral-500">本期没有记录</p>;
  }

  const size = 188;
  const center = size / 2;
  const radius = 54;
  const labelRadius = radius + 17;
  const circumference = 2 * Math.PI * radius;

  let cursor = 0;
  const slices = shown.map((bucket) => {
    const share = bucket.contents / total;
    const length = share * circumference;
    const midAngle = -90 + ((cursor + length / 2) / circumference) * 360;
    const radians = (midAngle * Math.PI) / 180;
    const cos = Math.cos(radians);
    const slice = {
      bucket,
      share,
      color: DURATION_DONUT_COLORS[buckets.indexOf(bucket) % DURATION_DONUT_COLORS.length],
      length,
      offset: cursor,
      labelX: center + labelRadius * Math.cos(radians),
      labelY: center + labelRadius * Math.sin(radians),
      anchor: (cos > 0.25 ? "start" : cos < -0.25 ? "end" : "middle") as
        | "start"
        | "end"
        | "middle",
      showLabel: share >= 0.05,
    };
    cursor += length;
    return slice;
  });

  return (
    <div className="flex flex-col items-center">
      <div className="relative" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} className="h-full w-full">
          {/* 只把环旋转到 12 点方向；标签单独画在未旋转的坐标系里，否则文字会跟着转 */}
          <g transform={`rotate(-90 ${center} ${center})`}>
            {slices.map((slice) => (
              <circle
                key={slice.bucket.label}
                cx={center}
                cy={center}
                r={radius}
                fill="none"
                stroke={slice.color}
                strokeWidth={24}
                strokeDasharray={`${slice.length} ${circumference - slice.length}`}
                strokeDashoffset={-slice.offset}
              >
                <title>{`${slice.bucket.label} · ${slice.bucket.contents} 个视频`}</title>
              </circle>
            ))}
          </g>

          {slices
            .filter((slice) => slice.showLabel)
            .map((slice) => (
              <text
                key={`label-${slice.bucket.label}`}
                x={slice.labelX}
                y={slice.labelY}
                textAnchor={slice.anchor}
                dominantBaseline="middle"
                fontSize={11}
                className="fill-gray-500 dark:fill-neutral-400"
              >
                {Math.round(slice.share * 100)}%
              </text>
            ))}
        </svg>

        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-semibold tabular-nums text-gray-900 dark:text-neutral-100">
            {known}
          </span>
          <span className="text-[10px] text-gray-400 dark:text-neutral-500">个视频</span>
        </div>
      </div>

      <ul className="mt-4 w-full space-y-2">
        {slices.map((slice) => (
          <li key={slice.bucket.label} className="flex items-center gap-2 text-sm">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: slice.color }}
            />
            <span className="min-w-0 flex-1 text-gray-700 dark:text-neutral-200">
              {slice.bucket.label}
            </span>
            <span className="shrink-0 text-xs tabular-nums text-gray-400 dark:text-neutral-500">
              {Math.round(slice.share * 100)}%
            </span>
            <span className="w-16 shrink-0 text-right text-xs font-medium tabular-nums text-gray-700 dark:text-neutral-200">
              {slice.bucket.contents} 个
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/** 报告内容用一个弹窗承载，不新开页面 */
const HistoryReportModal = ({
  report,
  following,
  onClose,
}: {
  report: HistoryReport;
  /** 本期关注变动；null 表示没算（例如直接构造了报告对象） */
  following: EventTypeTotals | null;
  onClose: () => void;
}) => {
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const totalVideos = report.summary.uniqueContents;
  const dailyAverage =
    report.activeDays > 0 ? Math.round((totalVideos / report.activeDays) * 10) / 10 : 0;
  const hourAxisLabels = buildHourAxisLabels();

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${report.kindLabel} ${report.periodLabel}`}
    >
      <button type="button" aria-label="关闭" className="absolute inset-0 cursor-default" onClick={onClose} />
      <div className="relative max-h-[85vh] w-full max-w-[900px] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl dark:bg-neutral-900">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-bold text-gray-900 dark:text-neutral-100">
              {report.kindLabel}
            </h2>
            <p className="mt-1 text-xs text-gray-400 dark:text-neutral-500">
              {report.periodLabel} · 本期 {report.totalDays} 天中有 {report.activeDays} 天有记录
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭报告"
            className="rounded-md p-1.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-wrap gap-3">
          {[
            { label: "看过的视频", value: totalVideos },
            { label: "完整播放", value: report.completedPlays },
            { label: "活跃天数", value: report.activeDays },
            { label: "活跃日均", value: dailyAverage },
            { label: "最长连续", value: `${report.longestStreak} 天` },
          ].map((item) => (
            <div
              key={item.label}
              className="min-w-[7rem] flex-1 rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 dark:border-neutral-800 dark:bg-neutral-800/50"
            >
              <p className="text-xs text-gray-500 dark:text-neutral-400">{item.label}</p>
              <p className="mt-1 text-lg font-semibold tabular-nums text-gray-900 dark:text-neutral-100">
                {item.value}
              </p>
            </div>
          ))}
        </div>

        {/* 本期关注变动：报告原本只讲"看了什么"，这里补上"关注关系发生了什么" */}
        {following ? (
          <section className="mt-4 rounded-xl border border-gray-100 p-4 dark:border-neutral-800">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-neutral-100">
                本期关注变动
              </h3>
              <p className="text-xs text-gray-400 dark:text-neutral-500">
                按插件的关注同步记录统计
              </p>
            </div>
            <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-2 text-sm">
              <span className="text-gray-600 dark:text-neutral-300">
                新增关注{" "}
                <span className="text-lg font-semibold tabular-nums text-pink-600 dark:text-pink-400">
                  {following.followed}
                </span>{" "}
                人
              </span>
              <span className="text-gray-600 dark:text-neutral-300">
                取关{" "}
                <span className="text-lg font-semibold tabular-nums text-amber-600 dark:text-amber-400">
                  {following.unfollowed}
                </span>{" "}
                人
              </span>
              <span className="text-xs text-gray-400 dark:text-neutral-500">
                改名 {following.renamed} · 账号注销 {following.accountGone}
              </span>
            </div>
            <p className="mt-2 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
              只有插件建立关注基线之后发生的变动才有记录；刚装上插件的那一期这里会是 0。
            </p>
          </section>
        ) : null}

        <div className="mt-5 rounded-xl border border-gray-100 p-4 dark:border-neutral-800">
          <DailyViewChart points={report.series} />
        </div>

        <div className="mt-4 space-y-4">
          <section className="rounded-xl border border-gray-100 p-4 dark:border-neutral-800">
            <div className="mb-1 flex flex-wrap items-baseline justify-between gap-2">
              {/* 「最爱时段」并进这张图：它就是分布的最高点，单开一张卡只是占地方。
                  星期分布已废弃——"周几看得多"对回顾没有指导意义，"几点看得多"才有。 */}
              <h3 className="text-sm font-semibold text-gray-900 dark:text-neutral-100">
                24 小时时段分布（个视频）
              </h3>
              <p className="text-xs text-gray-500 dark:text-neutral-400">
                最爱时段{" "}
                <span className="font-semibold text-gray-900 dark:text-neutral-100">
                  {formatHourWindow(report.peakHour)}
                </span>
                {report.peakHour ? ` · 共 ${report.peakHour.views} 个视频` : ""}
              </p>
            </div>
            <HourSlotChart values={report.hours} labels={hourAxisLabels} />
          </section>

          {/* 榜单与内容类型分布并排：单放一个 5 行的榜单，右边会空一大片；
              两个都带宽度的占比条，卡片的"形状"也立起来了 */}
          {/* 左窄右宽：UP 主榜单几十个字就够，扇形图要地方放环上的占比标注 */}
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            <section className="rounded-xl border border-gray-100 p-4 dark:border-neutral-800">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-neutral-100">
                  看得最多的 UP 主
                </h3>
                <span className="text-xs text-gray-400 dark:text-neutral-500">按不同视频数</span>
              </div>
              <ul className="space-y-2.5">
                {report.topAuthors.map((author) => (
                  <li key={author.mid} className="text-sm">
                    <div className="flex items-baseline gap-2">
                      <span
                        className="min-w-0 flex-1 truncate text-gray-700 dark:text-neutral-200"
                        title={author.name}
                      >
                        {author.name}
                      </span>
                      <span className="shrink-0 text-xs text-gray-400 dark:text-neutral-500">
                        完整播放 {author.completedPlays} 次
                      </span>
                      <span className="w-14 shrink-0 text-right text-xs font-medium tabular-nums text-gray-700 dark:text-neutral-200">
                        {author.uniqueContents} 个
                      </span>
                    </div>
                    {/* 占比条：以榜首为满格，一眼看出梯队差距 */}
                    <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-neutral-800">
                      <div
                        className="h-full rounded-full bg-pink-400/80"
                        style={{
                          width: `${Math.round(
                            (author.uniqueContents /
                              Math.max(1, report.topAuthors[0]?.uniqueContents ?? 1)) *
                              100,
                          )}%`,
                        }}
                      />
                    </div>
                  </li>
                ))}
                {report.topAuthors.length === 0 ? (
                  <li className="text-sm text-gray-400 dark:text-neutral-500">本期没有记录</li>
                ) : null}
              </ul>
            </section>

            <section className="rounded-xl border border-gray-100 p-4 dark:border-neutral-800">
              <div className="mb-3 flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-neutral-100">
                  视频时长分布
                </h3>
                <span className="text-xs text-gray-400 dark:text-neutral-500">按不同视频数</span>
              </div>
              <DurationDonut buckets={report.durationBuckets} />
              <p className="mt-3 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
                缺时长的记录单列一档（灰），不会被算进「5 分钟以内」；
                数据面板里的「历史元数据回填」会把它们补上。
              </p>
            </section>
          </div>
        </div>

        <p className="mt-4 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
          数字是去重后的视频数；「完整播放」按进度到达片尾计数（≥95% 或接口标记已看完），
          同一视频循环播放会分别计数。两者都只统计视频 / 番剧 / 课程，且都是插件定时观测到的
          下限——扩展没在运行、或循环短于同步间隔时会计少。
        </p>
      </div>
    </div>
  );
};

const ProportionBar = ({
  segments,
}: {
  segments: Array<{ label: string; value: number; color: string }>;
}) => {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  return (
    <div>
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-neutral-800">
        {total > 0
          ? segments.map((segment) => (
              <div
                key={segment.label}
                style={{ width: `${(segment.value / total) * 100}%`, backgroundColor: segment.color }}
                title={`${segment.label} ${segment.value}`}
              />
            ))
          : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {segments.map((segment) => (
          <span key={segment.label} className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-neutral-400">
            <span className="h-2 w-2 rounded-full" style={{ backgroundColor: segment.color }} />
            {segment.label}
            <span className="font-medium text-gray-700 dark:text-neutral-200">{segment.value}</span>
          </span>
        ))}
      </div>
    </div>
  );
};

/**
 * 时段柱子的配色：**跨 24 小时连续渐变**（蓝 → 青绿 → 黄 → 橙 → 粉 → 玫红），
 * 外加每根柱子自上而下的一层浅色渐变。
 *
 * 参考 B 站「观看时间分析」：整条曲线随时间变色，一眼能看出作息，而不是四块硬色。
 */
const HOUR_GRADIENT_STOPS: Array<{ hour: number; rgb: [number, number, number] }> = [
  { hour: 0, rgb: [96, 165, 250] }, // 蓝
  { hour: 5, rgb: [45, 212, 191] }, // 青绿
  { hour: 9, rgb: [74, 222, 128] }, // 绿
  { hour: 13, rgb: [250, 204, 21] }, // 黄
  { hour: 17, rgb: [251, 146, 60] }, // 橙
  { hour: 21, rgb: [244, 114, 182] }, // 粉
  { hour: 23, rgb: [219, 39, 119] }, // 玫红
];

const hourBarRgb = (hour: number): [number, number, number] => {
  for (let i = 0; i < HOUR_GRADIENT_STOPS.length - 1; i += 1) {
    const from = HOUR_GRADIENT_STOPS[i];
    const to = HOUR_GRADIENT_STOPS[i + 1];
    if (hour <= to.hour) {
      const ratio = (hour - from.hour) / Math.max(1, to.hour - from.hour);
      return [
        Math.round(from.rgb[0] + (to.rgb[0] - from.rgb[0]) * ratio),
        Math.round(from.rgb[1] + (to.rgb[1] - from.rgb[1]) * ratio),
        Math.round(from.rgb[2] + (to.rgb[2] - from.rgb[2]) * ratio),
      ];
    }
  }
  return HOUR_GRADIENT_STOPS[HOUR_GRADIENT_STOPS.length - 1].rgb;
};

/** 每根柱子再用一层"上浅下深"的渐变，避免整排柱子看起来是一块色板 */
const hourBarBackground = (hour: number): string => {
  const base = hourBarRgb(hour);
  const top = base.map((value) => Math.round(value + (255 - value) * 0.32));
  return `linear-gradient(to top, rgb(${base.join(",")}), rgb(${top.join(",")}))`;
};

/** 把坐标轴上限抬到"好看"的整数，并按 3 等分给刻度 */
const buildAxisTicks = (peak: number): { max: number; ticks: number[] } => {
  const niceStep = (raw: number): number => {
    if (raw <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const normalized = raw / magnitude;
    const step = normalized <= 1.5 ? 1.5 : normalized <= 2 ? 2 : normalized <= 3 ? 3 : normalized <= 5 ? 5 : 10;
    return step * magnitude;
  };
  const step = niceStep(Math.max(1, peak) / 3);
  const max = Math.max(3, Math.round(step * 3));
  return { max, ticks: [0, step, step * 2, step * 3].map((value) => Math.round(value)) };
};

/**
 * 时段分布图：24 根柱子，一小时一根，**占满整行**。
 *
 * 设计参照 B 站自己的"24 小时观看分布"：
 * - 左侧 Y 轴刻度 + 横向网格线，柱子上不再写数字（24 根柱子塞 24 个数字必然挤，
 *   具体数值交给 hover）；
 * - 横轴每 3 小时一个 `H:00`（`buildHourAxisLabels()` 为其余小时留空串占位，刻度与柱子仍然对齐）；
 * - 柱子按时间段上色，扫一眼就能看出作息。
 */
const HourSlotChart = ({ values, labels }: { values: number[]; labels: string[] }) => {
  const { max, ticks } = buildAxisTicks(Math.max(1, ...values));

  return (
    <div className="mt-3">
      <div className="flex gap-2">
        {/* Y 轴刻度：从上到下与网格线一一对应 */}
        <div className="flex h-[132px] w-9 shrink-0 flex-col justify-between text-right text-[10px] leading-none tabular-nums text-gray-400 dark:text-neutral-500">
          {ticks
            .slice()
            .reverse()
            .map((tick) => (
              <span key={tick}>{tick}</span>
            ))}
        </div>

        <div className="relative min-w-0 flex-1">
          {/* 网格线 */}
          <div className="pointer-events-none absolute inset-0 flex flex-col justify-between">
            {ticks.map((tick) => (
              <div
                key={tick}
                className="border-t border-gray-100 dark:border-neutral-800"
              />
            ))}
          </div>
          {/* 柱子 */}
          <div className="relative flex h-[132px] items-end gap-[2px]">
            {values.map((value, hour) => (
              <div
                key={hour}
                className="flex h-full min-w-0 flex-1 items-end"
                title={`${hour}:00–${hour + 1}:00 · ${value} 个视频`}
              >
                <div
                  className="w-full rounded-t"
                  style={{
                    height: `${Math.max(value > 0 ? 2 : 0, Math.round((value / max) * 100))}%`,
                    background: hourBarBackground(hour),
                  }}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 横轴：与柱子同宽同间距 */}
      <div className="mt-1 flex gap-2">
        <div className="w-9 shrink-0" />
        <div className="flex min-w-0 flex-1 gap-[2px]">
          {labels.map((label, hour) => (
            <span
              key={hour}
              className="min-w-0 flex-1 whitespace-nowrap text-center text-[9px] leading-none text-gray-400 dark:text-neutral-500"
            >
              {label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

const Panel = ({
  title,
  hint,
  action,
  children,
  className = "",
}: {
  title: string;
  hint?: string;
  /** 标题右侧的操作入口（如「查看更多」）。入口放右上角，不占正文高度 */
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) => (
  <section
    className={`rounded-xl border border-gray-100 bg-white p-4 shadow-sm dark:border-neutral-800 dark:bg-neutral-900 ${className}`}
  >
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-base font-semibold text-gray-900 dark:text-neutral-100">{title}</h2>
      <div className="flex shrink-0 items-center gap-3">
        {hint ? <span className="text-xs text-gray-400 dark:text-neutral-500">{hint}</span> : null}
        {action}
      </div>
    </div>
    {children}
  </section>
);

export const Dashboard = () => {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [rangeDays, setRangeDays] = useState<number>(30);
  /** 「最近变动」面板：预览条数由常量决定，完整列表在弹窗里 */
  const [changeListOpen, setChangeListOpen] = useState(false);
  /** 正在看明细的那条变动；`null` 表示弹窗关闭 */
  const [activeChangeEvent, setActiveChangeEvent] = useState<FollowingEvent | null>(null);
  const [viewEvents, setViewEvents] = useState<HistoryEvent[]>([]);
  const [recordStartedAt, setRecordStartedAt] = useState<number | null>(null);
  const [viewWindowDays, setViewWindowDays] = useState<number>(30);
  const [trendChart, setTrendChart] = useState<TrendChartKind>("bar");
  const [authorRecentDays, setAuthorRecentDays] = useState<number>(30);
  const [reportKind, setReportKind] = useState<ReportKind | null>(null);
  const [metrics, setMetrics] = useState({
    historyCount: 0,
    favoriteCount: 0,
    folderCount: 0,
    collectionCount: 0,
    collectionResourceCount: 0,
  });
  const [following, setFollowing] = useState<Awaited<ReturnType<typeof getAllFollowing>>>([]);
  const [events, setEvents] = useState<FollowingEvent[]>([]);
  const [interactions, setInteractions] = useState<Awaited<ReturnType<typeof getAllInteractions>>>(
    [],
  );
  const [progress, setProgress] = useState<FollowingSyncProgress | null>(null);
  const [hasBaseline, setHasBaseline] = useState(false);
  const [lastSyncAt, setLastSyncAt] = useState<number | null>(null);
  const [intervalMinutes, setIntervalMinutes] = useState(DEFAULT_FOLLOWING_SYNC_INTERVAL_MINUTES);
  const [assetCount, setAssetCount] = useState(0);
  const [avatarAssetCount, setAvatarAssetCount] = useState(0);
  const [coverAssetCount, setCoverAssetCount] = useState(0);
  const [archiveProgress, setArchiveProgress] = useState<AvatarArchiveProgress | null>(null);
  const [coverArchiveProgress, setCoverArchiveProgress] = useState<CoverArchiveProgress | null>(null);
  const [collectionCoverArchiveProgress, setCollectionCoverArchiveProgress] =
    useState<CoverArchiveProgress | null>(null);
  const [archiving, setArchiving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [
        historyCount,
        favorites,
        folders,
        collections,
        collectionResources,
        followingList,
        eventList,
        savedProgress,
        savedBaseline,
        savedLastSync,
        savedInterval,
        assets,
        avatarAssets,
        coverAssets,
        savedArchiveProgress,
        savedCoverArchiveProgress,
        savedCollectionCoverArchiveProgress,
        viewEventList,
        earliestViewAt,
        interactionList,
      ] = await Promise.all([
        getTotalHistoryCount(),
        getAllFavResources(),
        getAllFavFolders(),
        getAllSubscribedCollections(),
        getAllSubscribedCollectionResources(),
        getAllFollowing(),
        getAllFollowingEvents(),
        getStorageValue<FollowingSyncProgress | null>(FOLLOWING_SYNC_PROGRESS, null),
        getStorageValue(HAS_FULL_FOLLOWING_SYNC, false),
        getStorageValue<number | null>(FOLLOWING_LAST_SYNC, null),
        getStorageValue(FOLLOWING_SYNC_INTERVAL, DEFAULT_FOLLOWING_SYNC_INTERVAL_MINUTES),
        countAssets(),
        // 按类型直接数库里的实际张数，而不是依赖进度计数器——
        // 进度只是个累加值，一旦没存住，面板就会显示 0 张而库里其实已有上千张
        countAssets("avatar"),
        countAssets("cover"),
        getStorageValue<AvatarArchiveProgress | null>(FOLLOWING_AVATAR_ARCHIVE_PROGRESS, null),
        getStorageValue<CoverArchiveProgress | null>(FAV_COVER_ARCHIVE_PROGRESS, null),
        getStorageValue<CoverArchiveProgress | null>(COLLECTION_COVER_ARCHIVE_PROGRESS, null),
        // 只读最近一年的事件：观看事件表比 history 投影大一个数量级，
        // 统计永远先限定窗口，绝不整表读进内存
        getHistoryEventsInRange(
          Math.floor((Date.now() - MAX_VIEW_WINDOW_DAYS * DAY_MS) / 1000),
          Math.floor(Date.now() / 1000),
        ),
        getEarliestHistoryEventViewAt(),
        getAllInteractions(),
      ]);

      setMetrics({
        historyCount,
        favoriteCount: favorites.length,
        folderCount: folders.length,
        collectionCount: collections.length,
        collectionResourceCount: collectionResources.length,
      });
      setFollowing(followingList);
      setEvents(eventList);
      setProgress(savedProgress);
      setHasBaseline(savedBaseline);
      setLastSyncAt(savedLastSync);
      setIntervalMinutes(savedInterval);
      setAssetCount(assets);
      setAvatarAssetCount(avatarAssets);
      setCoverAssetCount(coverAssets);
      setArchiveProgress(savedArchiveProgress);
      setCoverArchiveProgress(savedCoverArchiveProgress);
      setCollectionCoverArchiveProgress(savedCollectionCoverArchiveProgress);
      setViewEvents(viewEventList);
      setRecordStartedAt(earliestViewAt);
      setInteractions(interactionList);
    } catch (error) {
      console.error("加载总览失败:", error);
      toast.error("加载总览失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 只重读归档相关的数据，避免整页重载。
   *
   * 归档一轮要跑几十秒，任务会每 20 条写一次进度；面板订阅存储变化实时更新，
   * 用户不必对着静止的界面干等。
   */
  const refreshArchiveStats = useCallback(async () => {
    const [savedAvatar, savedCover, savedCollectionCover, avatarCount, coverCount, total] =
      await Promise.all([
      getStorageValue<AvatarArchiveProgress | null>(FOLLOWING_AVATAR_ARCHIVE_PROGRESS, null),
      getStorageValue<CoverArchiveProgress | null>(FAV_COVER_ARCHIVE_PROGRESS, null),
      getStorageValue<CoverArchiveProgress | null>(COLLECTION_COVER_ARCHIVE_PROGRESS, null),
      countAssets("avatar"),
      countAssets("cover"),
      countAssets(),
    ]);
    setArchiveProgress(savedAvatar);
    setCoverArchiveProgress(savedCover);
    setCollectionCoverArchiveProgress(savedCollectionCover);
    setAvatarAssetCount(avatarCount);
    setCoverAssetCount(coverCount);
    setAssetCount(total);
  }, []);

  useEffect(() => {
    const listener = (changes: Record<string, unknown>) => {
      if (
        FOLLOWING_AVATAR_ARCHIVE_PROGRESS in changes ||
        FAV_COVER_ARCHIVE_PROGRESS in changes
      ) {
        void refreshArchiveStats();
      }
    };
    browser.storage.local.onChanged.addListener(listener);
    return () => browser.storage.local.onChanged.removeListener(listener);
  }, [refreshArchiveStats]);

  const handleSync = useCallback(async () => {
    setSyncing(true);
    try {
      const response = await browser.runtime.sendMessage({ action: "syncFollowing" });
      if (!response?.success) throw new Error(response?.error || "关注同步失败");
      toast.success(response.message ?? "关注同步完成");
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "关注同步失败");
    } finally {
      setSyncing(false);
    }
  }, [load]);

  const handleArchive = useCallback(async () => {
    setArchiving(true);
    try {
      // 两类图片一起触发：关注头像与收藏封面都归档到同一个 assets store
      const [avatarResponse, coverResponse, collectionResponse] = await Promise.all([
        browser.runtime.sendMessage({ action: "archiveFollowingAvatars" }),
        browser.runtime.sendMessage({ action: "archiveFavCovers" }),
        browser.runtime.sendMessage({ action: "archiveCollectionCovers" }),
      ]);

      const messages: string[] = [];
      if (avatarResponse?.success) messages.push(avatarResponse.message ?? "头像归档完成");
      if (coverResponse?.success) messages.push(coverResponse.message ?? "封面归档完成");
      if (collectionResponse?.success) {
        messages.push(collectionResponse.message ?? "合集封面归档完成");
      }

      if (messages.length === 0) {
        throw new Error(
          avatarResponse?.error ?? coverResponse?.error ?? collectionResponse?.error ?? "图片归档失败",
        );
      }
      toast.success(messages.join("；"));
      await load();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "图片归档失败");
    } finally {
      setArchiving(false);
    }
  }, [load]);

  const kpis = useMemo(() => buildDashboardMetrics(metrics, following.length), [metrics, following.length]);

  const interactionStats = useMemo(() => buildInteractionStats(interactions), [interactions]);

  /** 只保留视频类的观看事件：直播接口不给时长与进度，文章不是视频，都不进统计 */
  const statsEvents = useMemo(() => toStatsEvents(viewEvents), [viewEvents]);

  const dailySeries = useMemo(
    () => buildDailyViewSeries(statsEvents, viewWindowDays, Date.now()),
    [statsEvents, viewWindowDays],
  );

  /**
   * 实时记录开始的时刻。
   *
   * 数据库升级时迁移生成的事件，其 `observed_at` 全都等于升级那一刻；实时同步写入的
   * 则接近同步时间。所以"最早的 observed_at"就是插件开始真实记录的时间点。
   * 早于它的日期只有**历史快照**（每个视频一条、且只反映最后一次观看状态），
   * 拿它当"记录自"会让人高估早期覆盖度。
   */
  const realtimeSince = useMemo(() => {
    let earliest = Number.POSITIVE_INFINITY;
    for (const event of viewEvents) {
      const at = Number(event.observed_at);
      if (Number.isFinite(at) && at > 0 && at < earliest) earliest = at;
    }
    return Number.isFinite(earliest) ? Math.floor(earliest / 1000) : null;
  }, [viewEvents]);

  const viewSummary = useMemo(() => summarizeViewCounts(statsEvents, Date.now()), [statsEvents]);

  /**
   * 图表窗口内的子集。活跃天数 / 不同视频必须与图表同口径——
   * 用整年的数字配 7 天的图，用户会以为其中一个算错了。
   */
  const windowEvents = useMemo(() => {
    const fromSec = startOfLocalDaySec(Date.now()) - (viewWindowDays - 1) * (DAY_MS / 1000);
    return filterEventsInRange(statsEvents, fromSec, Math.floor(Date.now() / 1000));
  }, [statsEvents, viewWindowDays]);

  const windowSummary = useMemo(() => summarizeViewCounts(windowEvents, Date.now()), [windowEvents]);

  /**
   * 榜单按**近期**排序：只有全时段数字时，前几名都是 15–20 个视频，几乎没有区分度，
   * 也看不出"谁还在看、谁已经停了"。近期窗口一加，这些信息立刻出现。
   */
  /**
   * 名字兜底表：接口对部分内容类型不返回 author_name，实测会出现整行没有名字的条目。
   * 关注列表里已经有这些 UP 的当前昵称，直接拿来补，不额外发请求。
   */
  const authorNameByMid = useMemo(() => {
    const map = new Map<number, string>();
    for (const item of following) {
      if (item.name) map.set(item.mid, item.name);
    }
    return map;
  }, [following]);

  const topAuthors = useMemo(
    () =>
      buildTopAuthors(statsEvents, 5, {
        recentSinceSec: startOfLocalDaySec(Date.now()) - (authorRecentDays - 1) * (DAY_MS / 1000),
        nameByMid: authorNameByMid,
      }),
    [statsEvents, authorRecentDays, authorNameByMid],
  );

  /**
   * 时段分布与「最爱时段」都用**当前所选时间窗口内**的事件。
   *
   * 之前它们吃的是全量已加载事件（最多一年），于是切换「近 7 天 / 近 30 天」时段图纹丝不动——
   * 上面选了窗口、下面却是另一段时间的数据，属于口径不一致。
   */
  const windowStatsEvents = useMemo(() => {
    const toSec = Math.floor(Date.now() / 1000);
    return filterEventsInRange(statsEvents, toSec - viewWindowDays * (DAY_MS / 1000), toSec);
  }, [statsEvents, viewWindowDays]);

  /** 时段分布：24 小时，每小时一根柱子 */
  const hourSlots = useMemo(() => buildHourHistogram(windowStatsEvents), [windowStatsEvents]);
  const hourAxisLabels = useMemo(() => buildHourAxisLabels(), []);

  const peakDay = useMemo(() => findPeakDay(dailySeries), [dailySeries]);

  const peakHour = useMemo(
    () => findPeakHourWindow(buildHourHistogram(windowStatsEvents), 2),
    [windowStatsEvents],
  );

  const reportAvailability = useMemo(
    () => buildReportAvailability(recordStartedAt, Date.now()),
    [recordStartedAt],
  );

  const activeReport = useMemo(
    () =>
      reportKind
        ? buildHistoryReport(statsEvents, reportKind, Date.now(), { nameByMid: authorNameByMid })
        : null,
    [reportKind, statsEvents, authorNameByMid],
  );

  /**
   * 报告周期内的关注变动（新增 / 取关 / 改名 / 注销）。
   *
   * 口径与报告一致：都是"自然周期起点 → 现在"。数据来自 followingEvents，
   * 也就是插件观测到的事件；建立基线之前的变动无从回溯，这点在弹窗里写清楚。
   */
  const activeReportFollowing = useMemo((): EventTypeTotals | null => {
    if (!reportKind) return null;
    const fromMs = resolvePeriodStartMs(reportKind, Date.now());
    const toMs = Date.now();
    return summarizeEventTypes(
      events.filter((event) => event.occurred_at >= fromMs && event.occurred_at <= toMs),
    );
  }, [reportKind, events]);

  /** 覆盖天数不够的报告不出现按钮，避免生成一份看不出东西的报告 */
  const availableReportKinds = useMemo(
    () => REPORT_KINDS.filter((kind) => reportAvailability.available[kind]),
    [reportAvailability],
  );

  const followingStats = useMemo(() => buildFollowingStats(following), [following]);

  const series = useMemo(
    () => buildDailyChangeSeries(events, rangeDays, Date.now()),
    [events, rangeDays],
  );

  const windowEventCount = useMemo(
    () => series.reduce((sum, point) => sum + point.total, 0),
    [series],
  );

  /**
   * 「最近变动」面板：只取最近 `CHANGE_PREVIEW_SIZE` 条做预览。
   *
   * 面板**不再**承担筛选与翻页——那两件事收在「查看更多」的弹窗里。
   * 面板的职责只是"扫一眼最近发生了什么"，把筛选 chip 和加载更多塞进来
   * 会让它变成一个小号的列表页，而它本来只有半栏宽。
   */
  const changePreviewEvents = useMemo(
    () => buildRecentEvents(events, CHANGE_PREVIEW_SIZE),
    [events],
  );
  /** 事件只带 mid，明细弹窗需要 `following` 快照里的完整档案 */
  const followingByMid = useMemo(
    () => new Map(following.map((entry) => [entry.mid, entry])),
    [following],
  );
  const recordStartDay = useMemo(() => earliestEventDay(events), [events]);

  const nextRunAt = lastSyncAt ? lastSyncAt + intervalMinutes * 60 * 1000 : null;

  /**
   * 正在归档的任务及其进度。
   *
   * `done` 取**库里的实际张数**而不是任务的累加计数——前者是事实，随落库实时变化；
   * 后者只在每 20 条写进度时才跳一次。
   */
  /** 收藏封面 + 合集封面的待归档总数。两者占用同一个 assets 的 cover 类型 */
  const coverArchivePending =
    (coverArchiveProgress?.remaining ?? 0) + (collectionCoverArchiveProgress?.remaining ?? 0);

  const runningArchiveTasks = (() => {
    const tasks: Array<{ label: string; done: number; total: number }> = [];
    if (archiveProgress && archiveProgress.status !== "completed" && archiveProgress.remaining > 0) {
      tasks.push({
        label: "头像",
        done: avatarAssetCount,
        total: avatarAssetCount + archiveProgress.remaining,
      });
    }
    if (coverArchivePending > 0) {
      tasks.push({
        label: "封面",
        done: coverAssetCount,
        total: coverAssetCount + coverArchivePending,
      });
    }
    return tasks;
  })();

  return (
    <div className="h-screen overflow-y-auto">
      <div className="mx-auto max-w-[1500px] px-6 py-5 lg:px-10">
        <div className="mb-6 flex flex-col justify-between gap-4 rounded-xl border border-gray-100 bg-white p-4 shadow-sm md:flex-row md:items-center dark:border-neutral-800 dark:bg-neutral-900">
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900 dark:text-neutral-100">
            <LayoutDashboard className="h-5 w-5 text-pink-500" />
            总览
          </h1>
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-full border border-gray-100 bg-gray-50 px-2 py-1 text-sm font-normal text-gray-500 dark:border-neutral-700 dark:bg-neutral-800 dark:text-neutral-400">
              {lastSyncAt ? `上次同步 ${formatDateTime(lastSyncAt)}` : "尚未同步过"}
            </span>
            <button
              type="button"
              onClick={handleSync}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 rounded-full bg-pink-500 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-pink-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} />
              {syncing ? "同步中…" : "立即同步"}
            </button>
          </div>
        </div>

        {loading ? (
          <div className="py-20 text-center text-sm text-gray-400 dark:text-neutral-500">加载中…</div>
        ) : (
          <div className="space-y-5">
            {/* A. 跨模块指标 */}
            <div className="flex flex-wrap gap-3">
              {kpis.map((metric) => (
                <div
                  key={metric.key}
                  className="min-w-[8.5rem] max-w-[15rem] flex-1 rounded-xl border border-gray-100 bg-white px-4 py-3 shadow-sm dark:border-neutral-800 dark:bg-neutral-900"
                >
                  <p className="text-xs text-gray-500 dark:text-neutral-400">{metric.label}</p>
                  <p className="mt-1 text-xl font-semibold tabular-nums text-gray-900 dark:text-neutral-100">
                    {metric.value}
                  </p>
                </div>
              ))}
            </div>

            {/* 观看记录统计：回答"我看了什么"，报告按记录覆盖天数门控 */}
            <Panel
              title="观看记录统计"
              hint={
                !recordStartedAt
                  ? "还没有观看记录"
                  : realtimeSince && recordStartedAt < realtimeSince - DAY_MS / 1000
                    ? `实时记录自 ${formatRecordStart(realtimeSince)}（更早为历史快照）`
                    : `记录自 ${formatRecordStart(recordStartedAt)}`
              }
            >
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {[
                  { label: "今天", value: viewSummary.todayVideos },
                  { label: "本周", value: viewSummary.weekVideos },
                  { label: "本月", value: viewSummary.monthVideos },
                  { label: "本年", value: viewSummary.yearVideos },
                ].map((item) => (
                  <div key={item.label}>
                    <p className="text-xs text-gray-500 dark:text-neutral-400">{item.label}</p>
                    <p className="mt-0.5 text-lg font-semibold tabular-nums text-gray-900 dark:text-neutral-100">
                      {item.value}
                    </p>
                  </div>
                ))}
              </div>

              <p className="mt-2 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
                「视频」是去重后的数量，同一视频当天看多次只算 1 个；「完整播放」是进度到达片尾
                （≥95% 或接口标记已看完）的次数，同一视频循环播放会分别计数。
                两者都只统计视频 / 番剧 / 课程，不含直播与文章。
                计数来自插件的定时观测：扩展没在运行时的观看看不到，循环短于同步间隔时可能漏采，
                所以完整播放次数是下限。
              </p>

              <div className="mt-4 flex flex-wrap items-center gap-2">
                {VIEW_WINDOW_OPTIONS.map((option) => (
                  <button
                    key={option.days}
                    type="button"
                    onClick={() => setViewWindowDays(option.days)}
                    className={`rounded-full px-3 py-1 text-sm transition-colors ${
                      viewWindowDays === option.days
                        ? "bg-pink-50 font-medium text-pink-600 dark:bg-pink-500/10 dark:text-pink-400"
                        : "text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
                {/* 画法切换：柱状看单日高低、折线看走向、热力图看长期规律 */}
                <span className="ml-auto flex items-center gap-1">
                  {TREND_CHARTS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setTrendChart(option.value)}
                      className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${
                        trendChart === option.value
                          ? "bg-pink-50 font-medium text-pink-600 dark:bg-pink-500/10 dark:text-pink-400"
                          : "text-gray-400 hover:bg-gray-100 dark:text-neutral-500 dark:hover:bg-neutral-800"
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </span>
              </div>

              <p className="mb-2 text-xs text-gray-400 dark:text-neutral-500">
                窗口内：活跃 {windowSummary.activeDays} 天 · 视频 {windowSummary.uniqueContents} 个 ·
                完整播放 {windowSummary.completedPlays} 次 · 单日最高{" "}
                {peakDay ? `${formatDayLabel(peakDay.day)} · ${peakDay.uniqueContents} 个视频` : "—"}
                {trendChart === "heatmap" && viewWindowDays < 90
                  ? "（热力图更适合「近 90 天」或「近一年」）"
                  : ""}
              </p>

              <div className="mt-3">
                {trendChart === "bar" ? <DailyViewChart points={dailySeries} /> : null}
                {trendChart === "line" ? <DailyViewLineChart points={dailySeries} /> : null}
                {trendChart === "heatmap" ? <DailyViewHeatmap points={dailySeries} /> : null}
              </div>

              {/* 「最爱时段」不再单独占一张卡片：它就是这张分布图上的最高点，
                  并成一行显示（右对齐的小结），整块图才能占满整行、24 根柱子全部显示出来。 */}
              <div className="mt-4 rounded-xl border border-gray-100 p-4 dark:border-neutral-800">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  {/* 用不同视频数：按记录会被长视频带偏。
                      不再画"星期分布"——周几看得多对回顾没有指导意义，"几点看得多"才有。 */}
                  <p className="text-sm font-medium text-gray-700 dark:text-neutral-200">
                    时段分布（个视频）
                    <span className="ml-2 text-xs font-normal text-gray-400 dark:text-neutral-500">
                      近 {viewWindowDays} 天
                    </span>
                  </p>
                  <p className="text-xs text-gray-500 dark:text-neutral-400">
                    最爱时段{" "}
                    <span className="font-semibold text-gray-900 dark:text-neutral-100">
                      {formatHourWindow(peakHour)}
                    </span>
                    {peakHour ? ` · 窗口内共 ${peakHour.views} 个视频` : " · 窗口内还没有记录"}
                  </p>
                </div>
                <HourSlotChart values={hourSlots} labels={hourAxisLabels} />
              </div>

              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-gray-700 dark:text-neutral-200">
                      最近在看的 UP 主
                    </p>
                    <span className="ml-auto flex gap-1">
                      {AUTHOR_RECENT_OPTIONS.map((option) => (
                        <button
                          key={option.days}
                          type="button"
                          onClick={() => setAuthorRecentDays(option.days)}
                          className={`rounded-full px-2.5 py-0.5 text-xs transition-colors ${
                            authorRecentDays === option.days
                              ? "bg-pink-50 font-medium text-pink-600 dark:bg-pink-500/10 dark:text-pink-400"
                              : "text-gray-400 hover:bg-gray-100 dark:text-neutral-500 dark:hover:bg-neutral-800"
                          }`}
                        >
                          {option.label}
                        </button>
                      ))}
                    </span>
                  </div>
                  <ul className="space-y-2">
                    {topAuthors.map((author) => (
                      <li
                        key={author.mid}
                        className="flex items-center gap-2 text-sm"
                        title={`UID ${author.mid} · 最近 ${authorRecentDays} 天看了 ${author.recentVideos} 个视频 · 近一年共 ${author.uniqueContents} 个 · 完整播放 ${author.completedPlays} 次${
                          author.lastViewedAt
                            ? ` · 最近一次 ${formatDayLabel(toDayKey(author.lastViewedAt))}`
                            : ""
                        }`}
                      >
                        <a
                          href={`https://space.bilibili.com/${author.mid}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="min-w-0 flex-1 truncate text-gray-700 hover:text-pink-600 dark:text-neutral-200 dark:hover:text-pink-400"
                          title={author.name}
                        >
                          {author.name}
                        </a>
                        <span className="shrink-0 rounded-full bg-pink-50 px-2 py-0.5 text-xs text-pink-600 dark:bg-pink-500/10 dark:text-pink-400">
                          {author.recentVideos} 个视频
                        </span>
                      </li>
                    ))}
                    {topAuthors.length === 0 ? (
                      <li className="text-sm text-gray-400 dark:text-neutral-500">
                        窗口内还没有记录
                      </li>
                    ) : null}
                  </ul>
                </div>

                <div>
                  <p className="mb-2 text-sm font-medium text-gray-700 dark:text-neutral-200">
                    观看报告
                  </p>
                  {availableReportKinds.length > 0 ? (
                    <>
                      <div className="flex flex-wrap gap-2">
                        {availableReportKinds.map((kind) => (
                          <button
                            key={kind}
                            type="button"
                            onClick={() => setReportKind(kind)}
                            className="inline-flex items-center gap-1.5 rounded-full border border-gray-200 px-3.5 py-1.5 text-sm text-gray-600 transition-colors hover:border-pink-300 hover:text-pink-500 dark:border-neutral-700 dark:text-neutral-300 dark:hover:text-pink-400"
                          >
                            <FileText className="h-3.5 w-3.5" />
                            生成{REPORT_KIND_LABEL[kind]}
                          </button>
                        ))}
                      </div>
                      <p className="mt-2 text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
                        已记录 {reportAvailability.coverageDays} 天，报告按自然周期统计。
                      </p>
                    </>
                  ) : (
                    <p className="text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
                      已记录 {reportAvailability.coverageDays} 天。周报需要满{" "}
                      {REQUIRED_COVERAGE_DAYS.week} 天、月报满 {REQUIRED_COVERAGE_DAYS.month}{" "}
                      天、年报满 {REQUIRED_COVERAGE_DAYS.year}{" "}
                      天才会出现生成按钮——天数不够时不给一份看不出东西的报告。
                    </p>
                  )}
                </div>
              </div>
            </Panel>

            {/* 两块"构成"面板并排等宽。
                「变动构成」已删除：它和下面的「每日变动趋势」是同一份数据的两种画法，
                而且窗口内往往只有一两种变动，剩下几段恒为 0，等于没信息。 */}
            <div className="grid gap-5 lg:grid-cols-2">
              {/* B. 关注构成 */}
              <Panel title="关注构成" hint={`共 ${followingStats.total} 位`}>
                <ProportionBar
                  segments={[
                    { label: "仍关注", value: followingStats.following, color: "#22c55e" },
                    { label: "已取关", value: followingStats.unfollowed, color: "#f59e0b" },
                    { label: "已注销", value: followingStats.gone, color: "#94a3b8" },
                  ]}
                />
              </Panel>

              {/* B2. 互动记录构成（点赞 / 投币） */}
              <Panel
                title="互动记录构成"
                hint={`共 ${interactionStats.total} 条（${INTERACTION_TYPE_LABEL.like} ${interactionStats.like} / ${INTERACTION_TYPE_LABEL.coin} ${interactionStats.coin}）`}
              >
                {interactionStats.total === 0 ? (
                  <div className="rounded-lg border border-dashed border-gray-200 py-8 text-center text-sm text-gray-400 dark:border-neutral-700 dark:text-neutral-500">
                    <p>还没有点赞 / 投币记录。</p>
                    <p className="mt-2">去「互动记录」页同步一次就能开始本地留存。</p>
                  </div>
                ) : (
                  <>
                    {/* 主体按**类型**拆：点赞与投币是两条独立记录，颜色分开才看得出各自的量。
                        状态不再单独画一条比例条——绝大多数时候它是"全绿"，一条 100% 的单色条
                        没信息量（这也是「变动构成」被删掉的原因），改成下面的圆点小结。 */}
                    <ProportionBar
                      segments={[
                        {
                          label: INTERACTION_TYPE_LABEL.like,
                          value: interactionStats.like,
                          color: "#ec4899",
                        },
                        {
                          label: INTERACTION_TYPE_LABEL.coin,
                          value: interactionStats.coin,
                          color: "#f59e0b",
                        },
                      ]}
                    />

                  </>
                )}
              </Panel>
            </div>

            {/* C. 每日变动趋势 */}
            <Panel
              title="每日变动趋势"
              hint={windowEventCount > 0 ? `窗口内 ${windowEventCount} 条` : undefined}
            >
              <div className="mb-3 flex flex-wrap items-center gap-2">
                {RANGES.map((range) => (
                  <button
                    key={range.days}
                    type="button"
                    onClick={() => setRangeDays(range.days)}
                    className={`rounded-full px-3 py-1 text-sm transition-colors ${
                      rangeDays === range.days
                        ? "bg-pink-50 font-medium text-pink-600 dark:bg-pink-500/10 dark:text-pink-400"
                        : "text-gray-500 hover:bg-gray-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
                    }`}
                  >
                    {range.label}
                  </button>
                ))}
                <span className="ml-auto flex flex-wrap gap-3">
                  {STACK_ORDER.map((key) => (
                    <span
                      key={key}
                      className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-neutral-400"
                    >
                      <span
                        className="h-2 w-2 rounded-full"
                        style={{ backgroundColor: CHANGE_TYPE_COLOR[STACK_TYPE[key]] }}
                      />
                      {CHANGE_TYPE_LABEL[STACK_TYPE[key]]}
                    </span>
                  ))}
                </span>
              </div>

              {events.length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-200 py-10 text-center text-sm text-gray-400 dark:border-neutral-700 dark:text-neutral-500">
                  <p>还没有任何变动记录。</p>
                  <p className="mt-2">
                    {hasBaseline
                      ? `基线建立于 ${recordStartDay ?? "首次同步"}，趋势随每日同步累积。`
                      : "完成一次完整同步后开始建立基线，从第二次同步起产生变动记录。"}
                  </p>
                </div>
              ) : (
                <>
                  <DailyChangeChart points={series} />
                  {windowEventCount === 0 ? (
                    <p className="mt-2 text-center text-xs text-gray-400 dark:text-neutral-500">
                      所选时间窗口内没有变动
                    </p>
                  ) : null}
                  <p className="mt-2 text-xs text-gray-400 dark:text-neutral-500">
                    记录自 {recordStartDay ?? "首次同步"}。B 站不提供取关 / 改名的历史，
                    因此趋势只能从建立基线之后开始，无法回溯更早的变动。
                  </p>
                </>
              )}
            </Panel>

            <div className="grid gap-5 lg:grid-cols-2">
              {/* 最近变动：面板只放最近几条预览，筛选与翻更多都在「查看更多」弹窗里 */}
              <Panel
                title="最近变动"
                hint={events.length === 0 ? undefined : `共 ${events.length} 条`}
                action={
                  events.length === 0 ? undefined : (
                    <button
                      type="button"
                      onClick={() => setChangeListOpen(true)}
                      className="rounded-full border border-gray-200 px-2.5 py-0.5 text-xs text-gray-600 transition-colors hover:border-pink-300 hover:text-pink-500 dark:border-neutral-700 dark:text-neutral-300 dark:hover:border-pink-500/50 dark:hover:text-pink-400"
                    >
                      查看更多
                    </button>
                  )
                }
              >
                {events.length === 0 ? (
                  <p className="py-4 text-center text-sm text-gray-400 dark:text-neutral-500">
                    还没有变动记录
                  </p>
                ) : (
                  <ul className="space-y-1">
                    {changePreviewEvents.map((event) => (
                      <li key={event.event_id}>
                        <button
                          type="button"
                          onClick={() => setActiveChangeEvent(event)}
                          title="查看这次变动的明细"
                          className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm transition-colors hover:bg-gray-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 dark:hover:bg-neutral-800/70"
                        >
                          <span
                            className="shrink-0 rounded px-1.5 py-0.5 text-xs text-white"
                            style={{ backgroundColor: CHANGE_TYPE_COLOR[event.type] }}
                          >
                            {CHANGE_TYPE_LABEL[event.type]}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-gray-700 dark:text-neutral-200">
                            {event.previous_name && event.type === "renamed"
                              ? `${event.previous_name} → ${event.name}`
                              : event.name || `UID ${event.mid}`}
                          </span>
                          <span className="shrink-0 text-xs text-gray-400 dark:text-neutral-500">
                            {formatRelativeDay(event.day)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              {/* F. 数据健康度 */}
              <Panel title="数据健康度">
                <dl className="space-y-2 text-sm">
                  {[
                    {
                      label: "首次基线",
                      value: hasBaseline ? "已建立" : "未建立",
                    },
                    {
                      label: "上次同步",
                      value: formatDateTime(lastSyncAt ?? undefined),
                    },
                    {
                      label: "同步间隔",
                      value:
                        intervalMinutes >= 60
                          ? `${Math.round(intervalMinutes / 60)} 小时`
                          : `${intervalMinutes} 分钟`,
                    },
                    {
                      label: "下次同步",
                      value: formatDateTime(nextRunAt ?? undefined),
                    },
                    {
                      label: "头像归档",
                      value:
                        archiveProgress && archiveProgress.remaining > 0
                          ? `${avatarAssetCount} 张 · 待归档 ${archiveProgress.remaining}`
                          : `${avatarAssetCount} 张`,
                    },
                    {
                      label: "封面归档",
                      value:
                        coverArchivePending > 0
                          ? `${coverAssetCount} 张 · 待归档 ${coverArchivePending}`
                          : `${coverAssetCount} 张`,
                    },
                    { label: "图片合计", value: `${assetCount} 张` },
                  ].map((row) => (
                    <div key={row.label} className="flex items-center justify-between gap-3">
                      <dt className="text-gray-500 dark:text-neutral-400">{row.label}</dt>
                      <dd className="tabular-nums text-gray-700 dark:text-neutral-200">{row.value}</dd>
                    </div>
                  ))}
                </dl>

                {/* 归档进度。任务每 20 条写一次进度、面板订阅存储变化，
                    所以这里的数字会实时跳动，不是静止的等待。 */}
                {runningArchiveTasks.length > 0 ? (
                  <div className="mt-3 space-y-2.5 border-t border-gray-100 pt-3 dark:border-neutral-800">
                    {runningArchiveTasks.map((task) => {
                      const percent =
                        task.total > 0
                          ? Math.min(100, Math.round((task.done / task.total) * 100))
                          : 0;
                      return (
                        <div key={task.label}>
                          <div className="flex items-center justify-between text-xs text-gray-500 dark:text-neutral-400">
                            <span className="flex items-center gap-1.5">
                              <RefreshCw className="h-3 w-3 animate-spin" />
                              {task.label}归档中…
                            </span>
                            <span className="tabular-nums">
                              {task.done} / {task.total}（{percent}%）
                            </span>
                          </div>
                          <div className="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-neutral-800">
                            <div
                              className="h-full rounded-full bg-pink-500 transition-all duration-300"
                              style={{ width: `${percent}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : null}

                <div className="mt-3 flex items-center justify-between gap-3 border-t border-gray-100 pt-3 dark:border-neutral-800">
                  <p className="text-xs leading-relaxed text-gray-400 dark:text-neutral-500">
                    图片字节只存本地，不参与备份。
                    <br />
                    内容被删或被替换封面后，归档的字节是唯一还能看到原图的办法。
                  </p>
                  <button
                    type="button"
                    onClick={handleArchive}
                    disabled={archiving}
                    className="shrink-0 rounded-full border border-gray-200 px-3 py-1 text-xs text-gray-600 transition-colors hover:border-pink-300 hover:text-pink-500 disabled:cursor-not-allowed disabled:opacity-50 dark:border-neutral-700 dark:text-neutral-300 dark:hover:text-pink-400"
                  >
                    {archiving ? "归档中…" : "立即归档图片"}
                  </button>
                </div>
                {progress?.lastError ? (
                  <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-600 dark:bg-amber-500/10 dark:text-amber-400">
                    上次同步出错：{progress.lastError}
                  </p>
                ) : null}
              </Panel>
            </div>
          </div>
        )}
      </div>
      {activeReport ? (
        <HistoryReportModal
          report={activeReport}
          following={activeReportFollowing}
          onClose={() => setReportKind(null)}
        />
      ) : null}

      <FollowingChangeListModal
        open={changeListOpen}
        events={events}
        onClose={() => {
          setChangeListOpen(false);
          setActiveChangeEvent(null);
        }}
        onSelectEvent={(event) => setActiveChangeEvent(event)}
      />

      <FollowingChangeDetailModal
        open={activeChangeEvent !== null}
        event={activeChangeEvent}
        item={activeChangeEvent ? (followingByMid.get(activeChangeEvent.mid) ?? null) : null}
        onClose={() => setActiveChangeEvent(null)}
      />
    </div>
  );
};

export default Dashboard;
