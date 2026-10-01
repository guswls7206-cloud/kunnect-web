import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, ne, notInArray, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { schema } from '../db/client.js';
import { ETC_BUILDING_KEY } from '../db/seed-data.js';
import { notify } from '../lib/notify.js';
import { applySensitivity } from '../lib/photo-privacy.js';
import { prepareImageForAi } from '../matching/image.js';
import type { MatchingEngine, PhotoAttributes, PostInput, RankedMatch } from '../matching/types.js';
import type { MatchingConfig } from '../matching/weights.js';
import type { PhotoStorage } from '../storage/index.js';
import type { MatchHandler } from './queue.js';

type PostRow = typeof schema.posts.$inferSelect;

export interface MatchHandlerDeps {
  db: Db;
  storage: PhotoStorage;
  engine: MatchingEngine;
  config: MatchingConfig;
  /** [가정/제안] 사진 없는 매칭(NO_PHOTO)의 AUTO 알림 허용 여부. 기본 true(강등 없음, 사용자 결정). */
  noPhotoAutoNotify?: boolean;
}

const IMAGE_CONCURRENCY = 8;

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** AI 전송용 사본을 돌려준다: 캐시(ai_key)가 있으면 그것을 읽고, 없으면 원본에서 만들어 저장한다. 실패하면 null(속성만 사용). */
async function loadAiImage(deps: MatchHandlerDeps, row: typeof schema.postPhotos.$inferSelect): Promise<{ base64: string; mediaType: 'image/jpeg' } | null> {
  const { db, storage, config } = deps;
  if (row.aiKey) {
    try {
      return { base64: (await storage.read(row.aiKey)).toString('base64'), mediaType: 'image/jpeg' };
    } catch {
      // 캐시 파일이 사라졌으면 아래에서 다시 만든다
    }
  }
  try {
    const prepared = await prepareImageForAi(await storage.read(row.storageKey), config.image);
    const key = `ai/${randomBytes(12).toString('hex')}.jpg`;
    await storage.save(key, Buffer.from(prepared.base64, 'base64'));
    await db.update(schema.postPhotos).set({ aiKey: key }).where(eq(schema.postPhotos.id, row.id));
    return { base64: prepared.base64, mediaType: prepared.mediaType };
  } catch {
    return null;
  }
}

/** DB 행 → 엔진 입력. hidden_features 는 절대 전달하지 않는다. includeImages=false 면 사진 base64 를 읽지 않는다. */
export async function toPostInputs(deps: MatchHandlerDeps, posts: PostRow[], includeImages = true): Promise<PostInput[]> {
  const { db } = deps;
  if (!posts.length) return [];
  const ids = posts.map((p) => p.id);
  const locs = await db.select().from(schema.locations).where(inArray(schema.locations.id, posts.map((p) => p.locationId)));
  const tagRows = await db
    .select({ postId: schema.postTags.postId, name: schema.tags.name, slug: schema.tags.slug, isPreset: schema.tags.isPreset })
    .from(schema.postTags)
    .innerJoin(schema.tags, eq(schema.tags.id, schema.postTags.tagId))
    .where(inArray(schema.postTags.postId, ids));
  const photos = await db.select().from(schema.postPhotos).where(inArray(schema.postPhotos.postId, ids)).orderBy(schema.postPhotos.order);

  const result: PostInput[] = [];
  for (const p of posts) {
    const loc = locs.find((l) => l.id === p.locationId);
    const myTags = tagRows.filter((t) => t.postId === p.id);
    const myPhotos = photos.filter((ph) => ph.postId === p.id);
    const photoInputs: PostInput['photos'] = myPhotos.map((ph) => ({ id: String(ph.id), attributes: (ph.aiAttributes as PhotoAttributes | null) ?? null }));
    result.push({
      id: String(p.id),
      type: p.type as 'LOST' | 'FOUND',
      authorId: String(p.authorId),
      title: p.title,
      description: p.description,
      presetTags: myTags.filter((t) => t.isPreset && t.slug).map((t) => t.slug as string),
      customTags: myTags.filter((t) => !t.isPreset).map((t) => t.name),
      occurredAt: p.occurredAt.toISOString(),
      // "기타"(자유 입력 장소)는 건물을 알 수 없으므로 위치 정보 없음으로 매칭한다(같은 건물·인접·거리 점수 없음).
      location: loc && loc.buildingKey !== ETC_BUILDING_KEY
        ? { id: String(loc.id), buildingId: loc.buildingKey, buildingName: loc.buildingName, floor: loc.floor, groupId: loc.groupId, lat: loc.lat, lng: loc.lng }
        : null,
      photos: photoInputs,
      // 작성자가 "민감함"으로 표시한 사진이 있으면 엔진이 처음 전송부터 흐림/생략 정책을 적용한다
      sensitiveHint: myPhotos.some((ph) => ph.sensitiveOverride === 'MARK') || undefined,
    });
  }
  if (includeImages) {
    // 비교(top-N)에 쓰일 수 있도록 AI 전송용 사본(base64)을 첨부한다. 사진마다 순차로 읽고 리사이즈하지 않고,
    // 캐시된 축소 사본(ai_key)을 동시 실행 수를 제한해 읽는다. 사본이 없으면 한 번 만들어 저장해 다음부터 재사용한다.
    const jobs: { target: PostInput['photos'][number]; row: typeof schema.postPhotos.$inferSelect }[] = [];
    for (const input of result) {
      for (const ph of input.photos) {
        const row = photos.find((x) => String(x.id) === ph.id);
        if (row) jobs.push({ target: ph, row });
      }
    }
    await mapLimit(jobs, IMAGE_CONCURRENCY, async ({ target, row }) => {
      const img = await loadAiImage(deps, row);
      if (img) {
        target.base64 = img.base64;
        target.mediaType = img.mediaType;
      }
    });
  }
  return result;
}

