import argon2 from 'argon2';
import { eq, like, sql } from 'drizzle-orm';
import sharp from 'sharp';
import type { Db } from './client.js';
import { schema } from './client.js';
import { seedCatalog } from './seed.js';
import type { PhotoStorage } from '../storage/index.js';

/**
 * 시연용 데이터: 사용자 4명, 분실/습득 글(쌍 시나리오), 매칭 결과(AUTO/CANDIDATE), 댓글, 쪽지.
 * - 사진은 sharp 로 직접 그린 단색 도형 플레이스홀더다(저작권 문제 없음). 실제 물건 사진이 필요하면 교체한다.
 * - 매칭 결과는 AI 호출 없이 DB 에 직접 넣는다(ANTHROPIC_API_KEY 없이도 시연 가능). ai_reason 은 "시드" 문구다.
 * - 이미 demo_ 사용자가 있으면 아무것도 하지 않는다(멱등). 운영 DB 에서는 실행하지 않는다(scripts/seed-demo.ts 가 거부).
 */
export const DEMO_USERS = [
  { loginId: 'demo_a', nickname: '데모분실자' },
  { loginId: 'demo_b', nickname: '데모습득자' },
  { loginId: 'demo_c', nickname: '데모학생C' },
  { loginId: 'demo_d', nickname: '데모학생D' },
] as const;

interface PhotoSpec {
  bg: string;
  shape: 'rounded' | 'circle' | 'rect';
  color: string;
  attrs: { category: string; colors: string[]; brand: string; shape: string; features: string[] };
}

async function drawPhoto(spec: PhotoSpec): Promise<Buffer> {
  const body =
    spec.shape === 'circle'
      ? `<circle cx="400" cy="300" r="170" fill="${spec.color}"/>`
      : `<rect x="220" y="170" width="360" height="260" rx="${spec.shape === 'rounded' ? 70 : 8}" fill="${spec.color}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="${spec.bg}"/>${body}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 85 }).toBuffer();
}

/** 동시에 두 번 시드해도 한 번만 만들어지도록 트랜잭션 안에서 잡는 advisory lock 키 */
const SEED_LOCK_KEY = 7_340_001;

/**
 * 시연 데이터 생성. DB 쓰기는 한 트랜잭션이라 중간에 실패해도 반쯤 만들어진 데이터가 남지 않고(다음 실행이 다시 시도),
 * 실패 시 그 사이 저장한 사진 파일도 지운다. 같은 시드를 동시에 실행해도 advisory lock 으로 직렬화된다.
 */
export async function seedDemo(db: Db, storage: PhotoStorage, opts: { password: string }): Promise<{ created: boolean }> {
  await seedCatalog(db);
  const hash = await argon2.hash(opts.password, { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
  const saved: string[] = [];
  const recording: PhotoStorage = {
    save: async (key, data) => {
      saved.push(key);
      return storage.save(key, data);
    },
    delete: (key) => storage.delete(key),
    read: (key) => storage.read(key),
    list: (o) => storage.list(o),
  };
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${SEED_LOCK_KEY})`);
      const existing = await tx.select({ id: schema.users.id }).from(schema.users).where(like(schema.users.loginId, 'demo\\_%'));
      if (existing.length) return { created: false };
      return seedDemoRows(tx as unknown as Db, recording, hash);
    });
  } catch (e) {
    for (const key of saved) await storage.delete(key); // 롤백된 시드의 파일 정리
    throw e;
  }
}

