import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createMatchHandler } from '../src/jobs/match-handler.js';
import { runNextJob, setMatchHandler } from '../src/jobs/queue.js';
import { loadMatchingConfig, type MatchingEngine, type RankedMatch } from '../src/matching/index.js';
import { LocalDiskStorage } from '../src/storage/index.js';
import { makePost, setupEnv, signup, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => (env = await setupEnv()));
afterAll(async () => env.close());
beforeEach(async () => {
  setMatchHandler(null);
  await env.reset();
});

const rows = async <T>(q: ReturnType<typeof sql>) => (await env.db.execute<T & Record<string, unknown>>(q)).rows;

function autoEngine(): MatchingEngine {
  return {
    async extractAttributes(post: { id: string }) {
      return { postId: post.id, photos: [] };
    },
    async matchPair() {
      throw new Error('사용하지 않음');
    },
    async rankCandidates(post: { id: string; type: string }, candidates: { id: string }[]) {
      return candidates.map<RankedMatch>((c) => ({
        candidateId: c.id,
        lostPostId: post.type === 'LOST' ? post.id : c.id,
        foundPostId: post.type === 'LOST' ? c.id : post.id,
        score: 0.95,
        grade: 'AUTO',
        breakdown: { location: 1, tag: 1 },
        mode: 'NO_PHOTO',
        autoThreshold: 0.85,
        photoSource: 'NONE',
        degraded: false,
      }));
    },
  } as never;
}

describe('M1: AUTO 알림은 알림 생성 실패 시 유실되지 않는다', () => {
  it('notify 가 던지면 notifiedAt 이 롤백되어 재시도에서 알림이 1회 발송된다', async () => {
    const loser = await signup(env.app);
    const finder = await signup(env.app);
    await makePost(loser.client, { type: 'LOST' });
    await makePost(finder.client, { type: 'FOUND' });
    setMatchHandler(createMatchHandler({ db: env.db, storage: new LocalDiskStorage(env.storageDir), engine: autoEngine(), config: loadMatchingConfig({}), noPhotoAutoNotify: true }));

    await env.db.execute(sql`
      create or replace function test_fail_notification() returns trigger as $$
      begin raise exception 'notification insert failed'; end $$ language plpgsql`);
    await env.db.execute(sql`create trigger test_fail_notification before insert on notifications for each row execute function test_fail_notification()`);
    try {
      // 첫 번째 글(분실글) 작업은 후보가 없고, 두 번째(습득글) 작업에서 매칭 + 알림 시도가 일어난다
      while (await runNextJob(env.db, { timeoutMs: 5000 })); // 실패한 작업은 backoff 로 대기 상태가 된다
    } finally {
      await env.db.execute(sql`drop trigger if exists test_fail_notification on notifications`);
      await env.db.execute(sql`drop function if exists test_fail_notification()`);
    }
    const [m] = await rows<{ notified_at: Date | null }>(sql`select notified_at from matches`);
    expect(m?.notified_at ?? null).toBeNull(); // 알림 없이 "보냈다"고 기록되면 안 된다
    expect(await rows(sql`select 1 from notifications where type = 'MATCH'`)).toHaveLength(0);

    await env.db.execute(sql`update jobs set run_after = now() where status = 'QUEUED'`);
    while (await runNextJob(env.db, { timeoutMs: 5000 }));
    expect(await rows(sql`select 1 from notifications where type = 'MATCH' and user_id = ${loser.user.id}`)).toHaveLength(1);
    const [m2] = await rows<{ notified_at: Date | null }>(sql`select notified_at from matches`);
    expect(m2!.notified_at).toBeTruthy();
  });
});
