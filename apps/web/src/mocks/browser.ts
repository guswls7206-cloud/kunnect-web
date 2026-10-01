import { setupWorker } from "msw/browser";
import { getDb } from "./db";
import { handlers } from "./handlers";
import { resetDb } from "./seed";

const globalStore = globalThis as unknown as { __kunnectMockStarted?: Promise<void> };

/** 브라우저에서 MSW를 시작한다. 여러 번 호출해도 한 번만 시작한다. */
export function startMocking(): Promise<void> {
  if (!globalStore.__kunnectMockStarted) {
    resetDb();
    // 개발·E2E 보조: 다른 사용자의 행동(새 쪽지 도착 등)을 브라우저 콘솔/스크립트에서 흉내 낼 수 있게 노출한다.
    (window as unknown as { __kunnectMock?: unknown }).__kunnectMock = { getDb };
    globalStore.__kunnectMockStarted = setupWorker(...handlers)
      .start({ onUnhandledFrame: "bypass", quiet: true })
      .then(() => undefined);
  }
  return globalStore.__kunnectMockStarted;
}
