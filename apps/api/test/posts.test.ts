import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { sql } from 'drizzle-orm';
import { Client, firstLocationId, jpeg, makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => env.reset());

describe('위치/태그', () => {
  it('위치 목록은 지정한 12곳을 순서대로, 층 없이 내려준다(예전 더미는 숨김)', async () => {
    const { client } = await signup(env.app);
    const items = (await client.get('/locations')).body.items as { id: number; buildingId: string; buildingName: string; floor: number | null }[];
    expect(items.map((l) => l.buildingName)).toEqual([
      '학생회관', '인문사회관', '해오름학사', '생명과학관', '자연과학관', '창의예술관',
      '상허연구동', '의학관', '모시래학사', '중앙도서관', '글로컬이음관', '기타',
    ]);
    expect(items.map((l) => l.buildingId)).toEqual([
      'student-hall', 'humanities-social', 'haeoreum-dorm', 'life-science', 'natural-science', 'creative-arts',
      'sanghuh-research', 'medicine', 'mosirae-dorm', 'central-library', 'glocal-ieum', 'etc',
    ]);
    expect(items.every((l) => l.floor === null)).toBe(true);
    // 예전 더미 행이 남아 있어도 목록·새 글에서는 숨긴다
    const [dummy] = (await env.db.execute(sql`insert into locations (building_key, building_name, floor, lat, lng, is_dummy) values ('eng-hall', '공학관(더미)', 1, 0, 0, true) returning id`)).rows as { id: number }[];
    expect(((await client.get('/locations')).body.items as unknown[]).length).toBe(12);
    expect((await makePost(client, { locationId: dummy!.id })).status).toBe(400);
  });

  it('기타 위치는 locationText 필수(1~50자, 공백 제거), 다른 위치에서는 입력 불가', async () => {
    const { client } = await signup(env.app);
    const items = (await client.get('/locations')).body.items as { id: number; buildingId: string }[];
    const etc = items.find((l) => l.buildingId === 'etc')!.id;
    const hall = items.find((l) => l.buildingId === 'student-hall')!.id;
    const missing = await makePost(client, { locationId: etc });
    expect(missing.status).toBe(400);
    expect(missing.body.error.fields.locationText).toBeTruthy();
    expect((await makePost(client, { locationId: etc, locationText: '   ' })).status).toBe(400);
    expect((await makePost(client, { locationId: etc, locationText: 'x'.repeat(51) })).status).toBe(400);
    const wrong = await makePost(client, { locationId: hall, locationText: '정문 앞' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.fields.locationText).toBeTruthy();
    // 다른 위치에서 빈 값·null 은 허용(입력 없음)
    expect((await makePost(client, { locationId: hall, locationText: '' })).status).toBe(201);
    expect((await makePost(client, { locationId: hall, locationText: null })).body.locationText).toBeNull();

    const ok = await makePost(client, { locationId: etc, locationText: '  정문 버스정류장  ', title: '기타 글' });
    expect(ok.status).toBe(201);
    expect(ok.body.locationText).toBe('정문 버스정류장');
    expect(ok.body.location.buildingId).toBe('etc');
    const card = ((await client.get('/me/posts')).body.items as { title: string; locationName: string; locationText: string | null }[]).find((p) => p.title === '기타 글')!;
    expect(card).toEqual(expect.objectContaining({ locationName: '기타', locationText: '정문 버스정류장' }));

    // 수정: 기타 글만 locationText 변경 가능, 비우기 불가
    expect((await client.patch(`/posts/${ok.body.id}`, { locationText: '노천극장' })).body.locationText).toBe('노천극장');
    expect((await client.patch(`/posts/${ok.body.id}`, { locationText: '' })).status).toBe(400);
    const hallPost = (await makePost(client, { locationId: hall })).body;
    expect((await client.patch(`/posts/${hallPost.id}`, { locationText: '여기' })).status).toBe(400);
  });

  it('위치 시드(더미)와 프리셋 태그가 조회된다', async () => {
    const { client } = await signup(env.app);
    const locs = await client.get('/locations');
    expect(locs.status).toBe(200);
    expect(locs.body.items.length).toBeGreaterThan(0);
    expect(locs.body.items.some((l: { buildingName: string }) => l.buildingName === '학생회관')).toBe(true);
    const tags = await client.get('/tags?preset=true');
    expect(tags.body.items.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['스마트폰', '이어폰', '학생증', '지갑', '가방', '열쇠', '노트북']));
    const sug = await client.get('/tags/suggest?q=' + encodeURIComponent('이어'));
    expect(sug.body.items[0].name).toBe('이어폰');
  });

  it('태그 검색의 LIKE 와일드카드는 이스케이프된다', async () => {
    const { client } = await signup(env.app);
    const r = await client.get('/tags?q=' + encodeURIComponent('%'));
    expect(r.body.items).toEqual([]);
  });
});

