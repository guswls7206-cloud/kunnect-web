import type { Location, Tag } from "@/lib/api/types";
import { setDb, setSessionUserId, type MockDb, type MockPhoto, type MockPost } from "./db";

/**
 * 글로컬캠퍼스 위치 목록(사용자 지정 순서, 백엔드 시드와 같은 buildingId·좌표). 층 정보는 없어 floor=null.
 * "기타"(etc)는 목록에 없는 장소로, 글에 locationText 를 직접 적는다(좌표는 임시 값).
 */
const CAMPUS_LOCATIONS: Array<[string, string, number, number]> = [
  ["student-hall", "학생회관", 36.951391, 127.907142],
  ["humanities-social", "인문사회관", 36.949704, 127.90887],
  ["haeoreum-dorm", "해오름학사", 36.948622, 127.912192],
  ["life-science", "생명과학관", 36.949182, 127.905889],
  ["natural-science", "자연과학관", 36.948959, 127.907003],
  ["creative-arts", "창의예술관", 36.948299, 127.907607],
  ["sanghuh-research", "상허연구동", 36.947892, 127.908547],
  ["medicine", "의학관", 36.950675, 127.907722],
  ["mosirae-dorm", "모시래학사", 36.951368, 127.90926],
  ["central-library", "중앙도서관", 36.948874, 127.908453],
  ["glocal-ieum", "글로컬이음관", 36.94838, 127.90936],
  ["etc", "기타", 36.9495, 127.90687],
];

export const MATCH_TEXT = "분실하신 물건과 비슷한 물건의 글이 작성되었습니다. 확인해 보세요.";
export const COMMENT_TEXT = "내 글에 새 댓글이 달렸습니다.";
export const REPLY_TEXT = "내 댓글에 답글이 달렸습니다.";

const PRESET_TAGS = ["스마트폰", "이어폰", "학생증", "지갑", "가방", "열쇠", "노트북"];

/** 사진 대용 SVG(데이터 URL). 외부 이미지·저작권 이슈 없이 카드/캐러셀 UI를 확인하기 위함. */
export function placeholderImage(label: string, color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><rect width="640" height="480" fill="${color}"/><text x="320" y="250" font-size="40" text-anchor="middle" fill="#ffffff" font-family="sans-serif">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 3600_000).toISOString();
}

