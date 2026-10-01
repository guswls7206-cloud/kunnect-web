import { expect, test } from "@playwright/test";
import { DEMO, login, loginButton, loginIdInput, passwordInput } from "./helpers";

test.describe("로그인", () => {
  test("데모 계정으로 로그인하면 메인으로 이동한다", async ({ page }) => {
    await login(page);
    await expect(page.getByRole("navigation", { name: /메뉴/ }).first()).toBeVisible();
  });

  test("비밀번호가 틀리면 오류 알림을 보여 주고 머문다", async ({ page }) => {
    await page.goto("/login");
    await loginIdInput(page).fill(DEMO.loginId);
    await passwordInput(page).fill("wrong-password");
    await loginButton(page).click();
    // Next.js 라우트 안내 영역(__next-route-announcer__)도 role=alert 라 문구로 좁힌다.
    await expect(
      page.getByRole("alert").filter({ hasText: "아이디 또는 비밀번호가 올바르지 않습니다." }),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("아이디 저장을 선택하면 다음 방문 때 아이디가 채워진다", async ({ context, page }) => {
    await page.goto("/login");
    await loginIdInput(page).fill(DEMO.loginId);
    await passwordInput(page).fill(DEMO.password);
    await page.getByRole("checkbox", { name: "아이디 저장" }).check();
    await loginButton(page).click();
    await expect(page).toHaveURL("/");

    // 새 탭은 로그인 세션(sessionStorage)이 없어 로그인 화면이 보이고, 저장한 아이디(localStorage)는 남아 있다.
    const next = await context.newPage();
    await next.goto("/login");
    await expect(loginIdInput(next)).toHaveValue(DEMO.loginId);
    await expect(next.getByRole("checkbox", { name: "아이디 저장" })).toBeChecked();
  });

  test("로그인한 상태로 /login 에 들어오면 메인으로 이동한다", async ({ page }) => {
    await login(page);
    await page.goto("/login");
    await expect(page).toHaveURL("/");
    await expect(loginButton(page)).toHaveCount(0);
  });
});

test("없는 주소는 404 화면(h1 하나)을 보여 준다", async ({ page }) => {
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("페이지를 찾을 수 없어요");
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "홈으로" })).toHaveAttribute("href", "/");
});
