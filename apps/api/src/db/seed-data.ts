/**
 * 시드 데이터.
 * 위치: 사용자 지정 목록(2026-10-02) 12곳, 배열 순서 = 화면 정렬 순서. 층은 받지 않는다(floor=null 한 행).
 * 좌표는 건국대 글로컬캠퍼스 공식 캠퍼스맵(kku.ac.kr campusMap) 마커 값. "중앙도서관"은 지도상 "중원도서관(U7)" 위치다.
 * groupId(인접 그룹, 매칭 NEARBY 판단용)는 지도 건물 코드 구역(K·U).
 * "기타"(buildingKey=etc)는 글의 locationText(자유 입력)로 장소를 적는 항목이며, 매칭에서는 위치를 모르는 것으로 본다.
 * 좌표는 지도 기본 중심값(캠퍼스 중앙)이고 매칭 점수에는 쓰지 않는다.
 */
export const ETC_BUILDING_KEY = 'etc';

export const CAMPUS_LOCATIONS: ReadonlyArray<{
  buildingKey: string;
  buildingName: string;
  lat: number;
  lng: number;
  groupId: string | null;
}> = [
  { buildingKey: 'student-hall', buildingName: '학생회관', lat: 36.95139111952721, lng: 127.90714152466568, groupId: 'zone-k' },
  { buildingKey: 'humanities-social', buildingName: '인문사회관', lat: 36.94970418643559, lng: 127.90887007706155, groupId: 'zone-k' },
  { buildingKey: 'haeoreum-dorm', buildingName: '해오름학사', lat: 36.948622227976195, lng: 127.91219150313214, groupId: 'zone-k' },
  { buildingKey: 'life-science', buildingName: '생명과학관', lat: 36.94918182636977, lng: 127.90588881632969, groupId: 'zone-u' },
  { buildingKey: 'natural-science', buildingName: '자연과학관', lat: 36.94895931836202, lng: 127.90700322688977, groupId: 'zone-u' },
  { buildingKey: 'creative-arts', buildingName: '창의예술관', lat: 36.94829918327556, lng: 127.90760724369241, groupId: 'zone-u' },
  { buildingKey: 'sanghuh-research', buildingName: '상허연구동', lat: 36.94789215350658, lng: 127.90854683803904, groupId: 'zone-u' },
  { buildingKey: 'medicine', buildingName: '의학관', lat: 36.95067484435495, lng: 127.9077224391241, groupId: 'zone-k' },
  { buildingKey: 'mosirae-dorm', buildingName: '모시래학사', lat: 36.95136815642895, lng: 127.90926033736457, groupId: 'zone-k' },
  { buildingKey: 'central-library', buildingName: '중앙도서관', lat: 36.94887389698219, lng: 127.90845324886476, groupId: 'zone-u' },
  { buildingKey: 'glocal-ieum', buildingName: '글로컬이음관', lat: 36.94838038868628, lng: 127.90935954141487, groupId: 'zone-u' },
  { buildingKey: ETC_BUILDING_KEY, buildingName: '기타', lat: 36.9495, lng: 127.90687, groupId: null },
];

/**
 * 예전 임시 더미 위치의 buildingKey(참고용). 기존 DB 에 남은 행은 is_dummy=true 로 목록(/locations)과 새 글에서 숨기고,
 * 이미 그 위치를 가리키는 글은 그대로 보존한다(FK 유지). 'student-hall' 은 새 학생회관과 같은 키라 건물 필터·매칭에서 같은 건물로 취급된다.
 */
export const LEGACY_DUMMY_BUILDING_KEYS = ['student-hall', 'library', 'eng-hall', 'humanities', 'dorm'] as const;

/** 프리셋 태그. slug 는 매칭 엔진 PostInput.presetTags 와 일치해야 한다(카테고리 태그). */
export const PRESET_TAGS = [
  { name: '스마트폰', slug: 'smartphone', isCategory: true },
  { name: '이어폰', slug: 'earphones', isCategory: true },
  { name: '학생증', slug: 'student_id', isCategory: true },
  { name: '지갑', slug: 'wallet', isCategory: true },
  { name: '가방', slug: 'bag', isCategory: true },
  { name: '열쇠', slug: 'keys', isCategory: true },
  { name: '노트북', slug: 'laptop', isCategory: true },
] as const;
