import React, { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, ChevronLeft, ChevronRight, Calendar as CalendarIcon, X } from "lucide-react";
import dayjs from "dayjs";

interface DateRangePickerProps {
  startDate: string;
  endDate: string;
  onChange: (start: string, end: string) => void;
  /** 内联显示日历，用于空间足够、但会被父级 overflow 裁切弹层的场景。 */
  inline?: boolean;
  /** 以居中弹层显示日历，适合放在本身已经是弹窗、又不能再被裁切的场景。 */
  dialog?: boolean;
}

export const DateRangePicker: React.FC<DateRangePickerProps> = ({
  startDate,
  endDate,
  onChange,
  inline = false,
  dialog = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [currentMonth, setCurrentMonth] = useState(dayjs());
  const [yearOpen, setYearOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const currentYear = dayjs().year();
  const minYear = 2009;
  const maxYear = currentYear + 1;
  const yearOptions = Array.from({ length: maxYear - minYear + 1 }, (_, i) => maxYear - i);

  // Sync current month with selected start date if getting open
  useEffect(() => {
    if (isOpen && startDate) {
      setCurrentMonth(dayjs(startDate));
    }
  }, [isOpen]);

  useEffect(() => {
    if (inline || dialog) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
        setYearOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [inline]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsOpen(false);
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isOpen]);

  /**
   * 日期选择只有一种交互：连点两天选出范围。
   *
   * 曾经有一个「单日选择」模式（点一下 = 起止同一天），已按评审删除：
   * 它并没有带来新能力——`matchDate` 里 `start === end` 与"只设起始日"
   * 的结果完全相同——却要求用户先切模式才能选一天，属于纯粹的额外成本。
   * 只想看某一天时，点那一天两次即可。
   */
  const handleDateClick = (dateStr: string) => {
    if (!startDate && !endDate) {
      onChange(dateStr, "");
    } else if (startDate && !endDate) {
      if (dateStr < startDate) {
        // Correct selection if user clicks earlier date
        onChange(dateStr, startDate);
        setIsOpen(false);
      } else {
        onChange(startDate, dateStr);
        setIsOpen(false);
      }
    } else {
      // Reset and start new selection
      onChange(dateStr, "");
    }
  };

  const nextMonth = () => setCurrentMonth(currentMonth.add(1, "month"));
  const prevMonth = () => setCurrentMonth(currentMonth.subtract(1, "month"));

  const monthOptions = Array.from({ length: 12 }, (_, i) => i);

  const generateDays = () => {
    const startOfMonth = currentMonth.startOf("month");
    const daysInMonth = startOfMonth.daysInMonth();
    const paddingDays = startOfMonth.day() === 0 ? 6 : startOfMonth.day() - 1; // Start Monday

    const days = [];
    for (let i = 0; i < paddingDays; i++) {
      days.push(null);
    }
    for (let i = 1; i <= daysInMonth; i++) {
      days.push(startOfMonth.date(i));
    }
    return days;
  };

  const days = generateDays();
  const weekDays = ["一", "二", "三", "四", "五", "六", "日"];

  const displayText = startDate
    ? endDate && startDate !== endDate
      ? `${startDate} ~ ${endDate}`
      : startDate
    : "";

  const calendarBody = (
    <>
      <div className="mb-2 flex items-center justify-between gap-2 pr-8">
        <div className="flex items-center gap-1">
          <div className="relative">
            <button
              type="button"
              onClick={() => setYearOpen((value) => !value)}
              aria-expanded={yearOpen}
              aria-haspopup="listbox"
              className="inline-flex h-8 items-center gap-0.5 rounded-md border border-gray-200 bg-white px-1.5 text-xs font-medium text-gray-700 transition-colors hover:border-pink-200 focus:outline-none focus:ring-2 focus:ring-pink-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:border-pink-500/40"
            >
              {currentMonth.year()}年
              <ChevronDown className="h-3 w-3 text-gray-400" />
            </button>
            {yearOpen && (
              <div
                role="listbox"
                aria-label="选择年份"
                className="absolute left-0 top-full z-30 mt-1 max-h-40 w-20 overflow-y-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-neutral-700 dark:bg-neutral-900"
              >
                {yearOptions.map((year) => (
                  <button
                    key={year}
                    type="button"
                    role="option"
                    aria-selected={currentMonth.year() === year}
                    onClick={() => {
                      setCurrentMonth(currentMonth.year(year));
                      setYearOpen(false);
                    }}
                    className={`flex w-full items-center justify-center px-2 py-1.5 text-xs transition-colors ${
                      currentMonth.year() === year
                        ? "bg-pink-500 font-medium text-white"
                        : "text-gray-600 hover:bg-pink-50 dark:text-neutral-300 dark:hover:bg-neutral-800"
                    }`}
                  >
                    {year}年
                  </button>
                ))}
              </div>
            )}
          </div>
          <select
            value={currentMonth.month()}
            onChange={(event) => setCurrentMonth(currentMonth.month(Number(event.target.value)))}
            aria-label="选择月份"
            className="h-8 rounded-md border border-gray-200 bg-white px-1.5 text-xs font-medium text-gray-700 focus:outline-none focus:ring-2 focus:ring-pink-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
          >
            {monthOptions.map((month) => (
              <option key={month} value={month}>
                {month + 1}月
              </option>
            ))}
          </select>
        </div>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={prevMonth}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
            aria-label="上个月"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={nextMonth}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-white"
            aria-label="下个月"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="mb-1.5 grid grid-cols-7">
        {weekDays.map((d) => (
          <div key={d} className="py-0.5 text-center text-[11px] text-gray-400 dark:text-neutral-500">
            {d}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {days.map((date, idx) => {
          if (!date) return <div key={idx} />;
          const dateStr = date.format("YYYY-MM-DD");
          const isSelected =
            startDate === dateStr ||
            endDate === dateStr ||
            (startDate && endDate && dateStr > startDate && dateStr < endDate);

          const isStart = startDate === dateStr;
          const isEnd = endDate === dateStr;
          const isInRange = startDate && endDate && dateStr > startDate && dateStr < endDate;

          let bgClass =
            "hover:bg-pink-50 dark:hover:bg-pink-500/10 text-gray-700 dark:text-neutral-200";
          if (isStart || isEnd) bgClass = "bg-pink-500 text-white hover:bg-pink-600";
          else if (isInRange)
            bgClass = "bg-pink-50 dark:bg-pink-500/15 text-pink-600 dark:text-pink-400";

          return (
            <button
              key={idx}
              type="button"
              onClick={() => handleDateClick(dateStr)}
              aria-label={date.format("YYYY年MM月DD日")}
              aria-pressed={Boolean(isSelected)}
              className={`
                flex h-6 items-center justify-center rounded-md text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500
                ${bgClass}
              `}
            >
              {date.date()}
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex justify-between border-t border-gray-200 pt-2 dark:border-neutral-800">
        <button
          type="button"
          onClick={() => {
            onChange("", "");
          }}
          className="rounded text-xs text-gray-600 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500 dark:text-neutral-400 dark:hover:text-red-300"
        >
          清除
        </button>
        <button
          type="button"
          onClick={() => {
            const today = dayjs().format("YYYY-MM-DD");
            onChange(today, today);
            setIsOpen(false);
          }}
          className="rounded text-xs font-medium text-pink-700 hover:text-pink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-pink-500 dark:text-pink-300 dark:hover:text-pink-200"
        >
          今天
        </button>
      </div>
    </>
  );

  if (inline) {
    return (
      <div
        ref={containerRef}
        className="mx-auto w-full max-w-[320px] rounded-xl border border-gray-200 bg-white p-2.5 shadow-sm dark:border-neutral-700 dark:bg-neutral-900"
      >
        {calendarBody}
      </div>
    );
  }

  const trigger = (
    <div className="group relative flex h-10 items-center rounded-lg border border-gray-200 bg-white transition-colors hover:border-pink-200 hover:bg-pink-50 focus-within:ring-2 focus-within:ring-pink-500 focus-within:ring-offset-2 dark:border-neutral-700 dark:bg-neutral-900 dark:hover:border-pink-500/40 dark:hover:bg-pink-500/10 dark:focus-within:ring-offset-[#0a0a0a]">
      <button
        type="button"
        className="flex h-full min-w-0 items-center gap-2 px-3 text-sm text-gray-700 focus-visible:outline-none dark:text-neutral-300"
        onClick={() => setIsOpen(!isOpen)}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        aria-label={displayText ? `已选日期：${displayText}` : "选择日期"}
      >
        <CalendarIcon className="h-4 w-4 shrink-0 text-gray-500 transition-colors group-hover:text-pink-600 dark:text-neutral-400 dark:group-hover:text-pink-300" />
        <span
          className={`max-w-[180px] truncate whitespace-nowrap ${
            displayText
              ? "text-gray-700 dark:text-neutral-200"
              : "text-gray-500 dark:text-neutral-500"
          }`}
        >
          {displayText || "选择日期"}
        </span>
      </button>
      {displayText && (
        <button
          type="button"
          onClick={() => {
            onChange("", "");
          }}
          className="flex h-full w-9 shrink-0 items-center justify-center rounded-r-lg text-gray-500 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-red-500 dark:text-neutral-400 dark:hover:bg-red-500/10 dark:hover:text-red-300"
          title="清除日期"
          aria-label="清除日期"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );

  return (
    <div className="relative" ref={containerRef}>
      {trigger}

      {isOpen && dialog
        ? createPortal(
            <div
              className="fixed inset-0 z-[120] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[1px]"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setIsOpen(false);
              }}
            >
              <div
                className="relative w-full max-w-[340px] select-none rounded-2xl border border-gray-200 bg-white p-4 shadow-2xl dark:border-neutral-700 dark:bg-neutral-900"
                role="dialog"
                aria-label="选择历史记录日期"
              >
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  aria-label="关闭日期选择"
                  className="absolute right-3 top-3 z-10 inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 dark:text-neutral-500 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
                <div className="pt-1">{calendarBody}</div>
              </div>
            </div>,
            document.body,
          )
        : isOpen && (
            <div
              className="absolute right-0 top-full z-50 mt-2 w-[min(320px,calc(100vw-2rem))] select-none rounded-xl border border-gray-200 bg-white p-4 shadow-[0_14px_36px_rgba(15,23,42,0.16)] dark:border-neutral-700 dark:bg-neutral-900"
              role="dialog"
              aria-label="选择历史记录日期"
            >
              {calendarBody}
            </div>
          )}
    </div>
  );
};
