# API 부하 테스트 (autocannon)

`apps/api` 의 주요 경로를 대량 데이터 위에서 측정하고, 느린 쿼리의 실행 계획과 인덱스 개선 후보를 확인한다.
**src/ 는 수정하지 않는다** — 개선안은 아래 "권고"로 코어 담당에게 전달한다.

## 실행 방법

```bash
# 1) 전용 PostgreSQL (운영/공용 DB 금지). 기본 5432 와 겹치지 않게 다른 포트 사용.
cd apps/api
PGPORT=55433 PGDATA_DIR=./.pgdata pnpm db:dev            # 별도 터미널에서 유지
#   (선택) 쿼리 통계: ALTER SYSTEM SET shared_preload_libraries='pg_stat_statements' 후 DB 재시작,
#          CREATE EXTENSION pg_stat_statements;  → run.mjs 가 상위 쿼리를 자동으로 보고한다.

# 2) 마이그레이션·시드 후 API 기동. NODE_ENV=test 는 레이트 리밋/로그인 잠금을 끈다(부하 테스트 전용!).
export DATABASE_URL=postgres://kunnect:kunnect@localhost:55433/kunnect
pnpm db:migrate && pnpm db:seed
NODE_ENV=test TEST_LOG=1 PORT=4200 ALLOWED_ORIGINS=http://localhost:4200 pnpm start   # TEST_LOG=1: 운영과 같이 로그 출력 유지

# 3) 부하 도구 설치(자체 package.json — autocannon 만 설치, pg·sharp 는 apps/api 것을 재사용)
cd test/perf && npm install

# 4) 데이터 생성 → 측정 → 실행 계획
API_URL=http://localhost:4200 node seed-load.mjs      # 사용자 2,000 · 글 20,000 · 댓글 60,000 · 대화 3,000(쪽지 45,000) · 알림 30,000
DURATION=10 API_URL=http://localhost:4200 node run.mjs  # 시나리오별 req/s·지연, DB 상위 쿼리
node explain.mjs                                        # EXPLAIN ANALYZE + 후보 인덱스(트랜잭션 ROLLBACK, 스키마 불변)
node bench-image.mjs                                    # 사진 처리(sharp) 단건 비용
```

환경 변수: `DURATION`(초, 기본 10) `CONNECTIONS`(기본 20) `SESSIONS`(기본 60) `ONLY`(시나리오 이름 부분 일치, 쉼표 구분) `USERS/POSTS/COMMENTS/…`(seed-load).
모든 상태 변경 요청은 세션 쿠키와 함께 **Origin 헤더**를 보낸다(백엔드가 요구, `ALLOWED_ORIGINS` 와 일치해야 함).
결과 JSON 은 `results/latest.json`(git 제외).

## 측정 환경과 한계 (결과 해석 전에 읽을 것)

- 한 대의 개발용 노트북에서 **API·PostgreSQL·부하 도구를 모두** 실행: Windows 11, 16코어(i5-1340P) 17GB, Node 24, PostgreSQL 18(embedded), API **단일 프로세스**, 로그 출력 켜짐.
  부하 도구가 CPU 를 나눠 쓰므로 절대 수치는 운영 서버보다 낮게(지연은 높게) 나온다. **상대 비교와 병목 식별**용으로 쓴다.
- `NODE_ENV=test` 라서 레이트 리밋(DB 카운터 왕복)·로그인 잠금이 꺼져 있다 → 운영에서는 제한이 걸린 요청마다 DB 왕복이 1회 늘어난다.
- 데이터는 합성이다(균일 분포, 모든 글 제목에 "검은 우산" 포함). 실제 분포와 다를 수 있다.
- 대량 데이터는 SQL 로 직접 넣었다(글·댓글·쪽지·알림). 사진 글은 API 로만 만들었다(사진 파일 20,000개를 만들지 않음).
- 사진 업로드 시나리오의 입력은 1600×1200 **무작위 노이즈** JPEG(1.19MB, 압축이 가장 어려운 최악 케이스)다. 일반 사진은 이보다 가볍다(아래 sharp 측정 참고).
- 로그인 시나리오는 마지막에 실행한다: 사용자당 동시 세션이 5개로 제한되어(오래된 세션 만료) 로그인을 몰아치면 앞서 발급한 쿠키가 무효가 된다.

## 결과 (백엔드 `3642e31` = feature/backend 병합 시점, 연결 20 · 10초)

