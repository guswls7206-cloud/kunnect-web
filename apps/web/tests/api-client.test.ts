import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { apiFetch } from "@/lib/api/client";
import { api } from "@/lib/api/endpoints";
import { server } from "@/mocks/server";

/** 받은 요청의 Content-Type 과 본문을 그대로 돌려주는 확인용 핸들러 */
function echoHandler() {
  let seen: { contentType: string | null; body: string } | null = null;
  server.use(
    http.all("*/api/v1/__echo", async ({ request }) => {
      seen = { contentType: request.headers.get("content-type"), body: await request.text() };
      return HttpResponse.json({ ok: true });
    }),
  );
  return () => seen;
}

describe("apiFetch Content-Type", () => {
  it.each(["POST", "PATCH", "PUT", "DELETE"] as const)(
    "본문 없는 %s 요청에는 Content-Type 을 붙이지 않는다",
    async (method) => {
      const seen = echoHandler();
      await apiFetch("/__echo", { method });
      expect(seen()).toEqual({ contentType: null, body: "" });
    },
  );

  it("본문 있는 요청은 application/json 으로 보낸다", async () => {
    const seen = echoHandler();
    await apiFetch("/__echo", { method: "POST", body: { a: 1 } });
    expect(seen()).toEqual({ contentType: "application/json", body: '{"a":1}' });
  });
});

describe("목 서버(백엔드와 같은 규칙)", () => {
  it("application/json 인데 본문이 비어 있으면 400 으로 거절한다", async () => {
    const res = await fetch("/api/v1/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("FST_ERR_CTP_EMPTY_JSON_BODY");
  });

  it("본문 없는 상태 변경 요청(로그아웃·모두 읽음)이 정상 처리된다", async () => {
    await api.auth.login({ loginId: "demo_a", password: "demo1234" });
    await api.notifications.readAll();
    await api.auth.logout();
    await expect(api.me.get()).rejects.toMatchObject({ status: 401 });
  });
});
