import type { AiClient, AiImage, CompareOutput } from '../claude.js';
import type { LocationRef, PhotoAttributes, PostInput } from '../types.js';

// 시드 위치는 임시 더미(실제 건물명/좌표 아님). N1 확정 전까지 테스트 전용.
export const LOC_UNION_1F: LocationRef = { id: 'loc-union-1', buildingId: 'b-union', buildingName: '학생회관(더미)', floor: 1, groupId: 'g-center', lat: 37.0, lng: 127.0 };
export const LOC_UNION_2F: LocationRef = { ...LOC_UNION_1F, id: 'loc-union-2', floor: 2 };
export const LOC_LIB: LocationRef = { id: 'loc-lib-1', buildingId: 'b-lib', buildingName: '도서관(더미)', floor: 1, groupId: 'g-center', lat: 37.001, lng: 127.0 };
export const LOC_FAR: LocationRef = { id: 'loc-far', buildingId: 'b-far', buildingName: '먼 곳(더미)', floor: 1, groupId: 'g-far', lat: 37.02, lng: 127.0 };

export const FAKE_IMG = { base64: 'QUJD', mediaType: 'image/jpeg' as const }; // "ABC"

export function post(over: Partial<PostInput> & { id: string; type: PostInput['type'] }): PostInput {
  return {
    title: '검은 에어팟 케이스',
    description: '',
    presetTags: ['earphones'],
    customTags: ['검정'],
    occurredAt: '2026-10-01T09:00:00+09:00',
    location: LOC_UNION_1F,
    photos: [],
    ...over,
  };
}

export const attrs = (over: Partial<PhotoAttributes> = {}): PhotoAttributes => ({
  category: 'earphones',
  colors: ['검정'],
  brand: 'Apple',
  shape: '케이스',
  features: ['스티커'],
  has_sensitive_info: false,
  confidence: 0.9,
  ...over,
});

export const withPhoto = (id: string, a?: PhotoAttributes) => ({ id, ...FAKE_IMG, attributes: a ?? null });

/** 호출을 기록하는 모의 AI 클라이언트 */
export class MockAi implements AiClient {
  extractCalls = 0;
  compareCalls = 0;
  likelihood = 0.9;
  failCompare: Error | null = null;
  failExtract: Error | null = null;
  extractResult: PhotoAttributes = attrs();
  lastCompareImages: AiImage[][] = [];
  /** compare 결과 일부를 덮어쓴다(테스트용) */
  compareResult: Partial<CompareOutput> = {};
  lastExtractImages: AiImage[][] = [];
  async extractAttributes(images?: AiImage[]) {
    this.extractCalls++;
    if (images) this.lastExtractImages.push(images);
    if (this.failExtract) throw this.failExtract;
    return { data: this.extractResult };
  }
  async compare(input: { lost: { images: AiImage[] }; found: { images: AiImage[] } }) {
    this.compareCalls++;
    this.lastCompareImages.push(input.lost.images, input.found.images);
    if (this.failCompare) throw this.failCompare;
    const data: CompareOutput = {
      sameItemLikelihood: this.likelihood,
      matchingFeatures: ['색'],
      conflictingFeatures: [],
      reasonKo: '색과 형태가 비슷합니다',
      ...this.compareResult,
    };
    return { data };
  }
}
