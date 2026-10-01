import { and, asc, count, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { schema } from '../../db/client.js';
import { originalAccessPosts, viewUrlFor } from '../../lib/photo-privacy.js';
import { badRequest } from '../../lib/errors.js';
import { normalizeTags } from '../../lib/tags.js';

/** 트랜잭션 안/밖 어디서든 쓸 수 있는 쿼리 실행자 */
export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** 목록 카드용 요약. ids 순서를 유지한다. */
export async function loadPostCards(db: Db, ids: number[], viewerId: number) {
  if (!ids.length) return [];
  const rows = await db
    .select({
      id: schema.posts.id,
      type: schema.posts.type,
      title: schema.posts.title,
      status: schema.posts.status,
      occurredAt: schema.posts.occurredAt,
      createdAt: schema.posts.createdAt,
      locationName: schema.locations.buildingName,
      floor: schema.locations.floor,
      locationText: schema.posts.locationText,
      authorId: schema.users.id,
      authorNickname: schema.users.nickname,
    })
    .from(schema.posts)
    .innerJoin(schema.locations, eq(schema.locations.id, schema.posts.locationId))
    .innerJoin(schema.users, eq(schema.users.id, schema.posts.authorId))
    .where(inArray(schema.posts.id, ids));
  const photos = await db
    .select()
    .from(schema.postPhotos)
    .where(inArray(schema.postPhotos.postId, ids))
    .orderBy(asc(schema.postPhotos.order));
  const tagRows = await db
    .select({ postId: schema.postTags.postId, name: schema.tags.name })
    .from(schema.postTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.postTags.tagId))
    .where(inArray(schema.postTags.postId, ids));
  // 민감 사진은 작성자(및 소유 확인 후 인수 상대)가 아니면 흐림 사본으로 대체한다
  const access = await originalAccessPosts(db, viewerId, new Map(rows.map((r) => [r.id, r.authorId])));
  const thumb = new Map<number, string | null>();
  const sensitivePosts = new Set<number>();
  for (const p of photos) {
    if (p.postId == null) continue;
    if (p.sensitive) sensitivePosts.add(p.postId);
    if (!thumb.has(p.postId)) thumb.set(p.postId, viewUrlFor(p, access.has(p.postId)).url);
  }
  const tagsBy = new Map<number, string[]>();
  for (const t of tagRows) tagsBy.set(t.postId, [...(tagsBy.get(t.postId) ?? []), t.name]);
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = byId.get(id);
    if (!r) return [];
    return [
      {
        id: r.id,
        type: r.type,
        title: r.title,
        status: r.status,
        thumbnailUrl: thumb.get(r.id) ?? null,
        hasSensitivePhoto: sensitivePosts.has(r.id),
        locationName: r.floor != null ? `${r.locationName} ${r.floor}층` : r.locationName,
        locationText: r.locationText,
        occurredAt: r.occurredAt,
        tags: tagsBy.get(r.id) ?? [],
        author: { id: r.authorId, nickname: r.authorNickname },
        createdAt: r.createdAt,
      },
    ];
  });
}

export async function loadPostDetail(db: Db, id: number, viewerId: number) {
  const [p] = await db.select().from(schema.posts).where(eq(schema.posts.id, id)).limit(1);
  if (!p) return null;
  const [loc] = await db.select().from(schema.locations).where(eq(schema.locations.id, p.locationId)).limit(1);
  const [author] = await db.select({ id: schema.users.id, nickname: schema.users.nickname }).from(schema.users).where(eq(schema.users.id, p.authorId)).limit(1);
  const photos = await db.select().from(schema.postPhotos).where(eq(schema.postPhotos.postId, id)).orderBy(asc(schema.postPhotos.order));
  const tagRows = await db
    .select({ name: schema.tags.name })
    .from(schema.postTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.postTags.tagId))
    .where(eq(schema.postTags.postId, id));
  const [cc] = await db
    .select({ c: count() })
    .from(schema.comments)
    .where(and(eq(schema.comments.postId, id), eq(schema.comments.status, 'VISIBLE')));
  const isMine = p.authorId === viewerId;
  const access = await originalAccessPosts(db, viewerId, new Map([[p.id, p.authorId]]));
  return {
    id: p.id,
    type: p.type,
    title: p.title,
    description: p.description,
    status: p.status,
    matchState: p.matchState,
    occurredAt: p.occurredAt,
    location: loc ? { id: loc.id, buildingId: loc.buildingKey, buildingName: loc.buildingName, floor: loc.floor, lat: loc.lat, lng: loc.lng } : null,
    locationText: p.locationText,
    lat: p.lat,
    lng: p.lng,
    storagePlace: p.storagePlace,
    hiddenFeatures: isMine ? p.hiddenFeatures : null,
    photos: photos.map((x) => {
      const v = viewUrlFor(x, access.has(p.id));
      // sensitive: 작성자에게는 유효 플래그(+ 지정 상태), 그 외에는 흐림 여부와 같다
      return { photoId: x.id, url: v.url, width: x.width, height: x.height, isBlurred: v.isBlurred, sensitive: isMine ? x.sensitive : v.isBlurred };
    }),
    hasSensitivePhoto: photos.some((x) => x.sensitive),
    tags: tagRows.map((t) => t.name),
    author,
    commentCount: cc?.c ?? 0,
    isMine,
    createdAt: p.createdAt,
  };
}

/** 태그 이름 목록을 정규화해 tags 행을 보장하고 tag id 를 돌려준다. 프리셋은 이름 또는 slug 로 매칭. */
export async function resolveTagIds(db: Executor, rawTags: string[]): Promise<number[]> {
  const names = normalizeTags(rawTags);
  if (!names.length) return [];
  const presets = await db.select().from(schema.tags).where(eq(schema.tags.isPreset, true));
  const ids = new Set<number>();
  const custom: string[] = [];
  for (const n of names) {
    const preset = presets.find((p) => p.name.toLowerCase() === n || p.slug === n);
    if (preset) ids.add(preset.id);
    else custom.push(n);
  }
  if (custom.length) {
    await db.insert(schema.tags).values(custom.map((name) => ({ name }))).onConflictDoNothing();
    const rows = await db.select({ id: schema.tags.id }).from(schema.tags).where(inArray(schema.tags.name, custom));
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}

/** 글에 연결할 사진을 검증한다: 내 소유 + 아직 글에 연결되지 않음. */
export async function loadAttachablePhotos(db: Db, userId: number, photoIds: number[]) {
  if (!photoIds.length) return [];
  if (new Set(photoIds).size !== photoIds.length) throw badRequest('VALIDATION_ERROR', '중복된 사진이 있습니다.');
  const rows = await db
    .select()
    .from(schema.postPhotos)
    .where(and(inArray(schema.postPhotos.id, photoIds), eq(schema.postPhotos.ownerId, userId), isNull(schema.postPhotos.postId)));
  return rows;
}