| 시나리오 | 연결 | req/s | p50 ms | p90 ms | p97.5 ms | p99 ms | max ms | non2xx | 오류 |
|---|---|---|---|---|---|---|---|---|---|
| 글 목록(기본) | 20 | 264 | 72 | 94 | 116 | 127 | 239 | 0 | 0 |
| 글 목록 type+status | 20 | 320 | 58 | 84 | 102 | 112 | 129 | 0 | 0 |
| 글 목록 buildingId | 20 | 423 | 45 | 57 | 66 | 71 | 77 | 0 | 0 |
| 글 목록 tag | 20 | 361 | 53 | 65 | 81 | 88 | 108 | 0 | 0 |
| 글 목록 q 검색(흔한 단어) | 20 | 333 | 58 | 72 | 83 | 88 | 99 | 0 | 0 |
| 글 목록 깊은 페이지(cursor) | 20 | 511 | 37 | 50 | 60 | 66 | 79 | 0 | 0 |
| 글 상세 | 20 | 296 | 52 | 82 | 239 | 288 | 436 | 0 | 0 |
| 글 작성(사진 없음) | 10 | 202 | 47 | 61 | 77 | 83 | 89 | 0 | 0 |
| **사진 업로드(multipart 1.19MB)** | 8 | **2** | **3091** | 4738 | 4739 | 4739 | 4739 | 0 | 0 |
| 댓글 목록(인기 글) | 20 | 426 | 45 | 56 | 63 | 67 | 173 | 0 | 0 |
| 댓글 목록(일반 글) | 20 | 551 | 34 | 52 | 68 | 77 | 122 | 0 | 0 |
| 댓글 작성 | 10 | 276 | 33 | 47 | 59 | 65 | 84 | 0 | 0 |
| unread-count 폴링 | 20 | 652 | 29 | 40 | 47 | 51 | 56 | 0 | 0 |
| 알림 목록 | 20 | 507 | 38 | 49 | 58 | 63 | 81 | 0 | 0 |
| 쪽지함 | 20 | 229 | 84 | 107 | 117 | 125 | 142 | 0 | 0 |
| 쪽지 폴링(afterId, 빈 응답) | 20 | 444 | 41 | 61 | 74 | 83 | 101 | 0 | 0 |
| 쪽지 최근 30개 | 20 | 324 | 57 | 77 | 124 | 149 | 216 | 0 | 0 |
| 쪽지 전송 | 10 | 200 | 48 | 63 | 71 | 77 | 89 | 0 | 0 |
| 로그인(argon2) | 8 | 57 | 137 | 164 | 174 | 178 | 190 | 0 | 0 |

- p95 는 autocannon 이 직접 주지 않아 p90 과 p97.5 사이로 본다.
- 사진 포함 글 작성 흐름(업로드→작성, 동시 6, 60회): 업로드 p50/p95 **2458/4198ms**, 작성 47/105ms, 전체 2529/4259ms, 실패 0/60.
- 읽기 API 는 연결 20 에서 p97.5 가 대부분 120ms 이하, 오류 0. 시나리오 중 로드 직후 첫 글 상세에서 p97.5 239ms 가 보이나(캐시 워밍) 재현은 일관되지 않았다.
- 쪽지·알림 폴링 환산: unread-count 는 약 650 req/s 이므로 15초 주기 폴링이면 **동시 접속 약 9,700명 분**(이 노트북 기준, API 단일 프로세스·읽기 전용 가정). 대화 화면(5초 주기)은 약 2,200명 분.

### DB 상위 쿼리 (pg_stat_statements, 시나리오 전체 합계)

| 총 시간 | 호출 | 평균 | 쿼리 |
|---|---|---|---|
| 33.2s | 3,350 | **9.9ms** | `posts where status in (…) and (title ilike … or description ilike …) order by id desc limit` — **글 검색** |
| 17.3s | 3,627 | **4.8ms** | `posts where status in (…) and exists (post_tags join tags …) order by id desc limit` — **태그 필터** |
| 11.7s | 22,238 | 0.53ms | 글 카드(posts+locations+users 조인) — 호출 수가 많을 뿐 건강함 |
| 3.0s | 14,544 | 0.21ms | `insert into matches` (매칭 워커) |
| 2.7s | 63,641 | 0.04ms | 세션 조회(모든 인증 요청) |
| 2.3s | 7,121 | 0.32ms | 쪽지 읽지 않음 수(배지 폴링) |
| 2.1s | 1,466 | **1.46ms** | `update jobs … for update skip locked` (작업 큐 선점, 큐가 쌓였을 때) |

## EXPLAIN 결과와 권고 (코어 담당용)

`node explain.mjs` 기준(글 25k, 댓글 67k, 쪽지 49k, 알림 37k 행):

