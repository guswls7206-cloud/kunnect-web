# KUnnect 프런트엔드 개발 계획 (데모)

> 기준 문서: `README.md`(main, 7d5cae1). 표기 규칙은 README와 동일하다. **[확정]** = 사용자 결정, **[가정/제안]** = 임시 결정(확인 필요).
> API 계약은 백엔드 문서(`docs/dev-plan-backend.md`, feature/backend)가 **기준(authoritative)** 이다. 이 문서의 API 표는 프런트 관점의 요구·가정이며, 충돌 시 백엔드 문서를 따르고 차이는 11절에서 합의한다.
> 구성원: 개발자 2인(프런트/백엔드 분담). 이 문서는 프런트 담당 범위만 다룬다.

## 1. 범위 / 담당

**담당**: 반응형 웹 + PWA 클라이언트 전체(README 1·8·9절). 서버·DB·매칭·Claude API 호출은 백엔드 담당이다.

| 영역 | 화면(README 9절) | 비고 |
|---|---|---|
| 인증 | 1. 회원가입/로그인 | 아이디·비밀번호·닉네임, 세션 쿠키 [확정 3번] |
| 글 작성 | 3. 분실/습득 글 작성 | 사진 0~3장(선택), 위치(목록+지도), 일시, 태그(프리셋+직접 입력), 설명, (습득) 보관 장소 |
| 글 목록/상세 | 2. 홈 피드, 4. 글 상세 | 분실/습득 탭, 검색·필터, 사진 캐러셀 |
| 댓글 | 4. 글 상세 하단 | 대댓글 1단계, 수정/삭제/신고, 마스킹 안내 |
| 매칭/알림 | 5. 매칭 결과, 6. 알림 센터 | 유사도 등급, 맞아요/아니에요, 폴링 |
| 쪽지 | 7. 쪽지함, 8. 쪽지 대화 | 폴링, 읽지 않음, 소유 확인 질문, 인수 완료 요청 |
| 프로필/차단 | 9. 프로필, 11. 설정 일부 | 차단·신고, 차단 목록 |
| 내 활동/설정 | 10, 11 | 상태 변경(반환 완료·삭제), 알림 on/off, 로그아웃 |

**범위 밖**: 서버 로직, 관리자 화면, 스토어 배포, WebSocket(이후 단계), 이미지 쪽지.

## 2. 기술 선택

| 영역 | 선택 [가정/제안] | 이유 |
|---|---|---|
| 프레임워크 | Next.js(App Router) + TypeScript | README 8절. 라우팅·번들·PWA 대응 용이 |
| 렌더링 | 대부분 클라이언트 컴포넌트(CSR) + 공개 글 상세만 SSR 선택 | 세션 쿠키 기반 데모, 단순성 우선. SSR 필요성은 호스팅(N3) 확정 후 재검토 |
| 데이터 패칭 | TanStack Query | 캐시·재시도·`refetchInterval` 폴링·낙관적 업데이트 |
| 폼/검증 | React Hook Form + Zod | 스키마를 API 타입과 공유, 에러 표시 일관 |
| 스타일 | Tailwind CSS (+ headless 컴포넌트: Radix UI) | 모바일 우선 반응형, 접근성 기본 제공 |
| 상태 | 서버 상태=TanStack Query, UI 상태=React state/Context(필요 시 Zustand 최소) | 전역 스토어 최소화 |
| API 클라이언트 | `fetch` 래퍼(`credentials: 'include'`) + 타입(수동 또는 OpenAPI 생성) | 백엔드가 OpenAPI 제공 시 타입 생성 [가정/제안] |
| 이미지 업로드 | 클라이언트 압축(긴 변 ~1024px, `browser-image-compression` 등) → `multipart/form-data` | README 3·5.5절. EXIF 제거는 서버가 최종 보장, 클라이언트도 재인코딩으로 1차 제거 |
| 지도 | 시설 목록 선택을 기본 + 지도 핀은 보조. SDK는 미정(README 8절) | 지도 제공자 미결정이므로 지도 컴포넌트를 어댑터로 분리, 목록 선택만으로 작성 가능하게 설계 |
| PWA | `manifest.webmanifest` + 서비스워커(Serwist 또는 `next-pwa` 계열) | 설치 가능, 앱 셸 캐시. API 응답은 캐시하지 않음(네트워크 우선) |
| Web Push | 선택 기능(N2). 서비스워커 `push` 핸들러 + 구독 등록 UI를 마지막 단계에 | iOS는 홈 화면 설치 필요(README 13절). 기본 경로는 앱 내 알림 센터 |
| 테스트 | Vitest + Testing Library(컴포넌트), Playwright(시연 시나리오 E2E 1~2개) | 데모 범위에 맞춰 최소화 |
| 모킹 | MSW(Mock Service Worker) | 5절 참조 |
| 품질 | ESLint, Prettier, `tsc --noEmit`, Lighthouse(PWA/접근성) | |
| 패키지 매니저 | pnpm [가정/제안] | 백엔드와 모노레포 여부 미정(11절) |

