import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import NewPostPage from "@/app/(main)/posts/new/page";
import { PostCreateForm } from "@/components/post/post-create-form";
import { ToastProvider } from "@/components/ui/toast";
import { postCreateSchema, postEditSchema } from "@/features/posts/schemas";
import { api } from "@/lib/api/endpoints";
import { fitSize } from "@/lib/image";

const replace = vi.fn();
// 글쓰기 페이지 테스트에서 주소의 ?type= 을 바꿔 가며 렌더링할 수 있게 검색 파라미터를 바깥에서 바꾼다.
const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace, back: vi.fn() }),
  useSearchParams: () => nav.params,
}));

function renderForm(type: "LOST" | "FOUND") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <PostCreateForm initialType={type} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("PostCreateForm", () => {
  beforeEach(async () => {
    replace.mockClear();
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
  });

  it("일시 칸에 미래 날짜를 넣으면 기존 오류 문구로 막는다", async () => {
    renderForm("LOST");
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const pad = (n: number) => String(n).padStart(2, "0");
    fireEvent.change(screen.getByLabelText("날짜"), {
      target: {
        value: `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}`,
      },
    });
    await userEvent.click(screen.getByRole("button", { name: "등록하기" }));
    expect(await screen.findByText("미래 시각은 입력할 수 없어요.")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("일시 빠른 선택(어제)을 고르면 그 값으로 등록한다", async () => {
    const create = vi.spyOn(api.posts, "create");
    renderForm("LOST");
    await userEvent.type(screen.getByLabelText(/제목/), "어제 잃어버림");
    await userEvent.type(screen.getByLabelText(/설명/), "검은색");
    const building = await screen.findByLabelText(/분실 위치/);
    await waitFor(() => expect(building).not.toBeDisabled());
    await userEvent.selectOptions(building, (building as HTMLSelectElement).options[1].value);
    await userEvent.click(screen.getByRole("button", { name: "어제" }));
    await userEvent.click(screen.getByRole("button", { name: "등록하기" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const sent = new Date(create.mock.calls[0][0].occurredAt);
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(sent.getDate()).toBe(yesterday.getDate());
    expect(sent.getHours()).toBe(12);
    create.mockRestore();
  });

  it("위치를 기타로 고르면 장소 입력칸이 생기고, 비우면 막고, 입력하면 함께 등록한다", async () => {
    const create = vi.spyOn(api.posts, "create");
    renderForm("LOST");
    await userEvent.type(screen.getByLabelText(/제목/), "기타 장소 분실");
    await userEvent.type(screen.getByLabelText(/설명/), "설명");
    const building = await screen.findByLabelText(/분실 위치/);
    await waitFor(() => expect(building).toBeEnabled());
    expect(screen.queryByLabelText(/^장소/)).not.toBeInTheDocument();
    await userEvent.selectOptions(building, "기타");
    const place = screen.getByPlaceholderText("장소를 직접 입력해 주세요");
    await userEvent.click(screen.getByRole("button", { name: "등록하기" }));
    expect(await screen.findByText("장소를 입력해 주세요.")).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
    await userEvent.type(place, "체육관 앞 벤치");
    await userEvent.click(screen.getByRole("button", { name: "등록하기" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).toMatchObject({ locationText: "체육관 앞 벤치" });
    create.mockRestore();
  });

  it("기타에서 다른 위치로 바꾸면 장소 입력칸이 사라지고 값을 보내지 않는다", async () => {
    const create = vi.spyOn(api.posts, "create");
    renderForm("LOST");
    await userEvent.type(screen.getByLabelText(/제목/), "제목");
    await userEvent.type(screen.getByLabelText(/설명/), "설명");
    const building = await screen.findByLabelText(/분실 위치/);
    await waitFor(() => expect(building).toBeEnabled());
    await userEvent.selectOptions(building, "기타");
    await userEvent.type(screen.getByPlaceholderText("장소를 직접 입력해 주세요"), "어딘가");
    await userEvent.selectOptions(building, "학생회관");
    expect(screen.queryByPlaceholderText("장소를 직접 입력해 주세요")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "등록하기" }));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(create.mock.calls[0][0]).not.toHaveProperty("locationText");
    create.mockRestore();
  });

  it("필수 항목이 비어 있으면 오류를 보여주고 등록하지 않는다", async () => {
    renderForm("LOST");
    await userEvent.click(screen.getByRole("button", { name: "등록하기" }));
    expect(await screen.findByText("제목을 입력해 주세요.")).toBeInTheDocument();
    expect(screen.getByText("설명을 입력해 주세요.")).toBeInTheDocument();
    expect(screen.getByText("위치를 선택해 주세요.")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("분실글을 작성하면 상세 화면으로 이동한다", async () => {
    renderForm("LOST");
    await userEvent.type(screen.getByLabelText(/제목/), "테스트 분실글");
    await userEvent.type(screen.getByLabelText(/설명/), "검은색 케이스입니다");
    const building = await screen.findByLabelText(/분실 위치/);
    await waitFor(() => expect(building).toBeEnabled());
    await userEvent.selectOptions(building, "중앙도서관");
    await userEvent.click(screen.getByRole("button", { name: "스마트폰" }));
    await userEvent.type(screen.getByLabelText("태그 직접 입력"), "검정{Enter}");
    await userEvent.click(screen.getByRole("button", { name: "등록하기" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/posts/7"));
    const created = await api.posts.get(7);
    expect(created.tags).toEqual(["스마트폰", "검정"]);
    expect(created.storagePlace).toBeNull();
  });

  it("습득글은 보관 장소가 필수이고 비공개 특징 입력란이 보인다", async () => {
    renderForm("FOUND");
    expect(screen.getByLabelText(/비공개 특징/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/제목/), "주웠어요");
    await userEvent.type(screen.getByLabelText(/설명/), "설명");
    const building = await screen.findByLabelText(/습득 위치/);
    await waitFor(() => expect(building).toBeEnabled());
    await userEvent.selectOptions(building, "자연과학관");
    await userEvent.click(screen.getByRole("button", { name: "등록하기" }));
    expect(await screen.findByText("현재 보관 장소를 입력해 주세요.")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("태그는 최대 8개까지만 추가된다", async () => {
    renderForm("LOST");
    const input = screen.getByLabelText("태그 직접 입력");
    for (let i = 1; i <= 9; i++) await userEvent.type(input, `태그${i}{Enter}`);
    expect(await screen.findByText("태그는 최대 8개까지 달 수 있어요.")).toBeInTheDocument();
    expect(screen.getByLabelText("선택한 태그").children).toHaveLength(8);
  });
});

describe("글쓰기 페이지", () => {
  it("같은 화면에서 ?type=FOUND 로 이동하면 습득글 폼으로 다시 시작한다", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const page = () => (
      <QueryClientProvider client={client}>
        <ToastProvider>
          <NewPostPage />
        </ToastProvider>
      </QueryClientProvider>
    );

    nav.params = new URLSearchParams();
    const { rerender } = render(page());
    expect(await screen.findByRole("heading", { name: "잃어버렸어요" })).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/제목/), "분실글 제목");

    // 클라이언트 이동처럼 같은 컴포넌트 트리에서 검색 파라미터만 바뀐다.
    nav.params = new URLSearchParams("type=FOUND");
    rerender(page());
    expect(await screen.findByRole("heading", { name: "주웠어요" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "습득" })).toBeChecked();
    expect(screen.getByLabelText(/현재 보관 장소/)).toBeInTheDocument();
    expect(screen.getByLabelText(/제목/)).toHaveValue("");
  });
});

describe("스키마·이미지 유틸", () => {
  const valid = {
    type: "LOST" as const,
    title: "제목",
    description: "설명",
    locationId: 1,
    occurredAt: "2020-01-01T10:00",
    tags: [],
    storagePlace: "",
    hiddenFeatures: "",
  };

  it("미래 일시는 거부한다", () => {
    const future = new Date(Date.now() + 86_400_000).toISOString().slice(0, 16);
    expect(postCreateSchema.safeParse({ ...valid, occurredAt: future }).success).toBe(false);
    expect(postCreateSchema.safeParse(valid).success).toBe(true);
  });

  it("제목 50자 초과는 거부한다", () => {
    expect(postCreateSchema.safeParse({ ...valid, title: "가".repeat(51) }).success).toBe(false);
  });

  it("수정 스키마도 습득글 보관 장소를 요구한다", () => {
    const edit = {
      type: "FOUND" as const,
      title: "t",
      description: "d",
      tags: [],
      storagePlace: "",
      hiddenFeatures: "",
    };
    expect(postEditSchema.safeParse(edit).success).toBe(false);
  });

  it("fitSize: 긴 변만 줄이고 확대하지 않는다", () => {
    expect(fitSize(4000, 3000)).toEqual({ width: 1280, height: 960 });
    expect(fitSize(3000, 4000)).toEqual({ width: 960, height: 1280 });
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
  });
});

describe("TagInput 쉼표 분리", () => {
  it("붙여넣기한 쉼표 목록이 각각 태그가 된다", async () => {
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
    renderForm("LOST");
    await userEvent.click(screen.getByLabelText("태그 직접 입력"));
    await userEvent.paste("우산,검정, 큰것");
    await userEvent.keyboard("{Enter}");
    const list = screen.getByLabelText("선택한 태그");
    expect(list.children).toHaveLength(3);
    expect(list).toHaveTextContent("#우산");
    expect(list).toHaveTextContent("#큰것");
  });
});
