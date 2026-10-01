import type { Db } from '../db/client.js';
import { deleteFiles, hardDeletePosts } from '../lib/hard-delete.js';
import { retryOnConflict } from '../modules/handovers/service.js';
import type { Executor } from '../modules/posts/service.js';
import type { PhotoStorage } from '../storage/index.js';

/** 글 id 목록을 완전히 삭제한다(사진 파일 포함). 테스트에서 대체할 수 있도록 교체 지점으로 둔다. */
export type PostDeleter = (db: Db, storage: PhotoStorage, postIds: number[]) => Promise<void>;

/**
 * 기본 삭제 = 공용 hardDeletePosts(글 영구 삭제 헬퍼, 별도 구현 없음):
 * 한 트랜잭션에서 대화 → 인수 → 글 순으로 잠그고 삭제(사진 행·댓글·매칭·인수 요청·알림은 cascade, 쪽지 메시지는 post_id 만 null),
 * 교착·직렬화 실패는 재시도하며, 사진 파일(원본·AI 사본·흐림 사본)은 **커밋 이후** 지운다.
 * 파일 삭제 실패는 고아 파일 정리가 회수하므로 삭제를 되돌리지 않는다.
 */
export const defaultDeletePosts: PostDeleter = async (db, storage, ids) => {
  const res = await retryOnConflict(() => db.transaction(async (tx) => hardDeletePosts(tx as unknown as Executor, ids)));
  await deleteFiles(storage, res.fileKeys);
};
