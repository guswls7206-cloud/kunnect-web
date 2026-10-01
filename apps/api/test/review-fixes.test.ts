import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { schema } from '../src/db/client.js';
import { Client, firstLocationId, jpeg, makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => env.reset());

const rows = async <T>(q: ReturnType<typeof sql>) => (await env.db.execute<T & Record<string, unknown>>(q)).rows;

describe('H-A: 탈퇴 마커와 가입 이름 충돌 방지', () => {
  it('deleted_<id> 아이디와 탈퇴한사용자<id> 닉네임으로는 가입할 수 없다(예약어)', async () => {
    const c = new Client(env.app);
    const a = await c.post('/auth/signup', { loginId: 'deleted_123', password: 'Test-Pass-77', nickname: '정상닉네임' });
    expect(a.status).toBe(400);
    const b = await new Client(env.app).post('/auth/signup', { loginId: 'normal_user', password: 'Test-Pass-77', nickname: '탈퇴한사용자123' });
    expect(b.status).toBe(400);
  });

  it('선점 시도가 막혀 있어 탈퇴(DELETE /me)가 항상 성공한다', async () => {
    const victim = await signup(env.app, 'victimdel');
    await new Client(env.app).post('/auth/signup', { loginId: `deleted_${victim.user.id}`, password: 'Test-Pass-77', nickname: '선점시도' });
    expect((await victim.client.req('DELETE', '/me', { password: 'Test-Pass-77' })).status).toBe(204);
  });
});

describe('H-B: 글 삭제 상태 전이', () => {
  it('RETURNED 글은 종료(CLOSED)로 바뀌지 않고 closedAt 도 바뀌지 않는다', async () => {
    const { client } = await signup(env.app);
    const post = (await makePost(client)).body;
    await env.db.execute(sql`update posts set status = 'RETURNED', closed_at = now() - interval '10 days' where id = ${post.id}`);
    const before = (await rows<{ t: string }>(sql`select closed_at::text as t from posts where id = ${post.id}`))[0]!.t;
    const r = await client.post(`/posts/${post.id}/status`, { status: 'CLOSED' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INVALID_TRANSITION');
    const after = (await rows<{ t: string; status: string }>(sql`select closed_at::text as t, status from posts where id = ${post.id}`))[0]!;
    expect(after.status).toBe('RETURNED');
    expect(after.t).toBe(before);
  });

  it('이미 CLOSED 인 글의 재종료는 멱등이며 closedAt 을 다시 쓰지 않는다', async () => {
    const { client } = await signup(env.app);
    const post = (await makePost(client)).body;
    await client.post(`/posts/${post.id}/status`, { status: 'CLOSED' });
    const t1 = (await rows<{ t: string }>(sql`select closed_at::text as t from posts where id = ${post.id}`))[0]!.t;
    expect((await client.post(`/posts/${post.id}/status`, { status: 'CLOSED' })).status).toBe(200);
    expect((await rows<{ t: string }>(sql`select closed_at::text as t from posts where id = ${post.id}`))[0]!.t).toBe(t1);
  });
});

describe('H-C: 동시 가입 경합(unique 위반)', () => {
  it('같은 아이디 동시 가입은 하나만 성공하고 나머지는 409 LOGIN_ID_TAKEN(500 아님)', async () => {
    const res = await Promise.all(
      Array.from({ length: 4 }, (_, i) => new Client(env.app).post('/auth/signup', { loginId: 'racelogin', password: 'Test-Pass-77', nickname: `경합닉${i}` })),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409).every((r) => r.body.error.code === 'LOGIN_ID_TAKEN')).toBe(true);
    expect(res.some((r) => r.status >= 500)).toBe(false);
  });

  it('같은 닉네임 동시 가입은 409 NICKNAME_TAKEN 으로 구분된다', async () => {
    const res = await Promise.all(
      Array.from({ length: 4 }, (_, i) => new Client(env.app).post('/auth/signup', { loginId: `racenick${i}`, password: 'Test-Pass-77', nickname: '경합같은닉' })),
    );
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409).every((r) => r.body.error.code === 'NICKNAME_TAKEN')).toBe(true);
    expect(res.some((r) => r.status >= 500)).toBe(false);
  });
});

