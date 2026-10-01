// 부하 테스트 중 상위로 나온 쿼리의 실행 계획(EXPLAIN ANALYZE)과 인덱스 개선 후보 효과를 측정한다.
// 후보 인덱스는 트랜잭션 안에서 만들고 ROLLBACK 하므로 DB 스키마는 바뀌지 않는다(src/ 도 수정하지 않음).
// 사용: DATABASE_URL=postgres://kunnect:kunnect@localhost:55433/kunnect node explain.mjs
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL ?? 'postgres://kunnect:kunnect@localhost:5432/kunnect', max: 1 });
const c = await pool.connect();

const { rows: [u] } = await c.query(`select cm.user_id uid from conversation_members cm
  join users x on x.id = cm.user_id where x.login_id like 'load\\_0%' limit 1`);
const { rows: [tag] } = await c.query(`select name from tags order by id limit 1`);
const { rows: [bld] } = await c.query(`select building_key k from locations limit 1`);
const { rows: convs } = await c.query(`select conversation_id id from conversation_members where user_id = $1 limit 20`, [u.uid]);
const convIds = convs.map((x) => x.id).join(',');

const queries = [
  {
    name: '글 검색(q) 흔한 단어 "우산": ILIKE',
    sql: `select id from posts where status in ('OPEN','MATCHED') and (title ilike '%우산%' or description ilike '%우산%') order by id desc limit 21`,
  },
  {
    // 실제 검색어는 대부분 드문 단어다: 21건을 못 채우면 테이블 전체를 훑는다(행 수에 비례해 느려짐)
    name: '글 검색(q) 드문 단어 "17321": ILIKE',
    sql: `select id from posts where status in ('OPEN','MATCHED') and (title ilike '%17321%' or description ilike '%17321%') order by id desc limit 21`,
  },
  {
    name: '글 목록 + 태그 필터(EXISTS)',
    sql: `select id from posts where status in ('OPEN','MATCHED') and exists (select 1 from post_tags pt join tags t on t.id = pt.tag_id where pt.post_id = posts.id and (t.name = '${tag.name}' or t.slug = '${tag.name}')) order by id desc limit 21`,
  },
  {
    name: '글 목록 + 건물(buildingId) 필터',
    sql: `select id from posts where status in ('OPEN','MATCHED') and location_id in (select id from locations where building_key = '${bld.k}') order by id desc limit 21`,
  },
  {
    name: '글 목록 + 태그 필터(조인 재작성: post_tags 에서 시작)',
    sql: `select p.id from post_tags pt join posts p on p.id = pt.post_id join tags t on t.id = pt.tag_id where (t.name = '${tag.name}' or t.slug = '${tag.name}') and p.status in ('OPEN','MATCHED') order by p.id desc limit 21`,
  },
  {
    name: '글 목록(필터 없음, 상태만)',
    sql: `select id from posts where status in ('OPEN','MATCHED') order by id desc limit 21`,
  },
  {
    name: '글 목록(type+status)',
    sql: `select id from posts where type = 'LOST' and status = 'OPEN' order by id desc limit 21`,
  },
  {
    name: '작업 큐 선점(update jobs … skip locked)',
    sql: `select id from jobs where status = 'PENDING' and run_after <= now() order by id limit 1 for update skip locked`,
  },
  {
    name: '쪽지 읽지 않음 수(배지 폴링)',
    sql: `select count(*)::int as c from messages m join conversation_members cm on cm.conversation_id = m.conversation_id and cm.user_id = ${u.uid} where m.sender_id <> ${u.uid} and m.deleted_at is null and m.id > cm.last_read_message_id and cm.left_at is null`,
  },
  {
    name: '쪽지함: 대화별 마지막 메시지(DISTINCT ON)',
    sql: `select distinct on (conversation_id) conversation_id, created_at, type from messages where conversation_id in (${convIds}) and deleted_at is null order by conversation_id, id desc`,
  },
];

