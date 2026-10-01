import { expect, test } from "@playwright/test";
import { login, navigate } from "./helpers";

test.describe("글 작성·수정", () => {
  test("필수 항목을 비우고 등록하면 오류를 보여 주고 머문다", async ({ page }) => {
    await login(page);
    await navigate(page, "/posts/new");
    await page.getByRole("button", { name: "등록하기" }).click();
    await expect(page.getByText("제목을 입력해 주세요.")).toBeVisible();
    await expect(page.getByText("위치를 선택해 주세요.")).toBeVisible();
    await expect(page.getByText("설명을 입력해 주세요.")).toBeVisible();
    await expect(page).toHaveURL("/posts/new");
  });

  test("분실글을 태그·위치와 함께 등록하면 상세 화면으로 이동한다", async ({ page }) => {
    await login(page);
    await navigate(page, "/posts/new");
    await expect(page.getByRole("radio", { name: "분실" })).toBeChecked();
    await page.getByRole("textbox", { name: "제목" }).fill("E2E 회색 우산을 잃어버렸어요");
    await page.getByRole("combobox", { name: "분실 위치" }).selectOption({ label: "중앙도서관" });
    await page.getByRole("button", { name: "가방", exact: true }).click();
    const tagInput = page.getByRole("textbox", { name: "태그 직접 입력" });
    await tagInput.fill("우산");
    await tagInput.press("Enter");
    const chosen = page.getByRole("list", { name: "선택한 태그" });
    await expect(chosen).toContainText("가방");
    await expect(chosen).toContainText("우산");
    await page.getByRole("textbox", { name: "설명" }).fill("손잡이가 나무로 된 회색 장우산입니다.");
    await page.getByRole("button", { name: "등록하기" }).click();

    await expect(page).toHaveURL(/\/posts\/\d+$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "E2E 회색 우산을 잃어버렸어요",
    );
    await expect(page.getByText("중앙도서관").first()).toBeVisible();
    await expect(page.getByText("#우산").first()).toBeVisible();
  });

  test("내 글을 수정하면 바뀐 제목으로 보인다", async ({ page }) => {
    await login(page);
    await navigate(page, "/posts/1");
    await page.getByRole("link", { name: "수정", exact: true }).click();
    await expect(page).toHaveURL("/posts/1/edit");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("글 수정");
    const title = page.getByRole("textbox", { name: "제목" });
    await title.fill("E2E 수정한 제목");
    await page.getByRole("button", { name: "저장" }).click();
    await expect(page).toHaveURL("/posts/1");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("E2E 수정한 제목");
  });
});

test("댓글에 연락처를 쓰면 가려지고 안내가 보인다", async ({ page }) => {
  await login(page);
  await navigate(page, "/posts/2");
  await page.getByLabel("댓글 입력").fill("연락주세요 010-1234-5678");
  await page.getByRole("button", { name: "등록", exact: true }).click();
  await expect(page.getByText(/연락주세요 ●+/)).toBeVisible();
  await expect(page.getByText("010-1234-5678")).toHaveCount(0);
  await expect(page.getByText(/연락처로 보이는 내용은 가려졌어요/)).toBeVisible();
});