describe('M7: 매칭 결정의 상태 검사', () => {
  async function seed() {
    const loser = await signup(env.app);
    const finder = await signup(env.app);
    const lost = (await makePost(loser.client, { type: 'LOST' })).body;
    const found = (await makePost(finder.client, { type: 'FOUND' })).body;
    const [m] = await env.db.insert(schema.matches).values({ lostPostId: lost.id, foundPostId: found.id, locationScore: 1, tagScore: 1, totalScore: 0.9, level: 'AUTO' }).returning();
    return { loser, finder, lost, found, m: m! };
  }

  it('종료(CLOSED)된 글이 걸린 매칭은 확정할 수 없다 (409 POST_CLOSED), 글 상태는 바뀌지 않는다', async () => {
    const { loser, finder, found, lost, m } = await seed();
    await finder.client.post(`/posts/${found.id}/status`, { status: 'CLOSED' });
    const r = await loser.client.post(`/matches/${m.id}/confirm`);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('POST_CLOSED');
    expect((await loser.client.get(`/posts/${lost.id}`)).body.status).toBe('OPEN');
  });

  it('탈퇴한 습득자의 매칭은 확정할 수 없다(탈퇴 시 글과 함께 매칭도 즉시 삭제되어 404)', async () => {
    const { loser, finder, m } = await seed();
    await finder.client.req('DELETE', '/me', { password: 'Test-Pass-77' });
    const r = await loser.client.post(`/matches/${m.id}/confirm`);
    expect(r.status).toBe(404);
  });

  it('동시에 confirm 과 reject 를 보내도 하나만 성공한다', async () => {
    const { loser, m } = await seed();
    const [a, b] = await Promise.all([loser.client.post(`/matches/${m.id}/confirm`), loser.client.post(`/matches/${m.id}/reject`)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const st = (await rows<{ status: string }>(sql`select status from matches where id = ${m.id}`))[0]!.status;
    expect(['CONFIRMED', 'REJECTED']).toContain(st);
  });
});

describe('M8: 사진 삭제 원자성', () => {
  it('글에 연결된 사진은 삭제 쿼리 자체에서도 지워지지 않는다(연결 직후 삭제 경합)', async () => {
    const { client } = await signup(env.app);
    const photoId = (await client.upload(await jpeg())).body.photoId;
    const [del, post] = await Promise.all([client.del(`/photos/${photoId}`), makePost(client, { photoIds: [photoId] })]);
    // 어느 쪽이 먼저든 일관: 삭제가 성공하면 글 생성이 422, 글이 먼저면 삭제가 409
    if (del.status === 204) expect(post.status).toBe(422);
    else {
      expect(del.status).toBe(409);
      expect(post.status).toBe(201);
      expect((await rows<{ c: number }>(sql`select count(*)::int as c from post_photos where id = ${photoId}`))[0]!.c).toBe(1);
    }
  });
});

describe('M9: 종료(CLOSED)·탈퇴 작성자 글의 열람 범위 [가정/제안]', () => {
  it('CLOSED 글은 작성자만 상세 조회할 수 있고 다른 사용자는 404, status=CLOSED 목록은 내 글만', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const post = (await makePost(owner.client, { description: '비공개로 돌릴 설명' })).body;
    await owner.client.post(`/posts/${post.id}/status`, { status: 'CLOSED' });
    expect((await owner.client.get(`/posts/${post.id}`)).status).toBe(200);
    expect((await other.client.get(`/posts/${post.id}`)).status).toBe(404);
    expect((await other.client.get('/posts?status=CLOSED')).body.items).toEqual([]);
    expect((await owner.client.get('/posts?status=CLOSED')).body.items).toHaveLength(1);
  });

  it('탈퇴한 작성자의 글은 다른 사용자가 상세 조회할 수 없다', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const post = (await makePost(owner.client)).body;
    await owner.client.req('DELETE', '/me', { password: 'Test-Pass-77' });
    expect((await other.client.get(`/posts/${post.id}`)).status).toBe(404);
  });

  it('RETURNED 글은 계속 공개(성공 사례)로 열람 가능하다', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const post = (await makePost(owner.client)).body;
    await env.db.execute(sql`update posts set status = 'RETURNED', closed_at = now() where id = ${post.id}`);
    expect((await other.client.get(`/posts/${post.id}`)).status).toBe(200);
  });
});

describe('M10: occurredAt 검증', () => {
  it('오프셋 없는 시각, null, 1970, 너무 먼 과거는 400, 오프셋이 있는 ISO 문자열은 허용', async () => {
    const { client } = await signup(env.app);
    const base = { type: 'LOST', title: 't', description: 'd', locationId: await firstLocationId(client) };
    expect((await client.post('/posts', { ...base, occurredAt: '2026-10-01T10:00:00' })).status).toBe(400);
    expect((await client.post('/posts', { ...base, occurredAt: null })).status).toBe(400);
    expect((await client.post('/posts', { ...base, occurredAt: 0 })).status).toBe(400);
    expect((await client.post('/posts', { ...base, occurredAt: '1970-01-01T00:00:00Z' })).status).toBe(400);
    const ok = await client.post('/posts', { ...base, occurredAt: new Date(Date.now() - 3600_000).toISOString() });
    expect(ok.status).toBe(201);
    const withOffset = new Date(Date.now() - 7200_000).toISOString().replace('Z', '+00:00');
    expect((await client.post('/posts', { ...base, occurredAt: withOffset })).status).toBe(201);
  });
});

