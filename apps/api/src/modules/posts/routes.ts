import { and, count, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { schema } from '../../db/client.js';
import { ETC_BUILDING_KEY } from '../../db/seed-data.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { decodeCursor, idParam, pageQuery, toPage } from '../../lib/pagination.js';
import { isBlockedEither, notBlockedWith } from '../../lib/blocks.js';
import { maskContacts } from '../../lib/contact-mask.js';
import { escapeLike } from '../../lib/pg.js';
import { syncTagSensitivity } from '../../lib/photo-privacy.js';
import { deleteFiles, hardDeletePosts } from '../../lib/hard-delete.js';
import { loadMatchingConfig } from '../../matching/index.js';
import { retryOnConflict } from '../handovers/service.js';
import { normalizeTag } from '../../lib/tags.js';
import { me, requireAuth } from '../auth/plugin.js';
import { loadAttachablePhotos, loadPostCards, loadPostDetail, resolveTagIds } from './service.js';

const POST_TYPES = ['LOST', 'FOUND'] as const;
const POST_STATUSES = ['OPEN', 'MATCHED', 'RETURNED', 'CLOSED'] as const;
const DAILY_POST_LIMIT = 10;
const MIN_OCCURRED_AT = Date.parse('2020-01-01T00:00:00Z'); // 합리적 하한(서비스 시작 이전의 시각은 입력 오류로 본다)

const tagsField = z.array(z.string().max(40)).max(8);
/** 위치가 "기타"일 때 쓰는 자유 입력 장소. 빈 문자열은 입력 없음(null)으로 본다. */
const LOCATION_TEXT_MAX = 50;
const locationTextField = z
  .string()
  .trim()
  .max(LOCATION_TEXT_MAX, `장소는 ${LOCATION_TEXT_MAX}자 이하로 입력해 주세요.`)
  .nullish()
  .transform((v) => (v ? v : null));
const createBody = z.object({
  type: z.enum(POST_TYPES),
  title: z.string().trim().min(1, '제목을 입력해 주세요.').max(50),
  description: z.string().trim().min(1, '설명을 입력해 주세요.').max(1000),
  locationId: z.number().int().positive(),
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
  // 오프셋이 있는 ISO 8601 문자열만 허용(오프셋 없는 값은 서버 시간대에 따라 달라지고, null/0 이 1970 으로 변환되는 것을 막는다)
  occurredAt: z
    .string()
    .datetime({ offset: true })
    .transform((v) => new Date(v))
    .refine((d) => d.getTime() >= MIN_OCCURRED_AT, '너무 오래된 시각입니다.'),
  tags: tagsField.default([]),
  storagePlace: z.string().trim().max(100).optional(),
  hiddenFeatures: z.string().trim().max(300).optional(),
  locationText: locationTextField,
  photoIds: z.array(z.number().int().positive()).max(3).default([]),
});
const updateBody = z.object({
  title: z.string().trim().min(1).max(50).optional(),
  description: z.string().trim().min(1).max(1000).optional(),
  tags: tagsField.optional(),
  storagePlace: z.string().trim().max(100).optional(),
  hiddenFeatures: z.string().trim().max(300).optional(),
  /** 위치가 "기타"인 글만 바꿀 수 있다(위치 자체는 수정 불가). */
  locationText: locationTextField.optional(),
});
const listQuery = pageQuery.extend({
  type: z.enum(POST_TYPES).optional(),
  status: z.enum(POST_STATUSES).optional(),
  locationId: z.coerce.number().int().positive().optional(),
  buildingId: z.string().max(60).optional(),
  tag: z.string().max(40).optional(),
  q: z.string().trim().max(50).optional(),
});

/** [가정/제안] 공개되는 글 텍스트(제목·설명·보관 장소·기타 장소)에도 댓글과 같은 연락처 마스킹을 적용한다(앱 밖 연락 유도 방지). */
function maskPostText<T extends { title?: string; description?: string; storagePlace?: string; locationText?: string | null }>(b: T): T {
  const out: Record<string, unknown> = { ...b };
  for (const k of ['title', 'description', 'storagePlace', 'locationText'] as const) {
    const v = out[k];
    if (typeof v === 'string') out[k] = maskContacts(v).text;
  }
  return out as T;
}


/** "기타" 위치는 장소 입력이 필수, 그 외 위치는 입력 불가(400). */
function assertLocationText(buildingKey: string, locationText: string | null) {
  if (buildingKey === ETC_BUILDING_KEY && !locationText) {
    throw badRequest('VALIDATION_ERROR', '기타 위치는 장소를 입력해야 합니다.', { locationText: '장소를 입력해 주세요.' });
  }
  if (buildingKey !== ETC_BUILDING_KEY && locationText) {
    throw badRequest('VALIDATION_ERROR', '장소 직접 입력은 기타 위치에서만 쓸 수 있습니다.', { locationText: '기타 위치에서만 입력할 수 있습니다.' });
  }
}

export async function postRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  // 민감 태그 목록(AI_SENSITIVE_TAGS, 기본 student_id,wallet,카드) — 매칭 엔진 설정과 같은 값을 쓴다
  const sensitiveTags = loadMatchingConfig(process.env).exposure.tags;

  async function mustOwn(postId: number, userId: number) {
    const [p] = await db.select().from(schema.posts).where(eq(schema.posts.id, postId)).limit(1);
    if (!p) throw notFound('글을 찾을 수 없습니다.');
    if (p.authorId !== userId) throw forbidden('내 글만 수정할 수 있습니다.');
    return p;
  }

  app.post('/posts', { preHandler: requireAuth, config: ctx.rl(30, 3600_000) }, async (req, reply) => {
    const user = me(req);
    const body = maskPostText(createBody.parse(req.body));
    if (body.occurredAt.getTime() > Date.now() + 5 * 60_000) throw badRequest('FUTURE_TIME', '미래 시각은 입력할 수 없습니다.', { occurredAt: '미래 시각은 입력할 수 없습니다.' });
    if (body.type === 'FOUND' && !body.storagePlace) throw badRequest('VALIDATION_ERROR', '습득글은 보관 장소가 필요합니다.', { storagePlace: '보관 장소를 입력해 주세요.' });
    if (ctx.rateLimitEnabled) {
      // 일일 작성 상한(운영 환경 한정)
      const since = new Date(Date.now() - 24 * 3600_000);
      const [c] = await db.select({ c: count() }).from(schema.posts).where(and(eq(schema.posts.authorId, user.id), sql`${schema.posts.createdAt} > ${since}`));
      if ((c?.c ?? 0) >= DAILY_POST_LIMIT) throw new AppError(429, 'RATE_LIMITED', '하루에 작성할 수 있는 글 수를 초과했습니다.');
    }
    const [loc] = await db.select().from(schema.locations).where(eq(schema.locations.id, body.locationId)).limit(1);
    // 숨긴 예전 더미 위치로는 새 글을 쓸 수 없다(기존 글은 그대로 유지).
    if (!loc || loc.isDummy) throw badRequest('VALIDATION_ERROR', '존재하지 않는 위치입니다.', { locationId: '존재하지 않는 위치입니다.' });
    assertLocationText(loc.buildingKey, body.locationText);
    const photos = await loadAttachablePhotos(db, user.id, body.photoIds);
    if (photos.length !== body.photoIds.length) throw new AppError(422, 'PHOTO_NOT_OWNED', '사용할 수 없는 사진이 포함되어 있습니다.');

    const postId = await db.transaction(async (tx) => {
      const [p] = await tx
        .insert(schema.posts)
        .values({
          type: body.type,
          authorId: user.id,
          title: body.title,
          description: body.description,
          locationId: body.locationId,
          lat: body.lat,
          lng: body.lng,
          occurredAt: body.occurredAt,
          storagePlace: body.type === 'FOUND' ? body.storagePlace : null,
          hiddenFeatures: body.type === 'FOUND' ? (body.hiddenFeatures ?? null) : null,
          locationText: body.locationText,
        })
        .returning({ id: schema.posts.id });
      const tagIds = await resolveTagIds(tx, body.tags);
      if (tagIds.length) await tx.insert(schema.postTags).values(tagIds.map((tagId) => ({ postId: p!.id, tagId })));
      // 요청한 photoIds 순서대로 order 부여
      // 조건부 갱신(내 소유 + 아직 연결 안 됨)으로 동시 요청이 같은 사진을 두 글에 붙이는 경합을 막는다
      for (const [i, photoId] of body.photoIds.entries()) {
        const attached = await tx
          .update(schema.postPhotos)
          .set({ postId: p!.id, order: i })
          .where(and(eq(schema.postPhotos.id, photoId), eq(schema.postPhotos.ownerId, user.id), isNull(schema.postPhotos.postId)))
          .returning({ id: schema.postPhotos.id });
        if (!attached.length) throw new AppError(422, 'PHOTO_NOT_OWNED', '사용할 수 없는 사진이 포함되어 있습니다.');
      }
      // 매칭 작업 등록도 같은 트랜잭션: 글만 남고 작업이 없는 상태(클라이언트 재시도 시 중복 글)를 막는다
      await tx.insert(schema.jobs).values({ type: 'MATCH_POST', payload: { postId: p!.id } });
      return p!.id;
    });
    await syncTagSensitivity({ db, storage: ctx.storage }, postId, sensitiveTags);
    return reply.status(201).send(await loadPostDetail(db, postId, user.id));
  });

  app.get('/posts', { preHandler: requireAuth }, async (req) => {
    const q = listQuery.parse(req.query);
    const cursor = decodeCursor(q.cursor);
    let tagFilter;
    if (q.tag) {
      const name = normalizeTag(q.tag);
      tagFilter = name
        ? sql`exists (select 1 from post_tags pt join tags t on t.id = pt.tag_id where pt.post_id = ${schema.posts.id} and (t.name = ${name} or t.slug = ${name}))`
        : sql`false`;
    }
    const search = q.q ? `%${escapeLike(q.q)}%` : null;
    const rows = await db
      .select({ id: schema.posts.id })
      .from(schema.posts)
      .where(
        and(
          q.type ? eq(schema.posts.type, q.type) : undefined,
          // 상태를 지정하지 않으면 진행 중인 글(OPEN/MATCHED)만 노출
          q.status ? eq(schema.posts.status, q.status) : inArray(schema.posts.status, ['OPEN', 'MATCHED']),
          // 종료(CLOSED)된 글은 작성자 본인 것만 목록에 나온다
          q.status === 'CLOSED' ? eq(schema.posts.authorId, me(req).id) : undefined,
          // [사용자 결정] 차단 관계(양방향)인 사용자의 글은 목록·검색에서 제외
          notBlockedWith(me(req).id, schema.posts.authorId),
          q.locationId ? eq(schema.posts.locationId, q.locationId) : undefined,
          q.buildingId
            ? sql`${schema.posts.locationId} in (select id from locations where building_key = ${q.buildingId})`
            : undefined,
          tagFilter,
          search ? or(ilike(schema.posts.title, search), ilike(schema.posts.description, search)) : undefined,
          cursor ? lt(schema.posts.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(schema.posts.id))
      .limit(q.limit + 1);
    const page = toPage(rows, q.limit);
    return { items: await loadPostCards(db, page.items.map((r) => r.id), me(req).id), nextCursor: page.nextCursor };
  });

  app.get('/me/posts', { preHandler: requireAuth }, async (req) => {
    const q = pageQuery.extend({ type: z.enum(POST_TYPES).optional(), status: z.enum(POST_STATUSES).optional() }).parse(req.query);
    const cursor = decodeCursor(q.cursor);
    const rows = await db
      .select({ id: schema.posts.id })
      .from(schema.posts)
      .where(
        and(
          eq(schema.posts.authorId, me(req).id),
          q.type ? eq(schema.posts.type, q.type) : undefined,
          q.status ? eq(schema.posts.status, q.status) : undefined,
          cursor ? lt(schema.posts.id, cursor) : undefined,
        ),
      )
      .orderBy(desc(schema.posts.id))
      .limit(q.limit + 1);
    const page = toPage(rows, q.limit);
    return { items: await loadPostCards(db, page.items.map((r) => r.id), me(req).id), nextCursor: page.nextCursor };
  });

  app.get('/posts/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const detail = await loadPostDetail(db, id, me(req).id);
    if (!detail) throw notFound('글을 찾을 수 없습니다.');
    // [가정/제안] 작성자가 종료(CLOSED)한 글과 탈퇴한 작성자의 글은 작성자 본인 외에는 볼 수 없다(RETURNED 는 공개 유지)
    if (!detail.isMine) {
      const [author] = await db.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, detail.author!.id)).limit(1);
      if (detail.status === 'CLOSED' || author?.status === 'DELETED') throw notFound('글을 찾을 수 없습니다.');
      // [사용자 결정] 차단 관계(양방향)인 사용자의 글은 상세도 404
      if (await isBlockedEither(db, me(req).id, detail.author!.id)) throw notFound('글을 찾을 수 없습니다.');
    }
    return detail;
  });

  app.patch('/posts/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const user = me(req);
    const body = maskPostText(updateBody.parse(req.body));
    const p = await mustOwn(id, user.id);
    if (p.status === 'RETURNED' || p.status === 'CLOSED') throw conflict('POST_CLOSED', '종료된 글은 수정할 수 없습니다.');
    if (p.type === 'FOUND' && body.storagePlace === '') throw badRequest('VALIDATION_ERROR', '보관 장소가 필요합니다.');
    if (body.locationText !== undefined) {
      const [loc] = await db.select({ buildingKey: schema.locations.buildingKey }).from(schema.locations).where(eq(schema.locations.id, p.locationId)).limit(1);
      assertLocationText(loc?.buildingKey ?? '', body.locationText);
    }
    // 바꿀 값이 없으면 갱신 시각·매칭 재실행 없이 현재 상태를 돌려준다
    if (Object.values(body).every((v) => v === undefined)) return loadPostDetail(db, id, user.id);
    await db.transaction(async (tx) => {
      const set: Partial<typeof schema.posts.$inferInsert> = { updatedAt: new Date() };
      if (body.title !== undefined) set.title = body.title;
      if (body.description !== undefined) set.description = body.description;
      if (body.locationText !== undefined) set.locationText = body.locationText;
      if (p.type === 'FOUND') {
        if (body.storagePlace !== undefined) set.storagePlace = body.storagePlace;
        if (body.hiddenFeatures !== undefined) set.hiddenFeatures = body.hiddenFeatures;
      }
      await tx.update(schema.posts).set(set).where(eq(schema.posts.id, id));
      if (body.tags) {
        await tx.delete(schema.postTags).where(eq(schema.postTags.postId, id));
        const tagIds = await resolveTagIds(tx, body.tags);
        if (tagIds.length) await tx.insert(schema.postTags).values(tagIds.map((tagId) => ({ postId: id, tagId })));
      }
      // 수정 시 매칭 재실행(같은 트랜잭션에서 작업 등록)
      await tx.insert(schema.jobs).values({ type: 'MATCH_POST', payload: { postId: id } });
      await tx.update(schema.posts).set({ matchState: 'PENDING' }).where(eq(schema.posts.id, id));
    });
    if (body.tags) await syncTagSensitivity({ db, storage: ctx.storage }, id, sensitiveTags);
    return loadPostDetail(db, id, user.id);
  });

  /** 진행 중(OPEN/MATCHED)인 글만 CLOSED 로 전환한다(조용히 닫기). 이미 CLOSED 면 멱등(변경 없음), RETURNED 는 되돌릴 수 없다. */
  const close = async (id: number, userId: number) => {
    await mustOwn(id, userId);
    const closed = await db
      .update(schema.posts)
      .set({ status: 'CLOSED', closedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.posts.id, id), inArray(schema.posts.status, ['OPEN', 'MATCHED'])))
      .returning({ id: schema.posts.id });
    if (closed.length) return;
    const [cur] = await db.select({ status: schema.posts.status }).from(schema.posts).where(eq(schema.posts.id, id)).limit(1);
    if (cur?.status === 'RETURNED') throw conflict('INVALID_TRANSITION', '이미 반환 완료된 글은 종료할 수 없습니다.');
  };

  /**
   * 글 삭제 = 즉시 영구 삭제 [가정/제안 A32]. 모든 상태에서 가능, 진행 중 인수 요청이 있으면 409 ACTIVE_HANDOVER.
   * 사진 파일(원본/AI/흐림)·댓글·매칭·알림·인수 기록은 함께 삭제되고, 쪽지 메시지는 남고 글 맥락만 사라진다. 이미 삭제됐으면 404.
   * 잠금 순서(대화 -> 인수 -> 글)는 hardDeletePosts 가 지키며 40P01/40001 은 재시도한다. 파일은 커밋 후 삭제한다.
   */
  app.delete('/posts/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    await mustOwn(id, me(req).id);
    const removed = await retryOnConflict(() => db.transaction((tx) => hardDeletePosts(tx, [id], { rejectIfActiveHandover: true })));
    if (!removed.postIds.length) throw notFound('글을 찾을 수 없습니다.'); // 동시에 이미 삭제됨
    await deleteFiles(ctx.storage, removed.fileKeys);
    return reply.status(204).send();
  });

  app.post('/posts/:id/status', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const user = me(req);
    const { status } = z.object({ status: z.enum(['CLOSED', 'RETURNED']) }).parse(req.body);
    const p = await mustOwn(id, user.id);
    if (status === 'RETURNED') throw conflict('INVALID_TRANSITION', '반환 완료는 쪽지의 인수 완료 절차로만 변경할 수 있습니다.');
    if (p.status === 'RETURNED') throw conflict('INVALID_TRANSITION', '이미 반환 완료된 글입니다.');
    await close(id, user.id);
    return loadPostDetail(db, id, user.id);
  });
}
