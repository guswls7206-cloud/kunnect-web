import { and, asc, eq, ilike } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Ctx } from '../../app.js';
import { schema } from '../../db/client.js';
import { escapeLike } from '../../lib/pg.js';
import { requireAuth } from '../auth/plugin.js';

const tagQuery = z.object({ preset: z.enum(['true', 'false']).optional(), q: z.string().max(20).optional() });


export async function catalogRoutes(app: FastifyInstance, ctx: Ctx) {
  const { db } = ctx;
  const toTag = (t: typeof schema.tags.$inferSelect) => ({ id: t.id, name: t.name, isPreset: t.isPreset, isCategory: t.isCategory });

  app.get('/locations', { preHandler: requireAuth }, async (_req, reply) => {
    // 실제 캠퍼스 위치만, 시드 순서(건물 번호순 → 층)대로. 예전 더미 위치(is_dummy)는 숨긴다.
    const rows = await db.select().from(schema.locations).where(eq(schema.locations.isDummy, false)).orderBy(asc(schema.locations.id));
    reply.header('Cache-Control', 'private, max-age=300');
    return { items: rows.map((l) => ({ id: l.id, buildingId: l.buildingKey, buildingName: l.buildingName, floor: l.floor, lat: l.lat, lng: l.lng })) };
  });

  app.get('/tags', { preHandler: requireAuth }, async (req) => {
    const q = tagQuery.parse(req.query);
    const rows = await db
      .select()
      .from(schema.tags)
      .where(
        and(
          q.preset ? eq(schema.tags.isPreset, q.preset === 'true') : undefined,
          q.q ? ilike(schema.tags.name, `%${escapeLike(q.q)}%`) : undefined,
        ),
      )
      .orderBy(asc(schema.tags.id))
      .limit(100);
    return { items: rows.map(toTag) };
  });

  app.get('/tags/suggest', { preHandler: requireAuth }, async (req) => {
    const q = z.object({ q: z.string().min(1).max(20) }).parse(req.query);
    const rows = await db
      .select()
      .from(schema.tags)
      .where(ilike(schema.tags.name, `${escapeLike(q.q.toLowerCase())}%`))
      .orderBy(asc(schema.tags.isPreset), asc(schema.tags.name))
      .limit(10);
    return { items: rows.map(toTag) };
  });
}
