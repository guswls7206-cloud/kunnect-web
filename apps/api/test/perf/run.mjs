// KUnnect API 부하 테스트(autocannon). 실행 전 seed-load.mjs 로 데이터를 만들어 둔다.
// 사용:
//   DATABASE_URL=postgres://kunnect:kunnect@localhost:55433/kunnect API_URL=http://localhost:4200 node run.mjs
// 환경 변수(선택): DURATION=10(초) CONNECTIONS=20 ONLY=posts,dm (시나리오 이름 부분 일치) SESSIONS=60
// 주의: 레이트 리밋·로그인 잠금 때문에 API 를 NODE_ENV=test(+TEST_LOG=1 로 로그 유지)로 띄워야 한다. 운영 DB 금지.
import autocannon from 'autocannon';
import { mkdirSync, writeFileSync } from 'node:fs';
import pg from 'pg';
import sharp from 'sharp';

const API_URL = process.env.API_URL ?? 'http://localhost:4000';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://kunnect:kunnect@localhost:5432/kunnect';
const DURATION = Number(process.env.DURATION ?? 10);
const CONNECTIONS = Number(process.env.CONNECTIONS ?? 20);
const SESSIONS = Number(process.env.SESSIONS ?? 60);
const ONLY = (process.env.ONLY ?? '').split(',').filter(Boolean);
const PASSWORD = 'Load-Pass-2026';
const ORIGIN = new URL(API_URL).origin;
const BASE = `${API_URL}/api/v1`;

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];
const J = { 'Content-Type': 'application/json', Origin: ORIGIN };

// ───────── 준비: 세션 쿠키, 대화/쪽지 매핑, 글 id 범위 ─────────
const users = (await pool.query(`select id, login_id from users where login_id like 'load\\_0%' order by id limit $1`, [SESSIONS])).rows;
if (!users.length) throw new Error('부하 사용자가 없습니다. 먼저 seed-load.mjs 를 실행하세요.');

async function login(loginId) {
  const r = await fetch(`${BASE}/auth/login`, { method: 'POST', headers: J, body: JSON.stringify({ loginId, password: PASSWORD }) });
  if (r.status !== 200) throw new Error(`로그인 실패 ${loginId}: ${r.status} ${await r.text()}`);
  return r.headers.get('set-cookie').split(';')[0];
}
const sessions = [];
for (const u of users) {
  const convs = (
    await pool.query(
      `select c.id, coalesce((select max(m.id) from messages m where m.conversation_id = c.id), 0) last_id
       from conversations c join conversation_members cm on cm.conversation_id = c.id and cm.user_id = $1 limit 20`,
      [u.id],
    )
  ).rows;
  sessions.push({ id: u.id, loginId: u.login_id, cookie: await login(u.login_id), convs });
}
const withConvs = sessions.filter((s) => s.convs.length);
const { rows: [pr] } = await pool.query(`select min(id) lo, max(id) hi from posts`);
const { rows: hotPosts } = await pool.query(
  `select c.post_id from comments c join posts p on p.id = c.post_id where p.status = 'OPEN' group by c.post_id order by count(*) desc limit 100`,
);
const { rows: buildings } = await pool.query(`select distinct building_key k from locations`);
const { rows: tagRows } = await pool.query(`select name from tags order by id limit 6`);
// 깊은 페이지용 커서: 첫 페이지의 nextCursor 를 몇 번 따라가 얻는다
let deepCursor = null;
{
  let cursor = null;
  for (let i = 0; i < 20; i++) {
    const r = await (await fetch(`${BASE}/posts?limit=20${cursor ? `&cursor=${cursor}` : ''}`, { headers: { cookie: sessions[0].cookie } })).json();
    if (!r.nextCursor) break;
    cursor = r.nextCursor;
    if (i === 9) deepCursor = cursor;
  }
}
console.log(`준비 완료: 세션 ${sessions.length}개(대화 보유 ${withConvs.length}), 글 id ${pr.lo}..${pr.hi}, 인기 글 ${hotPosts.length}개, 깊은 커서 ${deepCursor ? '있음' : '없음'}`);
await pool.query('delete from post_photos where post_id is null'); // 이전 실행의 임시 사진(사용자당 20개 상한) 정리
await pool.query('select pg_stat_statements_reset()').catch(() => console.warn('pg_stat_statements 를 쓸 수 없습니다(확장 미설치)'));

