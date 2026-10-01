import { and, desc, eq, inArray, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Ctx } from '../../app.js';
import { schema } from '../../db/client.js';
import { blockedUserIds, isBlockedEither } from '../../lib/blocks.js';
import { retryOnConflict } from '../handovers/service.js';
import { ETC_BUILDING_KEY } from '../../db/seed-data.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { idParam } from '../../lib/pagination.js';
import { me, requireAuth } from '../auth/plugin.js';
import { loadPostCards } from '../posts/service.js';

type MatchRow = typeof schema.matches.$inferSelect;
type LocRow = typeof schema.locations.$inferSelect;

/** 두 글의 위치 차이 등급(점수 비노출): 같은 장소 / 같은 건물 / 인접 건물 / 먼 곳 */
function locationDiff(a?: LocRow, b?: LocRow) {
  if (!a || !b) return 'FAR';
  // "기타"는 실제 장소를 알 수 없어 같은 위치로 보지 않는다
  if (a.buildingKey === ETC_BUILDING_KEY || b.buildingKey === ETC_BUILDING_KEY) return 'FAR';
  if (a.id === b.id) return 'SAME_PLACE';
  if (a.buildingKey === b.buildingKey) return 'SAME_BUILDING';
  if (a.groupId && a.groupId === b.groupId) return 'NEARBY';
  return 'FAR';
}

/** 매칭 점수 수치는 노출하지 않고 등급만 내려준다. AUTO=HIGH, CANDIDATE=MID */
const gradeOf = (level: string) => (level === 'AUTO' ? 'HIGH' : 'MID');