## 3. 프로젝트 / 폴더 구조 [가정/제안]

레포 구조(모노레포 vs 분리)는 백엔드 개발자와 합의 필요(11절). 아래는 `web/` 하위 단독 앱 기준이다.

```
web/
├─ public/                 # manifest, 아이콘, 오프라인 페이지
├─ src/
│  ├─ app/                 # App Router 라우트(4절)
│  │  ├─ (auth)/login, signup
│  │  ├─ (main)/          # 로그인 필요 영역(공통 레이아웃: 하단 탭/헤더)
│  │  └─ sw.ts            # 서비스워커 진입
│  ├─ components/
│  │  ├─ ui/              # 버튼·입력·칩·모달·토스트 등 공통
│  │  ├─ post/            # PostCard, PostForm, PhotoPicker, TagInput, LocationPicker
│  │  ├─ comment/         # CommentList, CommentItem, CommentForm
│  │  ├─ match/           # MatchCard, ScoreBadge
│  │  ├─ message/         # ConversationList, MessageBubble, MessageInput, VerifyPanel
│  │  └─ layout/          # AppShell, BottomNav, Header
│  ├─ features/           # 도메인별 훅·쿼리·스키마(auth, posts, comments, matches, notifications, messages, blocks, reports)
│  ├─ lib/                # api 클라이언트, 이미지 압축, 날짜 포맷, 폴링 훅
│  ├─ mocks/              # MSW 핸들러·시드 데이터
│  └─ types/              # API 타입(계약 기준)
└─ tests/                 # unit, e2e
```

## 4. 페이지 / 라우트 목록 [가정/제안]

| 경로 | 화면 | 인증 |
|---|---|---|
| `/login`, `/signup` | 로그인/가입 | 불필요 |
| `/` | 홈 피드(분실/습득 탭, 검색·필터) | 필요 [가정/제안: 비로그인 열람 허용 여부는 11절] |
| `/posts/new?type=lost\|found` | 글 작성 | 필요 |
| `/posts/[id]` | 글 상세 + 댓글 | 필요 |
| `/posts/[id]/edit` | 글 수정 | 작성자 |
| `/posts/[id]/matches` | 매칭 결과(내 글 기준 후보) | 작성자 |
| `/notifications` | 알림 센터 | 필요 |
| `/messages` | 쪽지함 | 필요 |
| `/messages/[conversationId]` | 쪽지 대화 | 참여자 |
| `/users/[id]` | 사용자 프로필(공개 글, 쪽지 보내기, 차단/신고) | 필요 |
| `/me` | 내 활동(내 글·내 댓글·상태 변경) | 필요 |
| `/settings` | 알림 on/off, Web Push, 차단 목록, 비밀번호 변경, 로그아웃 | 필요 |
| `/offline` | 오프라인 안내 | 불필요 |

- 하단 탭(모바일): 홈 / 글쓰기 / 알림(배지) / 쪽지(배지) / 내 정보. 데스크톱은 상단 헤더 + 중앙 컬럼 레이아웃.
- 알림 항목 탭 이동: MATCH → `/posts/[id]/matches`, COMMENT·REPLY → `/posts/[id]#comment-{id}`, MESSAGE → `/messages/[id]` (README 9절 6번).

