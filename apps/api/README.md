# KUnnect API (apps/api)

Fastify + Zod + Drizzle + PostgreSQL 백엔드. API 계약은 `openapi.yaml`(개발 중 `GET /docs` 에서 Swagger UI), 설계는 `docs/dev-plan-backend.md`.

## 사전 준비

- Node.js 22 이상(검증: 24.x), pnpm 10 이상(검증: 12.8). 
- Windows 는 저장소를 **짧은 경로**(예: `C:\work\KUnnect`)에 두는 것을 권장한다. 경로가 약 260자를 넘으면 embedded-postgres 의 `initdb.exe` 실행이 `ENOENT` 로 실패한다.
- pnpm 10+ 는 의존성 빌드 스크립트를 승인 없이 실행하지 않고 미승인이 있으면 설치를 실패시킨다. 승인 목록은 `pnpm-workspace.yaml` 의 `allowBuilds` 에 패키지별로 들어 있으니 별도 조치는 필요 없다(전체 허용 옵션은 쓰지 않는다).

## 빠른 시작

```bash
cd apps/api
pnpm install
cp .env.example .env              # 필요 값 수정(아래 환경 변수)

# 1) DB 실행 — 둘 중 하나
docker compose -f ../../docker-compose.yml up -d db   # Docker 가 있을 때 (postgres:18, 5432)
pnpm db:dev                                           # Docker 없이: embedded-postgres(공식 PG 바이너리), 별도 터미널에서 유지

# 2) 스키마·시드
pnpm db:migrate                   # 마이그레이션 0000~0008 적용(스키마 변경 시 pnpm db:generate 로 새 파일 생성)
pnpm db:seed                      # 위치(지정 12곳)·프리셋 태그
pnpm db:seed:demo                 # (선택) 시연용 계정·글·매칭·댓글·쪽지

# 3) 서버
pnpm dev                          # http://localhost:4000 (파일 변경 시 재시작)
```

확인: `curl localhost:4000/api/v1/health` → `{"status":"ok"}`.

## 명령

| 명령 | 설명 |
|---|---|
| `pnpm dev` / `pnpm start` | 서버 실행(개발 감시 / 단일 실행). 매칭 워커·정리 작업도 함께 시작. `start` 는 `tsx`(운영 의존성)로 실행하며 Node 22 이상이 필요하다(`engines`). SIGTERM/SIGINT 를 받으면 HTTP 서버 → 워커(진행 중 작업 대기) → 정리 작업 → DB 풀 순으로 정상 종료하고, 처리되지 않은 예외는 기록 후 종료(exit 1)한다 |
| `pnpm test` | 전체 테스트(통합 + `src/matching` 엔진 테스트, 임시 PostgreSQL 자동 기동, Docker 불필요). `TEST_DATABASE_URL` 로 외부 DB 사용 가능 |
| `pnpm test:coverage` | v8 커버리지 포함 전체 테스트(`src/matching`·마이그레이션·server.ts 제외) |
| `pnpm typecheck` / `pnpm lint` | 타입 검사 / ESLint |
| `pnpm db:generate` | 스키마(`src/db/schema.ts`) 변경 후 마이그레이션 SQL 생성 |
| `pnpm db:migrate` / `db:seed` / `db:seed:demo` | 마이그레이션 / 기본 시드 / 시연 시드(멱등) |

## 환경 변수

