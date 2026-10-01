import { inArray, sql } from 'drizzle-orm';
import { schema } from '../db/client.js';
import { conflict } from './errors.js';
import type { PhotoStorage } from '../storage/index.js';
import type { Executor } from '../modules/posts/service.js';

/**
 * 글 영구 삭제(hard delete) 공용 헬퍼 [사용자 결정: 종료 24시간 후 자동 삭제, 탈퇴 시 즉시 삭제].
 *
 * DB 에서 글 행을 지우면 FK cascade 로 사진 행·댓글·태그 연결·매칭·인수 요청·글에 걸린 알림이 함께 삭제된다.
 * - 쪽지 메시지는 남기고 `messages.post_id` 만 null 이 된다(FK ON DELETE SET NULL → 대화 내용은 보존, 글 맥락만 사라짐).
 * - 신고(`reports`)는 FK 가 없어 snapshot 이 그대로 보존된다.
 * - 사진 파일(원본/AI 사본/흐림 사본)은 DB 트랜잭션 **커밋 이후** `deleteFiles` 로 지운다. 실패해도 정리 작업의 고아 파일 정리가 회수한다.
 *
 * 잠금 순서(교착 방지, 인수 처리와 동일): 대화 → 인수 요청 → 글. 이 함수는 글과 연관된 대화·인수 요청을 id 순으로 먼저 잠근 뒤 글을 잠근다.
 * 호출 측이 이미 일부 대화를 잠갔다면(예: DELETE /me) 같은 순서를 지키므로 충돌하지 않는다.
 * 멱등: 이미 없는 id 는 무시하고, 같은 id 를 다시 호출해도 안전하다. 많은 id 는 청크로 나눠 처리한다(배치 안전).
 */
export interface DeletedFileKeys {
  /** 삭제된 글 id (실제로 존재했던 것만) */
  postIds: number[];
  /** 커밋 후 지워야 할 파일 키(원본·AI 사본·흐림 사본) */
  fileKeys: string[];
}

const CHUNK = 500;

export interface HardDeleteOptions {
  /** true 면 진행 중인 인수 요청(REQUESTED/VERIFIED)이 걸린 글이 하나라도 있을 때 409 ACTIVE_HANDOVER (사용자 직접 삭제용). 기본 false */
  rejectIfActiveHandover?: boolean;
}

export async function hardDeletePosts(tx: Executor, postIds: number[], opts: HardDeleteOptions = {}): Promise<DeletedFileKeys> {
  const result: DeletedFileKeys = { postIds: [], fileKeys: [] };
  const ids = [...new Set(postIds)].filter((n) => Number.isInteger(n) && n > 0).sort((a, b) => a - b);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    // 1) 대화 → 2) 인수 요청 → 3) 글 순으로 잠근다
    await tx.execute(sql`
      select c.id from conversations c
       where c.id in (select conversation_id from handover_requests where post_id in (${sql.join(chunk.map((n) => sql`${n}`), sql`, `)}))
       order by c.id for update`);
    const handovers = await tx.execute<{ id: number; status: string }>(sql`select id, status from handover_requests where post_id in (${sql.join(chunk.map((n) => sql`${n}`), sql`, `)}) order by id for update`);
    if (opts.rejectIfActiveHandover && handovers.rows.some((h) => h.status === 'REQUESTED' || h.status === 'VERIFIED')) {
      throw conflict('ACTIVE_HANDOVER', '진행 중인 인수 요청이 있어 글을 삭제할 수 없습니다. 먼저 인수를 완료하거나 거절해 주세요.');
    }
    const existing = await tx.execute<{ id: number }>(sql`select id from posts where id in (${sql.join(chunk.map((n) => sql`${n}`), sql`, `)}) order by id for update`);
    const present = existing.rows.map((r) => r.id);
    if (!present.length) continue;
    const photos = await tx
      .select({ key: schema.postPhotos.storageKey, aiKey: schema.postPhotos.aiKey, blurredKey: schema.postPhotos.blurredKey })
      .from(schema.postPhotos)
      .where(inArray(schema.postPhotos.postId, present));
    for (const p of photos) {
      result.fileKeys.push(p.key);
      if (p.aiKey) result.fileKeys.push(p.aiKey);
      if (p.blurredKey) result.fileKeys.push(p.blurredKey);
    }
    await tx.delete(schema.posts).where(inArray(schema.posts.id, present));
    result.postIds.push(...present);
  }
  return result;
}

/** 커밋 후 파일 삭제(최선 노력). 지우지 못한 키 목록을 돌려준다(고아 파일 정리가 회수). */
export async function deleteFiles(storage: PhotoStorage, keys: string[]): Promise<string[]> {
  const failed: string[] = [];
  for (const k of new Set(keys)) {
    try {
      await storage.delete(k);
    } catch {
      failed.push(k);
    }
  }
  return failed;
}