/**
 * 매칭 작업 핸들러: 속성 추출 → 후보 선별(SQL) → 엔진 평가 → matches 저장 → 처음 AUTO 일 때 분실자에게 1회 알림.
 * 엔진은 AI 오류에도 throw 하지 않는다(degraded). DB 오류만 작업 재시도 대상이다.
 */
export function createMatchHandler(deps: MatchHandlerDeps): MatchHandler {
  const { db, storage, engine, config } = deps;

  return async (postId: number) => {
    const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, postId)).limit(1);
    if (!post || post.status !== 'OPEN') return; // 종료/반환된 글은 매칭하지 않는다

    // 1) 이 글의 사진 속성 추출 → post_photos.ai_attributes 에 캐시
    const [input] = await toPostInputs(deps, [post], true);
    if (!input) return;
    const extraction = await engine.extractAttributes(input);
    for (const ph of extraction.photos) {
      const id = Number(ph.photoId);
      if (ph.status === 'OK' && ph.attributes) {
        await db.update(schema.postPhotos).set({ aiAttributes: ph.attributes, aiStatus: 'DONE' }).where(eq(schema.postPhotos.id, id));
        const mine = input.photos.find((x) => x.id === ph.photoId);
        if (mine) mine.attributes = ph.attributes;
        // 민감 정보 감지(학생증·카드·얼굴 등): 신뢰도 이상이면 민감 사진으로 표시하고 흐림 사본을 만든다(작성자 외에는 사본만 열람)
        const detected = !!ph.sensitive && ph.sensitive.confidence >= config.exposure.detectMinConfidence;
        await db
          .update(schema.postPhotos)
          .set({ sensitiveAi: detected, sensitiveKinds: ph.sensitive?.kinds ?? null })
          .where(eq(schema.postPhotos.id, id));
        await applySensitivity({ db, storage }, id);
      } else if (ph.status === 'FAILED') {
        await db.update(schema.postPhotos).set({ aiStatus: 'FAILED' }).where(eq(schema.postPhotos.id, id));
      }
    }

    // 2) 후보 선별: 반대 유형·진행 중·작성자 다름·서로 차단 아님, 최신순 상한
    const oppositeType = post.type === 'LOST' ? 'FOUND' : 'LOST';
    const blocked = await db
      .select({ a: schema.blocks.blockerId, b: schema.blocks.blockedId })
      .from(schema.blocks)
      .where(or(eq(schema.blocks.blockerId, post.authorId), eq(schema.blocks.blockedId, post.authorId)));
    const blockedIds = blocked.map((x) => (x.a === post.authorId ? x.b : x.a));
    const candidateRows = await db
      .select()
      .from(schema.posts)
      .where(
        and(
          eq(schema.posts.type, oppositeType),
          eq(schema.posts.status, 'OPEN'),
          ne(schema.posts.authorId, post.authorId),
          blockedIds.length ? notInArray(schema.posts.authorId, blockedIds) : undefined,
        ),
      )
      // 최신 글 우선(id 내림차순). 엔진의 정렬은 안정 정렬이라 점수가 같으면 이 순서(최신 먼저)가 유지된다
      .orderBy(desc(schema.posts.id))
      .limit(Math.min(config.maxCandidates, 50)); // 이미지 base64 로드 비용을 고려해 50건으로 제한
    // 내 글에 사진이 없으면 모든 쌍이 NO_PHOTO 라 이미지가 필요 없다
    const candidates = await toPostInputs(deps, candidateRows, input.photos.length > 0);

    // 3) 엔진 평가 → 저장
    const ranked = await engine.rankCandidates(input, candidates, { topN: config.topN });
    for (const r of ranked) await saveMatch(db, r, deps.noPhotoAutoNotify ?? true);

    // 4) 이전에 저장됐지만 이번 평가에서 빠진(IGNORE/제외) 미결정·미알림 매칭 정리
    const keptCandidateIds = ranked.filter((r) => r.grade !== 'IGNORE').map((r) => Number(r.candidateId));
    const col = post.type === 'LOST' ? schema.matches.lostPostId : schema.matches.foundPostId;
    const other = post.type === 'LOST' ? schema.matches.foundPostId : schema.matches.lostPostId;
    await db
      .delete(schema.matches)
      .where(
        and(
          eq(col, post.id),
          eq(schema.matches.status, 'PENDING'),
          sql`${schema.matches.notifiedAt} is null`,
          keptCandidateIds.length ? notInArray(other, keptCandidateIds) : undefined,
        ),
      );
  };
}