// 후보 인덱스(Worker 3 에게 전달할 마이그레이션 SQL 후보). 각 항목은 어떤 쿼리를 겨냥하는지 적는다.
const candidates = [
  { label: 'pg_trgm GIN (글 검색)', sql: [`create extension if not exists pg_trgm`, `create index tmp_posts_title_trgm on posts using gin (title gin_trgm_ops)`, `create index tmp_posts_desc_trgm on posts using gin (description gin_trgm_ops)`] },
  { label: 'post_tags(tag_id, post_id desc) (태그 필터: 조인 재작성과 함께)', sql: [`create index tmp_post_tags_tag_post on post_tags (tag_id, post_id desc)`] },
  { label: 'posts(status, id desc) (상태만 필터한 목록)', sql: [`create index tmp_posts_status_id on posts (status, id desc)`] },
  { label: 'posts(location_id, id desc) (건물 필터)', sql: [`create index tmp_posts_loc_id on posts (location_id, id desc)`] },
  { label: "jobs(id) WHERE status='PENDING' (작업 큐 부분 인덱스)", sql: [`create index tmp_jobs_pending on jobs (id) where status = 'PENDING'`] },
];

function summarize(plan) {
  const nodes = [];
  (function walk(n) {
    nodes.push(`${n['Node Type']}${n['Relation Name'] ? ` on ${n['Relation Name']}` : ''}${n['Index Name'] ? ` (${n['Index Name']})` : ''}`);
    (n.Plans ?? []).forEach(walk);
  })(plan.Plan);
  return { ms: plan['Execution Time'], nodes: [...new Set(nodes)].join(' → '), buffers: (plan.Plan['Shared Hit Blocks'] ?? 0) + (plan.Plan['Shared Read Blocks'] ?? 0) };
}

async function measure(sql, runs = 5) {
  const times = [];
  let last;
  for (let i = 0; i < runs; i++) {
    const r = await c.query(`explain (analyze, buffers, format json) ${sql}`);
    last = summarize(r.rows[0]['QUERY PLAN'][0]);
    times.push(last.ms);
  }
  times.sort((a, b) => a - b);
  return { ...last, ms: times[Math.floor(times.length / 2)] };
}

await c.query('analyze'); // 통계를 최신으로 맞춘 뒤 기준선을 잰다(후보 인덱스 비교가 통계 갱신 효과와 섞이지 않도록)
const sizes = (await c.query(`select relname, n_live_tup from pg_stat_user_tables where relname in ('posts','comments','messages','notifications','post_tags','conversations') order by relname`)).rows;
console.log('테이블 행 수:', sizes.map((s) => `${s.relname}=${s.n_live_tup}`).join(', '));
console.log('\n## 현재 실행 계획 (5회 중앙값)');
const base = {};
for (const q of queries) {
  base[q.name] = await measure(q.sql);
  console.log(`- ${q.name}: ${base[q.name].ms.toFixed(2)}ms, 버퍼 ${base[q.name].buffers} — ${base[q.name].nodes}`);
}

console.log('\n## 후보 인덱스 적용 시(트랜잭션 후 ROLLBACK)');
for (const cand of candidates) {
  await c.query('begin');
  try {
    for (const s of cand.sql) await c.query(s);
    await c.query('analyze');
    console.log(`\n[${cand.label}]`);
    for (const q of queries) {
      const after = await measure(q.sql);
      const b = base[q.name];
      if (after.nodes !== b.nodes || Math.abs(after.ms - b.ms) / Math.max(b.ms, 0.01) > 0.25) {
        console.log(`  · ${q.name}: ${b.ms.toFixed(2)}ms → ${after.ms.toFixed(2)}ms (${(b.ms / after.ms).toFixed(1)}x) — ${after.nodes}`);
      }
    }
  } catch (e) {
    console.log(`  (적용 실패: ${e.message})`);
  } finally {
    await c.query('rollback');
  }
}

console.log('\n## 시퀀셜 스캔이 많은 테이블(pg_stat_user_tables)');
for (const r of (await c.query(`select relname, seq_scan, seq_tup_read, idx_scan from pg_stat_user_tables where seq_scan > 100 order by seq_tup_read desc limit 8`)).rows) {
  console.log(`- ${r.relname}: seq_scan ${r.seq_scan}, seq_tup_read ${r.seq_tup_read}, idx_scan ${r.idx_scan}`);
}
console.log('\n## 한 번도 쓰이지 않은 인덱스(idx_scan = 0, 크기순)');
for (const r of (await c.query(`select s.relname, s.indexrelname, pg_size_pretty(pg_relation_size(s.indexrelid)) size from pg_stat_user_indexes s join pg_index i on i.indexrelid = s.indexrelid where s.idx_scan = 0 and not i.indisunique and not i.indisprimary order by pg_relation_size(s.indexrelid) desc limit 12`)).rows) {
  console.log(`- ${r.relname}.${r.indexrelname} (${r.size})`);
}

c.release();
await pool.end();
