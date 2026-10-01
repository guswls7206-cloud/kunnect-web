"use client";

import { useMemo } from "react";
import { Field, inputClass } from "@/components/ui/field";
import { useLocations } from "@/features/meta/queries";
import { ETC_BUILDING_ID, LOCATION_TEXT_MAX } from "@/lib/api/types";

interface LocationPickerProps {
  value: number | null;
  /** isEtc: 고른 위치가 "기타"인지(장소 직접 입력이 필요한지) */
  onChange: (locationId: number | null, isEtc: boolean) => void;
  error?: string;
  label: string;
  /** "기타"일 때 직접 입력하는 장소 */
  locationText: string;
  onLocationTextChange: (text: string) => void;
  locationTextError?: string;
}

/**
 * 목록 우선 위치 선택: 건물 → (층이 여러 개면) 층.
 * 지도 핀은 지도 SDK 확정 전이라 넣지 않았다. 나중에 같은 locationId 를 돌려주는 지도 어댑터를 붙일 수 있다.
 */
export function LocationPicker({
  value,
  onChange,
  error,
  label,
  locationText,
  onLocationTextChange,
  locationTextError,
}: LocationPickerProps) {
  const { data: locations, isPending, isError } = useLocations();

  const groups = useMemo(() => {
    const map = new Map<string, NonNullable<typeof locations>>();
    locations?.forEach((l) => map.set(l.buildingId, [...(map.get(l.buildingId) ?? []), l]));
    return map;
  }, [locations]);

  const selected = locations?.find((l) => l.id === value) ?? null;
  const building = selected?.buildingId ?? "";
  const floors = building ? (groups.get(building) ?? []) : [];

  return (
    <div className="flex flex-col gap-3">
      <Field label={label} error={error} required>
        {(p) => (
          <select
            {...p}
            value={building}
            disabled={isPending || isError}
            onChange={(e) => {
              const first = groups.get(e.target.value)?.[0];
              const isEtc = e.target.value === ETC_BUILDING_ID;
              // 기타가 아닌 곳으로 바꾸면 직접 입력한 장소는 지운다(서버는 기타에서만 받는다).
              if (!isEtc && locationText) onLocationTextChange("");
              onChange(first ? first.id : null, isEtc);
            }}
            className={inputClass}
          >
            <option value="">
              {isPending ? "불러오는 중…" : isError ? "위치를 불러오지 못했어요" : "건물 선택"}
            </option>
            {[...groups.entries()].map(([id, list]) => (
              <option key={id} value={id}>
                {list[0].buildingName}
              </option>
            ))}
          </select>
        )}
      </Field>

      {floors.length > 1 && (
        <Field label="층">
          {(p) => (
            <select
              {...p}
              value={value ?? ""}
              onChange={(e) => onChange(Number(e.target.value), building === ETC_BUILDING_ID)}
              className={inputClass}
            >
              {floors.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.floor ? `${l.floor}층` : "층 모름 / 건물 전체"}
                </option>
              ))}
            </select>
          )}
        </Field>
      )}

      {building === ETC_BUILDING_ID && (
        <Field label="장소" error={locationTextError} hint="예: 체육관 앞 벤치" required>
          {(p) => (
            <input
              {...p}
              value={locationText}
              onChange={(e) => onLocationTextChange(e.target.value)}
              maxLength={LOCATION_TEXT_MAX}
              placeholder="장소를 직접 입력해 주세요"
              className={inputClass}
            />
          )}
        </Field>
      )}
    </div>
  );
}
