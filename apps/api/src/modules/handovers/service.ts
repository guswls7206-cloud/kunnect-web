import { and, desc, eq, inArray, ne, or } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { schema } from '../../db/client.js';

type Handover = typeof schema.handoverRequests.$inferSelect;
type Conv = typeof schema.conversations.$inferSelect;
type Post = typeof schema.posts.$inferSelect;
/** 트랜잭션 안/밖 어디서든 쓸 수 있는 쿼리 실행자 */
export type Executor = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** 인수 대상이 될 수 있는 글 상태 */
export const ACTIVE_POST = ['OPEN', 'MATCHED'];

/**
 * matchId 없이 완료되는 인수에서 상대 글(분실글↔습득글의 짝)을 추론한다 [가정/제안].
 * 규칙: 대상 글과 매칭(거절되지 않은 것)이 있고, 그 상대 글의 작성자가 이 대화의 상대방이며, 상대 글이 아직 OPEN/MATCHED 인 경우만 후보.
 *  - 후보 상대 글이 정확히 1개면 선택.
 *  - 둘 이상이면 CONFIRMED 매칭의 상대 글이 정확히 1개일 때만 선택(추측하지 않는다).
 *  - 매칭 행이 없으면 추론하지 않는다(무관한 글을 닫지 않기 위함).
 * 못 찾으면 null(호출 측이 기존 동작으로 폴백).
 */
export async function inferCounterpart(ex: Executor, post: Post, otherUserId: number): Promise<{ matchId: number; counterpartPostId: number } | null> {
  const mine = post.type === 'FOUND' ? schema.matches.foundPostId : schema.matches.lostPostId;
  const theirs = post.type === 'FOUND' ? schema.matches.lostPostId : schema.matches.foundPostId;
  const cands = await ex
    .select({ matchId: schema.matches.id, status: schema.matches.status, counterpartPostId: theirs })
    .from(schema.matches)
    .innerJoin(schema.posts, eq(schema.posts.id, theirs))
    .where(and(eq(mine, post.id), ne(schema.matches.status, 'REJECTED'), eq(schema.posts.authorId, otherUserId), inArray(schema.posts.status, ACTIVE_POST)));
  if (!cands.length) return null;
  const pick = (rows: typeof cands) => {
    const distinct = new Set(rows.map((r) => r.counterpartPostId));
    if (distinct.size !== 1) return null;
    // 같은 상대 글에 매칭이 여럿일 수는 없다(쌍 유니크)지만, 방어적으로 CONFIRMED 우선
    const best = [...rows].sort((a, b) => Number(b.status === 'CONFIRMED') - Number(a.status === 'CONFIRMED'))[0]!;
    return { matchId: best.matchId, counterpartPostId: best.counterpartPostId };
  };
  return pick(cands) ?? pick(cands.filter((r) => r.status === 'CONFIRMED'));
}

/**
 * 인수 완료 시 매칭 정리: 짝 매칭은 CONFIRMED, 반환된 글에 걸린 나머지 대기(PENDING) 매칭은 REJECTED 로 닫는다.
 * 반환된 글은 더 이상 매칭 후보가 아니므로(OPEN 만 매칭) 추가 알림이 나가지 않고 목록에서도 사라진다.
 */
export async function closeMatchesOnReturn(ex: Executor, returnedPostIds: number[], pairMatchId: number | null) {
  if (pairMatchId !== null) {
    await ex.update(schema.matches).set({ status: 'CONFIRMED' }).where(and(eq(schema.matches.id, pairMatchId), eq(schema.matches.status, 'PENDING')));
  }
  await ex
    .update(schema.matches)
    .set({ status: 'REJECTED' })
    .where(
      and(
        eq(schema.matches.status, 'PENDING'),
        or(inArray(schema.matches.lostPostId, returnedPostIds), inArray(schema.matches.foundPostId, returnedPostIds)),
        pairMatchId !== null ? ne(schema.matches.id, pairMatchId) : undefined,
      ),
    );
}

/**
 * 인수 요청의 역할 계산.
 * - 습득글(FOUND)이 대상이면 그 글 작성자가 습득자(finder), 대화 상대가 주인(owner).
 * - 분실글(LOST)이 대상이면 그 글 작성자가 주인, 대화 상대가 습득자.
 */
