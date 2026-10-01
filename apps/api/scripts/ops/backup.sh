#!/bin/sh
# 운영 백업: PostgreSQL 덤프(pg_dump -Fc) + 사진 볼륨 tar.gz. 저장소 루트에서 실행한다.
#   sh apps/api/scripts/ops/backup.sh                # ./backups 에 저장
#   BACKUP_DIR=/mnt/backup KEEP_DAYS=14 sh apps/api/scripts/ops/backup.sh
# cron 예) 0 3 * * *  cd /srv/kunnect && sh apps/api/scripts/ops/backup.sh >> backups/backup.log 2>&1
# ※ Docker 가 없는 환경에서 작성되어 실제 실행은 검증하지 못했다. 처음 한 번은 수동으로 돌리고 복원까지 리허설할 것.
set -eu

COMPOSE="docker compose -f docker-compose.prod.yml --env-file .env.prod"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

echo "[backup] DB 덤프 → $BACKUP_DIR/db-$STAMP.dump"
# -Fc: 커스텀 형식(pg_restore 로 선택 복원 가능). 비밀번호는 컨테이너 환경에서 읽으므로 명령행에 노출되지 않는다.
$COMPOSE exec -T db pg_dump -U kunnect -d kunnect -Fc > "$BACKUP_DIR/db-$STAMP.dump"

echo "[backup] 사진 볼륨 → $BACKUP_DIR/photos-$STAMP.tar.gz"
# 사진 볼륨(compose 프로젝트명 kunnect → kunnect_photos)을 읽기 전용으로 마운트해 압축한다.
docker run --rm -v kunnect_photos:/data:ro -v "$(cd "$BACKUP_DIR" && pwd)":/backup alpine:3 \
  tar czf "/backup/photos-$STAMP.tar.gz" -C /data .

# 덤프가 비어 있으면 실패로 처리(권한·연결 문제를 조용히 넘기지 않기 위함)
[ -s "$BACKUP_DIR/db-$STAMP.dump" ] || { echo "[backup] 오류: DB 덤프가 비어 있습니다" >&2; exit 1; }

echo "[backup] $KEEP_DAYS 일 지난 백업 삭제"
find "$BACKUP_DIR" -maxdepth 1 \( -name 'db-*.dump' -o -name 'photos-*.tar.gz' \) -mtime +"$KEEP_DAYS" -print -delete

echo "[backup] 완료: db-$STAMP.dump, photos-$STAMP.tar.gz"
