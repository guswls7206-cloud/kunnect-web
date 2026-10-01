"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ConversationMenu } from "@/components/message/conversation-menu";
import { HandoverPanel } from "@/components/message/handover-panel";
import { MessageBubble } from "@/components/message/message-bubble";
import { Button } from "@/components/ui/button";
import { ErrorState, Spinner } from "@/components/ui/states";
import { useToast } from "@/components/ui/toast";
import { useMe } from "@/features/auth/use-me";
import { unreadKey } from "@/features/auth/use-unread";
import {
  appendMessage,
  MAX_MESSAGE_LENGTH,
  messageKeys,
  mergeMessages,
  PAGE_SIZE,
  useConversation,
  useMessages,
} from "@/features/messages/queries";
import { usePostDetail } from "@/features/posts/queries";
import { isApiError } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import { parsePositiveIntId } from "@/lib/ids";
import type { Message } from "@/lib/api/types";

type SendType = "TEXT" | "VERIFY_QUESTION" | "VERIFY_ANSWER";

export default function ConversationPage() {
  const parsedId = parsePositiveIntId(useParams<{ id: string }>().id);
  const id = parsedId ?? 0;
  const queryClient = useQueryClient();
  const toast = useToast();
  const { data: me } = useMe();
  const conversation = useConversation(id);
  const messages = useMessages(id);
  const items = messages.data ?? [];
  const context = conversation.data?.postContext ?? null;
  const { data: contextPost } = usePostDetail(context?.id ?? 0);

  const [text, setText] = useState("");
  const [sendType, setSendType] = useState<SendType>("TEXT");
  const [sending, setSending] = useState(false);
  // 이전 쪽지를 더 불러왔더니 한 페이지가 안 차면 더 이상 없다고 본다.
  const [olderExhausted, setOlderExhausted] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  const nearBottom = useRef(true);
  const lastSeenId = useRef(0);
  const lastReadSent = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);
  // 화면 아래에 고정된 입력창의 높이. 목록 끝에 같은 높이의 빈 공간을 둬 마지막 말풍선이 가려지지 않게 한다.
  const composerRef = useRef<HTMLDivElement>(null);
  const [composerHeight, setComposerHeight] = useState(0);
  // 의존성 없이 매 렌더 확인한다: 로딩 화면 동안에는 입력창이 없어서, 처음 그려진 뒤에 관찰을 시작해야 한다.
  // 같은 높이면 상태가 바뀌지 않아 다시 그리지 않는다.
  useEffect(() => {
    const el = composerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) =>
      setComposerHeight(Math.ceil(entry.target.getBoundingClientRect().height)),
    );
    observer.observe(el);
    return () => observer.disconnect();
  });

  useEffect(() => {
    const onScroll = () => {
      nearBottom.current =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 160;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const hasMoreOlder = !olderExhausted && items.length >= PAGE_SIZE;
  const lastId = items.at(-1)?.id ?? 0;
  const lastMine = items.at(-1)?.senderId === me?.id;

  // 새 메시지가 오면: 첫 로딩·내가 보낸 경우·이미 아래쪽을 보고 있던 경우에만 맨 아래로 스크롤
  useEffect(() => {
    if (lastId === 0 || lastId === lastSeenId.current) return;
    const first = lastSeenId.current === 0;
    lastSeenId.current = lastId;
    if (first || lastMine || nearBottom.current) endRef.current?.scrollIntoView({ block: "end" });
  }, [lastId, lastMine]);

  // 상대 메시지를 화면에 보여준 뒤 읽음 처리(마지막 id 기준, 중복 호출 방지)
  useEffect(() => {
    if (!lastId || lastId <= lastReadSent.current || document.visibilityState !== "visible") return;
    lastReadSent.current = lastId;
    api.conversations
      .markRead(id, lastId)
      .then(() => {
        queryClient.invalidateQueries({ queryKey: unreadKey });
        queryClient.invalidateQueries({ queryKey: messageKeys.inbox });
      })
      .catch(() => {
        lastReadSent.current = 0; // 실패하면 다음 폴링에서 다시 시도
      });
  }, [lastId, id, queryClient]);

  async function loadOlder() {
    const firstId = items[0]?.id;
    if (!firstId) return;
    setLoadingOlder(true);
    try {
      const { items: older } = await api.conversations.messages(id, {
        beforeId: firstId,
        limit: PAGE_SIZE,
      });
      queryClient.setQueryData<Message[]>(messageKeys.messages(id), (prev) =>
        mergeMessages(prev ?? [], older),
      );
      setOlderExhausted(older.length < PAGE_SIZE);
    } catch {
      toast.show("이전 쪽지를 불러오지 못했어요.", "error");
    } finally {
      setLoadingOlder(false);
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try {
      const { message } = await api.conversations.send(id, { type: sendType, body });
      appendMessage(queryClient, id, message);
      // 내 메시지를 바로 보여준 뒤, 서버 기준 커서로 곧바로 한 번 더 조회해 그 사이 온 상대 메시지도 가져온다.
      queryClient.invalidateQueries({ queryKey: messageKeys.messages(id) });
      setText("");
      setSendType("TEXT");
      queryClient.invalidateQueries({ queryKey: messageKeys.inbox });
    } catch (error) {
      // 차단 사실이 드러나지 않도록 서버가 준 중립 문구만 보여준다(READ_ONLY 도 동일 취급).
      toast.show(
        isApiError(error, 409) || isApiError(error, 403)
          ? "이 대화에서는 메시지를 보낼 수 없어요."
          : isApiError(error)
            ? error.message
            : "보내지 못했습니다. 잠시 후 다시 시도해 주세요.",
        "error",
      );
      queryClient.invalidateQueries({ queryKey: messageKeys.conversation(id) });
    } finally {
      setSending(false);
    }
  }

  const notFound = (
    <ErrorState
      variant="notice"
      title="대화를 찾을 수 없어요"
      message="삭제되었거나 주소가 잘못되었어요."
    />
  );
  if (parsedId === null) return notFound;
  if (conversation.isPending || messages.isPending) return <Spinner />;
  if (conversation.isError) {
    return isApiError(conversation.error, 404) ? (
      notFound
    ) : (
      <ErrorState message="대화를 불러오지 못했습니다." onRetry={() => conversation.refetch()} />
    );
  }
  const conv = conversation.data;
  const handoverOpen = conv.handover?.status === "REQUESTED";
  const iAmFinder = contextPost
    ? contextPost.type === "FOUND"
      ? contextPost.isMine
      : !contextPost.isMine
    : null;

  return (
    <div className="flex flex-col gap-3">
      <header className="card flex items-center justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span
            aria-hidden="true"
            className="flex size-10 shrink-0 items-center justify-center rounded-full bg-brand-100 text-base font-bold text-brand-700"
          >
            {conv.other.nickname.slice(0, 1)}
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-lg font-bold text-slate-900">
              <Link href={`/users/${conv.other.id}`} className="rounded hover:underline">
                {conv.other.nickname}
              </Link>
            </h1>
            {context && (
              <Link
                href={`/posts/${context.id}`}
                className="block truncate rounded text-sm font-medium text-brand-600 hover:underline"
              >
                관련 글: {context.title}
              </Link>
            )}
          </div>
        </div>
        <ConversationMenu conversation={conv} />
      </header>

      <HandoverPanel conversation={conv} />

      {hasMoreOlder && (
        <Button variant="ghost" loading={loadingOlder} onClick={loadOlder}>
          이전 쪽지 보기
        </Button>
      )}

      <ul aria-label="쪽지 내용" className="flex flex-col gap-2.5 py-1">
        {items.map((m) => (
          <MessageBubble key={m.id} message={m} mine={m.senderId === me?.id} />
        ))}
      </ul>

      {/* 고정된 입력창이 차지하는 만큼 목록 끝에 자리를 비워 둔다(마지막 말풍선이 입력창 뒤로 숨지 않게). */}
      <div aria-hidden="true" style={{ height: composerHeight }} />

      {/*
        입력창은 스크롤과 관계없이 항상 화면 아래에 고정한다. 본문 열(max-w-2xl, px-4)과 가로 위치를 맞추고,
        모바일은 하단 메뉴(높이 4rem + 안전 영역) 바로 위, md 이상은 화면 아래에서 1rem 위에 둔다.
      */}
      <div
        ref={composerRef}
        className="fixed inset-x-0 bottom-[calc(var(--bottom-nav-h)+0.5rem+env(safe-area-inset-bottom))] z-20 md:bottom-4"
      >
        <div className="mx-auto w-full max-w-2xl px-4">
          {conv.readOnly ? (
            <p
              role="status"
              className="rounded-2xl border border-slate-200/70 bg-slate-100/95 px-4 py-3 text-center text-sm text-slate-600 shadow-card backdrop-blur"
            >
              이 대화에서는 메시지를 보낼 수 없어요.
            </p>
          ) : (
            <form
              onSubmit={send}
              className="flex flex-col gap-2 rounded-2xl border border-slate-200/70 bg-white/95 p-2 shadow-card backdrop-blur"
            >
              {handoverOpen && iAmFinder !== null && (
                <label className="flex items-center gap-2 px-1 pt-1 text-xs font-medium text-slate-700">
                  보내는 종류
                  <select
                    value={sendType}
                    onChange={(e) => setSendType(e.target.value as SendType)}
                    className="min-h-9 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-900 focus-visible:border-brand-600 focus-visible:outline-offset-0"
                  >
                    <option value="TEXT">일반 쪽지</option>
                    <option value={iAmFinder ? "VERIFY_QUESTION" : "VERIFY_ANSWER"}>
                      {iAmFinder ? "소유 확인 질문" : "소유 확인 답변"}
                    </option>
                  </select>
                </label>
              )}
              <div className="flex items-end gap-2">
                <label className="sr-only" htmlFor="message-input">
                  쪽지 입력
                </label>
                <textarea
                  id="message-input"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter 전송, Shift+Enter 줄바꿈(한글 조합 중에는 무시)
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      e.currentTarget.form?.requestSubmit();
                    }
                  }}
                  maxLength={MAX_MESSAGE_LENGTH}
                  rows={1}
                  placeholder="쪽지를 입력하세요"
                  className="max-h-32 min-h-11 flex-1 resize-none rounded-xl border border-slate-300 bg-white px-3 py-2 text-base text-slate-900 placeholder:text-slate-500 focus-visible:border-brand-600 focus-visible:outline-offset-0"
                />
                <Button type="submit" loading={sending} disabled={!text.trim()}>
                  보내기
                </Button>
              </div>
            </form>
          )}
        </div>
      </div>
      {/*
        스크롤 기준점은 입력창 자리(빈 공간) "뒤"에 둔다. 목록 끝에 두면 고정 입력창(+ 모바일 하단 메뉴)이 마지막 말풍선을 덮는다.
        scroll-margin 으로 하단 메뉴 높이만큼 더 올려, 입력창이 메뉴 위에 오고 마지막 말풍선이 그 위에 온전히 보이게 한다.
      */}
      <div
        ref={endRef}
        data-testid="chat-end"
        className="scroll-mb-[calc(var(--bottom-nav-h)+0.5rem+env(safe-area-inset-bottom))] md:scroll-mb-4"
      />
    </div>
  );
}
