/** 태그 정규화·동의어·유사도. 모두 순수 함수. */

interface SynonymGroup {
  /** 대표 토큰. 프리셋 슬러그와 같게 두면(예: earphones) 프리셋 태그와 직접 일치한다 */
  canonical: string;
  variants: string[];
  /** 이 대표 토큰이 암시하는 상위 카테고리(프리셋 슬러그). 상위 개념 부분 일치용 */
  implies?: string;
}

/**
 * 캠퍼스 분실물 동의어 그룹 [가정/제안]. 시드 JSON(tags.json의 동의어 사전)이 확정되면
 * `createTagNormalizer(seedSynonyms)` + `implied` 인자로 교체한다.
 * 공백·구두점·대소문자는 정규화 단계에서 제거되므로(자유 텍스트 오탐 방지를 위해 한 글자 표기는 넣지 않는다) "보조 배터리"와 "보조배터리"는 같은 표기다.
 */
const GROUPS: SynonymGroup[] = [
  // ── 색상 ──
  { canonical: '검정', variants: ['검은', '검정색', '검은색', '블랙', 'black', '까만', '까만색', '흑색', '진검정'] },
  { canonical: '흰색', variants: ['하양', '하얀', '하얀색', '화이트', 'white', '백색', '흰둥이'] },
  { canonical: '회색', variants: ['그레이', 'gray', 'grey', '쥐색', '진회색', '연회색'] },
  { canonical: '빨간색', variants: ['빨강', '빨간', '레드', 'red', '붉은', '적색'] },
  { canonical: '파란색', variants: ['파랑', '파란', '블루', 'blue', '푸른', '하늘색', '스카이블루'] },
  { canonical: '남색', variants: ['네이비', 'navy', '곤색', '감색'] },
  { canonical: '노란색', variants: ['노랑', '노란', '옐로', '옐로우', 'yellow'] },
  { canonical: '초록색', variants: ['초록', '녹색', '그린', 'green', '연두', '연두색'] },
  { canonical: '분홍색', variants: ['분홍', '핑크', 'pink'] },
  { canonical: '보라색', variants: ['보라', '퍼플', 'purple', '바이올렛'] },
  { canonical: '주황색', variants: ['주황', '오렌지', 'orange'] },
  { canonical: '갈색', variants: ['브라운', 'brown', '밤색', '카멜'] },
  { canonical: '베이지', variants: ['beige', '크림', '아이보리', 'ivory'] },
  { canonical: '은색', variants: ['실버', 'silver'] },
  { canonical: '금색', variants: ['골드', 'gold'] },
  { canonical: '투명', variants: ['투명한', 'clear', 'transparent'] },

  // ── 프리셋 카테고리(대표 토큰 = 정규화된 슬러그) ──
  { canonical: 'earphones', variants: ['이어폰', '이어폰케이스', '이어버즈', '무선이어폰', '블루투스이어폰', 'earphone', 'earbuds', 'earbud', '헤드폰', '헤드셋'] },
  { canonical: 'smartphone', variants: ['스마트폰', '핸드폰', '휴대폰', '휴대전화', '전화기', 'phone', 'cellphone', 'mobile', '스마트폰케이스', '폰케이스', '핸드폰케이스'] },
  { canonical: 'studentid', variants: ['학생증', '신분증', '학생카드', '사원증', '교직원증', 'idcard', 'studentid', '모바일학생증'] },
  { canonical: 'wallet', variants: ['지갑', '반지갑', '장지갑', '카드지갑', '카드케이스', '동전지갑', '머니클립'] },
  { canonical: 'bag', variants: ['가방', '백팩', '책가방', '크로스백', '에코백', '숄더백', '손가방', '파우치', 'backpack', 'bag'] },
  { canonical: 'keys', variants: ['열쇠', '열쇠고리', '키링', '카드키', '도어락키', '자동차키', 'key', 'keyring'] },
  { canonical: 'laptop', variants: ['노트북', '랩탑', '랩톱', 'laptop', 'notebook'] },

  // ── 브랜드/모델: 자기 토큰은 유지하되 상위 카테고리를 암시 ──
  { canonical: '에어팟', variants: ['airpods', 'airpod', '에어팟프로', 'airpodspro', '에어팟맥스', '에어팟케이스'], implies: 'earphones' },
  { canonical: '버즈', variants: ['buds', '갤럭시버즈', 'galaxybuds', '버즈프로', '버즈2', '버즈라이브'], implies: 'earphones' },
  { canonical: '아이폰', variants: ['iphone', '아이폰케이스'], implies: 'smartphone' },
  { canonical: '갤럭시', variants: ['galaxy', '갤럭시폰', '삼성폰'], implies: 'smartphone' },
  { canonical: '맥북', variants: ['macbook', '맥북에어', '맥북프로'], implies: 'laptop' },
  { canonical: '그램', variants: ['lg그램', 'gram', 'lggram'], implies: 'laptop' },

  // ── 프리셋에 없는 흔한 분실물(자기 대표 토큰만) ──
  { canonical: '보조배터리', variants: ['배터리', '파워뱅크', 'powerbank', '충전배터리', '보조밧데리', '밧데리'] },
  { canonical: '우산', variants: ['장우산', '단우산', '3단우산', '자동우산', 'umbrella', '양산'] },
  { canonical: '텀블러', variants: ['tumbler', '물병', '보온병', '머그컵', '물통', '스탠리'] },
  { canonical: '충전기', variants: ['charger', '충전케이블', '케이블', '어댑터', '충전선', 'c타입', '라이트닝케이블'] },
  { canonical: '태블릿', variants: ['tablet', '아이패드', 'ipad', '갤럭시탭', '아이패드프로'] },
  { canonical: '안경', variants: ['glasses', '안경케이스', '선글라스', '렌즈케이스'] },
  { canonical: '시계', variants: ['손목시계', '스마트워치', '애플워치', '워치', 'watch', 'smartwatch', 'applewatch', '갤럭시워치'] },
  { canonical: '카드', variants: ['교통카드', '체크카드', '신용카드', '티머니', 'tmoney', '현금카드', 'card'] },
  { canonical: '필통', variants: ['펜슬케이스', '필기구', '볼펜', '샤프'] },
  { canonical: '교재', variants: ['전공책', '노트', '공책', '필기노트', '교과서', '문제집', '다이어리'] },
  { canonical: '마우스', variants: ['mouse', '무선마우스', '키보드', 'keyboard'] },
  { canonical: '계산기', variants: ['공학용계산기', '전자계산기', 'calculator'] },
  { canonical: '모자', variants: ['볼캡', '비니', 'cap', 'hat'] },
  { canonical: '외투', variants: ['자켓', '재킷', '점퍼', '패딩', '후드', '후드티', '코트', '가디건', '겉옷', 'jacket'] },
  { canonical: '운동화', variants: ['신발', '슬리퍼', '구두', '스니커즈'] },
];