export function rolesOf(conv: Conv, post: Post) {
  const other = conv.userAId === post.authorId ? conv.userBId : conv.userAId;
  return post.type === 'FOUND' ? { finderId: post.authorId, ownerId: other } : { finderId: other, ownerId: post.authorId };
}

export function serializeHandover(h: Handover, conv: Conv, post: Post, viewerId: number) {
  const { finderId, ownerId } = rolesOf(conv, post);
  const iAmFinder = viewerId === finderId;
  const myConfirmed = !!(iAmFinder ? h.foundSideConfirmedAt : h.lostSideConfirmedAt);
  const otherConfirmed = !!(iAmFinder ? h.lostSideConfirmedAt : h.foundSideConfirmedAt);
  return {
    id: h.id,
    conversationId: h.conversationId,
    postId: h.postId,
    matchId: h.matchId,
    status: h.status,
    finderId,
    ownerId,
    myRole: iAmFinder ? ('FINDER' as const) : ('OWNER' as const),
    myConfirmed,
    otherConfirmed,
    canVerify: iAmFinder && h.status === 'REQUESTED',
    canReject: iAmFinder && (h.status === 'REQUESTED' || h.status === 'VERIFIED'),
    canComplete: h.status === 'VERIFIED' && !myConfirmed,
    // 완료된 인수에서 상대 글(짝)까지 닫았는가. false 면 짝을 특정하지 못해 이 글만 RETURNED 로 닫힌 것(폴백). 완료 전에는 null
    counterpartLinked: h.status === 'COMPLETED' ? h.matchId !== null : null,
  };
}

/** 대화들의 최신 인수 요청(있으면)을 viewer 기준으로 직렬화해 대화 id → 객체 맵으로 돌려준다. */
export async function latestHandovers(db: Db, convs: Conv[], viewerId: number) {
  const map = new Map<number, ReturnType<typeof serializeHandover>>();
  if (!convs.length) return map;
  const rows = await db
    .select()
    .from(schema.handoverRequests)
    .where(
      inArray(
        schema.handoverRequests.conversationId,
        convs.map((c) => c.id),
      ),
    )
    .orderBy(desc(schema.handoverRequests.id));
  const posts = rows.length ? await db.select().from(schema.posts).where(inArray(schema.posts.id, [...new Set(rows.map((r) => r.postId))])) : [];
  for (const h of rows) {
    if (map.has(h.conversationId)) continue; // 최신(id 큰 것)만
    const conv = convs.find((c) => c.id === h.conversationId);
    const post = posts.find((p) => p.id === h.postId);
    if (conv && post) map.set(h.conversationId, serializeHandover(h, conv, post, viewerId));
  }
  return map;
}

export async function loadHandoverContext(db: Db, id: number) {
  const [h] = await db.select().from(schema.handoverRequests).where(eq(schema.handoverRequests.id, id)).limit(1);
  if (!h) return null;
  const [conv] = await db.select().from(schema.conversations).where(eq(schema.conversations.id, h.conversationId)).limit(1);
  const [post] = await db.select().from(schema.posts).where(eq(schema.posts.id, h.postId)).limit(1);
  if (!conv || !post) return null;
  return { h, conv, post };
}

/** PostgreSQL 교착(40P01)·직렬화 실패(40001)는 트랜잭션 전체를 한 번 더 시도한다. 트랜잭션 본문은 DB 작업만 하므로 재시도해도 안전하다. */
export async function retryOnConflict<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await run();
    } catch (e) {
      const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
      if ((code === '40P01' || code === '40001') && i < attempts) continue;
      throw e;
    }
  }
}

type PgLike = { code?: string; constraint?: string; cause?: PgLike };
const ACTIVE_INDEX = 'handover_active_conv_uq';

/**
 * 대화당 진행 중 인수 1건 부분 유니크 인덱스(handover_active_conv_uq) 위반(23505)인지 판별한다.
 * 앱 수준 검사(대화 행 잠금)를 통과한 경합·직접 삽입에도 DB 가 최후 방어선이 된다. 드리즌이 감싼 오류(cause)도 본다.
 */
export function isActiveHandoverViolation(e: unknown): boolean {
  for (let cur = e as PgLike | undefined, depth = 0; cur && depth < 4; cur = cur.cause, depth++) {
    if (cur.code === '23505' && cur.constraint === ACTIVE_INDEX) return true;
  }
  return false;
}
