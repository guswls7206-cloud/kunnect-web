/** 태그 이름 정규화: NFC, 공백 정리, 소문자, 최대 20자. 비어 있으면 null. */
export function normalizeTag(raw: string): string | null {
  const t = raw.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t || t.length > 20) return null;
  return t;
}

export function normalizeTags(raw: string[]): string[] {
  const out = new Set<string>();
  for (const r of raw) {
    const n = normalizeTag(r);
    if (n) out.add(n);
  }
  return [...out];
}