export const DEFAULT_SYNONYMS: Readonly<Record<string, string>> = Object.freeze(buildSynonyms(GROUPS));

/** 대표 토큰 → 암시하는 카테고리(정규화된 슬러그). 예: 에어팟 → earphones */
export const DEFAULT_IMPLIED: Readonly<Record<string, string>> = Object.freeze(buildImplied(GROUPS));

function buildSynonyms(groups: readonly SynonymGroup[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const g of groups) {
    out[g.canonical] = g.canonical;
    for (const v of g.variants) {
      const key = baseNormalize(v);
      // 중복 정의는 먼저 나온 그룹이 우선(색상 → 카테고리 → 브랜드 순). 충돌은 테스트로 감시한다
      if (!(key in out)) out[key] = g.canonical;
    }
  }
  return out;
}

function buildImplied(groups: readonly SynonymGroup[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const g of groups) if (g.implies) out[baseNormalize(g.canonical)] = baseNormalize(g.implies);
  return out;
}

/** 테스트용: 정의된 동의어 그룹(읽기 전용) */
export const SYNONYM_GROUPS: readonly SynonymGroup[] = GROUPS;

export type TagNormalizer = (raw: string) => string;

/** 소문자화, NFC, 선행 '#', 공백·구두점 제거 후 동의어 치환 */
export function createTagNormalizer(synonyms: Readonly<Record<string, string>> = DEFAULT_SYNONYMS): TagNormalizer {
  const table = new Map<string, string>();
  for (const [k, v] of Object.entries(synonyms)) table.set(baseNormalize(k), baseNormalize(v));
  return (raw) => {
    const base = baseNormalize(raw);
    return table.get(base) ?? base;
  };
}

export function baseNormalize(raw: string): string {
  return raw
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/^#+/, '')
    .replace(/[\s_\-.,;:!?'"`~()[\]{}<>/\\|]+/g, '')
    .trim();
}

export function jaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * 프리셋 + 사용자 정의 태그를 정규화한 대표 토큰 집합.
 * `implied`가 있으면 브랜드/모델 토큰(에어팟 등)에 상위 카테고리 토큰(earphones)을 함께 넣어
 * "에어팟" ↔ "버즈"가 카테고리 수준에서 부분 일치하게 한다.
 */
export function tagSet(
  preset: readonly string[],
  custom: readonly string[],
  norm: TagNormalizer,
  implied: Readonly<Record<string, string>> = DEFAULT_IMPLIED,
): Set<string> {
  const out = new Set<string>();
  for (const t of [...preset, ...custom]) {
    const n = norm(t);
    if (!n) continue;
    out.add(n);
    const up = Object.hasOwn(implied, n) ? implied[n] : undefined;
    if (up) out.add(up);
  }
  return out;
}

/** 두 글의 태그 유사도(0~1). 어느 한쪽이 비어 있으면 0(정보 없음). */
export function tagSimilarity(
  a: { preset: readonly string[]; custom: readonly string[] },
  b: { preset: readonly string[]; custom: readonly string[] },
  norm: TagNormalizer,
  implied: Readonly<Record<string, string>> = DEFAULT_IMPLIED,
): number {
  return jaccard(tagSet(a.preset, a.custom, norm, implied), tagSet(b.preset, b.custom, norm, implied));
}
