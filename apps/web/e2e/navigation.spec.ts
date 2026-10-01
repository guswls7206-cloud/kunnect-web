import { expect, test } from "@playwright/test";
import { login, navigate } from "./helpers";

for (const { name, width, height, nav } of [
  { name: "데스크톱", width: 1280, height: 900, nav: "주요 메뉴" },
  { name: "모바일", width: 390, height: 844, nav: "하단 메뉴" },
]) {
  test(`${name}: /messages 에서는 '쪽지' 메뉴만 활성이다`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await login(page);
    await navigate(page, "/messages");
    const current = page.getByRole("navigation", { name: nav }).locator("a[aria-current='page']");
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute("href", "/messages");
  });
}