| # | 쿼리 | 현재 | 후보 적용 후 | 권고 |
|---|---|---|---|---|
| 1 | **글 검색 `q`** (드문 단어) | **70.3ms**, `Seq Scan on posts` + Sort (행 수에 비례해 증가) | **0.12ms (약 570배)** | `create extension if not exists pg_trgm;` + `create index posts_title_trgm_idx on posts using gin (title gin_trgm_ops);` + `create index posts_description_trgm_idx on posts using gin (description gin_trgm_ops);` (마이그레이션에 확장 생성 포함. postgres 공식 이미지에는 contrib 포함). 흔한 단어는 pkey 역순 스캔이라 현재도 빠르다(11.7ms) |
| 2 | **사진 업로드** 처리 | 단건 1.1s(노이즈)/0.14s(일반)/0.48s(4000×3000) | mozjpeg 끄면 **0.05s/0.03s/0.18s (2.6~24배 빠름)**, 대신 파일 크기 +16~45%(1005→1163KB, 121→176KB, 251→342KB) | `processImage` 의 `.jpeg({ quality: 82, mozjpeg: true })` → `mozjpeg: false`. 용량이 부담이면 quality 를 낮추거나 mozjpeg 재압축을 백그라운드 작업(AI 사본처럼)으로 미룬다. 업로드 동시 8 에서 p50 3.1s → 1s 미만 예상(미측정). 사진 처리가 CPU 를 점유해 다른 요청 지연도 키운다 |
| 3 | 태그 필터 | 약 9ms(버퍼 4,765), 태그가 7% 글에 달린 경우. 후보 인덱스 `(tag_id, post_id desc)`·쿼리 재작성으로 계획이 거의 안 바뀜(6.9~7.5ms) | 개선 미미 | **지금은 조치 불필요**. 글이 수십만 건이거나 매우 드문 태그면 post_tags 에서 시작하는 재작성 + `(tag_id, post_id desc)` 인덱스를 재측정할 것 |
| 4 | 작업 큐 선점 | 0.09ms(큐 짧을 때), 부하 중 평균 1.46ms | 부분 인덱스 `create index jobs_pending_idx on jobs (id) where status = 'PENDING'` 로 3.8배(0.02ms) | 낮은 우선순위: 작업이 쌓일 때만 의미. `jobs_status_idx(status, run_after)` 는 `order by id` 때문에 Sort 를 거친다 |
| 5 | 글 목록(필터 없음/type+status)·건물 필터·쪽지 배지·쪽지함 | 0.05~0.35ms | — | 조치 불필요(모두 인덱스 사용) |
| 6 | 글 카드 조인 | 계획 시간 0.6ms ≈ 실행 0.8ms. 사용자 2천 명이라 `users` 를 해시 조인(전체 스캔) | 사용자 수가 늘면 플래너가 인덱스 조인으로 바꿈 | 조치 불필요(단, 요청당 계획 시간이 실행 시간만큼 든다 — 이 규모에서는 무시 가능) |

한 번도 쓰이지 않은 인덱스(이번 시나리오 기준, 삭제 전 실제 트래픽으로 재확인 필요): `posts_occurred_idx`(688kB), `comments_author_idx`(664kB, 내 댓글 API 를 안 쳤을 뿐일 수 있음), `post_tags_tag_idx`(384kB), `posts_location_idx`(184kB). 쓰기 비용만 늘리므로 운영 지표로 확인 후 정리.

### 사진 처리(sharp) 단건 비용 — `node bench-image.mjs`

| 입력 | mozjpeg=true (시간 → 결과 크기) | mozjpeg=false |
|---|---|---|
| 노이즈 1600×1200 (1.3MB) | 1,088ms → 1,005KB | 46ms → 1,163KB |
| 완만한 이미지 1600×1200 (180KB) | 140ms → 121KB | 27ms → 176KB |
| 휴대폰급 4000×3000 (5.5MB) | 483ms → 251KB | 183ms → 342KB |

## 결론

- 읽기·쓰기 API 는 단일 프로세스·노트북에서도 연결 20 기준 p97.5 < 120ms, 오류 0 으로 데모 규모(수십~수백 명)에는 충분하다.
- 병목 후보는 **① 사진 업로드(mozjpeg) ② 글 검색 q(풀스캔) ③ 로그인 argon2(57 req/s, 의도된 비용)** 이며 ①②는 위 권고로 크게 줄어든다.
- 확장: API 를 여러 대로 늘려도 매칭 작업(`FOR UPDATE SKIP LOCKED`)과 제한 카운터(DB)는 안전하다. 사진은 로컬 디스크이므로 다중 인스턴스에서는 **공유 볼륨 또는 S3 전환**이 필요하다(`PhotoStorage` 인터페이스).
