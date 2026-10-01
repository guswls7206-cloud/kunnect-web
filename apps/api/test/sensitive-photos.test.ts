import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import sharp from 'sharp';
import { schema } from '../src/db/client.js';
import { runCleanup } from '../src/jobs/cleanup.js';
import { createMatchHandler } from '../src/jobs/match-handler.js';
import { loadMatchingConfig } from '../src/matching/index.js';
import type { MatchingEngine, PostInput } from '../src/matching/types.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { Client, makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => env.reset());

/** 눈에 띄는 패턴이 있는 사진(흐림 처리 전후를 구분하기 위해 줄무늬) */
async function striped(w = 800, h = 600) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${Array.from({ length: 40 }, (_, i) => `<rect x="${i * 20}" y="0" width="10" height="${h}" fill="${i % 2 ? '#000' : '#fff'}"/>`).join('')}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 95 }).toBuffer();
}

const getFile = (c: Client | null, url: string) =>
  env.app.inject({ method: 'GET', url, headers: c?.cookie ? { cookie: c.cookie } : {} });

async function sensitivePost(author: Client, tags: string[] = ['학생증']) {
  const up = (await author.upload(await striped())).body;
  const post = (await makePost(author, { type: 'FOUND', tags, photoIds: [up.photoId] })).body;
  return { post, up };
}

