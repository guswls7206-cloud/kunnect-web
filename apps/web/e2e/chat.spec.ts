import { expect, test, type Page } from "@playwright/test";
import { login, navigate } from "./helpers";

const composerInput = (page: Page) => page.getByPlaceholder("쪽지를 입력하세요");

async function box(
  page: Page,
  selector: Parameters<Page["locator"]>[0] | ReturnType<Page["locator"]>,
) {
  const loc = typeof selector === "string" ? page.locator(selector) : selector;
  const b = await loc.boundingBox();
  if (!b) throw new Error("요소 위치를 구하지 못했습니다.");
  return { top: b.y, bottom: b.y + b.height };
}

for (const { name, width, height } of [
  { name: "모바일 390", width: 390, height: 844 },
  { name: "데스크톱 1280", width: 1280, height: 900 },
]) {
  test(`${name}: 쪽지 4개를 보내도 마지막 말풍선이 입력창에 가리지 않는다`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await login(page);
    await navigate(page, "/messages/1");
    const input = composerInput(page);
    await expect(input).toBeVisible();
    const composer = page.locator("form").filter({ has: input });

    for (let i = 1; i <= 4; i++) {
      const text = `E2E 확인 메시지 ${i}`;
      await input.fill(text);
      await page.getByRole("button", { name: "보내기" }).click();
      const bubble = page.getByText(text, { exact: true });
      await expect(bubble).toBeVisible();
      await expect(input).toHaveValue("");
      // 자동 스크롤이 끝날 때까지 기다린 뒤 위치를 비교한다.
      await expect
        .poll(async () => (await box(page, bubble)).bottom <= (await box(page, composer)).top, {
          timeout: 5_000,
        })
        .toBe(true);
    }

    if (width < 768) {
      // 모바일: 입력창이 하단 메뉴 위에 있어야 한다.
      const nav = page.getByRole("navigation", { name: "하단 메뉴" });
      expect((await box(page, composer)).bottom).toBeLessThanOrEqual((await box(page, nav)).top);
    }
  });
}
