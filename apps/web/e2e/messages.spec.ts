import { expect, test, type Page } from "@playwright/test";
import { login, loginInPlace, logout, navigate } from "./helpers";

const handover = (page: Page) => page.getByRole("region", { name: "인수 상태" });

// 대화 1: demo_a(분실자) ↔ demo_b(습득자, 관련 글 2번 작성자).
// 목 DB 는 메모리에만 있어 두 사용자가 같은 DB 를 보려면 같은 탭에서 앱 안 이동으로 로그아웃·로그인해야 한다.
test("인수 절차: 요청 → 소유 확인(습득자) → 양쪽 완료 확인", async ({ page }) => {
  test.setTimeout(90_000);
  await login(page);
  await navigate(page, "/messages/1");
  await handover(page).getByRole("button", { name: "인수 절차 시작" }).click();
  await expect(handover(page)).toContainText("소유 확인 중");
  await expect(handover(page)).toContainText("습득자가 소유 여부를 확인하고 있어요");

  await logout(page);
  await loginInPlace(page, "demo_b");
  await navigate(page, "/messages/1");
  await expect(handover(page)).toContainText("소유 확인 중");
  await handover(page).getByRole("button", { name: "소유 확인 완료" }).click();
  await expect(handover(page)).toContainText("소유 확인 완료");
  await handover(page).getByRole("button", { name: "인수 완료 확인" }).click();
  await expect(handover(page).getByRole("button", { name: "상대방 확인 대기 중" })).toBeDisabled();

  await logout(page);
  await loginInPlace(page, "demo_a");
  await navigate(page, "/messages/1");
  await handover(page).getByRole("button", { name: "인수 완료 확인" }).click();
  await expect(handover(page)).toContainText("물건이 주인에게 돌아갔어요");
});

test("상대를 차단하면 대화가 읽기 전용이 된다", async ({ page }) => {
  await login(page);
  await navigate(page, "/messages/1");
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "대화 메뉴" }).click();
  await page.getByRole("menuitem", { name: "차단" }).click();
  await expect(page.getByText("이 대화에서는 메시지를 보낼 수 없어요.")).toBeVisible();
  await expect(page.getByPlaceholder("쪽지를 입력하세요")).toHaveCount(0);
});
