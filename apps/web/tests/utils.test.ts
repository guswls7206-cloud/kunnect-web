import { describe, expect, it } from "vitest";
import { signupSchema } from "@/features/auth/schemas";
import { formatLocation, relativeTime, toLocalInputValue } from "@/lib/format";
import { normalizeTag } from "@/lib/tags";
import { safeNextPath } from "@/app/(auth)/login/login-form";

describe("safeNextPath", () => {
  it("같은 사이트 경로만 허용한다", () => {
    expect(safeNextPath("/posts/3")).toBe("/posts/3");
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath("https://evil.example")).toBe("/");
    expect(safeNextPath("//evil.example")).toBe("/");
  });
});

describe("signupSchema", () => {
  it("계약 규칙을 따른다", () => {
    expect(
      signupSchema.safeParse({ loginId: "abcd", password: "12345678", nickname: "닉네임" }).success,
    ).toBe(true);
    expect(
      signupSchema.safeParse({ loginId: "ABCD", password: "12345678", nickname: "닉네임" }).success,
    ).toBe(false);
    expect(
      signupSchema.safeParse({ loginId: "abc", password: "12345678", nickname: "닉네임" }).success,
    ).toBe(false);
    expect(
      signupSchema.safeParse({ loginId: "abcd", password: "1234567", nickname: "닉네임" }).success,
    ).toBe(false);
    expect(
      signupSchema.safeParse({ loginId: "abcd", password: "12345678", nickname: "가" }).success,
    ).toBe(false);
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-01T12:00:00Z");
  it("구간별 문구", () => {
    expect(relativeTime("2026-10-01T11:59:40Z", now)).toBe("방금 전");
    expect(relativeTime("2026-10-01T11:30:00Z", now)).toBe("30분 전");
    expect(relativeTime("2026-10-01T09:00:00Z", now)).toBe("3시간 전");
    expect(relativeTime("2026-09-29T12:00:00Z", now)).toBe("2일 전");
  });
});

describe("기타 유틸", () => {
  it("normalizeTag", () => {
    expect(normalizeTag(" Black Case ")).toBe("blackcase");
    expect(normalizeTag("가".repeat(30))).toHaveLength(20);
  });
  it("toLocalInputValue", () => {
    expect(toLocalInputValue(new Date(2026, 9, 1, 9, 5))).toBe("2026-10-01T09:05");
  });
});

describe("formatLocation", () => {
  it("기타 위치는 직접 입력한 장소를 붙인다", () => {
    expect(formatLocation("기타", "체육관 앞 벤치")).toBe("기타 · 체육관 앞 벤치");
    expect(formatLocation("학생회관", null)).toBe("학생회관");
  });
});
