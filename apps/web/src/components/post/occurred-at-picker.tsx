"use client";

import { useId, useMemo } from "react";
import { inputClass } from "@/components/ui/field";
import { toLocalInputValue } from "@/lib/format";

interface OccurredAtPickerProps {
  /** "분실 일시" / "습득 일시" */
  label: string;
  /** <input type="datetime-local"> 형식의 로컬 시각 "YYYY-MM-DDTHH:mm" */
  value: string;
  onChange: (value: string) => void;
  error?: string;
  /** 기준 시각(테스트용). 기본은 처음 그릴 때의 현재 시각 */
  now?: Date;
}

interface Preset {
  label: string;
  value: string;
}

/** 기준 시각에서 days 일 전 날짜의 hour:minute */
function atTime(now: Date, daysAgo: number, hour: number, minute = 0): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d;
}

/**
 * 빠른 선택 목록. 모두 지금 이전 시각이라 고를 수 없는 칩은 없다.
 * 어제·그저께는 시각을 정하기 어려워 정오(12:00)로 두고, 아래 시간 칸에서 고치게 한다.
 */
function buildPresets(now: Date): Preset[] {
  const list: Array<[string, Date]> = [
    ["방금 전", now],
    ["1시간 전", new Date(now.getTime() - 60 * 60 * 1000)],
    ["어제", atTime(now, 1, 12)],
    ["그저께", atTime(now, 2, 12)],
  ];
  return list.map(([label, date]) => ({ label, value: toLocalInputValue(date) }));
}

/**
 * 분실·습득 일시 선택: 자주 쓰는 시각은 칩 한 번으로, 그 밖에는 날짜·시간 칸으로 직접 고른다.
 * 값은 기존과 같은 "YYYY-MM-DDTHH:mm" 문자열 하나라 폼 스키마는 그대로다(미래 시각은 스키마가 거부).
 */
export function OccurredAtPicker({ label, value, onChange, error, now }: OccurredAtPickerProps) {
  const id = useId();
  // 처음 그릴 때의 시각을 기준으로 고정한다(렌더마다 칩 값이 바뀌지 않게).
  const base = useMemo(() => now ?? new Date(), [now]);
  const presets = useMemo(() => buildPresets(base), [base]);
  const maxValue = toLocalInputValue(base);
  const [maxDate, maxTime] = maxValue.split("T");
  const [date = "", time = ""] = value ? value.split("T") : [];
  const errorId = `${id}-error`;
  // 한쪽만 지워도 다른 칸 값은 남긴다("YYYY-MM-DDT" 같은 불완전한 값은 스키마가 "올바른 일시"로 거부).
  const combine = (d: string, t: string) => (d || t ? `${d}T${t}` : "");
  const describedBy = error ? errorId : undefined;

  return (
    <fieldset className="flex flex-col gap-2" aria-describedby={describedBy}>
      <legend className="mb-1.5 text-sm font-semibold text-zinc-800">
        {label}
        <span className="ml-0.5 text-red-700" aria-hidden="true">
          *
        </span>
      </legend>

      <div role="group" aria-label="빠른 선택" className="flex flex-wrap gap-1.5">
        {presets.map((preset) => {
          const selected = preset.value === value;
          return (
            <button
              key={preset.label}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange(preset.value)}
              className={`min-h-11 rounded-full border px-3.5 text-sm font-medium transition-[background-color,border-color,color] ${
                selected
                  ? "border-brand-600 bg-brand-600 text-white shadow-sm"
                  : "border-zinc-300 bg-white text-zinc-700 hover:border-brand-400 hover:text-brand-700"
              }`}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600">
          날짜
          <input
            type="date"
            value={date}
            max={maxDate}
            required
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy}
            // 날짜만 바꾸면 시간은 그대로 둔다(시간이 비어 있으면 정오).
            onChange={(e) =>
              onChange(combine(e.target.value, e.target.value ? time || "12:00" : time))
            }
            className={inputClass}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs font-medium text-zinc-600">
          시간
          <input
            type="time"
            value={time}
            step={600}
            // 오늘 날짜일 때만 지금 이후 시각을 막는다.
            max={date === maxDate ? maxTime : undefined}
            required
            aria-invalid={Boolean(error)}
            aria-describedby={describedBy}
            onChange={(e) =>
              onChange(combine(e.target.value ? date || maxDate : date, e.target.value))
            }
            className={inputClass}
          />
        </label>
      </div>

      {error && (
        <p id={errorId} role="alert" className="text-xs text-red-700">
          {error}
        </p>
      )}
    </fieldset>
  );
}
