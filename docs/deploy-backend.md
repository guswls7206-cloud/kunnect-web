# KUnnect 백엔드 배포 가이드

> 대상: `apps/api`(Fastify + PostgreSQL). 데모/소규모 운영을 가정한다. 프런트(Next.js)는 별도 문서·담당이다.
> 표기: **[검증]** 이 저장소 작성 환경에서 실제로 실행해 확인한 것, **[미검증]** 문서·정적 점검만 했고 실행해 보지 못한 것.

## 0. 먼저 읽을 것: 무엇을 확인했고 무엇을 못 했나

이 문서와 산출물은 **Docker 가 설치되지 않은 Windows 개발 PC** 에서 만들었다. 따라서 **Docker 이미지 빌드와 컨테이너 기동은 한 번도 실행하지 못했다.**

| 항목 | 상태 | 근거 |
|---|---|---|
| `Dockerfile` 문법·모범 사례(비루트 USER, HEALTHCHECK, 핀 버전 등) | **[검증]** | hadolint 2.15.1 통과(`DL3008` 만 의도적으로 예외 처리) |
| `docker-compose.prod.yml`·`.env.example` 구성 규칙 | **[검증]** (정적) | `node apps/api/scripts/ops/check-compose.mjs` — 필수 변수 강제, DB 포트 비공개, 볼륨 일치, 환경 변수 29개 문서화 등. 실패 시 종료 코드 1 |
| Dockerfile 이 하는 것과 같은 **빌드 절차** | **[검증]** | 로컬에서 동일 순서 재현: `pnpm install --frozen-lockfile` → `tsc -p tsconfig.build.json` → 마이그레이션 SQL 복사 → `pnpm install --prod`(운영 의존성만) → `docker-entrypoint.sh`(마이그레이션·시드) → `node dist/src/server.js` (NODE_ENV=production). 헬스 200, `/docs` 404(운영에서 비활성), 시드 적용 확인 |
| 이미지 빌드, 컨테이너 기동, 볼륨 권한(uid 1000), compose 의존성 대기, tini 신호 전달, 컨테이너 내 healthcheck, **리눅스(glibc)에서의 `argon2`·`sharp` 네이티브 모듈 설치**(검증은 Windows 에서만) | **[미검증]** | Docker 필요. 처음 배포 전에 스테이징에서 아래 "10. 첫 배포 체크리스트"로 확인할 것 |
| `backup.sh` / `restore.sh` | **[미검증]** (셸 문법만 `sh -n` 확인) | Docker 필요. **복원 리허설을 반드시 먼저** 할 것 |
| Nginx/Caddy 설정 예시 | **[미검증]** | 일반적인 설정을 옮겨 적은 것 |
| TRUST_PROXY_HOPS 의미 | **[검증]** | 아래 5.3 의 실측 |
| 부하 성능 | **[검증]** (개발 노트북 1대) | `apps/api/test/perf/README.md` |

## 1. 구성

```
브라우저 ──HTTPS──> 리버스 프록시(Nginx/Caddy) ──> Next.js 서버 ──rewrites──> API(컨테이너 :4000) ──> PostgreSQL
                         └────────── /api/* 를 API 로 직접 보내도 된다 ──────────┘
```

- API 는 상태가 DB(PostgreSQL)와 **사진 볼륨**에만 있다. 매칭 작업 큐도 DB 테이블(`jobs`)이다(Redis 없음).
- 매칭 워커·정리 작업·제한 카운터는 API 프로세스 안에서 동작한다. 별도 워커 컨테이너는 없다.
- API 는 CORS 를 쓰지 않는다. 프런트와 **동일 출처**(프록시/rewrites)로 호출하는 것이 전제다.

## 2. 사전 준비

