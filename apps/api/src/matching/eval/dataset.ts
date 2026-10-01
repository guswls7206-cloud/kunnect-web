/**
 * 매칭 품질 평가용 합성 데이터셋. 실제 사용자 데이터가 아니며 작성자가 직접 만든 시나리오다.
 * - 위치는 더미 시드(실제 건물명/좌표 아님). 좌표 0.001° ≈ 111m.
 * - 사진은 "사전 계산된 속성 JSON"으로만 표현한다(실제 Claude 호출 없음). 속성 값은 사람이 손으로 쓴 것이라
 *   실제 모델의 오인식 분포를 반영하지 못한다(한계: eval/RESULTS.md 참조).
 */
import type { AttributeCategory, LocationRef, PhotoAttributes, PostInput } from '../types.js';

export type Label = 'TRUE' | 'NEAR' | 'FAR';

export interface EvalPair {
  id: string;
  /** TRUE = 같은 물건(정답), NEAR = 비슷해서 헷갈리는 다른 물건, FAR = 명백한 비매칭 */
  label: Label;
  note: string;
  lost: PostInput;
  found: PostInput;
  /** 양쪽에 사진 속성이 있는가(사진 모드 평가 가능) */
  bothPhotos: boolean;
}

// ── 더미 위치 시드 ──
const L = (id: string, buildingId: string, name: string, floor: number, groupId: string, lat: number, lng: number): LocationRef => ({
  id, buildingId, buildingName: name, floor, groupId, lat, lng,
});
export const LOCS = {
  union1: L('union-1', 'union', '학생회관', 1, 'center', 37.0, 127.0),
  union2: L('union-2', 'union', '학생회관', 2, 'center', 37.0, 127.0),
  lib1: L('lib-1', 'lib', '도서관', 1, 'center', 37.001, 127.0),
  lib3: L('lib-3', 'lib', '도서관', 3, 'center', 37.001, 127.0),
  cafe1: L('cafe-1', 'cafe', '식당', 1, 'center', 37.0005, 127.001),
  eng1: L('eng-1', 'eng', '공학관', 1, 'east', 37.003, 127.002),
  eng2: L('eng-2', 'eng', '공학관', 2, 'east', 37.003, 127.002),
  dorm1: L('dorm-1', 'dorm', '기숙사', 1, 'west', 37.01, 126.995),
  gym1: L('gym-1', 'gym', '체육관', 1, 'south', 37.012, 127.01),
} as const;
type LocKey = keyof typeof LOCS;

const T0 = Date.parse('2026-10-01T09:00:00+09:00');
const iso = (hoursFromT0: number) => new Date(T0 + hoursFromT0 * 3_600_000).toISOString();

export const attr = (
  category: AttributeCategory,
  colors: string[],
  brand = 'unknown',
  shape = 'unknown',
  features: string[] = [],
  confidence = 0.85,
): PhotoAttributes => ({ category, colors, brand, shape, features, has_sensitive_info: false, confidence });

interface Side {
  title: string;
  p?: string[]; // 프리셋 태그
  c?: string[]; // 사용자 정의 태그
  loc: LocKey | null;
  h?: number; // T0 기준 시각 오프셋(시간)
  a?: PhotoAttributes; // 사진 속성(있으면 사진 있음)
  author?: string;
}

function post(id: string, type: 'LOST' | 'FOUND', s: Side, defaultAuthor: string): PostInput {
  return {
    id,
    type,
    authorId: s.author ?? defaultAuthor,
    title: s.title,
    presetTags: s.p ?? [],
    customTags: s.c ?? [],
    occurredAt: iso(s.h ?? (type === 'LOST' ? 0 : 3)),
    location: s.loc ? LOCS[s.loc] : null,
    photos: s.a ? [{ id: `${id}-ph`, attributes: s.a }] : [],
  };
}

function pair(id: string, label: Label, note: string, l: Side, f: Side): EvalPair {
  return {
    id, label, note,
    lost: post(`${id}-L`, 'LOST', l, `lu-${id}`),
    found: post(`${id}-F`, 'FOUND', f, `fu-${id}`),
    bothPhotos: !!l.a && !!f.a,
  };
}

const AIRPODS = attr('earphones', ['흰색'], 'Apple', '케이스', ['스티커']);
const AIRPODS_BLACK = attr('earphones', ['검정'], 'Apple', '케이스', ['스티커']);

