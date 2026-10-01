import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { sensitivityOf } from '../exposure.js';
import { createMatchingEngine } from '../pipeline.js';
import { createTagNormalizer } from '../tags.js';
import { loadMatchingConfig } from '../weights.js';
import { attrs, LOC_UNION_1F, MockAi, post } from './fixtures.js';

const norm = createTagNormalizer();
const cfg = loadMatchingConfig({});

const jpegB64 = async () => (await sharp({ create: { width: 320, height: 200, channels: 3, background: '#2040d0' } }).jpeg().toBuffer()).toString('base64');
const photo = async (id: string, extra: Record<string, unknown> = {}) => ({ id, base64: await jpegB64(), mediaType: 'image/jpeg' as const, ...extra });

describe('사용자 결정: 민감 사진 기본 모드 = SKIP (AI 로 보내지 않음, 흐림 사본도 보내지 않음)', () => {
  it('기본 설정은 SKIP, 알 수 없는 값도 SKIP(안전한 기본), BLUR/SEND 는 명시적 선택일 때만', () => {
    expect(cfg.exposure.mode).toBe('SKIP');
    expect(loadMatchingConfig({ AI_SENSITIVE_MODE: 'whatever' }).exposure.mode).toBe('SKIP');
    expect(loadMatchingConfig({ AI_SENSITIVE_MODE: '' }).exposure.mode).toBe('SKIP');
    expect(loadMatchingConfig({ AI_SENSITIVE_MODE: ' blur ' }).exposure.mode).toBe('BLUR');
    expect(loadMatchingConfig({ AI_SENSITIVE_MODE: 'send' }).exposure.mode).toBe('SEND');
  });

  it('예상 민감 글(학생증 태그): 첫 전송 전에 건너뛴다 — 추출·비교 호출 0회, 어떤 이미지(원본/흐림)도 전송되지 않는다', async () => {
    const ai = new MockAi();
    const engine = createMatchingEngine({ client: ai, config: cfg });
    const lost = post({ id: 'L', type: 'LOST', authorId: 'a', presetTags: ['student_id'], customTags: [], location: LOC_UNION_1F, photos: [await photo('p1')] });
    const found = post({ id: 'F', type: 'FOUND', authorId: 'b', presetTags: ['student_id'], customTags: [], location: LOC_UNION_1F, photos: [await photo('p2')] });
    const ex = await engine.extractAttributes(lost);
    expect(ex.photos[0]).toMatchObject({ status: 'SKIPPED', reason: 'SENSITIVE', exposure: 'SKIPPED' });
    await engine.rankCandidates(lost, [found]);
    expect(ai.extractCalls).toBe(0);
    expect(ai.compareCalls).toBe(0);
    expect(ai.lastExtractImages).toEqual([]);
    expect(ai.lastCompareImages).toEqual([]);
  });

  it('민감 키워드(제목·설명): 태그가 없어도 첫 전송 전에 건너뛴다 — 학생증/신분증/카드/면허증/여권/지갑', async () => {
    const mkPost = async (title: string, description = '') => post({ id: 'P', type: 'FOUND', title, description, presetTags: [], customTags: [], photos: [await photo('p1')] });
    for (const [t, d] of [['학생증 주웠어요', ''], ['물건 주웠어요', '체크카드가 떨어져 있었습니다'], ['신분증', ''], ['운전면허증 습득', ''], ['여권 분실', ''], ['검정 지갑', '']] as const) {
      const ai = new MockAi();
      const res = await createMatchingEngine({ client: ai, config: cfg }).extractAttributes(await mkPost(t, d));
      expect(ai.extractCalls, `${t}/${d}`).toBe(0);
      expect(res.photos[0]!.reason).toBe('SENSITIVE');
    }
  });

  it('민감하지 않은 글은 영향 없음(우산·에어팟)', async () => {
    const ai = new MockAi();
    const p = post({ id: 'P', type: 'LOST', title: '검정 우산', description: '장우산', presetTags: [], customTags: ['우산'], photos: [await photo('p1')] });
    const res = await createMatchingEngine({ client: ai, config: cfg }).extractAttributes(p);
    expect(ai.extractCalls).toBe(1);
    expect(res.photos[0]!.exposure).toBe('SENT');
  });

  it('키워드 목록은 설정으로 바꾼다(AI_SENSITIVE_KEYWORDS), 비우면 키워드 판단 끔', async () => {
    expect(loadMatchingConfig({ AI_SENSITIVE_KEYWORDS: '여권, 사원증' }).exposure.keywords).toEqual(['여권', '사원증']);
    const off = loadMatchingConfig({ AI_SENSITIVE_KEYWORDS: ' ' });
    expect(sensitivityOf(post({ id: 'a', type: 'LOST', title: '학생증', presetTags: [], customTags: [] }), off.exposure, norm).expected).toBe(false);
    expect(sensitivityOf(post({ id: 'a', type: 'LOST', title: '학생증', presetTags: [], customTags: [] }), cfg.exposure, norm).expected).toBe(true);
  });

  it('[적대적] 키워드 우회 시도: 전각/공백/대소문자 변형도 걸린다', () => {
    const t = (title: string) => sensitivityOf(post({ id: 'a', type: 'LOST', title, presetTags: [], customTags: [] }), cfg.exposure, norm).expected;
    expect(t('학 생 증')).toBe(true);
    expect(t('학생증')).toBe(true);
    expect(t('ＩＤ 카드')).toBe(true); // 전각 → NFKC
    expect(t('학​생증')).toBe(true); // 제로폭 문자
  });

  it('SKIP 된 글은 사진 없는 글로 평가: NO_PHOTO(위치 0.5/태그 0.5, AUTO 0.85), degraded 아님, 직접 비교 없음', async () => {
    const ai = new MockAi();
    const lost = post({ id: 'L', type: 'LOST', authorId: 'a', presetTags: ['student_id'], customTags: [], location: LOC_UNION_1F, photos: [await photo('p1', { attributes: attrs({ category: 'student_id' }) })] });
    const found = post({ id: 'F', type: 'FOUND', authorId: 'b', presetTags: ['student_id'], customTags: [], location: LOC_UNION_1F, photos: [await photo('p2', { attributes: attrs({ category: 'student_id' }) })] });
    const r = await createMatchingEngine({ client: ai, config: cfg }).matchPair(lost, found);
    expect(ai.compareCalls).toBe(0);
    expect(r.mode).toBe('NO_PHOTO');
    expect(r.degraded).toBe(false);
    expect(r.autoThreshold).toBe(0.85);
    expect(r.score).toBe(1); // 같은 위치 + 같은 태그
    expect(r.grade).toBe('AUTO'); // 엔진 기본(이 위험은 아래 MATCH_SENSITIVE_NEVER_AUTO 로 제어)
  });

  it('[첫 추출 노출 문서화] 태그·키워드·표시 없이 올린 학생증 사진: 첫 속성 추출은 원본(사본)이 나가지만 민감 감지 후 다음 전송부터는 건너뛴다', async () => {
    const ai = new MockAi();
    ai.extractResult = attrs({ category: 'student_id', sensitive: { kinds: ['ID_CARD', 'FACE'], confidence: 0.9 }, has_sensitive_info: true });
    const engine = createMatchingEngine({ client: ai, config: cfg });
    const ph = await photo('p1');
    const untagged = post({ id: 'L', type: 'LOST', authorId: 'a', title: '잃어버렸어요', presetTags: [], customTags: [], location: LOC_UNION_1F, photos: [ph] });
    const first = await engine.extractAttributes(untagged);
    expect(ai.extractCalls).toBe(1); // 첫 전송: 어쩔 수 없이 한 번 나간다(감지하려면 봐야 함)
    expect(ai.lastExtractImages[0]![0]!.base64).toBe(ph.base64); // 흐림이 아니라 원본 사본
    expect(first.photos[0]).toMatchObject({ exposure: 'SENT', sensitive: { kinds: ['ID_CARD', 'FACE'] } });
    // 호출 측이 속성을 캐시하면 이후에는 민감 글로 취급: 비교에 사진이 나가지 않는다
    const cached = { ...untagged, photos: [{ ...ph, attributes: first.photos[0]!.attributes }] };
    const found = post({ id: 'F', type: 'FOUND', authorId: 'b', presetTags: [], customTags: [], location: LOC_UNION_1F, photos: [await photo('p2', { attributes: attrs({ category: 'student_id' }) })] });
    const r = await engine.matchPair(cached, found);
    expect(ai.compareCalls).toBe(0);
    expect(r.mode).toBe('NO_PHOTO');
    expect(r.degraded).toBe(false);
  });

  it('[첫 추출 완화] 사용자 표시(sensitiveHint)가 있으면 태그·키워드 없이도 첫 전송 전에 건너뛴다', async () => {
    const ai = new MockAi();
    const p = post({ id: 'L', type: 'LOST', title: '잃어버렸어요', presetTags: [], customTags: [], sensitiveHint: true, photos: [await photo('p1')] });
    const res = await createMatchingEngine({ client: ai, config: cfg }).extractAttributes(p);
    expect(ai.extractCalls).toBe(0);
    expect(res.photos[0]!.reason).toBe('SENSITIVE');
  });

  it('명시적 선택: SEND 는 원본 사본, BLUR 는 흐린 사본이 나간다(기본이 아님)', async () => {
    const ph = await photo('p1');
    const base = () => post({ id: 'L', type: 'LOST', presetTags: ['student_id'], customTags: [], photos: [ph] });
    const aiSend = new MockAi();
    await createMatchingEngine({ client: aiSend, config: loadMatchingConfig({ AI_SENSITIVE_MODE: 'SEND' }) }).extractAttributes(base());
    expect(aiSend.lastExtractImages[0]![0]!.base64).toBe(ph.base64);
    const aiBlur = new MockAi();
    await createMatchingEngine({ client: aiBlur, config: loadMatchingConfig({ AI_SENSITIVE_MODE: 'BLUR' }) }).extractAttributes(base());
    expect(aiBlur.lastExtractImages[0]![0]!.base64).not.toBe(ph.base64);
  });
});