describe('사진 업로드', () => {
  it('JPEG 업로드: EXIF 제거, 긴 변 1600px 이하로 리사이즈, 임시 사진으로 저장', async () => {
    const { client } = await signup(env.app);
    const big = await sharp({ create: { width: 3000, height: 2000, channels: 3, background: '#aa3333' } })
      .withExif({ IFD0: { ImageDescription: 'SECRET-GPS-INFO' } })
      .jpeg()
      .toBuffer();
    expect((await sharp(big).metadata()).exif).toBeTruthy(); // 입력에는 EXIF 가 있다
    const r = await client.upload(big);
    expect(r.status).toBe(201);
    expect(Math.max(r.body.width, r.body.height)).toBeLessThanOrEqual(1600);
    expect(r.body.url).toMatch(/^\/api\/v1\/files\/photos\/[0-9a-f]{32}\.jpg$/);
    const stored = join(env.storageDir, r.body.url.replace('/api/v1/files/', ''));
    expect(existsSync(stored)).toBe(true);
    const meta = await sharp(stored).metadata();
    expect(meta.exif).toBeUndefined();
    // 저장된 파일에 원본 EXIF 문자열이 남아 있지 않다
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(stored).includes(Buffer.from('SECRET-GPS-INFO'))).toBe(false);
  });

  it('정적 파일로 제공된다', async () => {
    const { client } = await signup(env.app);
    const r = await client.upload(await jpeg());
    const get = await env.app.inject({ method: 'GET', url: r.body.url, headers: { cookie: client.cookie } });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toContain('image/jpeg');
  });

  it('PNG/WebP 허용, GIF/텍스트/손상 파일 거부', async () => {
    const { client } = await signup(env.app);
    const png = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).png().toBuffer();
    const webp = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).webp().toBuffer();
    const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#fff' } }).gif().toBuffer();
    expect((await client.upload(png, 'a.png', 'image/png')).status).toBe(201);
    expect((await client.upload(webp, 'a.webp', 'image/webp')).status).toBe(201);
    expect((await client.upload(gif, 'a.gif', 'image/gif')).status).toBe(415);
    const text = await client.upload(Buffer.from('not an image at all'), 'a.jpg', 'image/jpeg');
    expect(text.status).toBe(422);
    expect(text.body.error.code).toBe('CORRUPT_IMAGE');
    const trunc = (await jpeg(800, 800)).subarray(0, 200);
    expect((await client.upload(trunc)).status).toBe(422);
  });

  it('확장자·MIME 위장(HTML 을 jpg 로)은 거부된다', async () => {
    const { client } = await signup(env.app);
    const r = await client.upload(Buffer.from('<html><script>alert(1)</script></html>'), 'x.jpg', 'image/jpeg');
    expect(r.status).toBe(422);
  });

  it('10MB 초과는 413 FILE_TOO_LARGE', async () => {
    const { client } = await signup(env.app);
    const r = await client.upload(Buffer.alloc(10 * 1024 * 1024 + 1024, 1));
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('FILE_TOO_LARGE');
  });

  it('로그인 없이 업로드 불가, 타인의 사진은 삭제 불가', async () => {
    const anon = new Client(env.app);
    expect((await anon.upload(await jpeg())).status).toBe(401);
    const { client: a } = await signup(env.app);
    const { client: b } = await signup(env.app);
    const up = await a.upload(await jpeg());
    expect((await b.del(`/photos/${up.body.photoId}`)).status).toBe(404);
    const stored = join(env.storageDir, up.body.url.replace('/api/v1/files/', ''));
    expect(existsSync(stored)).toBe(true);
    expect((await a.del(`/photos/${up.body.photoId}`)).status).toBe(204);
    expect(existsSync(stored)).toBe(false); // 파일도 함께 삭제
  });
});

