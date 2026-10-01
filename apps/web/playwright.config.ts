import { defineConfig } from "@playwright/test";

// E2E 회귀 테스트. 목(MSW) 모드 dev 서버를 별도 포트·별도 빌드 폴더로 띄워 일반 dev 서버(:3000)와 겹치지 않게 한다.
// 브라우저는 내려받지 않고 설치된 Chrome(channel: "chrome")을 쓴다.
const PORT = Number(process.env.E2E_PORT ?? 3500);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  // dev 서버는 첫 요청 때 화면을 컴파일하므로 여유를 둔다.
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  workers: 2,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    channel: "chrome",
    locale: "ko-KR",
    trace: "retain-on-failure",
  },
  webServer: {
    command: `pnpm exec next dev --port ${PORT}`,
    url: `${BASE_URL}/login`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: { NEXT_PUBLIC_API_MOCK: "true", NEXT_DIST_DIR: ".next-e2e" },
  },
});