## 5. 컴포넌트 목록

- **공통 UI**: Button, Input, Textarea, Select, Chip, Modal/BottomSheet, Toast, Badge(읽지 않음), Skeleton, EmptyState, ErrorState, ConfirmDialog.
- **레이아웃**: AppShell, BottomNav, Header, AuthGuard.
- **글**: PostCard, PostList(무한 스크롤 또는 더보기), PostFilterBar, PostForm(분실/습득 분기), PhotoPicker(0~3장·미리보기·삭제·압축), TagInput(프리셋 칩+직접 입력), LocationPicker(목록 + 지도 어댑터), DateTimePicker, PhotoCarousel, PostStatusBadge.
- **댓글**: CommentList, CommentItem(답글/수정/삭제/신고, "수정됨"·"삭제된 댓글입니다"), CommentForm(글자 수, "개인 연락은 쪽지로" 안내, 마스킹 결과 반영 표시), 상태 RETURNED/CLOSED 시 입력 비활성.
- **매칭**: MatchCard(유사도 등급·위치 차이·AI 근거 한 줄), ScoreBadge, MatchActions(맞아요/아니에요).
- **알림**: NotificationItem, NotificationList, 폴링 훅 `useUnreadCounts`.
- **쪽지**: ConversationList/Item(읽지 않음 배지), MessageBubble, MessageInput(1,000자), PostContextCard(글 맥락), VerifyPanel(소유 확인 질문/답변, 인수 완료 요청), ConversationMenu(차단/신고/나가기/음소거).
- **프로필/신고/차단**: UserHeader, ReportDialog(사유 선택), BlockList.
- **PWA**: InstallPrompt, PushSubscribeToggle(선택).

## 6. 백엔드에 필요한 API (프런트 요구 — 가정, 백엔드 문서가 기준)

README 14·15절에 명시된 엔드포인트는 그대로 사용하고, 나머지는 프런트 필요에 따른 **제안**이다.

| 구분 | 메서드·경로 [가정] | 용도 | 출처 |
|---|---|---|---|
| 인증 | `POST /auth/signup`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `PATCH /auth/password` | 세션 쿠키 인증 | 제안 |
| 글 | `GET /posts`(type, status, tag, location, q, cursor/page), `POST /posts`, `GET /posts/{id}`, `PATCH /posts/{id}`, `DELETE /posts/{id}`, `POST /posts/{id}/status`(반환 완료/종료) | 피드·작성·상세·상태 | 제안 |
| 사진 | `POST /posts`에 multipart 포함, 또는 `POST /posts/{id}/photos` | 업로드 방식 택일 필요 | 제안(11절) |
| 메타 | `GET /locations`, `GET /tags/presets` | 위치 시드, 프리셋 태그 | 제안 |
| 댓글 | `GET/POST /posts/{id}/comments`, `PATCH/DELETE /comments/{id}` | 댓글 | README 14절 |
| 매칭 | `GET /posts/{id}/matches`, `POST /matches/{id}/confirm`, `POST /matches/{id}/reject` | 후보 조회, 맞음/아님 | 제안 |
| 알림 | `GET /notifications`, `POST /notifications/{id}/read`, `POST /notifications/read-all`, `GET /notifications/unread-count`(또는 통합 요약) | 알림 센터·배지 폴링 | 제안 |
| 쪽지 | `POST /conversations`, `GET /conversations`, `GET/POST /conversations/{id}/messages`, `POST /conversations/{id}/read` | 쪽지 | README 15절 |
| 쪽지 부가 | `PATCH /conversations/{id}`(음소거), `DELETE /conversations/{id}`(나가기), 소유 확인/인수 완료용 `POST /conversations/{id}/handover`(요청·검증·완료) | 인수 협의 | 제안 |
| 차단/신고 | `POST/DELETE /blocks`, `GET /blocks`, `POST /reports` | 차단 목록, 신고 | README 15절 + 제안 |
| 프로필 | `GET /users/{id}`, `GET /users/{id}/posts` | 프로필 | 제안 |
| 설정 | `GET/PATCH /me/settings`, `POST/DELETE /me/push-subscription` | 알림 on/off, Web Push | 제안(Push는 N2) |