| 이름 | 기본값 | 설명 |
|---|---|---|
| `PORT` | 4000 | 서버 포트 |
| `NODE_ENV` | development | `production` 이면 Secure 쿠키, `/docs` 비활성. 운영에서는 `DATABASE_URL`·`ALLOWED_ORIGINS` 필수(개발용 기본값 거부), `RETENTION_*_DAYS` ≥ 1 이어야 기동한다(`src/config.ts`) |
| `DATABASE_URL` | `postgres://kunnect:kunnect@localhost:5432/kunnect` | PostgreSQL 접속 문자열 |
| `ALLOWED_ORIGINS` | `http://localhost:3000` | 상태 변경 요청을 허용할 브라우저 Origin(쉼표 구분). Next.js rewrites 프록시는 브라우저 Origin 을 그대로 전달하므로 **프런트 주소를 넣어야 한다**. CORS 는 사용하지 않는다(동일 출처 프록시) |
| `TRUST_PROXY_HOPS` | 0 | API 앞에 있는 프록시 **대수**(실측: 0=소켓 IP, 1=X-Forwarded-For 마지막 값, 2=뒤에서 두 번째). 개발에서 Next rewrites 만 앞에 있으면 1, 운영의 브라우저→Nginx→Next→API 면 2(`docs/deploy-backend.md` 5.3). 클라이언트가 앞에 위조해 넣은 값은 무시된다. 직접 노출 시 반드시 0 |
| `STORAGE_DIR` | `./storage` | 사진 저장 디렉터리(로컬 디스크, `PhotoStorage` 인터페이스로 교체 가능) |
| `ANTHROPIC_API_KEY` | (없음) | 서버 전용 비밀. 없으면 매칭은 로컬 점수만 사용하고 AI 가 필요한 단계는 건너뛴다(degraded) |
| `NOPHOTO_AUTO_NOTIFY` | true | 사진이 한쪽이라도 없는 매칭의 AUTO(알림) 허용. [사용자 결정] 별도 정책 없음 → 기본 허용(엔진 사진 없음 임계 0.85). `false` 로 두면 AUTO→CANDIDATE 로 낮춰 알림 없음(오탐 완화) |
| `RETENTION_POST_DAYS` / `RETENTION_DM_DAYS` | 90 / 30 | 종료 글 백스톱 일수 / **쪽지: 마지막 메시지 후 일수**. 시연에서 줄여 동작 확인 가능 |
| `CLEANUP_ENDED_POSTS_INTERVAL_MIN` | 30 | 종료된 글(24시간 뒤 삭제) 정리 작업 실행 주기(분, 1~1440) |
| `DEMO_PASSWORD` | (코드 기본값) | `db:seed:demo` 계정 비밀번호 |
| `TEST_DATABASE_URL` / `TEST_LOG` | | 테스트용 외부 DB 지정 / 테스트 중 서버 로그 출력(디버깅) |
| `CLAUDE_MODEL_EXTRACT` / `CLAUDE_MODEL_COMPARE` 등 | | 매칭 엔진 설정은 `src/matching/README.md` 참조(모델·가중치·임계값·일일 호출 상한) |

## 브라우저 외 클라이언트(curl 등) 사용 시

세션 쿠키로 상태 변경 요청(POST/PATCH/DELETE)을 보내려면 `Origin` 헤더가 필요하다(CSRF 방지). 예: `curl -b jar -H 'Origin: http://localhost:3000' -X PATCH ...`. 로그인·가입은 쿠키가 없으므로 불필요하다.

## 매칭 워커 동작 방식

1. `POST /posts`(또는 수정) 가 `jobs` 테이블에 `MATCH_POST` 작업을 넣고 즉시 응답한다(글의 `matchState=PENDING`).
2. 서버 프로세스 안의 워커(`startWorker`, 1초 간격)가 작업을 하나씩 가져가 `createMatchHandler` 를 실행한다: 사진 속성 추출 → 후보 SQL 필터(반대 유형·진행 중·작성자 다름·차단 아님, 최신 50건) → `src/matching` 엔진 평가 → `matches` 저장 → **처음 AUTO 가 되는 순간** 분실자에게 알림 1회.
3. 실패 시 최대 3회 재시도(2s/8s/30s), 모두 실패하면 `FAILED`(글 `matchState=FAILED`). 핸들러는 120초 제한(초과 시 재시도 대기)이며, 서버가 죽어 `RUNNING` 에 멈춘 작업은 기동 직후와 이후 1분마다 복구된다(10분 넘게 RUNNING 이면 멈춘 것으로 본다. 시도 상한이면 `FAILED` + 글 `matchState=FAILED`). AUTO 알림 기록(`notifiedAt`)과 알림 생성은 한 트랜잭션이라 실패해도 알림이 유실되지 않는다.
4. Redis 는 쓰지 않는다. 서버가 여러 대여도 `FOR UPDATE SKIP LOCKED` 로 작업이 중복 처리되지 않는다.