describe('선택 옵션: MATCH_SENSITIVE_NEVER_AUTO (기본 꺼짐) — 민감 카테고리는 후보까지만', () => {
  const idPair = () => ({
    lost: post({ id: 'L', type: 'LOST', authorId: 'a', presetTags: ['student_id'], customTags: [], location: LOC_UNION_1F }),
    found: post({ id: 'F', type: 'FOUND', authorId: 'b', presetTags: ['student_id'], customTags: [], location: LOC_UNION_1F }),
  });
  it('기본값은 꺼짐', () => {
    expect(cfg.sensitiveNeverAuto).toBe(false);
    expect(loadMatchingConfig({ MATCH_SENSITIVE_NEVER_AUTO: 'true' }).sensitiveNeverAuto).toBe(true);
    expect(loadMatchingConfig({ MATCH_SENSITIVE_NEVER_AUTO: 'yes' }).sensitiveNeverAuto).toBe(false); // true 만 켠다
  });
  it('켜면 학생증 쌍(같은 위치·같은 태그, 점수 1.0)도 AUTO 가 아니라 CANDIDATE, 점수는 유지', async () => {
    const { lost, found } = idPair();
    const off = await createMatchingEngine({ config: cfg }).matchPair(lost, found);
    expect(off.grade).toBe('AUTO');
    const on = await createMatchingEngine({ config: loadMatchingConfig({ MATCH_SENSITIVE_NEVER_AUTO: 'true' }) }).matchPair(lost, found);
    expect(on.score).toBe(off.score);
    expect(on.grade).toBe('CANDIDATE');
  });
  it('켜도 민감하지 않은 쌍은 영향 없음, 키워드·감지·sensitiveHint 로 민감한 쌍은 막힌다', async () => {
    const on = createMatchingEngine({ config: loadMatchingConfig({ MATCH_SENSITIVE_NEVER_AUTO: 'true' }) });
    const plain = await on.matchPair(
      post({ id: 'L', type: 'LOST', authorId: 'a', presetTags: ['earphones'], customTags: ['검정'], location: LOC_UNION_1F }),
      post({ id: 'F', type: 'FOUND', authorId: 'b', presetTags: ['earphones'], customTags: ['검정'], location: LOC_UNION_1F }),
    );
    expect(plain.grade).toBe('AUTO');
    const byKeyword = await on.matchPair(
      post({ id: 'L', type: 'LOST', authorId: 'a', title: '학생증 잃어버림', presetTags: ['earphones'], customTags: ['검정'], location: LOC_UNION_1F }),
      post({ id: 'F', type: 'FOUND', authorId: 'b', presetTags: ['earphones'], customTags: ['검정'], location: LOC_UNION_1F }),
    );
    expect(byKeyword.grade).toBe('CANDIDATE');
    const byHint = await on.matchPair(
      post({ id: 'L', type: 'LOST', authorId: 'a', presetTags: ['earphones'], customTags: ['검정'], location: LOC_UNION_1F }),
      post({ id: 'F', type: 'FOUND', authorId: 'b', presetTags: ['earphones'], customTags: ['검정'], location: LOC_UNION_1F, sensitiveHint: true }),
    );
    expect(byHint.grade).toBe('CANDIDATE');
  });
});