// ───────── 시나리오 정의 ─────────
const authed = (build) => (req) => {
  const s = pick(sessions);
  req.headers = { ...J, cookie: s.cookie };
  return build(req, s);
};

// 사진 업로드용 JPEG(무작위 노이즈 → 압축이 잘 안 되는 실제 사진과 비슷한 크기)
const noise = Buffer.alloc(1600 * 1200 * 3);
for (let i = 0; i < noise.length; i++) noise[i] = (Math.random() * 256) | 0;
const jpeg = await sharp(noise, { raw: { width: 1600, height: 1200, channels: 3 } }).jpeg({ quality: 80 }).toBuffer();
const boundary = '----kunnectperf';
const multipart = Buffer.concat([
  Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="p.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`),
  jpeg,
  Buffer.from(`\r\n--${boundary}--\r\n`),
]);
console.log(`업로드용 JPEG ${(jpeg.length / 1024).toFixed(0)}KB`);

const scenarios = [
  { name: 'posts list (기본)', req: authed((r) => ((r.method = 'GET'), (r.path = '/api/v1/posts?limit=20'), r)) },
  { name: 'posts list type+status', req: authed((r) => ((r.method = 'GET'), (r.path = '/api/v1/posts?type=LOST&status=OPEN&limit=20'), r)) },
  {
    name: 'posts list buildingId',
    req: authed((r) => ((r.method = 'GET'), (r.path = `/api/v1/posts?buildingId=${encodeURIComponent(pick(buildings).k)}&limit=20`), r)),
  },
  { name: 'posts list tag', req: authed((r) => ((r.method = 'GET'), (r.path = `/api/v1/posts?tag=${encodeURIComponent(pick(tagRows).name)}&limit=20`), r)) },
  { name: 'posts list q 검색', req: authed((r) => ((r.method = 'GET'), (r.path = `/api/v1/posts?q=${encodeURIComponent(pick(['우산', '지갑', '열쇠', '학생회관']))}&limit=20`), r)) },
  {
    name: 'posts list 깊은 페이지(cursor)',
    skip: !deepCursor,
    req: authed((r) => ((r.method = 'GET'), (r.path = `/api/v1/posts?limit=20&cursor=${encodeURIComponent(deepCursor)}`), r)),
  },
  { name: 'post detail', req: authed((r) => ((r.method = 'GET'), (r.path = `/api/v1/posts/${Number(pr.lo) + rnd(Number(pr.hi) - Number(pr.lo))}`), r)) },
  {
    name: 'post create (사진 없음)',
    connections: 10,
    req: authed((r) => {
      r.method = 'POST';
      r.path = '/api/v1/posts';
      r.body = JSON.stringify({
        type: 'LOST',
        title: `부하 ${Date.now()}`,
        description: '부하 테스트 글',
        locationId: 1 + rnd(13),
        occurredAt: new Date(Date.now() - 3600_000).toISOString(),
        tags: ['검정', '우산'],
        photoIds: [],
      });
      return r;
    }),
  },
  {
    name: 'photo upload (multipart)',
    note: 'sharp 리사이즈·EXIF 제거·디스크 쓰기',
    connections: 8,
    req: authed((r) => {
      r.method = 'POST';
      r.path = '/api/v1/photos';
      r.headers = { ...r.headers, 'Content-Type': `multipart/form-data; boundary=${boundary}` };
      r.body = multipart;
      return r;
    }),
  },
  { name: 'comments list (인기 글)', req: authed((r) => ((r.method = 'GET'), (r.path = `/api/v1/posts/${pick(hotPosts).post_id}/comments`), r)) },
  { name: 'comments list (일반 글)', req: authed((r) => ((r.method = 'GET'), (r.path = `/api/v1/posts/${Number(pr.lo) + rnd(Number(pr.hi) - Number(pr.lo))}/comments`), r)) },
  {
    name: 'comment create',
    connections: 10,
    req: authed((r) => {
      r.method = 'POST';
      r.path = `/api/v1/posts/${pick(hotPosts).post_id}/comments`;
      r.body = JSON.stringify({ body: `부하 댓글 ${Date.now()}` });
      return r;
    }),
  },
  { name: 'unread-count 폴링', req: authed((r) => ((r.method = 'GET'), (r.path = '/api/v1/notifications/unread-count'), r)) },
  { name: 'notifications list', req: authed((r) => ((r.method = 'GET'), (r.path = '/api/v1/notifications?limit=20'), r)) },
  {
    name: 'inbox (conversations list)',
    req: (r) => {
      const s = pick(withConvs);
      r.method = 'GET';
      r.path = '/api/v1/conversations?limit=20';
      r.headers = { ...J, cookie: s.cookie };
      return r;
    },
  },
  {
    name: 'DM poll (afterId, 빈 응답)',
    req: (r) => {
      const s = pick(withConvs);
      const c = pick(s.convs);
      r.method = 'GET';
      r.path = `/api/v1/conversations/${c.id}/messages?afterId=${c.last_id}`;
      r.headers = { ...J, cookie: s.cookie };
      return r;
    },
  },
  {
    name: 'DM 최근 30개 로드',
    req: (r) => {
      const s = pick(withConvs);
      r.method = 'GET';
      r.path = `/api/v1/conversations/${pick(s.convs).id}/messages?limit=30`;
      r.headers = { ...J, cookie: s.cookie };
      return r;
    },
  },
  {
    name: 'DM 전송',
    connections: 10,
    req: (r) => {
      const s = pick(withConvs);
      r.method = 'POST';
      r.path = `/api/v1/conversations/${pick(s.convs).id}/messages`;
      r.headers = { ...J, cookie: s.cookie };
      r.body = JSON.stringify({ body: `부하 쪽지 ${Date.now()}` });
      return r;
    },
  },
  // 로그인은 마지막에 실행한다: 사용자당 동시 세션이 5개로 제한되어(오래된 세션 만료) 로그인을 몰아치면
  // 앞서 발급한 쿠키가 무효가 되기 때문이다.
  {
    name: 'login',
    note: 'argon2 검증(CPU 집약)',
    connections: 8,
    req: (r) => {
      const u = pick(users);
      r.method = 'POST';
      r.path = '/api/v1/auth/login';
      r.headers = J;
      r.body = JSON.stringify({ loginId: u.login_id, password: PASSWORD });
      return r;
    },
  },
];

