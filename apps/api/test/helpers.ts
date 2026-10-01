import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import sharp from 'sharp';
import { parse } from 'yaml';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, runMigrations, type Db } from '../src/db/client.js';
import { seedCatalog } from '../src/db/seed.js';
import { LocalDiskStorage } from '../src/storage/index.js';

// ───── OpenAPI 계약 검증: 모든 테스트 요청의 실제 응답을 openapi.yaml 스키마로 검증한다 ─────
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- OpenAPI 문서는 동적 구조
const oas = parse(readFileSync(new URL('../openapi.yaml', import.meta.url), 'utf8')) as Json;
// 응답 스키마 엄격화: required 가 없는 객체 스키마는 선언된 모든 속성을 필수로 취급한다(선택 속성은 아래 목록)
const OPTIONAL_PROPS = new Set(['fields', 'suggestedConversation']);
(function strictify(node: unknown) {
  if (Array.isArray(node)) return node.forEach(strictify);
  if (!node || typeof node !== 'object') return;
  const o = node as Json;
  if (o.nullable && !o.type && Array.isArray(o.allOf)) {
    // OpenAPI 3.0 의 "nullable + allOf" 를 JSON Schema 로 변환
    o.anyOf = [{ type: 'null' }, ...o.allOf];
    delete o.allOf;
    delete o.nullable;
  }
  if (o.properties && typeof o.properties === 'object' && !o.required) {
    o.required = Object.keys(o.properties).filter((k) => !OPTIONAL_PROPS.has(k));
  }
  Object.values(o).forEach(strictify);
})(oas);
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(oas, 'oas');
const escapePtr = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
const templates = Object.keys(oas.paths as Json)
  .map((p) => ({ p, re: new RegExp('^' + p.replace(/\{\w+\}/g, '[^/]+') + '$'), params: (p.match(/\{/g) ?? []).length }))
  .sort((a, b) => a.params - b.params);

export function contractViolations(method: string, url: string, status: number, body: unknown): string[] {
  const path = url.split('?')[0]!;
  const tpl = templates.find((t) => t.re.test(path));
  if (!tpl) return [];
  const op = (oas.paths as Json)[tpl.p][method.toLowerCase()];
  if (!op) return [`${method} ${tpl.p}: 명세에 없는 메서드`];
  let pointer: string | null = null;
  const resp = op.responses?.[String(status)];
  if (resp?.$ref) pointer = `${resp.$ref}/content/application~1json/schema`;
  else if (resp) pointer = resp.content?.['application/json'] ? `#/paths/${escapePtr(tpl.p)}/${method.toLowerCase()}/responses/${status}/content/application~1json/schema` : null;
  else if (status >= 400) pointer = '#/components/schemas/Error'; // 명세에 개별 정의가 없는 오류는 공통 오류 형식만 검사
  else return [`${method} ${tpl.p}: 명세에 없는 상태 코드 ${status}`];
  if (!pointer) return [];
  const validate = ajv.getSchema('oas' + pointer);
  if (!validate) return [`${method} ${tpl.p} ${status}: 스키마를 찾을 수 없음 (${pointer})`];
  return validate(body) ? [] : (validate.errors ?? []).map((e) => `${method} ${tpl.p} ${status}: ${e.instancePath || '/'} ${e.message}`);
}

function assertContract(method: string, url: string, status: number, body: unknown) {
  const v = contractViolations(method, url, status, body);
  if (v.length) throw new Error(['OpenAPI 계약 위반:', ...v.slice(0, 5)].join('\n'));
}

export interface TestEnv {
  app: FastifyInstance;
  db: Db;
  storageDir: string;
  reset: () => Promise<void>;
  close: () => Promise<void>;
}

export async function setupEnv(opts: { rateLimitEnabled?: boolean; config?: Record<string, unknown> } = {}): Promise<TestEnv> {
  const config = { ...loadConfig({ ...process.env, NODE_ENV: 'test' }), NODE_ENV: 'test' as const, ...(opts.config ?? {}) };
  const { db, pool } = createDb(process.env.DATABASE_URL!);
  await runMigrations(db);
  await seedCatalog(db);
  const storageDir = mkdtempSync(join(tmpdir(), 'kunnect-files-'));
  const app = await buildApp({ config, db, storage: new LocalDiskStorage(storageDir), rateLimitEnabled: opts.rateLimitEnabled ?? false });
  await app.ready();
  const reset = async () => {
    await pool.query('truncate users, jobs, rate_counters, ai_call_counters restart identity cascade');
    await pool.query('delete from tags where is_preset = false');
  };
  return {
    app,
    db,
    storageDir,
    reset,
    close: async () => {
      await app.close();
      await pool.end();
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

/** 쿠키를 유지하는 간단한 테스트 클라이언트 */
export class Client {
  cookie = '';
  constructor(private app: FastifyInstance) {}

  async req(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.app.inject({
      method,
      url: `/api/v1${url}`,
      payload: body === undefined ? undefined : (body as object),
      headers: { origin: 'http://localhost:3000', ...(this.cookie ? { cookie: this.cookie } : {}), ...headers },
    });
    const set = res.headers['set-cookie'];
    if (set) {
      const raw = Array.isArray(set) ? set[0]! : set;
      const pair = raw.split(';')[0]!;
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 테스트 편의상 응답 본문은 any
    let json: any = null;
    try {
      json = res.body ? JSON.parse(res.body) : null;
    } catch {
      /* 본문이 JSON 이 아님 */
    }
    assertContract(method, url, res.statusCode, json);
    return { status: res.statusCode, body: json, headers: res.headers, raw: res };
  }
  get = (url: string) => this.req('GET', url);
  post = (url: string, body?: unknown) => this.req('POST', url, body ?? {});
  patch = (url: string, body?: unknown) => this.req('PATCH', url, body ?? {});
  del = (url: string) => this.req('DELETE', url);

  async upload(buf: Buffer, filename = 'a.jpg', mime = 'image/jpeg') {
    const boundary = '----kunnect' + Math.random().toString(16).slice(2);
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const res = await this.app.inject({
      method: 'POST',
      url: '/api/v1/photos',
      payload: Buffer.concat([head, buf, tail]),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, cookie: this.cookie, origin: 'http://localhost:3000' },
    });
    const json = res.body ? JSON.parse(res.body) : null;
    assertContract('POST', '/photos', res.statusCode, json);
    return { status: res.statusCode, body: json };
  }
}

let seq = 0;
export async function signup(app: FastifyInstance, name?: string) {
  const c = new Client(app);
  seq += 1;
  const loginId = name ?? `user${seq}`;
  const res = await c.post('/auth/signup', { loginId, password: 'Test-Pass-77', nickname: `닉${loginId}`.slice(0, 12) });
  if (res.status !== 201) throw new Error(`가입 실패: ${JSON.stringify(res.body)}`);
  return { client: c, user: res.body.user as { id: number; nickname: string; loginId: string } };
}

export async function firstLocationId(c: Client) {
  const r = await c.get('/locations');
  return r.body.items[0].id as number;
}

export async function makePost(c: Client, over: Record<string, unknown> = {}) {
  const locationId = (over.locationId as number | undefined) ?? (await firstLocationId(c));
  const type = (over.type as string | undefined) ?? 'LOST';
  const res = await c.post('/posts', {
    type,
    title: '검은색 에어팟 케이스',
    description: '학생회관에서 잃어버렸습니다.',
    locationId,
    occurredAt: new Date(Date.now() - 3600_000).toISOString(),
    tags: ['이어폰', '검정'],
    ...(type === 'FOUND' ? { storagePlace: '학생회관 안내데스크' } : {}),
    ...over,
  });
  return res;
}

export const jpeg = (w = 64, h = 48, color = '#3366cc') => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
