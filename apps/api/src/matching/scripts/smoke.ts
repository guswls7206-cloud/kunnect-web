/**
 * 수동 스모크 테스트: 실제 Claude API로 속성 추출 + 직접 비교를 각 1회(총 2회) 호출한다.
 * ANTHROPIC_API_KEY가 없으면 아무 것도 호출하지 않고 종료한다. CI에서 실행하지 않는다.
 *
 *   ANTHROPIC_API_KEY=... pnpm matching:smoke
 *
 * 합성 이미지(단색 도형)라서 점수 자체보다 "형식·연결이 동작하는지"만 확인한다. 호출 수·토큰은 로그로 출력된다.
 */
import sharp from 'sharp';
import { createClaudeClientFromEnv } from '../claude.js';
import { prepareImageForAi } from '../image.js';
import { createMatchingEngine } from '../pipeline.js';
import type { PostInput } from '../types.js';
import { loadMatchingConfig } from '../weights.js';

async function shape(color: string): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><rect width="800" height="600" fill="#eeeeee"/><rect x="250" y="200" width="300" height="200" rx="40" fill="${color}"/></svg>`;
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return (await prepareImageForAi(png, loadMatchingConfig().image)).base64;
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    console.log('ANTHROPIC_API_KEY 미설정: 스모크 테스트를 건너뜁니다.');
    return;
  }
  const config = loadMatchingConfig();
  const client = createClaudeClientFromEnv(config, process.env, {
    info: (e) => console.log('[ai]', JSON.stringify(e)),
    warn: (e) => console.warn('[ai:warn]', JSON.stringify(e)),
  });
  if (!client) return;
  const engine = createMatchingEngine({ client, config });

  const mk = (id: string, type: 'LOST' | 'FOUND', b64: string): PostInput => ({
    id,
    type,
    authorId: id,
    title: '검은 케이스',
    presetTags: ['earphones'],
    customTags: ['검정'],
    occurredAt: new Date().toISOString(),
    location: { id: 'x', buildingId: 'x', buildingName: '테스트' },
    photos: [{ id: `${id}-p`, base64: b64, mediaType: 'image/jpeg' }],
  });

  const lost = mk('lost', 'LOST', await shape('#111111'));
  const found = mk('found', 'FOUND', await shape('#151515'));

  const ex = await engine.extractAttributes(lost);
  console.log('추출 결과:', JSON.stringify(ex.photos[0]));
  const lostWithAttrs = { ...lost, photos: lost.photos.map((p) => ({ ...p, attributes: ex.photos[0]?.attributes ?? null })) };
  const result = await engine.matchPair(lostWithAttrs, found);
  console.log('매칭 결과:', JSON.stringify(result));
  console.log(`오늘 사용한 AI 호출 수: ${await client.callsToday()}`);
}

main().catch((e) => {
  console.error('스모크 실패:', e instanceof Error ? e.name : e); // 메시지/키 노출 방지
  process.exitCode = 1;
});
