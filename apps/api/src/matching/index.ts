/** 매칭 엔진 공개 진입점. API 서버는 이 파일만 import 한다. */
export * from './types.js';
export { createMatchingEngine, type EngineOptions } from './pipeline.js';
export {
  AiError,
  ClaudeClient,
  createClaudeClientFromEnv,
  type AiClient,
  type AiErrorKind,
  type AiImage,
  type AiLogger,
  type CompareInput,
  type CompareOutput,
} from './claude.js';
export { DailyCallLimiter, InMemoryCounterStore, type CounterStore } from './limiter.js';
export { loadMatchingConfig, type MatchingConfig, type SensitiveMode } from './weights.js';
export { prepareImageForAi, blurImageForPrivacy, ImageError, type PreparedImage, type BlurOptions, type BlurRegion, type BlurMode, type BlurredImage } from './image.js';
export { exposureFor, sensitivityOf, modeToExposure, type Sensitivity } from './exposure.js';
export { createTagNormalizer, DEFAULT_SYNONYMS } from './tags.js';
