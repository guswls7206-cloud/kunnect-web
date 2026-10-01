// zod/mini: 메서드 체인 대신 .check(...) 를 쓰는 경량 API(클래식 zod 전체·로캘 번들을 피한다).
import * as z from "zod/mini";
import { LOCATION_TEXT_MAX } from "@/lib/api/types";

// 한도는 백엔드 계약(5.3)과 같다: title ≤50, description ≤1000, tags ≤8(각 ≤20), storagePlace ≤100, hiddenFeatures ≤300.
const base = {
  title: z
    .string()
    .check(
      z.trim(),
      z.minLength(1, "제목을 입력해 주세요."),
      z.maxLength(50, "제목은 50자 이하로 입력해 주세요."),
    ),
  description: z
    .string()
    .check(
      z.trim(),
      z.minLength(1, "설명을 입력해 주세요."),
      z.maxLength(1000, "설명은 1000자 이하로 입력해 주세요."),
    ),
  tags: z
    .array(z.string().check(z.maxLength(20, "태그는 20자 이하로 입력해 주세요.")))
    .check(z.maxLength(8, "태그는 최대 8개입니다.")),
  storagePlace: z
    .string()
    .check(z.trim(), z.maxLength(100, "보관 장소는 100자 이하로 입력해 주세요.")),
  hiddenFeatures: z
    .string()
    .check(z.trim(), z.maxLength(300, "비공개 특징은 300자 이하로 입력해 주세요.")),
};

/**
 * 기타 위치의 직접 입력 장소(백엔드 계약: 1~50자, 기타에서만).
 * 선택한 위치가 기타인지는 목록(서버 id)을 알아야 해서 폼이 needsLocationText 로 알려 준다(전송하지 않음).
 */
const locationTextFields = {
  locationText: z.optional(
    z
      .string()
      .check(
        z.trim(),
        z.maxLength(LOCATION_TEXT_MAX, `장소는 ${LOCATION_TEXT_MAX}자 이하로 입력해 주세요.`),
      ),
  ),
  needsLocationText: z.optional(z.boolean()),
};

const requireLocationTextForEtc = z.superRefine<{
  locationText?: string;
  needsLocationText?: boolean;
}>((values, ctx) => {
  if (values.needsLocationText && !values.locationText) {
    ctx.addIssue({
      code: "custom",
      path: ["locationText"],
      message: "장소를 입력해 주세요.",
      input: values.locationText,
    });
  }
});

/** 습득 글은 현재 보관 장소가 필수 */
const requireStoragePlaceForFound = z.superRefine<{ type: "LOST" | "FOUND"; storagePlace: string }>(
  (values, ctx) => {
    if (values.type === "FOUND" && !values.storagePlace) {
      ctx.addIssue({
        code: "custom",
        path: ["storagePlace"],
        message: "현재 보관 장소를 입력해 주세요.",
        input: values.storagePlace,
      });
    }
  },
);

export const postCreateSchema = z
  .object({
    type: z.enum(["LOST", "FOUND"]),
    ...base,
    locationId: z
      .int({ error: "위치를 선택해 주세요." })
      .check(z.positive("위치를 선택해 주세요.")),
    ...locationTextFields,
    // <input type="datetime-local"> 값(로컬 시간)
    occurredAt: z.string().check(
      z.minLength(1, "일시를 입력해 주세요."),
      z.refine((v) => !Number.isNaN(Date.parse(v)), "올바른 일시를 입력해 주세요."),
      z.refine((v) => Date.parse(v) <= Date.now() + 60_000, "미래 시각은 입력할 수 없어요."),
    ),
  })
  .check(requireStoragePlaceForFound, requireLocationTextForEtc);

export type PostCreateValues = z.infer<typeof postCreateSchema>;

/** 수정 가능한 항목만(유형·위치·일시·사진은 수정 불가 — 계약 5.3) */
export const postEditSchema = z
  .object({ type: z.enum(["LOST", "FOUND"]), ...base, ...locationTextFields })
  .check(requireStoragePlaceForFound, requireLocationTextForEtc);

export type PostEditValues = z.infer<typeof postEditSchema>;