async function seedDemoRows(db: Db, storage: PhotoStorage, hash: string): Promise<{ created: boolean }> {
  const users = await db
    .insert(schema.users)
    .values(DEMO_USERS.map((u) => ({ loginId: u.loginId, passwordHash: hash, nickname: u.nickname, nicknameLower: u.nickname.toLowerCase() })))
    .returning();
  const [a, b, c, d] = users as [(typeof users)[number], (typeof users)[number], (typeof users)[number], (typeof users)[number]];

  const locs = await db.select().from(schema.locations);
  const loc = (name: string) => locs.find((l) => !l.isDummy && l.buildingName === name)!;
  const ensureTag = async (name: string) => {
    await db.insert(schema.tags).values({ name }).onConflictDoNothing();
    const [t] = await db.select({ id: schema.tags.id }).from(schema.tags).where(eq(schema.tags.name, name)).limit(1);
    return t!.id;
  };

  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);
  let photoSeq = 0;

  async function addPost(opts2: {
    author: typeof a;
    type: 'LOST' | 'FOUND';
    title: string;
    description: string;
    where: ReturnType<typeof loc>;
    ago: number;
    tagNames: string[];
    storagePlace?: string;
    hiddenFeatures?: string;
    photo?: PhotoSpec;
  }) {
    const [p] = await db
      .insert(schema.posts)
      .values({
        type: opts2.type,
        authorId: opts2.author.id,
        title: opts2.title,
        description: opts2.description,
        locationId: opts2.where.id,
        occurredAt: hoursAgo(opts2.ago),
        storagePlace: opts2.storagePlace ?? null,
        hiddenFeatures: opts2.hiddenFeatures ?? null,
        matchState: 'DONE',
        createdAt: hoursAgo(Math.max(opts2.ago - 1, 0.5)),
      })
      .returning();
    for (const name of opts2.tagNames) await db.insert(schema.postTags).values({ postId: p!.id, tagId: await ensureTag(name) });
    if (opts2.photo) {
      photoSeq += 1;
      const key = `photos/demo-${photoSeq}.jpg`;
      const url = await storage.save(key, await drawPhoto(opts2.photo));
      await db.insert(schema.postPhotos).values({
        postId: p!.id,
        ownerId: opts2.author.id,
        storageKey: key,
        url,
        width: 800,
        height: 600,
        order: 0,
        aiStatus: 'DONE',
        aiAttributes: { ...opts2.photo.attrs, has_sensitive_info: false, confidence: 0.9 },
      });
    }
    return p!;
  }

  const earphoneAttrs = { category: 'earphones', colors: ['black'], brand: 'unknown', shape: '케이스', features: [] };
  // 시나리오 1: AUTO 매칭 — 학생회관, 사진 있음(양쪽), 태그 동일
  const lost1 = await addPost({
    author: a, type: 'LOST', title: '검은색 에어팟 케이스', description: '학생회관에서 분실했습니다. 검은색 케이스입니다.',
    where: loc('학생회관'), ago: 26, tagNames: ['이어폰', '검정'],
    photo: { bg: '#e8eef6', shape: 'rounded', color: '#1a1a1a', attrs: earphoneAttrs },
  });
  const found1 = await addPost({
    author: b, type: 'FOUND', title: '검은 케이스 주웠어요', description: '학생회관 2층 계단 옆에서 습득했습니다.',
    where: loc('학생회관'), ago: 20, tagNames: ['이어폰', '검정'], storagePlace: '학생회관 안내데스크에 맡김',
    hiddenFeatures: '뒷면에 작은 스티커가 있음',
    photo: { bg: '#f1f1ec', shape: 'rounded', color: '#222222', attrs: earphoneAttrs },
  });
  // 시나리오 2: CANDIDATE — 지갑, 다른 건물
  const lost2 = await addPost({
    author: a, type: 'LOST', title: '갈색 반지갑', description: '중앙도서관에서 잃어버린 것 같아요.',
    where: loc('중앙도서관'), ago: 30, tagNames: ['지갑', '갈색'],
    photo: { bg: '#eef3ea', shape: 'rect', color: '#7a4b2a', attrs: { category: 'wallet', colors: ['brown'], brand: 'unknown', shape: '반지갑', features: [] } },
  });
  const found2 = await addPost({
    author: c, type: 'FOUND', title: '갈색 지갑 습득', description: '자연과학관 1층 복도에서 주웠습니다.',
    where: loc('자연과학관'), ago: 12, tagNames: ['지갑', '갈색'], storagePlace: '본인이 보관 중',
    photo: { bg: '#f4efe6', shape: 'rect', color: '#8a5a33', attrs: { category: 'wallet', colors: ['brown'], brand: 'unknown', shape: '반지갑', features: [] } },
  });
  // 시나리오 3: 사진 없는 쌍 — 알림 없이 후보로만(사진 없음 AUTO 차단 정책)
  const lost3 = await addPost({ author: c, type: 'LOST', title: '기숙사 열쇠', description: '열쇠고리가 달린 열쇠를 잃어버렸습니다.', where: loc('모시래학사'), ago: 8, tagNames: ['열쇠'] });
  const found3 = await addPost({ author: d, type: 'FOUND', title: '열쇠 습득', description: '모시래학사 1층 로비.', where: loc('모시래학사'), ago: 5, tagNames: ['열쇠'], storagePlace: '모시래학사 행정실' });
  // 시나리오 4: 매칭되지 않는 글(카테고리 충돌) + 잡음
  await addPost({ author: d, type: 'LOST', title: '노트북 충전기', description: '자연과학관 3층 강의실.', where: loc('자연과학관'), ago: 40, tagNames: ['노트북'] });
  await addPost({ author: b, type: 'FOUND', title: '학생증 습득', description: '인문사회관 앞.', where: loc('인문사회관'), ago: 3, tagNames: ['학생증'], storagePlace: '인문사회관 행정실' });

  const seedMatch = async (lost: typeof lost1, found: typeof found1, level: 'AUTO' | 'CANDIDATE', total: number, mode: string, reason: string | null) => {
    const [m] = await db
      .insert(schema.matches)
      .values({
        lostPostId: lost.id, foundPostId: found.id, photoScore: mode === 'WITH_PHOTO' ? total : null,
        locationScore: level === 'AUTO' ? 0.8 : 0.4, tagScore: 1, totalScore: total, level, mode, degraded: false, aiReason: reason,
        notifiedAt: level === 'AUTO' ? new Date() : null,
      })
      .returning();
    return m!;
  };
  const m1 = await seedMatch(lost1, found1, 'AUTO', 0.91, 'WITH_PHOTO', '[시드] 색상·형태가 비슷합니다.');
  await seedMatch(lost2, found2, 'CANDIDATE', 0.68, 'WITH_PHOTO', '[시드] 색은 비슷하지만 위치가 다릅니다.');
  await seedMatch(lost3, found3, 'CANDIDATE', 0.74, 'NO_PHOTO', null);
  await db.insert(schema.notifications).values({ userId: a.id, type: 'MATCH', matchId: m1.id, postId: lost1.id });

  // 댓글·쪽지 샘플
  const [c1] = await db.insert(schema.comments).values({ postId: found1.id, authorId: c.id, body: '저도 비슷한 케이스를 봤어요.' }).returning();
  await db.insert(schema.comments).values({ postId: found1.id, authorId: b.id, parentId: c1!.id, body: '혹시 주인이시면 쪽지 주세요.' });
  await db.insert(schema.notifications).values({ userId: b.id, type: 'COMMENT', commentId: c1!.id, postId: found1.id });

  const [conv] = await db.insert(schema.conversations).values({ userAId: a.id, userBId: b.id }).returning();
  await db.insert(schema.conversationMembers).values([{ conversationId: conv!.id, userId: a.id }, { conversationId: conv!.id, userId: b.id }]);
  const [msg] = await db
    .insert(schema.messages)
    .values({ conversationId: conv!.id, senderId: a.id, postId: found1.id, body: '안녕하세요, 올려주신 검은 케이스가 제 것 같아서 연락드려요.' })
    .returning();
  await db.update(schema.conversations).set({ lastMessageAt: msg!.createdAt }).where(eq(schema.conversations.id, conv!.id));
  await db.insert(schema.notifications).values({ userId: b.id, type: 'MESSAGE', conversationId: conv!.id, postId: found1.id });

  return { created: true };
}

/** 개발용 기본 비밀번호(공개된 값). 운영에서는 쓸 수 없고, 개발에서도 DEMO_PASSWORD 를 권장한다. */
const DEFAULT_DEMO_PASSWORD = 'Demo-Pass-2026';

/**
 * 시연 시드 실행 허용 여부와 비밀번호 결정. 운영(NODE_ENV=production)에서는 거부한다(공개된 비밀번호의 계정이 생기는 것을 막음).
 * DEMO_PASSWORD 가 없으면 기본값을 쓰되 경고를 돌려준다.
 */
export function resolveDemoSeedSettings(env: Record<string, string | undefined>): { password: string; warning?: string } {
  if (env.NODE_ENV === 'production') {
    throw new Error('운영 환경(NODE_ENV=production)에서는 시연 데이터를 만들 수 없습니다.');
  }
  const fromEnv = env.DEMO_PASSWORD?.trim();
  if (fromEnv) return { password: fromEnv };
  return { password: DEFAULT_DEMO_PASSWORD, warning: 'DEMO_PASSWORD 미설정: 공개된 기본 비밀번호를 사용합니다. 개발/시연 DB 에서만 쓰세요.' };
}