**공통 요구**: 에러 응답 형식(코드·메시지·필드 오류), 페이지네이션 방식, 시간은 ISO 8601(UTC), 인증은 세션 쿠키(CORS·`SameSite` 설정은 11절), 폴링 가능한 가벼운 요약 엔드포인트(`since`/ETag 지원 시 이득).

## 7. Mock 우선 전략

백엔드 완성을 기다리지 않도록 **계약 우선 + MSW**로 개발한다.

1. 1주차에 6절을 바탕으로 `types/`(요청·응답 타입, Zod 스키마)를 작성하고 백엔드 문서와 대조·합의한다.
2. MSW 핸들러 + 시드 데이터(분실/습득 쌍, 댓글, 쪽지, 알림, 매칭 후보 0.6~0.8 / 0.8+ 케이스)를 `mocks/`에 둔다. 위치 시드는 N1 확정 전까지 **가짜 이름 목록(플레이스홀더)** 으로 쓰고 실제 목록처럼 표기하지 않는다.
3. 환경변수 `NEXT_PUBLIC_API_MOCK=true|false`로 모킹 on/off. 핸들러는 지연·오류(401/403/409/413/422/429/5xx) 시나리오를 포함해 로딩·에러 UI를 검증한다.
4. 백엔드 API가 준비되는 순서대로 실서버로 전환(도메인별 스위치). 전환 시 계약 불일치는 즉시 11절 채널로 보고한다.
5. 시연용 오프라인 폴백: 실서버 불안정 시 mock 모드로 시연 가능하도록 유지 [가정/제안].

## 8. 폴링 설계 [확정 18번: MVP는 폴링]

| 대상 | 간격 [가정/제안] | 조건 |
|---|---|---|
| 알림·쪽지 읽지 않음 배지 | 15초 | 로그인 + 탭 가시(`document.visibilityState`) |
| 쪽지 대화 메시지 | 5초(README 5~10초) | 대화 화면 열림 + 가시 상태. 마지막 메시지 id 이후만 요청(`after`) |
| 쪽지함 목록 | 10초 | 쪽지함 화면 |
| 글 상세 댓글 | 폴링 없음(수동 새로고침/작성 후 무효화) | 부하 최소화 |

- TanStack Query `refetchInterval`을 가시 상태에서만 활성, 백그라운드 탭은 중지, 오류 시 지수 백오프.
- 전송 직후 낙관적 반영 → 실패 시 재시도 UI. 중복 방지를 위해 클라이언트 임시 id와 서버 id 매핑.
- Web Push 사용 시에도 폴링은 유지(보완 경로).

## 9. 반응형 / PWA / 접근성 체크리스트

**반응형**
- [ ] 모바일 우선(360px 기준) → 태블릿/데스크톱에서 중앙 컬럼(최대 폭 제한) 확장
- [ ] 터치 타깃 44px 이상, 하단 탭과 가상 키보드 겹침 처리(쪽지 입력창)
- [ ] 가로 스크롤 없음, 이미지 비율 고정(레이아웃 시프트 방지), safe-area 대응

**PWA**
- [ ] manifest(이름 KUnnect, 아이콘 192/512·maskable, `display: standalone`, theme/background color)
- [ ] 서비스워커: 앱 셸 사전 캐시, API는 네트워크 우선, 오프라인 페이지
- [ ] 설치 유도(Android `beforeinstallprompt`, iOS는 안내 문구)
- [ ] Lighthouse PWA/성능/접근성/SEO 점검 기록
- [ ] (선택) Web Push 구독·수신·클릭 시 이동. iOS 설치 필요 안내. 알림 문구는 README 사양 그대로, 상세·위치 미포함(README 10절)

