// zod/mini: 메서드 체인 대신 .check(...) 를 쓰는 경량 API(클래식 zod 전체·로캘 번들을 피한다).
import * as z from "zod/mini";

// 규칙은 백엔드 계약(5.1)과 같다: loginId 4~20자 영소문자·숫자·_, password 8~64자, nickname 2~12자.
export const loginIdSchema = z
  .string()
  .check(z.regex(/^[a-z0-9_]{4,20}$/, "아이디는 영소문자·숫자·_ 4~20자로 입력해 주세요."));

export const loginSchema = z.object({
  loginId: z.string().check(z.minLength(1, "아이디를 입력해 주세요.")),
  password: z.string().check(z.minLength(1, "비밀번호를 입력해 주세요.")),
});

/** 로그인 화면 폼(아이디 저장 체크 포함) */
export const loginFormSchema = z.extend(loginSchema, { rememberId: z.boolean() });

export const signupSchema = z.object({
  loginId: loginIdSchema,
  password: z
    .string()
    .check(
      z.minLength(8, "비밀번호는 8자 이상이어야 합니다."),
      z.maxLength(64, "비밀번호는 64자 이하여야 합니다."),
    ),
  nickname: z
    .string()
    .check(
      z.trim(),
      z.minLength(2, "닉네임은 2자 이상이어야 합니다."),
      z.maxLength(12, "닉네임은 12자 이하여야 합니다."),
    ),
});

/** 설정 화면 비밀번호 변경 */
export const passwordChangeSchema = z
  .object({
    currentPassword: z.string().check(z.minLength(1, "현재 비밀번호를 입력해 주세요.")),
    newPassword: z
      .string()
      .check(
        z.minLength(8, "새 비밀번호는 8자 이상이어야 합니다."),
        z.maxLength(64, "새 비밀번호는 64자 이하여야 합니다."),
      ),
    confirm: z.string(),
  })
  .check(
    z.refine((v) => v.newPassword === v.confirm, {
      path: ["confirm"],
      message: "새 비밀번호가 서로 다릅니다.",
    }),
  );

export type LoginValues = z.infer<typeof loginSchema>;
export type LoginFormValues = z.infer<typeof loginFormSchema>;
export type SignupValues = z.infer<typeof signupSchema>;
export type PasswordChangeValues = z.infer<typeof passwordChangeSchema>;
