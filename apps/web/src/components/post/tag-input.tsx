"use client";

import { useState } from "react";
import { inputClass } from "@/components/ui/field";
import { usePresetTags } from "@/features/meta/queries";
import { normalizeTag } from "@/lib/tags";

export const MAX_TAGS = 8;

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  error?: string;
}

/** 프리셋 칩(토글) + 직접 입력(Enter/쉼표로 추가). 서버 정규화와 같은 규칙으로 미리 정리한다. */
export function TagInput({ value, onChange, error }: TagInputProps) {
  const { data: presets } = usePresetTags();
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  function toggle(name: string) {
    const tag = normalizeTag(name);
    if (value.includes(tag)) onChange(value.filter((t) => t !== tag));
    else add(tag);
  }

  function add(raw: string) {
    const tag = normalizeTag(raw);
    if (!tag || value.includes(tag)) return;
    if (value.length >= MAX_TAGS) {
      setNotice(`태그는 최대 ${MAX_TAGS}개까지 달 수 있어요.`);
      return;
    }
    setNotice(null);
    onChange([...value, tag]);
  }

  function addMany(raws: string[]) {
    const next = [...value];
    for (const raw of raws) {
      const tag = normalizeTag(raw);
      if (!tag || next.includes(tag)) continue;
      if (next.length >= MAX_TAGS) {
        setNotice(`태그는 최대 ${MAX_TAGS}개까지 달 수 있어요.`);
        break;
      }
      next.push(tag);
    }
    onChange(next);
  }

  function commitDraft() {
    if (draft.trim()) add(draft);
    setDraft("");
  }

  return (
    <div className="flex flex-col gap-2">
      <span id="tag-label" className="text-sm font-semibold text-zinc-800">
        태그 <span className="font-normal text-zinc-500">(최대 {MAX_TAGS}개)</span>
      </span>

      <ul aria-labelledby="tag-label" className="flex flex-wrap gap-1.5">
        {presets?.map((preset) => {
          const selected = value.includes(normalizeTag(preset.name));
          return (
            <li key={preset.id}>
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => toggle(preset.name)}
                className={`min-h-9 rounded-full border px-3.5 text-sm font-medium transition-[background-color,border-color,color] ${
                  selected
                    ? "border-brand-600 bg-brand-600 text-white shadow-sm"
                    : "border-zinc-300 bg-white text-zinc-700 hover:border-brand-400 hover:text-brand-700"
                }`}
              >
                {preset.name}
              </button>
            </li>
          );
        })}
      </ul>

      <input
        value={draft}
        onChange={(e) => {
          // 쉼표는 태그 구분자: 입력·붙여넣기 모두 쉼표 앞부분을 바로 태그로 확정하고 마지막 조각만 입력창에 남긴다.
          const parts = e.target.value.split(",");
          if (parts.length === 1) return setDraft(e.target.value);
          addMany(parts.slice(0, -1));
          setDraft(parts[parts.length - 1]);
        }}
        onKeyDown={(e) => {
          // 한글 조합 중 Enter 는 무시한다(IME).
          if (e.key === "Enter" && !e.nativeEvent.isComposing) {
            e.preventDefault();
            commitDraft();
          }
        }}
        onBlur={commitDraft}
        placeholder="직접 입력 후 Enter (예: 검정, 케이스)"
        aria-label="태그 직접 입력"
        maxLength={20}
        className={inputClass}
      />

      {value.length > 0 && (
        <ul aria-label="선택한 태그" className="flex flex-wrap gap-1.5">
          {value.map((tag) => (
            <li
              key={tag}
              className="flex items-center gap-1 rounded-full bg-brand-50 py-1 pr-1 pl-3 text-sm font-medium text-brand-700 ring-1 ring-brand-200 ring-inset"
            >
              #{tag}
              <button
                type="button"
                onClick={() => onChange(value.filter((t) => t !== tag))}
                aria-label={`태그 ${tag} 삭제`}
                className="flex h-7 w-7 items-center justify-center rounded-full hover:bg-brand-100"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {(error || notice) && (
        <p role="alert" className="text-xs text-red-700">
          {error ?? notice}
        </p>
      )}
    </div>
  );
}