**접근성(a11y)**
- [ ] 시맨틱 마크업, 폼 라벨·오류 메시지 연결(`aria-describedby`), 포커스 링 유지
- [ ] 키보드 조작 가능(모달 포커스 트랩, ESC 닫기), 이미지 대체 텍스트(사용자 사진은 제목 기반)
- [ ] 색 대비 WCAG AA, 색에만 의존하지 않는 상태 표시(유사도 등급은 텍스트 병기)
- [ ] 새 메시지·토스트에 `aria-live`, 읽지 않음 배지에 접근 가능한 이름
- [ ] `prefers-reduced-motion` 존중

**안전/개인정보(프런트 측)**
- [ ] 사진 업로드 전 압축·재인코딩, 민감 정보(얼굴·학생증) 주의 안내와 "Claude API로 전송" 안내 문구(README 10절)
- [ ] 댓글 입력 시 "개인 연락은 쪽지로" 안내, 서버 마스킹 결과 표시
- [ ] 인수 협의 시 공공장소 권장 안내, 앱에 연락처 입력란 없음
- [ ] 차단 사실은 상대에게 비노출, 차단된 대화는 읽기 전용 표시

## 10. 작업 분해 / 일정 [가정/제안]

README 12절(설계 1주 + 개발 3~4주 + 점검 1주 ≈ 5~6주)에 맞춘 프런트 일정이다. 1인 기준 영업일 추정이며 백엔드 연동 지연 시 mock으로 병행한다.

| 마일스톤 | 기간 | 작업(순서) | 일수 |
|---|---|---|---|
| **M0 설계·세팅** | 1주 | ① Next.js/TS/Tailwind/ESLint/CI 초기화 ② 디자인 토큰·공통 UI 기본 ③ 화면 와이어/플로우 확정(README 9절) ④ API 타입·MSW 골격, 백엔드와 계약 대조 ⑤ PWA manifest·서비스워커 골격 | 5 |
| **M1 인증 + 글 핵심** | 1주 | ⑥ AppShell/라우팅/AuthGuard ⑦ 가입/로그인/로그아웃 ⑧ 홈 피드(탭·필터·카드) ⑨ 글 상세(캐러셀) | 5 |
| **M2 글 작성** | 약 1주 | ⑩ PostForm 분실/습득 분기 ⑪ PhotoPicker(압축·미리보기) ⑫ TagInput·LocationPicker(목록 우선, 지도 어댑터) ⑬ 내 활동·글 상태 변경·수정/삭제 | 5 |
| **M3 댓글 + 알림 + 매칭** | 1주 | ⑭ 댓글(작성/수정/삭제/대댓글/신고/상태 비활성) ⑮ 알림 센터·배지 폴링 ⑯ 매칭 결과 화면(맞아요/아니에요) | 5 |
| **M4 쪽지 + 프로필/차단** | 1주 | ⑰ 쪽지함·대화(폴링·읽지 않음·글 맥락) ⑱ 소유 확인 질문/인수 완료 요청 UI ⑲ 프로필·차단·신고·설정(차단 목록) | 5~6 |
| **M5 통합·PWA·점검** | 1주 | ⑳ mock→실서버 전환·계약 불일치 수정 ㉑ PWA 완성(오프라인·설치), Web Push(N2 확정 시) ㉒ 반응형·a11y·Lighthouse 점검 ㉓ 시연 시나리오 E2E ㉔ 버그 수정 | 5 |
| **합계** | 약 5~6주 | | 약 26~27 |

- 지도 SDK(미정)·Web Push(N2)는 확정이 늦어지면 M5로 이월하고, M2는 목록 선택만으로 완료 처리한다.
- 통합(M5)에만 몰리지 않도록 M1부터 도메인별로 백엔드가 준비되는 대로 전환한다.

## 11. 마일스톤별 완료 정의(DoD)

