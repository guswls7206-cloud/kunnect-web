// 백엔드 API 계약(docs/dev-plan-backend.md 5절) 기준 타입. 계약이 바뀌면 이 파일만 고친다.

export type PostType = "LOST" | "FOUND";
export type PostStatus = "OPEN" | "MATCHED" | "RETURNED" | "CLOSED";
export type MatchState = "PENDING" | "DONE" | "FAILED";

export type UploadedPhoto = PostPhoto;

export interface UserSummary {
  id: number;
  nickname: string;
}

export interface MeSettings {
  notifyMatch: boolean;
  notifyComment: boolean;
  notifyMessage: boolean;
}

export interface Me {
  id: number;
  loginId: string;
  nickname: string;
  settings: MeSettings;
  unread: { notifications: number; messages: number };
}

export interface Location {
  id: number;
  /** 같은 건물의 모든 층이 공유하는 식별자 */
  buildingId: string;
  buildingName: string;
  floor: number | null;
  lat: number;
  lng: number;
}

/** "기타" 위치의 buildingId(목록에 없는 장소 — 글에 locationText 를 직접 적는다) */
export const ETC_BUILDING_ID = "etc";

/** 기타 위치의 직접 입력 장소 최대 길이(백엔드 계약) */
export const LOCATION_TEXT_MAX = 50;

export interface Tag {
  id: number;
  name: string;
  isPreset: boolean;
  isCategory: boolean;
}

export interface PostCardData {
  id: number;
  type: PostType;
  title: string;
  status: PostStatus;
  thumbnailUrl: string | null;
  /** 건물 이름(층이 있으면 "건물 N층"). 기타면 "기타" — 화면은 locationText 와 함께 formatLocation 으로 표시 */
  locationName: string;
  /** 기타 위치일 때 작성자가 직접 입력한 장소. 기타가 아니면 null */
  locationText: string | null;
  occurredAt: string;
  /** 태그 이름 목록(계약상 `tags[]` — 이름 문자열로 가정) */
  tags: string[];
  author: UserSummary;
  createdAt: string;
}

export interface PostPhoto {
  photoId: number;
  url: string;
  width: number;
  height: number;
}

/** GET /posts/{id}, POST /posts(`{post}`), PATCH, status 응답이 모두 이 형태(평탄) */
export interface PostDetail {
  id: number;
  type: PostType;
  title: string;
  description: string;
  status: PostStatus;
  matchState: MatchState;
  occurredAt: string;
  location: Location;
  /** 기타 위치(location.buildingId === "etc")일 때 직접 입력한 장소. 기타가 아니면 null */
  locationText: string | null;
  lat: number | null;
  lng: number | null;
  storagePlace: string | null;
  /** 작성자 본인에게만 내려온다 */
  hiddenFeatures: string | null;
  photos: PostPhoto[];
  tags: string[];
  author: UserSummary;
  commentCount: number;
  isMine: boolean;
  createdAt: string;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PostListQuery {
  type?: PostType;
  status?: PostStatus;
  locationId?: number;
  /** 건물 전체(모든 층) */
  buildingId?: string;
  tag?: string;
  q?: string;
  limit?: number;
}

export interface CreatePostInput {
  type: PostType;
  title: string;
  description: string;
  locationId: number;
  /** 기타 위치일 때만(1~50자). 기타가 아니면 보내지 않는다 */
  locationText?: string;
  lat?: number;
  lng?: number;
  occurredAt: string;
  tags: string[];
  storagePlace?: string;
  hiddenFeatures?: string;
  photoIds: number[];
}

export interface UpdatePostInput {
  title?: string;
  /** 기타 위치 글만 수정 가능 */
  locationText?: string;
  description?: string;
  tags?: string[];
  storagePlace?: string;
  hiddenFeatures?: string;
}

export interface UnreadCount {
  notifications: number;
  messages: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; fields?: Record<string, string> };
}

export interface Comment {
  id: number;
  postId: number;
  parentId: number | null;
  author: UserSummary;
  /** 삭제된 댓글(답글이 있어 자리만 유지)이면 null */
  body: string | null;
  status: "VISIBLE" | "DELETED";
  createdAt: string;
  editedAt: string | null;
  isMine: boolean;
  replies: Comment[];
}

export type NotificationType = "MATCH" | "COMMENT" | "REPLY" | "MESSAGE";

export interface NotificationItem {
  id: number;
  type: NotificationType;
  /** 서버가 만든 문구(물건·위치 비포함). 그대로 보여준다. */
  text: string;
  createdAt: string;
  readAt: string | null;
  target: { kind: "match" | "comment" | "conversation"; id: number; postId: number | null };
}

export interface MatchItem {
  matchId: number;
  level: "AUTO" | "CANDIDATE";
  grade: "HIGH" | "MID";
  otherPost: PostCardData;
  locationDiff: "SAME_PLACE" | "SAME_BUILDING" | "NEARBY" | "FAR";
  aiReason: string | null;
  status: "PENDING" | "CONFIRMED" | "REJECTED";
}

export type ReportReason = "SPAM" | "HARASSMENT" | "PRIVACY" | "FAKE" | "OTHER";
export type ReportTargetType = "POST" | "COMMENT" | "MESSAGE" | "USER";

export type MessageType = "TEXT" | "SYSTEM" | "VERIFY_QUESTION" | "VERIFY_ANSWER";

export interface Message {
  id: number;
  conversationId: number;
  senderId: number;
  type: MessageType;
  body: string;
  postId: number | null;
  createdAt: string;
}

export interface Handover {
  id: number;
  conversationId: number;
  postId: number;
  matchId: number | null;
  status: "REQUESTED" | "VERIFIED" | "COMPLETED" | "REJECTED";
}

export interface ConversationItem {
  id: number;
  other: UserSummary;
  lastMessage: { createdAt: string; type: string } | null;
  unread: number;
  muted: boolean;
  /** 차단·종료 등으로 새 메시지를 보낼 수 없음(차단 사실은 드러내지 않는다) */
  readOnly: boolean;
  postContext: { id: number; title: string } | null;
  /**
   * [제안] 현재 인수 상태. 계약(openapi)에는 아직 없어 백엔드에 요청 중 —
   * 없으면 null 로 보고 "인수 요청" 버튼만 보여준다.
   */
  handover?: Handover | null;
}

export interface ConversationStart {
  conversation: ConversationItem;
  message: Message;
}

export interface BlockItem {
  userId: number;
  nickname: string;
  createdAt: string;
}
