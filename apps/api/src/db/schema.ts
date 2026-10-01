import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

const id = () => integer().primaryKey().generatedAlwaysAsIdentity();
const createdAt = () => timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const users = pgTable(
  'users',
  {
    id: id(),
    loginId: text('login_id').notNull(),
    passwordHash: text('password_hash').notNull(),
    nickname: text().notNull(),
    nicknameLower: text('nickname_lower').notNull(),
    notifyMatch: boolean('notify_match').notNull().default(true),
    notifyComment: boolean('notify_comment').notNull().default(true),
    notifyMessage: boolean('notify_message').notNull().default(true),
    status: text().notNull().default('ACTIVE'), // ACTIVE | DELETED
    createdAt: createdAt(),
  },
  (t) => [
    check('users_status_ck', sql`${t.status} in ('ACTIVE', 'DELETED')`),uniqueIndex('users_login_id_uq').on(t.loginId), uniqueIndex('users_nickname_lower_uq').on(t.nicknameLower)],
);

/** 세션 토큰은 SHA-256 해시만 저장한다. */
export const sessions = pgTable(
  'sessions',
  {
    id: text().primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    userAgent: text('user_agent'),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
);

/** 캠퍼스 위치. 건물 단위 행(floor 는 현재 시드에서 null). 시드는 seed-data.ts 의 CAMPUS_LOCATIONS. is_dummy=true 는 예전 임시 더미(목록·새 글에서 숨김). */
export const locations = pgTable(
  'locations',
  {
    id: id(),
    buildingKey: text('building_key').notNull(),
    buildingName: text('building_name').notNull(),
    floor: integer(),
    lat: doublePrecision().notNull(),
    lng: doublePrecision().notNull(),
    groupId: text('group_id'),
    isDummy: boolean('is_dummy').notNull().default(false),
  },
  (t) => [index('locations_building_idx').on(t.buildingKey)],
);

/** slug: 프리셋 태그의 영문 식별자(매칭 엔진 PostInput.presetTags). 사용자 정의 태그는 null. */
export const tags = pgTable(
  'tags',
  {
    id: id(),
    name: text().notNull(),
    slug: text(),
    isPreset: boolean('is_preset').notNull().default(false),
    isCategory: boolean('is_category').notNull().default(false),
  },
  (t) => [uniqueIndex('tags_name_uq').on(t.name), uniqueIndex('tags_slug_uq').on(t.slug)],
);

export const posts = pgTable(
  'posts',
  {
    id: id(),
    type: text().notNull(), // LOST | FOUND
    authorId: integer('author_id')
      .notNull()
      .references(() => users.id),
    title: text().notNull(),
    description: text().notNull(),
    status: text().notNull().default('OPEN'), // OPEN | MATCHED | RETURNED | CLOSED
    matchState: text('match_state').notNull().default('PENDING'), // PENDING | DONE | FAILED
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' }).notNull(),
    locationId: integer('location_id')
      .notNull()
      .references(() => locations.id),
    lat: doublePrecision(),
    lng: doublePrecision(),
    storagePlace: text('storage_place'),
    hiddenFeatures: text('hidden_features'),
    /** 위치가 "기타"(buildingKey=etc)일 때만 쓰는 자유 입력 장소(1~50자). 그 외 위치는 null */
    locationText: text('location_text'),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (t) => [
    check('posts_match_state_ck', sql`${t.matchState} in ('PENDING', 'DONE', 'FAILED')`),
    check('posts_status_ck', sql`${t.status} in ('OPEN', 'MATCHED', 'RETURNED', 'CLOSED')`),
    check('posts_type_ck', sql`${t.type} in ('LOST', 'FOUND')`),
    index('posts_list_idx').on(t.type, t.status, t.id),
    // 글 검색(ILIKE '%q%')용 trigram GIN 인덱스 — pg_trgm 확장 필요(마이그레이션 0005 에서 생성)
    index('posts_title_trgm_idx').using('gin', sql`${t.title} gin_trgm_ops`),
    index('posts_description_trgm_idx').using('gin', sql`${t.description} gin_trgm_ops`),
    index('posts_author_idx').on(t.authorId),
    index('posts_location_idx').on(t.locationId),
    index('posts_occurred_idx').on(t.occurredAt),
    index('posts_closed_idx').on(t.closedAt),
  ],
);

/** postId가 null이면 글에 연결되기 전의 임시 사진(24시간 후 정리). */
export const postPhotos = pgTable(
  'post_photos',
  {
    id: id(),
    postId: integer('post_id').references(() => posts.id, { onDelete: 'cascade' }),
    ownerId: integer('owner_id')
      .notNull()
      .references(() => users.id),
    storageKey: text('storage_key').notNull(),
    url: text().notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    /** AI 전송용 축소 사본(긴 변 1024px JPEG)의 저장 키. 첫 매칭 때 한 번 만들어 재사용한다. */
    aiKey: text('ai_key'),
    aiAttributes: jsonb('ai_attributes'),
    /** 민감 사진 [가정/제안]: 유효 플래그(작성자 지정 > AI 감지/민감 태그). true 면 작성자 외에는 blurred 사본만 볼 수 있다 */
    sensitive: boolean().notNull().default(false),
    sensitiveAi: boolean('sensitive_ai').notNull().default(false),
    sensitiveTag: boolean('sensitive_tag').notNull().default(false),
    /** 작성자 지정: MARK(민감함) | UNMARK(민감하지 않음) | null(자동) */
    sensitiveOverride: text('sensitive_override'),
    sensitiveKinds: jsonb('sensitive_kinds'),
    /** 흐림 처리된 표시용 사본의 저장 키(blurred/...) */
    blurredKey: text('blurred_key'),
    aiStatus: text('ai_status').notNull().default('NONE'), // NONE | PENDING | DONE | FAILED
    order: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    check('post_photos_override_ck', sql`${t.sensitiveOverride} is null or ${t.sensitiveOverride} in ('MARK', 'UNMARK')`),
    check('post_photos_ai_status_ck', sql`${t.aiStatus} in ('NONE', 'PENDING', 'DONE', 'FAILED')`),index('post_photos_post_idx').on(t.postId), index('post_photos_owner_idx').on(t.ownerId)],
);

export const postTags = pgTable(
  'post_tags',
  {
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id),
  },
  (t) => [primaryKey({ columns: [t.postId, t.tagId] }), index('post_tags_tag_idx').on(t.tagId)],
);

export const matches = pgTable(
  'matches',
  {
    id: id(),
    lostPostId: integer('lost_post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    foundPostId: integer('found_post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    photoScore: doublePrecision('photo_score'),
    locationScore: doublePrecision('location_score').notNull(),
    tagScore: doublePrecision('tag_score').notNull(),
    totalScore: doublePrecision('total_score').notNull(),
    level: text().notNull(), // AUTO | CANDIDATE
    mode: text(), // WITH_PHOTO | NO_PHOTO
    degraded: boolean().notNull().default(false),
    aiReason: text('ai_reason'),
    status: text().notNull().default('PENDING'), // PENDING | CONFIRMED | REJECTED
    notifiedAt: timestamp('notified_at', { withTimezone: true, mode: 'date' }), // 알림 1회 발송 보장
    createdAt: createdAt(),
  },
  (t) => [
    check('matches_status_ck', sql`${t.status} in ('PENDING', 'CONFIRMED', 'REJECTED')`),
    check('matches_level_ck', sql`${t.level} in ('AUTO', 'CANDIDATE')`),
    uniqueIndex('matches_pair_uq').on(t.lostPostId, t.foundPostId),
    index('matches_lost_idx').on(t.lostPostId, t.totalScore),
    index('matches_found_idx').on(t.foundPostId),
  ],
);

export const comments = pgTable(
  'comments',
  {
    id: id(),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    authorId: integer('author_id')
      .notNull()
      .references(() => users.id),
    parentId: integer('parent_id'),
    body: text().notNull(),
    status: text().notNull().default('VISIBLE'), // VISIBLE | HIDDEN | DELETED
    createdAt: createdAt(),
    editedAt: timestamp('edited_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    check('comments_status_ck', sql`${t.status} in ('VISIBLE', 'HIDDEN', 'DELETED')`),index('comments_post_idx').on(t.postId, t.id), index('comments_parent_idx').on(t.parentId), index('comments_author_idx').on(t.authorId)],
);

export const conversations = pgTable(
  'conversations',
  {
    id: id(),
    userAId: integer('user_a_id')
      .notNull()
      .references(() => users.id),
    userBId: integer('user_b_id')
      .notNull()
      .references(() => users.id),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('conversations_pair_uq').on(t.userAId, t.userBId)],
);

export const conversationMembers = pgTable(
  'conversation_members',
  {
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id),
    lastReadMessageId: integer('last_read_message_id').notNull().default(0),
    muted: boolean().notNull().default(false),
    leftAt: timestamp('left_at', { withTimezone: true, mode: 'date' }),
    /** 쪽지함에서 삭제한 시각(사용자별 삭제, [가정/제안 A31]). 삭제 시점까지의 메시지(id <= cleared_message_id)는 이 사용자에게 숨긴다 */
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
    clearedMessageId: integer('cleared_message_id').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.conversationId, t.userId] }), index('conv_members_user_idx').on(t.userId)],
);