| 마일스톤 | 완료 조건 |
|---|---|
| M0 | 빌드·린트·타입체크 통과, 공통 UI 스토리/예시 화면, 계약 타입이 백엔드 문서와 대조 완료, mock 모드로 앱 기동 |
| M1 | 가입→로그인→피드→상세 흐름이 mock·실서버(가능 시) 모두 동작, 인증 만료(401) 처리, 로딩/빈/오류 상태 구현 |
| M2 | 분실/습득 글을 사진 0~3장·위치·태그와 함께 등록·수정·삭제, 사진 압축 확인, 폼 검증 메시지, 모바일 실기기 입력 확인 |
| M3 | 댓글 정책(대댓글 1단계·수정됨·삭제 자리 유지·RETURNED/CLOSED 비활성) 동작, 알림 배지 폴링과 알림 탭 이동, 매칭 결과에서 맞아요/아니에요 처리 |
| M4 | 글·프로필에서 쪽지 시작, 폴링 갱신·읽지 않음 배지, 소유 확인 질문→답변→인수 완료 요청 UI, 차단/신고 동작(차단 대화 읽기 전용) |
| M5 | README 4절 시연 시나리오(작성→매칭→알림→쪽지→인수 완료) E2E 통과, PWA 설치·오프라인 페이지 확인, Lighthouse·a11y 체크리스트(9절) 기록, 알려진 이슈 목록 문서화 |

## 12. 리스크 (프런트 관점)

