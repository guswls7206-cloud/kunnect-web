import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedDemo } from '../src/db/seed-demo.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { Client, setupEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => env.reset());

describe('시연 시드', () => {
  it('생성되고(멱등) 시연 시나리오가 API 로 이어진다: 로그인 → 알림 → 매칭 결과 → 쪽지 → 인수 완료', async () => {
    const storage = new LocalDiskStorage(env.storageDir);
    expect((await seedDemo(env.db, storage, { password: 'Demo-Test-Pw1' })).created).toBe(true);
    expect((await seedDemo(env.db, storage, { password: 'Demo-Test-Pw1' })).created).toBe(false);

    const a = new Client(env.app);
    expect((await a.post('/auth/login', { loginId: 'demo_a', password: 'Demo-Test-Pw1' })).status).toBe(200);
    // 분실자: MATCH 알림 → 내 분실글의 매칭(AUTO/HIGH)
    const notifs = (await a.get('/notifications')).body.items;
    expect(notifs.some((n: { type: string }) => n.type === 'MATCH')).toBe(true);
    const mine = (await a.get('/me/posts?type=LOST')).body.items;
    const earphone = mine.find((p: { title: string }) => p.title.includes('에어팟'));
    const matches = (await a.get(`/posts/${earphone.id}/matches`)).body.items;
    expect(matches[0]).toMatchObject({ level: 'AUTO', grade: 'HIGH' });
    expect(matches[0].otherPost.thumbnailUrl).toMatch(/^\/api\/v1\/files\/photos\/demo-/);
    // 사진 파일이 실제로 제공된다
    const img = await env.app.inject({ method: 'GET', url: matches[0].otherPost.thumbnailUrl, headers: { cookie: a.cookie } });
    expect(img.statusCode).toBe(200);
    // 후보(CANDIDATE) 시나리오도 존재
    const all = (await a.get('/me/matches')).body.items;
    expect(all.map((m: { level: string }) => m.level)).toEqual(expect.arrayContaining(['AUTO', 'CANDIDATE']));
    // 맞음 → 쪽지(기존 대화 재사용) → 인수 완료
    const conf = (await a.post(`/matches/${matches[0].matchId}/confirm`)).body;
    const conv = (await a.post('/conversations', { postId: conf.suggestedConversation.postId, body: '인수 협의합니다' })).body;
    expect(conv.conversation.id).toBeTruthy();
    const h = (await a.post(`/conversations/${conv.conversation.id}/handover`, { postId: conf.suggestedConversation.postId, matchId: matches[0].matchId })).body;
    const b = new Client(env.app);
    await b.post('/auth/login', { loginId: 'demo_b', password: 'Demo-Test-Pw1' });
    expect((await b.post(`/handovers/${h.id}/verify`, { note: '스티커 일치' })).status).toBe(200);
    await a.post(`/handovers/${h.id}/complete`);
    expect((await b.post(`/handovers/${h.id}/complete`)).body.status).toBe('COMPLETED');
    expect((await a.get(`/posts/${earphone.id}`)).body.status).toBe('RETURNED');
  });
});
