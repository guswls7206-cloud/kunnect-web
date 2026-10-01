"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { ReportDialog } from "@/components/ui/report-dialog";
import { useToast } from "@/components/ui/toast";
import { unreadKey } from "@/features/auth/use-unread";
import { messageKeys } from "@/features/messages/queries";
import { api } from "@/lib/api/endpoints";
import type { ConversationItem } from "@/lib/api/types";

/**
 * 대화 설정 메뉴(⋯): 음소거, 차단, 신고, 나가기.
 * WAI-ARIA 메뉴 버튼 패턴: 열면 첫 항목에 포커스, ↑↓/Home/End 로 이동, Esc 는 닫고 버튼으로 포커스 복귀, Tab 은 닫기.
 */
export function ConversationMenu({ conversation }: { conversation: ConversationItem }) {
  // null: 닫힘, "first"/"last": 열면서 포커스할 항목
  const [open, setOpen] = useState<null | "first" | "last">(null);
  const [reporting, setReporting] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const toast = useToast();
  const queryClient = useQueryClient();

  // 바깥 클릭으로 닫기
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(null);
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  // 열릴 때 첫(또는 마지막) 항목으로 포커스
  useEffect(() => {
    if (!open) return;
    const items = menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (items?.length) items[open === "last" ? items.length - 1 : 0].focus();
  }, [open]);

  function menuItems() {
    return Array.from(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
  }

  /** 닫고 버튼으로 포커스를 돌려준다(Esc·항목 선택 후). */
  function close() {
    setOpen(null);
    triggerRef.current?.focus();
  }

  function onTriggerKeyDown(e: ReactKeyboardEvent<HTMLButtonElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setOpen(e.key === "ArrowDown" ? "first" : "last");
    }
  }

  function onMenuKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const items = menuItems();
    const index = items.indexOf(document.activeElement as HTMLElement);
    const move = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        return move(index + 1);
      case "ArrowUp":
        return move(index < 0 ? -1 : index - 1);
      case "Home":
        return move(0);
      case "End":
        return move(-1);
      case "Escape":
        e.preventDefault();
        return close();
      case "Tab":
        // 포커스는 브라우저 기본 동작대로 다음 요소로 이동하고 메뉴만 닫는다.
        return setOpen(null);
    }
  }

  function refresh() {
    queryClient.invalidateQueries({ queryKey: messageKeys.conversation(conversation.id) });
    queryClient.invalidateQueries({ queryKey: messageKeys.inbox });
  }

  async function run(action: () => Promise<unknown>, success: string) {
    close();
    try {
      await action();
      toast.show(success);
      refresh();
    } catch {
      toast.show("처리하지 못했습니다. 잠시 후 다시 시도해 주세요.", "error");
    }
  }

  const item = "flex min-h-11 w-full items-center px-4 text-left text-sm hover:bg-slate-50";

  return (
    <div ref={ref} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={Boolean(open)}
        aria-controls={open ? "conversation-menu" : undefined}
        aria-label="대화 메뉴"
        onClick={() => setOpen((v) => (v ? null : "first"))}
        onKeyDown={onTriggerKeyDown}
        className="flex h-11 w-11 items-center justify-center rounded-lg text-xl text-slate-600 hover:bg-slate-100 hover:text-slate-900"
      >
        ⋯
      </button>
      {open && (
        <div
          ref={menuRef}
          id="conversation-menu"
          role="menu"
          aria-label="대화 메뉴"
          onKeyDown={onMenuKeyDown}
          className="absolute right-0 top-12 z-40 w-44 overflow-hidden rounded-xl border border-slate-200/70 bg-white py-1 text-slate-700 shadow-lg shadow-slate-900/10"
        >
          <button
            role="menuitem"
            tabIndex={-1}
            className={item}
            onClick={() =>
              run(
                () => api.conversations.setMuted(conversation.id, !conversation.muted),
                conversation.muted ? "음소거를 해제했어요." : "음소거했어요.",
              )
            }
          >
            {conversation.muted ? "음소거 해제" : "음소거"}
          </button>
          <button
            role="menuitem"
            tabIndex={-1}
            className={item}
            onClick={() => {
              setOpen(null);
              setReporting(true);
            }}
          >
            신고
          </button>
          <button
            role="menuitem"
            tabIndex={-1}
            className={`${item} text-red-700`}
            onClick={() => {
              if (
                window.confirm(
                  `${conversation.other.nickname}님을 차단할까요? 새 쪽지와 알림이 오지 않아요.`,
                )
              ) {
                run(
                  () =>
                    api.blocks
                      .add(conversation.other.id)
                      .then(() => queryClient.invalidateQueries({ queryKey: unreadKey })),
                  "차단했어요.",
                );
              } else close();
            }}
          >
            차단
          </button>
          <button
            role="menuitem"
            tabIndex={-1}
            className={item}
            onClick={() => {
              if (!window.confirm("이 대화를 쪽지함에서 나갈까요?")) return close();
              run(async () => {
                await api.conversations.leave(conversation.id);
                router.replace("/messages");
              }, "대화에서 나갔어요.");
            }}
          >
            나가기
          </button>
        </div>
      )}
      <ReportDialog
        open={reporting}
        onClose={() => {
          setReporting(false);
          triggerRef.current?.focus();
        }}
        targetType="USER"
        targetId={conversation.other.id}
      />
    </div>
  );
}