// ───────── 실행 ─────────
const rows = [];

// 사진 포함 글 작성 흐름(업로드 → 글 작성)은 단계가 이어져 autocannon 으로 표현하기 어려워 직접 측정한다
async function flowPhotoPost(iterations = 60, concurrency = 6) {
  const lat = { upload: [], create: [], total: [] };
  let failures = 0;
  let next = 0;
  async function worker() {
    while (next < iterations) {
      next++;
      const s = pick(sessions);
      const h = { ...J, cookie: s.cookie };
      const t0 = performance.now();
      try {
        const fd = new FormData();
        fd.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'p.jpg');
        const up = await fetch(`${BASE}/photos`, { method: 'POST', headers: { Origin: ORIGIN, cookie: s.cookie }, body: fd });
        if (up.status !== 201) throw new Error(`upload ${up.status}`);
        const { photoId } = await up.json();
        const t1 = performance.now();
        const cr = await fetch(`${BASE}/posts`, {
          method: 'POST',
          headers: h,
          body: JSON.stringify({
            type: 'FOUND', title: `사진 글 ${Date.now()}`, description: '사진 포함', locationId: 1 + rnd(13),
            occurredAt: new Date(Date.now() - 3600_000).toISOString(), tags: ['검정'], storagePlace: '안내데스크', photoIds: [photoId],
          }),
        });
        if (cr.status !== 201) throw new Error(`create ${cr.status} ${await cr.text()}`);
        const t2 = performance.now();
        lat.upload.push(t1 - t0);
        lat.create.push(t2 - t1);
        lat.total.push(t2 - t0);
      } catch (e) {
        failures++;
        if (failures <= 3) console.warn('  흐름 실패:', e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const pct = (a, p) => (a.length ? Math.round([...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]) : null);
  return { iterations, concurrency, failures, upload: [pct(lat.upload, 50), pct(lat.upload, 95)], create: [pct(lat.create, 50), pct(lat.create, 95)], total: [pct(lat.total, 50), pct(lat.total, 95)] };
}
let flow = null;
if (!ONLY.length || ONLY.some((o) => '사진 글 흐름 flow'.includes(o))) {
  process.stdout.write('▶ 사진 포함 글 작성 흐름 (업로드→작성) ... ');
  flow = await flowPhotoPost();
  console.log(`p50/p95 ms — 업로드 ${flow.upload.join('/')}, 작성 ${flow.create.join('/')}, 전체 ${flow.total.join('/')}, 실패 ${flow.failures}/${flow.iterations}`);
}

// 시나리오 본 실행
for (const sc of scenarios) {
  if (sc.skip) continue;
  if (ONLY.length && !ONLY.some((o) => sc.name.includes(o))) continue;
  const connections = sc.connections ?? CONNECTIONS;
  process.stdout.write(`▶ ${sc.name} (연결 ${connections}, ${DURATION}s) ... `);
  const r = await autocannon({
    url: API_URL,
    connections,
    duration: DURATION,
    timeout: 30,
    requests: [{ setupRequest: sc.req }],
  });
  const row = {
    name: sc.name,
    note: sc.note ?? '',
    connections,
    rps: Math.round(r.requests.average),
    p50: r.latency.p50,
    p90: r.latency.p90,
    p97_5: r.latency.p97_5,
    p99: r.latency.p99,
    max: r.latency.max,
    total: r.requests.total,
    non2xx: r.non2xx,
    errors: r.errors,
    timeouts: r.timeouts,
  };
  rows.push(row);
  await new Promise((res) => setTimeout(res, 2000)); // 직전 시나리오의 대기 작업(매칭·파일 처리)이 가라앉도록 쉰다
  console.log(`${row.rps} req/s, p50 ${row.p50}ms, p97.5 ${row.p97_5}ms, p99 ${row.p99}ms, non2xx ${row.non2xx}, err ${row.errors}`);
}

// ───────── DB 핫스팟(pg_stat_statements) ─────────
let top = [];
try {
  top = (
    await pool.query(
      `select left(regexp_replace(query, '\\s+', ' ', 'g'), 220) q, calls, round(total_exec_time::numeric, 1) total_ms,
              round(mean_exec_time::numeric, 3) mean_ms, round(max_exec_time::numeric, 1) max_ms, rows
       from pg_stat_statements where query not ilike '%pg_stat_statements%' and dbid = (select oid from pg_database where datname = current_database())
       order by total_exec_time desc limit 15`,
    )
  ).rows;
} catch (e) {
  console.warn('pg_stat_statements 조회 실패:', e.message);
}

mkdirSync(new URL('./results', import.meta.url), { recursive: true });
const out = { at: new Date().toISOString(), duration: DURATION, connections: CONNECTIONS, rows, flow, topStatements: top };
writeFileSync(new URL('./results/latest.json', import.meta.url), JSON.stringify(out, null, 2));

console.log('\n| 시나리오 | 연결 | req/s | p50 | p90 | p97.5 | p99 | max | non2xx | 오류 |');
console.log('|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(`| ${r.name} | ${r.connections} | ${r.rps} | ${r.p50} | ${r.p90} | ${r.p97_5} | ${r.p99} | ${r.max} | ${r.non2xx} | ${r.errors + r.timeouts} |`);
console.log('\nDB 상위 쿼리(총 실행 시간순):');
for (const t of top) console.log(`- ${t.total_ms}ms / ${t.calls}회 / 평균 ${t.mean_ms}ms / 최대 ${t.max_ms}ms :: ${t.q}`);
await pool.end();
