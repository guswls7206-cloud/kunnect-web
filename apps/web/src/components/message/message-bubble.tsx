import type { Message } from "@/lib/api/types";
import { formatDateTime } from "@/lib/format";

const TYPE_LABEL: Partial<Record<Message["type"], string>> = {
  VERIFY_QUESTION: "소유 확인 질문",
  VERIFY_ANSWER: "소유 확인 답변",
};

export function MessageBubble({ message, mine }: { message: Message; mine: boolean }) {
  if (message.type === "SYSTEM") {
    return (
      <li className="my-1 text-center text-xs text-slate-600">
        <span className="inline-block rounded-full bg-white/80 px-3 py-1 ring-1 ring-slate-200/70">
          {message.body}
        </span>
      </li>
    );
  }
  const label = TYPE_LABEL[message.type];
  return (
    <li className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
      {label && <span className="mb-0.5 text-[11px] font-semibold text-brand-700">{label}</span>}
      <p
        className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm leading-relaxed shadow-sm ${
          mine
            ? "rounded-br-md bg-brand-600 text-white"
            : "rounded-bl-md bg-white text-slate-900 ring-1 ring-slate-200/70"
        }`}
      >
        {message.body}
      </p>
      <time dateTime={message.createdAt} className="mt-1 text-[11px] text-slate-600">
        {formatDateTime(message.createdAt)}
      </time>
    </li>
  );
}
