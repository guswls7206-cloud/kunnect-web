// 목(mock) 인메모리 DB. 새로고침하면 시드 상태로 돌아간다(로그인 세션만 sessionStorage에 유지).
import type {
  Location,
  MatchItem,
  NotificationItem,
  NotificationType,
  PostDetail,
  PostPhoto,
  PostType,
  Tag,
} from "@/lib/api/types";

export interface MockUser {
  id: number;
  loginId: string;
  password: string;
  nickname: string;
  createdAt: string;
  settings: { notifyMatch: boolean; notifyComment: boolean; notifyMessage: boolean };
}

export interface MockPost {
  id: number;
  type: PostType;
  title: string;
  description: string;
  status: PostDetail["status"];
  matchState: PostDetail["matchState"];
  occurredAt: string;
  locationId: number;
  /** 기타 위치일 때 직접 입력한 장소 */
  locationText: string | null;
  lat: number | null;
  lng: number | null;
  storagePlace: string | null;
  hiddenFeatures: string | null;
  photoIds: number[];
  tags: string[];
  authorId: number;
  createdAt: string;
}

export interface MockPhoto extends PostPhoto {
  ownerId: number;
  postId: number | null;
}

export interface MockComment {
  id: number;
  postId: number;
  parentId: number | null;
  authorId: number;
  body: string;
  deleted: boolean;
  createdAt: string;
  editedAt: string | null;
}

export interface MockNotification {
  id: number;
  userId: number;
  type: NotificationType;
  text: string;
  createdAt: string;
  readAt: string | null;
  target: NotificationItem["target"];
}

export interface MockMatch {
  id: number;
  lostPostId: number;
  foundPostId: number;
  level: MatchItem["level"];
  grade: MatchItem["grade"];
  locationDiff: MatchItem["locationDiff"];
  aiReason: string | null;
  status: MatchItem["status"];
}

export interface MockMember {
  userId: number;
  lastReadId: number;
  muted: boolean;
  left: boolean;
}

export interface MockConversation {
  id: number;
  members: [MockMember, MockMember];
  postContextId: number | null;
  createdAt: string;
}

export interface MockMessage {
  id: number;
  conversationId: number;
  senderId: number;
  type: "TEXT" | "SYSTEM" | "VERIFY_QUESTION" | "VERIFY_ANSWER";
  body: string;
  postId: number | null;
  createdAt: string;
}

export interface MockHandover {
  id: number;
  conversationId: number;
  postId: number;
  matchId: number | null;
  status: "REQUESTED" | "VERIFIED" | "COMPLETED" | "REJECTED";
  /** 완료를 확인한 사용자 id 들 */
  completedBy: number[];
}

export interface MockDb {
  conversations: MockConversation[];
  messages: MockMessage[];
  handovers: MockHandover[];
  blocks: Array<{ blockerId: number; blockedId: number; createdAt: string }>;
  comments: MockComment[];
  notifications: MockNotification[];
  matches: MockMatch[];
  reports: Array<{ reporterId: number; targetType: string; targetId: number }>;
  users: MockUser[];
  posts: MockPost[];
  photos: MockPhoto[];
  locations: Location[];
  tags: Tag[];
  nextIds: {
    user: number;
    post: number;
    photo: number;
    comment: number;
    notification: number;
    conversation: number;
    message: number;
    handover: number;
  };
}

const SESSION_KEY = "kunnect-mock-session";
let memorySession: number | null = null;

export function getSessionUserId(): number | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    return raw ? Number(raw) : null;
  } catch {
    return memorySession;
  }
}

export function setSessionUserId(id: number | null): void {
  memorySession = id;
  try {
    if (id === null) sessionStorage.removeItem(SESSION_KEY);
    else sessionStorage.setItem(SESSION_KEY, String(id));
  } catch {
    // sessionStorage 사용 불가(테스트·사생활 보호 모드) → 메모리 값만 사용
  }
}

// 개발 모드(HMR·청크 분리)에서 이 모듈이 두 번 평가돼도 같은 DB를 쓰도록 globalThis 에 보관한다.
const globalStore = globalThis as unknown as { __kunnectMockDb?: MockDb };

export function getDb(): MockDb {
  if (!globalStore.__kunnectMockDb)
    throw new Error("mock DB가 초기화되지 않았습니다. resetDb()를 먼저 호출하세요.");
  return globalStore.__kunnectMockDb;
}

export function setDb(next: MockDb): void {
  globalStore.__kunnectMockDb = next;
}