- 서버: 1 vCPU / 2GB RAM 이상(데모). 사진 디스크는 글당 사진 최대 3장 × 약 0.2~1MB(서버가 긴 변 1600px JPEG 로 줄임) + AI 사본을 감안해 여유 있게.
- 도메인과 **HTTPS 인증서**(Let's Encrypt 등). 세션 쿠키가 `Secure` 라 HTTPS 없이는 브라우저에서 로그인이 유지되지 않는다(5.1).
- Docker Engine 24+ 와 Compose v2. (없으면 9절 "Docker 없이" 참고)

## 3. 환경 변수

전체 목록과 설명은 `apps/api/.env.example` (코드가 읽는 29개 변수 모두 문서화 — 정적 점검이 누락을 잡는다).
운영에서는 `.env.prod` 를 만들어 채운다(저장소에 커밋 금지, 권한 `chmod 600`).

```bash
cp apps/api/.env.example .env.prod
chmod 600 .env.prod
```

운영에서 **반드시 정해야 하는 값**:

| 이름 | 설명 | 예 |
|---|---|---|
| `POSTGRES_PASSWORD` | DB 비밀번호. 비어 있으면 compose 가 시작을 거부한다. 길고 무작위로. **URL 에 들어가므로 `@ : / ? # %` 같은 문자는 피하거나 퍼센트 인코딩** | `openssl rand -hex 24` |
| `ALLOWED_ORIGINS` | 프런트 주소(쉼표 구분). 비어 있으면 compose 가 시작을 거부한다 | `https://kunnect.example.com` |
| `TRUST_PROXY_HOPS` | API 앞 프록시 **대수**(5.3). compose 기본 1 | `1` 또는 `2` |

선택/정책 값: `ANTHROPIC_API_KEY`(6), `NOPHOTO_AUTO_NOTIFY`(7), `RETENTION_POST_DAYS`(기본 90) / `RETENTION_DM_DAYS`(기본 30), 매칭 가중치·임계값·모델(`MATCH_*`, `CLAUDE_MODEL_*`, `AI_*`), `RUN_MIGRATIONS`/`RUN_SEED`(컨테이너), `API_BIND`.

**`NODE_ENV=test` 는 운영에서 절대 쓰지 않는다**(레이트 리밋·로그인 잠금이 꺼짐). compose 는 `production` 으로 고정한다.

## 4. Docker Compose 로 배포 [미검증]

```bash
# 저장소 루트에서
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
docker compose -f docker-compose.prod.yml --env-file .env.prod ps          # api: healthy 확인
docker compose -f docker-compose.prod.yml --env-file .env.prod logs -f api
curl -fsS http://127.0.0.1:4000/api/v1/health                              # {"status":"ok"}
```

구성: `db`(postgres:18, 외부 비공개) + `api`(이 저장소 이미지) + 볼륨 `pgdata`·`photos`.
`api` 는 `db` 가 healthy 가 될 때까지 기다리고, 기동 시 **마이그레이션 → 카탈로그 시드(위치·프리셋 태그, 멱등) → 서버** 순서로 실행한다(`scripts/docker-entrypoint.sh`).
포트는 기본 `127.0.0.1:4000` 에만 열린다(리버스 프록시 전용). 인터넷에 직접 열려면 `API_BIND=0.0.0.0:4000` 이지만 **권장하지 않는다**(5.3).

운영 DB 에 시연 데이터(`pnpm db:seed:demo`)를 넣지 않는다. 시연용 환경이 따로 필요하면 별도 스택으로 띄운다.

### 이미지 구조(요약)
멀티 스테이지: `deps`(전체 설치) → `build`(tsc → `dist/`) → `prod-deps`(`--prod` 설치) → `runtime`(node:22-bookworm-slim, **비루트 uid 1000**, tini, HEALTHCHECK). 런타임에는 TypeScript·tsx·테스트 도구가 없다. `cap_drop: ALL`, `no-new-privileges` 적용.

## 5. HTTPS · 쿠키 · 프록시

### 5.1 Secure 쿠키
`NODE_ENV=production` 이면 세션 쿠키(`kunnect_sid`)에 `Secure` 가 붙는다. 브라우저는 HTTPS(또는 localhost)에서만 이 쿠키를 저장한다 → **TLS 는 프록시에서 종단하고 사용자는 HTTPS 로 접속**해야 한다. HTTP 로 접속하면 로그인은 성공해도 다음 요청에서 로그아웃 상태가 된다.

### 5.2 Origin 헤더 전달 (중요)
세션 쿠키를 보내는 **상태 변경 요청(POST/PATCH/PUT/DELETE)은 `Origin` 헤더가 필수**이고 `ALLOWED_ORIGINS`(또는 자기 자신)와 일치해야 한다(아니면 403 `BAD_ORIGIN`). 쿠키 없는 로그인/가입은 예외.
따라서 리버스 프록시·Next rewrites 는 **브라우저의 `Origin` 을 지우지 말고 그대로 전달**해야 하고, `ALLOWED_ORIGINS` 에는 브라우저가 실제로 보는 주소(스킴+호스트+포트)를 넣는다. 부하 테스트·헬스체크 스크립트도 같다.

### 5.3 TRUST_PROXY_HOPS (클라이언트 IP)
레이트 리밋(IP 기준 가입 5/시간, 로그인 IP+아이디 5/10분 등)은 요청 IP 를 쓴다.
- `0`(기본): `X-Forwarded-For` 를 무시한다 → 프록시 뒤에서는 **모든 사용자가 같은 IP(프록시)** 로 보여 한도를 서비스 전체가 공유한다. 직접 노출할 때만 0.
- `N`: **API 앞에 있는 프록시 N 대**를 신뢰한다. 실제 클라이언트 IP = 오른쪽에서 N+1 번째 주소(소켓 주소 포함 N 개를 신뢰).
- **직접 노출하면서 1 이상으로 두면 클라이언트가 `X-Forwarded-For` 를 위조해 한도를 피할 수 있다.** API 포트를 인터넷에 열지 말 것.

실측(API 를 직접 호출하며 `X-Forwarded-For: 198.51.100.1, 203.0.113.9` 헤더를 보내고 로그의 `remoteAddress` 확인) **[검증]**:

| TRUST_PROXY_HOPS | 로그의 클라이언트 IP |
|---|---|
| 0 | 127.0.0.1 (헤더 무시) |
| 1 | 203.0.113.9 (마지막 항목 = 바로 앞 프록시가 본 주소) |
| 2 | 198.51.100.1 |

즉 값은 "프록시 대수"로 동작하고, 코드가 off-by-one 인 것은 아니다. 다만 **체인에 몇 대가 있는지 정확히 세는 것은 운영자의 몫**이다: 브라우저 → Nginx → API 면 1, 브라우저 → Nginx → Next(rewrites) → API 면 Next 가 `X-Forwarded-For` 를 덧붙이는지에 따라 2(실제 체인으로 위 방식 확인 필요 [미검증]). 설정 후에는 반드시 로그의 `remoteAddress` 가 **본인 공인 IP** 로 찍히는지 확인한다.
프록시는 클라이언트가 보낸 `X-Forwarded-For` 를 **그대로 이어 붙이지 말고** 자신이 본 주소로 설정/덧붙이도록 구성한다(아래 예시).

### 5.4 Nginx 예시 [미검증]
```nginx
server {
  listen 443 ssl http2;
  server_name kunnect.example.com;
  # ssl_certificate / ssl_certificate_key ...

  client_max_body_size 11m;            # 사진 10MB + multipart 오버헤드 (API 한도 10MB)

  # API 로 직접 보내는 경우(프런트가 /api/v1 을 같은 도메인에서 호출)
  location /api/ {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host              $host;
    proxy_set_header X-Forwarded-For   $remote_addr;      # 클라이언트 값을 덮어쓴다(위조 방지). 이 경우 TRUST_PROXY_HOPS=1
    proxy_set_header X-Forwarded-Proto $scheme;
    # Origin / Cookie 헤더는 기본으로 전달된다. 지우지 말 것(5.2)
    proxy_read_timeout 60s;
  }
  location / { proxy_pass http://127.0.0.1:3000; }       # Next.js 서버
}
```
Caddy 는 `reverse_proxy 127.0.0.1:4000` 만으로 `X-Forwarded-For` 를 덧붙이고 TLS 를 자동 처리한다(`handle_path /api/*` 로 분기). 업로드 한도는 `request_body { max_size 11MB }`.

### 5.5 정적 사진 파일
사진은 API 가 `/api/v1/files/photos/<랜덤>.jpg` 로 제공한다(같은 `/api` 경로 → 프록시 규칙 하나로 충분). 로그인 쿠키가 필요하고 공개 캐시를 하지 않는다. CDN 을 앞에 두려면 인증 쿠키를 고려해야 하므로 데모에서는 쓰지 않는다.

### 5.6 Cloudflare(Tunnel) 배포 체크리스트 [미검증 — 실제 배포에서 확인]

사용자가 Cloudflare 로 직접 배포하는 경우의 요점. 이 환경에서는 Cloudflare 를 실행해 보지 못했으므로 값은 배포 후 로그로 확인한다.

- **HTTPS 필수**: 프로덕션(`NODE_ENV=production`)은 세션 쿠키에 `Secure` 가 붙으므로 브라우저가 https 로 접속해야 로그인된다(Cloudflare 가 TLS 종단, 원본 서버는 http 여도 됨).
- **`ALLOWED_ORIGINS` = 공개 URL**(예: `https://kunnect.example.com`, 쉼표 구분). Next.js 프록시/Cloudflare 가 브라우저의 `Origin` 헤더를 그대로 전달해야 한다(5.2). 이 값이 틀리면 로그인 후 모든 POST/PATCH/DELETE 가 403 `BAD_ORIGIN`.
- **`TRUST_PROXY_HOPS`**: API 앞에 있는 프록시 **대수**. 예) 인터넷 → Cloudflare 엣지 → `cloudflared`(같은 호스트) → Next.js(rewrites) → API 이면 `cloudflared` 와 Next 가 API 앞에 있어 **2** 가 될 가능성이 높다(클라이언트 IP 가 XFF 의 뒤에서 두 번째). Nginx 가 더 있으면 +1. 값을 바꾼 뒤 로그의 `req.ip` 가 실제 클라이언트 IP 인지 확인한다(5.3). 잘못 설정하면 모든 사용자가 한 IP 로 보여 IP 기준 한도를 공유하거나, 반대로 IP 위조가 가능해진다.
- **시연 시드 금지**: 운영 DB 에는 `pnpm db:seed:demo` 를 실행하지 않는다(알려진 시연 계정이 생긴다). 기본 카탈로그 시드(위치 12곳·태그)만 쓴다.
- **AI 비용 보호**: `AI_DAILY_CALL_LIMIT` 을 시연보다 낮게 시작(예: 100~200)해 점차 올리고, Anthropic 콘솔에서 **월 지출 한도(spend limit)** 를 따로 건다. 키는 서버 환경 변수로만 두고 저장소·이미지·로그에 넣지 않는다(6).
- **파일 저장소**: 사진은 컨테이너 볼륨에 저장된다. Cloudflare 캐시를 쓰더라도 `/api/v1/files/*` 는 로그인 쿠키가 필요한 응답(`Cache-Control: private`)이므로 캐시하지 않는다(5.5).
- **가입 제한 없음(현재)**: 초대 코드·학교 이메일 검증은 보류 결정이라 가입은 아이디/비밀번호 + IP당 5회/시간 제한뿐이다. 공개 배포 전에 필요성을 다시 판단한다.