describe('민감 사진: 태그 기반 자동 보호', () => {
  it('학생증 태그 글의 사진은 작성자에겐 원본, 다른 사용자에겐 흐림 사본 URL 로 내려간다', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const { post } = await sensitivePost(owner.client);
    expect(post.hasSensitivePhoto).toBe(true);
    expect(post.photos[0]).toMatchObject({ isBlurred: false, sensitive: true });
    expect(post.photos[0].url).toMatch(/^\/api\/v1\/files\/photos\//);

    const seen = (await other.client.get(`/posts/${post.id}`)).body;
    expect(seen.hasSensitivePhoto).toBe(true);
    expect(seen.photos[0]).toMatchObject({ isBlurred: true, sensitive: true });
    expect(seen.photos[0].url).toMatch(/^\/api\/v1\/files\/blurred\//);
    // 목록 카드 썸네일도 흐림 사본
    const card = (await other.client.get('/posts')).body.items.find((p: { id: number }) => p.id === post.id);
    expect(card.thumbnailUrl).toMatch(/\/files\/blurred\//);
    expect(card.hasSensitivePhoto).toBe(true);
    const mine = (await owner.client.get('/posts')).body.items.find((p: { id: number }) => p.id === post.id);
    expect(mine.thumbnailUrl).toMatch(/\/files\/photos\//);
  });

  it('민감하지 않은 태그의 사진은 모두에게 원본이고 플래그가 없다', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const { post } = await sensitivePost(owner.client, ['열쇠']);
    expect(post.hasSensitivePhoto).toBe(false);
    const seen = (await other.client.get(`/posts/${post.id}`)).body;
    expect(seen.photos[0]).toMatchObject({ isBlurred: false, sensitive: false });
    expect(seen.photos[0].url).toMatch(/\/files\/photos\//);
  });

  it('글 태그를 수정하면 민감 상태가 다시 계산된다(추가/제거)', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const { post } = await sensitivePost(owner.client, ['열쇠']);
    await owner.client.patch(`/posts/${post.id}`, { tags: ['카드'] });
    expect((await other.client.get(`/posts/${post.id}`)).body.photos[0].isBlurred).toBe(true);
    await owner.client.patch(`/posts/${post.id}`, { tags: ['열쇠'] });
    expect((await other.client.get(`/posts/${post.id}`)).body.photos[0].isBlurred).toBe(false);
  });
});

describe('민감 사진: 파일 엔드포인트 인가(IDOR)', () => {
  it('원본은 작성자만, 다른 사용자·비로그인은 거부되고 흐림 사본은 로그인한 열람 가능자에게 제공된다', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const { post } = await sensitivePost(owner.client);
    const original = post.photos[0].url as string;
    const blurredUrl = (await other.client.get(`/posts/${post.id}`)).body.photos[0].url as string;

    const mine = await getFile(owner.client, original);
    expect(mine.statusCode).toBe(200);
    expect(mine.headers['content-type']).toBe('image/jpeg');
    expect(String(mine.headers['cache-control'])).toContain('private');
    expect((await getFile(other.client, original)).statusCode).toBe(404); // 원본 직접 요청(IDOR) 차단
    expect((await getFile(null, original)).statusCode).toBe(401);
    expect((await getFile(null, blurredUrl)).statusCode).toBe(401);

    const blurred = await getFile(other.client, blurredUrl);
    expect(blurred.statusCode).toBe(200);
    expect(blurred.rawPayload.equals(mine.rawPayload)).toBe(false); // 원본과 다른 바이트
    // 흐림 사본은 원본의 줄무늬 대비가 크게 줄어 있다(평균 밝기 변화가 작음)
    const stats = await sharp(blurred.rawPayload).stats();
    const origStats = await sharp(mine.rawPayload).stats();
    expect(stats.channels[0]!.stdev).toBeLessThan(origStats.channels[0]!.stdev * 0.5);
    expect((await sharp(blurred.rawPayload).metadata()).exif).toBeUndefined();
  });

  it('작성자는 자기 사진의 흐림 사본도 받을 수 있고, 형식이 다른 이름·내부 경로(ai/)는 404', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const { post } = await sensitivePost(owner.client);
    const blurredUrl = (await other.client.get(`/posts/${post.id}`)).body.photos[0].url as string;
    expect((await getFile(owner.client, blurredUrl)).statusCode).toBe(200);
    expect((await getFile(owner.client, '/api/v1/files/photos/not-a-valid-name.jpg')).statusCode).toBe(404);
    expect((await getFile(owner.client, '/api/v1/files/photos/' + '0'.repeat(32) + '.jpg')).statusCode).toBe(404);
    expect((await getFile(owner.client, '/api/v1/files/ai/' + '0'.repeat(24) + '.jpg')).statusCode).toBe(404);
    expect((await getFile(owner.client, '/api/v1/files/../photos/x.jpg')).statusCode).toBe(404);
  });

  it('임시(글에 연결 전) 사진은 작성자만 받을 수 있다', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const up = (await owner.client.upload(await striped())).body;
    expect((await getFile(owner.client, up.url)).statusCode).toBe(200);
    expect((await getFile(other.client, up.url)).statusCode).toBe(404);
  });

  it('종료된 글·탈퇴한 작성자·차단 관계의 사진은 다른 사용자에게 404 (민감 여부와 무관)', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const upA = (await owner.client.upload(await striped())).body;
    const open = (await makePost(owner.client, { photoIds: [upA.photoId], tags: ['열쇠'] })).body;
    expect((await getFile(other.client, open.photos[0].url)).statusCode).toBe(200);
    // 차단(양방향)
    await other.client.post('/blocks', { userId: owner.user.id });
    expect((await getFile(other.client, open.photos[0].url)).statusCode).toBe(404);
    await other.client.del(`/blocks/${owner.user.id}`);
    // 종료
    await owner.client.post(`/posts/${open.id}/status`, { status: 'CLOSED' });
    expect((await getFile(other.client, open.photos[0].url)).statusCode).toBe(404);
    expect((await getFile(owner.client, open.photos[0].url)).statusCode).toBe(200); // 작성자는 계속 가능
  });

  it('소유 확인(VERIFIED) 이후의 인수 상대에게만 민감 원본이 열린다', async () => {
    const finder = await signup(env.app);
    const owner = await signup(env.app);
    const stranger = await signup(env.app);
    const { post } = await sensitivePost(finder.client);
    const original = post.photos[0].url as string;
    const conv = (await owner.client.post('/conversations', { postId: post.id, body: '제 학생증 같아요' })).body.conversation;
    expect((await getFile(owner.client, original)).statusCode).toBe(404);
    const h = (await owner.client.post(`/conversations/${conv.id}/handover`, { postId: post.id })).body;
    expect((await getFile(owner.client, original)).statusCode).toBe(404); // REQUESTED 단계에서는 아직 흐림
    expect((await owner.client.get(`/posts/${post.id}`)).body.photos[0].isBlurred).toBe(true);
    expect((await finder.client.post(`/handovers/${h.id}/verify`, { note: '확인' })).status).toBe(200);
    expect((await getFile(owner.client, original)).statusCode).toBe(200);
    const detail = (await owner.client.get(`/posts/${post.id}`)).body.photos[0];
    expect(detail).toMatchObject({ isBlurred: false, url: original });
    // 제3자는 여전히 불가
    expect((await getFile(stranger.client, original)).statusCode).toBe(404);
    expect((await stranger.client.get(`/posts/${post.id}`)).body.photos[0].isBlurred).toBe(true);
  });
});

