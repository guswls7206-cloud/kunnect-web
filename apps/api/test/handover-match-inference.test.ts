import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { setMatchHandler } from '../src/jobs/queue.js';
import { makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => {
  setMatchHandler(null);
  await env.reset();
});

const rows = async <T>(q: ReturnType<typeof sql>) => (await env.db.execute<T & Record<string, unknown>>(q)).rows;
const postStatus = async (id: number) => (await rows<{ status: string }>(sql`select status from posts where id = ${id}`))[0]!.status;
const matchStatus = async (id: number) => (await rows<{ status: string }>(sql`select status from matches where id = ${id}`))[0]!.status;

async function addMatch(lostPostId: number, foundPostId: number, status = 'PENDING') {
  const r = await rows<{ id: number }>(sql`
    insert into matches (lost_post_id, found_post_id, location_score, tag_score, total_score, level, status)
    values (${lostPostId}, ${foundPostId}, 0.9, 0.9, 0.9, 'AUTO', ${status}) returning id`);
  return r[0]!.id;
}

/** 습득자(finder)의 FOUND 글, 주인(owner)의 LOST 글, 주인이 시작한 대화. matchId 없이 인수를 진행하는 시나리오의 공통 준비 */
async function scenario() {
  const finder = await signup(env.app);
  const owner = await signup(env.app);
  const found = (await makePost(finder.client, { type: 'FOUND' })).body;
  const lost = (await makePost(owner.client, { type: 'LOST' })).body;
  const conv = (await owner.client.post('/conversations', { postId: found.id, body: '제 것 같아요' })).body.conversation;
  return { finder, owner, found, lost, conv };
}

type S = Awaited<ReturnType<typeof scenario>>;
async function runHandover(s: S, body: Record<string, unknown>) {
  const h = (await s.owner.client.post(`/conversations/${s.conv.id}/handover`, body)).body;
  await s.finder.client.post(`/handovers/${h.id}/verify`, {});
  await s.owner.client.post(`/handovers/${h.id}/complete`);
  const done = await s.finder.client.post(`/handovers/${h.id}/complete`);
  return { h, done };
}

