/**
 * 민감 사진 노출 정책: 어떤 글의 사진을 AI(외부)로 보낼 때 원본/흐림/미전송 중 무엇으로 보낼지 결정한다. 순수 함수.
 *
 * 민감하다고 보는 경우(둘 중 하나):
 *  - 예상(expected): 글에 학생증·지갑·카드 등 민감 태그가 있거나 사용자가 sensitiveHint 로 표시
 *  - 감지(detected): 이전 추출에서 AI 가 민감 정보(학생증·카드 번호·얼굴·문서 글자 등)를 신뢰도 기준 이상으로 감지
 * 예상 민감 글은 **첫 전송(속성 추출)부터** 정책을 적용한다(원본이 한 번도 나가지 않게). 감지된 글은 감지 이후 전송(직접 비교)에 적용한다.
 */
import { normalizeText } from './guard.js';
import { baseNormalize } from './tags.js';
import type { PhotoExposure, PostInput } from './types.js';
import type { TagNormalizer } from './tags.js';
import type { MatchingConfig, SensitiveMode } from './weights.js';

export interface Sensitivity {
  expected: boolean;
  detected: boolean;
}

export function sensitivityOf(post: PostInput, cfg: MatchingConfig['exposure'], norm: TagNormalizer): Sensitivity {
  const wanted = new Set(cfg.tags.map((t) => norm(t)).filter(Boolean));
  const tagHit = [...post.presetTags, ...post.customTags].some((t) => wanted.has(norm(t)));
  // 제목·설명 키워드: 태그를 안 붙인 학생증 글도 첫 전송 전에 잡는다(NFKC·공백·제로폭 우회 정리 후 부분 일치)
  const text = baseNormalize(normalizeText(`${post.title} ${post.description ?? ''}`));
  const textHit = cfg.keywords.some((k) => {
    const kk = baseNormalize(normalizeText(k));
    return kk.length > 0 && text.includes(kk);
  });
  const expected = post.sensitiveHint === true || tagHit || textHit;
  const detected = post.photos.some((p) => {
    const a = p.attributes;
    if (!a) return false;
    if (a.sensitive) return a.sensitive.kinds.length > 0 && a.sensitive.confidence >= cfg.detectMinConfidence;
    return a.has_sensitive_info === true; // 이전 버전에서 저장된 속성(종류 없음)은 보수적으로 감지로 간주
  });
  return { expected, detected };
}

export const modeToExposure = (mode: SensitiveMode): PhotoExposure => (mode === 'SEND' ? 'SENT' : mode === 'BLUR' ? 'BLURRED' : 'SKIPPED');

/** 이 글의 사진을 AI 로 보낼 때의 노출 방식 */
export function exposureFor(post: PostInput, cfg: MatchingConfig['exposure'], norm: TagNormalizer): PhotoExposure {
  const s = sensitivityOf(post, cfg, norm);
  return s.expected || s.detected ? modeToExposure(cfg.mode) : 'SENT';
}