## 매칭 작업 성능

후보 사진의 AI 전송용 축소 사본(긴 변 1024px JPEG)은 첫 매칭 때 한 번 만들어 `ai/` 아래에 저장(`post_photos.ai_key`)하고 이후 재사용한다. 읽기는 동시 8개로 제한하고, 내 글에 사진이 없으면 후보 이미지를 아예 읽지 않는다. 측정(후보 50건, 각 1600x1200·약 1MB): 예전 방식(순차 읽기+리사이즈) 3,163ms → 첫 실행 1,436ms → 캐시 후 50ms (`test/limits-and-perf.test.ts`, 개발 PC 1회 측정치).

## 민감 사진 (흐림 처리 + AI 전송 SKIP)

**[사용자 결정] 민감 사진은 AI(Anthropic)로 전송하지 않는다**(`AI_SENSITIVE_MODE` 기본 SKIP, 흐림 사본도 보내지 않음). 태그·제목·설명 키워드·작성자 표시·AI 감지로 판정하며 해당 글은 태그·위치만으로 매칭된다. 태그·키워드·표시가 전혀 없는 학생증 사진은 감지를 위해 첫 속성 추출 1회만 전송될 수 있다. 상세는 `src/matching/README.md`.

학생증·카드·얼굴 등 민감한 사진은 작성자 외에는 흐림 사본만 보인다(원본은 작성자와 소유 확인 이후의 인수 상대). 민감 태그(기본 student_id·wallet·카드)·AI 감지(신뢰도 0.5)·작성자 지정(`PATCH /photos/{id}`)으로 결정된다. 설계는 `docs/dev-plan-backend.md` 17절. AI 전송은 사용자 결정으로 기본 SKIP(민감 글의 사진은 Anthropic 에 보내지 않음, 엔진 설정 `AI_SENSITIVE_MODE`), 표시용 흐림 사본은 별개로 유지된다. 사진 파일은 `/api/v1/files/...` 로 로그인 후에만 제공되며 `ai/` 등 내부 파일은 제공하지 않는다.

## 정리 작업(6시간 주기 + 종료된 글 24시간 삭제 주기 작업)

**쪽지 대화는 마지막 메시지 후 30일(`RETENTION_DM_DAYS`)이 지나면 종료·인수 상태와 무관하게 삭제**하고(사용자 결정 U3), 종료 후 90일 지난 글은 안전망으로 삭제한다(정상 삭제는 아래 24시간 작업). 그 밖에 만료 세션, 만료된 제한 카운터, 24시간 지난 임시 사진, 고아 파일, 7일 지난 완료 작업·30일 지난 실패 작업, 60일 지난 AI 일일 카운터를 삭제한다. 안전장치: 200건씩 배치 처리, 단계별 오류 격리(`errors` 보고), DB 임대(lease)로 중복 실행 방지, 고아 파일은 `photos/`·`ai/` 아래만 대상(24시간 유예)이며 한 번에 최대 500건 + 삭제 전 건수 로그, **DB 에 사진 행이 없는데 고아 후보가 20건 이상이면 DB 초기화/저장소 경로 오설정을 의심해 삭제하지 않고 오류로 보고**한다. 