describe('민감 사진: 작성자 표시/해제 (PATCH /photos/{id})', () => {
  it('직접 민감으로 표시하면 흐림 사본이 생기고, 해제하면 다시 원본이 노출된다', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const { post, up } = await sensitivePost(owner.client, ['열쇠']);
    const mark = await owner.client.patch(`/photos/${up.photoId}`, { sensitive: true });
    expect(mark.status).toBe(200);
    expect(mark.body).toMatchObject({ sensitive: true, hasBlurredCopy: true, isBlurred: false });
    expect((await other.client.get(`/posts/${post.id}`)).body.photos[0].isBlurred).toBe(true);
    expect((await owner.client.patch(`/photos/${up.photoId}`, { sensitive: false })).body.sensitive).toBe(false);
    expect((await other.client.get(`/posts/${post.id}`)).body.photos[0].isBlurred).toBe(false);
    // null 이면 자동 판단으로 복귀(민감 태그가 없으므로 비민감)
    expect((await owner.client.patch(`/photos/${up.photoId}`, { sensitive: null })).body.sensitive).toBe(false);
  });

  it('민감 태그가 있어도 작성자가 "민감하지 않음"으로 해제하면 우선한다', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const { post, up } = await sensitivePost(owner.client);
    expect((await other.client.get(`/posts/${post.id}`)).body.photos[0].isBlurred).toBe(true);
    await owner.client.patch(`/photos/${up.photoId}`, { sensitive: false });
    expect((await other.client.get(`/posts/${post.id}`)).body.photos[0].isBlurred).toBe(false);
    // 자동으로 되돌리면 태그 때문에 다시 민감
    await owner.client.patch(`/photos/${up.photoId}`, { sensitive: null });
    expect((await other.client.get(`/posts/${post.id}`)).body.photos[0].isBlurred).toBe(true);
  });

  it('타인의 사진은 표시를 바꿀 수 없고(404), 잘못된 본문은 400, 비로그인은 401', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const { up } = await sensitivePost(owner.client, ['열쇠']);
    expect((await other.client.patch(`/photos/${up.photoId}`, { sensitive: true })).status).toBe(404);
    expect((await owner.client.patch(`/photos/${up.photoId}`, { sensitive: 'yes' })).status).toBe(400);
    expect((await new Client(env.app).patch(`/photos/${up.photoId}`, { sensitive: true })).status).toBe(401);
  });
});

describe('민감 사진: fail-closed', () => {
  it('흐림 사본을 만들 수 없으면 작성자 외에는 사진 URL 이 null 이고 원본 요청도 404 (원본으로 대체하지 않음)', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const up = (await owner.client.upload(await striped())).body;
    const post = (await makePost(owner.client, { photoIds: [up.photoId], tags: ['열쇠'] })).body;
    // 원본 파일이 손상/유실된 상황을 만든다 → 흐림 처리 불가
    rmSync(join(env.storageDir, up.url.replace('/api/v1/files/', '')));
    const mark = await owner.client.patch(`/photos/${up.photoId}`, { sensitive: true });
    expect(mark.body).toMatchObject({ sensitive: true, hasBlurredCopy: false });
    const seen = (await other.client.get(`/posts/${post.id}`)).body;
    expect(seen.photos[0]).toMatchObject({ url: null, isBlurred: true });
    const card = (await other.client.get('/posts')).body.items.find((p: { id: number }) => p.id === post.id);
    expect(card.thumbnailUrl).toBeNull();
    expect((await getFile(other.client, up.url)).statusCode).toBe(404);
  });
});

