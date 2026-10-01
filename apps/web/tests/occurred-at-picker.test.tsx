import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { OccurredAtPicker } from "@/components/post/occurred-at-picker";

// 기준 시각: 2026-10-02(금) 10:30(로컬)
const NOW = new Date(2026, 9, 2, 10, 30);

function Harness({ initial = "2026-10-02T10:30", onChange = vi.fn() }) {
  const [value, setValue] = useState(initial);
  return (
    <OccurredAtPicker
      label="분실 일시"
      value={value}
      now={NOW}
      onChange={(v) => {
        setValue(v);
        onChange(v);
      }}
    />
  );
}

const chip = (name: string) => screen.getByRole("button", { name });
const dateInput = () => screen.getByLabelText("날짜");
const timeInput = () => screen.getByLabelText("시간");

describe("OccurredAtPicker", () => {
  it("빠른 선택 칩은 방금 전·1시간 전·어제·그저께 네 개이고 모두 고를 수 있다", () => {
    render(<Harness />);
    const group = screen.getByRole("group", { name: "빠른 선택" });
    const chips = within(group).getAllByRole("button");
    expect(chips.map((c) => c.textContent)).toEqual(["방금 전", "1시간 전", "어제", "그저께"]);
    chips.forEach((c) => expect(c).toBeEnabled());
    // 기본값(지금)은 "방금 전"으로 표시된다.
    expect(chip("방금 전")).toHaveAttribute("aria-pressed", "true");
  });

  it.each([
    ["1시간 전", "2026-10-02T09:30"],
    ["어제", "2026-10-01T12:00"],
    ["그저께", "2026-09-30T12:00"],
  ])("%s 칩을 누르면 %s 로 바뀌고 날짜·시간 칸에 채워진다", async (name, expected) => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(chip(name));
    expect(onChange).toHaveBeenLastCalledWith(expected);
    expect(chip(name)).toHaveAttribute("aria-pressed", "true");
    expect(chip("방금 전")).toHaveAttribute("aria-pressed", "false");
    const [d, t] = expected.split("T");
    expect(dateInput()).toHaveValue(d);
    expect(timeInput()).toHaveValue(t);
  });

  it("날짜만 바꾸면 시간은 유지되고, 시간만 바꾸면 날짜는 유지된다", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.change(dateInput(), { target: { value: "2026-09-28" } });
    expect(onChange).toHaveBeenLastCalledWith("2026-09-28T10:30");
    fireEvent.change(timeInput(), { target: { value: "18:20" } });
    expect(onChange).toHaveBeenLastCalledWith("2026-09-28T18:20");
  });

  it("오늘이면 시간 칸에 지금 시각을 최대값으로, 날짜 칸에는 오늘을 최대값으로 둔다", () => {
    render(<Harness />);
    expect(dateInput()).toHaveAttribute("max", "2026-10-02");
    expect(timeInput()).toHaveAttribute("max", "10:30");
    expect(timeInput()).toHaveAttribute("step", "600");
  });

  it("오류가 있으면 알림으로 보여 주고 입력칸과 연결한다", () => {
    render(
      <OccurredAtPicker
        label="분실 일시"
        value=""
        onChange={vi.fn()}
        now={NOW}
        error="일시를 입력해 주세요."
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("일시를 입력해 주세요.");
    expect(dateInput()).toHaveAttribute("aria-describedby", alert.id);
    expect(dateInput()).toHaveAttribute("aria-invalid", "true");
  });
});
