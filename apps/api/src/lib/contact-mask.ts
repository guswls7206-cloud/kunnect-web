/**
 * 댓글의 연락처 패턴(전화번호·이메일·SNS ID)을 마스킹한다. (쪽지에는 적용하지 않는다 — README 17번 확정)
 * 완전한 탐지는 불가능하므로 흔한 변형만 처리하며, 과잉 마스킹을 피하기 위해 학번·시각·층/호수 등은 건드리지 않는다.
 */
const MASK = '●';
const mask = (m: string) => MASK.repeat(Math.max(m.length, 3));

// 구분자(공백 - . _ · ,) 를 사이에 끼운 휴대전화 번호 (010, 011, 016~019)
const PHONE_MOBILE = /(?<!\d)01[016789][\s\-._·,]{0,2}\d{3,4}[\s\-._·,]{0,2}\d{4}(?!\d)/g;
// 지역번호 번호 (02, 031~064)
const PHONE_LANDLINE = /(?<!\d)0(?:2|[3-6][1-5])[\s\-._·,]{0,2}\d{3,4}[\s\-._·,]{0,2}\d{4}(?!\d)/g;
// "공일공 일이삼사..." 식 한글 숫자 표기: 숫자 한글이 9자 이상 연속(구분자 허용)
const PHONE_KOREAN = /(?:[공영일이삼사오육륙칠팔구][\s\-.]?){9,}/g;

// 이메일 및 "(at)", "골뱅이" 변형
const EMAIL = /[A-Za-z0-9._%+-]+\s?(?:@|\(at\)|\[at\]|골뱅이)\s?[A-Za-z0-9-]+(?:\s?(?:\.|\(dot\)|점)\s?[A-Za-z0-9-]+)+/gi;

// SNS 링크
const URL_SNS = /(?:https?:\/\/)?(?:open\.kakao\.com|(?:www\.)?instagram\.com|t\.me|line\.me|(?:www\.)?facebook\.com|wa\.me)\/\S+/gi;
// "인스타 abc_123", "카톡: abc123", "kakao id abc" 등 키워드 + ID
const SNS_KEYWORD =
  /(?:인스타그램|인스타|카카오톡|카카오|카톡|오픈채팅|오픈카톡|텔레그램|insta(?:gram)?|kakao(?:talk)?|telegram)\s*(?:id|아이디|계정|주소)?\s*[:=-]?\s*@?[A-Za-z0-9._]{3,30}/gi;
// 독립된 @handle (이메일은 앞에서 먼저 처리됨)
const AT_HANDLE = /(?<![A-Za-z0-9._])@[A-Za-z0-9._]{3,30}/g;

export interface MaskResult {
  text: string;
  masked: boolean;
}

// 제로폭 문자(숫자 사이에 끼워 탐지를 피하는 용도). U+200D(ZWJ)는 이모지 결합에 쓰이므로 제외한다
const ZERO_WIDTH = /[\u200B\u200C\u2060\uFEFF]/g;

/**
 * NFKC 정규화(전각 숫자·@·영문 → 일반 문자)와 제로폭 문자 제거 후 마스킹한다.
 * 정규화 때문에 원문과 표기가 조금 달라질 수 있다(예: 전각 문자). 완전한 우회 방지는 불가능하다.
 */
export function maskContacts(input: string): MaskResult {
  let text = input.normalize('NFKC').replace(ZERO_WIDTH, '');
  let masked = false;
  const apply = (re: RegExp) => {
    text = text.replace(re, (m) => {
      masked = true;
      return mask(m);
    });
  };
  // 이메일 → 전화번호 → SNS 순서(이메일 안의 숫자를 전화번호로 오인하지 않도록)
  apply(EMAIL);
  apply(PHONE_MOBILE);
  apply(PHONE_LANDLINE);
  apply(PHONE_KOREAN);
  apply(URL_SNS);
  apply(SNS_KEYWORD);
  apply(AT_HANDLE);
  return { text, masked };
}