async function saveMatch(db: Db, r: RankedMatch, allowNoPhotoAuto: boolean) {
  if (r.grade === 'IGNORE') return;
  // 신호가 위치·태그 2개뿐인 NO_PHOTO 결과는 오탐 위험이 커서 기본적으로 알림(AUTO)을 보내지 않는다
  const grade = r.grade === 'AUTO' && r.mode === 'NO_PHOTO' && !allowNoPhotoAuto ? 'CANDIDATE' : r.grade;
  const lostId = Number(r.lostPostId);
  const foundId = Number(r.foundPostId);
  const [existing] = await db
    .select()
    .from(schema.matches)
    .where(and(eq(schema.matches.lostPostId, lostId), eq(schema.matches.foundPostId, foundId)))
    .limit(1);
  // 이미 알림이 나간 AUTO 는 강등하지 않는다
  const level = existing?.level === 'AUTO' ? 'AUTO' : grade;
  const values = {
    photoScore: r.breakdown.photo ?? null,
    locationScore: r.breakdown.location,
    tagScore: r.breakdown.tag,
    totalScore: r.score,
    level,
    mode: r.mode,
    degraded: r.degraded,
    aiReason: r.aiReason ?? null,
  };
  let matchId: number;
  const notifiedAt = existing?.notifiedAt ?? null;
  const status = existing?.status ?? 'PENDING';
  if (existing) {
    matchId = existing.id;
    await db.update(schema.matches).set(values).where(eq(schema.matches.id, existing.id));
  } else {
    const [row] = await db.insert(schema.matches).values({ lostPostId: lostId, foundPostId: foundId, ...values }).onConflictDoNothing().returning();
    if (!row) return; // 동시 실행으로 다른 워커가 먼저 저장 — 다음 평가에서 반영
    matchId = row.id;
  }
  // 처음 AUTO 가 되는 순간 분실자에게 1회만 알림. REJECTED/CONFIRMED 매칭에는 보내지 않는다
  if (level === 'AUTO' && !notifiedAt && status === 'PENDING') {
    // 발송 기록(notifiedAt)과 알림 생성은 한 트랜잭션: notify 가 실패하면 기록도 롤백되어 재시도에서 알림이 유실되지 않는다
    await db.transaction(async (tx) => {
      const claimed = await tx
        .update(schema.matches)
        .set({ notifiedAt: new Date() })
        .where(and(eq(schema.matches.id, matchId), sql`${schema.matches.notifiedAt} is null`))
        .returning({ id: schema.matches.id });
      if (!claimed.length) return;
      const [lost] = await tx.select({ authorId: schema.posts.authorId }).from(schema.posts).where(eq(schema.posts.id, lostId)).limit(1);
      if (lost) await notify(tx as unknown as typeof db, { userId: lost.authorId, type: 'MATCH', postId: lostId, matchId });
    });
  }
}