export function createSeed(): MockDb {
  const locations: Location[] = CAMPUS_LOCATIONS.map(([buildingId, buildingName, lat, lng], i) => ({
    id: i + 1,
    buildingId,
    buildingName,
    floor: null,
    lat,
    lng,
  }));
  const tags: Tag[] = PRESET_TAGS.map((name, i) => ({
    id: i + 1,
    name,
    isPreset: true,
    isCategory: true,
  }));

  const photos: MockPhoto[] = [
    {
      photoId: 1,
      url: placeholderImage("검은 케이스", "#374151"),
      width: 640,
      height: 480,
      ownerId: 1,
      postId: 1,
    },
    {
      photoId: 2,
      url: placeholderImage("에어팟 케이스", "#1f2937"),
      width: 640,
      height: 480,
      ownerId: 2,
      postId: 2,
    },
    {
      photoId: 3,
      url: placeholderImage("학생증", "#2563eb"),
      width: 640,
      height: 480,
      ownerId: 2,
      postId: 3,
    },
  ];

  const base = {
    matchState: "DONE" as const,
    locationText: null,
    lat: null,
    lng: null,
    storagePlace: null,
    hiddenFeatures: null,
  };
  const posts: MockPost[] = [
    {
      ...base,
      id: 1,
      type: "LOST",
      title: "검은색 에어팟 케이스를 잃어버렸어요",
      description:
        "학생회관 근처에서 잃어버린 것 같아요. 검은색 실리콘 케이스이고 모서리에 약간 흠집이 있습니다.",
      status: "OPEN",
      occurredAt: hoursAgo(30),
      locationId: 1,
      photoIds: [1],
      tags: ["이어폰", "검정"],
      authorId: 1,
      createdAt: hoursAgo(29),
    },
    {
      ...base,
      id: 2,
      type: "FOUND",
      title: "검은 케이스 주웠습니다",
      description: "학생회관 2층 복도에서 검은색 케이스를 주웠어요. 제가 보관하고 있습니다.",
      status: "OPEN",
      occurredAt: hoursAgo(26),
      locationId: 1,
      photoIds: [2],
      tags: ["이어폰", "검정"],
      storagePlace: "습득자 본인 소지",
      hiddenFeatures: "안쪽에 스티커가 붙어 있음",
      authorId: 2,
      createdAt: hoursAgo(25),
    },
    {
      ...base,
      id: 3,
      type: "FOUND",
      title: "학생증을 주웠습니다",
      description:
        "중앙도서관 1층 열람실 앞에서 학생증을 주웠습니다. 개인정보 보호를 위해 사진은 가렸습니다.",
      status: "OPEN",
      occurredAt: hoursAgo(8),
      locationId: 10,
      photoIds: [3],
      tags: ["학생증"],
      storagePlace: "중앙도서관 안내데스크",
      authorId: 2,
      createdAt: hoursAgo(7),
    },
    {
      ...base,
      id: 4,
      type: "LOST",
      title: "회색 가방을 두고 왔어요",
      description: "자연과학관에서 회색 가방을 두고 왔어요. 안에 노트북 충전기도 들어 있습니다.",
      status: "OPEN",
      occurredAt: hoursAgo(5),
      locationId: 5,
      photoIds: [],
      tags: ["가방", "노트북"],
      authorId: 2,
      createdAt: hoursAgo(4),
    },
    {
      ...base,
      id: 5,
      type: "LOST",
      title: "열쇠고리 달린 기숙사 열쇠",
      description: "해오름학사 입구 근처에서 잃어버렸습니다.",
      status: "MATCHED",
      occurredAt: hoursAgo(60),
      locationId: 3,
      photoIds: [],
      tags: ["열쇠"],
      authorId: 1,
      createdAt: hoursAgo(59),
    },
    {
      ...base,
      id: 6,
      type: "FOUND",
      title: "파란색 지갑 습득",
      description: "체육관 입구 벤치에서 파란색 지갑을 발견했습니다.",
      status: "OPEN",
      occurredAt: hoursAgo(2),
      locationId: 12,
      locationText: "체육관 앞 벤치",
      photoIds: [],
      tags: ["지갑"],
      storagePlace: "체육관 관리실",
      authorId: 1,
      createdAt: hoursAgo(1),
    },
  ];

  return {
    users: [
      {
        id: 1,
        loginId: "demo_a",
        password: "demo1234",
        nickname: "데모A",
        createdAt: hoursAgo(500),
        settings: { notifyMatch: true, notifyComment: true, notifyMessage: true },
      },
      {
        id: 2,
        loginId: "demo_b",
        password: "demo1234",
        nickname: "데모B",
        createdAt: hoursAgo(400),
        settings: { notifyMatch: true, notifyComment: true, notifyMessage: true },
      },
    ],
    posts,
    photos,
    locations,
    tags,
    comments: [
      {
        id: 1,
        postId: 2,
        parentId: null,
        authorId: 1,
        body: "혹시 안쪽에 스티커가 붙어 있나요?",
        deleted: false,
        createdAt: hoursAgo(20),
        editedAt: null,
      },
      {
        id: 2,
        postId: 2,
        parentId: 1,
        authorId: 2,
        body: "쪽지로 알려 주세요.",
        deleted: false,
        createdAt: hoursAgo(19),
        editedAt: null,
      },
    ],
    notifications: [
      {
        id: 1,
        userId: 1,
        type: "MATCH",
        text: MATCH_TEXT,
        createdAt: hoursAgo(24),
        readAt: null,
        target: { kind: "match", id: 1, postId: 1 },
      },
      {
        id: 2,
        userId: 1,
        type: "REPLY",
        text: REPLY_TEXT,
        createdAt: hoursAgo(19),
        readAt: hoursAgo(10),
        target: { kind: "comment", id: 2, postId: 2 },
      },
    ],
    matches: [
      {
        id: 1,
        lostPostId: 1,
        foundPostId: 2,
        level: "AUTO",
        grade: "HIGH",
        locationDiff: "SAME_BUILDING",
        aiReason: "색상과 케이스 모양이 비슷하고 같은 건물에서 발견됐어요.",
        status: "PENDING",
      },
      {
        id: 2,
        lostPostId: 1,
        foundPostId: 3,
        level: "CANDIDATE",
        grade: "MID",
        locationDiff: "NEARBY",
        aiReason: "비슷한 시간대에 습득됐지만 물건 종류가 달라 보여요.",
        status: "PENDING",
      },
    ],
    reports: [],
    conversations: [
      {
        id: 1,
        members: [
          { userId: 1, lastReadId: 3, muted: false, left: false },
          { userId: 2, lastReadId: 4, muted: false, left: false },
        ],
        postContextId: 2,
        createdAt: hoursAgo(12),
      },
    ],
    messages: [
      {
        id: 1,
        conversationId: 1,
        senderId: 1,
        type: "TEXT",
        body: "안녕하세요, 올려주신 케이스가 제 것 같아요.",
        postId: 2,
        createdAt: hoursAgo(12),
      },
      {
        id: 2,
        conversationId: 1,
        senderId: 2,
        type: "VERIFY_QUESTION",
        body: "케이스 안쪽에 붙어 있는 것이 무엇인가요?",
        postId: null,
        createdAt: hoursAgo(11),
      },
      {
        id: 3,
        conversationId: 1,
        senderId: 1,
        type: "VERIFY_ANSWER",
        body: "작은 별 모양 스티커예요.",
        postId: null,
        createdAt: hoursAgo(10),
      },
      {
        id: 4,
        conversationId: 1,
        senderId: 2,
        type: "TEXT",
        body: "맞아요! 학생회관 안내데스크에서 전달해 드릴게요.",
        postId: null,
        createdAt: hoursAgo(1),
      },
    ],
    handovers: [],
    blocks: [],
    nextIds: {
      user: 3,
      post: 7,
      photo: 4,
      comment: 3,
      notification: 3,
      conversation: 2,
      message: 5,
      handover: 1,
    },
  };
}

/** 시드 상태로 되돌린다. clearSession=true 면 로그인 세션도 지운다(테스트용). */
export function resetDb(clearSession = false): void {
  setDb(createSeed());
  if (clearSession) setSessionUserId(null);
}
