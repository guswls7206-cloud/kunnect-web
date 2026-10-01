import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

const require = createRequire(import.meta.url);

/** 개발 환경 전용 Swagger UI: GET /docs (명세는 /docs/openapi.yaml). 운영(NODE_ENV=production)에서는 등록하지 않는다. */
export async function registerDocs(app: FastifyInstance) {
  const swagger = require('swagger-ui-dist') as { absolutePath: () => string };
  await app.register(fastifyStatic, { root: swagger.absolutePath(), prefix: '/docs/assets/', decorateReply: false });
  const spec = readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8');
  app.get('/docs/openapi.yaml', async (_req, reply) => reply.type('application/yaml; charset=utf-8').send(spec));
  app.get('/docs', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(`<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><title>KUnnect API 문서</title>
<link rel="stylesheet" href="/docs/assets/swagger-ui.css"></head>
<body><div id="ui"></div>
<script src="/docs/assets/swagger-ui-bundle.js"></script>
<script>window.ui = SwaggerUIBundle({ url: '/docs/openapi.yaml', dom_id: '#ui' });</script>
</body></html>`),
  );
}
