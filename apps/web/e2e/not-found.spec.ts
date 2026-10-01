import { expect, test } from "@playwright/test";
import { login } from "./helpers";

test("없는 글(/posts/9999)은 오류가 아닌 중립 '찾을 수 없음' 카드를 보여 준다", async ({
  page,
}) => {
  await login(page);
  await page.goto("/posts/9999");
  const heading = page.getByRole("heading", { level: 1 });
  await expect(heading).toHaveText("게시글을 찾을 수 없어요");
  await expect(page.locator("h1")).toHaveCount(1);
  await expect(page.getByRole("link", { name: "홈으로" })).toHaveAttribute("href", "/");
  // 오류 알림(role=alert)으로 다루지 않는다. Next.js 라우트 안내 영역은 비어 있으므로 내용 있는 alert 만 센다.
  await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toHaveCount(0);
});

for (const { path, title } of [
  { path: "/posts/abc", title: "게시글을 찾을 수 없어요" },
  { path: "/messages/abc", title: "대화를 찾을 수 없어요" },
]) {
  test(`올바르지 않은 id 주소(${path})는 로딩 없이 바로 '찾을 수 없음' 화면을 보여 준다`, async ({
    page,
  }) => {
    await login(page);
    await page.goto(path);
    // API 요청 없이 곧바로 판단하므로 짧은 시간 안에 보여야 한다(로딩이 끝나지 않던 회귀 방지).
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title, { timeout: 5_000 });
    await expect(page.locator("h1")).toHaveCount(1);
    await expect(page.getByRole("status").filter({ hasText: "불러오는 중" })).toHaveCount(0);
    await expect(page.getByRole("link", { name: "홈으로" })).toHaveAttribute("href", "/");
  });
}
