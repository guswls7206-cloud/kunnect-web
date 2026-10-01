import { expect, test } from "@playwright/test";

test.describe("회원가입", () => {
  test("형식에 맞지 않으면 항목별 오류를 보여 주고 머문다", async ({ page }) => {
    await page.goto("/signup");
    await page.getByRole("textbox", { name: "아이디" }).fill("A!");
    await page.getByRole("textbox", { name: "비밀번호", exact: true }).fill("short");
    await page.getByRole("textbox", { name: "닉네임" }).fill("가");
    await page.getByRole("button", { name: "가입하기" }).click();
    await expect(page.getByText("아이디는 영소문자·숫자·_ 4~20자로 입력해 주세요.")).toBeVisible();
    await expect(page.getByText("비밀번호는 8자 이상이어야 합니다.")).toBeVisible();
    await expect(page.getByText("닉네임은 2자 이상이어야 합니다.")).toBeVisible();
    await expect(page).toHaveURL("/signup");
  });

  test("이미 있는 아이디면 아이디 칸에 서버 오류를 보여 준다", async ({ page }) => {
    await page.goto("/signup");
    await page.getByRole("textbox", { name: "아이디" }).fill("demo_a");
    await page.getByRole("textbox", { name: "비밀번호", exact: true }).fill("password123");
    await page.getByRole("textbox", { name: "닉네임" }).fill("새로운사람");
    await page.getByRole("button", { name: "가입하기" }).click();
    await expect(page.getByRole("textbox", { name: "아이디" })).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    await expect(page).toHaveURL("/signup");
  });

  test("올바르게 입력하면 가입 후 메인으로 이동한다", async ({ page }) => {
    await page.goto("/signup");
    await page.getByRole("textbox", { name: "아이디" }).fill("e2e_user");
    await page.getByRole("textbox", { name: "비밀번호", exact: true }).fill("password123");
    await page.getByRole("textbox", { name: "닉네임" }).fill("이투이");
    await page.getByRole("button", { name: "가입하기" }).click();
    await expect(page).toHaveURL("/");
  });
});
