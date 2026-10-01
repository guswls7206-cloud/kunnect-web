import { expect, type Page } from "@playwright/test";

/**
 * 목 DB 는 페이지를 새로 불러올 때마다 시드 상태로 돌아가고, 로그인 세션만 탭의 sessionStorage 에 남는다.
 * 테스트마다 새 브라우저 컨텍스트가 만들어지므로 테스트끼리 상태가 섞이지 않는다.
 */
export const DEMO = { loginId: "demo_a", password: "demo1234" };

export const passwordInput = (page: Page) => page.getByLabel("비밀번호", { exact: true });
export const loginIdInput = (page: Page) => page.getByRole("textbox", { name: "아이디" });
export const loginButton = (page: Page) =>
  page.getByRole("button", { name: "로그인", exact: true });

export async function login(page: Page, { loginId, password } = DEMO) {
  await page.goto("/login");
  await loginIdInput(page).fill(loginId);
  await passwordInput(page).fill(password);
  await loginButton(page).click();
  await expect(page).toHaveURL("/");
}

/**
 * 전체 새로고침 없이(목 DB 유지) 앱 안에서 이동한다. page.goto 는 목 DB 를 시드로 되돌린다.
 */
export async function navigate(page: Page, path: string) {
  await page.evaluate(
    (p) =>
      (window as unknown as { next: { router: { push(p: string): void } } }).next.router.push(p),
    path,
  );
  await expect(page).toHaveURL(path);
}

/** 내 정보 → 로그아웃(앱 안 이동이라 목 DB 가 유지된다) */
export async function logout(page: Page) {
  await navigate(page, "/me");
  await page.getByRole("button", { name: "로그아웃" }).click();
  await expect(page).toHaveURL(/\/login/);
}

/** 로그인 화면에서 앱 안 이동으로 다른 계정에 로그인한다(목 DB 유지). */
export async function loginInPlace(page: Page, loginId: string, password = DEMO.password) {
  await expect(page).toHaveURL(/\/login/);
  await loginIdInput(page).fill(loginId);
  await passwordInput(page).fill(password);
  await loginButton(page).click();
  await expect(page).not.toHaveURL(/\/login/);
}
