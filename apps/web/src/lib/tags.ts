/** 서버 정규화(공백 제거, NFC, 소문자, 최대 20자)와 같은 규칙으로 미리 정리해 중복·길이 오류를 줄인다. */
export function normalizeTag(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, "").toLowerCase().slice(0, 20);
}