| 리스크 | 영향 | 대응 |
|---|---|---|
| 백엔드 API 지연/계약 변경 | 일정 지연, 재작업 | mock 우선, 1주차 계약 합의, 변경은 문서 기준 버전 관리 |
| 지도 SDK 미정·위치 목록(N1) 미확정 | 위치 선택 지연 | 목록 선택 우선, 지도는 어댑터·후순위, 플레이스홀더 시드 |
| 사진 업로드(용량·EXIF·모바일 브라우저 차이) | 업로드 실패 | 클라이언트 압축·크기 제한·오류 UI, 실기기 테스트 |
| iOS Safari PWA/Web Push 제약 | 푸시 미수신 | 앱 내 알림 센터 기본, Push는 선택(N2) |
| 폴링 부하·배터리 | 서버 부하 | 가시 상태에서만, 가벼운 요약 API, 백오프 |
| 서버리스 호스팅 제약(N3) | 쿠키·SSR·백그라운드 동작 차이 | 호스팅 확정 시 SSR/CSR 구성 재검토 |
| 댓글 정책(#14) 변경 | UI 수정 | 제한 수치(300자·분당 5건)를 상수/설정으로 분리 |
| 범위 증가 | 일정 지연 | 쪽지 텍스트 전용, 대댓글 1단계, Web Push 후순위 |
| 접근성·반응형 점검 후반 집중 | 막판 수정 폭증 | 공통 UI 단계부터 체크리스트 적용 |

## 13. 백엔드 개발자와의 인터페이스 합의 / 미결 질문

**합의 요청(백엔드 문서에서 확정 후 반영)**
1. 레포 구조: 모노레포(`web/` + `server/`)인지 분리인지, 백엔드가 Next.js API Routes인지 별도 Node 서버인지. 별도 서버면 CORS·쿠키(`SameSite`, `Secure`, 도메인) 정책.
2. 인증: 세션 쿠키 방식 확정, CSRF 대책(토큰 헤더 등), 401/403 응답 규약.
3. 에러 응답 스키마, 페이지네이션(cursor vs page), 필드명 규칙(snake_case vs camelCase), 시간 표기.
4. 사진 업로드: 글 생성과 단일 multipart인지 별도 업로드 후 id 연결인지, 최대 크기·MIME, 서버 EXIF 제거·썸네일 URL 제공 여부.
5. OpenAPI(또는 공유 타입) 제공 여부 → 프런트 타입 자동 생성.
6. 폴링용 요약 엔드포인트(알림·쪽지 읽지 않음 수 통합), `after`/`since` 파라미터, ETag 지원.
7. 매칭 응답 필드: 유사도 등급 표현(점수 노출 여부), AI 근거 문구, 후보 구간(0.6~0.8)과 자동 연결(≥0.8)을 구분하는 필드, 사진 없는 글의 임계값(N4)이 프런트에 어떻게 전달되는지.
8. 소유 확인·인수 완료 API 형태(`VERIFY_QUESTION`/`VERIFY_ANSWER` 메시지 타입 사용 방식, `HandoverRequest` 상태 전이, 양측 확인 후 Post=RETURNED 처리 주체).
9. 댓글 마스킹 결과 응답(마스킹된 본문 반환, 마스킹 발생 여부 플래그), 삭제된 댓글 표현.
10. 위치 시드(`/locations`)와 프리셋 태그 제공 방식, 좌표 포함 여부(N1).
11. 차단 상태 노출 규칙(차단된 대화 읽기 전용 플래그, 상대에게 비노출) 응답 필드.
12. 비로그인 사용자의 글 열람 허용 여부(피드·상세 공개 범위).

**사용자 확인 필요(README 미결과 연계)**
- N1 캠퍼스 위치 목록·좌표, N2 Web Push 포함 여부, N3 호스팅, 지도 제공자, 닉네임 규칙(N5), 댓글 정책 수치(#14) — 확정 전까지 위 [가정/제안] 값으로 진행한다.

## 14. 이 문서의 [가정/제안] 요약

pnpm·TanStack Query·RHF+Zod·Tailwind/Radix·MSW·Serwist 등 도구 선택, 라우트 구조, 폴링 간격(배지 15초/대화 5초/목록 10초), 지도는 목록 우선·어댑터 분리, 일정·일수 배분, 6절 API 중 README에 없는 항목 전부. 백엔드 문서와 불일치하면 백엔드 문서를 따른다.

## 15. 구현 반영 메모 (M0~M2, 계획 대비 변경)

- 위치: `web/` → **`apps/web/`**. 패키지 매니저는 pnpm, 모노레포 루트 워크스페이스는 두지 않음(앱 단독).
- API 계약의 기준은 `apps/api/openapi.yaml`. 글 상세는 평탄 응답(`{post}` 래퍼는 생성 응답에만), 태그는 문자열 배열, 사진 업로드는 2단계(`POST /photos` → `photoIds`).
- PWA: Serwist 대신 `app/manifest.ts` + 직접 작성한 `public/sw.js`(오프라인 안내 페이지만 캐시, API 비캐시). MSW 서비스워커와 범위가 겹쳐 **목 모드에서는 PWA 서비스워커를 등록하지 않음**.
- 동일 오리진: Next.js `rewrites`로 `/api/*`, `/files/*` 프록시(`API_ORIGIN`). 목 모드는 `NEXT_PUBLIC_API_MOCK=true`.
- 위치 선택은 목록 우선(건물 → 층). 지도 핀은 미구현(지도 SDK 미정). 위치 시드는 글로컬캠퍼스 건물 12곳(사용자 지정, "기타"는 장소 직접 입력).
- 비로그인 열람 불가(계약): 모든 화면이 로그인 필요.
- (M3) 배지 폴링은 `GET /notifications/unread-count`(15초), `/me`의 unread는 시작 스냅샷으로만 사용. 피드 건물 필터는 `buildingId`. 알림 이동: match→`/posts/{postId}/matches`, comment→`/posts/{postId}#comment-{id}`, conversation→`/messages/{id}`.
- (M3) 매칭 화면은 등급(HIGH/MID)과 AI 의견만 표시, 확인/제외는 분실글 작성자만. 댓글은 대댓글 1단계, 마스킹 결과(`masked`)는 토스트로 안내.
- (M4) 쪽지 폴링: 대화 5초(`afterId` 커서는 서버에서 받은 마지막 id만 따름 — 내가 보낸 메시지 id로 앞당기면 상대 메시지를 놓칠 수 있음), 쪽지함·대화 메타 10초, 배지 15초. 차단 사실은 "이 대화에서는 메시지를 보낼 수 없어요" 중립 문구로만 표시.
- (M4) 인수(Handover) 역할은 관련 글(postContext) 유형·작성자 여부로 판단. 계약에 대화별 handover 상태·내 완료 여부가 없어 `ConversationItem.handover`를 [제안] 필드로 가정(백엔드 확인 필요).
