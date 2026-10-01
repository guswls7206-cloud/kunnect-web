import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { schema } from '../../db/client.js';
import { isBlockedEither } from '../../lib/blocks.js';
import { notFound } from '../../lib/errors.js';
import { originalAccessPosts } from '../../lib/photo-privacy.js';
import { me, requireAuth } from '../auth/plugin.js';

// 영숫자·-·_ 만 허용(경로 문자·점 금지). 실제 제공 여부는 DB 에 등록된 키인지로 결정한다(시연 시드는 demo-N.jpg 이름 사용)
const nameParam = z.object({ name: z.string().regex(/^[A-Za-z0-9_-]{1,64}[.]jpg$/) });

/**
 * 사진 파일 제공(로그인 필요). 저장소의 모든 파일을 노출하지 않고 DB 에 등록된 사진만 제공한다:
 * - /files/photos/<name>: 원본. 임시(글에 연결 전) 사진은 작성자만, 연결된 사진은 글을 볼 수 있는 사용자만(차단·종료·탈퇴 글 제외).
 *   민감 사진의 원본은 작성자와 소유 확인(VERIFIED) 이후 인수 상대에게만 — 그 외에는 404(흐림 사본 URL 을 API 가 따로 내려준다).
 * - /files/blurred/<name>: 민감 사진의 흐림 사본(글을 볼 수 있는 사용자에게 제공).
 * - ai/ 등 내부 파일은 제공하지 않는다(AI 전송용 원본 축소본 보호).
 */
export async function fileRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, storage } = ctx;

  async function postVisibleTo(viewerId: number, postId: number): Promise<{ authorId: number } | null> {
    const [row] = await db
      .select({ authorId: schema.posts.authorId, status: schema.posts.status, authorStatus: schema.users.status })
      .from(schema.posts)
      .innerJoin(schema.users, eq(schema.users.id, schema.posts.authorId))
      .where(eq(schema.posts.id, postId))
      .limit(1);
    if (!row) return null;
    if (row.authorId === viewerId) return { authorId: row.authorId };
    if (row.status === 'CLOSED' || row.authorStatus === 'DELETED') return null;
    if (await isBlockedEither(db, viewerId, row.authorId)) return null;
    return { authorId: row.authorId };
  }

  const send = async (reply: import('fastify').FastifyReply, key: string) => {
    const buf = await storage.read(key).catch(() => null);
    if (!buf) throw notFound('파일을 찾을 수 없습니다.');
    return reply.type('image/jpeg').header('Cache-Control', 'private, max-age=86400').send(buf);
  };

  app.get('/files/photos/:name', { preHandler: requireAuth }, async (req, reply) => {
    const { name } = nameParam.parse(req.params);
    const viewer = me(req).id;
    const [photo] = await db.select().from(schema.postPhotos).where(eq(schema.postPhotos.storageKey, `photos/${name}`)).limit(1);
    if (!photo) throw notFound('파일을 찾을 수 없습니다.');
    if (photo.ownerId === viewer) return send(reply, photo.storageKey);
    if (photo.postId === null) throw notFound('파일을 찾을 수 없습니다.'); // 임시 사진은 작성자만
    const post = await postVisibleTo(viewer, photo.postId);
    if (!post) throw notFound('파일을 찾을 수 없습니다.');
    if (photo.sensitive) {
      const access = await originalAccessPosts(db, viewer, new Map([[photo.postId, post.authorId]]));
      if (!access.has(photo.postId)) throw notFound('파일을 찾을 수 없습니다.');
    }
    return send(reply, photo.storageKey);
  });

  app.get('/files/blurred/:name', { preHandler: requireAuth }, async (req, reply) => {
    const { name } = nameParam.parse(req.params);
    const viewer = me(req).id;
    const [photo] = await db.select().from(schema.postPhotos).where(eq(schema.postPhotos.blurredKey, `blurred/${name}`)).limit(1);
    if (!photo) throw notFound('파일을 찾을 수 없습니다.');
    if (photo.ownerId !== viewer) {
      if (photo.postId === null || !(await postVisibleTo(viewer, photo.postId))) throw notFound('파일을 찾을 수 없습니다.');
    }
    return send(reply, `blurred/${name}`);
  });
}
