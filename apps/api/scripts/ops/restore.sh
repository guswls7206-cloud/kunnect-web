#!/bin/sh
# 운영 복원: 백업한 DB 덤프와(선택) 사진 tar.gz 를 되돌린다. 저장소 루트에서 실행한다.
#   sh apps/api/scripts/ops/restore.sh backups/db-20261001-030000.dump [backups/photos-20261001-030000.tar.gz]
# 주의: 현재 DB 의 내용을 덮어쓴다(--clean). 실행 전 API 를 멈추고, 가능하면 현재 상태를 먼저 백업한다.
# ※ Docker 가 없는 환경에서 작성되어 실제 실행은 검증하지 못했다. 스테이징에서 복원 리허설을 먼저 할 것.
set -eu

[ $# -ge 1 ] || { echo "사용법: $0 <db 덤프> [사진 tar.gz]" >&2; exit 2; }
DUMP="$1"
PHOTOS="${2:-}"
[ -s "$DUMP" ] || { echo "덤프 파일이 없거나 비어 있습니다: $DUMP" >&2; exit 2; }

COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod"

echo "[restore] API 중지(DB 연결 끊기)"
$COMPOSE stop api

echo "[restore] DB 복원: $DUMP"
# --clean --if-exists: 기존 객체를 지우고 다시 만든다. --no-owner: 소유자 차이로 인한 오류 방지.
$COMPOSE exec -T db pg_restore -U kunnect -d kunnect --clean --if-exists --no-owner < "$DUMP"

if [ -n "$PHOTOS" ]; then
  [ -s "$PHOTOS" ] || { echo "사진 백업이 없거나 비어 있습니다: $PHOTOS" >&2; exit 2; }
  echo "[restore] 사진 복원: $PHOTOS"
  docker run --rm -v kunnect_photos:/data -v "$(cd "$(dirname "$PHOTOS")" && pwd)":/backup alpine:3 \
    sh -c "rm -rf /data/* && tar xzf /backup/$(basename "$PHOTOS") -C /data && chown -R 1000:1000 /data"
fi

echo "[restore] API 시작(기동 시 마이그레이션이 적용되므로 스키마가 이전 버전이어도 최신으로 올라감)"
$COMPOSE start api
echo "[restore] 완료. 로그인·글 목록·사진 표시를 확인하세요."