export const messages = pgTable(
  'messages',
  {
    id: id(),
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderId: integer('sender_id')
      .notNull()
      .references(() => users.id),
    postId: integer('post_id').references(() => posts.id, { onDelete: 'set null' }),
    type: text().notNull().default('TEXT'), // TEXT | SYSTEM | VERIFY_QUESTION | VERIFY_ANSWER
    body: text().notNull(),
    createdAt: createdAt(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    check('messages_type_ck', sql`${t.type} in ('TEXT', 'SYSTEM', 'VERIFY_QUESTION', 'VERIFY_ANSWER')`),
    index('messages_post_idx').on(t.postId),
    index('messages_conv_idx').on(t.conversationId, t.id),
  ],
);

export const handoverRequests = pgTable(
  'handover_requests',
  {
    id: id(),
    matchId: integer('match_id').references(() => matches.id, { onDelete: 'set null' }),
    postId: integer('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    conversationId: integer('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    requesterId: integer('requester_id')
      .notNull()
      .references(() => users.id),
    status: text().notNull().default('REQUESTED'), // REQUESTED | VERIFIED | COMPLETED | REJECTED
    verificationNote: text('verification_note'),
    lostSideConfirmedAt: timestamp('lost_side_confirmed_at', { withTimezone: true, mode: 'date' }),
    foundSideConfirmedAt: timestamp('found_side_confirmed_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    // DB 수준 보장: 대화당 진행 중(REQUESTED/VERIFIED) 인수 요청은 1개
    index('handover_post_idx').on(t.postId),
    uniqueIndex('handover_active_conv_uq').on(t.conversationId).where(sql`${t.status} in ('REQUESTED', 'VERIFIED')`),
    check('handover_status_ck', sql`${t.status} in ('REQUESTED', 'VERIFIED', 'COMPLETED', 'REJECTED')`),index('handover_conv_idx').on(t.conversationId), index('handover_match_idx').on(t.matchId)],
);

export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text().notNull(), // MATCH | COMMENT | REPLY | MESSAGE
    matchId: integer('match_id').references(() => matches.id, { onDelete: 'cascade' }),
    commentId: integer('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
    conversationId: integer('conversation_id').references(() => conversations.id, { onDelete: 'cascade' }),
    postId: integer('post_id').references(() => posts.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    check('notifications_type_ck', sql`${t.type} in ('MATCH', 'COMMENT', 'REPLY', 'MESSAGE')`),
    // FK 컬럼 인덱스(삭제 cascade·조회 성능)
    index('notifications_post_idx').on(t.postId),
    index('notifications_match_idx').on(t.matchId),
    index('notifications_comment_idx').on(t.commentId),
    index('notifications_conversation_idx').on(t.conversationId),
    index('notifications_user_idx').on(t.userId, t.id),
    index('notifications_unread_idx').on(t.userId, t.readAt),
  ],
);

export const blocks = pgTable(
  'blocks',
  {
    blockerId: integer('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: integer('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] }), index('blocks_blocked_idx').on(t.blockedId)],
);

export const reports = pgTable(
  'reports',
  {
    id: id(),
    reporterId: integer('reporter_id')
      .notNull()
      .references(() => users.id),
    targetType: text('target_type').notNull(), // POST | COMMENT | MESSAGE | USER
    targetId: integer('target_id').notNull(),
    targetUserId: integer('target_user_id'),
    reason: text().notNull(),
    detail: text(),
    snapshot: jsonb().notNull(),
    status: text().notNull().default('NEW'),
    createdAt: createdAt(),
  },
  (t) => [
    check('reports_target_type_ck', sql`${t.targetType} in ('POST', 'COMMENT', 'MESSAGE', 'USER')`),
    index('reports_target_idx').on(t.targetType, t.targetId),
    uniqueIndex('reports_once_uq').on(t.reporterId, t.targetType, t.targetId),
  ],
);

/** 프로세스 내 작업 큐(Redis 없음). 매칭 엔진 호출 등. */
export const jobs = pgTable(
  'jobs',
  {
    id: id(),
    type: text().notNull(), // MATCH_POST
    payload: jsonb().notNull(),
    status: text().notNull().default('QUEUED'), // QUEUED | RUNNING | DONE | FAILED
    attempts: integer().notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    runAfter: timestamp('run_after', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [
    check('jobs_type_ck', sql`${t.type} in ('MATCH_POST')`),
    check('jobs_status_ck', sql`${t.status} in ('QUEUED', 'RUNNING', 'DONE', 'FAILED')`),
    index('jobs_status_idx').on(t.status, t.runAfter),
    // 대기 작업 선점 쿼리(status='QUEUED' order by id)용 부분 인덱스
    index('jobs_queued_idx').on(t.id).where(sql`${t.status} = 'QUEUED'`),
  ],
);

/** 레이트 리밋·로그인 실패 카운터(프로세스 재시작·다중 인스턴스에서도 유지). 만료 행은 정리 작업이 삭제한다. */
export const rateCounters = pgTable(
  'rate_counters',
  {
    key: text().primaryKey(),
    count: integer().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [index('rate_counters_expires_idx').on(t.expiresAt)],
);

/** AI(Claude) 일일 호출 상한 카운터. day 는 KST 'YYYY-MM-DD'. */
export const aiCallCounters = pgTable('ai_call_counters', {
  day: text().primaryKey(),
  n: integer().notNull(),
});