**종료된 글 자동 삭제(사용자 결정 A17)**: CLOSED 와 [가정/제안] RETURNED 글은 종료 시각(`posts.closed_at`) 24시간 뒤 삭제한다. 24시간 정밀도를 위해 6시간 작업과 **별도로 `CLEANUP_ENDED_POSTS_INTERVAL_MIN`(기본 30분, 1~1440)마다** 실행하며(`runEndedPostsCleanup`), 6시간 작업과 임대(lease)가 분리되어 서로 막지 않고 같은 작업끼리는 중복 실행되지 않는다. 삭제는 공용 `hardDeletePosts` 를 쓴다: 사진 파일(원본·AI·흐림 사본)은 커밋 후 삭제, 댓글·매칭·인수 요청·알림은 cascade, **쪽지 메시지는 남고 글 맥락(post_id)만 사라지며, 신고 snapshot 은 보존**된다. `closed_at` 이 없는 글(OPEN/MATCHED, 비정상 종료 글)은 삭제하지 않는다. 6시간 작업의 90일 규칙은 이 작업이 놓친 종료 글을 위한 백스톱이다.

## 시연 시나리오 (db:seed:demo 후)

계정 `demo_a`(분실자) ~ `demo_d`, 비밀번호는 `DEMO_PASSWORD`(미설정 시 공개된 개발용 기본값을 쓰며 경고를 출력). **`NODE_ENV=production` 에서는 시드가 거부된다.** 시드는 한 트랜잭션이라 중간에 실패해도 반쯤 만들어진 데이터가 남지 않는다(재실행 가능).

1. `demo_a` 로그인 → 알림에 "분실하신 물건과 비슷한 물건…"(MATCH) → 내 분실글 "검은색 에어팟 케이스"의 매칭 결과(등급 HIGH).
2. "내 것이 맞아요" → `demo_b`(습득자)와 쪽지 → `demo_b` 가 소유 확인 → 양쪽 인수 완료 → 글 RETURNED.
3. 후보(CANDIDATE) 예: 지갑(위치 다름), 사진 없는 열쇠 쌍(알림 없음).

사진은 sharp 로 그린 단색 플레이스홀더다. 실제 물건 사진으로 시연하려면 `storage/photos` 의 파일을 교체한다.

## 알려진 한계

- 레이트 리밋·로그인 잠금·AI 일일 상한은 PostgreSQL 카운터(`rate_counters`, `ai_call_counters`)라 재시작·다중 인스턴스에서도 유지된다. 대신 제한이 걸린 요청마다 DB 왕복이 1회 늘어난다(데모 규모에서 무시 가능). 프록시 뒤에서 `TRUST_PROXY_HOPS` 를 설정하지 않으면 모든 사용자가 같은 IP 로 보여 IP 기준 한도(가입 5/시간, 로그인 IP+아이디 5/10분)를 서비스 전체가 공유한다.
- 로그인 잠금은 IP+아이디 5회/10분에 더해 아이디 단독 30회/10분(분산 공격 대응) 한도가 있다. 공격자가 30회 실패를 쌓으면 피해자 계정도 10분간 잠길 수 있다(DoS 가능성, 임계를 높게 둔 절충).
- 글 제목·설명·보관 장소에도 댓글과 같은 연락처 마스킹을 적용한다 — README(기획안)는 댓글만 명시하므로 **[가정/제안] 사용자 승인 필요**. 전각 문자는 NFKC 정규화로 일반 문자로 바뀐다. 한글로 풀어쓴 숫자(공일공…)는 9자 이상 연속일 때만 탐지한다.
- Web Push 미구현(N2 미결정). 위치 목록은 사용자 지정 12곳(`src/db/seed-data.ts`, 층 없음, "기타"는 글의 `locationText` 자유 입력). 예전 더미 위치는 `is_dummy=true` 로 숨기고 기존 글의 참조는 보존한다.
- 쪽지 보존 기준(U3)과 사진 없는 매칭 AUTO 정책(N4 후속)은 사용자 확정 전 [가정/제안] 값이다.
