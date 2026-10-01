// Docker 없이 할 수 있는 정적 점검: docker-compose.prod.yml 과 Dockerfile 의 흔한 실수를 잡는다.
// 사용: node scripts/ops/check-compose.mjs   (apps/api 에서 실행, 종료 코드 0 = 통과)
// 한계: 문법·구성 규칙만 본다. 실제 이미지 빌드·컨테이너 기동은 Docker 가 있는 환경에서 따로 확인해야 한다.
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const composePath = new URL('../../../../docker-compose.prod.yml', import.meta.url);
const dockerfilePath = new URL('../../Dockerfile', import.meta.url);
const envExamplePath = new URL('../../.env.example', import.meta.url);

const errors = [];
const warns = [];
const check = (cond, msg) => { if (!cond) errors.push(msg); };

const composeText = readFileSync(composePath, 'utf8');
const compose = parse(composeText);
const dockerfile = readFileSync(dockerfilePath, 'utf8');
const envExample = readFileSync(envExamplePath, 'utf8');

// ── compose 구조 ──
const { db, api } = compose.services ?? {};
check(db && api, 'services.db / services.api 가 필요합니다');
check(!db?.ports, 'db 는 호스트에 포트를 공개하면 안 됩니다(ports 제거)');
check(api?.depends_on?.db?.condition === 'service_healthy', 'api 는 db 의 service_healthy 를 기다려야 합니다');
check(Boolean(db?.healthcheck), 'db 에 healthcheck 가 필요합니다');
check(!/:latest\b/.test(db?.image ?? ''), 'db 이미지에 :latest 태그를 쓰지 마세요');
check(/^postgres:\d+/.test(db?.image ?? ''), 'db 이미지는 postgres:<메이저 버전> 이어야 합니다');
check(api?.environment?.NODE_ENV === 'production', 'api 의 NODE_ENV 는 production 이어야 합니다(Secure 쿠키)');
check(api?.environment?.NODE_ENV !== 'test', 'NODE_ENV=test 는 레이트 리밋을 끄므로 운영에서 금지입니다');

// 비밀번호가 평문으로 박혀 있지 않은지, 필수 값이 :? 로 강제되는지
const pw = db?.environment?.POSTGRES_PASSWORD ?? '';
check(/^\$\{POSTGRES_PASSWORD:\?/.test(pw), 'POSTGRES_PASSWORD 는 ${POSTGRES_PASSWORD:?...} 로 필수 지정해야 합니다');
check(/^\$\{ALLOWED_ORIGINS:\?/.test(api?.environment?.ALLOWED_ORIGINS ?? ''), 'ALLOWED_ORIGINS 는 필수(:?)여야 합니다');
check(!/ANTHROPIC_API_KEY:\s*sk-/.test(composeText), 'API 키가 compose 파일에 평문으로 들어 있습니다');

// 볼륨: 선언한 것과 사용한 것이 일치, 사진 볼륨이 /data/storage 에 연결
const declared = new Set(Object.keys(compose.volumes ?? {}));
const used = [...(db?.volumes ?? []), ...(api?.volumes ?? [])].map((v) => String(v).split(':')[0]);
for (const v of used) check(declared.has(v), `사용한 볼륨 ${v} 이(가) volumes: 에 선언되지 않았습니다`);
check((api?.volumes ?? []).some((v) => String(v).endsWith(':/data/storage')), '사진 볼륨이 /data/storage 에 마운트되어야 합니다');
check(api?.environment?.STORAGE_DIR === '/data/storage', 'STORAGE_DIR 는 /data/storage 여야 합니다');

// API 포트 바인딩 기본값이 루프백인지
const portSpec = JSON.stringify(api?.ports ?? []);
check(/127\.0\.0\.1:4000/.test(portSpec), 'API 포트 기본 바인딩은 127.0.0.1:4000 이어야 합니다(리버스 프록시 전용)');

// ${VAR} 로 참조한 변수가 .env.example 에 문서화되어 있는지(주석 처리된 항목 포함)
const refs = new Set([...composeText.matchAll(/\$\{([A-Z_]+)[:?\-}]/g)].map((m) => m[1]));
for (const name of refs) {
  check(new RegExp(`^#?\\s*${name}=`, 'm').test(envExample), `compose 가 쓰는 ${name} 이(가) .env.example 에 없습니다`);
}

// ── Dockerfile ──
check(/^USER\s+(?!root\b)\S+/m.test(dockerfile), 'Dockerfile 은 비루트 USER 를 지정해야 합니다');
check(/^HEALTHCHECK\b/m.test(dockerfile), 'Dockerfile 에 HEALTHCHECK 가 필요합니다');
check((dockerfile.match(/^FROM\b/gm) ?? []).length >= 3, '멀티 스테이지(FROM 3개 이상)여야 합니다');
check(/--frozen-lockfile/.test(dockerfile), 'pnpm install 은 --frozen-lockfile 이어야 합니다');
check(!/^ENV\s+\S*(PASSWORD|API_KEY|SECRET)\S*=/mi.test(dockerfile), 'Dockerfile 에 비밀 ENV 가 있으면 안 됩니다');
if (!/^ARG\s+NODE_VERSION=\d+/m.test(dockerfile)) warns.push('Node 메이저 버전을 ARG 로 고정하는 것을 권장합니다');

// .env.example 가 코드가 읽는 모든 변수를 문서화하는지(config.ts + matching/weights.ts)
const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');
const names = new Set([
  ...[...read('../../src/config.ts').matchAll(/^\s{2}([A-Z][A-Z0-9_]+):\s*z\./gm)].map((m) => m[1]),
  ...[...read('../../src/matching/weights.ts').matchAll(/env\.([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]),
]);
for (const name of names) {
  check(new RegExp(`^#?\\s*${name}=`, 'm').test(envExample), `코드가 읽는 ${name} 이(가) .env.example 에 문서화되지 않았습니다`);
}

for (const w of warns) console.warn(`경고: ${w}`);
if (errors.length) {
  console.error(`실패 ${errors.length}건:`);
  for (const e of errors) console.error(` - ${e}`);
  process.exit(1);
}
console.log(`통과: compose·Dockerfile·.env.example 정적 점검 (환경 변수 ${names.size}개 문서화 확인)`);