export async function matchRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;

  /** 내 글 기준으로 상대 글 카드와 함께 직렬화 */
  async function serializeFor(rows: MatchRow[], myPostIds: Set<number>, viewerId: number) {
    const hidden = await blockedUserIds(db, viewerId); // [사용자 결정] 차단 관계인 사용자의 글은 매칭에서도 숨김
    const otherIds = rows.map((m) => (myPostIds.has(m.lostPostId) ? m.foundPostId : m.lostPostId));
    const cards = await loadPostCards(db, otherIds, viewerId);
    const byId = new Map(cards.map((c) => [c.id, c]));
    // 위치 차이 등급 계산용: 내 글과 상대 글의 위치
    const myIds = rows.map((m) => (myPostIds.has(m.lostPostId) ? m.lostPostId : m.foundPostId));
    const postLocs = await db
      .select({ id: schema.posts.id, loc: schema.locations })
      .from(schema.posts)
      .innerJoin(schema.locations, eq(schema.locations.id, schema.posts.locationId))
      .where(inArray(schema.posts.id, [...myIds, ...otherIds]));
    const locOf = new Map(postLocs.map((x) => [x.id, x.loc]));
    return rows.flatMap((m, i) => {
      const other = byId.get(otherIds[i]!);
      if (!other || hidden.has(other.author.id)) return [];
      return [
        {
          matchId: m.id,
          level: m.level,
          grade: gradeOf(m.level),
          otherPost: other,
          locationDiff: locationDiff(locOf.get(myIds[i]!), locOf.get(otherIds[i]!)),
          aiReason: m.aiReason,
          status: m.status,
        },
      ];
    });
  }

  app.get('/posts/:id/matches', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, id)).limit(1);
    if (!post) throw notFound('글을 찾을 수 없습니다.');
    if (post.authorId !== me(req).id) throw forbidden('내 글의 매칭만 볼 수 있습니다.');
    const rows = await db
      .select()
      .from(schema.matches)
      .where(and(or(eq(schema.matches.lostPostId, id), eq(schema.matches.foundPostId, id)), inArray(schema.matches.status, ['PENDING', 'CONFIRMED'])))
      .orderBy(desc(schema.matches.totalScore))
      .limit(50);
    return { matchState: post.matchState, items: await serializeFor(rows, new Set([id]), me(req).id) };
  });

  app.get('/me/matches', { preHandler: requireAuth }, async (req) => {
    const mine = await db.select({ id: schema.posts.id }).from(schema.posts).where(and(eq(schema.posts.authorId, me(req).id), eq(schema.posts.type, 'LOST'), inArray(schema.posts.status, ['OPEN', 'MATCHED'])));
    const ids = mine.map((p) => p.id);
    if (!ids.length) return { items: [] };
    const rows = await db
      .select()
      .from(schema.matches)
      .where(and(inArray(schema.matches.lostPostId, ids), inArray(schema.matches.status, ['PENDING', 'CONFIRMED'])))
      .orderBy(desc(schema.matches.totalScore))
      .limit(50);
    return { items: await serializeFor(rows, new Set(ids), me(req).id) };
  });

  async function loadForDecision(matchId: number, userId: number) {
    const [m] = await db.select().from(schema.matches).where(eq(schema.matches.id, matchId)).limit(1);
    if (!m) throw notFound('매칭을 찾을 수 없습니다.');
    const [lost] = await db.select().from(schema.posts).where(eq(schema.posts.id, m.lostPostId)).limit(1);
    // 맞음/아님은 분실글 작성자만 결정한다
    if (!lost || lost.authorId !== userId) throw forbidden('분실글 작성자만 결정할 수 있습니다.');
    // 차단 관계인 상대의 글이 걸린 매칭은 존재하지 않는 것처럼 404
    const [found] = await db.select({ authorId: schema.posts.authorId }).from(schema.posts).where(eq(schema.posts.id, m.foundPostId)).limit(1);
    if (found && (await isBlockedEither(db, userId, found.authorId))) throw notFound('매칭을 찾을 수 없습니다.');
    if (m.status !== 'PENDING') throw conflict('ALREADY_DECIDED', '이미 결정된 매칭입니다.');
    return { m, lost };
  }

  app.get('/matches/:id', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const userId = me(req).id;
    const [m] = await db.select().from(schema.matches).where(eq(schema.matches.id, id)).limit(1);
    if (!m) throw notFound('매칭을 찾을 수 없습니다.');
    const owners = await db.select({ id: schema.posts.id, authorId: schema.posts.authorId }).from(schema.posts).where(inArray(schema.posts.id, [m.lostPostId, m.foundPostId]));
    if (!owners.some((p) => p.authorId === userId)) throw forbidden('관련된 글의 작성자만 볼 수 있습니다.');
    const mine = new Set(owners.filter((p) => p.authorId === userId).map((p) => p.id));
    const [item] = await serializeFor([m], mine, userId);
    if (!item) throw notFound('매칭을 찾을 수 없습니다.');
    return item;
  });

  app.post('/matches/:id/confirm', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { m } = await loadForDecision(id, me(req).id);
    // 매칭 행과 두 글을 잠근 뒤 상태를 다시 확인한다(동시 reject/글 종료/탈퇴와 경합해도 일관)
    // 잠금 순서: 글 -> 매칭 (글 삭제가 글을 잠근 뒤 cascade 로 매칭 행을 지우는 순서와 같게 해 교착을 막는다). 그래도 충돌하면 재시도
    const foundAuthorId = await retryOnConflict(() => db.transaction(async (tx) => {
      const posts = await tx.select().from(schema.posts).where(inArray(schema.posts.id, [m.lostPostId, m.foundPostId])).orderBy(schema.posts.id).for('update');
      const [cur] = await tx.select().from(schema.matches).where(eq(schema.matches.id, id)).for('update');
      if (!cur || cur.status !== 'PENDING') throw conflict('ALREADY_DECIDED', '이미 결정된 매칭입니다.');
      if (posts.length !== 2 || posts.some((p) => p.status !== 'OPEN' && p.status !== 'MATCHED')) throw conflict('POST_CLOSED', '종료된 글이 포함된 매칭은 확정할 수 없습니다.');
      const found = posts.find((p) => p.id === m.foundPostId)!;
      const [author] = await tx.select({ status: schema.users.status }).from(schema.users).where(eq(schema.users.id, found.authorId)).limit(1);
      if (author?.status !== 'ACTIVE') throw conflict('READ_ONLY', '상대 사용자가 탈퇴하여 확정할 수 없습니다.');
      await tx.update(schema.matches).set({ status: 'CONFIRMED' }).where(eq(schema.matches.id, id));
      await tx
        .update(schema.posts)
        .set({ status: 'MATCHED', updatedAt: new Date() })
        .where(and(inArray(schema.posts.id, [m.lostPostId, m.foundPostId]), eq(schema.posts.status, 'OPEN')));
      return found.authorId;
    }));
    const [after] = await db.select().from(schema.matches).where(eq(schema.matches.id, id)).limit(1);
    const [item] = await serializeFor([after!], new Set([m.lostPostId]), me(req).id);
    // 쪽지 시작 안내: 습득글 작성자와 습득글 맥락으로 POST /conversations 호출
    return { ...item, suggestedConversation: { otherUserId: foundAuthorId, postId: m.foundPostId } };
  });

  app.post('/matches/:id/reject', { preHandler: requireAuth }, async (req) => {
    const { id } = idParam.parse(req.params);
    const { m } = await loadForDecision(id, me(req).id);
    // 기대 상태(PENDING)일 때만 전이: 동시에 confirm 이 먼저 커밋됐다면 갱신 0건 → 409
    const updated = await db.update(schema.matches).set({ status: 'REJECTED' }).where(and(eq(schema.matches.id, id), eq(schema.matches.status, 'PENDING'))).returning({ id: schema.matches.id });
    if (!updated.length) throw conflict('ALREADY_DECIDED', '이미 결정된 매칭입니다.');
    const [after] = await db.select().from(schema.matches).where(eq(schema.matches.id, id)).limit(1);
    const [item] = await serializeFor([after!], new Set([m.lostPostId]), me(req).id);
    return item;
  });
}
