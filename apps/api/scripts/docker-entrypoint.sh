#!/bin/sh
# 컨테이너 시작 스크립트: (선택) DB 마이그레이션·카탈로그 시드 후 서버를 실행한다.
#  - RUN_MIGRATIONS=true(기본)  기동 시 마이그레이션을 적용한다. 여러 인스턴스를 동시에 올리면
#    마이그레이션은 한 곳에서만(별도 1회성 작업) 돌리도록 false 로 두는 편이 안전하다.
#  - RUN_SEED=true(기본)        위치·프리셋 태그 시드(멱등: 이미 있으면 건너뜀).
set -eu

if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  echo "[entrypoint] DB 마이그레이션 적용"
  node dist/scripts/migrate.js
fi

if [ "${RUN_SEED:-true}" = "true" ]; then
  echo "[entrypoint] 카탈로그 시드(멱등)"
  node dist/scripts/seed.js
fi

exec "$@"
