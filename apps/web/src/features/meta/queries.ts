"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/endpoints";

// 위치·프리셋 태그는 거의 바뀌지 않으므로 세션 동안 캐시한다.
export function useLocations() {
  return useQuery({
    queryKey: ["meta", "locations"],
    queryFn: async () => (await api.meta.locations()).items,
    staleTime: Infinity,
  });
}

export function usePresetTags() {
  return useQuery({
    queryKey: ["meta", "preset-tags"],
    queryFn: async () => (await api.meta.presetTags()).items,
    staleTime: Infinity,
  });
}