export const DATASET: EvalPair[] = [
  // ─────────────── TRUE (같은 물건) ───────────────
  pair('T01', 'TRUE', '검은 에어팟 케이스, 학생회관 1F↔2F, 사진 둘 다, 동의어 태그', { title: '검은 에어팟 케이스', p: ['earphones'], c: ['검정'], loc: 'union1', a: AIRPODS_BLACK }, { title: '검은 케이스', p: ['earphones'], c: ['블랙'], loc: 'union2', a: attr('earphones', ['검정'], 'Apple', '케이스', ['스티커']) }),
  pair('T02', 'TRUE', '에어팟 케이스, 사진 없음, 같은 건물 다른 층', { title: '에어팟 케이스 분실', p: ['earphones'], c: ['검정'], loc: 'union1' }, { title: '검은 케이스 주웠어요', p: ['earphones'], c: ['검은색'], loc: 'union2' }),
  pair('T03', 'TRUE', '학생증, 도서관, 사진 둘 다', { title: '학생증 분실', p: ['student_id'], c: ['파란'], loc: 'lib1', a: attr('student_id', ['파란색', '흰색'], 'unknown', '카드') }, { title: '학생증 습득', p: ['student_id'], c: ['파랑'], loc: 'lib3', a: attr('student_id', ['파란색'], 'unknown', '카드') }),
  pair('T04', 'TRUE', '학생증, 사진 없음, 커스텀 태그만 vs 프리셋', { title: '학생증 잃어버렸어요', c: ['학생증'], loc: 'lib1' }, { title: '카드 하나 주움', p: ['student_id'], loc: 'lib1' }),
  pair('T05', 'TRUE', '갈색 지갑, 학생회관 ↔ 식당(같은 그룹), 사진', { title: '갈색 지갑', p: ['wallet'], c: ['갈색'], loc: 'union1', a: attr('wallet', ['갈색'], 'unknown', '반지갑') }, { title: '지갑 습득', p: ['wallet'], c: ['브라운'], loc: 'cafe1', a: attr('wallet', ['갈색'], 'unknown', '반지갑', ['지퍼']) }),
  pair('T06', 'TRUE', '지갑, 사진 없음, 반지갑↔지갑, 갈색↔브라운', { title: '반지갑 분실', c: ['반지갑', '갈색'], loc: 'union1' }, { title: '지갑 주웠습니다', c: ['지갑', '브라운'], loc: 'union1' }),
  pair('T07', 'TRUE', '검정 장우산, 같은 위치, 사진 없음', { title: '검은 장우산', c: ['우산', '검정'], loc: 'eng1' }, { title: '우산 습득', c: ['장우산', '블랙'], loc: 'eng1' }),
  pair('T08', 'TRUE', '검정 우산, 사진 둘 다(카테고리 other)', { title: '검정 우산', c: ['우산', '검정'], loc: 'eng1', a: attr('other', ['검정'], 'unknown', '장우산') }, { title: '우산', c: ['우산', '검은색'], loc: 'eng2', a: attr('other', ['검정'], 'unknown', '장우산', ['손잡이']) }),
  pair('T09', 'TRUE', '보조배터리, 같은 건물 다른 층, 사진 없음', { title: '흰색 보조배터리', c: ['보조배터리', '흰색'], loc: 'lib1' }, { title: '보조 배터리 습득', c: ['배터리', '화이트'], loc: 'lib3' }),
  pair('T10', 'TRUE', '보조배터리 사진, 식당↔학생회관(같은 그룹)', { title: '보조배터리', c: ['보조배터리'], loc: 'cafe1', a: attr('other', ['흰색'], 'Anker', '직사각형') }, { title: '충전 배터리', c: ['파워뱅크'], loc: 'union1', a: attr('other', ['흰색'], 'Anker', '직사각형') }),
  pair('T11', 'TRUE', '초록 텀블러, 같은 위치, 사진 둘 다', { title: '초록 텀블러', c: ['텀블러', '초록'], loc: 'cafe1', a: attr('other', ['초록색'], 'Stanley', '텀블러') }, { title: '텀블러 습득', c: ['텀블러', '녹색'], loc: 'cafe1', a: attr('other', ['초록색'], 'Stanley', '텀블러') }),
  pair('T12', 'TRUE', '텀블러, 사진 없음, 물병↔텀블러', { title: '텀블러 분실', c: ['텀블러', '초록'], loc: 'cafe1' }, { title: '물병', c: ['물병', '녹색'], loc: 'cafe1' }),
  pair('T13', 'TRUE', '아이폰, 사진 없음, 프리셋↔커스텀', { title: '아이폰 분실', p: ['smartphone'], c: ['아이폰', '검정'], loc: 'eng1' }, { title: '핸드폰 습득', p: ['smartphone'], c: ['검은색'], loc: 'eng1' }),
  pair('T14', 'TRUE', '갤럭시, 사진 없음, 같은 그룹', { title: '갤럭시 폰', c: ['갤럭시', '검정'], loc: 'union1' }, { title: '휴대폰 습득', p: ['smartphone'], c: ['블랙'], loc: 'lib1' }),
  pair('T15', 'TRUE', '회색 노트북, 사진 둘 다, 공학관 1F↔2F', { title: '회색 노트북', p: ['laptop'], c: ['회색'], loc: 'eng1', a: attr('laptop', ['회색'], 'Samsung', '노트북') }, { title: '노트북 습득', p: ['laptop'], c: ['그레이'], loc: 'eng2', a: attr('laptop', ['회색'], 'Samsung', '노트북') }),
  pair('T16', 'TRUE', '맥북(커스텀)↔노트북(프리셋), 사진 없음', { title: '맥북 에어', c: ['맥북', '은색'], loc: 'eng1' }, { title: '노트북', p: ['laptop'], c: ['실버'], loc: 'eng1' }),
  pair('T17', 'TRUE', '열쇠, 사진 없음, 같은 건물', { title: '열쇠 분실', p: ['keys'], loc: 'lib1' }, { title: '열쇠 습득', p: ['keys'], loc: 'lib3' }),
  pair('T18', 'TRUE', '카드키↔열쇠, 사진 없음, 같은 위치', { title: '카드키 분실', c: ['카드키'], loc: 'dorm1' }, { title: '열쇠고리 주움', c: ['열쇠'], loc: 'dorm1' }),
  pair('T19', 'TRUE', '[어려움] 습득자가 물건을 옮김(분실 학생회관, 습득 기숙사), 사진 있음', { title: '검은 에어팟 케이스', p: ['earphones'], c: ['검정'], loc: 'union1', a: AIRPODS_BLACK }, { title: '검은 케이스', p: ['earphones'], c: ['블랙'], loc: 'dorm1', a: AIRPODS_BLACK }),
  pair('T20', 'TRUE', '[어려움] 위치 불일치 + 사진 없음(에어팟을 기숙사로 가져감)', { title: '에어팟 케이스', p: ['earphones'], c: ['검정'], loc: 'union1' }, { title: '이어폰 케이스', p: ['earphones'], c: ['검정'], loc: 'dorm1' }),
  pair('T21', 'TRUE', '[어려움] 태그 빈약: 분실자는 프리셋만, 습득자는 태그 많음', { title: '에어팟', p: ['earphones'], loc: 'union1' }, { title: '충전 케이스', p: ['earphones'], c: ['흰색', '스티커', '케이스', '애플'], loc: 'union1' }),
  pair('T22', 'TRUE', '[어려움] AI 속성 오인식(조명으로 검정→회색)', { title: '검은 에어팟 케이스', p: ['earphones'], c: ['검정'], loc: 'union1', a: AIRPODS_BLACK }, { title: '케이스 습득', p: ['earphones'], c: ['검정'], loc: 'union1', a: attr('earphones', ['회색'], 'unknown', '케이스') }),
  pair('T23', 'TRUE', '영문 태그 혼용, 사진 없음', { title: 'AirPods case', c: ['airpods', 'black'], loc: 'union1' }, { title: '에어팟 케이스', c: ['에어팟', '검은색'], loc: 'union1' }),
  pair('T24', 'TRUE', '한쪽만 사진(분실자만), 학생회관 같은 층', { title: '검은 에어팟 케이스', p: ['earphones'], c: ['검정'], loc: 'union1', a: AIRPODS_BLACK }, { title: '케이스', p: ['earphones'], c: ['검정'], loc: 'union1' }),
  pair('T25', 'TRUE', '습득이 이틀 뒤(분실 후 늦게 주움), 사진 없음', { title: '검정 우산', c: ['우산', '검정'], loc: 'eng1' }, { title: '우산', c: ['우산', '검정'], loc: 'eng1', h: 50 }),
  pair('T26', 'TRUE', '[어려움] 위치를 모름/미입력(분실자), 사진 둘 다', { title: '초록 텀블러', c: ['텀블러', '초록'], loc: null, a: attr('other', ['초록색'], 'Stanley', '텀블러') }, { title: '텀블러', c: ['텀블러', '초록'], loc: 'cafe1', a: attr('other', ['초록색'], 'Stanley', '텀블러') }),

  // ─────────────── NEAR (헷갈리는 다른 물건) ───────────────
  pair('N01', 'NEAR', '에어팟(Apple, 흰색) vs 버즈(Samsung, 흰색), 같은 위치, 사진', { title: '에어팟', p: ['earphones'], c: ['에어팟', '흰색'], loc: 'union1', a: AIRPODS }, { title: '버즈', p: ['earphones'], c: ['버즈', '흰색'], loc: 'union1', a: attr('earphones', ['흰색'], 'Samsung', '케이스') }),
  pair('N02', 'NEAR', '에어팟 검정 vs 흰색, 같은 위치, 사진 없음', { title: '검은 에어팟', p: ['earphones'], c: ['에어팟', '검정'], loc: 'union1' }, { title: '흰 에어팟', p: ['earphones'], c: ['에어팟', '흰색'], loc: 'union1' }),
  pair('N03', 'NEAR', '에어팟 검정 vs 흰색, 같은 위치, 사진 있음', { title: '검은 에어팟', p: ['earphones'], c: ['에어팟', '검정'], loc: 'union1', a: AIRPODS_BLACK }, { title: '흰 에어팟', p: ['earphones'], c: ['에어팟', '흰색'], loc: 'union1', a: AIRPODS }),
  pair('N04', 'NEAR', '지갑 갈색 vs 검정, 같은 위치, 사진 없음', { title: '갈색 지갑', p: ['wallet'], c: ['갈색'], loc: 'union1' }, { title: '검은 지갑', p: ['wallet'], c: ['검정'], loc: 'union1' }),
  pair('N05', 'NEAR', '[구분 불가] 같은 모양 학생증 두 장(서로 다른 사람), 같은 건물, 사진 없음', { title: '학생증', p: ['student_id'], loc: 'lib1' }, { title: '학생증 습득', p: ['student_id'], loc: 'lib1' }),
  pair('N06', 'NEAR', '[구분 불가] 같은 모양 학생증 두 장, 사진 있음', { title: '학생증', p: ['student_id'], loc: 'lib1', a: attr('student_id', ['파란색'], 'unknown', '카드') }, { title: '학생증 습득', p: ['student_id'], loc: 'lib1', a: attr('student_id', ['파란색'], 'unknown', '카드') }),
  pair('N07', 'NEAR', '[구분 불가] 검정 장우산 vs 검정 장우산(흔함), 같은 위치', { title: '검은 우산', c: ['우산', '검정'], loc: 'eng1' }, { title: '검은 우산', c: ['우산', '검정'], loc: 'eng1' }),
  pair('N08', 'NEAR', '보조배터리 Anker vs Samsung(흰색), 같은 건물, 사진', { title: '보조배터리', c: ['보조배터리', '흰색'], loc: 'lib1', a: attr('other', ['흰색'], 'Anker', '직사각형') }, { title: '보조배터리', c: ['보조배터리', '흰색'], loc: 'lib3', a: attr('other', ['흰색'], 'Samsung', '직사각형') }),
  pair('N09', 'NEAR', '초록 텀블러 같은 종류, 다른 건물(공학관 vs 식당), 사진 없음', { title: '초록 텀블러', c: ['텀블러', '초록'], loc: 'eng1' }, { title: '초록 텀블러', c: ['텀블러', '초록'], loc: 'cafe1' }),
  pair('N10', 'NEAR', '에어팟 검정, 습득이 분실보다 5일 먼저(시간 제외)', { title: '검은 에어팟', p: ['earphones'], c: ['검정'], loc: 'union1' }, { title: '검은 에어팟', p: ['earphones'], c: ['검정'], loc: 'union1', h: -120 }),
  pair('N11', 'NEAR', '같은 작성자가 올린 분실/습득(제외)', { title: '지갑', p: ['wallet'], c: ['갈색'], loc: 'union1', author: 'same-user' }, { title: '지갑', p: ['wallet'], c: ['갈색'], loc: 'union1', author: 'same-user' }),
  pair('N12', 'NEAR', '지갑 vs 학생증 같은 위치(카테고리 충돌 제외)', { title: '지갑', p: ['wallet'], c: ['검정'], loc: 'union1' }, { title: '학생증', p: ['student_id'], c: ['검정'], loc: 'union1' }),
  pair('N13', 'NEAR', '노트북 회색 vs 은색, 같은 건물, 사진', { title: '노트북', p: ['laptop'], c: ['회색'], loc: 'eng1', a: attr('laptop', ['회색'], 'Samsung', '노트북') }, { title: '노트북', p: ['laptop'], c: ['실버'], loc: 'eng2', a: attr('laptop', ['은색'], 'LG', '노트북') }),
  pair('N14', 'NEAR', '스마트폰 검정 둘, 같은 위치(흔함), 사진 없음', { title: '검은 휴대폰', p: ['smartphone'], c: ['검정'], loc: 'union1' }, { title: '검은 핸드폰', p: ['smartphone'], c: ['블랙'], loc: 'union1' }),
  pair('N15', 'NEAR', '스마트폰 검정 둘, 같은 위치, 사진 있음(브랜드 다름)', { title: '검은 폰', p: ['smartphone'], c: ['검정', '아이폰'], loc: 'union1', a: attr('smartphone', ['검정'], 'Apple', '직사각형') }, { title: '검은 폰', p: ['smartphone'], c: ['검정', '갤럭시'], loc: 'union1', a: attr('smartphone', ['검정'], 'Samsung', '직사각형') }),
  pair('N16', 'NEAR', '열쇠 vs 열쇠, 같은 건물(흔함), 사진 없음', { title: '열쇠', p: ['keys'], loc: 'dorm1' }, { title: '열쇠', p: ['keys'], loc: 'dorm1' }),
  pair('N17', 'NEAR', '에어팟 vs 이어폰(유선), 같은 위치, 사진 없음', { title: '에어팟', p: ['earphones'], c: ['에어팟', '흰색'], loc: 'lib1' }, { title: '유선 이어폰', p: ['earphones'], c: ['흰색'], loc: 'lib1' }),
  pair('N18', 'NEAR', '가방 검정 둘, 같은 건물, 사진 없음', { title: '검은 백팩', p: ['bag'], c: ['검정'], loc: 'lib1' }, { title: '검은 가방', p: ['bag'], c: ['블랙'], loc: 'lib3' }),

  // ─────────────── FAR (명백한 비매칭) ───────────────
  pair('F01', 'FAR', '우산 vs 지갑, 다른 건물', { title: '우산', c: ['우산', '검정'], loc: 'eng1' }, { title: '지갑', p: ['wallet'], c: ['갈색'], loc: 'dorm1' }),
  pair('F02', 'FAR', '텀블러 vs 에어팟, 같은 위치', { title: '텀블러', c: ['텀블러', '초록'], loc: 'cafe1' }, { title: '에어팟', p: ['earphones'], c: ['흰색'], loc: 'cafe1' }),
  pair('F03', 'FAR', '열쇠 vs 노트북', { title: '열쇠', p: ['keys'], loc: 'lib1' }, { title: '노트북', p: ['laptop'], c: ['회색'], loc: 'lib1' }),
  pair('F04', 'FAR', '보조배터리 vs 충전기(관련 용품, 같은 위치)', { title: '보조배터리', c: ['보조배터리', '흰색'], loc: 'lib1' }, { title: '충전기', c: ['충전기', '흰색'], loc: 'lib1' }),
  pair('F05', 'FAR', '검정 가방 vs 검정 가방, 기숙사 vs 체육관(멀리)', { title: '검은 가방', p: ['bag'], c: ['검정'], loc: 'dorm1' }, { title: '검은 가방', p: ['bag'], c: ['검정'], loc: 'gym1' }),
  pair('F06', 'FAR', '학생증 vs 우산', { title: '학생증', p: ['student_id'], loc: 'union1' }, { title: '우산', c: ['우산', '파란색'], loc: 'union1' }),
  pair('F07', 'FAR', '검은 지갑 vs 흰 에어팟 사진', { title: '검은 지갑', p: ['wallet'], c: ['검정'], loc: 'union1', a: attr('wallet', ['검정'], 'unknown', '지갑') }, { title: '케이스', p: ['earphones'], c: ['흰색'], loc: 'union1', a: AIRPODS }),
  pair('F08', 'FAR', '텀블러(공학관) vs 우산(체육관)', { title: '텀블러', c: ['텀블러'], loc: 'eng1' }, { title: '우산', c: ['우산'], loc: 'gym1' }),
  pair('F09', 'FAR', '노트북 vs 스마트폰', { title: '노트북', p: ['laptop'], c: ['회색'], loc: 'eng1', a: attr('laptop', ['회색'], 'Samsung', '노트북') }, { title: '폰', p: ['smartphone'], c: ['회색'], loc: 'eng1', a: attr('smartphone', ['회색'], 'Samsung', '직사각형') }),
  pair('F10', 'FAR', '카테고리 정보 없는 글 vs 우산, 다른 건물', { title: '뭔가 잃어버림', c: ['검정'], loc: 'union1' }, { title: '우산', c: ['우산', '검정'], loc: 'gym1' }),
];
