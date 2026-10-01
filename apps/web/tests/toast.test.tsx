import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "@/components/ui/toast";

function Trigger({ message = "저장했어요.", tone }: { message?: string; tone?: "info" | "error" }) {
  const toast = useToast();
  return (
    <button type="button" onClick={() => toast.show(message, tone)}>
      알림 띄우기
    </button>
  );
}

const liveRegion = (kind: "polite" | "assertive") =>
  document.querySelector<HTMLElement>(`[data-toast-live="${kind}"]`)!;

describe("ToastProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    // jsdom 에는 popover API 가 없어 테스트마다 붙였다 뗀다.
    delete (HTMLElement.prototype as Partial<HTMLElement>).showPopover;
    delete (HTMLElement.prototype as Partial<HTMLElement>).hidePopover;
  });

  it("안내는 항상 존재하는 live 영역에 넣고, 보이는 토스트는 스크린리더에서 숨긴다", async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    const polite = liveRegion("polite");
    expect(polite).toBeInTheDocument();
    expect(polite).toBeEmptyDOMElement();

    await userEvent.click(screen.getByRole("button", { name: "알림 띄우기" }));
    // 같은 live 영역 요소가 그대로 유지된 채 내용만 바뀐다.
    expect(liveRegion("polite")).toBe(polite);
    expect(polite).toHaveTextContent("저장했어요.");
    const visual = document.querySelector<HTMLElement>("[data-message='저장했어요.']")!;
    expect(visual.closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("오류 안내는 assertive live 영역에 넣는다", async () => {
    render(
      <ToastProvider>
        <Trigger message="실패했어요." tone="error" />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "알림 띄우기" }));
    expect(liveRegion("assertive")).toHaveTextContent("실패했어요.");
    expect(liveRegion("polite")).toBeEmptyDOMElement();
  });

  it("토스트가 떠 있는 동안 모달 대화상자가 열리면 토스트를 다시 맨 위로 올린다", async () => {
    const showPopover = vi.fn();
    const hidePopover = vi.fn();
    Object.assign(HTMLElement.prototype, { showPopover, hidePopover });

    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole("button", { name: "알림 띄우기" }));
    await waitFor(() => expect(showPopover).toHaveBeenCalledTimes(1));

    const dialog = document.createElement("dialog");
    document.body.appendChild(dialog);
    act(() => dialog.setAttribute("open", ""));
    await waitFor(() => expect(showPopover).toHaveBeenCalledTimes(2));

    // 대화상자가 닫힐 때(open 제거)는 다시 올리지 않는다.
    act(() => dialog.removeAttribute("open"));
    await new Promise((r) => setTimeout(r, 50));
    expect(showPopover).toHaveBeenCalledTimes(2);
    dialog.remove();
  });

  it("모달 대화상자가 열려 있는 동안에는 live 영역을 그 안으로 옮기고, 닫히면 되돌린다(항상 한 곳)", async () => {
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    const dialog = document.createElement("dialog");
    dialog.innerHTML = "<p>대화상자</p>";
    document.body.appendChild(dialog);

    act(() => dialog.setAttribute("open", ""));
    await waitFor(() => expect(dialog.querySelector('[data-toast-live="polite"]')).not.toBeNull());
    expect(document.querySelectorAll('[data-toast-live="polite"]')).toHaveLength(1);

    // 모달이 열린 상태에서 띄운 토스트 안내도 모달 안 live 영역에 들어간다.
    await userEvent.click(screen.getByRole("button", { name: "알림 띄우기" }));
    expect(dialog.querySelector('[data-toast-live="polite"]')).toHaveTextContent("저장했어요.");

    act(() => dialog.removeAttribute("open"));
    await waitFor(() => expect(dialog.querySelector('[data-toast-live="polite"]')).toBeNull());
    expect(document.querySelectorAll('[data-toast-live="polite"]')).toHaveLength(1);
    expect(liveRegion("polite")).toHaveTextContent("저장했어요.");
    dialog.remove();
  });
});
