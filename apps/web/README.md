# KUnnect 웹(프런트엔드)

Next.js(App Router) + TypeScript + Tailwind CSS 기반 반응형 웹/PWA. 계획은 `docs/dev-plan-frontend.md`, API 계약은 백엔드의 `apps/api/openapi.yaml`을 따른다.

## 실행

```bash
pnpm install
cp .env.example .env.local   # 목 모드(NEXT_PUBLIC_API_MOCK=true)가 기본
pnpm dev                     # http://localhost:3000
```

- 데모 계정(목 전용): `demo_a` / `demo1234`, `demo_b` / `demo1234`
- 실서버 연결: `.env.local`에서 `NEXT_PUBLIC_API_MOCK=false`, `API_ORIGIN=<API 주소>` 로 바꾼다. 브라우저는 `/api/v1/*`, `/files/*`만 호출하고 Next.js rewrites가 API로 프록시한다(CORS 없음).

## 스크립트

| 명령 | 설명 |
|---|---|
| `pnpm dev` / `pnpm build` / `pnpm start` | 개발 / 빌드 / 실행 |
| `pnpm typecheck` | 라우트 타입 생성 + `tsc --noEmit` |
| `pnpm lint` | ESLint |
| `pnpm test` | Vitest(MSW 목 서버 사용) |
| `pnpm test:e2e` | Playwright E2E(아래 "테스트" 참고) |
| `node scripts/generate-icons.mjs` | PWA 아이콘 재생성 |

## 구조

- `src/lib/api/` 타입·fetch 래퍼·엔드포인트 함수(화면은 `api.*`만 사용)
- `src/mocks/` MSW 핸들러·시드(브라우저/테스트 공용)
- `src/features/` 도메인별 훅·스키마, `src/components/` 공통/도메인 컴포넌트
- 위치 시드는 글로컬캠퍼스 건물 12곳(학생회관 … 글로컬이음관, 기타). "기타"를 고르면 장소를 직접 입력한다. 층 정보는 없고 좌표는 가짜 값이다.

## 테스트

- `pnpm test`: Vitest 단위·컴포넌트 테스트(`tests/`). jsdom + MSW 목 서버.
- `pnpm test:e2e`: Playwright E2E(`e2e/`). `test` 에는 포함되지 않는다.
  - 브라우저를 내려받지 않고 **설치된 Chrome**(`channel: "chrome"`)을 쓴다. Chrome 이 없으면 실행되지 않는다.
  - 목 모드 dev 서버를 따로 띄운다(기본 포트 3500, `E2E_PORT` 로 변경). 이미 떠 있으면 재사용한다(CI 제외).
  - Next.js 는 같은 빌드 폴더(`.next`)로 dev 서버 두 개를 띄우지 못하므로, E2E 서버는 `NEXT_DIST_DIR=.next-e2e` 로 빌드 폴더를 분리한다. 그래서 `pnpm dev`(:3000)와 동시에 실행할 수 있다.
  - 목 DB 는 페이지를 새로 불러올 때마다 시드로 돌아가고, 테스트마다 새 브라우저 컨텍스트를 쓰므로 테스트끼리 상태가 섞이지 않는다.
  - CI: Chrome 이 있는 러너를 쓰거나, `pnpm exec playwright install chromium` 후 설정의 `channel` 을 빼고 실행한다. `CI` 환경변수가 있으면 기존 서버를 재사용하지 않는다.

## 디자인 토큰 요약 (`src/app/globals.css`)

로그인 화면(KU 초록 강조 + slate 무채색 + 흰 베일 위 옅은 초록 그라데이션)을 앱 전체 기준으로 삼는다.

- `brand-50`~`900`: KU 초록(#0f6e3a)을 `brand-600` 으로 둔 초록 스케일. hover·진한 글자 `brand-700`(#0b5a2f), 옅은 배경 `brand-50`(#ecf7f0). 대비: 흰 글자 600 6.3:1·700 8.3:1, 흰 배경 위 600 글자 6.3:1.
- `zinc-*`: **slate 값으로 재정의**되어 있다. 기존 `zinc-*` 클래스가 그대로 slate 톤이 되며, `slate-*` 를 써도 같은 색이다.
- `ku-green`(#0f6e3a): 로고 아이콘·워드마크 "KU". `brand-600` 과 같은 값.
- `lost` / `lost-bg`(주황), `found` / `found-bg`(파랑): 분실·습득 배지 색. 습득은 브랜드(초록)와 구분되도록 파랑을 유지한다.
- 유틸리티: `card`(흰 배경·rounded-2xl·옅은 테두리·`shadow-card`), `bg-page` / `bg-page-ku`(흰 베일 + 초록 그라데이션 배경).
- 기타 변수: `--page-veil`·`--page-gradient-ku`(배경 레이어, body·로그인·메인 공통; `--page-gradient` 는 이전 이름 호환), `--bottom-nav-h`(모바일 하단 메뉴 높이, 하단 고정 요소가 참조).
- 포커스 링은 `@layer base` 의 `:focus-visible`(2px `brand-600`)이며 `focus-visible:outline-*` 유틸리티로 덮어쓸 수 있다.

## 공용 컴포넌트

- `ui/page-header` `PageHeader`: 주요 화면 제목. 카드 밖 위쪽에 h1 하나(`title`, `subtitle`, `actions`).
- `ui/states` `ErrorState` 의 `variant`
  - `page`(기본): 화면 전체를 대신하는 오류. 카드 안에 h1·메시지·다시 시도·홈으로.
  - `section`: 목록·댓글 등 화면 일부의 오류. 제목 없이 메시지와 다시 시도만(h1 중복 방지). 필요하면 바깥을 `card` 로 감싼다.
  - `notice`: 오류가 아닌 안내(API 404 로 대상이 없음, 남의 글이라 권한 없음 등). 중립 톤과 주요 버튼 하나. `action`({href,label}, 기본 홈으로 "/")·`icon`(`search` 기본 / 권한 안내는 `lock`)으로 바꾼다.
  - `EmptyState` 는 항상 `card` 안에 그려진다.
- `ui/button` `Button`: `variant`(primary/secondary/danger/ghost), `size`(`md` 44px 기본, `lg` 48px 주요 제출). 링크용 `linkButtonClass`, `secondaryLinkClass`.
- `ui/field`: `Field`(라벨·도움말·오류 연결), `inputClass`(48px 입력칸), `inputIconClass`(왼쪽 아이콘 `absolute left-4 size-5`), `inputIconWithActionClass`(오른쪽 버튼까지).
- `ui/toast` `useToast().show(message, tone)`: 모바일은 헤더 아래 가운데, md 이상은 헤더 아래 오른쪽 위에 표시해 하단 메뉴·쪽지 입력창을 가리지 않는다. 열린 모달 대화상자 위에도 보이도록 popover(top layer)로 띄우며, 스크린리더 안내는 별도 live 영역이 담당한다.
- `ui/badge` `CountBadge` / `UnreadSrText`: 읽지 않은 개수(숫자는 시각용, 스크린리더는 "(읽지 않음 N)").
