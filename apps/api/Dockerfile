# syntax=docker/dockerfile:1
# KUnnect API 운영 이미지 (멀티 스테이지, 비루트, pnpm).
# 빌드 컨텍스트는 apps/api 디렉터리다:  docker build -t kunnect-api apps/api
# ※ 이 저장소 작성 환경에는 Docker 가 없어 이미지 빌드는 아직 실행해 보지 못했다(docs/deploy-backend.md 참고).
#   대신 같은 순서(설치 → tsc 빌드 → 운영 의존성만 설치 → entrypoint)를 로컬에서 재현해 동작을 확인했다.

ARG NODE_VERSION=22
ARG PNPM_VERSION=12.8.1

# ───────── 1) 의존성 설치(개발 의존성 포함, TypeScript 빌드에 필요) ─────────
FROM node:${NODE_VERSION}-bookworm-slim AS deps
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /app
# 락파일·워크스페이스 설정만 먼저 복사해 의존성 레이어를 캐시한다
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ───────── 2) TypeScript → dist/ 컴파일 ─────────
FROM deps AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
COPY openapi.yaml ./openapi.yaml
# drizzle 마이그레이션 SQL 은 tsc 가 복사하지 않으므로 직접 복사한다(런타임이 dist/src/db/migrations 를 읽는다).
# openapi.yaml 은 NODE_ENV 가 production 이 아닐 때 /docs 가 dist/ 옆에서 읽으므로 함께 둔다.
RUN pnpm exec tsc -p tsconfig.build.json \
    && cp -r src/db/migrations dist/src/db/migrations \
    && cp openapi.yaml dist/openapi.yaml

# ───────── 3) 운영 의존성만 설치 ─────────
FROM node:${NODE_VERSION}-bookworm-slim AS prod-deps
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ───────── 4) 런타임 ─────────
FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV PORT=4000
ENV STORAGE_DIR=/data/storage
# tini: PID 1 신호 전달(SIGTERM 시 graceful shutdown)·좀비 정리용. 버전을 고정하면 Debian 보안 갱신 때
# 빌드가 깨지므로 고정하지 않는다.
# hadolint ignore=DL3008
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY scripts/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# 사진 저장 디렉터리(볼륨 마운트 지점)를 비루트 사용자(node, uid 1000) 소유로 만든다
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /data/storage \
    && chown -R 1000:1000 /data /app
USER 1000:1000
EXPOSE 4000
VOLUME ["/data/storage"]
# curl 없이 Node 내장 fetch 로 확인한다(이미지에 불필요한 도구를 넣지 않음)
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/src/server.js"]
