import { describe, expect, it } from 'vitest';
import { maskContacts } from '../src/lib/contact-mask.js';

describe('연락처 마스킹 (양성)', () => {
  it.each([
    '010-1234-5678',
    '01012345678',
    '010 1234 5678',
    '010.1234.5678',
    '연락은 010-123-4567 로 주세요',
    '02-123-4567',
    '031-123-4567',
    '공일공 일이삼사 오육칠팔',
    'test.user+1@gmail.com',
    'abc@naver.com',
    'abc (at) naver.com',
    '인스타 hong_gildong',
    '카톡: hong123',
    '카카오톡 아이디 hong123',
    'kakao id hong123',
    '@hong_gildong 로 연락주세요',
    'https://open.kakao.com/o/abc123',
    'instagram.com/hong',
  ])('마스킹된다: %s', (text) => {
    const r = maskContacts(text);
    expect(r.masked).toBe(true);
    expect(r.text).toContain('●');
  });

  it('주변 문장은 보존하고 연락처만 가린다', () => {
    const r = maskContacts('찾으시면 010-1234-5678 로 전화주세요');
    expect(r.text.startsWith('찾으시면 ')).toBe(true);
    expect(r.text.endsWith(' 로 전화주세요')).toBe(true);
    expect(r.text).not.toMatch(/\d{4}/);
  });
});

describe('연락처 마스킹 (음성: 과잉 마스킹 방지)', () => {
  it.each([
    '학생회관 3층 301호에서 잃어버렸어요',
    '오후 10:30쯤 도서관 2층',
    '학번 2021123456 아닙니다', // 10자리 숫자(휴대전화 아님)
    '2024.10.01 에 분실',
    '가격은 15,000원',
    '검은색 에어팟 케이스입니다',
    '인스타그램 스티커가 붙어 있어요',
    '카톡 알림 소리가 나는 폰',
    '공학관 1층 열쇠',
  ])('그대로 유지된다: %s', (text) => {
    const r = maskContacts(text);
    expect(r.masked, text).toBe(false);
    expect(r.text).toBe(text);
  });
});
