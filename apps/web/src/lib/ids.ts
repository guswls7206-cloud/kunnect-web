/**
 * 주소의 [id] 조각을 양의 정수 id 로 바꾼다. "abc"·"1.5"·"0"·"-1"·"01"·빈 값처럼 올바른 id 가 아니면 null.
 * null 이면 화면은 조회 없이 바로 "찾을 수 없음"을 보여 준다(조회가 비활성으로 남아 로딩만 계속되는 것을 막는다).
 */
export function parsePositiveIntId(raw: string | string[] | undefined): number | null {
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}