## 6. ANTHROPIC_API_KEY 다루기
- **서버 전용 비밀**이다. 클라이언트·프런트 번들·로그·이미지·Git 에 넣지 않는다. 코드는 환경 변수로만 읽고, 로그에서는 쿠키·Authorization 헤더만 가린다(redact) — 키는 애초에 로그에 찍지 않는다.
- 저장: `.env.prod`(권한 600, 서버에만 존재) 또는 배포 플랫폼의 시크릿 저장소 → 컨테이너 환경 변수로 주입. compose 파일에는 `${ANTHROPIC_API_KEY:-}` 참조만 있고 값이 없다(정적 점검이 평문 `sk-…` 를 막음).
- 교체: `.env.prod` 수정 → `docker compose … up -d api`(재시작). 노출이 의심되면 Anthropic 콘솔에서 즉시 폐기·재발급.
- 비용 통제: `AI_DAILY_CALL_LIMIT`(기본 500/일, DB 카운터라 재시작 후에도 유지), `AI_CONCURRENCY`, `MATCH_TOP_N`, 이미지 상한(`AI_IMAGE_*`). 모델은 `CLAUDE_MODEL_*`(기본 Haiku 4.5, 예산 결정 #11 전 [가정/제안]).
- 키가 없으면 매칭은 로컬 점수(위치·태그)만 쓰고 **AUTO(알림)는 발송되지 않는다**(후보 표시만).
- 개인정보: 사진이 Claude API 로 전송된다. 서비스 이용 안내에 명시해야 한다(README 10절).

## 7. NOPHOTO_AUTO_NOTIFY
사진이 한쪽이라도 없는 매칭(위치+태그 2신호)은 오탐 위험이 커서 기본적으로 AUTO→CANDIDATE 로 낮춰 **알림을 보내지 않는다**(`false`). 사용자가 N4 를 확정해 알림을 허용하면 `true` 로 바꾸고 임계값(`MATCH_AUTO_THRESHOLD_NOPHOTO`, 기본 0.85)을 함께 검토한다. 값 변경은 재시작 후 새로 계산되는 매칭부터 적용된다.

## 8. 운영 절차

### 8.1 마이그레이션 (배포 시)
- 마이그레이션은 **앞으로만**(forward-only) 적용된다(drizzle). 롤백 SQL 은 없다 → 배포 전에 **백업**(9절)을 먼저 한다.
- 기본은 컨테이너 기동 시 자동 적용(`RUN_MIGRATIONS=true`). API 를 **여러 대** 올릴 때는 동시에 마이그레이션이 돌지 않도록 1회성 작업으로 분리한다:
  ```bash
  docker compose -f docker-compose.prod.yml --env-file .env.prod run --rm -e RUN_SEED=false api node dist/scripts/migrate.js
  # 이후 api 들은 RUN_MIGRATIONS=false 로 기동
  ```
- 스키마 변경은 구버전 코드와도 함께 동작하도록(컬럼 추가 → 코드 배포 → 컬럼 제거 순) 나눠서 배포한다.

### 8.2 정리 작업(보존 기간)
별도 cron 이 필요 없다. API 프로세스가 **기동 직후 1회 + 6시간마다** 실행한다: 종료 후 `RETENTION_POST_DAYS`(90일) 지난 글(사진·댓글·매칭·알림 포함), `RETENTION_DM_DAYS`(30일) 지난 종료 대화, 만료 세션·카운터, 24시간 지난 임시 사진, 고아 파일, 7일 지난 완료 작업. 로그에 `정리 작업 완료: {...}` 로 결과가 남는다.
API 를 여러 대 두면 인스턴스마다 실행된다. 삭제는 조건 기반이라 반복해도 같은 결과지만 동시 실행의 경합은 검증하지 않았다 → **데모는 API 1대 권장** [미검증].

### 8.3 백업/복원 [미검증]
- **무엇을**: ① PostgreSQL 덤프 ② 사진 볼륨(`kunnect_photos`). 둘은 같은 시점 쌍으로 보관한다(DB 만 복원하면 사진이 없고, 사진만 있으면 연결이 없다).
- **백업**: `sh apps/api/scripts/ops/backup.sh` (cron 예: 매일 03:00). `BACKUP_DIR`, `KEEP_DAYS`(기본 14) 설정. 결과: `db-<시각>.dump`(pg_dump -Fc), `photos-<시각>.tar.gz`.
- **복원**: `sh apps/api/scripts/ops/restore.sh backups/db-….dump [backups/photos-….tar.gz]` — API 를 멈추고 DB 를 **덮어쓴** 뒤 다시 시작한다(시작 시 마이그레이션이 최신 스키마로 올림). 반드시 스테이징에서 복원 리허설 후 운영에 쓴다.
- **개인정보**: 서비스는 종료 글 90일/쪽지 30일 후 데이터를 삭제하지만 **백업에는 삭제된 데이터가 남는다.** `KEEP_DAYS` 를 보존 기간보다 길게 두지 말고(쪽지 30일 이하 권장), 백업 저장소 접근을 제한·암호화한다.
- 오프사이트 보관(다른 서버/스토리지)은 이 스크립트 범위 밖이다. 같은 디스크에만 두면 디스크 장애 때 함께 잃는다.

### 8.4 모니터링
- 헬스: `GET /api/v1/health` → `{"status":"ok"}` (컨테이너 HEALTHCHECK 가 사용). 외부 업타임 모니터를 붙인다.
- 로그: JSON(pino) 한 줄씩, 컨테이너 로그 로테이션 설정(10MB×5). 쿠키·Authorization 은 가려진다. 요청마다 2줄이 나오므로 트래픽이 많으면 중앙 수집/레벨 조정을 고려.
- 확인할 것: 디스크(사진 볼륨·pgdata), `jobs` 테이블의 `FAILED`/오래된 `RUNNING`(매칭 실패), `matchState=FAILED` 글, 5xx 비율, AI 일일 상한 도달 로그.

### 8.5 업그레이드/롤백
1. 백업 → 2. `git pull` → 3. `docker compose … up -d --build`(마이그레이션 자동) → 4. 헬스·로그인·글 목록 확인.
롤백: 이전 이미지 태그로 되돌리되, **이미 적용된 마이그레이션은 되돌려지지 않으므로** 스키마가 바뀐 릴리스는 백업 복원이 롤백 수단이다.

## 9. Docker 없이 실행(대안) [부분 검증]
Node 22+, PostgreSQL 16+ 가 있으면 컨테이너 없이도 가능하다: `pnpm install --frozen-lockfile && pnpm exec tsc -p tsconfig.build.json && cp -r src/db/migrations dist/src/db/migrations`, `NODE_ENV=production DATABASE_URL=… ALLOWED_ORIGINS=… node dist/scripts/migrate.js && node dist/scripts/seed.js && node dist/src/server.js` (systemd 등으로 감독). 위 절차는 개발 PC 에서 **[검증]** 했다. 사진 디렉터리(`STORAGE_DIR`)는 미리 만들어 둔다(없으면 정적 서빙 등록 경고).

## 10. 첫 배포 체크리스트 (스테이징에서 먼저)
- [ ] `docker compose … up -d --build` 가 성공하고 `api` 가 healthy
- [ ] `docker compose … exec api id` → `uid=1000`(비루트), 사진 업로드 후 `photos` 볼륨에 파일 생성(권한 오류 없음)
- [ ] HTTPS 로 접속해 가입→로그인→새로고침 후에도 로그인 유지(Secure 쿠키)
- [ ] 글 작성/수정/삭제 요청이 403 `BAD_ORIGIN` 없이 성공(Origin 전달, 5.2)
- [ ] API 로그의 `remoteAddress` 가 본인 공인 IP(5.3)
- [ ] 같은 IP 에서 로그인 6번 실패 → 429 (제한이 사용자 전체가 아니라 IP 기준으로 동작)
- [ ] 컨테이너 재시작 후에도 데이터·사진 유지(볼륨), `docker compose … down`(볼륨 삭제 안 함) → `up`
- [ ] `backup.sh` 실행 → 다른 스택에서 `restore.sh` 로 복원 → 로그인·사진 표시 확인
- [ ] `docker stop` 시 종료가 빠르게 끝남(tini 신호 전달, 10초 이내)
- [ ] `ANTHROPIC_API_KEY` 설정 후 사진 글 2건(유사)로 매칭·AUTO 알림 동작, 키가 로그에 없음

## 11. 알려진 한계 / 후속 제안
- 사진은 로컬 디스크(볼륨)라 **API 다중 인스턴스에서는 공유 스토리지 또는 S3 전환**이 필요하다(`PhotoStorage` 인터페이스로 교체 가능).
- 정리 작업·마이그레이션은 단일 인스턴스를 전제로 검증했다(8.1, 8.2).
- 컨테이너 파일시스템은 `read_only` 로 두지 않았다(`sharp` 임시 파일 등 영향을 검증하지 못함). Docker 검증 후 `read_only: true` + `tmpfs: /tmp` 를 시도해 볼 수 있다.
- 이미지 취약점 스캔(예: Trivy)·SBOM 은 하지 않았다. 배포 파이프라인에 추가를 권장한다.
- 성능 병목(사진 업로드의 mozjpeg, 글 검색 풀스캔)과 개선안은 `apps/api/test/perf/README.md` 에 있다. 코어 담당 반영 대기.