describe('민감 사진: AI 감지 연동', () => {
  function fakeEngine(sensitive: { kinds: ('ID_CARD' | 'FACE')[]; confidence: number } | null, seen: PostInput[] = []): MatchingEngine {
    return {
      async extractAttributes(post) {
        seen.push(post);
        return {
          postId: post.id,
          photos: post.photos.map((p) => ({
            photoId: p.id,
            status: 'OK' as const,
            attributes: { category: 'other' as const, colors: [], brand: 'unknown', shape: '', features: [], has_sensitive_info: !!sensitive, confidence: 0.9, ...(sensitive ? { sensitive } : {}) },
            ...(sensitive ? { sensitive } : {}),
          })),
        };
      },
      async matchPair() {
        throw new Error('미사용');
      },
      async rankCandidates() {
        return [];
      },
    };
  }
  const handler = (engine: MatchingEngine) => createMatchHandler({ db: env.db, storage: new LocalDiskStorage(env.storageDir), engine, config: loadMatchingConfig({}) });

  it('신뢰도 0.5 이상 감지 → 민감 표시 + 흐림 사본, 미만이면 표시하지 않는다', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const { post } = await sensitivePost(owner.client, ['열쇠']);
    await handler(fakeEngine({ kinds: ['ID_CARD'], confidence: 0.3 }))(post.id);
    expect((await other.client.get(`/posts/${post.id}`)).body.photos[0].isBlurred).toBe(false);
    await handler(fakeEngine({ kinds: ['ID_CARD'], confidence: 0.9 }))(post.id);
    const seen = (await other.client.get(`/posts/${post.id}`)).body.photos[0];
    expect(seen.isBlurred).toBe(true);
    const row = (await env.db.execute<{ sensitive_ai: boolean; sensitive_kinds: string[]; blurred_key: string | null }>(sql`select sensitive_ai, sensitive_kinds, blurred_key from post_photos`)).rows[0]!;
    expect(row).toMatchObject({ sensitive_ai: true, sensitive_kinds: ['ID_CARD'] });
    expect(row.blurred_key).toMatch(/^blurred\//);
  });

  it('작성자가 해제(UNMARK)한 사진은 AI 가 감지해도 민감으로 되돌리지 않고, 표시(MARK)한 사진은 sensitiveHint 로 엔진에 전달된다', async () => {
    const owner = await signup(env.app);
    const other = await signup(env.app);
    const { post, up } = await sensitivePost(owner.client, ['열쇠']);
    await owner.client.patch(`/photos/${up.photoId}`, { sensitive: false });
    await handler(fakeEngine({ kinds: ['FACE'], confidence: 0.95 }))(post.id);
    expect((await other.client.get(`/posts/${post.id}`)).body.photos[0].isBlurred).toBe(false);
    const seen: PostInput[] = [];
    await owner.client.patch(`/photos/${up.photoId}`, { sensitive: true });
    await handler(fakeEngine(null, seen))(post.id);
    expect(seen[0]!.sensitiveHint).toBe(true);
  });
});

describe('민감 사진: 파일 정리', () => {
  it('사진 삭제·글 만료 삭제·계정 삭제 시 흐림 사본도 지워지고, 사본을 고아로 오인하지 않는다', async () => {
    const owner = await signup(env.app);
    const { post, up } = await sensitivePost(owner.client);
    const blurredKey = (await env.db.execute<{ blurred_key: string }>(sql`select blurred_key from post_photos where id = ${up.photoId}`)).rows[0]!.blurred_key;
    const blurredFile = join(env.storageDir, blurredKey);
    expect(existsSync(blurredFile)).toBe(true);
    // 고아 정리: 오래된 파일이어도 DB 에 등록된 흐림 사본은 유지
    const { utimesSync } = await import('node:fs');
    const past = new Date(Date.now() - 3 * 24 * 3600_000);
    utimesSync(blurredFile, past, past);
    const storage = new LocalDiskStorage(env.storageDir);
    const report = await runCleanup(env.db, storage, { postRetentionDays: 90, dmRetentionDays: 30 });
    expect(report.orphanFiles).toBe(0);
    expect(existsSync(blurredFile)).toBe(true);
    // 글 만료 삭제 → 원본·사본 모두 삭제
    await env.db.execute(sql`update posts set status = 'CLOSED', closed_at = now() - interval '100 days' where id = ${post.id}`);
    await runCleanup(env.db, storage, { postRetentionDays: 90, dmRetentionDays: 30 });
    expect(existsSync(blurredFile)).toBe(false);

    // 임시 사진 삭제(DELETE /photos)와 계정 삭제
    const t1 = (await owner.client.upload(await striped())).body;
    await owner.client.patch(`/photos/${t1.photoId}`, { sensitive: true });
    const k1 = (await env.db.execute<{ blurred_key: string }>(sql`select blurred_key from post_photos where id = ${t1.photoId}`)).rows[0]!.blurred_key;
    expect(existsSync(join(env.storageDir, k1))).toBe(true);
    expect((await owner.client.del(`/photos/${t1.photoId}`)).status).toBe(204);
    expect(existsSync(join(env.storageDir, k1))).toBe(false);
    const t2 = (await owner.client.upload(await striped())).body;
    await owner.client.patch(`/photos/${t2.photoId}`, { sensitive: true });
    const k2 = (await env.db.execute<{ blurred_key: string }>(sql`select blurred_key from post_photos where id = ${t2.photoId}`)).rows[0]!.blurred_key;
    await owner.client.req('DELETE', '/me', { password: 'Test-Pass-77' });
    expect(existsSync(join(env.storageDir, k2))).toBe(false);
  });
});

describe('민감 사진: 스키마', () => {
  it('sensitive_override 는 MARK/UNMARK/null 만 허용된다(CHECK)', async () => {
    const owner = await signup(env.app);
    const up = (await owner.client.upload(await striped())).body;
    await expect(env.db.execute(sql`update post_photos set sensitive_override = 'MAYBE' where id = ${up.photoId}`)).rejects.toThrow();
    void schema;
  });
});
