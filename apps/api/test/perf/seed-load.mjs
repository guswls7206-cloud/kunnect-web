// 부하 테스트용 대량 데이터 생성(PostgreSQL generate_series). 운영/공용 DB 에 실행하지 말 것(전용 DB 에서만).
// 사용:  DATABASE_URL=postgres://kunnect:kunnect@localhost:55433/kunnect API_URL=http://localhost:4200 node seed-load.mjs
// 환경 변수(선택): USERS=2000 POSTS=20000 COMMENTS=60000 CONVS=3000 MSGS_PER_CONV=15 NOTIFS=30000 FORCE=1
// 사전 조건: 마이그레이션·카탈로그 시드(pnpm db:migrate && pnpm db:seed)가 끝난 DB 와 실행 중인 API(비밀번호 해시 생성용).
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://kunnect:kunnect@localhost:5432/kunnect';
const API_URL = process.env.API_URL ?? 'http://localhost:4000';
export const LOAD_PASSWORD = 'Load-Pass-2026';
const N = (name, d) => Number(process.env[name] ?? d);
const USERS = N('USERS', 2000);
const POSTS = N('POSTS', 20000);
const COMMENTS = N('COMMENTS', 60000);
const CONVS = N('CONVS', 3000);
const MSGS = N('MSGS_PER_CONV', 15);
const NOTIFS = N('NOTIFS', 30000);

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 2 });
const q = (text, params) => pool.query(text, params);
const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

const existing = Number((await q("select count(*) c from users where login_id like 'load\\_%'")).rows[0].c);
if (existing > 0 && !process.env.FORCE) {
  console.log(`부하 데이터가 이미 있습니다(load_ 사용자 ${existing}명). 다시 만들려면 DB 를 비우거나 FORCE=1.`);
  await pool.end();
  process.exit(0);
}

// 1) 실제 API 로 기준 사용자 1명을 만들어 argon2 해시를 얻는다(모든 부하 사용자가 같은 비밀번호를 공유 → 로그인 부하 가능)
const base = await fetch(`${API_URL}/api/v1/auth/signup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: new URL(API_URL).origin },
  body: JSON.stringify({ loginId: 'load_base', password: LOAD_PASSWORD, nickname: 'ldbase' }),
});
if (![201, 409].includes(base.status)) throw new Error(`기준 사용자 생성 실패: ${base.status} ${await base.text()}`);
const hash = (await q("select password_hash h from users where login_id = 'load_base'")).rows[0].h;
log('기준 비밀번호 해시 확보');

await q(
  `insert into users (login_id, password_hash, nickname, nickname_lower)
   select 'load_' || lpad(i::text, 5, '0'), $1, 'ld' || i, 'ld' || i from generate_series(1, $2) i
   on conflict do nothing`,
  [hash, USERS],
);
const { rows: [u] } = await q("select min(id) lo, max(id) hi, count(*) n from users where login_id like 'load\\_0%'");
const ulo = Number(u.lo);
const un = Number(u.n);
log(`사용자 ${un}명 (id ${u.lo}..${u.hi})`);

// 2) 글: 분실/습득 반반, 상태 분포 OPEN 80 / MATCHED 5 / RETURNED 5 / CLOSED 10, 최근 60일에 분산
await q(
  `insert into posts (type, author_id, title, description, status, match_state, occurred_at, location_id, storage_place, closed_at, created_at, updated_at)
   select t, $1 + (random() * ($2 - 1))::int, '검은 우산 ' || i || ' ' || t,
          '설명 ' || i || ' 우산 케이스 지갑 열쇠 가방 학생회관', st, 'DONE',
          ts, (select id from locations order by id offset (random() * (select count(*) - 1 from locations))::int limit 1),
          case when t = 'FOUND' then '안내데스크' end,
          case when st in ('RETURNED','CLOSED') then ts + interval '1 day' end, ts, ts
   from (
     select i, case when i % 2 = 0 then 'LOST' else 'FOUND' end t,
            (array['OPEN','OPEN','OPEN','OPEN','OPEN','OPEN','OPEN','OPEN','MATCHED','RETURNED','CLOSED','CLOSED'])[1 + (random() * 11)::int] st,
            now() - make_interval(secs => random() * 60 * 86400) ts
     from generate_series(1, $3) i
   ) s`,
  [ulo, un, POSTS],
);
const { rows: [p] } = await q("select min(id) lo, max(id) hi from posts where title like '검은 우산 %'");
log(`글 ${POSTS}건`);

// 3) 글-태그: 글마다 프리셋·사용자 태그 2개(무작위)
await q(
  `insert into post_tags (post_id, tag_id)
   select distinct p.id, (select id from tags order by id offset ((p.id * k) % (select count(*) from tags))::int limit 1)
   from posts p cross join generate_series(1, 2) k where p.title like '검은 우산 %'
   on conflict do nothing`,
);
log('글 태그');

// 4) 댓글: 20% 는 인기 글 100개에 몰림(긴 스레드), 나머지는 전체에 분산
await q(
  `insert into comments (post_id, author_id, body, created_at)
   select case when random() < 0.2 then $1 + (random() * 99)::int else $1 + (random() * ($2 - $1))::int end,
          $3 + (random() * ($4 - 1))::int, '댓글 ' || i, now() - make_interval(secs => random() * 30 * 86400)
   from generate_series(1, $5) i`,
  [Number(p.lo), Number(p.hi), ulo, un, COMMENTS],
);
log(`댓글 ${COMMENTS}건`);

// 5) 대화/쪽지: 사용자 쌍이 겹치지 않게 만든다
await q(
  `insert into conversations (user_a_id, user_b_id, last_message_at)
   select $1 + ((i - 1) % ($2 - 1)), $1 + ((i - 1) % ($2 - 1)) + 1 + ((i - 1) / ($2 - 1))::int, now()
   from generate_series(1, $3) i
   where $1 + ((i - 1) % ($2 - 1)) + 1 + ((i - 1) / ($2 - 1))::int <= $1 + $2 - 1`,
  [ulo, un, CONVS],
);
await q(`insert into conversation_members (conversation_id, user_id)
         select c.id, u from conversations c cross join lateral (values (c.user_a_id), (c.user_b_id)) v(u)
         where c.user_a_id >= $1 on conflict do nothing`, [ulo]);
await q(
  `insert into messages (conversation_id, sender_id, body, created_at)
   select c.id, case when k % 2 = 0 then c.user_a_id else c.user_b_id end, '쪽지 ' || k,
          now() - make_interval(mins => ($1 - k) * 7)
   from conversations c cross join generate_series(1, $2) k where c.user_a_id >= $3`,
  [MSGS, MSGS, ulo],
);
log(`대화 ${CONVS}개 × 쪽지 ${MSGS}개`);

// 6) 알림
await q(
  `insert into notifications (user_id, type, post_id, created_at, read_at)
   select $1::int + (random() * ($2::int - 1))::int, 'COMMENT', $3::int + (random() * ($4::int - $3::int))::int, now() - make_interval(secs => random() * 20 * 86400),
          case when random() < 0.5 then now() end
   from generate_series(1, $5)`,
  [ulo, un, Number(p.lo), Number(p.hi), NOTIFS],
);
log(`알림 ${NOTIFS}건`);

await q('analyze');
const counts = (await q(`select (select count(*) from users) users, (select count(*) from posts) posts, (select count(*) from comments) comments,
  (select count(*) from messages) messages, (select count(*) from notifications) notifications`)).rows[0];
console.log('완료:', counts);
await pool.end();