describe('글', () => {
  it('분실글 작성 → 상세 조회, 매칭 작업이 큐에 등록되고 matchState 는 PENDING', async () => {
    const { client } = await signup(env.app);
    const r = await makePost(client);
    expect(r.status).toBe(201);
    expect(r.body.matchState).toBe('PENDING');
    expect(r.body.tags).toEqual(expect.arrayContaining(['이어폰', '검정']));
    expect(r.body.isMine).toBe(true);
    const jobs = await env.db.execute<{ type: string; status: string }>(sql`select type, status from jobs`);
    expect(jobs.rows).toEqual([{ type: 'MATCH_POST', status: 'QUEUED' }]);
  });

  it('습득글은 보관 장소 필수, hiddenFeatures 는 작성자에게만 보인다', async () => {
    const { client: finder } = await signup(env.app);
    const { client: other } = await signup(env.app);
    const locationId = await firstLocationId(finder);
    const bad = await finder.post('/posts', { type: 'FOUND', title: '지갑 습득', description: '주웠어요', locationId, occurredAt: new Date().toISOString() });
    expect(bad.status).toBe(400);
    expect(bad.body.error.fields.storagePlace).toBeTruthy();
    const ok = await makePost(finder, { type: 'FOUND', hiddenFeatures: '안쪽에 스티커' });
    expect(ok.status).toBe(201);
    expect(ok.body.hiddenFeatures).toBe('안쪽에 스티커');
    const seen = await other.get(`/posts/${ok.body.id}`);
    expect(seen.body.hiddenFeatures).toBeNull();
    expect(seen.body.isMine).toBe(false);
  });

  it('미래 시각·없는 위치·태그 9개 이상은 400', async () => {
    const { client } = await signup(env.app);
    const future = await makePost(client, { occurredAt: new Date(Date.now() + 86400_000).toISOString() });
    expect(future.status).toBe(400);
    expect(future.body.error.code).toBe('FUTURE_TIME');
    expect((await makePost(client, { locationId: 99999 })).status).toBe(400);
    expect((await makePost(client, { tags: Array.from({ length: 9 }, (_, i) => `t${i}`) })).status).toBe(400);
  });

  it('사진 연결: 최대 3장, 내 사진만, 한 번만 연결 가능', async () => {
    const { client: a } = await signup(env.app);
    const { client: b } = await signup(env.app);
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push((await a.upload(await jpeg(64 + i, 64))).body.photoId);
    expect((await makePost(a, { photoIds: ids })).status).toBe(400); // 4장
    const ok = await makePost(a, { photoIds: ids.slice(0, 3) });
    expect(ok.status).toBe(201);
    expect(ok.body.photos).toHaveLength(3);
    expect((await makePost(a, { photoIds: [ids[0]] })).status).toBe(422); // 이미 연결됨
    const bPhoto = (await b.upload(await jpeg())).body.photoId;
    const stolen = await makePost(a, { photoIds: [bPhoto] });
    expect(stolen.status).toBe(422);
    expect(stolen.body.error.code).toBe('PHOTO_NOT_OWNED');
  });

  it('목록: 기본은 OPEN/MATCHED 만, 유형·위치·태그·검색 필터, 커서 페이지네이션', async () => {
    const { client } = await signup(env.app);
    for (let i = 0; i < 5; i++) await makePost(client, { title: `분실 ${i}`, tags: i % 2 ? ['지갑'] : ['열쇠'] });
    const found = await makePost(client, { type: 'FOUND', title: '습득 물건' });
    const closed = await makePost(client, { title: '종료될 글' });
    await client.post(`/posts/${closed.body.id}/status`, { status: 'CLOSED' });

    const all = await client.get('/posts?limit=3');
    expect(all.body.items).toHaveLength(3);
    expect(all.body.nextCursor).toBeTruthy();
    const page2 = await client.get(`/posts?limit=3&cursor=${all.body.nextCursor}`);
    expect(page2.body.items.length).toBe(3);
    const ids = [...all.body.items, ...page2.body.items].map((p: { id: number }) => p.id);
    expect(new Set(ids).size).toBe(6); // 중복 없음 (7개 중 CLOSED 제외 6개)
    expect(ids).not.toContain(closed.body.id);
    expect((await client.get('/posts?type=FOUND')).body.items.map((p: { id: number }) => p.id)).toEqual([found.body.id]);
    expect((await client.get('/posts?tag=' + encodeURIComponent('지갑'))).body.items).toHaveLength(2);
    expect((await client.get('/posts?q=' + encodeURIComponent('습득'))).body.items).toHaveLength(1);
    expect((await client.get('/posts?status=CLOSED')).body.items).toHaveLength(1);
    expect((await client.get('/posts?cursor=%%%')).status).toBe(400);
  });

  it('작성자만 수정/삭제 가능, 수정 시 매칭 재큐잉, 종료된 글은 수정 불가', async () => {
    const { client: a } = await signup(env.app);
    const { client: b } = await signup(env.app);
    const p = await makePost(a);
    const id = p.body.id;
    expect((await b.patch(`/posts/${id}`, { title: '해킹' })).status).toBe(403);
    expect((await b.del(`/posts/${id}`)).status).toBe(403);
    const upd = await a.patch(`/posts/${id}`, { title: '수정된 제목', tags: ['가방'] });
    expect(upd.status).toBe(200);
    expect(upd.body.title).toBe('수정된 제목');
    expect(upd.body.tags).toEqual(['가방']);
    const jobs = await env.db.execute<{ c: number }>(sql`select count(*)::int as c from jobs`);
    expect(jobs.rows[0]!.c).toBe(2);
    // 조용히 닫기(소프트 종료). 글 삭제(DELETE)는 즉시 영구 삭제라 별도(post-delete.test.ts)
    expect((await a.post(`/posts/${id}/status`, { status: 'CLOSED' })).status).toBe(200);
    expect((await a.get(`/posts/${id}`)).body.status).toBe('CLOSED');
    expect((await a.patch(`/posts/${id}`, { title: '다시' })).status).toBe(409);
  });

  it('RETURNED 는 직접 변경할 수 없다 (인수 완료 절차 전용)', async () => {
    const { client } = await signup(env.app);
    const p = await makePost(client);
    const r = await client.post(`/posts/${p.body.id}/status`, { status: 'RETURNED' });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('XSS 문자열은 그대로 저장·반환(이스케이프는 프런트 책임)되고 SQL 인젝션 문자열은 무해하다', async () => {
    const { client } = await signup(env.app);
    const r = await makePost(client, { title: "'; drop table posts; --", description: '<img src=x onerror=alert(1)>' });
    expect(r.status).toBe(201);
    expect((await client.get('/posts')).status).toBe(200);
    expect(r.body.description).toBe('<img src=x onerror=alert(1)>');
  });

  it('내 글 / 사용자 공개 글 목록', async () => {
    const { client: a, user: ua } = await signup(env.app);
    const { client: b } = await signup(env.app);
    await makePost(a);
    await makePost(a, { type: 'FOUND' });
    expect((await a.get('/me/posts')).body.items).toHaveLength(2);
    expect((await a.get('/me/posts?type=FOUND')).body.items).toHaveLength(1);
    expect((await b.get(`/users/${ua.id}/posts`)).body.items).toHaveLength(2);
    expect((await b.get('/me/posts')).body.items).toHaveLength(0);
  });
});