describe('matchId 없이 완료한 인수의 상대 글 추론 [가정/제안]', () => {
  it('대화 상대의 글과 비거절 매칭이 정확히 1건이면 추론해 양쪽 글을 RETURNED 로, 그 매칭은 CONFIRMED 로 닫는다', async () => {
    const s = await scenario();
    const m = await addMatch(s.lost.id, s.found.id);
    const { done } = await runHandover(s, { postId: s.found.id });
    expect(done.body.status).toBe('COMPLETED');
    expect(done.body.matchId).toBe(m); // 추론한 매칭을 기록
    expect(done.body.counterpartLinked).toBe(true);
    expect(await postStatus(s.found.id)).toBe('RETURNED');
    expect(await postStatus(s.lost.id)).toBe('RETURNED'); // 상대 글이 영원히 OPEN 으로 남지 않는다
    expect(await matchStatus(m)).toBe('CONFIRMED');
  });

  it('두 글에 걸린 나머지 대기 매칭은 닫혀(REJECTED) 목록·알림에 더 나타나지 않는다', async () => {
    const s = await scenario();
    const third = await signup(env.app);
    const thirdFound = (await makePost(third.client, { type: 'FOUND' })).body;
    const thirdLost = (await makePost(third.client, { type: 'LOST' })).body;
    const m = await addMatch(s.lost.id, s.found.id);
    const otherA = await addMatch(s.lost.id, thirdFound.id); // 주인의 분실글 ↔ 제3자의 습득글
    const otherB = await addMatch(thirdLost.id, s.found.id); // 제3자의 분실글 ↔ 습득자의 습득글
    const unrelated = await addMatch(thirdLost.id, thirdFound.id);
    await runHandover(s, { postId: s.found.id });
    expect(await matchStatus(m)).toBe('CONFIRMED');
    expect(await matchStatus(otherA)).toBe('REJECTED');
    expect(await matchStatus(otherB)).toBe('REJECTED');
    expect(await matchStatus(unrelated)).toBe('PENDING'); // 무관한 매칭은 건드리지 않는다
    expect(await postStatus(thirdFound.id)).toBe('OPEN');
    expect(await postStatus(thirdLost.id)).toBe('OPEN');
  });

  it('분실글 쪽에서 시작해도(습득자가 대화 상대) 같은 규칙으로 추론한다', async () => {
    const s = await scenario();
    const m = await addMatch(s.lost.id, s.found.id);
    const h = (await s.finder.client.post(`/conversations/${s.conv.id}/handover`, { postId: s.lost.id })).body;
    await s.finder.client.post(`/handovers/${h.id}/verify`, {}); // 분실글 대상이면 대화 상대(습득자 역할)가 확인
    // 분실글 작성자(owner)의 대화 상대는 finder 이므로 finder 가 습득자 역할
    await s.owner.client.post(`/handovers/${h.id}/complete`);
    const done = await s.finder.client.post(`/handovers/${h.id}/complete`);
    expect(done.body.status).toBe('COMPLETED');
    expect(await postStatus(s.found.id)).toBe('RETURNED');
    expect(await postStatus(s.lost.id)).toBe('RETURNED');
    expect(await matchStatus(m)).toBe('CONFIRMED');
  });

  it('매칭이 없으면 현재 동작으로 폴백: 상대 글은 그대로, 응답에 counterpartLinked=false/matchId=null', async () => {
    const s = await scenario();
    const { done } = await runHandover(s, { postId: s.found.id });
    expect(done.body.status).toBe('COMPLETED');
    expect(done.body.matchId).toBeNull();
    expect(done.body.counterpartLinked).toBe(false);
    expect(await postStatus(s.found.id)).toBe('RETURNED');
    expect(await postStatus(s.lost.id)).toBe('OPEN');
  });

  it('진행 전(REQUESTED/VERIFIED)에는 counterpartLinked 가 null', async () => {
    const s = await scenario();
    const h = (await s.owner.client.post(`/conversations/${s.conv.id}/handover`, { postId: s.found.id })).body;
    expect(h.counterpartLinked).toBeNull();
  });

  it('거절된 매칭만 있으면 추론하지 않는다(사용자가 "아님"이라고 한 쌍)', async () => {
    const s = await scenario();
    const m = await addMatch(s.lost.id, s.found.id, 'REJECTED');
    const { done } = await runHandover(s, { postId: s.found.id });
    expect(done.body.counterpartLinked).toBe(false);
    expect(await postStatus(s.lost.id)).toBe('OPEN');
    expect(await matchStatus(m)).toBe('REJECTED');
  });

  it('상대의 글이 둘 이상 후보면(모호) 추측하지 않고 폴백', async () => {
    const s = await scenario();
    const lost2 = (await makePost(s.owner.client, { type: 'LOST' })).body;
    await addMatch(s.lost.id, s.found.id);
    await addMatch(lost2.id, s.found.id);
    const { done } = await runHandover(s, { postId: s.found.id });
    expect(done.body.counterpartLinked).toBe(false);
    expect(await postStatus(s.lost.id)).toBe('OPEN');
    expect(await postStatus(lost2.id)).toBe('OPEN');
  });

  it('모호해도 CONFIRMED 매칭이 정확히 1건이면 그 상대 글을 선택한다', async () => {
    const s = await scenario();
    const lost2 = (await makePost(s.owner.client, { type: 'LOST' })).body;
    await addMatch(s.lost.id, s.found.id);
    const confirmed = await addMatch(lost2.id, s.found.id, 'CONFIRMED');
    const { done } = await runHandover(s, { postId: s.found.id });
    expect(done.body.counterpartLinked).toBe(true);
    expect(done.body.matchId).toBe(confirmed);
    expect(await postStatus(lost2.id)).toBe('RETURNED');
    expect(await postStatus(s.lost.id)).toBe('OPEN');
  });

  it('이미 종료된 상대 글은 후보가 아니다', async () => {
    const s = await scenario();
    await addMatch(s.lost.id, s.found.id);
    await s.owner.client.post(`/posts/${s.lost.id}/status`, { status: 'CLOSED' });
    const { done } = await runHandover(s, { postId: s.found.id });
    expect(done.body.counterpartLinked).toBe(false);
    expect(await postStatus(s.lost.id)).toBe('CLOSED');
  });

  it('다른 사람의 글과의 매칭은 추론 대상이 아니다(대화 상대의 글만)', async () => {
    const s = await scenario();
    const stranger = await signup(env.app);
    const strangerLost = (await makePost(stranger.client, { type: 'LOST' })).body;
    await addMatch(strangerLost.id, s.found.id);
    const { done } = await runHandover(s, { postId: s.found.id });
    expect(done.body.counterpartLinked).toBe(false);
    expect(await postStatus(strangerLost.id)).toBe('OPEN');
  });

  it('matchId 를 명시한 인수도 매칭을 CONFIRMED 로 닫고 나머지 대기 매칭을 정리한다', async () => {
    const s = await scenario();
    const third = await signup(env.app);
    const thirdFound = (await makePost(third.client, { type: 'FOUND' })).body;
    const m = await addMatch(s.lost.id, s.found.id);
    const other = await addMatch(s.lost.id, thirdFound.id);
    const { done } = await runHandover(s, { postId: s.found.id, matchId: m });
    expect(done.body.counterpartLinked).toBe(true);
    expect(await matchStatus(m)).toBe('CONFIRMED');
    expect(await matchStatus(other)).toBe('REJECTED');
    expect(await postStatus(s.lost.id)).toBe('RETURNED');
  });
});

describe('잠금 순서(대화 → 인수 → 글): 섞인 동시 요청에도 교착/500 이 없다', () => {
  it('reject·complete·create·글 종료를 동시에 반복해도 5xx 가 없다', async () => {
    for (let i = 0; i < 6; i++) {
      const s = await scenario();
      const found2 = (await makePost(s.finder.client, { type: 'FOUND' })).body;
      const h = (await s.owner.client.post(`/conversations/${s.conv.id}/handover`, { postId: s.found.id })).body;
      await s.finder.client.post(`/handovers/${h.id}/verify`, {});
      const rs = await Promise.all([
        s.finder.client.post(`/handovers/${h.id}/reject`),
        s.owner.client.post(`/handovers/${h.id}/complete`),
        s.finder.client.post(`/handovers/${h.id}/complete`),
        s.owner.client.post(`/conversations/${s.conv.id}/handover`, { postId: found2.id }),
        s.finder.client.post(`/posts/${s.found.id}/status`, { status: 'CLOSED' }),
      ]);
      expect(rs.filter((r) => r.status >= 500).map((r) => r.status)).toEqual([]);
      const [row] = await rows<{ c: number }>(sql`select count(*)::int as c from handover_requests where conversation_id = ${s.conv.id} and status in ('REQUESTED','VERIFIED')`);
      expect(row!.c).toBeLessThanOrEqual(1);
      await env.reset();
    }
  });
});
