import { expect, test } from "@playwright/test";
import { login, navigate } from "./helpers";

test("글 신고 후 토스트가 보이고, 이어서 쪽지 대화상자를 열어도 토스트가 남아 있다", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await navigate(page, "/posts/2");

  await page.getByRole("button", { name: "신고", exact: true }).first().click();
  const reportDialog = page.getByRole("dialog", { name: "신고하기" });
  await expect(reportDialog).toBeVisible();
  await reportDialog.getByRole("radio").first().check();
  await reportDialog.getByRole("button", { name: "신고", exact: true }).click();
  await expect(reportDialog).toBeHidden();

  // 보이는 토스트(글자는 CSS 로 그림)와 스크린리더 live 영역 모두 확인한다.
  const toast = page.locator('[data-message="신고가 접수되었어요."]');
  await expect(toast).toBeVisible();
  await expect(page.locator('[data-toast-live="polite"]')).toHaveText("신고가 접수되었어요.");

  await page.getByRole("button", { name: "쪽지 보내기" }).first().click();
  await expect(page.locator("dialog[open]")).toBeVisible();
  await expect(toast).toBeVisible();
  // 토스트 영역이 모달 대화상자보다 나중에 top layer 에 올라가 있어야 위에 그려진다.
  const toastOnTop = await page.evaluate(() => {
    const region = document.querySelector("[data-message]")?.parentElement;
    return Boolean(region?.matches(":popover-open"));
  });
  expect(toastOnTop).toBe(true);
});