describe('M11: 쪽지함 커서 검증', () => {
  it('비정상 커서(거대한 시각, 숫자 아님)는 500 이 아니라 400', async () => {
    const { client } = await signup(env.app);
    const huge = Buffer.from('99999999999999999999_1').toString('base64url');
    expect((await client.get(`/conversations?cursor=${huge}`)).status).toBe(400);
    expect((await client.get(`/conversations?cursor=${Buffer.from('abc').toString('base64url')}`)).status).toBe(400);
  });
});

describe('M12: 댓글 페이지네이션', () => {
  it('삭제된 최상위 댓글이 많아도 페이지가 비지 않는다(limit 은 노출될 댓글 기준)', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const post = (await makePost(owner.client)).body;
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push((await other.client.post(`/posts/${post.id}/comments`, { body: `c${i}` })).body.comment.id);
    // 앞의 4개를 삭제(답글 없음 → 행 삭제가 아니라 상태만 바꿔 자리 유지 시나리오를 만든다)
    await env.db.execute(sql`update comments set status = 'DELETED', body = '' where id in (${sql.join(ids.slice(0, 4).map((i) => sql`${i}`), sql`, `)})`);
    const p1 = (await other.client.get(`/posts/${post.id}/comments?limit=2`)).body;
    expect(p1.items.map((c: { id: number }) => c.id)).toEqual([ids[4], ids[5]]);
    expect(p1.nextCursor).toBeNull();
  });
});

describe('M13: 글 작성의 원자성', () => {
  it('글과 매칭 작업이 같은 트랜잭션: 작업 등록이 실패하면 글도 남지 않는다', async () => {
    const { client } = await signup(env.app);
    await env.db.execute(sql`alter table jobs add constraint jobs_block_ck check (false) not valid`);
    try {
      const r = await makePost(client);
      expect(r.status).toBe(500);
      expect((await rows<{ c: number }>(sql`select count(*)::int as c from posts`))[0]!.c).toBe(0);
    } finally {
      await env.db.execute(sql`alter table jobs drop constraint jobs_block_ck`);
    }
  });
});

describe('LIKE 이스케이프(단위)', () => {
  it('%, _, 역슬래시를 이스케이프한다', async () => {
    const { escapeLike } = await import('../src/lib/pg.js');
    expect(escapeLike('50%_a\\b')).toBe('50\\%\\_a\\\\b');
  });
});

describe('LOW 항목', () => {
  it('비밀번호 변경: 현재와 같은 새 비밀번호는 400', async () => {
    const { client } = await signup(env.app);
    const r = await client.post('/me/password', { currentPassword: 'Test-Pass-77', newPassword: 'Test-Pass-77' });
    expect(r.status).toBe(400);
  });

  it('빈 PATCH 는 updatedAt 을 바꾸지 않고 매칭 작업도 다시 등록하지 않는다', async () => {
    const { client } = await signup(env.app);
    const post = (await makePost(client)).body;
    const before = (await rows<{ t: string }>(sql`select updated_at::text as t from posts where id = ${post.id}`))[0]!.t;
    const jobsBefore = (await rows<{ c: number }>(sql`select count(*)::int as c from jobs`))[0]!.c;
    expect((await client.patch(`/posts/${post.id}`, {})).status).toBe(200);
    expect((await rows<{ t: string }>(sql`select updated_at::text as t from posts where id = ${post.id}`))[0]!.t).toBe(before);
    expect((await rows<{ c: number }>(sql`select count(*)::int as c from jobs`))[0]!.c).toBe(jobsBefore);
  });

  it('계정 삭제 시 글에 연결되지 않은 임시 사진 행과 파일도 삭제된다', async () => {
    const { client, user } = await signup(env.app);
    const up = (await client.upload(await jpeg())).body;
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const file = join(env.storageDir, up.url.replace('/api/v1/files/', ''));
    expect(existsSync(file)).toBe(true);
    await client.req('DELETE', '/me', { password: 'Test-Pass-77' });
    expect((await rows<{ c: number }>(sql`select count(*)::int as c from post_photos where owner_id = ${user.id} and post_id is null`))[0]!.c).toBe(0);
    expect(existsSync(file)).toBe(false);
  });

  it('차단 목록 조회는 상한이 있다', async () => {
    const a = await signup(env.app);
    const b = await signup(env.app);
    await a.client.post('/blocks', { userId: b.user.id });
    expect((await a.client.get('/blocks')).body.items).toHaveLength(1);
  });
});
