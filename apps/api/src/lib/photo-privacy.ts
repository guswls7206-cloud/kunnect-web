import { randomBytes } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { schema } from '../db/client.js';
import { blurImageForPrivacy } from '../matching/image.js';
import type { PhotoStorage } from '../storage/index.js';
import { FILES_URL_PREFIX } from '../storage/index.js';

/**
 * 민감 사진(학생증·카드·얼굴 등) 처리 [가정/제안, 사용자 승인 기능].
 *
 * - 유효 플래그 `sensitive` = 작성자 지정(MARK/UNMARK) 우선, 없으면 (AI 감지 || 민감 태그).
 * - sensitive 이면 흐림 처리된 표시용 사본(blurred/...)을 만들어 두고, 작성자 외에는 그 사본만 제공한다.
 *   원본은 작성자와, 인수 요청이 소유 확인(VERIFIED) 이후인 대화 상대에게만 제공한다.
 * - 흐림 처리 실패는 fail-closed: 사본이 없으면 sensitive 사진은 작성자 외에게 제공하지 않는다(원본 대체 금지).
 */
type Photo = typeof schema.postPhotos.$inferSelect;

export interface PrivacyDeps {
  db: Db;
  storage: PhotoStorage;
}

export function effectiveSensitive(p: Pick<Photo, 'sensitiveOverride' | 'sensitiveAi' | 'sensitiveTag'>): boolean {
  if (p.sensitiveOverride === 'MARK') return true;
  if (p.sensitiveOverride === 'UNMARK') return false;
  return p.sensitiveAi || p.sensitiveTag;
}

export const blurredUrlOf = (key: string) => FILES_URL_PREFIX + key;

/** 흐림 사본이 없으면 만든다. 실패하면 예외(호출 측은 사본 없이 sensitive 만 표시 → 작성자 외 비공개). */
export async function ensureBlurred(deps: PrivacyDeps, photo: Photo): Promise<string> {
  if (photo.blurredKey) return photo.blurredKey;
  const original = await deps.storage.read(photo.storageKey);
  const blurred = await blurImageForPrivacy(original, { mode: 'BLUR', maxSide: 1024 });
  const key = `blurred/${randomBytes(16).toString('hex')}.jpg`;
  await deps.storage.save(key, blurred.buffer);
  await deps.db.update(schema.postPhotos).set({ blurredKey: key }).where(eq(schema.postPhotos.id, photo.id));
  return key;
}

/**
 * 구성 요소(작성자 지정/AI/태그)로 유효 플래그를 다시 계산해 저장하고, 민감하면 흐림 사본을 보장한다.
 * 흐림 처리가 실패해도 플래그는 저장된다(fail-closed). 반환: 최신 행.
 */
export async function applySensitivity(deps: PrivacyDeps, photoId: number): Promise<Photo | null> {
  const [photo] = await deps.db.select().from(schema.postPhotos).where(eq(schema.postPhotos.id, photoId)).limit(1);
  if (!photo) return null;
  const sensitive = effectiveSensitive(photo);
  if (sensitive !== photo.sensitive) await deps.db.update(schema.postPhotos).set({ sensitive }).where(eq(schema.postPhotos.id, photoId));
  let current = { ...photo, sensitive };
  if (sensitive && !photo.blurredKey) {
    try {
      const key = await ensureBlurred(deps, current);
      current = { ...current, blurredKey: key };
    } catch {
      // fail-closed: 사본 없음 → 작성자 외에는 열람 불가
    }
  }
  return current;
}

/**
 * viewer 가 원본을 볼 수 있는 글 id 집합(작성자 본인 글 + 소유 확인이 끝난 인수 요청의 대화 상대).
 * photoPostAuthors: postId → 작성자 id
 */
export async function originalAccessPosts(db: Db, viewerId: number, postAuthors: Map<number, number>): Promise<Set<number>> {
  const ok = new Set<number>();
  const others: number[] = [];
  for (const [postId, authorId] of postAuthors) {
    if (authorId === viewerId) ok.add(postId);
    else others.push(postId);
  }
  if (others.length) {
    const rows = await db
      .select({ postId: schema.handoverRequests.postId })
      .from(schema.handoverRequests)
      .innerJoin(schema.conversations, eq(schema.conversations.id, schema.handoverRequests.conversationId))
      .where(
        and(
          inArray(schema.handoverRequests.postId, others),
          inArray(schema.handoverRequests.status, ['VERIFIED', 'COMPLETED']),
          sql`(${schema.conversations.userAId} = ${viewerId} or ${schema.conversations.userBId} = ${viewerId})`,
        ),
      );
    for (const r of rows) ok.add(r.postId);
  }
  return ok;
}

/** viewer 에게 보여줄 사진 URL 과 흐림 여부. 흐림 사본이 없는 민감 사진은 url=null(제공 불가). */
export function viewUrlFor(photo: Pick<Photo, 'url' | 'sensitive' | 'blurredKey'>, canSeeOriginal: boolean): { url: string | null; isBlurred: boolean } {
  if (!photo.sensitive || canSeeOriginal) return { url: photo.url, isBlurred: false };
  return photo.blurredKey ? { url: blurredUrlOf(photo.blurredKey), isBlurred: true } : { url: null, isBlurred: true };
}

/**
 * 글의 태그가 민감 태그(학생증·지갑·카드 등, AI_SENSITIVE_TAGS)면 그 글의 사진에 태그 기반 민감 플래그를 켜고(아니면 끄고)
 * 흐림 사본을 보장한다. 글 작성·태그 수정 직후 호출해 AI 판독 전에도 보호한다.
 */
export async function syncTagSensitivity(deps: PrivacyDeps, postId: number, sensitiveTags: readonly string[]): Promise<void> {
  const wanted = new Set(sensitiveTags.map((t) => t.trim().toLowerCase()).filter(Boolean));
  const tagRows = await deps.db
    .select({ name: schema.tags.name, slug: schema.tags.slug })
    .from(schema.postTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.postTags.tagId))
    .where(eq(schema.postTags.postId, postId));
  const expected = tagRows.some((t) => wanted.has(t.name.toLowerCase()) || (t.slug !== null && wanted.has(t.slug.toLowerCase())));
  const photos = await deps.db.select({ id: schema.postPhotos.id, tag: schema.postPhotos.sensitiveTag }).from(schema.postPhotos).where(eq(schema.postPhotos.postId, postId));
  for (const p of photos) {
    if (p.tag !== expected) await deps.db.update(schema.postPhotos).set({ sensitiveTag: expected }).where(eq(schema.postPhotos.id, p.id));
    await applySensitivity(deps, p.id);
  }
}
