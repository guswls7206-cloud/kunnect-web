"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

interface ToastItem {
  id: number;
  message: string;
  tone: "info" | "error";
}

const ToastContext = createContext<{
  show: (message: string, tone?: ToastItem["tone"]) => void;
} | null>(null);

/**
 * 보이는 토스트 영역을 최상위 레이어(top layer)의 맨 위로 올린다.
 * 열린 모달 대화상자(<dialog>)도 top layer 에 있어 z-index 로는 위에 그릴 수 없으므로 popover 로 띄우고,
 * 다시 열면(hide → show) top layer 의 맨 위로 이동한다. popover 를 지원하지 않으면 일반 fixed 요소로 둔다.
 */
function raiseToTopLayer(el: HTMLElement | null) {
  if (!el || typeof el.showPopover !== "function") return;
  try {
    if (!el.hasAttribute("popover")) el.setAttribute("popover", "manual");
    try {
      el.hidePopover();
    } catch {
      // 아직 열려 있지 않으면 예외가 날 수 있다.
    }
    el.showPopover();
  } catch {
    // 지원하지 않는 환경은 무시한다.
  }
}

/**
 * 지금 열려 있는 가장 위의 모달 대화상자(없으면 null).
 * showModal 을 지원하지 않는 환경(테스트용 jsdom 등)에서는 열린 dialog 를 모달로 간주한다.
 */
function topmostModalDialog(): HTMLDialogElement | null {
  const supportsModal =
    typeof HTMLDialogElement !== "undefined" &&
    typeof HTMLDialogElement.prototype.showModal === "function";
  let list: NodeListOf<HTMLDialogElement>;
  try {
    list = document.querySelectorAll<HTMLDialogElement>(
      supportsModal ? "dialog:modal" : "dialog[open]",
    );
  } catch {
    list = document.querySelectorAll<HTMLDialogElement>("dialog[open]");
  }
  return list.length ? list[list.length - 1] : null;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const show = useCallback((message: string, tone: ToastItem["tone"] = "info") => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, message, tone }]);
    setTimeout(() => setItems((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const value = useMemo(() => ({ show }), [show]);

  const visualRef = useRef<HTMLDivElement>(null);
  const hasItemsRef = useRef(false);
  const hasItems = items.length > 0;

  // 새 토스트가 생기면 맨 위로 올린다.
  useEffect(() => {
    hasItemsRef.current = hasItems;
    if (hasItems) raiseToTopLayer(visualRef.current);
  }, [items, hasItems]);

  /*
   * 모달 대화상자가 열려 있으면 그 바깥은 모두 inert 가 되어(top layer 에서 모달보다 위로 올린 popover 포함)
   * 스크린리더가 live 영역 안내를 읽지 못한다. 그래서 열린 모달이 있는 동안에는 live 영역을 그 모달 안으로 옮긴다.
   * 동시에 보이는 토스트도 모달 위로 다시 올린다.
   */
  const [modalHost, setModalHost] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    let current: HTMLDialogElement | null = null;
    const sync = () => {
      const next = topmostModalDialog();
      if (next === current) return;
      current = next;
      setModalHost(next);
      if (next && hasItemsRef.current) raiseToTopLayer(visualRef.current);
    };
    // 대화상자 열고 닫기(open 속성)와, 열린 채로 화면에서 빠지는 경우(childList)를 모두 따라간다.
    const observer = new MutationObserver(sync);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => observer.disconnect();
  }, []);

  const polite = items.filter((t) => t.tone === "info");
  const assertive = items.filter((t) => t.tone === "error");

  /*
   * 스크린리더 안내용 live 영역. 토스트마다 숨기거나 다시 열지 않아 안내가 끊기지 않는다(popover 재표시와 분리).
   * 빈 상태에서도 role 이 남지 않도록 role 대신 aria-live 만 쓴다. 항상 한 곳에만 존재한다.
   */
  const liveRegions = (
    <>
      <div aria-live="polite" className="sr-only" data-toast-live="polite">
        {polite.map((t) => (
          <p key={t.id}>{t.message}</p>
        ))}
      </div>
      <div aria-live="assertive" className="sr-only" data-toast-live="assertive">
        {assertive.map((t) => (
          <p key={t.id}>{t.message}</p>
        ))}
      </div>
    </>
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      {modalHost ? createPortal(liveRegions, modalHost) : liveRegions}
      {/*
        눈에 보이는 토스트. 안내는 위 live 영역이 담당하므로 스크린리더에서는 숨기고,
        글자는 CSS 생성 콘텐츠(data-message)로 그려 DOM 텍스트가 live 영역과 중복되지 않게 한다.
        헤더 아래 상단에 띄워 하단 메뉴·쪽지 입력창을 가리지 않는다. 모바일은 좌우 16px 안쪽 가운데, md 이상은 오른쪽 위.
      */}
      <div
        ref={visualRef}
        aria-hidden="true"
        className="pointer-events-none fixed inset-x-0 top-[calc(4rem+0.75rem+env(safe-area-inset-top))] bottom-auto z-50 m-0 flex h-auto w-auto flex-col items-center gap-2 overflow-visible border-0 bg-transparent px-4 md:top-[calc(4rem+1rem)] md:right-6 md:left-auto md:items-end md:px-0"
      >
        {items.map((t) => (
          <div
            key={t.id}
            data-message={t.message}
            className={`w-full max-w-sm rounded-xl px-4 py-3 text-sm text-white shadow-lg shadow-zinc-900/10 [overflow-wrap:anywhere] before:content-[attr(data-message)] md:w-auto ${
              t.tone === "error" ? "bg-red-700" : "bg-zinc-800"
            }`}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("ToastProvider 안에서만 useToast 를 쓸 수 있습니다.");
  return ctx;
}
