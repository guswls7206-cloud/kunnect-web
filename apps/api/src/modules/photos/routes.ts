import { randomBytes } from 'node:crypto';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { schema } from '../../db/client.js';
import { AppError, notFound } from '../../lib/errors.js';
import { idParam } from '../../lib/pagination.js';
import { applySensitivity } from '../../lib/photo-privacy.js';
import { me, requireAuth } from '../auth/plugin.js';

const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);
const MAX_LONG_EDGE = 1600;
const MAX_PENDING_PER_USER = 20;
const MAX_PIXELS = 40_000_000; // 디컴프레션 폭탄 방지(약 40MP)

/** 업로드 이미지를 검증하고 EXIF(GPS 포함)를 제거한 JPEG 로 재인코딩한다. */
async function processImage(input: Buffer) {
  let meta;
  try {
    meta = await sharp(input, { failOn: 'error', limitInputPixels: MAX_PIXELS }).metadata();
  } catch {
    throw new AppError(422, 'CORRUPT_IMAGE', '이미지를 읽을 수 없습니다.');
  }
  if (!meta.format || !ALLOWED_FORMATS.has(meta.format)) {
    throw new AppError(415, 'UNSUPPORTED_TYPE', 'JPEG, PNG, WebP 이미지만 업로드할 수 있습니다.');
  }
  try {
    // rotate(): EXIF 방향을 픽셀에 반영한 뒤 메타데이터는 기본 동작대로 모두 제거된다
    const { data, info } = await sharp(input, { failOn: 'error', limitInputPixels: MAX_PIXELS })
      .rotate()
      .resize({ width: MAX_LONG_EDGE, height: MAX_LONG_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82 }) // mozjpeg 는 느려(큰 사진 수백 ms~초) 끄고 기본 인코더 사용(파일은 약 16~45% 커짐)
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    throw new AppError(422, 'CORRUPT_IMAGE', '이미지를 처리할 수 없습니다.');
  }
}

export async function photoRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db, storage } = ctx;

  /**
   * 민감 사진 표시 변경(작성자만). sensitive: true(민감함) | false(민감하지 않음) | null(자동 판단으로 되돌림).
   * 민감이 되면 흐림 사본을 만들어 작성자 외에는 그 사본만 제공한다. 응답은 작성자 관점의 사진 정보.
   */
  app.patch('/photos/:id', { preHandler: requireAuth, config: ctx.rl(60, 3600_000) }, async (req) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ sensitive: z.boolean().nullable() }).parse(req.body);
    const user = me(req);
    const [p] = await db.select().from(schema.postPhotos).where(and(eq(schema.postPhotos.id, id), eq(schema.postPhotos.ownerId, user.id))).limit(1);
    if (!p) throw notFound('사진을 찾을 수 없습니다.');
    await db.update(schema.postPhotos).set({ sensitiveOverride: body.sensitive === null ? null : body.sensitive ? 'MARK' : 'UNMARK' }).where(eq(schema.postPhotos.id, id));
    const after = (await applySensitivity({ db, storage }, id))!;
    return { photoId: after.id, url: after.url, width: after.width, height: after.height, isBlurred: false, sensitive: after.sensitive, hasBlurredCopy: !!after.blurredKey };
  });

  app.post('/photos', { preHandler: requireAuth, config: ctx.rl(20, 3600_000) }, async (req, reply) => {
    const user = me(req);
    const [pending] = await db
      .select({ c: count() })
      .from(schema.postPhotos)
      .where(and(eq(schema.postPhotos.ownerId, user.id), isNull(schema.postPhotos.postId)));
    if ((pending?.c ?? 0) >= MAX_PENDING_PER_USER) throw new AppError(429, 'RATE_LIMITED', '임시 사진이 너무 많습니다. 글에 연결하거나 삭제해 주세요.');

    if (!req.isMultipart()) throw new AppError(415, 'UNSUPPORTED_TYPE', 'multipart/form-data 로 file 을 보내 주세요.');
    const file = await req.file();
    if (!file) throw new AppError(400, 'VALIDATION_ERROR', 'file 이 필요합니다.');
    const buf = await file.toBuffer(); // 10MB 초과 시 FST_REQ_FILE_TOO_LARGE
    if (file.file.truncated) throw new AppError(413, 'FILE_TOO_LARGE', '파일은 10MB 이하여야 합니다.');

    const img = await processImage(buf);
    const key = `photos/${randomBytes(16).toString('hex')}.jpg`;
    const url = await storage.save(key, img.data);
    // 임시 사진 상한 확인과 삽입을 사용자 단위 advisory lock 안에서 처리해 동시 업로드의 상한 우회를 막는다
    const row = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(${user.id})`);
      const [cnt] = await tx.select({ c: count() }).from(schema.postPhotos).where(and(eq(schema.postPhotos.ownerId, user.id), isNull(schema.postPhotos.postId)));
      if ((cnt?.c ?? 0) >= MAX_PENDING_PER_USER) return null;
      const [r] = await tx.insert(schema.postPhotos).values({ ownerId: user.id, storageKey: key, url, width: img.width, height: img.height }).returning();
      return r!;
    });
    if (!row) {
      await storage.delete(key);
      throw new AppError(429, 'RATE_LIMITED', '임시 사진이 너무 많습니다. 글에 연결하거나 삭제해 주세요.');
    }
    return reply.status(201).send({ photoId: row.id, url, width: img.width, height: img.height, isBlurred: false, sensitive: false });
  });

  app.delete('/photos/:id', { preHandler: requireAuth }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    // 삭제 조건(내 소유 + 아직 글에 연결 안 됨)을 DELETE 자체에 넣어 첨부와의 경합에서도 연결된 사진이 지워지지 않게 한다
    const [deleted] = await db
      .delete(schema.postPhotos)
      .where(and(eq(schema.postPhotos.id, id), eq(schema.postPhotos.ownerId, me(req).id), isNull(schema.postPhotos.postId)))
      .returning();
    if (!deleted) {
      const [exists] = await db.select({ postId: schema.postPhotos.postId }).from(schema.postPhotos).where(and(eq(schema.postPhotos.id, id), eq(schema.postPhotos.ownerId, me(req).id))).limit(1);
      if (exists) throw new AppError(409, 'PHOTO_IN_USE', '글에 연결된 사진은 삭제할 수 없습니다.');
      throw notFound('사진을 찾을 수 없습니다.');
    }
    await storage.delete(deleted.storageKey);
    if (deleted.aiKey) await storage.delete(deleted.aiKey);
    if (deleted.blurredKey) await storage.delete(deleted.blurredKey);
    return reply.status(204).send();
  });
}
