import type { Db } from './client.js';
import { schema } from './client.js';
import { eq } from 'drizzle-orm';
import { CAMPUS_LOCATIONS, PRESET_TAGS } from './seed-data.js';

/**
 * 멱등 시드: 실제(비더미) 위치가 이미 있으면 건너뛴다.
 * 예전 더미 위치만 있는 DB 는 실제 캠퍼스 위치를 추가하고, 남은 행은 모두 is_dummy=true 로 표시해 목록·새 글에서 숨긴다.
 * 더미 행은 지우지 않는다(이미 그 위치를 가리키는 글의 FK 를 보존).
 */
export async function seedCatalog(db: Db) {
  const existingReal = await db.select({ id: schema.locations.id }).from(schema.locations).where(eq(schema.locations.isDummy, false)).limit(1);
  if (!existingReal.length) {
    await db.transaction(async (tx) => {
      await tx.update(schema.locations).set({ isDummy: true });
      // 배열 순서대로 넣어 id 순서가 곧 화면 정렬 순서가 되게 한다.
      await tx.insert(schema.locations).values(
        CAMPUS_LOCATIONS.map((b) => ({
          buildingKey: b.buildingKey,
          buildingName: b.buildingName,
          floor: null,
          lat: b.lat,
          lng: b.lng,
          groupId: b.groupId,
          isDummy: false,
        })),
      );
    });
  }
  await db
    .insert(schema.tags)
    .values(PRESET_TAGS.map((t) => ({ name: t.name, slug: t.slug, isPreset: true, isCategory: t.isCategory })))
    .onConflictDoNothing();
}
